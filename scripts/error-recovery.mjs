#!/usr/bin/env node
// error-recovery.mjs — Error taxonomy + bounded recovery + structured telemetry (Issue #9 D/G).
// Pure core, không IO. Không dependency ngoài.
//
// Taxonomy canonical: RATE_LIMIT | TIMEOUT | PROVIDER_ERROR | EMPTY_RESPONSE |
//   INVALID_TOOL_CALL | CONTEXT_OVERFLOW | REPEATED_REASONING | AUTH_OR_CONFIG_ERROR | UNKNOWN
//
// Recovery policy (planRecovery): retry-same / retry-backoff / compact-then-retry /
//   fallback-model / escalate-blocked. Bounded (attempt <= maxAttempts); hết → escalate.
//   KHÔNG round-robin mù: fallback chỉ khi fallbackChain khai báo + candidate chưa thử +
//   policyGate.passing === true (không bypass policy). identity truyền thẳng nguyên vẹn.
// Telemetry (G): recordExecutionEvent redact secret; summarizeByProvider thống kê theo model.

export const ERROR_CLASSES = [
  'RATE_LIMIT', 'TIMEOUT', 'PROVIDER_ERROR', 'EMPTY_RESPONSE', 'INVALID_TOOL_CALL',
  'CONTEXT_OVERFLOW', 'REPEATED_REASONING', 'AUTH_OR_CONFIG_ERROR', 'UNKNOWN',
];

const CLASSIFIERS = [
  ['RATE_LIMIT', /\b429\b|rate.?limit|too many requests|quota exceeded/i],
  ['TIMEOUT', /etimedout|timeout|timed out|deadline exceeded|esockettimedout/i],
  ['EMPTY_RESPONSE', /^\s*$|^null$|^undefined$/],
  ['INVALID_TOOL_CALL', /unknown tool|invalid tool|no such tool|tool_call.*(invalid|unknown)|malformed tool/i],
  ['CONTEXT_OVERFLOW', /context length|context overflow|max.{0,12}tokens|token limit|too large for model/i],
  ['REPEATED_REASONING', /repeated reasoning|no progress|loop detected|same response/i],
  ['AUTH_OR_CONFIG_ERROR', /\b401\b|\b403\b|unauthorized|forbidden|bad credentials|invalid api key|authentication|missing config|enoent.*\.env/i],
  ['PROVIDER_ERROR', /\b(500|502|503|504)\b|internal server error|bad gateway|service unavailable|provider error|overloaded|econnrefused|econnreset|enotfound|fetch failed|network/i],
];

/** Phân loại lỗi/runtime-output thô về ERROR_CLASSES. */
export function classifyError(raw) {
  const s = String(raw == null ? '' : raw && raw.message ? raw.message : raw).trim();
  if (!s) return 'EMPTY_RESPONSE';
  for (const [cls, re] of CLASSIFIERS) {
    if (re.test(s)) return cls;
  }
  return 'UNKNOWN';
}

const TRANSIENT_RETRY = new Set(['RATE_LIMIT', 'TIMEOUT', 'PROVIDER_ERROR']);

/**
 * Lập kế hoạch recovery cho 1 lần fail (pure).
 * attempts = số attempt ĐÃ chạy (kể cả lần vừa fail); identity được echo nguyên vẹn.
 */
