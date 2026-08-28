#!/usr/bin/env node
// test-pure-logic.mjs — test hành vi dựa trên pure logic (Nhóm 1).
// KHÔNG framework — assert-based self-check. Exit 0 = PASS, 1 = FAIL.
import { escapeHtml, eventKey, NotificationStore, buildMessage } from './tg-notify-core.mjs';
import {
  parseClaimResult,
  isClaimSuccess,
  planReview,
  canRetryFix,
  issueStatusFromLabels,
  branchNameFor,
  summarizeVerify,
} from './autonomous-core.mjs';
// --- review-contract (Issue #2) — hợp đồng review mới ---
import {
  LABELS as RL, AGENTS as RA, REVIEWER_LOCAL, POLICY_PATH,
  DEFAULT_BLOCKING_SEVERITIES, SEVERITIES,
  normalizeStatusLabels, validatePolicy, evaluateChecks, planCiRouting,
  planPreReviewOutcome, buildApprovalMarker, parseApprovalMarkers, isApprovalValid,
  effectiveApproval, planApprovalDrift, isStaleEvent, canMutatePr, mutationKey,
  collectActivationRecords, planPhaseActivation,
  countReviewRounds, gateOpenFindings, scanDiffForSecrets, evaluateDiffLimits,
  validateApprovalPayload,
  LOCAL_APPROVAL_REQUIRED_FIELDS, parseActivationComment, scanDuplicateObjectKeys,
  resolveRebuttalOutcome, steadyLocalApproval,
  planHeadLock, parsePreReviewPassShas, latestApprovalShaAnyHead,
  parseUnfreezeMarkers, isUnfrozenAfter, decidePrePushGuard,
  collectPreReviewPassRecords, isPreReviewPassCanonical,
} from './review-contract.mjs';
import { runSemanticPreReview } from './unified-orchestrator.mjs';
import { withRetry } from './tg-notify-core.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const policy = {
  policyVersion: '2026-08-23.1',
  requiredChecks: ['verify'],
  blockingSeverities: ['critical', 'important'],
  finalReviewer: 'agent:gpt',
  maxReviewRounds: 3,
  diffLimits: { maxLines: 100 },
  approvalAuthorities: { gptApprovalCommentAuthors: ['user', 'gpt-user'], localApprovalCommentAuthors: ['user'] },
};

// escapeHtml: escape & < > cho parse_mode=HTML, giữ tiếng Việt nguyên.
eq('escapeHtml &', escapeHtml('A & B'), 'A &amp; B');
eq('escapeHtml < >', escapeHtml('<x>'), '&lt;x&gt;');
eq('escapeHtml accents', escapeHtml('dự án'), 'dự án');

// eventKey: repo::ref::event::state
eq('eventKey', eventKey({ repo: 'o/r', ref: '#1', eventType: 'done', state: 'ready' }), 'o/r::#1::done::ready');

// NotificationStore chống trùng: key đã SENT -> shouldSend false
{
  const store = new NotificationStore();
  const key = 'a::#1::done::ready';
  tru('store.shouldSend initial', store.shouldSend(key));
  store.markSent(key);
  eq('store.shouldSend sau SENT', store.shouldSend(key), false);
}

// buildMessage: chứa các trường + đã escape.
{
  const msg = buildMessage({ eventType: 'done', repo: 'o/r', ref: '#1', state: 'ready', summary: 'a<b', nextAction: 'merge' });
  tru('buildMessage tags', msg.includes('Hoàn thành / Bàn giao') && msg.includes('a&lt;b'));
}

// --- autonomous-core (coder side, giữ nguyên) ---
// parseClaimResult: object & JSON string đều chuẩn hoá.
{
  const fromObj = parseClaimResult({ status: 'CLAIMED', number: 7, preflight: { baseSha: 'abc' } });
  eq('parseClaimResult obj.status', fromObj.status, 'CLAIMED');
  eq('parseClaimResult obj.number', fromObj.number, 7);
  eq('parseClaimResult obj.baseSha', fromObj.baseSha, 'abc');

  const fromStr = parseClaimResult('{"status":"ALREADY_CLAIMED","number":9}');
  eq('parseClaimResult str.status', fromStr.status, 'ALREADY_CLAIMED');
  eq('parseClaimResult str.number', fromStr.number, 9);

  const bad = parseClaimResult('not json');
  eq('parseClaimResult bad.status', bad.status, 'ERROR');
}
// isClaimSuccess
eq('isClaimSuccess CLAIMED', isClaimSuccess('CLAIMED'), true);
eq('isClaimSuccess ALREADY', isClaimSuccess('ALREADY_CLAIMED'), true);
eq('isClaimSuccess NO_TASK', isClaimSuccess('NO_TASK'), false);

// planReview (coder pipeline): verify PASS → xong; fail hết vòng → block.
eq('planReview changes r0', planReview({ verifyOk: false, round: 0 }).action, 'request-changes');
eq('planReview block r3', planReview({ verifyOk: false, round: 3 }).action, 'block');
eq('canRetryFix fail r0', canRetryFix({ verifyOk: false, round: 0 }), true);
eq('canRetryFix fail r3', canRetryFix({ verifyOk: false, round: 3 }), false);
// issueStatusFromLabels: terminal labels ưu tiên.
eq('status approved', issueStatusFromLabels(['status:approved', 'status:in-progress']), 'approved');
eq('status ready', issueStatusFromLabels(['status:ready-for-cline']), 'ready');
eq('status unknown', issueStatusFromLabels([]), 'unknown');
// branchNameFor: slug an toàn.
eq('branchNameFor', branchNameFor(12, '  Fix Lỗi XYZ !!!  '), 'feat/issue-12-fix-l-i-xyz');
// summarizeVerify.
eq('summarizeVerify pass', summarizeVerify('...\nTổng: 18/18 PASS\n'), 'Tổng: 18/18 PASS');

// C.1 CI pass → KHÔNG approve; chỉ status:reviewing.
{
  const p = planCiRouting({ ciState: 'pass' });
  eq('C.1 routing pass action', p.action, 'start-semantic-review');
  eq('C.1 routing pass label', p.addLabels.join(','), 'status:reviewing');
  tru('C.1 routing KHÔNG approved/gpt', !p.addLabels.includes('status:approved') && !p.addLabels.includes('agent:gpt'));
  tru('C.1 routing gỡ review-requested', p.removeLabels.includes('status:review-requested'));
}
// C.2 CI fail/missing/unknown → fail-closed trả Cline.
for (const st of ['fail', 'missing', 'unknown']) {
  const p = planCiRouting({ ciState: st });
  eq(`C.2 routing ${st}`, p.action, 'request-fix');
  tru(`C.2 ${st} nhãn cline`, p.addLabels.includes('agent:cline') && p.addLabels.includes('status:changes-requested'));
}
eq('C.2 routing pending', planCiRouting({ ciState: 'pending' }).action, 'wait');

// C.3 evaluateChecks + validatePolicy fail-closed.
eq('C.3 checks pass', evaluateChecks(policy, { checks: [{ name: 'verify', state: 'SUCCESS' }] }), 'pass');
eq('C.3 checks pending', evaluateChecks(policy, { checks: [{ name: 'verify', state: 'IN_PROGRESS' }] }), 'pending');
eq('C.3 checks fail', evaluateChecks(policy, { checks: [{ name: 'verify', state: 'FAILURE' }] }), 'fail');
eq('C.3 checks thiếu required', evaluateChecks(policy, { checks: [{ name: 'lint', state: 'SUCCESS' }] }), 'missing');
eq('C.3 checks null', evaluateChecks(policy, null), 'unknown');
eq('C.3 policy null', evaluateChecks(null, { checks: [] }), 'unknown');
eq('C.3 policy sai shape', evaluateChecks({ policyVersion: 'x' }, { checks: [{ name: 'verify', state: 'SUCCESS' }] }), 'unknown');
eq('C.3 requiredChecks rỗng → missing', evaluateChecks({ ...policy, requiredChecks: [] }, { checks: [{ name: 'verify', state: 'SUCCESS' }] }), 'missing');
// [CLINE-FIX-050] shape thật của `gh pr checks --json name,state` là mảng phẳng — phải pass như wrapper.
eq('C.3 checks pass (mảng phẳng gh)', evaluateChecks(policy, [{ name: 'verify', state: 'SUCCESS' }]), 'pass');
eq('C.3 checks fail (mảng phẳng gh)', evaluateChecks(policy, [{ name: 'verify', state: 'FAILURE' }]), 'fail');
eq('C.3 checks thiếu required (mảng phẳng gh)', evaluateChecks(policy, [{ name: 'lint', state: 'SUCCESS' }]), 'missing');

