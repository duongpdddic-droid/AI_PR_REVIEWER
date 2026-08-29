#!/usr/bin/env node
// test-dod.mjs — pure-logic test cho DoD state machine (Issue #25 Phase 4A).
// KHONG framework. Exit 0 = ALL PASS, 1 = co FAIL.
import assert from 'node:assert/strict';
import {
  DOD_STATES, DOD_EVENTS, DOD_REASONS,
  isValidState, isValidEvent, isTerminalState,
  transition, createDod, apply, summarize, oneLine,
} from './dod.mjs';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// 1. State / event constant surface
test('DOD_STATES co du 9 state theo Issue #25 body', () => {
  const expected = ['WORK_IN_PROGRESS','IMPLEMENTED_NOT_VERIFIED','VERIFIED_NOT_PUSHED',
    'PUSHED_NOT_HANDED_OFF','HANDOFF_READY','TASK_COMPLETE','VERIFIED_WITH_WARNINGS',
    'NEEDS_INPUT','BLOCKED'];
  for (const s of expected) {
    assert.ok(Object.prototype.hasOwnProperty.call(DOD_STATES, s), `thieu state ${s}`);
  }
  assert.equal(Object.keys(DOD_STATES).length, 9);
});

test('DOD_STATES la Object.freeze — khong mutate duoc', () => {
  assert.throws(() => { DOD_STATES.WORK_IN_PROGRESS = 'OTHER'; }, TypeError);
});

test('DOD_EVENTS co du 9 event cot loi', () => {
  const expected = ['EVIDENCE_IMPLEMENTATION','EVIDENCE_VERIFICATION','GIT_PUSH',
    'HANDOFF_MARKER','TERMINAL_COMPLETE','EVIDENCE_WARNING',
    'TERMINAL_INPUT_REQUIRED','TERMINAL_BLOCKED','RESET'];
  for (const e of expected) {
    assert.ok(Object.prototype.hasOwnProperty.call(DOD_EVENTS, e), `thieu event ${e}`);
  }
});

// 2. isValidState / isValidEvent
test('isValidState / isValidEvent — hop le vs khong hop le', () => {
  assert.equal(isValidState('WORK_IN_PROGRESS'), true);
  assert.equal(isValidState('NOT_A_STATE'), false);
  assert.equal(isValidState(''), false);
  assert.equal(isValidState(null), false);
  assert.equal(isValidEvent('evidence.implementation'), true);
  assert.equal(isValidEvent('random.event'), false);
});

