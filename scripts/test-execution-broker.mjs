#!/usr/bin/env node
// test-execution-broker.mjs — pure-logic test cho execution broker (Issue #25 Phase 4A).
// KHONG framework. Exit 0 = ALL PASS, 1 = co FAIL.
// YAGNI: chi test pure check + runTool integration. Tool wrapper that da smoke test bang CLI.

import assert from 'node:assert/strict';
import {
  TOOLS, AUTO_COMMIT_REQUIREMENTS,
  checkAutoCommitGate, runTool, shouldEmitDodEvent,
  originToRepo, mutationKey, HANDOFF_ACTION, MANDATORY_TEST_SUITES,
  verifyRemotePrHead,
} from './execution-broker.mjs';
import { DOD_STATES, DOD_EVENTS, createDod, apply } from './dod.mjs';
import {
  createBreakerRegistry, recordFailure, shouldPause,
} from './circuit-breaker.mjs';
import { parseHandoffMarkers, findCanonicalHandoffMarker } from './review-contract.mjs';

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

// 6. shouldEmitDodEvent (Finding 3)
test('shouldEmitDodEvent repo_diff totalFiles=0 -> false', () => {
  assert.equal(shouldEmitDodEvent('repo_diff', { ok: true, data: { totalFiles: 0 } }), false);
});
// Finding 5: repo_diff KHONG bao gio emit implementation (chi xem file co, khong confirm implemented).
test('shouldEmitDodEvent repo_diff totalFiles=5 -> false (Finding 5)', () => {
  assert.equal(shouldEmitDodEvent('repo_diff', { ok: true, data: { totalFiles: 5 } }), false);
});
test('shouldEmitDodEvent repo_diff ok=false -> false', () => {
  assert.equal(shouldEmitDodEvent('repo_diff', { ok: false }), false);
});
test('shouldEmitDodEvent test_run allPass=true -> true', () => {
  assert.equal(shouldEmitDodEvent('test_run', { ok: true, data: { allPass: true } }), true);
});
test('shouldEmitDodEvent test_run allPass=false -> false', () => {
  assert.equal(shouldEmitDodEvent('test_run', { ok: true, data: { allPass: false } }), false);
});
// Finding 4+6: handoff_status emit chi khi marker canonical (provenance) + remotePrHeadMatch.
test('shouldEmitDodEvent handoff_status markerValid=true + remote match -> true', () => {
  assert.equal(shouldEmitDodEvent('handoff_status', { ok: true, data: { handoffMarkerValid: true, remotePrHeadMatch: true } }), true);
});
test('shouldEmitDodEvent handoff_status markerValid=true nhung remote LEch -> false (Finding 4)', () => {
  assert.equal(shouldEmitDodEvent('handoff_status', { ok: true, data: { handoffMarkerValid: true, remotePrHeadMatch: false } }), false);
});
test('shouldEmitDodEvent handoff_status markerValid=false -> false', () => {
  assert.equal(shouldEmitDodEvent('handoff_status', { ok: true, data: { handoffMarkerValid: false } }), false);
});
test('shouldEmitDodEvent verify_status allPass undefined -> false (fail-closed)', () => {
  assert.equal(shouldEmitDodEvent('verify_status', { ok: true, data: {} }), false);
});
test('shouldEmitDodEvent repo_status (không mapping) -> true', () => {
  assert.equal(shouldEmitDodEvent('repo_status', { ok: true, data: {} }), true);
});

// 7. originToRepo (Finding 4)
test('originToRepo https URL -> owner/repo', () => {
  assert.equal(originToRepo('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git'), 'duongpdddic-droid/AI_PR_REVIEWER');
});
test('originToRepo git@ssh URL -> owner/repo', () => {
  assert.equal(originToRepo('git@github.com:user/project.git'), 'user/project');
});
test('originToRepo invalid URL -> null', () => {
  assert.equal(originToRepo('https://other.com/repo.git'), null);
  assert.equal(originToRepo(''), null);
  assert.equal(originToRepo(null), null);
});

// 8. mutationKey
test('mutationKey format', () => {
  const k = mutationKey({ repository: 'o/r', prNumber: 7, headSha: 'a'.repeat(40), policyVersion: 'v1', action: 'handoff:ready' });
  assert.equal(k, 'o/r::7::aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa::v1::handoff:ready');
});

// 9. HANDOFF_ACTION
test('HANDOFF_ACTION = handoff:ready', () => {
  assert.equal(HANDOFF_ACTION, 'handoff:ready');
});