eq('C.3 validatePolicy ok', validatePolicy(policy).ok, true);
eq('C.3 validatePolicy thiếu version', validatePolicy({ requiredChecks: [], maxReviewRounds: 1, finalReviewer: 'x' }).ok, false);

// C.4 approval khóa HEAD SHA.
{
  const marker = buildApprovalMarker({
    repository: 'o/r', prNumber: 7, reviewer: RA.gpt, headSha: SHA,
    policyVersion: policy.policyVersion, ciEvidence: { ciState: 'pass' },
    decisionId: 'dec-c4', openBlockingFindings: 0, reviewedAt: '2026-08-22T00:00:00Z',
  });
  tru('C.4 marker html comment', marker.startsWith('<!-- ai-review-approval:{') && marker.endsWith('-->'));
  const recs = parseApprovalMarkers([{ id: 'c1', user: { login: 'user' }, created_at: '2026-08-22T00:00:00Z', body: `nội dung thường ${marker} đuôi` }]);
  eq('C.4 parse 1 record', recs.length, 1);
  eq('C.4 parse sha', recs[0].marker.headSha, SHA);
  const rec0 = { ...recs[0].marker, commentId: recs[0].commentId, authorLogin: recs[0].authorLogin };
  eq('C.4 valid cùng SHA', isApprovalValid(rec0, { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: policy.policyVersion, gptApprovers: ['user'] }).valid, true);
  eq('C.4 invalid khác SHA', isApprovalValid(rec0, { headSha: SHA2, repository: 'o/r', prNumber: 7 }).valid, false);
  tru('C.4 invalid nêu lý do HEAD', String(isApprovalValid(rec0, { headSha: SHA2 }).reason).includes('HEAD'));
  eq('C.4 invalid khác reviewer', isApprovalValid({ ...rec0, reviewer: 'agent:cline' }, { headSha: SHA }).valid, false);
  eq('C.4 invalid policy lệch', isApprovalValid(rec0, { headSha: SHA, policyVersion: 'khác' }).valid, false);
  eq('C.4 invalid còn blocking', isApprovalValid({ ...rec0, openBlockingFindings: 2 }, { headSha: SHA }).valid, false);
  eq('C.4 invalid thiếu decisionId', isApprovalValid({ ...rec0, decisionId: '' }, { headSha: SHA }).valid, false);
  // [GPT-REV-049] allowlist fail-closed: actor không thuộc approvers bị từ chối.
  eq('C.4 invalid actor không thuộc approvers', isApprovalValid(rec0, { headSha: SHA, repository: 'o/r', prNumber: 7, gptApprovers: ['someone-else'] }).valid, false);
  tru('C.4 invalid nêu lý do UNAUTHORIZED_ACTOR', String(isApprovalValid(rec0, { headSha: SHA, gptApprovers: ['someone-else'] }).reason).includes('UNAUTHORIZED_ACTOR'));
  eq('C.4 invalid approvers rỗng/không truyền', isApprovalValid(rec0, { headSha: SHA, repository: 'o/r', prNumber: 7 }).valid, false);
  tru('C.4 invalid nêu lý do approvers thiếu', String(isApprovalValid(rec0, { headSha: SHA }).reason).includes('UNAUTHORIZED_ACTOR'));
  eq('C.4 marker hỏng bỏ qua', parseApprovalMarkers(['<!-- ai-review-approval:{hỏng -->']).length, 0);
  const old = buildApprovalMarker({ ...{ repository: 'o/r', prNumber: 7, reviewer: RA.gpt, headSha: SHA, policyVersion: policy.policyVersion, decisionId: 'dec-old', openBlockingFindings: 0 }, reviewedAt: '2026-08-21T00:00:00Z' });
  const oldC = { id: 'old1', user: { login: 'gpt-user' }, created_at: '2026-08-21T00:00:00Z', body: old };
  const newC = { id: 'new1', user: { login: 'gpt-user' }, created_at: '2026-08-22T00:00:00Z', body: marker };
  eq('C.4 effective chọn mới nhất',
    effectiveApproval([oldC, newC], { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: policy.policyVersion, gptApprovers: ['gpt-user'] }).reviewedAt,
    '2026-08-22T00:00:00Z');
}

// C.5 approval-drift.
{
  const plain = { id: 'p1', user: { login: 'user' }, created_at: '-', body: 'comment thường' };
  const d = planApprovalDrift({ labels: ['status:approved'], comments: [plain], headSha: SHA, repository: 'o/r', prNumber: 7, gptApprovers: ['gpt-user'] });
  eq('C.5 drift phát hiện', d.drift, true);
  tru('C.5 drift gỡ approved', d.removeLabels.includes('status:approved'));
  tru('C.5 drift thêm review-requested + gpt', d.addLabels.includes('status:review-requested') && d.addLabels.includes('agent:gpt'));
  const marker = buildApprovalMarker({ repository: 'o/r', prNumber: 7, reviewer: RA.gpt, headSha: SHA, policyVersion: policy.policyVersion, decisionId: 'dec-c5', openBlockingFindings: 0, reviewedAt: '2026-08-22T00:00:00Z' });
  const richMarker = { id: 'm1', user: { login: 'gpt-user' }, created_at: '2026-08-22T00:00:00Z', body: marker };
  eq('C.5 approval hợp lệ → không drift', planApprovalDrift({ labels: ['status:approved'], comments: [richMarker], headSha: SHA, repository: 'o/r', prNumber: 7, gptApprovers: ['gpt-user'] }).drift, false);
  // [GPT-REV-049] actor không thuộc approvers → approval KHÔNG hợp lệ → drift phát hiện.
  eq('C.5 actor không thuộc approvers → drift', planApprovalDrift({ labels: ['status:approved'], comments: [richMarker], headSha: SHA, repository: 'o/r', prNumber: 7, gptApprovers: ['someone-else'] }).drift, true);
  eq('C.5 không phải approved → bỏ qua', planApprovalDrift({ labels: ['status:reviewing'], comments: [], headSha: SHA }).drift, false);
}

// C.6 pre-review verdict chỉ 2 giá trị; PASS → handoff-gpt; findings → request-fix; hết vòng → block.
{
  const pass = planPreReviewOutcome({ verdict: 'PRE_REVIEW_PASS', round: 0, maxRounds: 3 });
  eq('C.6 pass action', pass.action, 'handoff-gpt');
  tru('C.6 pass gpt + review-requested', pass.addLabels.includes('agent:gpt') && pass.addLabels.includes('status:review-requested'));
  tru('C.6 pass KHÔNG approved', !pass.addLabels.includes('status:approved'));
  const fix = planPreReviewOutcome({ verdict: 'PRE_REVIEW_FINDINGS', round: 0, maxRounds: 3 });
  eq('C.6 findings action', fix.action, 'request-fix');
  const block = planPreReviewOutcome({ verdict: 'PRE_REVIEW_FINDINGS', round: 3, maxRounds: 3 });
  eq('C.6 hết vòng → block', block.action, 'block');
  eq('C.6 block label', block.addLabels.join(','), 'status:blocked');
}

