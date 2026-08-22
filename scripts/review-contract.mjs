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

// Phát hiện approval-drift: PR gắn status:approved nhưng không có approval GPT hợp lệ
// cho HEAD hiện tại → gỡ hiệu lực approval cũ, chuyển lại status:review-requested.
export function planApprovalDrift({ labels, comments, headSha, repository, prNumber, policyVersion } = {}) {
  const norm = normalizeStatusLabels(labels);
  if (norm.keepStatus !== LABELS.approved) return { drift: false };
  const approval = effectiveApproval(comments, { headSha, repository, prNumber, policyVersion });
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
