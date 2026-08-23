#!/usr/bin/env node
// review-contract.mjs — Lõi thuần (pure, KHÔNG IO) cho hợp đồng review Issue #2.
//
// Phân tách tuyệt đối: CI verification ≠ semantic review ≠ approval ≠ merge authorization.
// - CI PASS KHÔNG BAO GIỜ sinh approval; chỉ cho phép chuyển status:reviewing.
// - Local reviewer chỉ tạo PRE_REVIEW_PASS | PRE_REVIEW_FINDINGS; không bao giờ status:approved.
// - Approval cuối thuộc GPT (agent:gpt), khóa theo full HEAD SHA + policy version.
// - Required checks rỗng/thiếu/không đọc được → CI_MISSING/CI_UNKNOWN fail-closed.
// Không dependency ngoài (chỉ Node stdlib). Test: scripts/test-pure-logic.mjs
// và scripts/test-integration-orchestrator.mjs.

export const POLICY_PATH = '.github/ai-review-policy.json';

// Nhãn trạng thái workflow canonical (Issue #2 A5/B2).
export const LABELS = {
  queued: 'status:queued',
  readyForCline: 'status:ready-for-cline',
  inProgress: 'status:in-progress',
  reviewRequested: 'status:review-requested',
  reviewing: 'status:reviewing',
  changesRequested: 'status:changes-requested',
  approved: 'status:approved',
  blocked: 'status:blocked',
};

// Vai trò canonical (Issue #2 A5): KHÔNG dùng AI_PR_VIEWER / agent:local-reviewer.
export const AGENTS = {
  cline: 'agent:cline',
  gpt: 'agent:gpt',
};

// Reviewer hỗ trợ (pre-review), không phải agent label.
export const REVIEWER_LOCAL = 'reviewer:local';

// Thứ tự ưu tiên khi một PR/Issue lỡ có nhiều status:* — giữ cái đầu tiên xuất hiện ở đây,
// các status:* còn lại phải bị gỡ (mỗi PR chỉ được có đúng một trạng thái chính).
export const STATUS_PRIORITY = [
  LABELS.blocked,
  LABELS.approved,
  LABELS.changesRequested,
  LABELS.reviewing,
  LABELS.reviewRequested,
  LABELS.inProgress,
  LABELS.readyForCline,
  LABELS.queued,
];

const STATUS_VALUES = new Set(Object.values(LABELS));

// Chuẩn hóa danh sách nhãn về đúng MỘT status:*.
// Trả { keep, remove[], keepStatus }.
export function normalizeStatusLabels(labels) {
  const arr = (Array.isArray(labels) ? labels : []).map((l) => String(l && l.name ? l.name : l));
  const nonStatus = arr.filter((l) => !STATUS_VALUES.has(l));
  const statuses = arr.filter((l) => STATUS_VALUES.has(l));
  let keepStatus = null;
  for (const p of STATUS_PRIORITY) {
    if (statuses.includes(p)) { keepStatus = p; break; }
  }
  const remove = statuses.filter((l) => l !== keepStatus);
  return { keep: [...nonStatus, ...(keepStatus ? [keepStatus] : [])], remove, keepStatus };
}

// ---------------------------------------------------------------- policy

// Kiểm tra shape policy máy đọc được. Trả { ok, error }.
export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') return { ok: false, error: 'policy không phải object' };
  const req = ['policyVersion', 'requiredChecks', 'finalReviewer', 'maxReviewRounds'];
  for (const k of req) {
    if (policy[k] === undefined || policy[k] === null) return { ok: false, error: `thiếu trường ${k}` };
  }
  if (!Array.isArray(policy.requiredChecks)) return { ok: false, error: 'requiredChecks phải là mảng' };
  if (!Number.isInteger(policy.maxReviewRounds) || policy.maxReviewRounds < 1) {
    return { ok: false, error: 'maxReviewRounds phải là số nguyên >= 1' };
  }
  return { ok: true, error: null };
}