// C.7 event muộn + PR đóng + khóa idempotency.
eq('C.7 stale khác SHA', isStaleEvent({ eventHeadSha: SHA, currentHeadSha: SHA2 }), true);
eq('C.7 fresh cùng SHA', isStaleEvent({ eventHeadSha: SHA, currentHeadSha: SHA }), false);
eq('C.7 merged không mutation', canMutatePr('merged'), false);
eq('C.7 closed không mutation', canMutatePr('closed'), false);
eq('C.7 open được mutation', canMutatePr('open'), true);
eq('C.7 mutationKey', mutationKey({ repository: 'o/r', prNumber: 7, headSha: SHA, policyVersion: 'v1', action: 'request-fix' }), 'o/r::7::' + SHA + '::v1::request-fix');

// C.8 single-status normalization.
{
  const n = normalizeStatusLabels(['status:approved', 'status:reviewing', 'agent:gpt', 'bug']);
  eq('C.8 giữ 1 status', n.keepStatus, 'status:approved');
  eq('C.8 remove status thừa', n.remove.join(','), 'status:reviewing');
  tru('C.8 keep non-status', n.keep.includes('agent:gpt') && n.keep.includes('bug'));
  eq('C.8 không có status', normalizeStatusLabels(['agent:gpt']).keepStatus, null);
  eq('C.8 object labels', normalizeStatusLabels([{ name: 'status:queued' }]).keepStatus, 'status:queued');
}

// C.9 vòng fix đếm từ marker round.
eq('C.9 rounds 0', countReviewRounds(['bình thường']), 0);
eq('C.9 rounds 2', countReviewRounds(['x <!-- ai-pr-reviewer:round=2 -->']), 2);
eq('C.9 rounds max', countReviewRounds(['<!-- ai-pr-reviewer:round=1 -->', '<!-- ai-pr-reviewer:round=3 -->']), 3);

// C.10 gate findings blocking (taxonomy canonical: critical | important | suggestion).
{
  const fs = [
    { severity: 'critical', status: 'open' },
    { severity: 'important', status: 'resolved' },
    { severity: 'suggestion', status: 'open' },
  ];
  eq('C.10 gate chỉ critical mở (important đã xử lý)', gateOpenFindings(fs).length, 1);
  tru('C.10 Important mở cũng chặn (GPT-REV-034)', gateOpenFindings([{ severity: 'important', status: 'open' }]).length === 1);
  eq('C.10 suggestion không chặn', gateOpenFindings([{ severity: 'suggestion', status: 'open' }]).length, 0);
  eq('C.10 default blocking = critical+important', DEFAULT_BLOCKING_SEVERITIES.join(','), 'critical,important');
  eq('C.10 taxonomy canonical', SEVERITIES.join(','), 'critical,important,suggestion');
}

// C.11 secret scan trên diff.
{
  const diff = [
    'diff --git a/x.js b/x.js',
    '+++ b/x.js',
    "+const apiKey = 'AKIAIOSFODNN7EXAMPLE';",
    '+const name = "an toàn";',
    ' const token = "dòng cũ không quét";',
    '+-----BEGIN RSA PRIVATE KEY-----',
  ].join('\n');
  const f = scanDiffForSecrets(diff);
  tru('C.11 phát hiện secret', f.length >= 2);
  tru('C.11 severity critical', f.every((x) => x.severity === 'critical'));
  tru('C.11 không quét dòng cũ', !JSON.stringify(f).includes('dòng cũ không quét'));
  eq('C.11 diff sạch', scanDiffForSecrets('+const a = 1;').length, 0);
  eq('C.11 diff rỗng', scanDiffForSecrets('').length, 0);
}

// C.12 giới hạn diff (metric canonical: churn = additions + deletions — GPT-REV-031).
eq('C.12 dưới giới hạn', evaluateDiffLimits(policy, '+' + '\n+'.repeat(50)).over, false);
eq('C.12 vượt giới hạn', evaluateDiffLimits(policy, '+' + '\n+'.repeat(150)).over, true);
eq('C.12 không cấu hình giới hạn', evaluateDiffLimits({ diffLimits: {} }, '+' + '\n+'.repeat(999)).over, false);
eq('C.12 churn = added + removed', evaluateDiffLimits(policy, '+' + '\n+'.repeat(40) + '\n-' + '\n-'.repeat(60)).lines, 102);
tru('C.12 chỉ deletion cũng vượt', evaluateDiffLimits(policy, '-' + '\n-'.repeat(120)).over === true);
{
  const r = evaluateDiffLimits(policy, '+\n-\n+');
  eq('C.12 chi tiết added/removed', `${r.added}/${r.removed}`, '2/1');
}

// C.13 withRetry có giới hạn (Issue #2 A7).
{
  let calls = 0;
  let threw = null;
  try {
    await withRetry(async () => { calls++; throw new Error('fail ' + calls); }, { attempts: 3, delayMs: 1, sleep: () => {} });
  } catch (e) { threw = e; }
  eq('C.13 retry đủ 3 lượt', calls, 3);
  tru('C.13 ném lỗi cuối', threw && threw.message === 'fail 3');
  let ok = 0;
  const val = await withRetry(async () => { ok++; if (ok < 3) throw new Error('tạm'); return 'done'; }, { attempts: 3, delayMs: 1, sleep: () => {} });
  eq('C.13 retry thành công lượt 3', val, 'done');
}

// C.14 hằng số hợp đồng: reviewer duy nhất GPT; pre-reviewer local; không còn agent:local-reviewer.
eq('C.14 finalReviewer', policy.finalReviewer, 'agent:gpt');
eq('C.14 REVIEWER_LOCAL', REVIEWER_LOCAL, 'reviewer:local');
eq('C.14 POLICY_PATH', POLICY_PATH, '.github/ai-review-policy.json');
tru('C.14 không có local-reviewer trong AGENTS', !Object.values(RA).includes('agent:local-reviewer'));
eq('C.14 label reviewing tồn tại', RL.reviewing, 'status:reviewing');

// --- Vòng 2 fix theo GPT review (GPT-REV-031..034) ---

// C.15 (GPT-REV-031): diff vượt 1.500 dòng KHÔNG THỂ PRE_REVIEW_PASS → Decision Gate.
{
  const big = Array.from({ length: 1501 }, (_, i) => `+line ${i}`).join('\n');
  const r = runSemanticPreReview({ ...policy, diffLimits: { maxLines: 1500 } }, big);
  eq('C.15 diff 1501 dòng → FINDINGS (không PASS)', r.verdict, 'PRE_REVIEW_FINDINGS');
  eq('C.15 decisionGate = diff-limit', r.decisionGate, 'diff-limit');
  const outcome = planPreReviewOutcome({ verdict: r.verdict, round: 0, maxRounds: 3, decisionGate: r.decisionGate });
  eq('C.15 action block-decision-gate', outcome.action, 'block-decision-gate');
  tru('C.15 blocked + KHÔNG handoff gpt', outcome.addLabels.includes(RL.blocked) && !outcome.addLabels.includes(RA.gpt));
  tru('C.15 finding vượt ngưỡng là critical (blocking)', r.openBlocking.some((f) => f.severity === 'critical' && String(f.evidence).includes('additions-plus-deletions')));
  // Diff đúng giới hạn thì vẫn PASS.
  const ok = runSemanticPreReview({ ...policy, diffLimits: { maxLines: 1500 } }, Array.from({ length: 1500 }, (_, i) => `+l ${i}`).join('\n'));
  eq('C.15 đúng 1500 churn vẫn PASS', ok.verdict, 'PRE_REVIEW_PASS');
}