// 10. MANDATORY_TEST_SUITES (Finding 3)
test('MANDATORY_TEST_SUITES co 5 suites', () => {
  assert.equal(MANDATORY_TEST_SUITES.length, 5);
  assert.ok(MANDATORY_TEST_SUITES.includes('scripts/test-pure-logic.mjs'));
  assert.ok(MANDATORY_TEST_SUITES.includes('scripts/test-dod.mjs'));
  assert.ok(MANDATORY_TEST_SUITES.includes('scripts/test-circuit-breaker.mjs'));
  assert.ok(MANDATORY_TEST_SUITES.includes('scripts/test-execution-broker.mjs'));
  assert.ok(MANDATORY_TEST_SUITES.includes('scripts/test-breaker-persist.mjs'));
});

// 11. parseHandoffMarkers / findCanonicalHandoffMarker (Finding 6)
test('parseHandoffMarkers: rich comment + marker hợp lệ -> extract đúng key + provenance', () => {
  const SHA = 'a'.repeat(40);
  const key = `o/r::7::${SHA}::v1::handoff:ready`;
  const comments = [
    { id: 100, user: { login: 'duongpdddic-droid' }, created_at: '2026-08-30T00:00:00Z', body: `some text\n<!-- ai-pr-reviewer:key=${key} -->\nmore` },
  ];
  const parsed = parseHandoffMarkers(comments);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].key, key);
  assert.equal(parsed[0].commentId, '100');
  assert.equal(parsed[0].authorLogin, 'duongpdddic-droid');
});
test('parseHandoffMarkers: legacy body thuần -> KHONG co provenance (fail-closed)', () => {
  const SHA = 'a'.repeat(40);
  const key = `o/r::7::${SHA}::v1::handoff:ready`;
  const parsed = parseHandoffMarkers([`<!-- ai-pr-reviewer:key=${key} -->`]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].commentId, '');
  assert.equal(parsed[0].authorLogin, '');
});
test('parseHandoffMarkers: marker sai shape (khong 5 phan) -> skip', () => {
  const comments = [
    { id: 1, user: { login: 'u' }, body: '<!-- ai-pr-reviewer:key=o/r::7::not-hex::v1::handoff:ready -->' },
    { id: 2, user: { login: 'u' }, body: '<!-- ai-pr-reviewer:key=o/r::7::' + 'a'.repeat(40) + '::handoff:ready -->' },
  ];
  const parsed = parseHandoffMarkers(comments);
  assert.equal(parsed.length, 0);
});
test('findCanonicalHandoffMarker: provenance fail -> bo qua marker body thuan', () => {
  const SHA = 'a'.repeat(40);
  const key = `o/r::7::${SHA}::v1::handoff:ready`;
  const parsed = parseHandoffMarkers([`<!-- ai-pr-reviewer:key=${key} -->`]);
  const found = findCanonicalHandoffMarker(parsed, key);
  assert.equal(found, null, 'legacy body thuan khong du provenance phai reject');
});
test('findCanonicalHandoffMarker: rich + key khop -> tra marker', () => {
  const SHA = 'a'.repeat(40);
  const key = `o/r::7::${SHA}::v1::handoff:ready`;
  const parsed = parseHandoffMarkers([
    { id: 5, user: { login: 'coder' }, body: `<!-- ai-pr-reviewer:key=${key} -->` },
  ]);
  const found = findCanonicalHandoffMarker(parsed, key);
  assert.ok(found, 'phai tim thay marker');
  assert.equal(found.authorLogin, 'coder');
  assert.equal(found.commentId, '5');
});
test('findCanonicalHandoffMarker: rich nhung key khac -> null', () => {
  const SHA = 'a'.repeat(40);
  const key = `o/r::7::${SHA}::v1::handoff:ready`;
  const parsed = parseHandoffMarkers([
    { id: 5, user: { login: 'coder' }, body: `<!-- ai-pr-reviewer:key=o/r::7::${SHA}::v9::handoff:ready -->` },
  ]);
  assert.equal(findCanonicalHandoffMarker(parsed, key), null);
});

// 12. verifyRemotePrHead — input validation (Finding 4)
test('verifyRemotePrHead: ctx invalid -> ok=false, match=false', () => {
  const r1 = { ok: false, repo: null, branch: null, headSha: null, error: 'no origin' };
  const r2 = verifyRemotePrHead(r1);
  assert.equal(r2.ok, false);
  assert.equal(r2.match, false);
  assert.equal(r2.error, 'invalid git context');
});

// Run
for (const c of cases) {
  try { c.fn(); log(true, c.name, null); }
  catch (e) { log(false, c.name, e); }
}
// Invariant: passed không bao giờ vượt cases.length (chống duplicate runner loop)
if (passed !== cases.length) {
  console.log(`\nINVARIANT FAIL: passed=${passed} !== cases.length=${cases.length}`);
  process.exit(1);
}
console.log(`\nTổng: ${passed}/${cases.length} PASS`);
process.exit(failed === 0 ? 0 : 1);