// ---------------------------------------------------------------- phân loại CI (fail-closed)

// Phân loại CI của PR so với policy:
//   'pass'    — đủ mọi required check khai báo và tất cả thành công.
//   'pending' — đủ tên nhưng còn check chưa hoàn tất.
//   'fail'    — có required check thất bại.
//   'missing' — policy rỗng HOẶC có required check không tồn tại trên PR (CI_MISSING).
//   'unknown' — không đọc được dữ liệu (policy lỗi/thiếu, checks null) (CI_UNKNOWN).
// Fail-closed: KHÔNG BAO GIỜ trả 'pass' chỉ vì "không có gì fail".
export function evaluateChecks(policy, checksDetail) {
  if (!policy || !validatePolicy(policy).ok) return 'unknown';
  if (!checksDetail || typeof checksDetail !== 'object') return 'unknown';
  const required = policy.requiredChecks.map((c) => String(c).trim()).filter(Boolean);
  if (required.length === 0) return 'missing'; // policy không khai báo check → coi như không có CI
  const byName = new Map();
  for (const c of checksDetail.checks || []) byName.set(c.name, c.state);
  let anyPending = false;
  for (const name of required) {
    const st = byName.get(name);
    if (st === undefined || st === null) return 'missing'; // required check thiếu trên PR
    const s = String(st).toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPING'].includes(s)) continue;
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(s)) return 'fail';
    anyPending = true;
  }
  return anyPending ? 'pending' : 'pass';
}

// ---------------------------------------------------------------- routing (không auto-approve)

// Routing sau khi phân loại CI (Issue #2 A1/A2):
//   pass     → start-semantic-review (status:reviewing) — CHƯA review, CHƯA approve.
//   pending  → wait (không mutation).
//   fail/missing/unknown → request-fix (fail-closed).
// KHÔNG tồn tại action 'approve' ở đây — approval chỉ đến từ GPT (A3).
export function planCiRouting({ ciState } = {}) {
  if (ciState === 'pass') {
    return {
      action: 'start-semantic-review',
      addLabels: [LABELS.reviewing],
      removeLabels: [LABELS.reviewRequested],
      comment: '✅ CI PASS (đủ required checks theo policy) — chuyển `status:reviewing`, chờ semantic pre-review.',
    };
  }
  if (ciState === 'pending') return { action: 'wait', addLabels: [], removeLabels: [] };
  const reasonMap = {
    fail: 'CI FAIL',
    missing: 'CI_MISSING — thiếu required check theo policy',
    unknown: 'CI_UNKNOWN — không đọc được policy/checks (fail-closed)',
  };
  return {
    action: 'request-fix',
    addLabels: [LABELS.changesRequested, AGENTS.cline],
    removeLabels: [LABELS.reviewRequested],
    comment: `❌ ${reasonMap[ciState] || ciState} — fail-closed, trả Cline sửa; sau khi sửa sẽ pre-review lại.`,
  };
}

// Kết quả semantic pre-review của local reviewer (chỉ 2 verdict hợp lệ).
// verdict: 'PRE_REVIEW_PASS' | 'PRE_REVIEW_FINDINGS'
// round = số vòng findings đã phát hành trước đó; >= maxRounds → blocked.
// decisionGate khác null (vd 'diff-limit') → chặn ngay bằng Decision Gate:
// status:blocked, KHÔNG trả Cline như lỗi code và KHÔNG handoff approval (GPT-REV-031).
// KHÔNG BAO GIỜ trả label status:approved — approval cuối thuộc GPT.
export function planPreReviewOutcome({ verdict, round = 0, maxRounds = 3, decisionGate = null } = {}) {
  if (decisionGate) {
    return {
      action: 'block-decision-gate',
      addLabels: [LABELS.blocked],
      removeLabels: [LABELS.reviewing, AGENTS.cline],
    };
  }
  if (verdict === 'PRE_REVIEW_PASS') {
    return {
      action: 'handoff-gpt',
      addLabels: [LABELS.reviewRequested, AGENTS.gpt],
      removeLabels: [LABELS.reviewing, AGENTS.cline],
    };
  }
  if (round >= maxRounds) {
    return {
      action: 'block',
      addLabels: [LABELS.blocked],
      removeLabels: [LABELS.reviewing, AGENTS.cline],
    };
  }
  return {
    action: 'request-fix',
    addLabels: [LABELS.changesRequested, AGENTS.cline],
    removeLabels: [LABELS.reviewing],
  };
}

