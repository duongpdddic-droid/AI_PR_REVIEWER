#!/usr/bin/env node
// notifier.mjs — Single outbound sender. Đọc outbound queue, gửi qua transport (retry/429),
// idempotency (NotificationStore) theo gatewayEventKey bao gồm appNs/projectId + HEAD.
// Envelope invalid -> deadletter (không retry vô hạn). KHÔNG gửi trùng; lỗi -> giữ lại retry sau.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, sendTelegram } from './transport.mjs';
import { buildMessage, NotificationStore } from '../tg-notify-core.mjs';
import {
  APP_NS, RUNTIME_DIR, HEARTBEAT_MS, readQueue, dequeue, deadletter,
  gatewayEventKey, validateEnvelope,
} from './contract.mjs';

// SENT store lưu ở runtime (KHÔNG commit). Tái sử dụng idempotency liên lần restart.
const SENT_PATH = path.join(RUNTIME_DIR, 'sent.json');
const store = new NotificationStore({
  load: () => { try { return JSON.parse(fs.readFileSync(SENT_PATH, 'utf8')); } catch { return {}; } },
  save: (m) => fs.writeFileSync(SENT_PATH, JSON.stringify(m, null, 2)),
});

// Gửi 1 item outbound. payload = {eventType, repo, ref, state, summary, nextAction, link, appNs, head}.
export async function sendItem(item, cfg, { fetchImpl, sleep } = {}) {
  let key;
  try {
    validateEnvelope(item.payload);
    key = gatewayEventKey(item.payload);
  } catch (e) {
    // envelope không hợp lệ -> deadletter, không retry vô hạn
    deadletter(item.appNs || APP_NS, 'outbound', item.id, 'invalid');
    return { sent: false, invalid: true, key: null, error: String((e && e.message) || e) };
  }
  if (!store.shouldSend(key)) return { sent: false, skipped: true, key };
  const text = buildMessage(item.payload);
  const r = await sendTelegram({ token: cfg.botToken, chatId: cfg.chatId, text }, { fetchImpl, sleep });
  if (r.ok) {
    store.markSent(key); // chỉ markSent SAU khi gửi thành công
    dequeue(item.appNs || APP_NS, 'outbound', item.id);
    return { sent: true, key, ...r };
  }
  return { sent: false, key, ...r }; // KHÔNG markSent -> item còn, retry sau
}

export async function processOutbound(cfg, { fetchImpl, sleep, once } = {}) {
  const items = readQueue(APP_NS, 'outbound').filter((it) => it.appNs === APP_NS);
  let sent = 0;
  for (const it of items) {
    const r = await sendItem(it, cfg, { fetchImpl, sleep });
    if (r.sent) sent += 1;
    if (once) break;
  }
  return { processed: items.length, sent };
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  if (!cfg) { console.error('notifier: thiếu token/chatId'); process.exit(2); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (argv.includes('--once')) { console.log(JSON.stringify(await processOutbound(cfg, { fetchImpl: fetch, sleep }))); process.exit(0); }
  while (true) {
    try { await processOutbound(cfg, { fetchImpl: fetch, sleep }); } catch (e) { console.error('notifier error: ' + e.message); }
    await sleep(HEARTBEAT_MS);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
