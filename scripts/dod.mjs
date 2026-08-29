// dod.mjs — Deterministic Definition of Done state machine (Issue #25 / Phase 4A).
// Pure logic, ZERO IO. Mọi hàm chỉ nhận input + trả output, test được deterministic.
//
// State graph (theo Issue #25 body):
//   WORK_IN_PROGRESS -> IMPLEMENTED_NOT_VERIFIED -> VERIFIED_NOT_PUSHED
//   -> PUSHED_NOT_HANDED_OFF -> HANDOFF_READY -> TASK_COMPLETE
//   HANDOFF_READY -> VERIFIED_WITH_WARNINGS (warning) or TASK_COMPLETE
//   {any non-terminal} -> NEEDS_INPUT | BLOCKED
// Terminal: TASK_COMPLETE, BLOCKED. Resume: NEEDS_INPUT, VERIFIED_WITH_WARNINGS (RESET -> WIP).
// Fail-closed: event không hợp lệ trên state hiện tại -> {ok:false, reason:INVALID_TRANSITION}.

export const DOD_STATES = Object.freeze({
  WORK_IN_PROGRESS: 'WORK_IN_PROGRESS',
  IMPLEMENTED_NOT_VERIFIED: 'IMPLEMENTED_NOT_VERIFIED',
  VERIFIED_NOT_PUSHED: 'VERIFIED_NOT_PUSHED',
  PUSHED_NOT_HANDED_OFF: 'PUSHED_NOT_HANDED_OFF',
  HANDOFF_READY: 'HANDOFF_READY',
  TASK_COMPLETE: 'TASK_COMPLETE',
  VERIFIED_WITH_WARNINGS: 'VERIFIED_WITH_WARNINGS',
  NEEDS_INPUT: 'NEEDS_INPUT',
  BLOCKED: 'BLOCKED',
});

export const DOD_EVENTS = Object.freeze({
  EVIDENCE_IMPLEMENTATION: 'evidence.implementation',
  EVIDENCE_VERIFICATION: 'evidence.verification',
  GIT_PUSH: 'git.push',
  HANDOFF_MARKER: 'handoff.marker',
  TERMINAL_COMPLETE: 'terminal.complete',
  EVIDENCE_WARNING: 'evidence.warning',
  TERMINAL_INPUT_REQUIRED: 'terminal.input_required',
  TERMINAL_BLOCKED: 'terminal.blocked',
  RESET: 'reset',
});

const TRANSITIONS = Object.freeze({
  [DOD_STATES.WORK_IN_PROGRESS]: Object.freeze({
    [DOD_EVENTS.EVIDENCE_IMPLEMENTATION]: DOD_STATES.IMPLEMENTED_NOT_VERIFIED,
    [DOD_EVENTS.TERMINAL_INPUT_REQUIRED]: DOD_STATES.NEEDS_INPUT,
    [DOD_EVENTS.TERMINAL_BLOCKED]: DOD_STATES.BLOCKED,
  }),
  [DOD_STATES.IMPLEMENTED_NOT_VERIFIED]: Object.freeze({
    [DOD_EVENTS.EVIDENCE_VERIFICATION]: DOD_STATES.VERIFIED_NOT_PUSHED,
    [DOD_EVENTS.TERMINAL_INPUT_REQUIRED]: DOD_STATES.NEEDS_INPUT,
    [DOD_EVENTS.TERMINAL_BLOCKED]: DOD_STATES.BLOCKED,
  }),
  [DOD_STATES.VERIFIED_NOT_PUSHED]: Object.freeze({
    [DOD_EVENTS.GIT_PUSH]: DOD_STATES.PUSHED_NOT_HANDED_OFF,
    [DOD_EVENTS.TERMINAL_INPUT_REQUIRED]: DOD_STATES.NEEDS_INPUT,
    [DOD_EVENTS.TERMINAL_BLOCKED]: DOD_STATES.BLOCKED,
  }),
  [DOD_STATES.PUSHED_NOT_HANDED_OFF]: Object.freeze({
    [DOD_EVENTS.HANDOFF_MARKER]: DOD_STATES.HANDOFF_READY,
    [DOD_EVENTS.TERMINAL_INPUT_REQUIRED]: DOD_STATES.NEEDS_INPUT,
    [DOD_EVENTS.TERMINAL_BLOCKED]: DOD_STATES.BLOCKED,
  }),
  [DOD_STATES.HANDOFF_READY]: Object.freeze({
    [DOD_EVENTS.TERMINAL_COMPLETE]: DOD_STATES.TASK_COMPLETE,
    [DOD_EVENTS.EVIDENCE_WARNING]: DOD_STATES.VERIFIED_WITH_WARNINGS,
    [DOD_EVENTS.TERMINAL_INPUT_REQUIRED]: DOD_STATES.NEEDS_INPUT,
    [DOD_EVENTS.TERMINAL_BLOCKED]: DOD_STATES.BLOCKED,
  }),
  [DOD_STATES.TASK_COMPLETE]: Object.freeze({}),
  [DOD_STATES.VERIFIED_WITH_WARNINGS]: Object.freeze({
    [DOD_EVENTS.RESET]: DOD_STATES.WORK_IN_PROGRESS,
  }),
  [DOD_STATES.NEEDS_INPUT]: Object.freeze({
    [DOD_EVENTS.RESET]: DOD_STATES.WORK_IN_PROGRESS,
    [DOD_EVENTS.TERMINAL_BLOCKED]: DOD_STATES.BLOCKED,
  }),
  [DOD_STATES.BLOCKED]: Object.freeze({}),
});

