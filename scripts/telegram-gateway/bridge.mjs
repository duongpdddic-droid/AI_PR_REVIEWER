#!/usr/bin/env node
// bridge.mjs — Single getUpdates poller (inbound). Lock đảm bảo CHỈ 1 instance (chống 409 conflict).
// Nhận command từ Bố, parse + validate namespace, enqueue vào inbound queue cho agent xử lý.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getUpdates } from './transport.mjs';
import {
  APP_NS, RUNTIME_DIR, HEARTBEAT_MS,
  readLock, tryAcquireLock, touchHeartbeat, releaseLock, enqueue, isValidAppNs,
} from './contract.mjs';

// Parse một update thành { appNs, command, args, raw, updateId, fromId } hoặc null (bỏ qua).
// Quy ước command: "/<appNs>:<lệnh> <args>" hoặc "/<lệnh>" (mặc định APP_NS).
// appNs KHÔNG hợp lệ (traversal/unknown) -> reject (null) trước khi enqueue (GPT-REV-077).
// GPT-REV-077: giới hạn user. Reject fail-closed khi thiếu identity (channel_post / forwarded không có from).
export function routeUpdate(update, auth = {}) {
  const msg = update && update.message;
  if (!msg) return null;
  if (auth.chatId && String(msg.chat && msg.chat.id) !== String(auth.chatId)) return null; // chỉ nhận chat được phép
  // Reject channel_post / forwarded (không có from) khi có allowlist user.
  const fromId = msg.from && msg.from.id;
  const ids = auth.userIds;
  if (ids && ids.size && ids.size > 0 && !ids.has(String(fromId))) return null;
  const text = (msg.text || '').trim();
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).split(/\s+/);
  const head = parts[0] || '';
  const segs = head.split(':');
  let appNs = APP_NS;
  let command = head;
  if (segs.length >= 2) { appNs = segs[0]; command = segs.slice(1).join(':'); }
  if (!isValidAppNs(appNs)) return null; // reject traversal/unknown appNs (chat auth không thay thế validation)
  const args = parts.slice(1).join(' ');
  return { appNs, command, args, raw: text, updateId: update.update_id, fromId: fromId ? String(fromId) : null };
}

const OFFSET_FILE = path.join(RUNTIME_DIR, 'offset.json');
function readOffset() {
  try { return Number(JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0); } catch { return 0; }
}
function writeOffset(o) {
  try { fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset: o })); } catch {}
}

// Xử lý 1 batch getUpdates. Trả { ok, status, updates, offset, enqueued }.
export async function pollOnce(cfg, { enqueueFn = enqueue, fetchImpl } = {}) {
  const offset = readOffset();
  const r = await getUpdates({ token: cfg.botToken, offset, fetchImpl });
  let enqueued = 0;
  if (r.ok) {
    for (const u of r.updates) {
      const routed = routeUpdate(u, { chatId: cfg.chatId, userIds: cfg.allowedUserIds });
      if (routed) { enqueueFn(routed.appNs, 'inbound', routed); enqueued += 1; }
    }
    writeOffset(r.offset);
  }
  return { ...r, enqueued };
}

export { tryAcquireLock };

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  if (!cfg) { console.error('bridge: thiếu token/chatId'); process.exit(2); }
  if (argv.includes('--status')) { console.log(JSON.stringify(readLock())); process.exit(0); }
  if (argv.includes('--stop')) { releaseLock(); console.log('bridge: released lock'); process.exit(0); }
  const instanceId = `${process.pid}-${Date.now()}`;
  const acq = await tryAcquireLock(instanceId);
  if (!acq.acquired) {
    console.error('bridge: instance khác đang chạy (pid=' + (acq.lock && acq.lock.pid) + ') -> thoát');
    process.exit(3);
  }
  if (argv.includes('--once')) { await pollOnce(cfg); process.exit(0); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (true) {
    try {
      const r = await pollOnce(cfg);
      if (!r.ok && r.status === 429) await sleep((r.retryAfter || 5) * 1000);
      // 409 = nhiều poller cùng chạy -> lock của ta không hợp lệ -> stand down (không lặp vô hạn).
      if (r.status === 409) { console.error('bridge: 409 conflict (nhiều poller) -> stand down'); process.exit(3); }
    } catch (e) { console.error('bridge poll error: ' + e.message); }
    touchHeartbeat(instanceId);
    await sleep(HEARTBEAT_MS);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
