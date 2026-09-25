#!/usr/bin/env node
// Start / stop / inspect the local download service.
//
//   node service/manage.mjs start     start detached, wait for health, print URL
//   node service/manage.mjs stop      stop it
//   node service/manage.mjs status    PID + health + published file count
//   node service/manage.mjs restart
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, lanAddress } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const PID_FILE = path.join(HERE, 'service.pid');
const LOG_FILE = path.join(HERE, 'service.log');

const { port: PORT, bind: BIND, publicBase: PUBLIC_BASE } = loadConfig();
const HEALTH = `http://127.0.0.1:${PORT}/healthz`;

const readPid = () => {
  try {
    return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || null;
  } catch {
    return null;
  }
};

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function health(timeoutMs = 2500) {
  try {
    const res = await fetch(HEALTH, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function start() {
  const pid = readPid();
  if (alive(pid)) {
    const h = await health();
    if (h) {
      console.log(`已在运行（PID ${pid}），${h.files} 个文件`);
      return 0;
    }
  }
  const fd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER], {
    cwd: HERE,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const h = await health(1000);
    if (h) {
      console.log(`已启动（PID ${child.pid}）`);
      console.log(`  监听：http://${BIND}:${PORT}`);
      console.log(`  对外地址：${PUBLIC_BASE}`);
      if (BIND === '0.0.0.0') {
        console.log(`  局域网地址：http://${lanAddress()}:${PORT}`);
        console.log(`  首页（文件列表）：需要 service/config.json 里的 password`);
        console.log(`  下载链接用的是 /s/<8位短码>，短码是唯一的访问控制。`);
      }
      console.log(`  日志：${LOG_FILE}`);
      return 0;
    }
  }
  console.error(`启动后健康检查失败，请看日志：${LOG_FILE}`);
  return 1;
}

function stop() {
  const pid = readPid();
  if (!alive(pid)) {
    console.log('未在运行');
    try { fs.unlinkSync(PID_FILE); } catch {}
    return 0;
  }
  try {
    process.kill(pid);
  } catch (e) {
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      console.error(`停止失败：${e.message}`);
      return 1;
    }
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log(`已停止（PID ${pid}）`);
  return 0;
}

async function status() {
  const pid = readPid();
  const running = alive(pid);
  const h = await health();
  console.log(`PID：${pid ?? '无'}（${running ? '进程存在' : '进程不存在'}）`);
  console.log(`健康检查：${h ? `ok，已发布 ${h.files} 个文件` : '失败'}`);
  console.log(`监听：http://${BIND}:${PORT}`);
  console.log(`日志：${LOG_FILE}`);
  return h ? 0 : 1;
}

const cmd = process.argv[2] || 'status';
if (cmd === 'start') process.exit(await start());
else if (cmd === 'stop') process.exit(stop());
else if (cmd === 'restart') { stop(); process.exit(await start()); }
else if (cmd === 'status') process.exit(await status());
else {
  console.log('用法：node service/manage.mjs <start|stop|restart|status>');
  process.exit(2);
}
