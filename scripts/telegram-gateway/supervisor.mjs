#!/usr/bin/env node
// supervisor.mjs — Đảm bảo đúng 1 gateway instance (bridge+notifier) chạy; tự heal khi chết/stale.
// Chạy độc lập (cron/pm2/nohup): `node scripts/telegram-gateway/supervisor.mjs --run`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock, isLockAlive, STALE_MS, READY_FILE } from './contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.join(HERE, 'gateway.mjs');

function startGateway() {
  const child = spawn(process.execPath, [GATEWAY, '--start'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

function stopGateway() {
  const l = readLock();
  if (l && l.pid) { try { process.kill(l.pid, 'SIGTERM'); } catch {} }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--stop')) { stopGateway(); console.log('supervisor: stop'); process.exit(0); }
  if (argv.includes('--status')) {
    const l = readLock();
    console.log(JSON.stringify({ alive: isLockAlive(l), lock: l }));
    process.exit(0);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    while (true) {
      const l = readLock();
      if (!isLockAlive(l)) {
        // stale hoặc chết -> kill tiến trình cũ (nếu còn) rồi spawn lại
        if (l && l.pid) { try { process.kill(l.pid, 'SIGTERM'); } catch {} }
        startGateway();
        try { fs.writeFileSync(READY_FILE, String(Date.now())); } catch {}
      }
      await sleep(STALE_MS / 2);
    }
  })();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
