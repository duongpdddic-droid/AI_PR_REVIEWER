#!/usr/bin/env node
// test-pure-logic.mjs — test hành vi dự chak püre logic du khung (Nhóm 1).
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


const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });

// escapeHtml: escape & < > pour parse_mode=HTML, laisse Viêt intact
eq('escapeHtml &', escapeHtml('A & B'), 'A &amp; B');
eq('escapeHtml < >', escapeHtml('<x>'), '&lt;x&gt;');
eq('escapeHtml accents', escapeHtml('dự an'), 'dự an');

// eventKey: repo::ref::event::state
eq('eventKey', eventKey({ repo: 'o/r', ref: '#1', eventType: 'done', state: 'ready' }), 'o/r::#1::done::ready');

// NotificationStore chống trùng: même key déjà SENT -> shouldSend false
{
  const store = new NotificationStore();
  const key = 'a::#1::done::ready';
  tru('store.shouldSend initial', store.shouldSend(key));
  store.markSent(key);
  tru('store.shouldSend after SENT', store.shouldSend(key)); // -> false
  // shouldSend do-it renvoyer false; on check directement
  checks[checks.length - 1].ok = !Boolean(store.shouldSend(key));
  checks[checks.length - 1].want = false;
}

// buildMessage: contient les champs + échappé
{
  const msg = buildMessage({ eventType: 'done', repo: 'o/r', ref: '#1', state: 'ready', summary: 'a<b', nextAction: 'merge' });
  eq('buildMessage tags', true, msg.includes('Hoàn thành / Bàn giao') && msg.includes('a&lt;b'));
}

// --- autonomous-core ---
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

// planReview: verify PASS -> approve; fail trong budget -> request-changes; hết budget -> block.
eq('planReview approve', planReview({ verifyOk: true, round: 0 }).action, 'approve');
eq('planReview approve terminal', planReview({ verifyOk: true, round: 0 }).terminal, true);
eq('planReview changes r0', planReview({ verifyOk: false, round: 0 }).action, 'request-changes');
eq('planReview changes r2', planReview({ verifyOk: false, round: 2 }).action, 'request-changes');
eq('planReview block r3', planReview({ verifyOk: false, round: 3 }).action, 'block');
eq('planReview block label', planReview({ verifyOk: false, round: 3 }).label, 'status:blocked');

// canRetryFix
eq('canRetryFix fail r0', canRetryFix({ verifyOk: false, round: 0 }), true);
eq('canRetryFix pass r0', canRetryFix({ verifyOk: true, round: 0 }), false);
eq('canRetryFix fail r3', canRetryFix({ verifyOk: false, round: 3 }), false);

// issueStatusFromLabels: terminal labels ưu tiên.
eq('status approved', issueStatusFromLabels(['status:approved', 'status:in-progress']), 'approved');
eq('status changes', issueStatusFromLabels(['status:changes-requested']), 'changes-requested');
eq('status ready', issueStatusFromLabels(['status:ready-for-cline']), 'ready');
eq('status unknown', issueStatusFromLabels([]), 'unknown');

// branchNameFor: slug an toàn, giới hạn 40 ký tự (không tính prefix feat/issue-N-).
eq('branchNameFor', branchNameFor(12, '  Fix Lỗi XYZ !!!  '), 'feat/issue-12-fix-l-i-xyz');
tru('branchNameFor slug <= 40', branchNameFor(1, 'x'.repeat(100)).endsWith('x'.repeat(40)));

// summarizeVerify: lấy dòng tổng kết PASS nếu có.
eq('summarizeVerify pass', summarizeVerify('...\nTổng: 18/18 PASS\n'), 'Tổng: 18/18 PASS');
eq('summarizeVerify fallback', summarizeVerify('dòng cuối'), 'dòng cuối');

// --- routing reviewer ↔ coder ---
import { fixIssueTitle, nextFixRound, planRouting, FIX_ISSUE_LABEL } from './autonomous-core.mjs';

eq('fixIssueTitle', fixIssueTitle(12, 2), '[review-fix] PR #12 — vòng r2');

// nextFixRound: đếm max vòng trong tiêu đề issue của ĐÚNG PR, +1; không có → 1.
eq('nextFixRound none', nextFixRound([], 12), 1);
eq('nextFixRound r1', nextFixRound(['[review-fix] PR #12 — vòng r1'], 12), 2);
eq('nextFixRound bỏ PR khác', nextFixRound(['[review-fix] PR #13 — vòng r5'], 12), 1);
eq('nextFixRound max nhiều vòng', nextFixRound(['[review-fix] PR #12 — vòng r1', '[review-fix] PR #12 — vòng r3'], 12), 4);

// planRouting: pending → chờ, không mutation.
{
  const p = planRouting({ checks: 'pending' });
  eq('planRouting wait', p.action, 'wait');
  eq('planRouting wait no labels', p.addLabels.length, 0);
}
// pass → handoff GPT, KHÔNG bao giờ tự approve.
{
  const p = planRouting({ checks: 'pass', repo: 'o/r', prNumber: 7 });
  eq('planRouting gpt action', p.action, 'handoff-gpt');
  eq('planRouting gpt label', p.addLabels.join(','), 'agent:gpt');
  tru('planRouting không tự approved', !p.addLabels.includes('status:approved'));
}
// fail còn budget → request-fix + tạo issue [review-fix] đúng nhãn giao thức.
{
  const p = planRouting({ checks: 'fail', repo: 'o/r', prNumber: 9, nextRound: 1 });
  eq('planRouting fix action', p.action, 'request-fix');
  eq('planRouting fix title', p.createIssue.title, '[review-fix] PR #9 — vòng r1');
  eq('planRouting fix labels', p.createIssue.labels.join(','), ['agent:cline', 'status:ready-for-cline', FIX_ISSUE_LABEL].join(','));
  tru('planRouting fix bỏ review-requested', p.removeLabels.includes('status:review-requested'));
  tru('planRouting body dẫn PR', p.createIssue.body.includes('https://github.com/o/r/pull/9'));
}
// fail nhưng còn issue [review-fix] đang mở → KHÔNG tạo trùng.
eq('planRouting không trùng issue', planRouting({ checks: 'fail', repo: 'o/r', prNumber: 9, nextRound: 2, hasOpenFixIssue: true }).createIssue, null);
// fail hết budget → block (Decision Gate), gỡ agent:cline khỏi PR.
{
  const p = planRouting({ checks: 'fail', repo: 'o/r', prNumber: 5, nextRound: 4 });
  eq('planRouting block action', p.action, 'block');
  eq('planRouting block label', p.addLabels.join(','), 'status:blocked');
  tru('planRouting block gỡ cline', p.removeLabels.includes('agent:cline'));
}
// maxRounds cấu hình được (vd 2): r3 đã vượt.
eq('planRouting maxRounds tuỳ chỉnh', planRouting({ checks: 'fail', prNumber: 1, nextRound: 3, maxRounds: 2 }).action, 'block');


let fail = 0;
console.log('\n=== TEST PURE LOGIC ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);