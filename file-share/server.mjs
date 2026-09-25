#!/usr/bin/env node
// ZCode File Share MCP: upload a local file, get a download link.
//
// Design constraints:
//   * uploads can only start from this machine (the tool takes a local path)
//   * stdout is reserved for JSON-RPC; every diagnostic goes to stderr
//
// Run `node server.mjs --doctor` in a terminal for a standalone health report.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import * as filekiwi from './backends/filekiwi.mjs';
import * as local from './backends/local.mjs';
import * as store from './lib/store.mjs';
import { doctorReport } from './lib/doctor.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const VERSION = '2.0.0';
const MAX_MB = Number(process.env.FILE_SHARE_MAX_MB || 4096);

const BACKENDS = { filekiwi, local };
const DEFAULT_BACKEND = 'filekiwi';

// context handed to the maintenance report in lib/doctor.mjs
const DOCTOR_CTX = () => ({ version: VERSION, maxMb: MAX_MB, backends: BACKENDS, defaultBackend: DEFAULT_BACKEND });

const log = (...a) => process.stderr.write(`[download-service] ${a.join(' ')}\n`);

const human = (bytes) => {
  if (!Number.isFinite(bytes)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

const ago = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} 分钟前`;
  if (h < 48) return `${h.toFixed(1)} 小时前`;
  return `${(h / 24).toFixed(1)} 天前`;
};

const untilText = (date) => {
  if (!date) return '未知';
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return '已过期';
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} 分钟后过期`;
  if (h < 48) return `${h.toFixed(1)} 小时后过期`;
  return `${(h / 24).toFixed(1)} 天后过期`;
};

// ---------------------------------------------------------------- upload jobs
const jobs = new Map();

