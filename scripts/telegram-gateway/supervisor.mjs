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

// Quyết định 1 chu kỳ supervisor (injectable để test — GPT-REV-079/081):
// - đã ready -> 'already-ready'
// - lock còn sống (owner pid + heartbeat) nhưng CHƯA ready -> 'monitor-degraded' (chỉ theo dõi, KHÔNG spawn —
//   instance đang chạy nhưng xuống cấp; spawn thêm sẽ chết vì duplicate, gây restart storm)
// - spawn xong, đợi ready, VÀ lock ready đúng là child ta spawn (chứng minh restart đúng child) -> 'recovered'
// - ready nhưng lock thuộc pid khác -> 'already-ready-other' (instance khác đang chạy, KHÔNG kill)
// - hết timeout mà không ready -> 'recovery-failed'
export async function runSupervisorOnce({ startGatewayFn = startGateway, isReadyFn = isReady, readLockFn = readLock, timeoutMs = 5000 } = {}) {
  if (isReadyFn()) return { action: 'already-ready' };
  // GPT-REV-079: lock sống + chưa ready = live-degraded -> monitor, không spawn (dead/stale mới spawn 1).
  const cur = readLockFn();
  if (cur && isLockAlive(cur)) return { action: 'monitor-degraded', pid: cur.pid };
  const childPid = startGatewayFn(); // pid của child ta vừa spawn (nếu có)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if (isReadyFn()) {
      // Chỉ claim 'recovered' khi lock ready ĐÚNG là child chúng ta spawn (tránh nhận ready của instance khác).
      if (childPid != null) {
        const lk = readLockFn();
        if (lk && lk.pid === childPid) return { action: 'recovered', pid: childPid };
        return { action: 'already-ready-other', pid: lk && lk.pid };
      }
      return { action: 'recovered' };
    }
  }
  return { action: 'recovery-failed', pid: childPid };
}

// Tránh restart storm (GPT-REV-079): backoff cấp số nhân + circuit breaker sau N fail liên tiếp trong cửa sổ.
export const MAX_BACKOFF_MS = 5 * 60_000;
export const MAX_CONSECUTIVE_FAILS = 5;
export const FAIL_WINDOW_MS = 10 * 60_000;
// Backoff khởi điểm = 1 chu kỳ stale (đủ để process chết hoàn toàn trước khi retry).
export function computeBackoff(consecutiveFails) {
  return Math.min(MAX_BACKOFF_MS, STALE_MS * 2 ** Math.max(0, consecutiveFails - 1));
}
// Circuit open khi đủ N fail liên tiếp trong cửa sổ -> nghỉ dài thay vì spawn vô tội vạ.
export function isCircuitOpen(consecutiveFails, windowStart, now) {
  if (windowStart === 0) return false;
  return consecutiveFails >= MAX_CONSECUTIVE_FAILS && (now - windowStart) <= FAIL_WINDOW_MS;
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
    let consecutiveFails = 0;
    let windowStart = 0;
    while (true) {
      const r = await runSupervisorOnce();
      if (r.action === 'recovered' || r.action === 'already-ready' || r.action === 'already-ready-other' || r.action === 'monitor-degraded') {
        consecutiveFails = 0; windowStart = 0;
        await sleep(STALE_MS / 2);
        continue;
      }
      // recovery-failed -> tăng counter, áp backoff / circuit breaker
      consecutiveFails += 1;
      if (windowStart === 0) windowStart = Date.now();
      if (isCircuitOpen(consecutiveFails, windowStart, Date.now())) {
        console.error(`supervisor: circuit-open sau ${consecutiveFails} lần recovery-failed liên tiếp; nghỉ ${MAX_BACKOFF_MS}ms để tránh restart storm. Kiểm tra log gateway.`);
        await sleep(MAX_BACKOFF_MS);
        consecutiveFails = 0; windowStart = 0;
        continue;
      }
      const backoff = computeBackoff(consecutiveFails);
      console.error(`supervisor: recovery-failed (lần ${consecutiveFails}); backoff ${backoff}ms`);
      await sleep(backoff);
    }
  })();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
