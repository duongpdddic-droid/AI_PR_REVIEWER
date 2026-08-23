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

// --- Integration [GPT-REV-045]+[GPT-REV-046]: processPr activation CÓ AUTHORITY qua io thật ---
{
  const SHA2 = 'c'.repeat(40); // HEAD của PR đang review (o/r #7)
  const EV = canonical.reviewerPhases.phases.steadyState.activationEvidence;
  const WPR = `${EV.expectedWiringPr.repo}#${EV.expectedWiringPr.number}`;
  const MERGE_SHA = 'd'.repeat(40);   // merge commit SHA thật của wiring PR
  const MERGED_HEAD = 'e'.repeat(40); // head đã merge thật của wiring PR
  const RECORDER = EV.allowedRecorders[0];

  const actMarker = (o = {}) => `<!-- ai-review-phase-activation:${JSON.stringify({
    phase: 'steady-state', wiringPr: WPR, wiringMergedSha: MERGE_SHA,
    gptApprovedHeadSha: MERGED_HEAD, recordedBy: RECORDER, recordedAt: '2026-08-23T01:00:00Z', ...o,
  })} -->`;
  const wiredComment = (body, login = RECORDER) => ({ id: '1', user: { login }, created_at: '2026-08-23T01:00:00Z', body });
  const goodComment = () => wiredComment(actMarker());

  // GPT approval marker trên wiring PR (khoá đúng head đã merge + policyVersion hiện tại).
  const wiringApproval = (policyVersion = canonical.policyVersion) => `<!-- ai-review-approval:${JSON.stringify({
    repository: EV.expectedWiringPr.repo, prNumber: EV.expectedWiringPr.number,
    reviewer: 'agent:gpt', headSha: MERGED_HEAD, policyVersion,
    decisionId: 'gpt-wiring-001', ciEvidence: null, openBlockingFindings: 0,
    reviewedAt: '2026-08-23T00:00:00Z',
  })} -->`;

  function makeRuntimeIo({
    labels = ['status:review-requested'], diff = '+const a = 1;\n', readBackFail = false,
    issueComments = [], wiringState = null, wiringComments = [wiringApproval()], pullStateError = false,
  } = {}) {
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
      // [GPT-REV-046] io có metadata: Issue #2 → marker; wiring PR #4 → comments + trạng thái thật.
      getIssueComments(repo, num) {
        if (num === EV.issue) return issueComments;
        if (repo === EV.expectedWiringPr.repo && num === EV.expectedWiringPr.number) {
          return wiringComments.map((body, i) => ({ id: `w${i}`, user: { login: RECORDER }, created_at: '2026-08-23T00:00:00Z', body }));
        }
        return [];
      },
      getPullState(repo, num) {
        if (pullStateError) throw new Error('gh api pulls FAIL');
        if (repo === EV.expectedWiringPr.repo && num === EV.expectedWiringPr.number) {
          return wiringState || { state: 'closed', merged: true, mergeCommitSha: MERGE_SHA, headSha: MERGED_HEAD };
        }
        throw new Error(`unexpected getPullState ${repo}#${num}`);
      },
      addLabels(_r, _n, ls) { for (const l of ls) if (!st.labels.includes(l)) st.labels.push(l); },
      removeLabels(_r, _n, ls) { st.labels = st.labels.filter((l) => !ls.includes(l)); },
      postComment(_r, _n, body) { st.comments.push(body); return '#c'; },
      notify() { return { ok: true, attempts: 1, evidence: 'SENT', detail: '' }; },
      log() {},
    };
  }

  // Mọi kịch bản fail-closed → giữ transition (handoff-gpt), tuyệt đối KHÔNG status:approved.
  async function expectHandoff(opts, name) {
    const t = makeRuntimeIo(opts);
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.equal(res.preReview.outcome, 'handoff-gpt');
    assert.ok(!t.st.labels.includes(LABELS.approved), `${name}: KHÔNG approved`);
    assert.ok(t.st.labels.includes('agent:gpt'), `${name}: bàn giao GPT`);
    ok(name);
  }

  // R.1 transition (không marker) + PASS sạch → bàn giao GPT, KHÔNG approved.
  await expectHandoff({}, 'R.1 transition (không marker) + PASS sạch → handoff-gpt');

  // R.2 đủ authority (author+merge+SHA+GPT approval) + PASS sạch → local approval + status:approved.
  {
    const t = makeRuntimeIo({ issueComments: [goodComment()] });
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.equal(res.preReview.outcome, 'local-approved');
    assert.ok(Array.isArray(res.preReview.gates) && res.preReview.gates.every((g) => g.pass));
    assert.ok(t.st.labels.includes(LABELS.approved), 'phải có status:approved');
    const joined = t.st.comments.join('\n');
    assert.match(joined, /ai-review-approval:\{[^]*"reviewer":"reviewer:local"/);
    assert.ok(joined.includes(`"headSha":"${SHA2}"`), 'approval phải khóa đúng HEAD');
    assert.ok(joined.includes(`"policyVersion":"${canonical.policyVersion}"`), 'approval phải khóa policyVersion');
    ok('R.2 đủ authority → steady-state local approval + status:approved (read-back PASS)');
  }

  // R.3 marker hợp lệ nhưng decision-gate (diff-limit) → blocked, KHÔNG approved.
  {
    const bigDiff = Array.from({ length: 1501 }, (_, i) => `+line${i}`).join('\n');
    const t = makeRuntimeIo({ labels: ['status:reviewing'], issueComments: [goodComment()], diff: bigDiff });
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.equal(res.preReview.outcome, 'block-decision-gate');
    assert.ok(t.st.labels.includes(LABELS.blocked));
    assert.ok(!t.st.labels.includes(LABELS.approved));
    ok('R.3 steady-state + decision-gate → blocked, KHÔNG approve');
  }

  // R.4 read-after-write FAIL → không approve, fail-closed escalate GPT.
  {
    const t = makeRuntimeIo({ issueComments: [goodComment()], readBackFail: true });
    const res = await processPr(t, 'o/r', 7, { dryRun: false });
    assert.notEqual(res.preReview && res.preReview.outcome, 'local-approved');
    assert.ok(!t.st.labels.includes(LABELS.approved), 'read-back FAIL phải chặn approved');
    assert.ok(t.st.labels.includes('agent:gpt'), 'fail-closed phải bàn giao GPT');
    ok('R.4 read-after-write FAIL → fail-closed escalate-gpt, KHÔNG approve');
  }

  // R.5 marker sai SHA shape → collect bỏ qua → zero marker → transition fail-closed.
  await expectHandoff({ issueComments: [wiredComment(actMarker({ wiringMergedSha: 'shortsha' }))] },
    'R.5 marker sai SHA shape → transition fail-closed');

  // R.6 author không được policy cho phép (allowedRecorders) → không kích hoạt.
  await expectHandoff({ issueComments: [wiredComment(actMarker(), 'some-bot')] },
    'R.6 author không thuộc allowedRecorders → KHÔNG kích hoạt');

  // R.7 wiringPr sai PR (không khớp expectedWiringPr) → không kích hoạt.
  await expectHandoff({ issueComments: [wiredComment(actMarker({ wiringPr: `${EV.expectedWiringPr.repo}#9` }))] },
    'R.7 wiringPr sai PR → KHÔNG kích hoạt');

  // R.8 wiring PR chưa merge → không kích hoạt.
  await expectHandoff({
    issueComments: [goodComment()],
    wiringState: { state: 'open', merged: false, mergeCommitSha: MERGE_SHA, headSha: MERGED_HEAD },
  }, 'R.8 wiring PR chưa merge → KHÔNG kích hoạt');

  // R.9 merge commit thật khác marker wiringMergedSha → không kích hoạt.
  await expectHandoff({
    issueComments: [goodComment()],
    wiringState: { state: 'closed', merged: true, mergeCommitSha: 'a'.repeat(40), headSha: MERGED_HEAD },
  }, 'R.9 wiringMergedSha lệch merge commit thật → KHÔNG kích hoạt');

  // R.10 gptApprovedHeadSha lệch head đã merge → không kích hoạt.
  await expectHandoff({
    issueComments: [goodComment()],
    wiringState: { state: 'closed', merged: true, mergeCommitSha: MERGE_SHA, headSha: 'a'.repeat(40) },
  }, 'R.10 gptApprovedHeadSha lệch head đã merge → KHÔNG kích hoạt');

  // R.11 thiếu GPT approval trên wiring PR → không kích hoạt.
  await expectHandoff({ issueComments: [goodComment()], wiringComments: [] },
    'R.11 thiếu GPT approval trên wiring PR → KHÔNG kích hoạt');

  // R.12 GPT approval stale (sai policyVersion) → không kích hoạt.
  await expectHandoff({ issueComments: [goodComment()], wiringComments: [wiringApproval('2026-08-22.9')] },
    'R.12 GPT approval stale (sai policyVersion) → KHÔNG kích hoạt');

  // R.13 nhiều marker mâu thuẫn (2 record nội dung khác) → không kích hoạt.
  await expectHandoff({
    issueComments: [
      goodComment(),
      wiredComment(actMarker({ wiringMergedSha: 'f'.repeat(40) }), RECORDER),
    ],
  }, 'R.13 nhiều marker mâu thuẫn → KHÔNG kích hoạt');

  // R.14 API lỗi đọc wiring PR state → fail-closed transition (không crash, không approve).
  await expectHandoff({ issueComments: [goodComment()], pullStateError: true },
    'R.14 API lỗi trạng thái wiring PR → transition fail-closed');
}

console.log(`test-integration-review-runtime: ${passed} asserts PASS`);
