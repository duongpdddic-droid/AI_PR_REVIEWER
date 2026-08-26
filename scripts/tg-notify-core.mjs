#!/usr/bin/env node
// tg-notify-core.mjs — Lõi thuần (pure, không IO/network) cho Telegram Notification (shared contract).
// Issue #15: dùng chung bởi notify-telegram.mjs và scripts/telegram-gateway/ (single source of truth).
//   - buildMessage(): dựng nội dung Telegram tối thiểu (eventType, repo, issue/pr, state, summary,
//     nextAction, link) với escape an toàn.
//   - eventKey() + NotificationStore: khóa idempotency theo `repo + issue/pr + event type + state/version`;
//     retry sau lỗi gửi được phép, retry sau khi đã SENT không tạo tin thứ hai.
//   - withRetry(): retry có giới hạn, backoff theo số lần fail.
// Không dependency ngoài (chỉ Node stdlib). Test: scripts/test-tg-notify.mjs + scripts/test-telegram-gateway.mjs.

// Retry có giới hạn cho thao tác gửi (Issue #2 A7): thử tối đa `attempts` lần,
// nghỉ `delayMs * (số lần đã fail)` giữa các lần. Ném lỗi cuối cùng nếu hết lượt.
export async function withRetry(fn, { attempts = 3, delayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i < attempts && delayMs > 0) await sleep(delayMs * i);
    }
  }
  throw lastErr;
}


// Escape cho parse_mode=HTML của Telegram (chỉ & < >; KHÔNG escape dấu nháy để tiếng Việt an toàn).
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Nhãn sự kiện theo ma trận Issue #16 / #15 (gateway events: done/blocked/needs-input/test-fail/approved/merged).
export const EVENT_LABELS = {
  start: 'Bắt đầu Issue',
  'needs-input': 'Cần bạn quyết định',
  blocked: 'Bị chặn',
  done: 'Hoàn thành / Bàn giao',
  'test-fail': 'Test/CI thất bại',
  resume: 'Đã tiếp tục',
  approved: 'Đã duyệt (GPT)',
  merged: 'Đã merge',
  'timeout-level1': 'Cảnh báo im lặng (lần 1)',
  'timeout-level2': 'Cảnh báo im lặng (nghiêm trọng)',
};

const isUrl = (s) => typeof s === 'string' && /^https?:\/\//.test(s);

// Dựng nội dung Telegram tối thiểu. Mọi field đều escape (XSS/HTML injection). Trả chuỗi HTML.
export function buildMessage(input) {
  const { eventType, repo, ref, state, summary, nextAction, link } = input || {};
  const label = escapeHtml(EVENT_LABELS[eventType] || eventType || 'Sự kiện');
  const lines = [];
  lines.push('🧩 ' + label);
  if (repo) lines.push('Repo: ' + escapeHtml(repo));
  if (ref) lines.push('Ref: ' + escapeHtml(ref));
  if (state) lines.push('Trạng thái: ' + escapeHtml(state));
  if (summary) lines.push('Chi tiết: ' + escapeHtml(summary));
  if (nextAction) lines.push('Bạn cần: ' + escapeHtml(nextAction));
  if (link && isUrl(link)) lines.push('Link: ' + link); // link do code dựng, giữ nguyên; không chèn text user vào href
  return lines.join('\n');
}

// Khóa idempotency: repo + issue/pr + event type + state/version. state đổi -> khóa đổi -> gửi lại hợp lệ.
export function eventKey({ repo, ref, eventType, state }) {
  return [String(repo ?? ''), String(ref ?? ''), String(eventType ?? ''), String(state ?? '')].join('::');
}

// NotificationStore: chống gửi trùng theo khóa, có persistence injectable (test không cần file thật).
// - storage = { load(): Map<string,true> | Record, save(map): void } — nếu không truyền, dùng Map rỗng (in-memory).
// - Mark SENT chỉ SAU khi gửi thành công (retry sau lỗi vẫn cho phép).
export class NotificationStore {
  constructor(storage = null) {
    this.storage = storage;
    this.sent = new Map();
    if (storage && typeof storage.load === 'function') {
      const raw = storage.load();
      if (raw && typeof raw === 'object') for (const k of Object.keys(raw)) this.sent.set(k, true);
    }
  }
  // Chưa từng gửi thành công khóa này -> được phép gửi.
  shouldSend(key) { return !this.sent.has(key); }
  // Đánh dấu đã gửi thành công; flush xuống storage nếu có.
  markSent(key) {
    this.sent.set(key, true);
    if (this.storage && typeof this.storage.save === 'function') this.storage.save(Object.fromEntries(this.sent));
  }
  has(key) { return this.sent.has(key); }
}

// NOTE (Issue #15): Watchdog hibernate / idle-reminder / shutdown /h logic đã XÓA hoàn toàn.
// Gateway mới (scripts/telegram-gateway/) quản lý lock/heartbeat/supervisor thay thế, không nhắc ngủ đông.
