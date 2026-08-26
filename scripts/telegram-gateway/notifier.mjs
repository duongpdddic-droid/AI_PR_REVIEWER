#!/usr/bin/env node
// notifier.mjs — Single outbound sender. Đọc outbound queue (TẤT CẢ appNs), gửi qua transport (retry/429),
// idempotency (NotificationStore) theo gatewayEventKey bao gồm appNs + repo + ref + event + state + HEAD.
// Envelope invalid -> deadletter (không retry vô hạn). KHÔNG gửi trùng; lỗi -> giữ lại retry sau.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, sendTelegram } from './transport.mjs';
import { buildMessage, NotificationStore } from '../tg-notify-core.mjs';
import {
  APP_NS, RUNTIME_DIR, HEARTBEAT_MS, readOutboundAll, dequeue, deadletter,
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
  // GPT-REV-083: duplicate (đã gửi, key trong SENT store) -> skip VÀ dequeue để queue không tăng mãi.
  if (!store.shouldSend(key)) {
    dequeue(item.appNs || APP_NS, 'outbound', item.id);
    return { sent: false, skipped: true, key };
  }
  const text = buildMessage(item.payload);
  const r = await sendTelegram({ token: cfg.botToken, chatId: cfg.chatId, text }, { fetchImpl, sleep });
  if (r.ok) {
    store.markSent(key); // chỉ markSent SAU khi gửi thành công
    dequeue(item.appNs || APP_NS, 'outbound', item.id);
    return { sent: true, key, ...r };
  }
  return { sent: false, key, ...r }; // KHÔNG markSent -> item còn, retry sau
}

// GPT-REV-082: 1 notifier duy nhất xử lý outbound của TẤT CẢ registered appNs.
// readOutboundAll() trả mọi item trong OUTBOUND_DIR (shared) bất kể appNs.
// sendItem tự validate envelope -> item appNs unknown sẽ bị deadletter (fail-closed).
export async function processOutbound(cfg, { fetchImpl, sleep, once } = {}) {
  const items = readOutboundAll();
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
