#!/usr/bin/env node
// gateway.mjs — Single gateway instance (Issue #15). Chạy bridge (inbound) + notifier (outbound)
// trong 1 process, giữ lock + heartbeat. CHỈ 1 getUpdates poller -> tránh 409 conflict.
// Readiness được publish SAU KHI verified startup (lock + config + ít nhất 1 poll) — GPT-REV-079.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './transport.mjs';
import { pollOnce, tryAcquireLock } from './bridge.mjs';
import { processOutbound } from './notifier.mjs';
import { dispatchInbound } from './dispatcher.mjs';
import {
  readLock, readHealth, writeHealth, touchHeartbeat, isReady, releaseLock,
  writeReadyFlag, readQueue, dequeue, HEARTBEAT_MS, READY_FILE, RUNTIME_DIR, APP_NS, enqueue,
} from './contract.mjs';

function makeEnqueue(health) {
  return (appNs, kind, payload) => {
    const id = enqueue(appNs, kind, payload);
    health.lastInboxWrite = Date.now();
    return id;
  };
}

// Test hook: --fetch-impl <module> default-export fetch(url, opts). Cần file:// URL trên Windows.
async function resolveFetchImpl(argv) {
  const i = argv.indexOf('--fetch-impl');
  const p = i >= 0 ? argv[i + 1] : null;
  if (p) return (await import(pathToFileURL(path.resolve(p)).href)).default;
  return fetch;
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
  // GPT-REV-079: dọn stale/mismatched READY_FILE của instance cũ trước khi publish ready mới.
  if (fs.existsSync(READY_FILE)) {
    try {
      const rdy = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
      if (rdy.instanceId !== instanceId) fs.unlinkSync(READY_FILE);
    } catch { try { fs.unlinkSync(READY_FILE); } catch {} }
  }
  const fetchImpl = await resolveFetchImpl(argv);
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
  const r0 = await pollOnce(cfg, { enqueueFn: makeEnqueue(health), fetchImpl });
  if (r0.status === 409) { console.error('gateway: 409 conflict -> stand down'); process.exit(3); }
  health.lastSuccessfulPoll = r0.ok ? Date.now() : health.lastSuccessfulPoll;
  health.consecutiveFailures = r0.ok ? 0 : 1;
  health.status = r0.ok ? 'ready' : 'degraded';
  health.lastHeartbeat = Date.now();
  writeHealth(health);
  if (health.status === 'ready') writeReadyFlag(instanceId); // GPT-REV-079: chỉ publish khi ready

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bridgeLoop = (async () => {
    while (true) {
      try {
        const r = await pollOnce(cfg, { enqueueFn: makeEnqueue(health), fetchImpl });
        if (r.status === 409) { console.error('gateway: 409 conflict -> stand down'); process.exit(3); }
        health.lastSuccessfulPoll = r.ok ? Date.now() : health.lastSuccessfulPoll;
        health.consecutiveFailures = r.ok ? 0 : health.consecutiveFailures + 1;
        if (!r.ok) health.status = 'degraded';
        else if (health.status === 'degraded' && health.consecutiveFailures === 0) health.status = 'ready';
      } catch (e) { console.error('bridge: ' + e.message); }
      health.lastHeartbeat = Date.now();
      writeHealth(health);
      // Cập nhật READY flag theo trạng thái thực tế (chống publish ready giả khi poll fail).
      if (health.status === 'ready') writeReadyFlag(instanceId);
      else { try { fs.unlinkSync(READY_FILE); } catch {} }
      touchHeartbeat(instanceId); // GPT-REV-078: chỉ owner mới ghi heartbeat
      await sleep(HEARTBEAT_MS);
    }
  })();
  const notifierLoop = (async () => {
    while (true) {
      try { await processOutbound(cfg, { fetchImpl }); } catch (e) { console.error('notifier: ' + e.message); }
      await sleep(HEARTBEAT_MS);
    }
  })();
  const inboundLoop = (async () => {
    while (true) {
      try {
        const items = readQueue(APP_NS, 'inbound');
        for (const it of items) {
          dispatchInbound(it.payload); // Issue #15: KHÔNG verdict self-review, chỉ dispatch command
          dequeue(APP_NS, 'inbound', it.id);
        }
      } catch (e) { console.error('inbound: ' + e.message); }
      await sleep(HEARTBEAT_MS);
    }
  })();
  await Promise.all([bridgeLoop, notifierLoop, inboundLoop]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
