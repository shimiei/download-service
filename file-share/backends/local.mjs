// Local download service backend.
//
// Publishing = placing the file into service/storage/<id>/ on this machine. The
// service itself is read-only, so nothing on the network can add files: the only
// write path is a local process with filesystem access.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../service/config.mjs';

export const id = 'local';
export const label = '本机下载服务（不经第三方，不自动过期）';
export const retention = '不自动过期；只要本机服务在线就一直可用';
export const needsAccount = false;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const STORAGE = path.join(ROOT, 'service', 'storage');
const MANAGE = path.join(ROOT, 'service', 'manage.mjs');
const PORT = loadConfig().port;
const BIND = loadConfig().bind;
const HEALTH = `http://127.0.0.1:${PORT}/healthz`;
const BASE_FILE = path.join(ROOT, 'frp', 'public-base.txt');

// Resolved per call, not at import time: the port, bind address or tunnel URL can
// change while ZCode keeps this server process alive, and links must follow.
function publicBase() {
  return loadConfig().publicBase;
}

async function health(timeoutMs = 2500) {
  try {
    const res = await fetch(HEALTH, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// The MCP can be invoked from any conversation, so make the service self-starting.
async function ensureService() {
  if (await health()) return;
  const r = spawnSync(process.execPath, [MANAGE, 'start'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 || !(await health(5000))) {
    throw new Error(
      `本机下载服务启动失败：${(r.stderr || r.stdout || '').trim() || '未知错误'}\n可手动排查：node "${MANAGE}" start`
    );
  }
}

const safeName = (name) => {
  const base = path.basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return base || 'file';
};

// Short link codes come from service/shortcode.mjs so the MCP path and the web
// upload path can never mint a colliding code.
import { newShortCode, collectTakenCodes } from '../service/shortcode.mjs';

export async function upload(filePath, { title, onProgress } = {}) {
  await ensureService();

  const fid = crypto.randomBytes(5).toString('hex');
  const token = crypto.randomBytes(16).toString('base64url');
  const name = safeName(title || path.basename(filePath));
  const storedName = safeName(`${fid}-${name}`);
  const dir = path.join(STORAGE, fid);
  fs.mkdirSync(dir, { recursive: true });

  const dest = path.join(dir, storedName);
  let mode = 'hardlink';
  try {
    fs.linkSync(filePath, dest);
  } catch {
    mode = 'copy';
    fs.copyFileSync(filePath, dest);
  }

  const size = fs.statSync(dest).size;
  onProgress?.(1, 1);

  const short = newShortCode(collectTakenCodes(STORAGE));
  const meta = {
    id: fid,
    name,
    storedName,
    sizeBytes: size,
    mode,
    publishedAt: new Date().toISOString(),
    sourcePath: filePath,
    token,
    short,
    urlPath: `/s/${short}`,
    legacyUrlPath: `/f/${fid}/${token}`,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  const base = publicBase();
  return {
    backend: id,
    url: `${base}${meta.urlPath}`,
    retentionHours: null, // no automatic expiry
    freeDownloadHours: null,
    localId: fid,
    localPath: dest,
    linkMode: mode,
    shortCode: short,
    publicBase: base,
  };
}

export async function verify(record) {
  const id = record.localId;
  if (!id) return { alive: false, error: '缺少 localId' };
  const dir = path.join(STORAGE, id);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return { alive: false, error: '本机存储中没有这条记录' };
  }
  const filePath = path.join(dir, meta.storedName);
  if (!fs.existsSync(filePath)) return { alive: false, error: '本机文件已被移除' };

  const h = await health();
  if (!h) {
    return {
      alive: true,
      complete: true,
      note: '本机文件完好，但下载服务当前未运行（调用 share_upload 会自动拉起，或手动 node service/manage.mjs start）',
    };
  }
  return { alive: true, complete: true, note: `服务在线（已发布 ${h.files} 个文件）` };
}