// C.16 (GPT-REV-032): approval payload phải ràng buộc repo/pr/SHA/policy/decisionId — fail-closed.
{
  const ctx = { repository: 'o/r', prNumber: 7, headSha: SHA, policyVersion: policy.policyVersion };
  const base = { repository: 'o/r', prNumber: 7, headSha: SHA, policyVersion: policy.policyVersion, decisionId: 'dec-1' };
  eq('C.16 payload hợp lệ', validateApprovalPayload(base, ctx).ok, true);
  for (const k of Object.keys(base)) {
    const broken = { ...base };
    delete broken[k];
    tru(`C.16 thiếu ${k} → chặn`, !validateApprovalPayload(broken, ctx).ok);
  }
  tru('C.16 sai repository → chặn', !validateApprovalPayload({ ...base, repository: 'other/r' }, ctx).ok);
  tru('C.16 sai prNumber → chặn', !validateApprovalPayload({ ...base, prNumber: 8 }, ctx).ok);
  tru('C.16 SHA ngắn (<40 hex) → chặn', !validateApprovalPayload({ ...base, headSha: 'abc123def456' }, ctx).ok);
  tru('C.16 SHA lệch HEAD → chặn', !validateApprovalPayload({ ...base, headSha: SHA2 }, ctx).ok);
  tru('C.16 sai policyVersion → chặn', !validateApprovalPayload({ ...base, policyVersion: '2026-08-22.1' }, ctx).ok);
  tru('C.16 decisionId trống/khoảng trắng → chặn', !validateApprovalPayload({ ...base, decisionId: '  ' }, ctx).ok);
  tru('C.16 payload null → chặn', !validateApprovalPayload(null, ctx).ok);
}

// --- C.17 [GPT-REV-045] parseActivationComment — nguồn kích hoạt máy đọc được, fail-closed ---
{
  const rec = {
    phase: 'steady-state', wiringPr: 'duongpdddic-droid/AI_PR_REVIEWER#9',
    wiringMergedSha: SHA, gptApprovedHeadSha: 'b'.repeat(40),
    recordedBy: 'user', recordedAt: '2026-08-23T00:00:00Z',
  };
  const marker = (r) => `<!-- ai-review-phase-activation:${JSON.stringify(r)} -->`;
  tru('C.17 marker hợp lệ → active', parseActivationComment(`text\n${marker(rec)}\n`).active === true);
  tru('C.17 thiếu marker → inactive', parseActivationComment('không có gì').active === false);
  tru('C.17 marker không đóng → inactive', parseActivationComment('<!-- ai-review-phase-activation:{}').active === false);
  tru('C.17 JSON hỏng → inactive', parseActivationComment('<!-- ai-review-phase-activation:{bad} -->').active === false);
  tru('C.17 phase sai → inactive', parseActivationComment(marker({ ...rec, phase: 'transition' })).active === false);
  tru('C.17 thiếu recordedBy → inactive', parseActivationComment(marker({ ...rec, recordedBy: '' })).active === false);
  tru('C.17 wiringMergedSha ngắn → inactive', parseActivationComment(marker({ ...rec, wiringMergedSha: 'abc' })).active === false);
  tru('C.17 gptApprovedHeadSha thiếu → inactive', parseActivationComment(marker({ ...rec, gptApprovedHeadSha: null })).active === false);
}

// --- C.18 [GPT-REV-045] scanDuplicateObjectKeys — chống duplicate JSON keys ---
{
  const dup = '{"a":1,"projectPolicyContract":{"x":1,"x":2},"arr":[{"k":1},{"k":2}]}';
  const d = scanDuplicateObjectKeys(dup).duplicates;
  tru('C.18 phát hiện duplicate trong cùng object', d.length === 1 && d[0].key === 'x');
  tru('C.18 khác object trùng tên key KHÔNG phải dup',
    scanDuplicateObjectKeys('{"a":{"b":1},"c":{"b":2}}').duplicates.length === 0);
  tru('C.18 chuỗi giá trị chứa ":" không gây nhiễu',
    scanDuplicateObjectKeys('{"url":"http://x","a":1}').duplicates.length === 0);
  // Canonical THẬT phải sạch duplicate keys.
  const raw = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', POLICY_PATH), 'utf8');
  tru('C.18 canonical policy thật không có duplicate keys',
    scanDuplicateObjectKeys(raw).duplicates.length === 0);
  // LOCAL_APPROVAL_REQUIRED_FIELDS khớp policy.approvalMarker.requiredFields (cả hai chiều).
  const policyObj = JSON.parse(raw);
  const pf = policyObj.approvalMarker.requiredFields;
  tru('C.18 LOCAL_APPROVAL_REQUIRED_FIELDS đồng bộ policy.approvalMarker.requiredFields',
    LOCAL_APPROVAL_REQUIRED_FIELDS.length === pf.length
    && LOCAL_APPROVAL_REQUIRED_FIELDS.every((f) => pf.includes(f)));
}

// --- C.19/C.20 [GPT-REV-045] steadyLocalApproval + drift fallback ---
{
  const payload = {
    repository: 'o/r', prNumber: 7, reviewer: REVIEWER_LOCAL, headSha: SHA,
    policyVersion: 'v1', decisionId: 'steady-local-x', ciEvidence: { state: 'pass' },
    openBlockingFindings: 0, reviewedAt: '2026-08-23T00:00:00Z',
  };
  const commentBody = `✅ ok\n<!-- ai-review-approval:${JSON.stringify(payload)} -->`;
  const comment = { id: 'c1', user: { login: 'duongpdddic' }, created_at: '2026-08-23T00:00:00Z', body: commentBody };
  const ctx = { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: 'v1', localApprovers: ['duongpdddic'] };
  tru('C.19 local approval hợp lệ được nhận diện', Boolean(steadyLocalApproval([comment], ctx)));
  tru('C.19 sai HEAD → không nhận diện', !steadyLocalApproval([comment], { ...ctx, headSha: 'b'.repeat(40) }));
  tru('C.19 sai policyVersion → không nhận diện', !steadyLocalApproval([comment], { ...ctx, policyVersion: 'v2' }));
  tru('C.19 reviewer:gpt marker KHÔNG bị coi là local approval',
    !steadyLocalApproval([{ id: 'c2', user: { login: 'user' }, created_at: '-', body: `<!-- ai-review-approval:${JSON.stringify({ ...payload, reviewer: RA.gpt })} -->` }], ctx));
  tru('C.20 planApprovalDrift: approved + local marker hợp lệ → KHÔNG drift',
    planApprovalDrift({ labels: [RL.approved], comments: [comment], ...ctx }).drift === false);
  tru('C.20 planApprovalDrift: approved + local marker lệch SHA → drift',
    planApprovalDrift({ labels: [RL.approved], comments: [comment], ...ctx, headSha: 'b'.repeat(40) }).drift === true);
  tru('C.20 planApprovalDrift: approved + không marker nào → drift (như cũ)',
    planApprovalDrift({ labels: [RL.approved], comments: [], ...ctx }).drift === true);
}