function resolveLocalFile(input) {
  const p = path.resolve(input);
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${p}`);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error(`这是一个目录，不是文件：${p}`);
  if (st.size === 0) throw new Error(`文件为空：${p}`);
  const mb = st.size / 1024 / 1024;
  if (mb > MAX_MB) {
    throw new Error(`文件 ${human(st.size)} 超过上限 ${MAX_MB} MB（可用环境变量 FILE_SHARE_MAX_MB 调整）`);
  }
  return { path: p, size: st.size };
}

async function runUpload(jobId, absPath, size, title, backendId) {
  const backend = BACKENDS[backendId] ?? BACKENDS[DEFAULT_BACKEND];
  const started = Date.now();
  try {
    const rec = await backend.upload(absPath, {
      title,
      onProgress: (up, total) => {
        const j = jobs.get(jobId);
        if (j) { j.uploaded = up; j.total = total; }
      },
    });
    const uploadedAt = new Date().toISOString();
    const record = {
      id: jobId,
      backend: backendId,
      name: path.basename(absPath),
      path: absPath,
      sizeBytes: size,
      title: title || path.basename(absPath),
      uploadedAt,
      ...rec,
    };
    store.add(record);
    const j = jobs.get(jobId);
    if (j) {
      j.status = 'done';
      j.record = record;
      j.elapsedMs = Date.now() - started;
    }
    log(`uploaded ${record.name} (${human(size)}) -> ${record.url}`);
    return record;
  } catch (err) {
    const j = jobs.get(jobId);
    if (j) { j.status = 'failed'; j.error = err.message; }
    log(`upload failed for ${absPath}: ${err.message}`);
    throw err;
  }
}

function uploadSummary(record, extra = {}) {
  const expiry = store.expiryOf(record);
  const permanent = !record.retentionHours;
  return [
    `已上传：${record.name}（${human(record.sizeBytes)}）`,
    ``,
    `下载链接：`,
    `${record.url}`,
    ``,
    `本地记录 ID：${record.id}`,
    `上传时间：${new Date(record.uploadedAt).toLocaleString('zh-CN')}`,
    permanent
      ? `有效期：不自动过期，但链接依赖本机下载服务在线；本机服务停止后链接失效`
      : `有效期：${record.retentionHours} 小时，${untilText(expiry)}`,
    !permanent && record.freeDownloadHours
      ? `免费下载窗口：${record.freeDownloadHours} 小时（实测超时后仍可下载，此字段不拦访问）`
      : null,
    `后端：${record.backend}`,
    ...(record.backend === 'local' && !record.publicBase.includes('127.0.0.1') && !record.publicBase.includes('localhost')
      ? []
      : record.backend === 'local'
        ? [`注意：这个地址只有本机能访问。要让手机或别人下载，需要把服务绑到局域网（FILE_SHARE_BIND=0.0.0.0）或开一条隧道。`]
        : []),
    ...(extra.note ? [``, extra.note] : []),
  ].filter((x) => x !== null).join('\n');
}

// ---------------------------------------------------------------- MCP server
const server = new McpServer({ name: 'download-service', version: VERSION });

server.registerTool(
  'share_upload',
  {
    title: '下载服务 · 上传本地文件并生成下载链接',
    description:
      '把本机上的一个文件上传到文件托管服务，返回可直接分享的下载链接和有效期。' +
      '只能上传本机已存在的文件（不接受 URL）。' +
      '默认同步等待上传完成；超大文件（>1GB）建议传 background=true，随后用 share_list 查询结果。',
    inputSchema: {
      path: z.string().describe('本机文件的绝对路径，例如 C:\\\\Users\\\\Administrator\\\\Downloads\\\\book.pdf'),
      title: z.string().optional().describe('在托管服务上显示的名称，默认用文件名'),
      background: z.boolean().optional().describe('true 则立即返回任务 ID，不等待上传完成'),
      backend: z.string().optional().describe(`托管后端，可选：${Object.keys(BACKENDS).join(' / ')}，默认 ${DEFAULT_BACKEND}`),
    },
  },
  async ({ path: inputPath, title, background, backend }) => {
    const backendId = backend && BACKENDS[backend] ? backend : DEFAULT_BACKEND;
    let file;
    try {
      file = resolveLocalFile(inputPath);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }

    const jobId = store.newId();

    if (background) {
      jobs.set(jobId, { status: 'running', uploaded: 0, total: 0, file: file.path, size: file.size });
      runUpload(jobId, file.path, file.size, title, backendId).catch(() => {});
      return {
        content: [{
          type: 'text',
          text: [
            `已开始后台上传：${path.basename(file.path)}（${human(file.size)}）`,
            `任务 ID：${jobId}`,
            ``,
            `用 share_list 查看进度和最终链接。`,
          ].join('\n'),
        }],
      };
    }

    jobs.set(jobId, { status: 'running', uploaded: 0, total: 0, file: file.path, size: file.size });
    try {
      const record = await runUpload(jobId, file.path, file.size, title, backendId);
      return { content: [{ type: 'text', text: uploadSummary(record) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `上传失败：${err.message}\n后端：${backendId}` }],
      };
    } finally {
      jobs.delete(jobId);
    }
  }
);

server.registerTool(
  'share_list',
  {
    title: '下载服务 · 列出上传历史与进行中的任务',
    description: '列出本机通过本 MCP 上传过的文件，包含下载链接、上传时间和剩余有效期；同时显示进行中的上传任务。',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 10'),
      onlyActive: z.boolean().optional().describe('只显示尚未过期的记录'),
    },
  },
  async ({ limit, onlyActive }) => {
    const n = limit ?? 10;
    let uploads = store.load();
    if (onlyActive) {
      uploads = uploads.filter((u) => {
        const e = store.expiryOf(u);
        return e ? e.getTime() > Date.now() : !u.retentionHours; // keep permanent ones
      });
    }
    const running = [...jobs.entries()].filter(([, j]) => j.status === 'running');

    const lines = [];
    if (running.length) {
      lines.push('## 进行中');
      for (const [id, j] of running) {
        const pct = j.total ? ` ${((j.uploaded / j.total) * 100).toFixed(0)}%` : '';
        lines.push(`- ${id}  ${path.basename(j.file)}（${human(j.size)}）分块 ${j.uploaded}/${j.total}${pct}`);
      }
      lines.push('');
    }
    const finished = [...jobs.entries()].filter(([, j]) => j.status === 'failed');

    lines.push(`## 历史上传（共 ${uploads.length} 条，显示 ${Math.min(n, uploads.length)} 条）`);
    if (!uploads.length) {
      lines.push('（还没有上传记录）');
    } else {
      for (const u of uploads.slice(0, n)) {
        const expiry = store.expiryOf(u);
        const permanent = !u.retentionHours;
        const expired = !permanent && expiry && expiry.getTime() <= Date.now();
        lines.push(
          `- [${expired ? '已过期' : '有效'}] ${u.name}（${human(u.sizeBytes)}）${
            expired ? '' : permanent ? '，不自动过期（依赖本机服务在线）' : `，${untilText(expiry)}`
          }`,
          `    ID: ${u.id} | ${ago(u.uploadedAt)} | ${u.backend}`,
          `    ${u.url}`
        );
      }
    }
    if (finished.length) {
      lines.push('', '## 失败任务');
      for (const [id, j] of finished) lines.push(`- ${id}  ${path.basename(j.file)}：${j.error}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.registerTool(
  'share_verify',
  {
    title: '下载服务 · 校验分享链接是否仍然有效',
    description:
      '向托管服务查询，确认某个已上传文件的加密数据是否仍在服务器上（分块是否完整），并给出剩余有效期。' +
      '在把链接发给别人之前、或链接疑似失效时使用。',
    inputSchema: {
      id: z.string().optional().describe('上传记录 ID（share_list 返回的 ID）；省略则校验最近一次上传'),
      verifyAll: z.boolean().optional().describe('true 则校验所有未过期的记录'),
    },
  },
  async ({ id, verifyAll }) => {
    let targets = [];
    if (verifyAll) {
      targets = store.load().filter((u) => {
        const e = store.expiryOf(u);
        return e ? e.getTime() > Date.now() : !u.retentionHours;
      });
    } else if (id) {
      const rec = store.find(id);
      if (!rec) return { isError: true, content: [{ type: 'text', text: `找不到记录：${id}` }] };
      targets = [rec];
    } else {
      const all = store.load();
      if (!all.length) return { isError: true, content: [{ type: 'text', text: '还没有任何上传记录。' }] };
      targets = [all[0]];
    }

    if (!targets.length) {
      return { content: [{ type: 'text', text: '没有未过期的记录需要校验。' }] };
    }

    const out = [];
    for (const t of targets) {
      const backend = BACKENDS[t.backend] ?? BACKENDS[DEFAULT_BACKEND];
      const expiry = store.expiryOf(t);
      const expired = expiry && expiry.getTime() <= Date.now();
      let res;
      try {
        res = await backend.verify(t);
      } catch (err) {
        res = { alive: false, error: err.message };
      }
      const verdict = !res.alive
        ? `无法确认（${res.error ?? '查询失败'}）`
        : res.complete
          ? `服务器数据完整${res.note ? `，${res.note}` : ''}`
          : `数据不完整，缺少分块 ${JSON.stringify(res.missing)}`;
      out.push(
        `- ${t.name}（${human(t.sizeBytes)}）`,
        `    服务器状态：${verdict}`,
        `    有效期：${!t.retentionHours ? '不自动过期（依赖本机服务在线）' : expired ? '已过期' : untilText(expiry)}`,
        `    ${t.url}`
      );
    }
    return { content: [{ type: 'text', text: out.join('\n') }] };
  }
);

server.registerTool(
  'share_doctor',
  {
    title: '下载服务 · 诊断与维护手册',
    description:
      '返回本 MCP 的运行环境、ZCode 注册状态、启动与维护步骤、常见故障处理表，以及新增后端的方法。' +
      '在排查“工具调不出来”“链接失效”“要换托管后端”等问题时先调用它。',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: await doctorReport(DOCTOR_CTX()) }] })
);

// ---------------------------------------------------------------- entrypoint
if (process.argv.includes('--doctor')) {
  // human-facing mode: print to stdout and exit
  process.stdout.write(`${await doctorReport(DOCTOR_CTX())}\n`);
  process.exit(0);
}

log(`starting v${VERSION} (node ${process.version}, max ${MAX_MB}MB, backend ${DEFAULT_BACKEND})`);
await server.connect(new StdioServerTransport());
log('connected over stdio');
