#!/usr/bin/env node
// test-review-phases.mjs — [GPT-REV-035]: chứng minh mô hình reviewer hai giai đoạn trong policy.
// Kiểm tra thuần dữ liệu contract (không phụ thuộc orchestrator upstream):
//   P1 transition: local reviewer KHÔNG thể approve hai PR triển khai Issue #2 (GPT duyệt cuối).
//   P2 steadyState: local chỉ approve khi ĐỦ toàn bộ approvalRequiresAllGates.
//   P3 escalation/thiếu bằng chứng/rủi ro → fail-closed chuyển GPT/user; gate fail-closed còn nguyên.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'ai-review-policy.json'), 'utf8'));

let pass = 0;
let total = 0;
function check(name, ok, detail = '') {
  total++;
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const phases = policy.reviewerPhases || {};
const transition = (phases.phases && phases.phases.transition) || {};
const steady = (phases.phases && phases.phases.steadyState) || {};
const REQUIRED_GATES = [
  'requiredChecksAllPassed',
  'realSemanticReviewCompleted',
  'approvalLockedToHeadShaAndPolicyVersion',
  'noOpenBlockingFindings',
  'policyValid',
  'readAfterWriteSucceeded',
];
const REQUIRED_ESCALATIONS = [
  'userExplicitRequest',
  'statusBlockedOrDecisionGate',
  'highRiskPrPerPolicy',
  'insufficientEvidenceOrConflictOrReviewLimitExceededOrApprovalSuspicion',
  'postAuditOrQualitySampling',
];

console.log('P0 — Policy hợp lệ và khai báo đủ khung hai giai đoạn');
check('validatePolicy cơ bản: policyVersion/requiredChecks/finalReviewer/maxReviewRounds tồn tại',
  typeof policy.policyVersion === 'string' && policy.policyVersion.length > 0
  && Array.isArray(policy.requiredChecks) && policy.requiredChecks.length > 0
  && policy.finalReviewer === 'agent:gpt'
  && Number.isInteger(policy.maxReviewRounds) && policy.maxReviewRounds >= 1);
check('reviewerPhases.currentPhase = "transition"', phases.currentPhase === 'transition');
check('requiredChecks đúng check-run thật "Verify code and data"',
  policy.requiredChecks.includes('verify'));

console.log('P1 — Transition: local không thể approve hai PR triển khai Issue #2');
check('transition.finalReviewer = agent:gpt', transition.finalReviewer === 'agent:gpt');
check('transition.localReviewerCanApprove = false', transition.localReviewerCanApprove === false,
  'nếu true thì reviewer:local có thể tự chứng nhận thay đổi kiến trúc reviewer của chính nó');

console.log('P2 — Steady state: local chỉ approve khi đủ toàn bộ gate');
check('steadyState.defaultReviewer = reviewer:local', steady.defaultReviewer === 'reviewer:local');
check('steadyState.localReviewerCanApprove = true', steady.localReviewerCanApprove === true);
check('steadyState.gptReReviewsEveryPr = false', steady.gptReReviewsEveryPr === false);
check('approvalRequiresAllGates chứa đủ 6 gate USER-DECISION',
  REQUIRED_GATES.every((g) => (steady.approvalRequiresAllGates || []).includes(g)),
  'thiếu: ' + REQUIRED_GATES.filter((g) => !(steady.approvalRequiresAllGates || []).includes(g)).join(', '));
check('escalateToGptWhen chứa đủ 5 trường hợp USER-DECISION',
  REQUIRED_ESCALATIONS.every((e) => (steady.escalateToGptWhen || []).includes(e)),
  'thiếu: ' + REQUIRED_ESCALATIONS.filter((e) => !(steady.escalateToGptWhen || []).includes(e)).join(', '));

console.log('P3 — Escalation/rủi ro/thiếu bằng chứng vẫn fail-closed; gate bất biến còn nguyên');
check('escalationBehavior khai báo fail-closed → GPT/status:blocked, user quyết merge/deploy',
  /fail-closed/i.test(steady.escalationBehavior || '')
  && /status:blocked/.test(steady.escalationBehavior || '')
  && /người dùng|nguoi dung/i.test(steady.escalationBehavior || ''));
check('invariantsAllPhases khai báo đủ các gate bất biến mọi pha',
  ['ciPassNeverApproves', 'emptyChecksFailClosed', 'approvalLockedToFullHeadShaAndPolicyVersion',
    'headChangeInvalidatesApproval', 'openCriticalOrImportantFindingBlocksApproval',
    'draftClosedMergedOrLateEventNeverApproved', 'userAlwaysDecidesMergeAndDeploy']
    .every((i) => (phases.invariantsAllPhases || []).includes(i)));
check('blockingSeverities vẫn gồm critical + important',
  policy.blockingSeverities.includes('critical') && policy.blockingSeverities.includes('important'));
check('approvalMarker khóa full 40-hex HEAD SHA + vô hiệu khi HEAD đổi',
  policy.approvalMarker.shaLock === 'full-40-hex-head-sha'
  && policy.approvalMarker.invalidationOnHeadChange === true
  && ['repository', 'prNumber', 'reviewer', 'headSha', 'policyVersion'].every(
    (f) => policy.approvalMarker.requiredFields.includes(f)));
check('rules fail-closed: ciPassNeverApproves + emptyChecksFailClosed',
  policy.rules.ciPassNeverApproves === true && policy.rules.emptyChecksFailClosed === true);
check('merge/deploy luôn thuộc người dùng', policy.authority.merge === 'user' && policy.authority.deploy === 'user');
check('late event: stale theo SHA bị bỏ qua, PR đóng cấm mutation',
  policy.lateEventBehavior.staleByHeadSha === true && policy.lateEventBehavior.closedPrMutation === 'forbidden');

// ---------------- [GPT-REV-036] Reviewer <-> Coder contract ----------------
console.log('P4 — Reviewer <-> Coder contract (finding required fields + verdicts + rebuttal + fail-closed dispute)');
const contract = policy.reviewerCoderContract || {};
const REQ_FIELDS = ['code', 'severity', 'evidence', 'risk', 'expectedOutcome'];
check('reviewerCoderContract.findingRequiredFields đủ 5 trường bắt buộc',
  REQ_FIELDS.every((f) => (contract.findingRequiredFields || []).includes(f)),
  'thiếu: ' + REQ_FIELDS.filter((f) => !(contract.findingRequiredFields || []).includes(f)).join(', '));
check('coderVerdicts chỉ CLINE-FIX / CLINE-REBUT',
  (contract.coderVerdicts || []).includes('CLINE-FIX-NNN')
  && (contract.coderVerdicts || []).includes('CLINE-REBUT-NNN'));
check('reviewerRebuttalVerdicts chỉ ACCEPTED / REJECTED',
  (contract.reviewerRebuttalVerdicts || []).includes('ACCEPTED')
  && (contract.reviewerRebuttalVerdicts || []).includes('REJECTED'));
check('coderSelfResolveForbidden = true (coder không tự resolve thread khi chưa bằng chứng)',
  contract.coderSelfResolveForbidden === true);
check('unresolvedDisputeBehavior fail-closed → GPT hoặc status:blocked; coder không tự quyết',
  /fail-closed/.test(contract.unresolvedDisputeBehavior || '')
  && /(agent:gpt|status:blocked)/.test(contract.unresolvedDisputeBehavior || '')
  && /coder/i.test(contract.unresolvedDisputeBehavior || ''));

// ---------------- [GPT-REV-037] Minimal command + task discovery fail-closed ----------------
console.log('P5 — Lệnh tối thiểu + task discovery fail-closed (zero/one/many + stale checkpoint)');
const disc = policy.minimalCommandDiscovery || {};
const cmds = (disc.minimalCommands || []);
const xuLyTiep = cmds.find((c) => c.text === 'Xử lý tiếp.');
check('minimalCommands chứa "Xử lý tiếp."',
  Boolean(xuLyTiep), 'thiếu lệnh "Xử lý tiếp."');
check('"Xử lý tiếp." có alias tương đương "Thực thi tiếp."',
  Boolean(xuLyTiep) && Array.isArray(xuLyTiep.aliases) && xuLyTiep.aliases.includes('Thực thi tiếp.')
  && xuLyTiep.equivalentTo === 'discover-and-resume');
check('discoveryOrder: repo/origin -> Memory Bank -> GitHub',
  Array.isArray(disc.discoveryOrder)
  && disc.discoveryOrder.includes('git-repo-origin-and-worktree-state')
  && disc.discoveryOrder.includes('memory-bank-activeContext-progress')
  && disc.discoveryOrder.includes('github-issue-pr-head-ci-findings'));
check('zeroTaskBehavior → NO_TASK, không mutation',
  (disc.zeroTaskBehavior || {}).result === 'NO_TASK' && (disc.zeroTaskBehavior || {}).mutationAllowed === false);
check('oneTaskBehavior → claim-exactly-one',
  (disc.oneTaskBehavior || {}).result === 'claim-exactly-one');
check('manyOrConflictingTaskBehavior → blocked-no-guessing, không mutation',
  (disc.manyOrConflictingTaskBehavior || {}).result === 'blocked-no-guessing'
  && (disc.manyOrConflictingTaskBehavior || {}).mutationAllowed === false);
check('scope.appliesTo chứa cả 2 repo (QLDA + AI_PR_REVIEWER) để cross-repo reconcile',
  (policy.scope.appliesTo || []).includes('duongpdddic-droid/AI_PR_REVIEWER')
  && (policy.scope.appliesTo || []).includes('duongpdddic-droid/QLDA_DTXD'));

console.log(`\ntest-review-phases: ${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
