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
  const comment = `✅ ok\n<!-- ai-review-approval:${JSON.stringify(payload)} -->`;
  const ctx = { headSha: SHA, repository: 'o/r', prNumber: 7, policyVersion: 'v1' };
  tru('C.19 local approval hợp lệ được nhận diện', Boolean(steadyLocalApproval([comment], ctx)));
  tru('C.19 sai HEAD → không nhận diện', !steadyLocalApproval([comment], { ...ctx, headSha: 'b'.repeat(40) }));
  tru('C.19 sai policyVersion → không nhận diện', !steadyLocalApproval([comment], { ...ctx, policyVersion: 'v2' }));
  tru('C.19 reviewer:gpt marker KHÔNG bị coi là local approval',
    !steadyLocalApproval([`<!-- ai-review-approval:${JSON.stringify({ ...payload, reviewer: RA.gpt })} -->`], ctx));
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
    wiringState, wiringApprovalRecords: [gptApproval], policyVersion: PV, ...over,
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
}

let fail = 0;
console.log('\n=== TEST PURE LOGIC ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);
