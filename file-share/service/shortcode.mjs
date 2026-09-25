// Short-link code generation, shared by both write paths:
//   * backends/local.mjs   when the MCP publishes
//   * service/server.mjs   when the web UI uploads
//
// Keeping one implementation matters: two generators with different alphabets
// or lengths would let the two paths mint colliding codes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// No 0/O/1/l/I: these get read aloud, retyped, and copied by hand.
export const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 8;

export function newShortCode(taken = new Set()) {
  for (;;) {
    const bytes = crypto.randomBytes(CODE_LEN);
    let out = '';
    for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    if (!taken.has(out)) return out;
  }
}

export function collectTakenCodes(storageDir) {
  const codes = new Set();
  let ids = [];
  try {
    ids = fs.readdirSync(storageDir);
  } catch {
    return codes;
  }
  for (const id of ids) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(storageDir, id, 'meta.json'), 'utf8'));
      if (m.short) codes.add(m.short);
    } catch {}
  }
  return codes;
}