// ---------------------------------------------------------------- approval khóa HEAD SHA

// Marker HTML comment chứa JSON approval — máy đọc được, đính trong comment PR do
// scripts/gpt-approval.mjs đăng khi relay quyết định GPT.
export function buildApprovalMarker(record) {
  const json = JSON.stringify({
    repository: String(record.repository),
    prNumber: Number(record.prNumber),
    reviewer: String(record.reviewer), // 'agent:gpt'
    headSha: String(record.headSha),   // full 40-hex SHA
    policyVersion: String(record.policyVersion),
    decisionId: String(record.decisionId), // ID quyết định do người dùng relay cung cấp (GPT-REV-032)
    ciEvidence: record.ciEvidence ?? null,
    openBlockingFindings: Number(record.openBlockingFindings ?? 0),
    reviewedAt: String(record.reviewedAt),
  });
  return `<!-- ai-review-approval:${json} -->`;
}

// Quét danh sách comment text, trích toàn bộ approval records hợp lệ về cú pháp.
export function parseApprovalMarkers(texts) {
  const out = [];
  for (const t of Array.isArray(texts) ? texts : []) {
    const re = /<!--\s*ai-review-approval:(\{.*?\})\s*-->/g;
    let m;
    while ((m = re.exec(String(t || ''))) !== null) {
      try { out.push(JSON.parse(m[1])); } catch {} // marker hỏng → bỏ qua, không làm sập vòng review
    }
  }
  return out;
}

// Approval có còn hiệu lực cho (repo, pr, HEAD hiện tại, policy hiện tại) không?
// Bất kỳ lệch SHA/policy/repo/pr nào → invalid (không kế thừa approval từ commit trước).
export function isApprovalValid(record, ctx) {
  if (!record || typeof record !== 'object') return { valid: false, reason: 'record rỗng' };
  if (String(record.reviewer) !== AGENTS.gpt) return { valid: false, reason: `reviewer không phải ${AGENTS.gpt}` };
  if (!/^[0-9a-f]{40}$/i.test(String(record.headSha))) return { valid: false, reason: 'headSha không phải full 40-hex' };
  if (String(record.headSha).toLowerCase() !== String(ctx.headSha || '').toLowerCase()) {
    return { valid: false, reason: 'HEAD đã đổi sau approval — bắt buộc GPT review lại' };
  }
  if (ctx.policyVersion && String(record.policyVersion) !== String(ctx.policyVersion)) {
    return { valid: false, reason: 'policy version đã đổi' };
  }
  if (ctx.repository && String(record.repository) !== String(ctx.repository)) return { valid: false, reason: 'sai repository' };
  if (ctx.prNumber != null && Number(record.prNumber) !== Number(ctx.prNumber)) return { valid: false, reason: 'sai PR number' };
  if (Number(record.openBlockingFindings ?? 0) > 0) return { valid: false, reason: 'còn finding blocking mở' };
  if (!String(record.decisionId || '').trim()) return { valid: false, reason: 'marker thiếu decisionId (không hợp lệ theo GPT-REV-032)' };
  return { valid: true, reason: null };
}

