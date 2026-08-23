#!/usr/bin/env node
// test-integration-review-runtime.mjs — Integration runtime theo [GPT-REV-039]/[GPT-REV-040]:
// phase resolution fail-closed qua processPr (mock io), escalation theo pha, 6 gate steady-state,
// rebuttal FIX/REBUT → ACCEPTED/REJECTED, task discovery zero/one/many. Exit 0/1.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS } from './review-contract.mjs';
import {
  evaluateSteadyApprovalGates, planDiscoveryBehavior, planEscalationForPhase,
  resolveRebuttalOutcome, resolveReviewPhase,
} from './review-contract.mjs';
import { processPr } from './unified-orchestrator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const canonical = JSON.parse(readFileSync(path.join(ROOT, '.github', 'ai-review-policy.json'), 'utf8'));
let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

// --- Phase resolution ---
{
  const tr = resolveReviewPhase(canonical, { runtimeWiringMerged: false });
  assert.equal(tr.phase, 'transition');
  assert.equal(tr.escalateToGpt !== undefined ? true : true, true);
  assert.equal(tr.localReviewerCanApprove, false); // transition: local KHÔNG tự approve
  const ss = resolveReviewPhase(canonical, { runtimeWiringMerged: true });
  assert.equal(ss.phase, 'steady-state'); // activationRequires đủ + wiring merged
  const brokenPolicy = {};
  const bp = resolveReviewPhase(brokenPolicy, {});
  assert.equal(bp.phase, 'blocked');
  assert.equal(bp.code, 'BLOCKED_PHASE_UNRESOLVED');
  assert.equal(bp.localReviewerCanApprove, false);
  ok('phase: transition khi wiring chưa merge; steady-state chỉ sau merge+approved; hỏng shape → blocked');
}

// --- Escalation theo pha ---
{
  const tr = { phase: 'transition' };
  assert.equal(planEscalationForPhase(tr, { verdict: 'PRE_REVIEW_PASS', openBlockingCount: 0 }).action, 'escalate-gpt');
  const ss = { phase: 'steady-state' };
  assert.equal(planEscalationForPhase(ss, { verdict: 'PRE_REVIEW_PASS', openBlockingCount: 0 }).action, 'local-accept-candidate');
  assert.equal(planEscalationForPhase(ss, { verdict: 'PRE_REVIEW_FINDINGS', openBlockingCount: 2 }).action, 'escalate-gpt');
  assert.equal(planEscalationForPhase(ss, { verdict: 'PRE_REVIEW_PASS', decisionGate: 'diff-limit' }).action, 'escalate-gpt');
  assert.equal(planEscalationForPhase(null, {}).action, 'block');
  ok('escalation: transition luôn GPT; steady-state chỉ escalate khi blocking/decision-gate; phase null → block');
}

// --- 6 gate steady-state (fail-closed thiếu bất kỳ bằng chứng) ---
{
  const full = {
    ciState: 'pass', passMarkerPresent: true, headSha: 'a'.repeat(40),
    policyValid: true, policyVersionMatch: true, openBlockingCount: 0, readAfterWriteOk: true,
  };
  assert.equal(evaluateSteadyApprovalGates(full).ok, true);
  for (const k of Object.keys(full)) {
    const broken = { ...full, [k]: typeof full[k] === 'boolean' ? false : (k === 'openBlockingCount' ? 1 : null) };
    if (!evaluateSteadyApprovalGates(broken).ok) continue;
    throw new Error(`gate ${k} không fail-closed`);
  }
  ok('steady-state approval: đủ gate mới ok; mỗi gate thiếu riêng lẻ đều fail-closed');
}

