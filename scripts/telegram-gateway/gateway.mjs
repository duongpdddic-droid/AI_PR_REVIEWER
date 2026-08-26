#!/usr/bin/env node
// gateway.mjs — Single gateway instance (Issue #15). Chạy bridge (inbound) + notifier (outbound)
// trong 1 process, giữ lock + heartbeat. CHỈ 1 getUpdates poller -> tránh 409 conflict.
// Readiness được publish SAU KHI verified startup (lock + config + ít nhất 1 poll) — GPT-REV-079.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './transport.mjs';
import { pollOnce, tryAcquireLock } from './bridge.mjs';
import { processOutbound } from './notifier.mjs';
import {
  readLock, readHealth, writeHealth, touchHeartbeat, isReady, releaseLock,
  HEARTBEAT_MS, READY_FILE, enqueue,
} from './contract.mjs';

function makeEnqueue(health) {
  return (appNs, kind, payload) => {
    const id = enqueue(appNs, kind, payload);
    health.lastInboxWrite = Date.now();
    return id;
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--status')) {
    console.log(JSON.stringify({ lock: readLock(), health: readHealth(), ready: isReady() }));
    process.exit(0);
  }
  const cfg = loadConfig();
  if (!cfg) { console.error('gateway: thiếu token/chatId'); process.exit(2); }
  const instanceId = `${process.pid}-${Date.now()}`;
  const acq = tryAcquireLock(instanceId);
  if (!acq.acquired) {
    console.error('gateway: duplicate instance (pid=' + (acq.lock && acq.lock.pid) + ') -> thoát');
    process.exit(3);
  }
  // Graceful shutdown: owner release lock + clear ready để supervisor healing đúng.
  const onExit = () => {
    try { releaseLock(instanceId); } catch {}
    try { fs.unlinkSync(READY_FILE); } catch {}
  };
  process.on('SIGTERM', () => { onExit(); process.exit(0); });
  process.on('SIGINT', () => { onExit(); process.exit(0); });

  const health = {
    instanceId, pid: process.pid, status: 'starting',
    startedAt: Date.now(), lastHeartbeat: Date.now(),
    lastSuccessfulPoll: null, lastInboxWrite: null, consecutiveFailures: 0,
  };
  writeHealth(health);

  // Verified startup: poll đầu tiên bắt buộc trước khi khai báo ready.
  const r0 = await pollOnce(cfg, { enqueueFn: makeEnqueue(health) });
  if (r0.status === 409) { console.error('gateway: 409 conflict -> stand down'); process.exit(3); }
  health.lastSuccessfulPoll = r0.ok ? Date.now() : health.lastSuccessfulPoll;
  health.consecutiveFailures = r0.ok ? 0 : 1;
  health.status = r0.ok ? 'ready' : 'degraded';
  health.lastHeartbeat = Date.now();
  writeHealth(health);
  try { fs.writeFileSync(READY_FILE, String(Date.now())); } catch {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bridgeLoop = (async () => {
    while (true) {
      try {
        const r = await pollOnce(cfg, { enqueueFn: makeEnqueue(health) });
        if (r.status === 409) { console.error('gateway: 409 conflict -> stand down'); process.exit(3); }
        health.lastSuccessfulPoll = r.ok ? Date.now() : health.lastSuccessfulPoll;
        health.consecutiveFailures = r.ok ? 0 : health.consecutiveFailures + 1;
        if (!r.ok) health.status = 'degraded';
        else if (health.status === 'degraded' && health.consecutiveFailures === 0) health.status = 'ready';
      } catch (e) { console.error('bridge: ' + e.message); }
      health.lastHeartbeat = Date.now();
      writeHealth(health);
      touchHeartbeat(acq.lock, instanceId);
      await sleep(HEARTBEAT_MS);
    }
  })();
  const notifierLoop = (async () => {
    while (true) {
      try { await processOutbound(cfg); } catch (e) { console.error('notifier: ' + e.message); }
      await sleep(HEARTBEAT_MS);
    }
  })();
  await Promise.all([bridgeLoop, notifierLoop]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
