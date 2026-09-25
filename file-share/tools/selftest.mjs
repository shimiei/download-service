#!/usr/bin/env node
// Self-test for the file-share MCP server.
// Speaks real JSON-RPC over stdio to the server, exactly like ZCode does.
//
//   node tools/selftest.mjs            # handshake, tools/list, doctor
//   node tools/selftest.mjs --upload <path>   # also performs a real upload
import { spawn } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.dirname(HERE);
const SERVER = path.join(ROOT, 'server.mjs');
const NODE = process.execPath;

const uploadArgIdx = process.argv.indexOf('--upload');
const uploadPath = uploadArgIdx >= 0 ? process.argv[uploadArgIdx + 1] : null;
const backendArgIdx = process.argv.indexOf('--backend');
const uploadBackend = backendArgIdx >= 0 ? process.argv[backendArgIdx + 1] : null;

const child = spawn(NODE, [SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
const stderr = [];

child.stderr.on('data', (d) => stderr.push(d.toString()));

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log('!! 非 JSON 输出（会破坏协议）:', line.slice(0, 200)); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} 超时（${timeoutMs}ms）`)), timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const fail = (m) => { console.error(`\n✗ ${m}`); child.kill(); process.exit(1); };

try {
  console.log('1) initialize …');
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'file-share-selftest', version: '1.0.0' },
  });
  if (init.error) fail(`initialize 失败: ${JSON.stringify(init.error)}`);
  const si = init.result?.serverInfo ?? {};
  console.log(`   ok: 服务器 ${si.name} v${si.version}，协议 ${init.result.protocolVersion}`);

  notify('notifications/initialized', {});
  console.log('2) notifications/initialized … sent');

  console.log('3) tools/list …');
  const tools = await rpc('tools/list', {});
  if (tools.error) fail(`tools/list 失败: ${JSON.stringify(tools.error)}`);
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  console.log(`   ok: ${names.length} 个工具: ${names.join(', ')}`);
  for (const want of ['share_upload', 'share_list', 'share_verify', 'share_doctor']) {
    if (!names.includes(want)) fail(`缺少工具 ${want}`);
  }

  console.log('4) tools/call share_doctor …');
  const doc = await rpc('tools/call', { name: 'share_doctor', arguments: {} }, 30000);
  if (doc.error) fail(`share_doctor 失败: ${JSON.stringify(doc.error)}`);
  const text = doc.result?.content?.[0]?.text ?? '';
  if (!text.includes('维护手册')) fail('share_doctor 返回内容异常');
  console.log(`   ok: 返回 ${text.length} 字符`);

  console.log('5) tools/call share_list …');
  const list = await rpc('tools/call', { name: 'share_list', arguments: { limit: 3 } }, 30000);
  if (list.error) fail(`share_list 失败: ${JSON.stringify(list.error)}`);
  console.log(`   ok: ${(list.result?.content?.[0]?.text ?? '').split('\n')[0]}`);

  console.log('6) tools/call share_verify（校验最近一次上传）…');
  const ver = await rpc('tools/call', { name: 'share_verify', arguments: {} }, 60000);
  if (ver.error) fail(`share_verify 失败: ${JSON.stringify(ver.error)}`);
  const verText = ver.result?.content?.[0]?.text ?? '';
  if (ver.result?.isError) console.log(`   skip: ${verText}`);
  else console.log(`   ok: ${verText.split('\n')[1]?.trim() ?? verText.slice(0, 80)}`);

  if (uploadPath) {
    console.log(`7) tools/call share_upload（真实上传 ${uploadPath}${uploadBackend ? `，后端 ${uploadBackend}` : ''}）…`);
    const up = await rpc(
      'tools/call',
      { name: 'share_upload', arguments: { path: uploadPath, ...(uploadBackend ? { backend: uploadBackend } : {}) } },
      900000
    );
    if (up.error) fail(`share_upload 失败: ${JSON.stringify(up.error)}`);
    const upText = up.result?.content?.[0]?.text ?? '';
    if (up.result?.isError) fail(`share_upload 返回错误: ${upText}`);
    console.log('   ok');
    console.log(upText.split('\n').map((l) => `      ${l}`).join('\n'));
  }

  console.log(`\n✓ 全部通过${stderr.length ? '（服务器 stderr 有输出，见下）' : ''}`);
  if (stderr.length) console.log(stderr.join('').split('\n').filter(Boolean).map((l) => `   [stderr] ${l}`).join('\n'));
  child.kill();
  process.exit(0);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (stderr.length) console.error(stderr.join('').slice(0, 2000));
  child.kill();
  process.exit(1);
}