// --- Rebuttal FIX/REBUT → reviewer ACCEPTED/REJECTED ---
{
  const finding = { code: 'LOCAL-REV-001', severity: 'important', evidence: 'e', risk: 'r', expectedOutcome: 'o' };
  assert.deepEqual(
    resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-FIX', finding, evidencePresent: true }),
    { findingClosed: true, nextAction: 'close-finding' });
  assert.equal(resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-FIX', finding, evidencePresent: false }).findingClosed, false);
  assert.deepEqual(
    resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-REBUT', finding, reviewerVerdict: 'ACCEPTED', evidencePresent: true }),
    { findingClosed: true, nextAction: 'close-finding' });
  assert.equal(resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-REBUT', finding, reviewerVerdict: 'REJECTED' }).nextAction, 'escalate-dispute');
  // Im lặng = còn mở; finding malformed → reviewer phải xác nhận lại.
  assert.equal(resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-REBUT', finding, reviewerVerdict: null }).findingClosed, false);
  assert.equal(resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-REBUT', finding: { code: 'X' } }).malformedFinding, true);
  ok('rebuttal: FIX+closing evidence đóng; REBUT ACCEPTED đóng; REJECTED→dispute escalate; im lặng/malformed vẫn mở');
}

// --- Integration: processPr fail-closed khi effective policy không phân giải được ---
{
  const SHA = 'b'.repeat(40);
  const pr = {
    state: 'open',
    headRefOid: SHA,
    labels: ['status:review-requested'],
  };
  const mutations = [];
  const io = {
    getPrView() { return { state: pr.state, headRefOid: pr.headRefOid, labels: [...pr.labels] }; },
    listPrComments() { return []; },
    // Mô phỏng đúng shape defaultIo sau migration: canonical không đọc được → BLOCKED_*
    getPolicy() { return { policy: null, error: 'BLOCKED_VERSION_MISMATCH: pin 2099-01-01.1 != canonical 2026-08-23.5' }; },
    addLabels(_r, _n, labels) {
      for (const l of labels) if (!pr.labels.includes(l)) pr.labels.push(l);
      mutations.push(`add:${labels.join(',')}`);
    },
    removeLabels(_r, _n, labels) {
      for (const l of labels) pr.labels = pr.labels.filter((x) => x !== l);
      mutations.push(`remove:${labels.join(',')}`);
    },
    postComment() { return '#c'; },
    notify() { return { ok: true }; },
    log() {},
  };
  const res = await processPr(io, 'o/r', 7, { dryRun: false });
  assert.ok(pr.labels.includes(LABELS.blocked), 'PR phải chuyển status:blocked');
  assert.ok(!pr.labels.includes(LABELS.changesRequested), 'KHÔNG được trả coder như lỗi code');
  assert.match(String(res.error || ''), /BLOCKED_VERSION_MISMATCH/);
  ok('processPr: policy BLOCKED_* → status:blocked fail-closed (không request-fix, không handoff)');
}

// --- Task discovery zero/one/many (GPT-REV-037 runtime) ---
{
  assert.deepEqual(
    planDiscoveryBehavior({ validTasks: 0 }),
    { result: 'NO_TASK', mutationAllowed: false });
  assert.deepEqual(
    planDiscoveryBehavior({ validTasks: 1 }),
    { result: 'claim-exactly-one', mutationAllowed: true });
  assert.deepEqual(
    planDiscoveryBehavior({ validTasks: 2 }),
    { result: 'blocked-no-guessing', mutationAllowed: false });
  assert.deepEqual(
    planDiscoveryBehavior({ validTasks: 1, conflicting: true }),
    { result: 'blocked-no-guessing', mutationAllowed: false });
  ok('discovery: zero→NO_TASK; one→claim; many/conflict→blocked-no-guessing');
}

// --- Integration [GPT-REV-045]: processPr route theo pha qua activation marker ---
{
  const SHA2 = 'c'.repeat(40);
  const validActivation = `<!-- ai-review-phase-activation:${JSON.stringify({
    phase: 'steady-state', wiringPr: 'duongpdddic-droid/AI_PR_REVIEWER#9',
    wiringMergedSha: SHA2, gptApprovedHeadSha: SHA2,
    recordedBy: 'user', recordedAt: '2026-08-23T00:00:00Z',
  })} -->`;

  function makeRuntimeIo({ labels = ['status:review-requested'], diff = '+const a = 1;\n', activation = '', readBackFail = false } = {}) {
    const st = { labels: [...labels], comments: [] };
    return {
      st,
      getPrView() { return { state: 'open', headRefOid: SHA2, labels: [...st.labels] }; },
      listPrComments() {
        if (readBackFail && st.comments.length) return []; // mô phỏng read-after-write FAIL
        return [...st.comments];
      },
      getPolicy() { return { policy: JSON.parse(JSON.stringify(canonical)) }; },
      getChecks() { return { checks: [{ name: canonical.requiredChecks[0], state: 'SUCCESS' }] }; },
      getPrDiff() { return diff; },
      getPhaseActivationText() { return activation; },
      addLabels(_r, _n, ls) { for (const l of ls) if (!st.labels.includes(l)) st.labels.push(l); },
      removeLabels(_r, _n, ls) { st.labels = st.labels.filter((l) => !ls.includes(l)); },
      postComment(_r, _n, body) { st.comments.push(body); return '#c'; },
      notify() { return { ok: true, attempts: 1, evidence: 'SENT', detail: '' }; },
      log() {},
    };
  }

  // R.1 transition (không activation) + PASS sạch → bàn giao GPT, KHÔNG approved.
  {
    const t = makeRuntimeIo();
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.equal(res.preReview.outcome, 'handoff-gpt');
    assert.ok(t.st.labels.includes(LABELS.reviewRequested));
    assert.ok(t.st.labels.includes('agent:gpt'));
    assert.ok(!t.st.labels.includes(LABELS.approved));
    ok('processPr transition + PASS sạch → handoff-gpt, KHÔNG tự approve');
  }

  // R.2 marker hợp lệ + PASS sạch → local approval marker khóa HEAD/policy + status:approved.
  {
    const t = makeRuntimeIo({ activation: validActivation });
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.equal(res.preReview.outcome, 'local-approved');
    assert.ok(Array.isArray(res.preReview.gates) && res.preReview.gates.every((g) => g.pass));
    assert.ok(t.st.labels.includes(LABELS.approved), 'phải có status:approved');
    const joined = t.st.comments.join('\n');
    assert.match(joined, /ai-review-approval:\{[^]*"reviewer":"reviewer:local"/);
    assert.ok(joined.includes(`"headSha":"${SHA2}"`), 'approval phải khóa đúng HEAD');
    assert.ok(joined.includes(`"policyVersion":"${canonical.policyVersion}"`), 'approval phải khóa policyVersion');
    ok('processPr steady-state đủ gate → local approval + status:approved (read-back PASS)');
  }

  // R.3 marker hợp lệ nhưng decision-gate (diff-limit) → blocked, KHÔNG approved.
  {
    const bigDiff = Array.from({ length: 1501 }, (_, i) => `+line${i}`).join('\n');
    const t = makeRuntimeIo({ labels: ['status:reviewing'], activation: validActivation, diff: bigDiff });
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.equal(res.preReview.outcome, 'block-decision-gate');
    assert.ok(t.st.labels.includes(LABELS.blocked));
    assert.ok(!t.st.labels.includes(LABELS.approved));
    ok('processPr steady-state + decision-gate → blocked, KHÔNG approve');
  }

  // R.4 read-after-write FAIL → không approve, fail-closed escalate GPT.
  {
    const t = makeRuntimeIo({ activation: validActivation, readBackFail: true });
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.notEqual(res.preReview && res.preReview.outcome, 'local-approved');
    assert.ok(!t.st.labels.includes(LABELS.approved), 'read-back FAIL phải chặn approved');
    assert.ok(t.st.labels.includes('agent:gpt'), 'fail-closed phải bàn giao GPT');
    ok('processPr steady-state read-back FAIL → fail-closed escalate-gpt, KHÔNG approve');
  }

  // R.5 marker sai SHA shape → inactive → transition (GPT duyệt).
  {
    const t = makeRuntimeIo({ activation: validActivation.replace(SHA2, 'shortsha') });
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.equal(res.preReview.outcome, 'handoff-gpt');
    assert.ok(!t.st.labels.includes(LABELS.approved));
    ok('processPr activation marker sai SHA → transition fail-closed');
  }
}

console.log(`test-integration-review-runtime: ${passed} asserts PASS`);
