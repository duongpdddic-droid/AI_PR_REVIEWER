// circuit-breaker.mjs — per-tool circuit breaker (Issue #25 / Phase 4A "Model Circuit Breaker").
// Pure logic, ZERO IO. Pattern 3-state kinh điển:
//   CLOSED  -> tool chạy bình thường, đếm lỗi liên tiếp.
//   OPEN    -> tool bị tạm dừng, đợi cooldown xong -> HALF_OPEN eligible.
//   HALF_OPEN -> cho phép 1 lần probe; nếu success -> CLOSED, fail -> OPEN (reset cooldown).
//
// Mục tiêu (Issue #25 AC):
//   - "Không gọi model khi context > 80% budget" / "Khi 3 lỗi liên tiếp -> pause, hỏi human".
//   - Mỗi tool name có breaker riêng. Model check shouldPause(tool) trước khi exec.
//
// YAGNI:
//   - KHONG có timer thật (setTimeout); caller tự check elapsed.
//   - Mỗi recordFailure/recordSuccess trả registry MOI (immutable).

export const BREAKER_STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

export const BREAKER_REASONS = Object.freeze({
  INVALID_TOOL: 'BREAKER_INVALID_TOOL',
  INVALID_FAILURE_COUNT: 'BREAKER_INVALID_FAILURE_COUNT',
});

// Nguỡng mặc định: 3 lỗi liên tiếp. Cooldown 60s cho HALF_OPEN probe.
export const DEFAULT_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 60_000;

// Tạo registry breaker rỗng. Mỗi tool là 1 entry:
//   {state, failures, openedAt, lastReason}
export function createBreakerRegistry({
  threshold = DEFAULT_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    return { ok: false, registry: null, reason: BREAKER_REASONS.INVALID_FAILURE_COUNT };
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    return { ok: false, registry: null, reason: BREAKER_REASONS.INVALID_FAILURE_COUNT };
  }
  return {
    ok: true,
    threshold,
    cooldownMs,
    tools: Object.create(null),
  };
}

// Entry internal lazy.
function ensureEntry(reg, tool) {
  if (reg.tools[tool]) return reg.tools[tool];
  return { state: BREAKER_STATES.CLOSED, failures: 0, openedAt: 0, lastReason: null };
}

// recordFailure(reg, tool, reason, now=Date.now()) -> {ok, entry, opened, registry}
// Tăng failure; nếu >= threshold và đang CLOSED -> chuyển OPEN. Tra registry MOI (immutable).
export function recordFailure(reg, tool, reason = 'unspecified', now = Date.now()) {
  if (!reg || !reg.ok) {
    return { ok: false, entry: null, opened: false, reason: BREAKER_REASONS.INVALID_TOOL };
  }
  if (typeof tool !== 'string' || !tool) {
    return { ok: false, entry: null, opened: false, reason: BREAKER_REASONS.INVALID_TOOL };
  }
  const prev = ensureEntry(reg, tool);
  let next;
  let opened = false;
  if (prev.state === BREAKER_STATES.OPEN) {
    next = { ...prev, lastReason: reason };
  } else if (prev.state === BREAKER_STATES.HALF_OPEN) {
    next = { state: BREAKER_STATES.OPEN, failures: prev.failures + 1, openedAt: now, lastReason: reason };
    opened = true;
  } else {
    const failures = prev.failures + 1;
    if (failures >= reg.threshold) {
      next = { state: BREAKER_STATES.OPEN, failures, openedAt: now, lastReason: reason };
      opened = true;
    } else {
      next = { ...prev, failures, lastReason: reason };
    }
  }
  const newReg = { ...reg, tools: { ...reg.tools, [tool]: next } };
  return { ok: true, entry: next, opened, registry: newReg };
}

// recordSuccess(reg, tool) -> {ok, entry, recovered, registry}
// Reset về CLOSED (idempotent kể cả khi đang CLOSED).
export function recordSuccess(reg, tool) {
  if (!reg || !reg.ok || typeof tool !== 'string' || !tool) {
    return { ok: false, entry: null, recovered: false, reason: BREAKER_REASONS.INVALID_TOOL };
  }
  const prev = ensureEntry(reg, tool);
  const recovered = prev.state !== BREAKER_STATES.CLOSED;
  const next = { state: BREAKER_STATES.CLOSED, failures: 0, openedAt: 0, lastReason: null };
  const newReg = { ...reg, tools: { ...reg.tools, [tool]: next } };
  return { ok: true, entry: next, recovered, registry: newReg };
}

// shouldPause(reg, tool, now=Date.now()) -> {pause, state, reason}
// pause=true nếu KHONG được gọi tool lúc này.
//   - CLOSED -> pause:false
//   - OPEN và elapsed < cooldown -> pause:true (còn cooldown)
//   - OPEN và elapsed >= cooldown -> đề xuất chuyển HALF_OPEN, pause:false (cho 1 probe)
//   - HALF_OPEN -> pause:true (probe đang chạy)
// KHONG mutate registry.
export function shouldPause(reg, tool, now = Date.now()) {
  if (!reg || !reg.ok || typeof tool !== 'string' || !tool) {
    return { pause: true, state: null, reason: BREAKER_REASONS.INVALID_TOOL };
  }
  const entry = reg.tools[tool];
  if (!entry || entry.state === BREAKER_STATES.CLOSED) {
    return { pause: false, state: entry ? entry.state : BREAKER_STATES.CLOSED, reason: null };
  }
  if (entry.state === BREAKER_STATES.HALF_OPEN) {
    return { pause: true, state: BREAKER_STATES.HALF_OPEN, reason: 'probe in progress' };
  }
  const elapsed = now - (entry.openedAt || 0);
  if (elapsed < reg.cooldownMs) {
    return { pause: true, state: BREAKER_STATES.OPEN, reason: `cooldown ${Math.max(0, reg.cooldownMs - elapsed)}ms remaining` };
  }
  return { pause: false, state: BREAKER_STATES.OPEN, reason: 'cooldown elapsed — probe allowed' };
}

// peek(reg, tool) -> {ok, entry, state, failures} (read-only)
export function peek(reg, tool) {
  if (!reg || !reg.ok) return { ok: false, entry: null, state: null, failures: 0 };
  const entry = reg.tools[tool];
  if (!entry) return { ok: true, entry: null, state: BREAKER_STATES.CLOSED, failures: 0 };
  return { ok: true, entry, state: entry.state, failures: entry.failures };
}

// summarize(reg) -> {ok, openTools, halfOpenTools, closedTools, total}
export function summarize(reg) {
  if (!reg || !reg.ok) {
    return { ok: false, openTools: [], halfOpenTools: [], closedTools: [], total: 0 };
  }
  const open = [];
  const half = [];
  const closed = [];
  for (const [name, e] of Object.entries(reg.tools)) {
    if (e.state === BREAKER_STATES.OPEN) open.push(name);
    else if (e.state === BREAKER_STATES.HALF_OPEN) half.push(name);
    else closed.push(name);
  }
  return {
    ok: true,
    openTools: open,
    halfOpenTools: half,
    closedTools: closed,
    total: Object.keys(reg.tools).length,
  };
}