export function planRecovery(input) {
  const {
    errorClass, attempts, maxAttempts = 3,
    fallbackChain = [], triedFallbackKeys = [], policyGate = null, identity = {},
  } = input || {};
  const echo = () => identity;
  if (!ERROR_CLASSES.includes(errorClass)) {
    return { action: 'escalate-blocked', delayMs: 0, nextTarget: null, reason: `errorClass "${errorClass}" ngoài taxonomy → không suy đoán`, identity: echo() };
  }
  if (errorClass === 'AUTH_OR_CONFIG_ERROR') {
    return { action: 'escalate-blocked', delayMs: 0, nextTarget: null, reason: 'AUTH_OR_CONFIG_ERROR: cần sửa config/quyền — retry/fallback không hợp lệ, không bypass auth bằng model khác', identity: echo() };
  }
  if (errorClass === 'CONTEXT_OVERFLOW') {
    if (attempts < maxAttempts) return { action: 'compact-then-retry', delayMs: 0, nextTarget: null, reason: 'compact context (B1) rồi retry cùng model', identity: echo() };
    return { action: 'escalate-blocked', delayMs: 0, nextTarget: null, reason: 'CONTEXT_OVERFLOW lặp sau compact — hết biện pháp trong budget', identity: echo() };
  }
  if (errorClass === 'REPEATED_REASONING') {
    if (attempts < maxAttempts) return { action: 'compact-then-retry', delayMs: 0, nextTarget: null, reason: 'no-progress: compact + đổi góc tiếp cận trước escalate', identity: echo() };
    return { action: 'escalate-blocked', delayMs: 0, nextTarget: null, reason: 'REPEATED_REASONING kéo dài — escalate BLOCKED tránh đốt quota', identity: echo() };
  }
  if (TRANSIENT_RETRY.has(errorClass) && attempts < maxAttempts) {
    const isRateLimit = errorClass === 'RATE_LIMIT';
    return {
      action: isRateLimit ? 'retry-backoff' : 'retry-same',
      delayMs: isRateLimit ? Math.min(60000, 1000 * 2 ** attempts) : 0,
      nextTarget: null,
      reason: `${errorClass} transient: attempts ${attempts}/${maxAttempts}`,
      identity: echo(),
    };
  }
  if (!TRANSIENT_RETRY.has(errorClass) && attempts < maxAttempts) {
    // INVALID_TOOL_CALL / EMPTY_RESPONSE / UNKNOWN: retry đơn để loại nhiễu tạm thời.
    return { action: 'retry-same', delayMs: 0, nextTarget: null, reason: `${errorClass}: retry đơn để loại nhiễu tạm thời`, identity: echo() };
  }

  // Hết budget retry → cân nhắc fallback TƯỜNG MINH (không round-robin mù).
  for (const cand of fallbackChain) {
    const key = `${cand.provider || '*'}/${cand.model || '*'}`;
    if (triedFallbackKeys.includes(key)) continue;
    if (!policyGate || policyGate.passing !== true) {
      return { action: 'escalate-blocked', delayMs: 0, nextTarget: null, reason: 'fallback bị chặn: policy gate không PASS — fallback không được bypass policy', identity: echo() };
    }
    return { action: 'fallback-model', delayMs: 0, nextTarget: cand, reason: `hết retry (${attempts}/${maxAttempts}) — fallback tường minh tới ${key}, giữ identity`, identity: echo() };
  }
  return { action: 'escalate-blocked', delayMs: 0, nextTarget: null, reason: `hết ${attempts}/${maxAttempts} attempt${fallbackChain.length ? ', fallback chain đã cạn' : ' và không khai báo fallbackChain (mặc định không round-robin)'}`, identity: echo() };
}

// ---------------------------------------------------------------- Telemetry (G)

const SECRET_RES = [
  /(gh[pousr]_)[A-Za-z0-9]{16,}/g, // GitHub tokens
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI-style keys
  /((?:authorization|auth)"?\s*[:=]\s*"?bearer\s+)[A-Za-z0-9._~+/=-]+/gi, // Authorization: Bearer <token>
  /\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi, // "Bearer <token>" trần (stderr/log thô)
  /((?:api[_-]?key|apikey|token|secret|password)"?\s*[:=]\s*)["']?[^"'\s,};]+/gi, // key=value shapes
];

/** Redact secret khỏi chuỗi log/telemetry (AC: không log secrets). */
export function redactSecrets(text) {
  let s = String(text == null ? '' : text);
  for (const re of SECRET_RES) s = s.replace(re, '$1[REDACTED]');
  return s;
}

// Guards redact đệ quy (GPT-REV-061): không treo vì cycle, không phình log vì quá sâu/quá lớn.
const MAX_REDACT_DEPTH = 6;
const MAX_REDACT_NODES = 500;
const REDACT_TRUNCATED = '[TRUNCATED]';