// --- C.21 [GPT-REV-045] resolveRebuttalOutcome đủ 5 trường bắt buộc ---
{
  const base4 = { code: 'LOCAL-REV-001', severity: 'important', evidence: 'e', risk: 'r' };
  tru('C.21 finding thiếu expectedOutcome → malformed',
    resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-FIX', finding: base4, evidencePresent: true }).malformedFinding === true);
  tru('C.21 đủ 5 trường + evidence → đóng finding',
    resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-FIX', finding: { ...base4, expectedOutcome: 'ok' }, evidencePresent: true }).findingClosed === true);
  tru('C.21 expectedOutcome rỗng → malformed',
    resolveRebuttalOutcome({ coderVerdictKind: 'CLINE-FIX', finding: { ...base4, expectedOutcome: '' } }).malformedFinding === true);
}

// --- C.22 [GPT-REV-046] activation CÓ AUTHORITY: metadata + GitHub state + GPT approval ---
{
  const PV = '2026-08-23.7';
  const MERGE_SHA = 'c'.repeat(40);
  const MERGED_HEAD = 'd'.repeat(40);
  const WPR = 'duongpdddic-droid/AI_PR_REVIEWER#4';
  const marker = (o = {}) => `<!-- ai-review-phase-activation:${JSON.stringify({
    phase: 'steady-state', wiringPr: WPR, wiringMergedSha: MERGE_SHA,
    gptApprovedHeadSha: MERGED_HEAD, recordedBy: 'duongpdddic-droid',
    recordedAt: '2026-08-23T01:00:00Z', ...o,
  })} -->`;
  const comment = (body, login = 'duongpdddic-droid') => ({ id: '1', user: { login }, created_at: '2026-08-23T01:00:00Z', body });
  const gptApproval = buildApprovalMarker({
    repository: 'duongpdddic-droid/AI_PR_REVIEWER', prNumber: 4, reviewer: RA.gpt,
    headSha: MERGED_HEAD, policyVersion: PV, decisionId: 'gpt-wiring-001',
    ciEvidence: null, openBlockingFindings: 0, reviewedAt: '2026-08-23T00:00:00Z',
  });
  const wiringState = { state: 'closed', merged: true, mergeCommitSha: MERGE_SHA, headSha: MERGED_HEAD };
  const recs = (body, login) => collectActivationRecords([comment(body, login)]);
  const plan = (over = {}) => planPhaseActivation({
    records: recs(marker()), allowedRecorders: ['duongpdddic-droid'],
    expectedWiringPr: { repo: 'duongpdddic-droid/AI_PR_REVIEWER', number: 4 },
    wiringState, wiringApprovalRecords: [{ id: 'w1', user: { login: 'duongpdddic-droid' }, created_at: '2026-08-23T00:00:00Z', body: gptApproval }], policyVersion: PV, gptApprovers: ['duongpdddic-droid'], ...over,
  });
  tru('C.22 collect bóc tách metadata author/id', (() => {
    const r = collectActivationRecords([comment(marker(), 'duongpdddic-droid')]);
    return r.length === 1 && r[0].authorLogin === 'duongpdddic-droid' && r[0].commentId === '1';
  })());
  tru('C.22 collect bỏ qua comment không có marker', collectActivationRecords([comment('plain text')]).length === 0);
  tru('C.22 collect bỏ qua entry null/rỗng/string', collectActivationRecords([null, 'x', {}]).length === 0);
  tru('C.22 đủ authority (author+merge+SHA+GPT approval) → active', plan().active === true);
  tru('C.22 không có marker → inactive', plan({ records: [] }).active === false);
  tru('C.22 hai marker mâu thuẫn → inactive', plan({ records: [...recs(marker()), ...recs(marker({ wiringMergedSha: 'e'.repeat(40) }))] }).active === false);
  tru('C.22 marker trùng nội dung (duplicate) vẫn active', plan({ records: [...recs(marker()), ...recs(marker())] }).active === true);
  tru('C.22 author không thuộc allowedRecorders → inactive', plan({ records: recs(marker(), 'some-bot') }).active === false);
  tru('C.22 author rỗng → inactive', plan({ records: recs(marker(), '') }).active === false);
  tru('C.22 wiringPr sai PR → inactive', plan({ records: recs(marker({ wiringPr: 'duongpdddic-droid/AI_PR_REVIEWER#5' })) }).active === false);
  tru('C.22 wiringPr sai repo → inactive', plan({ records: recs(marker({ wiringPr: 'other/repo#4' })) }).active === false);
  tru('C.22 policy thiếu expectedWiringPr → inactive', plan({ expectedWiringPr: null }).active === false);
  tru('C.22 wiringState null → inactive', plan({ wiringState: null }).active === false);
  tru('C.22 wiringState.error → inactive', plan({ wiringState: { error: 'gh FAIL' } }).active === false);
  tru('C.22 PR chưa merge → inactive', plan({ wiringState: { ...wiringState, merged: false, state: 'open' } }).active === false);
  tru('C.22 mergeCommitSha lệch → inactive', plan({ wiringState: { ...wiringState, mergeCommitSha: 'e'.repeat(40) } }).active === false);
  tru('C.22 gptApprovedHeadSha lệch head thật → inactive', plan({ wiringState: { ...wiringState, headSha: 'e'.repeat(40) } }).active === false);
  tru('C.22 không có GPT approval trên wiring PR → inactive', plan({ wiringApprovalRecords: [] }).active === false);
  tru('C.22 approval stale (sai policyVersion) → inactive', plan({ policyVersion: '2026-08-22.9' }).active === false);
  tru('C.22 approval reviewer:local không được tính → inactive', (() => {
    const localMark = buildApprovalMarker({
      repository: 'duongpdddic-droid/AI_PR_REVIEWER', prNumber: 4, reviewer: REVIEWER_LOCAL,
      headSha: MERGED_HEAD, policyVersion: PV, decisionId: 'steady-local-x',
      ciEvidence: null, openBlockingFindings: 0, reviewedAt: '2026-08-23T00:00:00Z',
    });
    return plan({ wiringApprovalRecords: [localMark] }).active === false;
  })());
  tru('C.22 [GPT-REV-049] GPT approval author không thuộc approvers → inactive', plan({ gptApprovers: ['someone-else'] }).active === false);
}

// --- C.23 [GPT-REV-049] approvalAuthorities allowlist (gpt + local) fail-closed ---
{
  const mkGpt = (o = {}) => buildApprovalMarker({ repository: 'o/r', prNumber: 7, reviewer: RA.gpt, headSha: SHA, policyVersion: 'v1', decisionId: 'dec-1', openBlockingFindings: 0, reviewedAt: '2026-08-23T00:00:00Z', ...o });
  const ALLOW = ['duongpdddic-droid'];
  const recBad = parseApprovalMarkers([{ id: 'c1', user: { login: 'attacker' }, created_at: '-', body: `x ${mkGpt()}` }])[0];
  eq('C.23 GPT marker sai author → invalid', isApprovalValid({ ...recBad.marker, commentId: recBad.commentId, authorLogin: recBad.authorLogin }, { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: 'v1', gptApprovers: ALLOW }).valid, false);
  tru('C.23 GPT marker sai author nêu UNAUTHORIZED_ACTOR', String(isApprovalValid({ ...recBad.marker, commentId: recBad.commentId, authorLogin: recBad.authorLogin }, { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: 'v1', gptApprovers: ALLOW }).reason).includes('UNAUTHORIZED_ACTOR'));
  eq('C.23 thiếu commentId (legacy body) → invalid', isApprovalValid({ ...mkGpt(), commentId: undefined, authorLogin: 'attacker' }, { headSha: SHA, gptApprovers: ALLOW }).valid, false);
  eq('C.23 thiếu authorLogin → invalid', isApprovalValid({ ...mkGpt(), commentId: 'c9', authorLogin: undefined }, { headSha: SHA, gptApprovers: ALLOW }).valid, false);
  eq('C.23 validatePolicy thiếu approvalAuthorities → invalid', validatePolicy({ ...policy, approvalAuthorities: undefined }).ok, false);
  eq('C.23 validatePolicy gptApprovers rỗng → invalid', validatePolicy({ ...policy, approvalAuthorities: { gptApprovalCommentAuthors: [], localApprovalCommentAuthors: ['x'] } }).ok, false);
  eq('C.23 validatePolicy localApprovers rỗng → invalid', validatePolicy({ ...policy, approvalAuthorities: { gptApprovalCommentAuthors: ['x'], localApprovalCommentAuthors: [] } }).ok, false);
  eq('C.23 isApprovalValid gptApprovers rỗng → invalid', isApprovalValid({ ...mkGpt(), commentId: 'c1', authorLogin: 'duongpdddic-droid' }, { headSha: SHA, gptApprovers: [] }).valid, false);
  const mkLocal = (o = {}) => ({ repository: 'o/r', prNumber: 7, reviewer: REVIEWER_LOCAL, headSha: SHA, policyVersion: 'v1', decisionId: 'steady-x', ciEvidence: { state: 'pass' }, openBlockingFindings: 0, reviewedAt: '2026-08-23T00:00:00Z', ...o });
  const goodLocal = { id: 'c1', user: { login: 'duongpdddic' }, created_at: '-', body: `x <!-- ai-review-approval:${JSON.stringify(mkLocal())} -->` };
  const wrongLocal = { id: 'c1', user: { login: 'attacker' }, created_at: '-', body: `x <!-- ai-review-approval:${JSON.stringify(mkLocal())} -->` };
  const lctx = { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: 'v1', localApprovers: ['duongpdddic'] };
  tru('C.23 local marker đúng author → nhận diện', Boolean(steadyLocalApproval([goodLocal], lctx)));
  tru('C.23 local marker sai author → KHÔNG nhận diện', !steadyLocalApproval([wrongLocal], lctx));
  eq('C.23 drift khi chỉ có local marker sai author', planApprovalDrift({ labels: [RL.approved], comments: [wrongLocal], gptApprovers: [], localApprovers: ['duongpdddic'] }).drift, true);
  // 6) planPhaseActivation kích hoạt hợp lệ nhưng GPT approval sai author → không kích hoạt.
  const PV = '2026-08-23.7';
  const MERGE = 'c'.repeat(40);
  const HEAD = 'd'.repeat(40);
  const WPR = 'duongpdddic-droid/AI_PR_REVIEWER#4';
  const actMarker = (o = {}) => `<!-- ai-review-phase-activation:${JSON.stringify({ phase: 'steady-state', wiringPr: WPR, wiringMergedSha: MERGE, gptApprovedHeadSha: HEAD, recordedBy: 'duongpdddic-droid', recordedAt: '2026-08-23T01:00:00Z', ...o })} -->`;
  const actComment = (body, login = 'duongpdddic-droid') => ({ id: '1', user: { login }, created_at: '2026-08-23T01:00:00Z', body });
  const gptApproval = buildApprovalMarker({ repository: 'duongpdddic-droid/AI_PR_REVIEWER', prNumber: 4, reviewer: RA.gpt, headSha: HEAD, policyVersion: PV, decisionId: 'gpt-wiring-001', ciEvidence: null, openBlockingFindings: 0, reviewedAt: '2026-08-23T00:00:00Z' });
  const wiringState = { state: 'closed', merged: true, mergeCommitSha: MERGE, headSha: HEAD };
  const recs = (body, login) => collectActivationRecords([actComment(body, login)]);
  const planAA = (over = {}) => planPhaseActivation({ records: recs(actMarker()), allowedRecorders: ['duongpdddic-droid'], expectedWiringPr: { repo: 'duongpdddic-droid/AI_PR_REVIEWER', number: 4 }, wiringState, wiringApprovalRecords: [{ id: 'w1', user: { login: 'attacker' }, created_at: '2026-08-23T00:00:00Z', body: gptApproval }], policyVersion: PV, gptApprovers: ['duongpdddic-droid'], ...over });
  eq('C.23 activation hợp lệ nhưng GPT approval sai author → inactive', planAA({}).active, false);
  const planAAok = planPhaseActivation({ records: recs(actMarker()), allowedRecorders: ['duongpdddic-droid'], expectedWiringPr: { repo: 'duongpdddic-droid/AI_PR_REVIEWER', number: 4 }, wiringState, wiringApprovalRecords: [{ id: 'w1', user: { login: 'duongpdddic-droid' }, created_at: '2026-08-23T00:00:00Z', body: gptApproval }], policyVersion: PV, gptApprovers: ['duongpdddic-droid'] });
  eq('C.23 activation + GPT approval đúng author → active', planAAok.active, true);
  // 7) Chỉ marker đúng author + repo + PR + HEAD + policyVersion mới hợp lệ.
  const good = { id: 'g', user: { login: 'duongpdddic-droid' }, created_at: '-', body: `x ${mkGpt()}` };
  const wrongAuthor = { id: 'w', user: { login: 'attacker' }, created_at: '-', body: `x ${mkGpt()}` };
  const wrongHead = { id: 'h', user: { login: 'duongpdddic-droid' }, created_at: '-', body: `x ${mkGpt({ headSha: 'b'.repeat(40) })}` };
  const best = effectiveApproval([good, wrongAuthor, wrongHead], { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: 'v1', gptApprovers: ALLOW });
  eq('C.23 chỉ marker đúng author + HEAD hợp lệ được chọn', Boolean(best) && best.decisionId === 'dec-1' && best.headSha === SHA, true);
}

// --- C.24 [Issue #22] HEAD-Lock Lifecycle & Handoff Gate ---
{
  const REPO = 'o/r';
  const PRN = 7;
  const PV = 'v1';
  const headA = SHA;            // 'a'*40
  const headB = SHA2;           // 'b'*40 — HEAD đổi sau khi lock
  const passComment = (sha, at) => ({ id: `p-${sha.slice(0, 4)}`, user: { login: 'duongpdddic-droid' }, created_at: at, body: `✅ local pre-review PASS\n<!-- ai-pr-reviewer:key=${REPO}::${PRN}::${sha}::${PV}::pre-review:PRE_REVIEW_PASS --> <!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${sha} -->` });
  const gptCom = (sha, at, decisionId = 'gpt-x') => ({ id: `g-${sha.slice(0, 4)}`, user: { login: 'duongpdddic-droid' }, created_at: at, body: `✅ GPT approval\n<!-- ai-review-approval:${JSON.stringify({ repository: REPO, prNumber: PRN, reviewer: RA.gpt, headSha: sha, policyVersion: PV, decisionId, ciEvidence: { state: 'pass' }, openBlockingFindings: 0, reviewedAt: at })} -->` });
  const base = { repository: REPO, prNumber: PRN, policyVersion: PV, gptApprovers: ['duongpdddic-droid'], localApprovers: ['duongpdddic-droid'] };

  // (e) valid frozen HEAD — review-requested+agent:gpt, HEAD khớp lock PASS
  {
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z')], headSha: headA, ...base });
    eq('C.24 (e) frozen hợp lệ: HEAD khớp lock → valid, không drift', r.valid === true && r.drift === false && r.frozen === true, true);
  }
  // (a) sau pre-review PASS khóa headA, HEAD đổi headB → drift invalid
  {
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z')], headSha: headB, ...base });
    eq('C.24 (a) drift sau pre-review: HEAD đổi → invalid + drift', r.valid === false && r.drift === true && r.lockSha === headA, true);
  }
  // (b) sau approval khóa headA, HEAD đổi headB → drift invalid
  {
    const r = planHeadLock({ labels: [RL.approved], comments: [gptCom(headA, '2026-08-23T00:00:00Z')], headSha: headB, ...base });
    eq('C.24 (b) drift sau approval: HEAD đổi → invalid + drift, lockSha = SHA approval', r.valid === false && r.drift === true && r.lockSha === headA, true);
  }
  // (b2) approved + HEAD khớp approval → valid
  {
    const r = planHeadLock({ labels: [RL.approved], comments: [gptCom(headA, '2026-08-23T00:00:00Z')], headSha: headA, ...base });
    eq('C.24 (b2) approved + HEAD khớp approval → valid, không drift', r.valid === true && r.drift === false, true);
  }
  // (c) Memory Bank-only commit: HEAD KHÔNG đổi (marker PASS khóa headA, HEAD vẫn headA) → valid
  {
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z'), { id: 'mb', user: { login: 'duongpdddic-droid' }, created_at: '2026-08-23T01:00:00Z', body: '📝 Memory Bank update (không đổi code)' }], headSha: headA, ...base });
    eq('C.24 (c) Memory Bank-only commit (HEAD ko đổi) → vẫn valid', r.valid === true && r.drift === false, true);
  }
  // (d) `reviewing` KHÔNG frozen: trạng thái tạm chính orchestrator đặt ngay trước pre-review,
  // sẽ tự ghi PASS marker mới cho HEAD hiện tại trong cùng vòng → không bị gate drift.
  {
    const r = planHeadLock({ labels: [RL.reviewing], comments: [passComment(headA, '2026-08-23T00:00:00Z')], headSha: headB, ...base });
    eq('C.24 (d) reviewing (trạng thái tạm của orchestrator) → frozen=false, không gate', r.frozen === false, true);
  }
  // non-frozen: review-requested + agent:cline (mới, chưa pre-review) → KHÔNG bị gate
  {
    const r = planHeadLock({ labels: [RL.reviewRequested, 'agent:cline'], comments: [], headSha: headB, ...base });
    eq('C.24 non-frozen: review-requested+cline chưa pre-review → frozen=false', r.frozen === false, true);
  }
  // non-frozen: changes-requested + agent:cline (vòng fix Cline) với marker cũ → KHÔNG bị gate
  {
    const r = planHeadLock({ labels: [RL.changesRequested, 'agent:cline'], comments: [passComment(headA, '2026-08-23T00:00:00Z')], headSha: headB, ...base });
    eq('C.24 non-frozen: changes-requested+cline (vòng fix) → frozen=false', r.frozen === false, true);
  }
  // fail-closed: frozen (review-requested+agent:gpt) nhưng KHÔNG có bằng chứng PASS/approval → drift
  {
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [{ id: 'x', user: { login: 'bot' }, created_at: '-', body: 'plain text' }], headSha: headA, ...base });
    eq('C.24 fail-closed: frozen mà thiếu bằng chứng khóa HEAD → invalid + drift', r.valid === false && r.drift === true && r.lockSha === null, true);
  }
}