// User-relay approval payload (GPT-REV-032): bằng chứng ủy quyền do NGƯỜI DÙNG cung cấp,
// ràng buộc tuyệt đối repo + PR + full HEAD SHA + policyVersion + decision ID.
// Gate fail-closed: thiếu/lệch bất kỳ trường nào → KHÔNG mutation nào được phép.
// Lưu ý xác thực: payload chứng minh người relay nắm đúng ngữ cảnh tại thời điểm gọi;
// script KHÔNG thể tự xác minh danh tính GPT — đảm bảo đó thuộc về kênh relay con người.
export function validateApprovalPayload(payload, ctx) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'thiếu approval payload' };
  const p = (k) => String(payload[k] ?? '').trim();
  const required = ['repository', 'prNumber', 'headSha', 'policyVersion', 'decisionId'];
  for (const k of required) {
    if (!p(k)) return { ok: false, error: `payload thiếu ${k}` };
  }
  if (!/^[0-9a-f]{40}$/i.test(p('headSha'))) return { ok: false, error: 'payload headSha không phải full 40-hex SHA' };
  if (!/^\S+$/.test(p('decisionId'))) return { ok: false, error: 'decisionId không được chứa khoảng trắng' };
  if (ctx && ctx.repository && p('repository') !== String(ctx.repository)) {
    return { ok: false, error: `payload repository (${p('repository')}) không khớp PR thực tế (${ctx.repository})` };
  }
  if (ctx && ctx.prNumber != null && Number(p('prNumber')) !== Number(ctx.prNumber)) {
    return { ok: false, error: `payload prNumber (${p('prNumber')}) không khớp PR thực tế (${ctx.prNumber})` };
  }
  if (ctx && ctx.headSha && p('headSha').toLowerCase() !== String(ctx.headSha).toLowerCase()) {
    return { ok: false, error: `payload headSha không khớp HEAD hiện tại của PR` };
  }
  if (ctx && ctx.policyVersion && p('policyVersion') !== String(ctx.policyVersion)) {
    return { ok: false, error: `payload policyVersion (${p('policyVersion')}) không khớp policy tại HEAD (${ctx.policyVersion})` };
  }
  return { ok: true, error: null };
}

// Approval hiệu lực MỚI NHẤT cho HEAD hiện tại, hoặc null.
export function effectiveApproval(records, ctx) {
  let best = null;
  for (const r of parseApprovalMarkers(records)) {
    const v = isApprovalValid(r, ctx);
    if (v.valid && (!best || String(r.reviewedAt) > String(best.reviewedAt))) best = r;
  }
  return best;
}

// Approval cục bộ steady-state (GPT-REV-045): marker do reviewer:local ghi khi đủ toàn bộ
// evaluateSteadyApprovalGates. KHÔNG thay thế GPT approval ở transition; chỉ được dùng để
// chống approval-drift SAI khi PR đã được local approve đúng gates ở steady-state.
// Trường bắt buộc khớp policy.approvalMarker.requiredFields (test assert đồng bộ với JSON).
export const LOCAL_APPROVAL_REQUIRED_FIELDS = [
  'repository', 'prNumber', 'reviewer', 'headSha', 'policyVersion',
  'decisionId', 'ciEvidence', 'openBlockingFindings', 'reviewedAt',
];

export function steadyLocalApproval(records, { headSha, repository, prNumber, policyVersion } = {}) {
  for (const r of parseApprovalMarkers(records)) {
    if (String(r.reviewer) !== REVIEWER_LOCAL) continue;
    const fieldsOk = LOCAL_APPROVAL_REQUIRED_FIELDS.every((k) => r[k] !== undefined && r[k] !== null && r[k] !== '');
    const shaOk = /^[0-9a-f]{40}$/i.test(String(r.headSha || ''))
      && String(r.headSha).toLowerCase() === String(headSha || '').toLowerCase();
    const scopeOk = String(r.repository) === String(repository)
      && Number(r.prNumber) === Number(prNumber)
      && policyVersion != null && String(r.policyVersion) === String(policyVersion);
    if (fieldsOk && shaOk && scopeOk && Number(r.openBlockingFindings ?? 0) === 0) return r;
  }
  return null;
}