/**
 * Redact secret ĐỆ QUY trên mọi string trong object/array lồng nhau.
 * Guard: depth ≤ MAX_REDACT_DEPTH, tổng node ≤ MAX_REDACT_NODES, circular ref → '[Circular]'.
 * Không ném với input bất kỳ (null/primitive trả nguyên/redact chuỗi).
 */
export function redactDeep(value, depth = 0, seen = null, counter = { nodes: 0 }) {
  try {
    if (typeof value === 'string') return redactSecrets(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_REDACT_DEPTH) return REDACT_TRUNCATED;
    if (seen && seen.has(value)) return '[Circular]';
    if (counter.nodes > MAX_REDACT_NODES) return REDACT_TRUNCATED;
    const nextSeen = new Set(seen || []);
    nextSeen.add(value);
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        counter.nodes += 1;
        if (counter.nodes > MAX_REDACT_NODES) { out.push(REDACT_TRUNCATED); break; }
        out.push(redactDeep(item, depth + 1, nextSeen, counter));
      }
      return out;
    }
    const out = {};
    for (const k of Object.keys(value)) {
      counter.nodes += 1;
      if (counter.nodes > MAX_REDACT_NODES) { out[k] = REDACT_TRUNCATED; continue; }
      out[k] = redactDeep(value[k], depth + 1, nextSeen, counter);
    }
    return out;
  } catch {
    return REDACT_TRUNCATED; // fail-safe: telemetry không bao giờ làm hỏng caller
  }
}

/**
 * Ghi 1 execution/recovery event đã redact (pure — caller tự lưu vào store).
 * Trường: taskId/issue/pr/ref, provider/model (nếu runtime cung cấp), attempt, errorClass,
 * toolFailure, compactionEvent, fallbackEvent, manualIntervention, outcome, durationMs, ts.
 */
export function recordExecutionEvent(prevEvents, evt) {
  // GPT-REV-061: redact ĐỆ QUY mọi giá trị (kể cả object/array lồng như toolFailure.stderr),
  // không chỉ string top-level — secret trong cấu trúc lồng nhau không được ghi ra log.
  const clean = redactDeep(evt || {});
  const record = {
    taskId: clean.taskId ?? null,
    issue: clean.issue ?? null,
    pr: clean.pr ?? null,
    ref: clean.ref ?? null,
    provider: clean.provider ?? null,
    model: clean.model ?? null,
    attempt: Number(clean.attempt) || 0,
    errorClass: clean.errorClass ?? null,
    toolFailure: clean.toolFailure ?? null,
    compactionEvent: clean.compactionEvent ?? null,
    fallbackEvent: clean.fallbackEvent ?? null,
    manualIntervention: clean.manualIntervention ?? false,
    outcome: clean.outcome ?? null,
    durationMs: clean.durationMs ?? null,
    ts: clean.ts || new Date().toISOString(),
  };
  // Trường lạ (note/msg/stderr…) vẫn giữ SAU KHI redact — evidence hữu ích, secret không lộ.
  for (const k of Object.keys(clean)) {
    if (!(k in record)) record[k] = clean[k];
  }
  return [...(Array.isArray(prevEvents) ? prevEvents : []), record];
}

/** Thống kê theo provider/model: counts[provider][model] = {total, byErrorClass, outcomes}. */
export function summarizeByProvider(events) {
  const out = {};
  for (const e of Array.isArray(events) ? events : []) {
    const p = e.provider || 'unknown';
    const m = e.model || 'unknown';
    out[p] = out[p] || {};
    out[p][m] = out[p][m] || { total: 0, byErrorClass: {}, outcomes: {} };
    const slot = out[p][m];
    slot.total += 1;
    if (e.errorClass) slot.byErrorClass[e.errorClass] = (slot.byErrorClass[e.errorClass] || 0) + 1;
    if (e.outcome) slot.outcomes[e.outcome] = (slot.outcomes[e.outcome] || 0) + 1;
  }
  return out;
}

