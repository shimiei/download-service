// Upload history store. Kept as plain JSON so it can be read, backed up, or
// hand-edited without this server running.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = new URL('../data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const INDEX_FILE = path.join(DATA_DIR, 'uploads.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function load() {
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j.uploads) ? j.uploads : [];
  } catch {
    return [];
  }
}

export function save(uploads) {
  ensureDir();
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, uploads }, null, 2), 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
  try {
    // best effort: keep the share credentials readable only by this user
    fs.chmodSync(INDEX_FILE, 0o600);
  } catch {}
}

export function add(record) {
  const uploads = load();
  uploads.unshift(record);
  save(uploads.slice(0, 500));
  return record;
}

export function update(id, patch) {
  const uploads = load();
  const i = uploads.findIndex((u) => u.id === id);
  if (i >= 0) {
    uploads[i] = { ...uploads[i], ...patch };
    save(uploads);
    return uploads[i];
  }
  return null;
}

export function find(id) {
  return load().find((u) => u.id === id || u.webfolderId === id);
}

export function newId() {
  return `up_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function expiryOf(record) {
  if (!record.uploadedAt || !record.retentionHours) return null;
  return new Date(new Date(record.uploadedAt).getTime() + record.retentionHours * 3600 * 1000);
}