// Phát hiện approval-drift: PR gắn status:approved nhưng không có approval GPT hợp lệ
// cho HEAD hiện tại → gỡ hiệu lực approval cũ, chuyển lại status:review-requested.
export function planApprovalDrift({ labels, comments, headSha, repository, prNumber, policyVersion } = {}) {
  const norm = normalizeStatusLabels(labels);
  if (norm.keepStatus !== LABELS.approved) return { drift: false };
  const ctx = { headSha, repository, prNumber, policyVersion };
  // [GPT-REV-045] Approval hợp lệ = GPT (mọi pha) HOẶC reviewer:local steady-state đủ gates.
  const approval = effectiveApproval(comments, ctx) || steadyLocalApproval(comments, ctx);
  if (approval) return { drift: false, approval };
  return {
    drift: true,
    addLabels: [LABELS.reviewRequested, AGENTS.gpt],
    removeLabels: [LABELS.approved, AGENTS.cline],
    comment: `⚠️ Approval-drift: \`status:approved\` nhưng không có approval ${AGENTS.gpt} hợp lệ cho HEAD \`${String(headSha || '').slice(0, 12)}\` — gỡ hiệu lực approval cũ, chuyển lại \`status:review-requested\`, chờ GPT review lại.`,
  };
}

// ---------------------------------------------------------------- event muộn & mutation an toàn

// Event cũ (đính kèm headSha cũ) đến sau khi PR đã tiến xa hơn → bỏ qua, KHÔNG lùi trạng thái.
export function isStaleEvent({ eventHeadSha, currentHeadSha } = {}) {
  if (eventHeadSha && currentHeadSha && String(eventHeadSha).toLowerCase() !== String(currentHeadSha).toLowerCase()) return true;
  return false;
}

// Chỉ PR open mới được mutation. closed/merged nhận event muộn → bỏ qua (Issue #2 B5).
export function canMutatePr(prState) {
  return String(prState || '').toLowerCase() === 'open';
}

// Khóa idempotency theo Issue #2 A4: repo + PR + HEAD SHA + policy version + action.
export function mutationKey({ repository, prNumber, headSha, policyVersion, action }) {
  return [repository, prNumber, headSha, policyVersion, action].join('::');
}

// ---------------------------------------------------------------- vòng fix (A6: KHÔNG tạo issue [review-fix])

