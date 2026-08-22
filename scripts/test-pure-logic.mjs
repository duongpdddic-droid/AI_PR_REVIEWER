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
  countReviewRounds, gateOpenFindings, scanDiffForSecrets, evaluateDiffLimits,
  validateApprovalPayload,
} from './review-contract.mjs';
import { runSemanticPreReview } from './unified-orchestrator.mjs';
import { withRetry } from './tg-notify-core.mjs';

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
  const recs = parseApprovalMarkers([`nội dung thường ${marker} đuôi`]);
  eq('C.4 parse 1 record', recs.length, 1);
  eq('C.4 parse sha', recs[0].headSha, SHA);
  eq('C.4 valid cùng SHA', isApprovalValid(recs[0], { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: policy.policyVersion }).valid, true);
  eq('C.4 invalid khác SHA', isApprovalValid(recs[0], { headSha: SHA2, repository: 'o/r', prNumber: 7 }).valid, false);
  tru('C.4 invalid nêu lý do HEAD', String(isApprovalValid(recs[0], { headSha: SHA2 }).reason).includes('HEAD'));
  eq('C.4 invalid khác reviewer', isApprovalValid({ ...recs[0], reviewer: 'agent:cline' }, { headSha: SHA }).valid, false);
  eq('C.4 invalid policy lệch', isApprovalValid(recs[0], { headSha: SHA, policyVersion: 'khác' }).valid, false);
  eq('C.4 invalid còn blocking', isApprovalValid({ ...recs[0], openBlockingFindings: 2 }, { headSha: SHA }).valid, false);
  eq('C.4 invalid thiếu decisionId', isApprovalValid({ ...recs[0], decisionId: '' }, { headSha: SHA }).valid, false);
  eq('C.4 marker hỏng bỏ qua', parseApprovalMarkers(['<!-- ai-review-approval:{hỏng -->']).length, 0);
  const old = buildApprovalMarker({ ...{ repository: 'o/r', prNumber: 7, reviewer: RA.gpt, headSha: SHA, policyVersion: policy.policyVersion, decisionId: 'dec-old', openBlockingFindings: 0 }, reviewedAt: '2026-08-21T00:00:00Z' });
  eq('C.4 effective chọn mới nhất',
    effectiveApproval([old, marker], { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: policy.policyVersion }).reviewedAt,
    '2026-08-22T00:00:00Z');
}

// C.5 approval-drift.
{
  const d = planApprovalDrift({ labels: ['status:approved'], comments: ['comment thường'], headSha: SHA, repository: 'o/r', prNumber: 7 });
  eq('C.5 drift phát hiện', d.drift, true);
  tru('C.5 drift gỡ approved', d.removeLabels.includes('status:approved'));
  tru('C.5 drift thêm review-requested + gpt', d.addLabels.includes('status:review-requested') && d.addLabels.includes('agent:gpt'));
  const marker = buildApprovalMarker({ repository: 'o/r', prNumber: 7, reviewer: RA.gpt, headSha: SHA, policyVersion: policy.policyVersion, decisionId: 'dec-c5', openBlockingFindings: 0, reviewedAt: '2026-08-22T00:00:00Z' });
  eq('C.5 approval hợp lệ → không drift', planApprovalDrift({ labels: ['status:approved'], comments: [marker], headSha: SHA, repository: 'o/r', prNumber: 7 }).drift, false);
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

let fail = 0;
console.log('\n=== TEST PURE LOGIC ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);