// C.26 [GPT-REV-CHANGES-01] Lock = bằng chứng (PASS | approval) MỚI NHẤT theo createdAt;
// PASS canonical bắt buộc provenance + authorized author + key khớp.
{
  const REPO = 'o/r', PRN = 7, PV = 'v1';
  const headA = SHA, headB = SHA2;
  const passC = (sha, at) => ({ id: `p2-${sha.slice(0, 4)}`, user: { login: 'duongpdddic-droid' }, created_at: at, body: `✅ PASS\n<!-- ai-pr-reviewer:key=${REPO}::${PRN}::${sha}::${PV}::pre-review:PRE_REVIEW_PASS --> <!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${sha} -->` });
  const gptC = (sha, at) => ({ id: `g2-${sha.slice(0, 4)}`, user: { login: 'duongpdddic-droid' }, created_at: at, body: `x <!-- ai-review-approval:${JSON.stringify({ repository: REPO, prNumber: PRN, reviewer: RA.gpt, headSha: sha, policyVersion: PV, decisionId: 'g2', ciEvidence: { state: 'pass' }, openBlockingFindings: 0, reviewedAt: at })} -->` });
  const base2 = { repository: REPO, prNumber: PRN, policyVersion: PV, gptApprovers: ['duongpdddic-droid'], localApprovers: ['duongpdddic-droid'] };

  // approval cũ khóa A → unfreeze → push B → PASS(B) mới → lock phải là PASS(B), handoff B hợp lệ
  {
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [gptC(headA, '2026-08-23T00:00:00Z'), passC(headB, '2026-08-23T02:00:00Z')], headSha: headB, ...base2 });
    eq('C.26 lock mới nhất theo createdAt: PASS(B) sau approval(A) → lock=B, HEAD B hợp lệ', r.valid === true && r.drift === false && r.frozen === true && r.lockSha === headB, true);
  }
  // ngược lại: PASS(A) cũ, approval(B) mới hơn → lock=approval(B)
  {
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [passC(headA, '2026-08-23T00:00:00Z'), gptC(headB, '2026-08-23T02:00:00Z')], headSha: headB, ...base2 });
    eq('C.26 lock mới nhất: approval(B) sau PASS(A) → lock=B, HEAD B hợp lệ', r.valid === true && r.drift === false && r.lockSha === headB, true);
  }
  // PASS không có key → không canonical → fail-closed (thiếu bằng chứng khóa HEAD)
  {
    const noKey = { id: 'n1', user: { login: 'duongpdddic-droid' }, created_at: '2026-08-23T01:00:00Z', body: `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headA} -->` };
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [noKey], headSha: headA, ...base2 });
    eq('C.26 PASS thiếu key → không canonical → fail-closed', r.valid === false && r.frozen === true && r.lockSha === null, true);
  }
  // PASS author ngoài localApprovers → không canonical → fail-closed
  {
    const badAuthor = { id: 'n2', user: { login: 'attacker' }, created_at: '2026-08-23T01:00:00Z', body: `x ${['<!-- ai-pr-reviewer:key=', REPO, '::', PRN, '::', headA, '::', PV, '::pre-review:PRE_REVIEW_PASS -->'].join('')} <!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headA} -->` };
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [badAuthor], headSha: headA, ...base2 });
    eq('C.26 PASS author ngoài allowlist → không canonical → fail-closed', r.valid === false && r.frozen === true && r.lockSha === null, true);
  }
  // PASS thiếu comment id (provenance) → không canonical → fail-closed
  {
    const noId = { user: { login: 'duongpddcic-droid' }, created_at: '2026-08-23T01:00:00Z', body: `x <!-- ai-pr-reviewer:key=${REPO}::${PRN}::${headA}::${PV}::pre-review:PRE_REVIEW_PASS --> <!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headA} -->` };
    const r = planHeadLock({ labels: [RL.reviewRequested, RA.gpt], comments: [noId], headSha: headA, ...base2 });
    eq('C.26 PASS thiếu comment id → không canonical → fail-closed', r.valid === false && r.frozen === true && r.lockSha === null, true);
  }
}

