#!/usr/bin/env node
// gateway.mjs — Single gateway instance (Issue #15). Chạy bridge (inbound) + notifier (outbound)
// trong 1 process, giữ lock + heartbeat. Chỉ 1 getUpdates poller -> tránh 409 conflict.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './transport.mjs';
import { pollOnce, tryAcquireLock } from './bridge.mjs';
import { processOutbound } from './notifier.mjs';
import { readLock, touchHeartbeat, HEARTBEAT_MS, READY_FILE } from './contract.mjs';

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--status')) { console.log(JSON.stringify(readLock())); process.exit(0); }
  const cfg = loadConfig();
  if (!cfg) { console.error('gateway: thiếu token/chatId'); process.exit(2); }
  const instanceId = `${process.pid}-${Date.now()}`;
  const acq = tryAcquireLock(instanceId);
  if (!acq.acquired) {
    console.error('gateway: duplicate instance (pid=' + acq.lock.pid + ') -> thoát');
    process.exit(3);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try { fs.writeFileSync(READY_FILE, String(Date.now())); } catch {}

  const bridgeLoop = (async () => {
    while (true) {
      try { const r = await pollOnce(cfg); if (!r.ok && r.status === 429) await sleep((r.retryAfter || 5) * 1000); }
      catch (e) { console.error('bridge: ' + e.message); }
      touchHeartbeat(readLock());
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
