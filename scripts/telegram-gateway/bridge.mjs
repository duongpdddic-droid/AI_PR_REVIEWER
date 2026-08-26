#!/usr/bin/env node
// bridge.mjs — Single getUpdates poller (inbound). Lock đảm bảo CHỈ 1 instance (chống 409 conflict).
// Nhận command từ Bố, parse namespace, enqueue vào inbound queue cho agent xử lý.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getUpdates } from './transport.mjs';
import {
  APP_NS, LOCK_FILE, RUNTIME_DIR, STALE_MS, HEARTBEAT_MS,
  readLock, writeLock, touchHeartbeat, isLockAlive, releaseLock, enqueue,
} from './contract.mjs';

// Parse một update thành { appNs, command, args, raw, updateId } hoặc null (bỏ qua).
// Quy ước command: "/<appNs>:<lệnh> <args>" hoặc "/<lệnh>" (mặc định APP_NS).
export function routeUpdate(update, authorizedChatId) {
  const msg = update && update.message;
  if (!msg) return null;
  const fromId = String(msg.chat && msg.chat.id);
  if (authorizedChatId && fromId !== String(authorizedChatId)) return null; // chỉ nhận chat được phép
  const text = (msg.text || '').trim();
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).split(/\s+/);
  const head = parts[0] || '';
  const segs = head.split(':');
  let appNs = APP_NS;
  let command = head;
  if (segs.length >= 2) { appNs = segs[0]; command = segs.slice(1).join(':'); }
  const args = parts.slice(1).join(' ');
  return { appNs, command, args, raw: text, updateId: update.update_id };
}

// Thử chiếm lock. Nếu đã có instance sống -> {acquired:false, reason:'duplicate'}. Nếu stale -> takeover.
export function tryAcquireLock(instanceId) {
  const existing = readLock();
  if (isLockAlive(existing)) return { acquired: false, reason: 'duplicate', lock: existing };
  return { acquired: true, lock: writeLock(instanceId, process.pid) };
}

const OFFSET_FILE = path.join(RUNTIME_DIR, 'offset.json');
function readOffset() {
  try { return Number(JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0); } catch { return 0; }
}
function writeOffset(o) {
  try { fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset: o })); } catch {}
}

// Xử lý 1 batch getUpdates (dùng cho --once và trong loop).
export async function pollOnce(cfg, { enqueueFn = enqueue, fetchImpl } = {}) {
  const offset = readOffset();
  const r = await getUpdates({ token: cfg.botToken, offset, fetchImpl });
  if (r.ok) {
    for (const u of r.updates) {
      const routed = routeUpdate(u, cfg.chatId);
      if (routed) enqueueFn(routed.appNs, 'inbound', routed);
    }
    writeOffset(r.offset);
  }
  return r;
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  if (!cfg) { console.error('bridge: thiếu token/chatId'); process.exit(2); }
  if (argv.includes('--status')) { console.log(JSON.stringify(readLock())); process.exit(0); }
  if (argv.includes('--stop')) { releaseLock(); console.log('bridge: released lock'); process.exit(0); }
  const instanceId = `${process.pid}-${Date.now()}`;
  const acq = tryAcquireLock(instanceId);
  if (!acq.acquired) {
    console.error('bridge: instance khác đang chạy (pid=' + acq.lock.pid + ') -> thoát');
    process.exit(3);
  }
  if (argv.includes('--once')) { await pollOnce(cfg); process.exit(0); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (true) {
    try {
      const r = await pollOnce(cfg);
      if (!r.ok && r.status === 429) await sleep((r.retryAfter || 5) * 1000);
    } catch (e) { console.error('bridge poll error: ' + e.message); }
    touchHeartbeat(readLock());
    await sleep(HEARTBEAT_MS);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
