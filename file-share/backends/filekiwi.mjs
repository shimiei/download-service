// file.kiwi backend: no account, no API key, client-side AES-GCM encryption.
// The decryption key lives in the share URL fragment and never reaches the server.
import path from 'node:path';
import { createWebFolder, startUpload } from '@file-kiwi/node';

export const id = 'filekiwi';
export const label = 'file.kiwi（免注册，端到端加密）';
export const retention = '上传后 90 小时自动删除；前 24 小时为免费下载窗口';
export const needsAccount = false;

const API = 'https://api.file.kiwi';

export async function upload(filePath, { title, onProgress } = {}) {
  const webfolder = await createWebFolder({
    title: title || path.basename(filePath),
    files: [{ filepath: filePath }],
  });

  const f = webfolder.files[0];
  const record = {
    backend: id,
    url: webfolder.webfolderUrl,
    secretKey: webfolder.secretKey,
    webfolderId: webfolder.webfolderId,
    fid: f.fid,
    apiAuth: webfolder.apiAuth,
    chunkSize: f.chunkSize,
    chunks: f.chunks,
    retentionHours: webfolder.retentionHours,
    freeDownloadHours: f.freeDownloadHours,
  };

  await startUpload(webfolder, {
    onProgress: onProgress ? (_file, uploaded, total) => onProgress(uploaded, total) : undefined,
  });

  return record;
}

// Server-side check: is the encrypted payload still on file.kiwi, and are all chunks present?
export async function verify(record) {
  if (!record.fid || !record.webfolderId || !record.apiAuth) {
    return { alive: false, error: '缺少 fid / webfolderId / apiAuth，无法校验' };
  }
  const url = `${API}/v1/upload/check/${record.fid}?webfolderId=${record.webfolderId}&apiAuth=${encodeURIComponent(record.apiAuth)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { alive: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    return { alive: true, complete: !!j.complete, missing: j.missing ?? [] };
  } catch (err) {
    return { alive: false, error: err.message };
  }
}