// parsePreReviewPassShas: bóc tách đúng SHA, bỏ qua marker hỏng
{
  const headA = SHA, headB = SHA2;
  const shas = parsePreReviewPassShas([
    { id: '1', body: `abc\n<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headA} -->` },
    { id: '2', body: `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headB} -->` },
    { id: '3', body: '<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_FAIL:x -->' },
    { id: '4', body: 'plain' },
  ]);
  eq('C.24 parsePreReviewPassShas trích đủ SHA hợp lệ (thứ tự ASC)', shas.length === 2 && shas[0].sha === headA && shas[1].sha === headB, true);
  eq('C.24 parsePreReviewPassShas SHA lowercase chuẩn', shas[1].sha === headB, true);
}

// latestApprovalShaAnyHead: trả SHA approval MỚI NHẤT cho bất kỳ HEAD nào (bắt drift), bỏ qua author sai
{
  const REPO = 'o/r', PRN = 7, PV = 'v1';
  const headA = SHA, headB = SHA2;
  const mkG = (sha, at, decisionId, login = 'duongpdddic-droid') => ({ id: decisionId, user: { login }, created_at: at, body: `x <!-- ai-review-approval:${JSON.stringify({ repository: REPO, prNumber: PRN, reviewer: RA.gpt, headSha: sha, policyVersion: PV, decisionId, ciEvidence: { state: 'pass' }, openBlockingFindings: 0, reviewedAt: at })} -->` });
  const base = { repository: REPO, prNumber: PRN, policyVersion: PV, gptApprovers: ['duongpdddic-droid'], localApprovers: [] };
  const good = mkG(headA, '2026-08-23T00:00:00Z', 'g-1');
  const newer = mkG(headB, '2026-08-23T02:00:00Z', 'g-2');
  const badAuthor = mkG(headB, '2026-08-23T03:00:00Z', 'g-3', 'attacker');
  eq('C.24 latestApprovalShaAnyHead chọn approval mới nhất (không lọc HEAD)', latestApprovalShaAnyHead([good, newer], base).sha === headB, true);
  eq('C.24 latestApprovalShaAnyHead bỏ qua author ngoài allowlist', latestApprovalShaAnyHead([good, badAuthor], base).sha === headA, true);
  eq('C.24 latestApprovalShaAnyHead rỗng → null', latestApprovalShaAnyHead([], base) === null, true);
}