const TERMINAL_STATES = new Set([DOD_STATES.TASK_COMPLETE, DOD_STATES.BLOCKED]);

export const DOD_REASONS = Object.freeze({
  INVALID_STATE: 'DOD_INVALID_STATE',
  INVALID_EVENT: 'DOD_INVALID_EVENT',
  INVALID_TRANSITION: 'DOD_INVALID_TRANSITION',
  TERMINAL_STATE: 'DOD_TERMINAL_STATE',
});

// Kiểm tra state có hợp lệ không (string nằm trong DOD_STATES).
export function isValidState(state) {
  return Object.prototype.hasOwnProperty.call(DOD_STATES, state);
}

// Kiểm tra event có hợp lệ không (so khớp value dotted-string, vì transition table key theo value).
export function isValidEvent(event) {
  return Object.values(DOD_EVENTS).includes(event);
}

// State có terminal không (TASK_COMPLETE / BLOCKED) — không thể chuyển tiếp tự động.
export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

// Pure: transition(state, event) -> {ok, state, reason?}
// Fail-closed: input sai / state sai / event sai / không có cạnh -> trả ok:false, KHONG tu y doi.
export function transition(state, event) {
  if (!isValidState(state)) {
    return { ok: false, state, reason: DOD_REASONS.INVALID_STATE };
  }
  if (!isValidEvent(event)) {
    return { ok: false, state, reason: DOD_REASONS.INVALID_EVENT };
  }
  if (isTerminalState(state)) {
    return { ok: false, state, reason: DOD_REASONS.TERMINAL_STATE };
  }
  const edges = TRANSITIONS[state];
  const next = edges[event];
  if (!next) {
    return { ok: false, state, reason: DOD_REASONS.INVALID_TRANSITION };
  }
  return { ok: true, state: next };
}

// Tạo session DoD mới cho 1 task/issue.
export function createDod({ initial = DOD_STATES.WORK_IN_PROGRESS, history = [] } = {}) {
  if (!isValidState(initial)) {
    return { ok: false, state: null, reason: DOD_REASONS.INVALID_STATE, history: [] };
  }
  return {
    ok: true,
    state: initial,
    history: [...history, { state: initial, event: null, at: 0 }],
  };
}

// apply: tạo session mới (immutable) từ state hiện tại + event, ghi history.
// session = {ok, state, history}. Tra session moi (KHONG mutate input).
export function apply(session, event, now = Date.now()) {
  if (!session || !session.ok) {
    return { ok: false, state: null, reason: DOD_REASONS.INVALID_STATE, history: [] };
  }
  const result = transition(session.state, event);
  if (!result.ok) {
    return { ok: false, state: session.state, reason: result.reason, history: session.history };
  }
  return {
    ok: true,
    state: result.state,
    history: [...session.history, { state: result.state, event, at: now }],
  };
}

// progress_pct: 0/25/50/75/100 theo tuyến chính; off-track = -1.
const PROGRESS = Object.freeze({
  [DOD_STATES.WORK_IN_PROGRESS]: 0,
  [DOD_STATES.IMPLEMENTED_NOT_VERIFIED]: 25,
  [DOD_STATES.VERIFIED_NOT_PUSHED]: 50,
  [DOD_STATES.PUSHED_NOT_HANDED_OFF]: 75,
  [DOD_STATES.HANDOFF_READY]: 100,
  [DOD_STATES.TASK_COMPLETE]: 100,
  [DOD_STATES.VERIFIED_WITH_WARNINGS]: -1,
  [DOD_STATES.NEEDS_INPUT]: -1,
  [DOD_STATES.BLOCKED]: -1,
});

// Machine-readable summary (Issue #25 AC: "Một tool trả trạng thái DoD machine-readable").
export function summarize(session) {
  if (!session || !session.ok) {
    return { ok: false, state: null, terminal: false, progress_pct: 0, last_event: null, history_len: 0 };
  }
  const last = session.history[session.history.length - 1] || { state: session.state, event: null };
  return {
    ok: true,
    state: session.state,
    terminal: isTerminalState(session.state),
    progress_pct: PROGRESS[session.state],
    last_event: last.event,
    history_len: session.history.length,
  };
}

// Short one-line summary (Issue #25 AC: "dòng tóm tắt ngắn").
export function oneLine(session) {
  const s = summarize(session);
  if (!s.ok) return `[DoD] INVALID: ${s.state || 'null'}`;
  const pct = s.progress_pct >= 0 ? `${s.progress_pct}%` : 'off-track';
  return `[DoD] ${s.state} (${pct})`;
}


