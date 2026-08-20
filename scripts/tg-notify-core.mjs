#!/usr/bin/env node
// tg-notify-core.mjs — Lõi thuần (pure, không IO/network) cho Telegram Notification & Watchdog Protocol.
// Issue #16: tái sử dụng notifier/watchdog hiện có; chỉ thêm lớp tính toán dùng chung để test được:
//   - buildMessage(): dựng nội dung Telegram tối thiểu (eventType, repo, issue/pr, state, summary,
//     nextAction, link) với escape an toàn.
//   - eventKey() + NotificationStore: khóa idempotency theo `repo + issue/pr + event type + state/version`;
//     retry sau lỗi gửi được phép, retry sau khi đã SENT không tạo tin thứ hai.
//   - silenceTimeoutLevels() + nextSilenceState(): watchdog 2 mức cảnh báo (level1 / level2) dựa timestamp
//     thực tế, không suy đoán từ log; reset khi hoạt động trở lại.
// Không dependency ngoài (chỉ Node stdlib). Các test ở scripts/test-tg-notify.mjs.

// Escape cho parse_mode=HTML của Telegram (chỉ & < >; KHÔNG escape dấu nháy để tiếng Việt an toàn).
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Nhãn sự kiện theo ma trận Issue #16.
export const EVENT_LABELS = {
  start: 'Bắt đầu Issue',
  'needs-input': 'Cần bạn quyết định',
  blocked: 'Bị chặn',
  done: 'Hoàn thành / Bàn giao',
  'test-fail': 'Test/CI thất bại',
  resume: 'Đã tiếp tục',
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

// Mức cảnh báo im lặng watchdog dựa timestamp thực tế (ms). Không suy đoán từ log.
// Trả 'active' (vẫn hoạt động) | 'level1' (quá hạn lần 1) | 'level2' (quá hạn nghiêm trọng) | 'none' (không có guard).
// lastHeartbeat: ms cuối Cline ghi nhận hoạt động; armedAt: ms lúc arm guard; now: ms hiện tại (inject).
// level1Ms / level2Ms: ngưỡng (level2 > level1).
export function silenceTimeoutLevels({ armedAt, lastHeartbeat, now, level1Ms, level2Ms }) {
  if (!armedAt) return 'none';
  const base = lastHeartbeat || armedAt;
  const elapsed = Math.max(0, now - base);
  if (level2Ms && elapsed >= level2Ms) return 'level2';
  if (elapsed >= level1Ms) return 'level1';
  return 'active';
}

// Có nên gửi cảnh báo lần này không (tránh lặp cùng cấp độ): mới qua level1 hoặc level2 so với cấp đã gửi.
// prev: 'active'|'level1'|'level2'|null. Trả { level, shouldSend, eventType }.
export function nextSilenceState(prev, level) {
  const shouldSend = level !== 'active' && prev !== level;
  const eventType = level === 'level2' ? 'timeout-level2' : level === 'level1' ? 'timeout-level1' : null;
  return { level, shouldSend, eventType };
}

// Reset trạng thái im lặng khi Cline hoạt động trở lại: trả guard với lastHeartbeat=now, silenceWarnLevel='active'.
export function resetOnActivity(guard, now) {
  return { ...guard, lastHeartbeat: now, silenceWarnLevel: 'active' };
}

// Ngưỡng im lặng watchdog mặc định (dùng chung daemon, --status và test).
export const SILENCE_DEFAULTS = { level1Ms: 30 * 60_000, level2Ms: 60 * 60_000 };

// Tick chu kỳ daemon (REV-020): tính cấp im lặng theo `now`, quyết định có gửi cảnh báo mới không.
// Chống gửi lặp cùng cấp qua guard.silenceWarnLevel (lưu cấp đã gửi). KHÔNG tự đổi GitHub state,
// KHÔNG kết luận trạng thái task. Heartbeat mới (lastHeartbeat cập nhật) → tính lại từ 'active'.
// CHỈ trả event khi st.shouldSend === true (cấp mới chưa gửi) — cấp trùng prev KHÔNG phát lại.
// Trả { guard, events }: guard = guard mới khi cần ghi cấp đã gửi (giữ nguyên nếu không gửi);
// events = ['timeout-level1' | 'timeout-level2'] tối đa 1 phần tử.
export function watchdogSilenceTick(guard, now, { level1Ms, level2Ms } = {}) {
  if (!guard) return { guard: null, events: [] };
  const l1 = level1Ms ?? SILENCE_DEFAULTS.level1Ms;
  const l2 = level2Ms ?? SILENCE_DEFAULTS.level2Ms;
  const level = silenceTimeoutLevels({ armedAt: guard.armedAt, lastHeartbeat: guard.lastHeartbeat, now, level1Ms: l1, level2Ms: l2 });
  const st = nextSilenceState(guard.silenceWarnLevel || 'active', level);
  if (!st.eventType || !st.shouldSend) return { guard, events: [] };
  return { guard: { ...guard, silenceWarnLevel: level }, events: [st.eventType] };
}

// REV-023+025: commit cấp im lặng đã gửi vào guard TRÊN ĐĨA sau khi TRANSPORT gửi xong.
// Race guard: trong lúc await sendTelegram, tiến trình khác (--heartbeat/--cancel/--arm) có thể
// đã ghi guard mới. Hàm này chỉ ghi nếu guard hiện tại VẪN CÙNG observation (armedAt + lastHeartbeat
// + pid + cancel khớp với guard đã dùng để tạo tick); ngược lại giữ nguyên trạng thái mới — KHÔNG
// ghi snapshot cũ đè lên heartbeat/cancel/arm mới (REV-025). Ha: current guard bị xóa (null) -> null.
// Khi hợp lệ -> MERGE duy nhất silenceWarnLevel, không thay toàn bộ object.
export function commitSilenceLevel(guard, tick, currentGuard) {
  if (!tick || tick.events.length === 0) return guard;
  if (!currentGuard) return currentGuard; // guard bị xóa trong lúc send -> không ghi lại
  const sameObservation =
    guard != null &&
    currentGuard.armedAt === guard.armedAt &&
    currentGuard.lastHeartbeat === guard.lastHeartbeat &&
    currentGuard.pid === guard.pid &&
    currentGuard.cancel === guard.cancel;
  if (!sameObservation) return currentGuard; // heartbeat/cancel/arm mới giữa lúc send -> giữ nguyên
  return { ...currentGuard, silenceWarnLevel: tick.guard.silenceWarnLevel };
}

// PID còn sống? process.kill(pid, 0) không throw = sống (edge hiếm: pid bị tái sử dụng).
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

// Guard có daemon hợp lệ đang chạy không — phân biệt guard sống vs guard mồ côi (REV-021).
export function isGuardAlive(guard) {
  return Boolean(guard && !guard.cancel && isPidAlive(guard.pid));
}

// Notifier có nên arm watchdog không: chỉ arm khi chưa có daemon hợp lệ (guard null hoặc mồ côi).
export function shouldArm(guard) {
  return !isGuardAlive(guard);
}
