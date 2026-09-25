// Deployment settings for the local download service.
//
// Read by service/server.mjs, service/manage.mjs and backends/local.mjs so the
// port, bind address and public URL stay consistent and survive a restart.
//
// Precedence: environment variable > service/config.json > built-in default.
// Environment overrides exist so tests can point at a throwaway port.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = path.join(HERE, 'config.json');

export function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Best guess for "an address other devices can use" when bound to all interfaces.
export function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

export function loadConfig() {
  const file = readConfigFile();
  const port = Number(process.env.FILE_SHARE_PORT || file.port || 8099);
  const bind = process.env.FILE_SHARE_BIND || file.bind || '127.0.0.1';
  const storage = process.env.FILE_SHARE_STORAGE || file.storage || path.join(HERE, 'storage');

  // A public base is needed so generated links are usable by whoever receives them.
  let publicBase = process.env.FILE_SHARE_PUBLIC_BASE || file.publicBase || '';
  if (!publicBase) {
    // fall back to the tunnel-managed file, if a tunnel set one
    try {
      const t = fs.readFileSync(path.join(HERE, '..', 'frp', 'public-base.txt'), 'utf8').trim();
      if (t) publicBase = t;
    } catch {}
  }
  if (!publicBase) {
    const host = bind === '0.0.0.0' ? lanAddress() : bind;
    publicBase = `http://${host}:${port}`;
  }

  // Password for the file-list page. Empty means the listing stays disabled
  // rather than silently becoming public.
  const password = process.env.FILE_SHARE_PASSWORD ?? file.password ?? '';

  // Who may upload through the web UI.
  //   'off'      no write path at all; the service is pure read-only
  //   'local'    only requests that originate on this machine  (DEFAULT)
  //   'session'  anyone who has logged in with the password
  // 'local' is the default on purpose: this service is reachable from the
  // internet, and a public write endpoint plus a weak password means strangers
  // can fill the disk or host content from this IP.
  const uploadRaw = String(process.env.FILE_SHARE_UPLOAD ?? file.upload ?? 'local').toLowerCase();
  const upload = ['off', 'local', 'session'].includes(uploadRaw) ? uploadRaw : 'local';
  const uploadMaxMb = Number(process.env.FILE_SHARE_UPLOAD_MAX_MB || file.uploadMaxMb || 512);

  // Daily ceiling on web uploads. This is the safety net for running 'session'
  // mode with a weak password: if someone guesses the password, the worst case is
  // bounded instead of "fill the disk". 0 disables the corresponding check.
  const uploadDailyMb = Number(process.env.FILE_SHARE_UPLOAD_DAILY_MB ?? file.uploadDailyMb ?? 5120);
  const uploadDailyCount = Number(process.env.FILE_SHARE_UPLOAD_DAILY_COUNT ?? file.uploadDailyCount ?? 200);

  return {
    port,
    bind,
    storage,
    password: String(password),
    upload,
    uploadMaxMb,
    uploadDailyMb,
    uploadDailyCount,
    publicBase: publicBase.replace(/\/+$/, ''),
    file,
  };
}
