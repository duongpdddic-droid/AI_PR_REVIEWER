#!/usr/bin/env node
// supervisor.mjs — Đảm bảo đúng 1 gateway instance chạy; tự heal khi chết/stale.
// Chạy độc lập: `node scripts/telegram-gateway/supervisor.mjs --run` (hoặc --once để thử 1 chu kỳ).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock, isLockAlive, isReady, readHealth, releaseLock, STALE_MS } from './contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.join(HERE, 'gateway.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn gateway thực tế. Truyền env để gateway dùng cùng runtime dir.
export function startGateway(env = process.env) {
  const child = spawn(process.execPath, [GATEWAY, '--start'], { detached: true, stdio: 'ignore', env });
  child.unref();
  return child.pid;
}

// Quyết định 1 chu kỳ supervisor: đọc trạng thái, spawn nếu cần, chờ ready (timeout),
// báo recovered / recovery-failed / already-ready. Injectable để test (GPT-REV-079/081).
export async function runSupervisorOnce({ startGatewayFn = startGateway, isReadyFn = isReady, timeoutMs = 5000 } = {}) {
  if (isReadyFn()) return { action: 'already-ready' };
  startGatewayFn();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if (isReadyFn()) return { action: 'recovered' };
  }
  return { action: 'recovery-failed' };
}

function stopGateway() {
  const l = readLock();
  if (l && l.pid) { try { process.kill(l.pid, 'SIGTERM'); } catch {} }
  try { releaseLock(); } catch {}
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--stop')) { stopGateway(); console.log('supervisor: stop'); process.exit(0); }
  if (argv.includes('--status')) {
    const l = readLock();
    console.log(JSON.stringify({ alive: isLockAlive(l), ready: isReady(), lock: l, health: readHealth() }));
    process.exit(0);
  }
  if (argv.includes('--once')) {
    runSupervisorOnce().then((r) => { console.log(JSON.stringify(r)); process.exit(0); });
    return;
  }
  (async () => {
    let reportedFailed = false;
    while (true) {
      const r = await runSupervisorOnce();
      if (r.action === 'recovery-failed' && !reportedFailed) { console.error('supervisor: recovery-failed'); reportedFailed = true; }
      if (r.action === 'recovered') reportedFailed = false;
      await sleep(STALE_MS / 2);
    }
  })();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
