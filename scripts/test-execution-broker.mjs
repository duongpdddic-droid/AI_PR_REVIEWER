#!/usr/bin/env node
// test-execution-broker.mjs — pure-logic test cho execution broker (Issue #25 Phase 4A).
// KHONG framework. Exit 0 = ALL PASS, 1 = co FAIL.
// YAGNI: chi test pure check + runTool integration. Tool wrapper that da smoke test bang CLI.

import assert from 'node:assert/strict';
import {
  TOOLS, AUTO_COMMIT_REQUIREMENTS,
  checkAutoCommitGate, runTool,
} from './execution-broker.mjs';
import { DOD_STATES, DOD_EVENTS, createDod, apply } from './dod.mjs';
import {
  createBreakerRegistry, recordFailure, shouldPause,
} from './circuit-breaker.mjs';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
let passed = 0, failed = 0;
const log = (ok, name, err) => {
  if (ok) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name, err && err.message ? err.message : err); }
};

// 1. TOOLS list
test('TOOLS gom 6 tool + auto_commit_gate (Issue #25 body)', () => {
  for (const t of ['repo_status','repo_diff','test_run','verify_status','pre_review_status','handoff_status','auto_commit_gate']) {
    assert.ok(TOOLS.includes(t), `thieu tool ${t}`);
  }
  assert.equal(TOOLS.length, 7);
});
test('TOOLS frozen', () => {
  assert.throws(() => { TOOLS.push('x'); }, TypeError);
});

// 2. AUTO_COMMIT_REQUIREMENTS day du 8 key
test('AUTO_COMMIT_REQUIREMENTS day du 8 key theo Issue #25', () => {
  const expected = ['branchTask','worktreeClean','testsPass','verifyPass','preReviewPass','dodHandoffReady','handoffMarker','ciRequiredChecksPass'];
  for (const k of expected) {
    assert.ok(Object.prototype.hasOwnProperty.call(AUTO_COMMIT_REQUIREMENTS, k), `thieu key ${k}`);
  }
  assert.equal(Object.keys(AUTO_COMMIT_REQUIREMENTS).length, 8);
});

// 3. checkAutoCommitGate
test('checkAutoCommitGate tat-ca true -> ok=true, missing=[]', () => {
  const r = checkAutoCommitGate({
    branch: 'feat/issue-25', worktreeClean: true, testsPass: true, verifyPass: true,
    preReviewPass: true, dodState: DOD_STATES.HANDOFF_READY, handoffMarker: true,
    ciRequiredChecksPass: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});
test('checkAutoCommitGate branch=main -> missing branchTask', () => {
  const r = checkAutoCommitGate({ branch: 'main' });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('branchTask'));
});
test('checkAutoCommitGate dodState=VERIFIED_WITH_WARNINGS -> van ok', () => {
  const r = checkAutoCommitGate({
    branch: 'feat/x', worktreeClean: true, testsPass: true, verifyPass: true,
    preReviewPass: true, dodState: DOD_STATES.VERIFIED_WITH_WARNINGS, handoffMarker: true,
    ciRequiredChecksPass: true,
  });
  assert.equal(r.ok, true);
});
test('checkAutoCommitGate dodState=VERIFIED_NOT_PUSHED -> missing dodHandoffReady', () => {
  const r = checkAutoCommitGate({
    branch: 'feat/x', worktreeClean: true, testsPass: true, verifyPass: true,
    preReviewPass: true, dodState: DOD_STATES.VERIFIED_NOT_PUSHED, handoffMarker: true,
    ciRequiredChecksPass: true,
  });
  assert.ok(r.missing.includes('dodHandoffReady'));
});
test('checkAutoCommitGate all-false -> 8 missing', () => {
  const r = checkAutoCommitGate({});
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 8);
});
test('checkAutoCommitGate default -> branchTask false vi branch=""', () => {
  const r = checkAutoCommitGate({});
  assert.ok(r.missing.includes('branchTask'));
});

// 4. runTool
test('runTool unknown tool -> ok=false, error message', () => {
  const r = runTool('not_a_real_tool', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown tool/);
});
test('runTool khi breaker pause -> ok=false, paused=true, DoD chuyen BLOCKED', () => {
  let reg = createBreakerRegistry();
  reg = recordFailure(reg, 'repo_status', 'e1').registry;
  reg = recordFailure(reg, 'repo_status', 'e2').registry;
  reg = recordFailure(reg, 'repo_status', 'e3').registry;
  const p = shouldPause(reg, 'repo_status');
  assert.equal(p.pause, true);
  const r = runTool('repo_status', {}, { registry: reg });
  assert.equal(r.ok, false);
  assert.equal(r.breaker.paused, true);
  assert.equal(r.dod.state, DOD_STATES.BLOCKED);
  assert.equal(r.dod_event, DOD_EVENTS.TERMINAL_BLOCKED);
});
test('runTool repo_status that khong emit dod_event (mapping null)', () => {
  const r = runTool('repo_status', {});
  assert.equal(r.dod_event, null);
});

// 5. DoD state machine integration (kiểm chứng emission path)
test('DoD session IMPLEMENTED + verification event -> VERIFIED_NOT_PUSHED', () => {
  let s = createDod({ initial: DOD_STATES.WORK_IN_PROGRESS });
  s = apply(s, DOD_EVENTS.EVIDENCE_IMPLEMENTATION);
  assert.equal(s.state, DOD_STATES.IMPLEMENTED_NOT_VERIFIED);
  s = apply(s, DOD_EVENTS.EVIDENCE_VERIFICATION);
  assert.equal(s.state, DOD_STATES.VERIFIED_NOT_PUSHED);
});

// Run
for (const c of cases) {
  try { c.fn(); log(true, c.name, null); }
  catch (e) { log(false, c.name, e); }
}
console.log(`\nTổng: ${passed}/${cases.length} PASS`);
process.exit(failed === 0 ? 0 : 1);