// 3. Happy path
test('Happy path: WIP -> IMPL -> VERIFIED -> PUSHED -> READY -> COMPLETE', () => {
  let s = createDod();
  assert.equal(s.ok, true);
  assert.equal(s.state, DOD_STATES.WORK_IN_PROGRESS);
  s = apply(s, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  assert.equal(s.state, DOD_STATES.IMPLEMENTED_NOT_VERIFIED);
  s = apply(s, DOD_EVENTS.EVIDENCE_VERIFICATION);
  assert.equal(s.state, DOD_STATES.VERIFIED_NOT_PUSHED);
  s = apply(s, DOD_EVENTS.GIT_PUSH);
  assert.equal(s.state, DOD_STATES.PUSHED_NOT_HANDED_OFF);
  s = apply(s, DOD_EVENTS.HANDOFF_MARKER);
  assert.equal(s.state, DOD_STATES.HANDOFF_READY);
  s = apply(s, DOD_EVENTS.TERMINAL_COMPLETE);
  assert.equal(s.state, DOD_STATES.TASK_COMPLETE);
  assert.equal(s.history.length, 6); // initial + 5 events
});

// 4. HANDOFF_READY -> VERIFIED_WITH_WARNINGS branch
test('HANDOFF_READY -> VERIFIED_WITH_WARNINGS khi co warning, reset ve WIP', () => {
  let s = createDod();
  s = apply(s, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  s = apply(s, DOD_EVENTS.EVIDENCE_VERIFICATION);
  s = apply(s, DOD_EVENTS.GIT_PUSH);
  s = apply(s, DOD_EVENTS.HANDOFF_MARKER);
  s = apply(s, DOD_EVENTS.EVIDENCE_WARNING);
  assert.equal(s.state, DOD_STATES.VERIFIED_WITH_WARNINGS);
  assert.equal(isTerminalState(s.state), false);
  s = apply(s, DOD_EVENTS.RESET);
  assert.equal(s.state, DOD_STATES.WORK_IN_PROGRESS);
});

// 5. NEEDS_INPUT tu moi non-terminal + reset
test('NEEDS_INPUT reachable tu moi non-terminal, reset ve WIP', () => {
  const startStates = [DOD_STATES.WORK_IN_PROGRESS, DOD_STATES.IMPLEMENTED_NOT_VERIFIED,
    DOD_STATES.VERIFIED_NOT_PUSHED, DOD_STATES.PUSHED_NOT_HANDED_OFF, DOD_STATES.HANDOFF_READY];
  for (const start of startStates) {
    let s = { ok: true, state: start, history: [{ state: start, event: null, at: 0 }] };
    s = apply(s, DOD_EVENTS.TERMINAL_INPUT_REQUIRED);
    assert.equal(s.state, DOD_STATES.NEEDS_INPUT, `tu ${start} khong vao NEEDS_INPUT`);
    s = apply(s, DOD_EVENTS.RESET);
    assert.equal(s.state, DOD_STATES.WORK_IN_PROGRESS);
  }
});

// 6. BLOCKED reachable tu moi non-terminal, terminal
test('BLOCKED reachable tu moi non-terminal; la terminal state', () => {
  const startStates = [DOD_STATES.WORK_IN_PROGRESS, DOD_STATES.IMPLEMENTED_NOT_VERIFIED,
    DOD_STATES.VERIFIED_NOT_PUSHED, DOD_STATES.PUSHED_NOT_HANDED_OFF, DOD_STATES.HANDOFF_READY,
    DOD_STATES.NEEDS_INPUT];
  for (const start of startStates) {
    let s = { ok: true, state: start, history: [{ state: start, event: null, at: 0 }] };
    s = apply(s, DOD_EVENTS.TERMINAL_BLOCKED);
    assert.equal(s.state, DOD_STATES.BLOCKED);
    assert.equal(isTerminalState(s.state), true);
  }
});

// 7. Fail-closed: INVALID_TRANSITION
test('Invalid transition tren canh khong ton tai -> fail-closed, KHONG mutate', () => {
  const s0 = { ok: true, state: DOD_STATES.WORK_IN_PROGRESS, history: [{ state: DOD_STATES.WORK_IN_PROGRESS, event: null, at: 0 }] };
  const s1 = apply(s0, DOD_EVENTS.GIT_PUSH);
  assert.equal(s1.ok, false);
  assert.equal(s1.state, DOD_STATES.WORK_IN_PROGRESS);
  assert.equal(s1.reason, DOD_REASONS.INVALID_TRANSITION);
  assert.equal(s1.history.length, 1);
});

// 8. Fail-closed: TERMINAL_STATE khong tu chuyen
test('TASK_COMPLETE va BLOCKED la terminal — su kien bat ky (tru RESET) -> TERMINAL_STATE', () => {
  const s0 = { ok: true, state: DOD_STATES.TASK_COMPLETE, history: [{ state: DOD_STATES.TASK_COMPLETE, event: null, at: 0 }] };
  const s1 = apply(s0, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  assert.equal(s1.ok, false);
  assert.equal(s1.reason, DOD_REASONS.TERMINAL_STATE);
  const s2 = { ok: true, state: DOD_STATES.BLOCKED, history: [{ state: DOD_STATES.BLOCKED, event: null, at: 0 }] };
  const s3 = apply(s2, DOD_EVENTS.RESET);
  assert.equal(s3.ok, false);
  assert.equal(s3.reason, DOD_REASONS.TERMINAL_STATE);
});

// 9. Fail-closed: state / event khong hop le
test('State khong hop le / event khong hop le -> reason INVALID_STATE/INVALID_EVENT', () => {
  const r1 = transition('FAKE_STATE', DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, DOD_REASONS.INVALID_STATE);
  const r2 = transition(DOD_STATES.WORK_IN_PROGRESS, 'fake.event');
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, DOD_REASONS.INVALID_EVENT);
  const r3 = transition(null, null);
  assert.equal(r3.ok, false);
});

// 10. summarize() — progress_pct
test('summarize tra progress_pct 0/25/50/75/100 theo happy path', () => {
  const path = [
    [DOD_EVENTS.EVIDENCE_IMPLEMENTATION, 25],
    [DOD_EVENTS.EVIDENCE_VERIFICATION, 50],
    [DOD_EVENTS.GIT_PUSH, 75],
    [DOD_EVENTS.HANDOFF_MARKER, 100],
    [DOD_EVENTS.TERMINAL_COMPLETE, 100],
  ];
  let s = createDod();
  assert.equal(summarize(s).progress_pct, 0);
  for (const [ev, pct] of path) {
    s = apply(s, ev);
    assert.equal(summarize(s).progress_pct, pct, `sau ${ev} phai ${pct}%`);
    assert.equal(summarize(s).terminal, ev === DOD_EVENTS.TERMINAL_COMPLETE);
  }
});

test('summarize WARN/INPUT/BLOCKED -> progress_pct = -1 (off-track)', () => {
  const off = [DOD_STATES.VERIFIED_WITH_WARNINGS, DOD_STATES.NEEDS_INPUT, DOD_STATES.BLOCKED];
  for (const st of off) {
    const s = { ok: true, state: st, history: [{ state: st, event: null, at: 0 }] };
    assert.equal(summarize(s).progress_pct, -1, `${st} phai off-track`);
  }
});

// 11. oneLine
test('oneLine tra dung format "[DoD] STATE (X%)"', () => {
  let s = createDod();
  assert.match(oneLine(s), /^\[DoD\] WORK_IN_PROGRESS \(0%\)$/);
  s = createDod();
  s = apply(s, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  s = apply(s, DOD_EVENTS.EVIDENCE_VERIFICATION);
  assert.match(oneLine(s), /^\[DoD\] VERIFIED_NOT_PUSHED \(50%\)$/);
  s = apply(s, DOD_EVENTS.TERMINAL_BLOCKED);
  assert.match(oneLine(s), /^\[DoD\] BLOCKED \(off-track\)$/);
});

// 12. AC "Khong the TASK_COMPLETE khi thieu evidence/stale HEAD"
test('Tu WIP nhay thang sang TASK_COMPLETE bang EVIDENCE_IMPLEMENTATION lien tuc -> FAIL', () => {
  let s = createDod();
  s = apply(s, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  s = apply(s, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  assert.equal(s.ok, false);
  assert.equal(s.state, DOD_STATES.IMPLEMENTED_NOT_VERIFIED);
  s = apply(s, DOD_EVENTS.TERMINAL_COMPLETE);
  assert.equal(s.ok, false);
});

// 13. createDod voi initial khong hop le
test('createDod({initial: "FAKE"}) -> ok:false', () => {
  const s = createDod({ initial: 'FAKE_STATE' });
  assert.equal(s.ok, false);
  assert.equal(s.reason, DOD_REASONS.INVALID_STATE);
});

// 14. apply tren session invalid
test('apply tren session khong hop le -> ok:false, khong crash', () => {
  const s = apply(null, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  assert.equal(s.ok, false);
  const s2 = apply({ ok: false, state: null, history: [] }, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  assert.equal(s2.ok, false);
});

// 15. Immutability
test('apply KHONG mutate input session (history push sang array moi)', () => {
  const s0 = createDod();
  const hist0Len = s0.history.length;
  const hist0Ref = s0.history;
  apply(s0, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  assert.equal(s0.history.length, hist0Len);
  assert.equal(s0.history, hist0Ref);
});

// Chay
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.fn(); console.log(`PASS  ${c.name}`); pass++; }
  catch (e) { console.log(`FAIL  ${c.name}\n  ${e.message}`); fail++; }
}
console.log(`\nTotal: ${pass}/${pass+fail} PASS`);
if (fail > 0) { process.exit(1); }
else { process.exit(0); }