// parseUnfreezeMarkers + isUnfrozenAfter (Issue #22 unfreeze gate)
{
  const lockAt = '2026-08-23T00:00:00Z';
  const OW = ['duongpdddic-droid'];
  const uf = (reason, at, login = 'duongpdddic-droid') => ({ id: `u-${at}`, user: { login }, created_at: at, body: `🔓 user push override\n<!-- ai-pr-reviewer:unfreeze:reason=${reason} -->` });
  const parsed = parseUnfreezeMarkers([
    uf('fix CI typing', '2026-08-23T01:00:00Z'),
    { id: 'bad', created_at: '-', body: '<!-- ai-pr-reviewer:unfreeze -->' },
    { id: 'plain', created_at: '-', body: 'plain text' },
  ]);
  eq('C.24 parseUnfreezeMarkers trích reason + bỏ qua marker hỏng', parsed.length === 1 && parsed[0].reason === 'fix CI typing', true);
  eq('C.24 isUnfrozenAfter: unfreeze mới hơn lock + authorized → true',
    isUnfrozenAfter([uf('r', '2026-08-23T02:00:00Z')], lockAt, { authorizedLogins: OW }), true);
  eq('C.24 isUnfrozenAfter: unfreeze cũ hơn lock → false',
    isUnfrozenAfter([uf('r', '2026-08-22T00:00:00Z')], lockAt, { authorizedLogins: OW }), false);
  eq('C.24 isUnfrozenAfter: không có unfreeze → false',
    isUnfrozenAfter([{ id: 'x', created_at: '2026-08-23T02:00:00Z', user: { login: 'duongpdddic-droid' }, body: 'plain' }], lockAt, { authorizedLogins: OW }), false);
  eq('C.24 isUnfrozenAfter: author KHÔNG có quyền → false',
    isUnfrozenAfter([uf('r', '2026-08-23T02:00:00Z', 'attacker')], lockAt, { authorizedLogins: OW }), false);
  eq('C.24 isUnfrozenAfter: thiếu authorizedLogins (rỗng) → false (fail-closed)',
    isUnfrozenAfter([uf('r', '2026-08-23T02:00:00Z')], lockAt), false);
  eq('C.24 isUnfrozenAfter: marker thiếu author → false (fail-closed)',
    isUnfrozenAfter([{ id: 'u', created_at: '2026-08-23T02:00:00Z', body: '<!-- ai-pr-reviewer:unfreeze:reason=z -->' }], lockAt, { authorizedLogins: OW }), false);
}

let fail = 0;
// C.25 decidePrePushGuard — LOCAL pre-push HEAD-Lock guard (Issue #22)
{
  const REPO = 'o/r', PRN = 7, PV = 'v1';
  const headA = SHA, headB = SHA2;
  const OW = ['duongpdddic-droid'];
  const passComment = (sha, at) => ({ id: `p-${sha.slice(0, 4)}`, user: { login: 'duongpdddic-droid' }, created_at: at, body: `✅ local pre-review PASS\n<!-- ai-pr-reviewer:key=${REPO}::${PRN}::${sha}::${PV}::pre-review:PRE_REVIEW_PASS --> <!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${sha} -->` });
  const gptCom = (sha, at) => ({ id: `g-${sha.slice(0, 4)}`, user: { login: 'duongpdddic-droid' }, created_at: at, body: `x <!-- ai-review-approval:${JSON.stringify({ repository: REPO, prNumber: PRN, reviewer: RA.gpt, headSha: sha, policyVersion: PV, decisionId: 'g', ciEvidence: { state: 'pass' }, openBlockingFindings: 0, reviewedAt: at })} -->` });
  const uf = (at, login = 'duongpdddic-droid') => ({ id: `u-${at}`, user: { login }, created_at: at, body: `<!-- ai-pr-reviewer:unfreeze:reason=sửa tiếp -->` });
  const prBase = { number: PRN, repository: REPO, gptApprovers: ['duongpdddic-droid'], localApprovers: ['duongpdddic-droid'], policyVersion: PV };

  // không có PR open cho branch → allow
  eq('C.25 không có PR open → allow', decidePrePushGuard({ branch: 'feat/x', headSha: headA, pr: null, authorizedLogins: OW }).decision === 'allow', true);
  // không xác định được branch → allow (bỏ qua, không liên quan guard)
  eq('C.25 thiếu branch → allow', decidePrePushGuard({ headSha: headA }).decision === 'allow', true);
  // chưa frozen (review-requested + cline, chưa pre-review) → allow
  eq('C.25 chưa frozen → allow', decidePrePushGuard({ branch: 'feat/x', headSha: headB, pr: { ...prBase, state: 'open', labels: [RL.reviewRequested, 'agent:cline'], comments: [] }, authorizedLogins: OW }).decision === 'allow', true);
  // uncommitted Memory Bank: HEAD = lock PASS (không commit → HEAD không đổi) → allow
// unfreeze hợp lệ (reason + mới hơn lock + authorized author) → allow push override
  eq('C.25 unfreeze hợp lệ → allow push override', decidePrePushGuard({ branch: 'feat/x', headSha: headB, pr: { ...prBase, state: 'open', labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z'), uf('2026-08-23T02:00:00Z')] }, authorizedLogins: OW }).decision === 'allow', true);
  // unfreeze của user KHÔNG có quyền → vẫn BLOCK
  eq('C.25 unfreeze từ author không có quyền → BLOCK', decidePrePushGuard({ branch: 'feat/x', headSha: headB, pr: { ...prBase, state: 'open', labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z'), uf('2026-08-23T02:00:00Z', 'attacker')] }, authorizedLogins: OW }).decision === 'block', true);
  // unfreeze marker cũ hơn lock → BLOCK
  eq('C.25 unfreeze cũ hơn lock → BLOCK', decidePrePushGuard({ branch: 'feat/x', headSha: headB, pr: { ...prBase, state: 'open', labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z'), uf('2026-08-22T00:00:00Z')] }, authorizedLogins: OW }).decision === 'block', true);
  // không đọc được trạng thái PR đã biết tồn tại → BLOCK (fail-closed)
  eq('C.25 không đọc được trạng thái PR → BLOCK (fail-closed)', decidePrePushGuard({ branch: 'feat/x', headSha: headB, pr: { number: PRN, failed: true }, authorizedLogins: OW }).decision === 'block', true);
  eq('C.25 uncommitted Memory Bank (HEAD ko đổi) → allow', decidePrePushGuard({ branch: 'feat/x', headSha: headA, pr: { ...prBase, state: 'open', labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z')] }, authorizedLogins: OW }).decision === 'allow', true);
  // commit code → HEAD đổi (headB) so lock PASS headA → BLOCK
  eq('C.25 committed code → HEAD drift → BLOCK', decidePrePushGuard({ branch: 'feat/x', headSha: headB, pr: { ...prBase, state: 'open', labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z')] }, authorizedLogins: OW }).decision === 'block', true);
  // committed docs/Memory Bank —commit làm HEAD đổi, không phân biệt loại file → BLOCK
  eq('C.25 committed docs/Memory Bank (HEAD đổi) → BLOCK', decidePrePushGuard({ branch: 'feat/x', headSha: headB, pr: { ...prBase, state: 'open', labels: [RL.reviewRequested, RA.gpt], comments: [passComment(headA, '2026-08-23T00:00:00Z')] }, authorizedLogins: OW }).decision === 'block', true);
  // drift sau approval → BLOCK
  eq('C.25 drift sau approval → BLOCK', decidePrePushGuard({ branch: 'feat/x', headSha: headB, pr: { ...prBase, state: 'open', labels: [RL.approved], comments: [gptCom(headA, '2026-08-23T00:00:00Z')] }, authorizedLogins: OW }).decision === 'block', true);
}
console.log('\n=== TEST PURE LOGIC ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);
