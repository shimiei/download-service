#!/usr/bin/env node
// Local download service, read-only by design.
//
// There is deliberately NO upload endpoint. Files are published by the local
// file-share MCP placing them into ./storage/. That makes "upload only from this
// machine" a structural property rather than an access-control check.
//
// Routes
//   GET  /s/<code>       download a published file (short link)
//   GET  /f/<id>/<tok>   download a published file (legacy long link)
//   GET  /               file list; requires the password
//   POST /login          password form target
//   GET  /logout         drop the session
//   GET  /healthz        liveness probe
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { newShortCode, collectTakenCodes } from './shortcode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  port: PORT,
  bind: BIND,
  storage: STORAGE,
  password: PASSWORD,
  upload: UPLOAD_MODE,
  uploadMaxMb: UPLOAD_MAX_MB,
  uploadDailyMb: UPLOAD_DAILY_MB,
  uploadDailyCount: UPLOAD_DAILY_COUNT,
} = loadConfig();

const UPLOAD_MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;
const UPLOAD_DAILY_BYTES = UPLOAD_DAILY_MB * 1024 * 1024;

// ---------------------------------------------------------------- upload quota
//
// Scoped to the storage directory it protects, NOT to the service directory:
// two instances sharing one counter would corrupt each other's accounting.
// Persisted so a restart cannot be used to reset the ceiling. Keyed by UTC date.
const QUOTA_FILE = path.join(STORAGE, '.upload-quota.json');
const todayKey = () => new Date().toISOString().slice(0, 10);

function readQuota() {
  try {
    const j = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    if (j && j.date === todayKey()) return { date: j.date, bytes: Number(j.bytes) || 0, count: Number(j.count) || 0 };
  } catch {}
  return { date: todayKey(), bytes: 0, count: 0 };
}

function writeQuota(q) {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(q), 'utf8');
  } catch (e) {
    process.stderr.write(`[local-share] WARN could not persist upload quota: ${e.message}\n`);
  }
}

fs.mkdirSync(STORAGE, { recursive: true });

const MIME = {
  '.pdf': 'application/pdf', '.epub': 'application/epub+zip', '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const newCode = newShortCode;
const takenCodes = () => collectTakenCodes(STORAGE);

function metaPath(id) {
  return path.join(STORAGE, id, 'meta.json');
}

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function listAll() {
  const out = [];
  for (const id of fs.readdirSync(STORAGE)) {
    // skip the quota file and anything else that is not a published entry
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(STORAGE, id)).isDirectory();
    } catch {}
    if (!isDir) continue;
    const m = readMeta(id);
    if (m) out.push(m);
  }
  return out.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
}

// Give every existing file a short code exactly once.
function backfillCodes() {
  let changed = 0;
  const taken = new Set(listAll().map((m) => m.short).filter(Boolean));
  for (const m of listAll()) {
    if (m.short) continue;
    let code;
    do { code = newCode(); } while (taken.has(code));
    taken.add(code);
    m.short = code;
    try {
      fs.writeFileSync(metaPath(m.id), JSON.stringify(m, null, 2), 'utf8');
      changed++;
    } catch {}
  }
  return changed;
}

const findByCode = (code) => listAll().find((m) => m.short === code) ?? null;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const human = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

// ---------------------------------------------------------------- sessions
//
// Two stateless HMAC-signed cookies. Stateless on purpose: this service gets
// restarted (and the machine rebooted), so anything held in memory would make a
// long-lived cookie meaningless.
//
//   fs_session   1 个月，滑动续期（每次已认证访问都重新计时），实际门禁
//   fs_remember  半年，只在显式登录时续期；短 cookie 失效后凭它静默补发新的短 cookie，
//                所以最长可保持半年不用重新输密码；重新登录会把半年重新起算
//
// 想一次性作废所有已发出的令牌：删掉 service\cookie-secret.txt，服务会重新生成一个。
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;   // 短 cookie：1 个月
const REMEMBER_TTL_MS = 180 * 24 * 3600 * 1000; // 长 cookie：半年
const SECRET_FILE = path.join(HERE, 'cookie-secret.txt');

function loadSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s) return Buffer.from(s, 'base64url');
  } catch {}
  const fresh = crypto.randomBytes(32);
  try {
    fs.writeFileSync(SECRET_FILE, `${fresh.toString('base64url')}\n`, { mode: 0o600 });
    process.stderr.write(`[local-share] generated a new cookie secret: ${SECRET_FILE}\n`);
  } catch (e) {
    process.stderr.write(`[local-share] WARN cookie secret not persisted (${e.message}); logins will not survive a restart\n`);
  }
  return fresh;
}
const SECRET = loadSecret();

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest();

function issueToken(kind, ttlMs) {
  const payload = Buffer.from(JSON.stringify({ k: kind, exp: Date.now() + ttlMs }), 'utf8').toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}

function readToken(token, kind) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = sign(payload);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (j.k !== kind) return null;
    if (typeof j.exp !== 'number' || j.exp < Date.now()) return null;
    return j;
  } catch {
    return null;
  }
}

function cookieOf(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const sessionCookie = (t) =>
  `fs_session=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
const rememberCookie = (t) =>
  `fs_remember=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${REMEMBER_TTL_MS / 1000}`;
const clearCookie = (n) => `${n}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// May this request see the listing? Also reports the cookie to hand back (sliding).
function authorize(req) {
  if (readToken(cookieOf(req, 'fs_session'), 's')) {
    return { ok: true, session: issueToken('s', SESSION_TTL_MS) };
  }
  if (readToken(cookieOf(req, 'fs_remember'), 'r')) {
    // short cookie lapsed, but the long one still vouches for this browser
    return { ok: true, session: issueToken('s', SESSION_TTL_MS) };
  }
  return { ok: false, session: null };
}

// constant-time compare that tolerates different lengths
function passwordMatches(given) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(PASSWORD), 'utf8');
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length;
}

// ---------------------------------------------------------------- rate limit
const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const fails = new Map(); // ip -> { count, resetAt }

function tooManyFails(ip) {
  const e = fails.get(ip);
  if (!e) return false;
  if (e.resetAt < Date.now()) { fails.delete(ip); return false; }
  return e.count >= MAX_FAILS;
}

function noteFail(ip) {
  const e = fails.get(ip);
  if (!e || e.resetAt < Date.now()) fails.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else e.count++;
}

// ---------------------------------------------------------------- upload access
const safeUploadName = (name) => {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return base || `upload-${Date.now()}`;
};

// "From this machine" means loopback OR one of our own addresses, since a browser on
// this box may reach the service through the LAN IP instead of 127.0.0.1.
const ownAddresses = (() => {
  const set = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.address) set.add(a.address);
  }
  return set;
})();

const stripV4Mapped = (addr) => String(addr || '').replace(/^::ffff:/, '');

function isLocalRequest(req) {
  const raw = req.socket.remoteAddress || '';
  return ownAddresses.has(raw) || ownAddresses.has(stripV4Mapped(raw));
}

// null = may upload; otherwise a human-readable reason why not.
function uploadRefusal(req) {
  if (UPLOAD_MODE === 'off') return '上传功能已关闭（service/config.json 里 upload 为 "off"）';
  if (!PASSWORD) return '未设置访问密码，上传已禁用';
  if (!authorize(req).ok) return '需要先登录才能上传';
  if (UPLOAD_MODE === 'local' && !isLocalRequest(req)) {
    return '当前只允许从本机上传。如要从手机或外网上传，把 service/config.json 的 '
      + 'upload 改成 "session" 并重启服务，但请先了解这会让任何猜到密码的人都能写文件。';
  }
  return null;
}