// Đếm số vòng findings đã phát hành từ comment có marker `<!-- ai-pr-reviewer:round=N -->`.
export function countReviewRounds(comments) {
  let max = 0;
  for (const t of Array.isArray(comments) ? comments : []) {
    const m = String(t || '').match(/<!--\s*ai-pr-reviewer:round=(\d+)\s*-->/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

// Taxonomy severity canonical (GPT-REV-034): critical | important | suggestion.
// Blocking = critical + important; dùng đồng nhất trong policy/code/docs/test.
export const SEVERITIES = ['critical', 'important', 'suggestion'];
export const DEFAULT_BLOCKING_SEVERITIES = ['critical', 'important'];

// Gate: còn finding Critical/Important đang mở thì KHÔNG được đề xuất/ghi nhận approval
// (finding Important mở cũng chặn handoff/approval — GPT-REV-034).
export function gateOpenFindings(findings, blockingSeverities = DEFAULT_BLOCKING_SEVERITIES) {
  const block = new Set(blockingSeverities.map((s) => String(s).toLowerCase()));
  return (Array.isArray(findings) ? findings : []).filter((f) => {
    const sev = String((f && f.severity) || '').toLowerCase();
    const status = String((f && f.status) || 'open').toLowerCase();
    return block.has(sev) && status !== 'resolved';
  });
}

// ---------------------------------------------------------------- pre-review deterministic

// Regex quét secret trên phần thêm mới của diff (04-security-and-secrets §3).
export const SECRET_PATTERNS = [
  { id: 'api-key', re: /(api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9][^'"]+['"]/i },
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'generic-secret', re: /(password|secret|token)\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { id: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH |)?PRIVATE KEY-----/ },
];

// Quét dòng thêm (+) của diff → findings chuẩn (severity critical).
export function scanDiffForSecrets(diffText) {
  const findings = [];
  for (const line of String(diffText || '').split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) {
        findings.push({
          severity: 'critical',
          status: 'open',
          fileSymbol: `diff dòng: ${line.slice(1, 61).trim()}`,
          evidence: `Khớp mẫu secret "${p.id}" trong phần thêm mới của diff`,
          risk: 'Rò rỉ credential vào lịch sử Git nếu merge',
          requiredFix: 'Xóa secret khỏi code, đưa vào secret manager/env; rotate key nếu đã expose',
          acceptanceCriteria: 'Diff không còn khớp mẫu secret nào',
        });
        break; // 1 finding/dòng là đủ
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- reviewer phases (runtime, GPT-REV-039)

// Resolve pha review hiện tại từ dữ liệu policy (fail-closed):
//   - policy thiếu/mất shape reviewerPhases → phase 'blocked' (BLOCKED_PHASE_UNRESOLVED),
//     luôn escalate GPT, không bao giờ cho local approve.
//   - transition.runtimeWiringPrRequired === true và wiring chưa merge → 'transition'
//     (GPT duyệt mọi PR, local KHÔNG tự approve).
//   - steady-state CHỈ khi activationRequires đủ [runtimeWiringPrGptApproved,
//     runtimeWiringPrMerged] VÀ caller xác nhận wiring đã được GPT duyệt + merge
//     (tham số runtimeWiringMerged — marker máy đọc được do người dùng/orchestrator ghi).
export function resolveReviewPhase(policy, { runtimeWiringMerged = false } = {}) {
  const rp = policy && policy.reviewerPhases;
  const phases = rp && rp.phases;
  if (!rp || !phases || !phases.transition || !phases.steadyState) {
    return { phase: 'blocked', code: 'BLOCKED_PHASE_UNRESOLVED', escalateToGpt: true, localReviewerCanApprove: false };
  }
  const tr = phases.transition;
  const ss = phases.steadyState;
  const req = Array.isArray(ss.activationRequires) ? ss.activationRequires : [];
  const activationComplete =
    runtimeWiringMerged === true &&
    req.includes('runtimeWiringPrGptApproved') &&
    req.includes('runtimeWiringPrMerged');
  if (!activationComplete) {
    return { phase: 'transition', escalateToGpt: true, localReviewerCanApprove: tr.localReviewerCanApprove === true };
  }
  return { phase: 'steady-state', localReviewerCanApprove: ss.localReviewerCanApprove === true };
}

// Escalation theo pha (pure). Transition: MỌI PR sau pre-review đều bàn giao GPT.
// Steady-state: chỉ escalate GPT khi có blocking findings / decision gate / verdict không xác định;
// PASS sạch mới xét đường local-accept (vẫn phải qua evaluateSteadyApprovalGates trước khi ghi approval).
export function planEscalationForPhase(phaseInfo, { verdict, decisionGate = null, openBlockingCount = 0 } = {}) {
  if (!phaseInfo || phaseInfo.phase === 'blocked') {
    return { action: 'block', reason: (phaseInfo && phaseInfo.code) || 'BLOCKED_PHASE_UNRESOLVED',
      addLabels: [LABELS.blocked], removeLabels: [LABELS.reviewing] };
  }
  if (phaseInfo.phase === 'transition') {
    return { action: 'escalate-gpt', reason: 'transition-phase-final-reviewer-gpt' };
  }
  // steady-state:
  if (verdict !== 'PRE_REVIEW_PASS' || decisionGate || openBlockingCount > 0) {
    return { action: 'escalate-gpt', reason: 'blocking-findings-or-decision-gate' };
  }
  return { action: 'local-accept-candidate', reason: 'clean-pass-steady-state' };
}

// 6 gate approvalRequiresAllGates của steady-state (pure, fail-closed):
// trả { ok, gates: [{gate, pass}] } — thiếu bất kỳ bằng chứng nào → ok=false.
export function evaluateSteadyApprovalGates({ ciState, passMarkerPresent, headSha, policyValid, policyVersionMatch, openBlockingCount, readAfterWriteOk }) {
  const gates = [
    ['requiredChecksAllPassed', ciState === 'pass'],
    ['realSemanticReviewCompleted', passMarkerPresent === true],
    ['approvalLockedToHeadShaAndPolicyVersion', Boolean(headSha) && /^[0-9a-f]{40}$/i.test(String(headSha))],
    ['noOpenBlockingFindings', Number(openBlockingCount) === 0],
    ['policyValid', policyValid === true],
    ['readAfterWriteSucceeded', readAfterWriteOk === true],
    ['policyVersionMatchesCurrent', policyVersionMatch === true], // ràng buộc bổ sung, fail-closed thêm
  ];
  return { ok: gates.every(([, pass]) => pass), gates: gates.map(([gate, pass]) => ({ gate, pass })) };
}

// ---------------------------------------------------------------- activation & duplicate keys (GPT-REV-045)

/**
 * Pure: phân tích marker kích hoạt steady-state máy đọc được từ nguồn policy khai báo
 * (reviewerPhases.steadyState.activationEvidence — issue-comment marker).
 * Fail-closed: thiếu prefix / JSON hỏng / sai shape / SHA không full 40-hex → { active: false }.
 */
export function parseActivationComment(rawText) {
  const PREFIX = '<!-- ai-review-phase-activation:';
  const text = String(rawText || '');
  const start = text.indexOf(PREFIX);
  if (start === -1) return { active: false, reason: 'không có marker kích hoạt' };
  const end = text.indexOf('-->', start);
  if (end === -1) return { active: false, reason: 'marker không đóng -->' };
  let rec;
  try { rec = JSON.parse(text.slice(start + PREFIX.length, end).trim()); }
  catch { return { active: false, reason: 'JSON trong marker không parse được' }; }
  if (!rec || typeof rec !== 'object') return { active: false, reason: 'record không phải object' };
  if (rec.phase !== 'steady-state') return { active: false, reason: `phase=${String(rec.phase)} không phải steady-state` };
  for (const k of ['wiringPr', 'wiringMergedSha', 'gptApprovedHeadSha', 'recordedBy']) {
    if (!String(rec[k] || '').trim()) return { active: false, reason: `thiếu ${k}` };
  }
  const shaOk = (s) => /^[0-9a-f]{40}$/i.test(String(s || ''));
  if (!shaOk(rec.wiringMergedSha)) return { active: false, reason: 'wiringMergedSha không phải full 40-hex' };
  if (!shaOk(rec.gptApprovedHeadSha)) return { active: false, reason: 'gptApprovedHeadSha không phải full 40-hex' };
  return { active: true, record: rec };
}

/**
 * Pure: quét raw JSON text phát hiện duplicate key TRONG CÙNG MỘT object
 * (JSON.parse âm thầm giữ key cuối → schema mơ hồ theo GPT-REV-045).
 * Trả { duplicates: [{ key, path }] }; mảng rỗng = sạch.
 */
export function scanDuplicateObjectKeys(text) {
  const s = String(text || '');
  const dups = [];
  /** @type {Array<Set<string>|null>} null = level là array (không collect key) */
  const stack = [new Set()];
  const pathStack = [''];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      // đọc string (tôn trọng escape)
      let j = i + 1;
      let str = '';
      while (j < s.length) {
        if (s[j] === '\\') { str += s[j] + s[j + 1]; j += 2; continue; }
        if (s[j] === '"') break;
        str += s[j];
        j += 1;
      }
      // peek ký hiệu sau string
      let k = j + 1;
      while (k < s.length && /\s/.test(s[k])) k += 1;
      const top = stack[stack.length - 1];
      if (s[k] === ':' && top) {
        if (top.has(str)) dups.push({ key: str, path: pathStack.join('.') });
        else top.add(str);
        i = k + 1; // nhảy qua ':'
        continue;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      stack.push(new Set());
      // tên object hiện tại = chuỗi key gần nhất trong level cha
      pathStack.push(lastKeyBefore(s, i));
    } else if (ch === '[') {
      stack.push(null);
      pathStack.push(lastKeyBefore(s, i));
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      pathStack.pop();
      if (!stack.length) break;
    }
    i += 1;
  }
  return { duplicates: dups };
}

// Tên key gần nhất trước vị trí idx (dùng làm path mô tả; không cần chính xác tuyệt đối).
function lastKeyBefore(s, idx) {
  const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
  let last = '';
  let m;
  const slice = s.slice(0, idx);
  while ((m = re.exec(slice)) !== null) last = m[1];
  return last;
}

// Giới hạn kích thước diff theo policy.diffLimits.maxLines (0/undefined = không giới hạn).
// Metric canonical (GPT-REV-031): churn review = additions + deletions — cả hai phía diff
// đều tốn công review, chỉ đếm additions đã đánh giá thấp quy mô thật của PR.
export function evaluateDiffLimits(policy, diffText) {
  const limit = Number(policy && policy.diffLimits && policy.diffLimits.maxLines) || 0;
  const lines = String(diffText || '').split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  const churn = added + removed;
  return { over: limit > 0 && churn > limit, lines: churn, added, removed, limit };
}

// ---------------------------------------------------------------- reviewer↔coder rebuttal (GPT-REV-036 runtime)

/**
 * Pure: xử lý phản hồi coder trên một finding.
 * Quy tắc: finding thiếu trường bắt buộc = malformed → reviewer phải xác nhận/cập nhật trước khi
 * đem lại làm blocking; FIX không có evidence → finding vẫn mở; REBUT im lặng (không verdict) =
 * còn mở; REJECTED mà chưa phân xử được → escalate-dispute (agent:gpt / status:blocked),
 * CẤM coder tự đóng thread/tự gắn approved.
 */
export function resolveRebuttalOutcome({ coderVerdictKind, finding, reviewerVerdict = null, evidencePresent = false }) {
  // [GPT-REV-045] Đủ 5 trường bắt buộc theo reviewerCoderContract.findingRequiredFields
  // (thiếu expectedOutcome trước đây → finding malformed bị coi hợp lệ).
  const REQUIRED = ['code', 'severity', 'evidence', 'risk', 'expectedOutcome'];
  const malformed = !finding || REQUIRED.some((k) => finding[k] === undefined || finding[k] === null || finding[k] === '');
  if (malformed) {
    return { findingClosed: false, nextAction: 'request-reviewer-verdict', malformedFinding: true };
  }
  if (coderVerdictKind === 'CLINE-FIX') {
    if (!evidencePresent) return { findingClosed: false, nextAction: 'keep-open-fix-applied' };
    return { findingClosed: true, nextAction: 'close-finding' };
  }
  // CLINE-REBUT:
  if (reviewerVerdict === 'ACCEPTED') return { findingClosed: true, nextAction: 'close-finding' };
  if (reviewerVerdict === 'REJECTED') return { findingClosed: false, nextAction: 'escalate-dispute' };
  return { findingClosed: false, nextAction: 'request-reviewer-verdict' };
}

// ---------------------------------------------------------------- task discovery (GPT-REV-037 runtime)

/**
 * Pure: ánh xạ kết quả khám phá task sang hành vi fail-closed theo minimalCommandDiscovery.
 * zero → NO_TASK (không mutation); one → claim-exactly-one; many/conflict → blocked-no-guessing.
 */
export function planDiscoveryBehavior({ validTasks, conflicting = false }) {
  if (conflicting || validTasks > 1) {
    return { result: 'blocked-no-guessing', mutationAllowed: false };
  }
  if (validTasks === 1) return { result: 'claim-exactly-one', mutationAllowed: true };
  return { result: 'NO_TASK', mutationAllowed: false };
}


