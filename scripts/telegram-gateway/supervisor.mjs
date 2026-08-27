#!/usr/bin/env node
// supervisor.mjs — Đảm bảo đúng 1 gateway instance chạy; tự heal khi chết/stale.
// GPT-REV-078: nhận biết "instance đang chạy" qua probe OS TCP lease (bind port độc quyền), KHÔNG đọc file-lock.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeLease, isReady, readHealth, releaseLock, STALE_MS, LEASE_PORT } from './contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.join(HERE, 'gateway.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startGateway(env = process.env) {
  const child = spawn(process.execPath, [GATEWAY, '--start'], { detached: true, stdio: 'ignore', env });
  child.unref();
  return child.pid;
}

// Quyết định 1 chu kỳ supervisor (injectable để test):
// - lease được giữ REAL + health ready -> 'already-ready'
// - lease được giữ nhưng CHƯA ready -> 'monitor-degraded' (instance sống, chỉ theo dõi, KHÔNG spawn)
// - không ai giữ lease -> spawn, chờ ready, VÀ lease ready ĐÚNG là child ta spawn -> 'recovered'
// - ready nhưng lease thuộc pid khác -> 'already-ready-other'
// - hết timeout không ready -> 'recovery-failed'
export async function runSupervisorOnce({ startGatewayFn = startGateway, isReadyFn = isReady, probeFn = probeLease, timeoutMs = 5000, leasePort = LEASE_PORT } = {}) {
  if (await isReadyFn()) return { action: 'already-ready' };
  const probe = await probeFn(1500);
  if (probe.alive) return { action: 'monitor-degraded', pid: probe.lease ? probe.lease.pid : null };
  const childPid = await startGatewayFn();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if (await isReadyFn()) {
      if (childPid != null) {
        const p = await probeFn(1500);
        if (p.alive && p.lease && p.lease.pid === childPid) return { action: 'recovered', pid: childPid };
        return { action: 'already-ready-other', pid: p.lease && p.lease.pid };
      }
      return { action: 'recovered' };
    }
  }
  return { action: 'recovery-failed', pid: childPid };
}

export const MAX_BACKOFF_MS = 5 * 60_000;
export const MAX_CONSECUTIVE_FAILS = 5;
export const FAIL_WINDOW_MS = 10 * 60_000;
export function computeBackoff(consecutiveFails) {
  return Math.min(MAX_BACKOFF_MS, STALE_MS * 2 ** Math.max(0, consecutiveFails - 1));
}
export function isCircuitOpen(consecutiveFails, windowStart, now) {
  if (windowStart === 0) return false;
  return consecutiveFails >= MAX_CONSECUTIVE_FAILS && (now - windowStart) <= FAIL_WINDOW_MS;
}

// Vòng giám sát supervisor. GPT-REV-086: production PHẢI ngủ đúng backoff (computeBackoff lên tới
// MAX_BACKOFF_MS) để thật sự tránh restart storm — KHÔNG clamp xuống 2s. Test chạy nhanh bằng cách
// tiêm `sleepFn` rút ngắn, KHÔNG đụng thời gian production.
export async function supervisorLoop({ runSupervisorOnceFn = runSupervisorOnce, sleepFn = sleep } = {}) {
  let consecutiveFails = 0;
  let windowStart = 0;
  while (true) {
    const r = await runSupervisorOnceFn();
    if (['recovered', 'already-ready', 'already-ready-other', 'monitor-degraded'].includes(r.action)) {
      consecutiveFails = 0; windowStart = 0;
      await sleepFn(STALE_MS / 2);
      continue;
    }
    consecutiveFails += 1;
    if (windowStart === 0) windowStart = Date.now();
    if (isCircuitOpen(consecutiveFails, windowStart, Date.now())) {
      console.error(`supervisor: circuit-open sau ${consecutiveFails} lần recovery-failed; nghỉ ${MAX_BACKOFF_MS}ms. Kiểm tra log gateway.`);
      await sleepFn(MAX_BACKOFF_MS);
      consecutiveFails = 0; windowStart = 0;
      continue;
    }
    const backoff = computeBackoff(consecutiveFails);
    console.error(`supervisor: recovery-failed (lần ${consecutiveFails}); backoff ${backoff}ms`);
    await sleepFn(backoff); // GPT-REV-086: ngủ ĐÚNG backoff, không clamp.
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--stop')) {
    probeLease().then((p) => {
      if (p.alive && p.lease && p.lease.pid) { try { process.kill(p.lease.pid, 'SIGTERM'); } catch {} }
      console.log('supervisor: stop');
      process.exit(0);
    });
    return;
  }
  if (argv.includes('--status')) {
    (async () => {
      const p = await probeLease();
      console.log(JSON.stringify({ alive: p.alive, ready: await isReady(), lease: p.lease, health: readHealth() }));
      process.exit(0);
    })();
    return;
  }
  if (argv.includes('--once')) {
    runSupervisorOnce().then((r) => { console.log(JSON.stringify(r)); process.exit(0); });
    return;
  }
  // Production: chạy vòng giám sát với backoff ĐÚNG thời gian (GPT-REV-086).
  supervisorLoop().catch((e) => { console.error('supervisor: ' + (e && e.message || e)); process.exit(1); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();