// ---------------------------------------------------------------- responses
function sendFile(req, res, filePath, name, size) {
  const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_');
  const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Disposition': disposition,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': disposition,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const PAGE_CSS = `body{font-family:system-ui,"Segoe UI",sans-serif;margin:0;padding:2rem 1.5rem;
background:#faf9f7;color:#222;line-height:1.7}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 .3rem}
.sub{color:#777;font-size:.9rem;margin-bottom:1.6rem}
table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06)}
th,td{border-bottom:1px solid #eee;padding:.6rem .8rem;text-align:left;font-size:.92rem;vertical-align:top}
th{background:#f4f2ee;font-weight:600}
tr:last-child td{border-bottom:none}
a{color:#1a5fb4;text-decoration:none}
a:hover{text-decoration:underline}
code{background:#f2f2f2;padding:.1rem .35rem;border-radius:3px;font-size:.85em}
.empty{color:#888;padding:2rem;background:#fff;text-align:center}
form{background:#fff;padding:1.6rem;max-width:340px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}
button{margin-top:.9rem;padding:.6rem 1.2rem;font-size:.95rem;border:0;border-radius:4px;
background:#1a5fb4;color:#fff;cursor:pointer}
.err{color:#b3261e;font-size:.88rem;margin-top:.6rem}
.foot{color:#999;font-size:.8rem;margin-top:1.5rem}
.up{background:#fff;padding:1rem 1.2rem;margin-bottom:1.4rem;box-shadow:0 1px 3px rgba(0,0,0,.06);
display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}
.up button{margin-top:0}
.up .note{color:#777;font-size:.85rem}
.up .prog{color:#1a5fb4;font-size:.86rem;flex-basis:100%}`;

function htmlPage(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function loginPage(err) {
  return htmlPage(
    '需要密码',
    `<h1>文件下载</h1>
<div class="sub">请输入访问密码</div>
<form method="POST" action="/login">
  <input type="password" name="password" autofocus autocomplete="current-password" placeholder="密码">
  <button type="submit">进入</button>
  ${err ? `<div class="err">${escapeHtml(err)}</div>` : ''}
</form>`
  );
}

function listingPage(req) {
  const files = listAll();
  const base = `http://${req.headers.host || 'localhost'}`;
  const rows = files
    .map((m) => {
      const short = m.short ? `${base}/s/${m.short}` : `${base}/f/${m.id}/${m.token}`;
      const when = m.publishedAt ? new Date(m.publishedAt).toLocaleString('zh-CN') : '';
      return `<tr>
  <td>${escapeHtml(m.name)}</td>
  <td>${human(m.sizeBytes ?? 0)}</td>
  <td>${escapeHtml(when)}</td>
  <td><a href="${escapeHtml(short)}">${escapeHtml(short)}</a></td>
</tr>`;
    })
    .join('\n');

  const table = files.length
    ? `<table><thead><tr><th>文件名</th><th>大小</th><th>发布时间</th><th>下载链接</th></tr></thead>
<tbody>${rows}</tbody></table>`
    : `<div class="empty">还没有发布任何文件</div>`;

  // The uploader only appears when this particular request is allowed to upload,
  // so a public visitor never even sees that an upload path exists.
  const refusal = uploadRefusal(req);
  const uploader = refusal
    ? `<div class="up"><span class="note">${escapeHtml(refusal)}</span></div>`
    : `<div class="up">
  <input type="file" id="upfile" multiple>
  <button type="button" id="upgo">上传</button>
  <span class="note">上限 ${UPLOAD_MAX_MB} MB / 个</span>
  <div class="prog" id="upprog"></div>
</div>`;

  // Plain string concatenation, no template literals: this block is embedded in a
  // Node template literal, and backticks or ${} here would be interpolated away.
  const uploadJs = refusal ? '' : `
<script>
(function () {
  var btn = document.getElementById('upgo');
  var input = document.getElementById('upfile');
  var prog = document.getElementById('upprog');
  if (!btn || !input || !prog) return;
  btn.addEventListener('click', function () {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) { prog.textContent = '请先选择文件'; return; }
    btn.disabled = true;
    var i = 0;
    function next() {
      if (i >= files.length) { location.reload(); return; }
      var f = files[i++];
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload');
      xhr.setRequestHeader('x-filename', encodeURIComponent(f.name));
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          prog.textContent = '正在上传 ' + f.name + '　' + Math.round(e.loaded / e.total * 100) + '%';
        }
      };
      xhr.onload = function () {
        if (xhr.status === 200) {
          prog.textContent = '已上传 ' + f.name;
          next();
        } else {
          prog.textContent = '上传失败：' + (xhr.responseText || xhr.status);
          btn.disabled = false;
        }
      };
      xhr.onerror = function () { prog.textContent = '网络错误'; btn.disabled = false; };
      xhr.send(f);
    }
    next();
  });
})();
<\/script>`;

  const q = readQuota();
  const quotaNote = UPLOAD_DAILY_MB > 0
    ? `今日已用 ${Math.round(q.bytes / 1024 / 1024)} MB / ${UPLOAD_DAILY_MB} MB，${q.count} / ${UPLOAD_DAILY_COUNT} 个文件`
    : '未设每日额度';

  return htmlPage(
    '文件列表',
    `<h1>文件列表</h1>
<div class="sub">共 ${files.length} 个文件，按发布时间从新到旧　·　<a href="/logout">退出</a></div>
${uploader}
${table}
<div class="foot">上传模式：${escapeHtml(UPLOAD_MODE)}（<code>off</code> 只读 / <code>local</code> 仅本机 / <code>session</code> 登录后任意来源），单文件上限 ${UPLOAD_MAX_MB} MB。${escapeHtml(quotaNote)}。
删掉 <code>service\\storage\\&lt;id&gt;\\</code> 目录即可撤销某个分享。</div>
${uploadJs}`
  );
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const ip = req.socket.remoteAddress || 'unknown';

  // Write paths are exactly two: /login and /upload. Everything else is GET/HEAD,
  // and /upload refuses on its own when it is not permitted.
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const isAllowedWrite = url.pathname === '/login' || url.pathname === '/upload';
  if (!isRead && !isAllowedWrite) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    return res.end('此服务为只读，只接受 GET/HEAD。\n');
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, files: listAll().length }));
  }

  // ---- login / logout
  if (url.pathname === '/logout') {
    // Tokens are stateless, so logout just drops both cookies on this browser.
    // To invalidate every issued token at once, delete service\cookie-secret.txt.
    res.writeHead(302, {
      'Set-Cookie': [clearCookie('fs_session'), clearCookie('fs_remember')],
      Location: '/',
    });
    return res.end();
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      const given = new URLSearchParams(body).get('password') ?? '';

      // Check the password first: throttling must slow guessing, not lock the
      // legitimate user out of their own service when the counter is tripped.
      if (passwordMatches(given)) {
        fails.delete(ip);
        // An explicit login renews BOTH cookies: the short one and the 6-month one.
        res.writeHead(302, {
          'Set-Cookie': [
            sessionCookie(issueToken('s', SESSION_TTL_MS)),
            rememberCookie(issueToken('r', REMEMBER_TTL_MS)),
          ],
          Location: '/',
        });
        return res.end();
      }

      noteFail(ip);
      // Redirect on failure too. Answering the POST with an HTML body leaves the
      // browser sitting on a POST result page, which makes refresh offer to
      // resubmit the form.
      res.writeHead(302, { Location: tooManyFails(ip) ? '/?e=slow' : '/?e=bad' });
      res.end();
    });
    return;
  }

  // ---- upload (web UI)
  //
  // Raw request body rather than multipart: the filename rides in a header, so no
  // multipart parser (and no new dependency) is needed, and the body streams
  // straight to disk with the size cap enforced as it arrives.
  if (url.pathname === '/upload' && req.method === 'POST') {
    const refusal = uploadRefusal(req);
    if (refusal) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`${refusal}\n`);
    }

    // Daily ceiling: bounds the damage if the password is ever guessed.
    const quota = readQuota();
    const overCount = UPLOAD_DAILY_COUNT > 0 && quota.count >= UPLOAD_DAILY_COUNT;
    const remaining = UPLOAD_DAILY_BYTES > 0 ? UPLOAD_DAILY_BYTES - quota.bytes : Infinity;
    if (overCount || remaining <= 0) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(
        `今天的上传额度已用完（${UPLOAD_DAILY_MB} MB / ${UPLOAD_DAILY_COUNT} 个文件），已用 `
        + `${Math.round(quota.bytes / 1024 / 1024)} MB / ${quota.count} 个。次日自动重置；`
        + `如需调整请改 service/config.json 的 uploadDailyMb / uploadDailyCount。\n`
      );
    }
    // A single file may not exceed the remaining daily allowance either.
    const cap = Math.min(UPLOAD_MAX_BYTES, remaining);

    const declared = Number(req.headers['content-length'] || 0);
    if (declared > cap) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(
        declared > UPLOAD_MAX_BYTES
          ? `文件超过单文件上限 ${UPLOAD_MAX_MB} MB\n`
          : `文件加今天的用量会超出当日额度 ${UPLOAD_DAILY_MB} MB（剩余 ${Math.round(remaining / 1024 / 1024)} MB）\n`
      );
    }

    let rawName = String(req.headers['x-filename'] || '');
    try { rawName = decodeURIComponent(rawName); } catch {}
    const name = safeUploadName(rawName);

    const id = crypto.randomBytes(5).toString('hex');
    const short = newShortCode(takenCodes());
    const dir = path.join(STORAGE, id);
    fs.mkdirSync(dir, { recursive: true });
    const storedName = safeUploadName(`${id}-${name}`);
    const dest = path.join(dir, storedName);

    const out = fs.createWriteStream(dest);
    let written = 0;
    let settled = false;
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    const fail = (code, msg) => {
      if (settled) return;
      settled = true;
      out.destroy();
      cleanup();
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${msg}\n`);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      written += chunk.length;
      if (written > cap) {
        fail(413, written > UPLOAD_MAX_BYTES
          ? `文件超过单文件上限 ${UPLOAD_MAX_MB} MB`
          : `超出当日上传额度 ${UPLOAD_DAILY_MB} MB`);
        req.destroy();
        return;
      }
      if (!out.write(chunk)) req.pause();
    });
    out.on('drain', () => req.resume());
    req.on('aborted', () => { if (!settled) { settled = true; out.destroy(); cleanup(); } });
    out.on('error', (e) => fail(500, `写入失败：${e.message}`));
    req.on('end', () => { if (!settled) out.end(); });
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      if (written === 0) {
        cleanup();
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('空文件\n');
      }
      const meta = {
        id,
        name,
        storedName,
        sizeBytes: written,
        mode: 'web-upload',
        publishedAt: new Date().toISOString(),
        short,
        urlPath: `/s/${short}`,
        uploadedFrom: stripV4Mapped(req.socket.remoteAddress),
      };
      try {
        fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
      } catch (e) {
        cleanup();
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`写入元数据失败：${e.message}\n`);
      }
      // count it against today's ceiling only once it really landed
      const q = readQuota();
      writeQuota({ date: q.date, bytes: q.bytes + written, count: q.count + 1 });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, name, sizeBytes: written, short, path: `/s/${short}` }));
    });
    return;
  }

  // ---- index (password gated, reachable from anywhere)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!PASSWORD) {
      // never silently expose the listing just because no password was set
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        htmlPage('列表已禁用', `<h1>文件列表已禁用</h1>
<div class="sub">未在 <code>service/config.json</code> 里设置 <code>password</code>，因此不开放文件列表。
直接下载链接（<code>/s/&lt;code&gt;</code>）不受影响。</div>`)
      );
    }
    const auth = authorize(req);
    if (!auth.ok) {
      const e = url.searchParams.get('e');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage(e === 'bad' ? '密码不正确。' : e === 'slow' ? '尝试失败次数过多，请稍后再试。' : null));
    }
    // sliding: hand back a freshly-dated short cookie on every authenticated view
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': sessionCookie(auth.session),
    });
    return res.end(listingPage(req));
  }

  // ---- short link
  if (parts[0] === 's' && parts[1]) {
    const meta = findByCode(decodeURIComponent(parts[1]));
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('链接不存在或已失效\n');
    }
    const filePath = path.join(STORAGE, meta.id, meta.storedName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('文件已从服务器移除\n');
    }
    return sendFile(req, res, filePath, meta.name, fs.statSync(filePath).size);
  }

  // ---- legacy long link, still honoured so old links keep working
  if (parts[0] === 'f' && parts[1]) {
    const meta = readMeta(parts[1]);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('文件不存在或已被移除\n');
    }
    const token = parts[2];
    if (meta.token && token !== meta.token) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('链接不完整或已失效\n');
    }
    const filePath = path.join(STORAGE, meta.id, meta.storedName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('文件已从服务器移除\n');
    }
    return sendFile(req, res, filePath, meta.name, fs.statSync(filePath).size);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
});

const added = backfillCodes();
server.listen(PORT, BIND, () => {
  process.stderr.write(`[local-share] listening on http://${BIND}:${PORT}  storage=${STORAGE}\n`);
  process.stderr.write(`[local-share] upload mode=${UPLOAD_MODE} (max ${UPLOAD_MAX_MB} MB per file); downloads are always read-only\n`);
  if (UPLOAD_MODE !== 'off' && !PASSWORD) {
    process.stderr.write('[local-share] WARN uploads are configured but no password is set; they will be refused\n');
  }
  if (added) process.stderr.write(`[local-share] assigned short codes to ${added} existing file(s)\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    process.stderr.write(`[local-share] stopping (${sig})\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
