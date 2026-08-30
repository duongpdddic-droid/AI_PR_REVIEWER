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
  // [GPT-REV-049] approvalAuthorities: allowlist riêng theo loại approval (KHÔNG dùng
  // activationEvidence.allowedRecorders). gptApprovalCommentAuthors / localApprovalCommentAuthors
  // đều phải là mảng không rỗng. Thiếu/rỗng/sai schema → fail-closed (bất kỳ actor nào cũng có
  // thể giả marker approval).
  const aa = policy.approvalAuthorities;
  if (!aa || typeof aa !== 'object') {
    return { ok: false, error: 'thiếu object approvalAuthorities' };
  }
  for (const k of ['gptApprovalCommentAuthors', 'localApprovalCommentAuthors']) {
    if (!Array.isArray(aa[k]) || aa[k].length === 0) {
      return { ok: false, error: `approvalAuthorities.${k} phải là mảng không rỗng (allowlist người đăng approval marker)` };
    }
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
  // [CLINE-FIX-050] gh pr checks --json trả MẢNG phẳng; test/mock dùng wrapper {checks:[...]}.
  // Chấp nhận cả 2 shape — trước đây mảng thật làm byName rỗng → CI 'missing' sai trên production.
  const checkList = Array.isArray(checksDetail) ? checksDetail : (checksDetail.checks || []);
  const byName = new Map();
  for (const c of checkList) byName.set(c.name, c.state);
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

// Quét danh sách comment RICH (kèm metadata id/author/created_at/body), trích toàn bộ
// approval records hợp lệ VÀ giữ metadata nguồn. Fail-closed: entry thiếu metadata bắt buộc
// (id, authorLogin) → bỏ qua marker đó (không tin cậy body thuần).
// Trả về: [{ marker: {...parsed}, commentId, authorLogin, createdAt, body }].
export function parseApprovalMarkers(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    // Hỗ trợ cả comment object {id, user:{login}, created_at, body} VÀ legacy string
    let body = '';
    let commentId = '';
    let authorLogin = '';
    let createdAt = '';
    if (c && typeof c === 'object' && c.body !== undefined) {
      body = String(c.body || '');
      commentId = String(c.id || '');
      authorLogin = c.user && c.user.login ? String(c.user.login) : '';
      createdAt = String(c.created_at || '');
    } else {
      // Legacy: plain text string — KHÔNG có metadata → marker từ nguồn này KHÔNG được tin cậy
      // cho approval provenance (fail-closed). Vẫn parse để backward-compat nhưng gắn cờ.
      body = String(c || '');
      commentId = '';
      authorLogin = '';
      createdAt = '';
    }
    const re = /<!--\s*ai-review-approval:(\{.*?\})\s*-->/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      try {
        const marker = JSON.parse(m[1]);
        out.push({ marker, commentId, authorLogin, createdAt, body });
      } catch {
        // marker hỏng → bỏ qua, không làm sập vòng review
      }
    }
  }
  return out;
}

// Parse marker handoff dạng <!-- ai-pr-reviewer:key=<mutationKey> --> từ comment
// RICH object (kèm metadata id/author/created_at/body). Trả về mảng {key, commentId,
// authorLogin, createdAt, body} — fail-closed: comment legacy (body thuần) KHONG có
// provenance → marker KHONG được tin cậy (caller phải filter theo authorLogin/commentId).
// Dùng cho hasCanonicalHandoffMarker (execution-broker) — Finding 6.
export function parseHandoffMarkers(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    let body = '';
    let commentId = '';
    let authorLogin = '';
    let createdAt = '';
    if (c && typeof c === 'object' && c.body !== undefined) {
      body = String(c.body || '');
      commentId = String(c.id || '');
      authorLogin = c.user && c.user.login ? String(c.user.login) : '';
      createdAt = String(c.created_at || '');
    } else {
      body = String(c || '');
    }
    // Mutation key format: <repo>::<prNumber>::<headSha>::<policyVersion>::<action>
    const re = /<!--\s*ai-pr-reviewer:key=([^\s>]+)\s*-->/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const key = m[1].trim();
      // Validate key shape: 5 phần :: (repo, pr, headSha 40-hex, policy, action).
      const parts = key.split('::');
      const validShape = parts.length === 5
        && /^[0-9a-f]{40}$/i.test(parts[2] || '')
        && parts[3]
        && parts[4];
      if (!validShape) continue;
      out.push({ key, commentId, authorLogin, createdAt, body });
    }
  }
  return out;
}

// Tìm marker handoff hợp lệ trong danh sách parsed markers.
// Fail-closed (Finding 6): comment legacy (không có commentId/authorLogin) bị bỏ.
// Marker khớp = key (mutationKey) khớp đầy đủ 5 trường.
export function findCanonicalHandoffMarker(parsedMarkers, expectedKey) {
  for (const m of Array.isArray(parsedMarkers) ? parsedMarkers : []) {
    if (!m.commentId || !m.authorLogin) continue; // fail-closed provenance
    if (m.key === expectedKey) return m;
  }
  return null;
}

// Approval có còn hiệu lực cho (repo, pr, HEAD hiện tại, policy hiện tại) không?
// Bất kỳ lệch SHA/policy/repo/pr nào → invalid (không kế thừa approval từ commit trước).
// [GPT-REV-048] Fail-closed: record PHẢI có provenance (authorLogin + commentId) hợp lệ.
// GPT approval marker CHỈ hợp lệ khi do user relay (author là người dùng/coder) —
// marker do actor bất kỳ khác đăng (bot,第三方) bị từ chối.
export function isApprovalValid(record, ctx) {
  if (!record || typeof record !== 'object') return { valid: false, reason: 'record rỗng' };
  // [GPT-REV-048] provenance check: cần authorLogin + commentId
  if (!record.commentId || !record.authorLogin) {
    return { valid: false, reason: 'marker thiếu provenance (commentId/authorLogin) — body thuần không được tin cậy' };
  }
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
  // [GPT-REV-049] Allowlist fail-closed: GPT approval marker CHỈ hợp lệ khi commentId + authorLogin
  // có provenance VÀ authorLogin thuộc policy.approvalAuthorities.gptApprovalCommentAuthors.
  // Không cho phép actor bất kỳ (bot/third-party) giả marker reviewer:agent:gpt. Nếu caller
  // không truyền gptApprovers (policy thiếu approvalAuthorities) → fail-closed.
  const gptApprovers = Array.isArray(ctx.gptApprovers) ? ctx.gptApprovers.map((a) => String(a)) : [];
  if (gptApprovers.length === 0) {
    return { valid: false, reason: 'UNAUTHORIZED_ACTOR: policy.approvalAuthorities.gptApprovalCommentAuthors rỗng/không được truyền — từ chối mọi GPT approval marker' };
  }
  if (!gptApprovers.includes(String(record.authorLogin))) {
    return { valid: false, reason: `UNAUTHORIZED_ACTOR: author "${String(record.authorLogin || '(rỗng)')}" không thuộc policy.approvalAuthorities.gptApprovalCommentAuthors` };
  }
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
// [GPT-REV-048] records: mảng comment RICH object {id, user:{login}, created_at, body} hoặc legacy string.
// Trả về marker object (parsed JSON) hoặc null.
export function effectiveApproval(records, ctx) {
  let best = null;
  for (const entry of parseApprovalMarkers(records)) {
    const r = entry.marker;
    const v = isApprovalValid({ ...r, commentId: entry.commentId, authorLogin: entry.authorLogin }, ctx);
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

// [GPT-REV-048] Fail-closed: local approval marker PHẢI có provenance (authorLogin + commentId).
// Chỉ chấp nhận marker do actor/relay được policy cho phép (allowedRecorders từ activationEvidence,
// hoặc identity người dùng relay). Legacy body string không được tin cậy.
export function steadyLocalApproval(records, { headSha, repository, prNumber, policyVersion, localApprovers } = {}) {
  // [GPT-REV-049] Fail-closed: thiếu allowlist local → KHÔNG có approval cục bộ hợp lệ nào.
  const local = Array.isArray(localApprovers) ? localApprovers.map((a) => String(a)) : [];
  if (local.length === 0) return null;
  for (const entry of parseApprovalMarkers(records)) {
    const r = entry.marker;
    if (String(r.reviewer) !== REVIEWER_LOCAL) continue;
    // Provenance check: cần commentId + authorLogin
    if (!entry.commentId || !entry.authorLogin) continue; // bỏ qua legacy body string
    // Authorization check: author PHẢI thuộc localApprovalCommentAuthors.
    if (!local.includes(entry.authorLogin)) continue;
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
// [GPT-REV-048] comments: mảng comment RICH object {id, user:{login}, created_at, body} hoặc legacy string.
// allowedRecorders: danh sách actor được phép đăng local approval marker (từ policy.activationEvidence.allowedRecorders).
export function planApprovalDrift({ labels, comments, headSha, repository, prNumber, policyVersion, gptApprovers, localApprovers } = {}) {
  const norm = normalizeStatusLabels(labels);
  if (norm.keepStatus !== LABELS.approved) return { drift: false };
  const ctx = { headSha, repository, prNumber, policyVersion, gptApprovers };
  // [GPT-REV-045 + GPT-REV-048 + GPT-REV-049] Approval hợp lệ = GPT (mọi pha, có provenance +
  // author ∈ gptApprovalCommentAuthors) HOẶC reviewer:local steady-state đủ gates VÀ có
  // provenance + author ∈ localApprovalCommentAuthors. Thiếu allowlist → fail-closed (drift).
  const approval = effectiveApproval(comments, ctx) || steadyLocalApproval(comments, { ...ctx, localApprovers });
  if (approval) return { drift: false, approval };
  return {
    drift: true,
    addLabels: [LABELS.reviewRequested, AGENTS.gpt],
    removeLabels: [LABELS.approved, AGENTS.cline],
    comment: `⚠️ Approval-drift: \`status:approved\` nhưng không có approval ${AGENTS.gpt} hợp lệ cho HEAD \`${String(headSha || '').slice(0, 12)}\` — gỡ hiệu lực approval cũ, chuyển lại \`status:review-requested\`, chờ GPT review lại.`,
  };
}

// ---------------------------------------------------------------- HEAD-Lock Lifecycle (Issue #22)

// Trích toàn bộ SHA từ marker pre-review PASS: `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:<sha> -->`.
// Trả danh sách { sha(40-hex lowercase), createdAt? } theo thứ tự comment; marker hỏng/sai cú pháp → bỏ qua.
export function parsePreReviewPassShas(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = c && typeof c === 'object' && c.body != null ? String(c.body) : String(c);
    const re = /ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:([0-9a-f]{40})/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      out.push({
        sha: m[1].toLowerCase(),
        createdAt: c && typeof c === 'object' && c.created_at != null ? String(c.created_at) : '',
      });
    }
  }
  return out;
}

/**
 * [GPT-REV-CHANGES-01] Trích PASS records KÈM METADATA (author login + comment id + created_at)
 * từ danh sách comment object GitHub API ({id, user:{login}, created_at, body}). Chỉ nhận comment
 * có cú pháp marker PASS hợp lệ; marker hỏng → bỏ qua (fail-closed). KHÔNG tự tin body tự khai báo:
 * tính hợp lệ phải qua isPreReviewPassCanonical (provenance + author + key khớp).
 */
export function collectPreReviewPassRecords(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!c || typeof c !== 'object') continue;
    const sha = (String(c.body || '').match(/ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:([0-9a-f]{40})/i) || [])[1];
    if (!sha) continue;
    out.push({
      sha: sha.toLowerCase(),
      authorLogin: String((c.user && c.user.login) || ''),
      commentId: c.id != null ? String(c.id) : '',
      createdAt: String(c.created_at || ''),
      body: String(c.body || ''),
    });
  }
  return out;
}

/**
 * [GPT-REV-CHANGES-01] PRE_REVIEW_PASS canonical CHỈ được tin khi có ĐỦ:
 *   1. comment provenance (commentId bắt buộc — comment phải có id thật từ GitHub);
 *   2. author thuộc preReviewApprovers (policy localApprovalCommentAuthors);
 *   3. key trong body khớp repository::prNumber::full HEAD sha::policyVersion::pre-review:PRE_REVIEW_PASS.
 * Fail-closed: thiếu bất kỳ thành phần / sai key / approvers rỗng → false. PASS không canonical
 * KHÔNG được dùng làm bằng chứng khóa HEAD (không đóng finding, không giữ lock).
 */
export function isPreReviewPassCanonical(entry, { preReviewApprovers = [], repository = '', prNumber = '', policyVersion = '' } = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.commentId) return false;
  const allowed = preReviewApprovers.map((a) => String(a));
  if (allowed.length === 0 || !allowed.includes(entry.authorLogin)) return false;
  const sha = String(entry.sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  const bodyText = String(entry.body || '');
  const markerStart = 'ai-pr-reviewer:key=';
  const keyStart = bodyText.indexOf(markerStart);
  const keyEnd = keyStart === -1 ? -1 : bodyText.indexOf(' -->', keyStart + markerStart.length);
  const key = keyStart === -1 || keyEnd === -1 ? '' : bodyText.slice(keyStart + markerStart.length, keyEnd);
  const expected = [String(repository), String(prNumber), sha, String(policyVersion), 'pre-review:PRE_REVIEW_PASS'].join('::');
  return String(key || '').trim() === expected;
}

// Chọn SHA khóa LOCK MỚI NHẤT từ một danh sách { sha, createdAt }, mặc định entry cuối cùng
// (comments issue theo thứ tự ASC trên GitHub — bài mới ở cuối). Trả { sha, createdAt } hoặc null.
function latestShaOf(entries, orderKey) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let best = entries[entries.length - 1];
  for (const e of entries) {
    if (e[orderKey] && (!best[orderKey] || String(e[orderKey]) > String(best[orderKey]))) best = e;
  }
  return { sha: best.sha, createdAt: best[orderKey] || '' };
}

// Approval marker MỚI NHẤT cho BẤT KỲ head SHA nào (KHÔNG lọc theo headSha hiện tại) — dùng để
// phát hiện drift: approval cũ khóa sha X nhưng PR đang ở sha Y → invalidate. Chỉ tin marker có
// provenance + author thuộc allowlist (fail-closed, giống isApprovalValid nhưng bỏ ràng buộc headSha).
export function latestApprovalShaAnyHead(records, { repository, prNumber, policyVersion, gptApprovers, localApprovers } = {}) {
  let latest = null;
  let latestAt = '';
  for (const entry of parseApprovalMarkers(records)) {
    const r = entry.marker;
    // Provenance + scope (repo/pr) bắt buộc; KHÔNG ràng buộc headSha để bắt drift.
    if (!entry.commentId || !entry.authorLogin) continue;
    if (String(r.repository) !== String(repository) || Number(r.prNumber) !== Number(prNumber)) continue;
    if (policyVersion != null && String(r.policyVersion) !== String(policyVersion)) continue;
    if (!/^[0-9a-f]{40}$/i.test(String(r.headSha || ''))) continue;
    // reviewer: gpt (mọi pha) hoặc reviewer:local scheme — kiểm tra author theo loại.
    if (String(r.reviewer) === AGENTS.gpt) {
      const gpt = Array.isArray(gptApprovers) ? gptApprovers.map((a) => String(a)) : [];
      if (gpt.length === 0 || !gpt.includes(entry.authorLogin)) continue;
    } else if (String(r.reviewer) === REVIEWER_LOCAL) {
      const loc = Array.isArray(localApprovers) ? localApprovers.map((a) => String(a)) : [];
      if (loc.length === 0 || !loc.includes(entry.authorLogin)) continue;
    } else {
      continue; // reviewer không hợp lệ
    }
    const at = String(r.reviewedAt || entry.createdAt || '');
    if (!latest || (at && at > latestAt)) { latest = { sha: r.headSha.toLowerCase(), createdAt: at }; latestAt = at; }
  }
  return latest;
}

// Trích danh sách marker unfreeze: `<!-- ai-pr-reviewer:unfreeze:reason=<nội dung> -->`.
// Trả mảng { reason, createdAt, authorLogin } theo thứ tự comment; marker hỏng → bỏ qua phần
// reason rỗng. Author BẮT BUỘC (comment.user.login) — không có author → marker bỏ qua (fail-closed).
export function parseUnfreezeMarkers(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = c && typeof c === 'object' && c.body != null ? String(c.body) : String(c);
    const authorLogin = c && typeof c === 'object'
      ? String((c.user && c.user.login) || (c.author && c.author.login) || '')
      : '';
    // Reason BẮT BUỘC (Issue #22: "explicit unfreeze kèm reason") — marker thiếu reason bị bỏ qua.
    const re = /ai-pr-reviewer:unfreeze:reason=([^\s*][^>]*?)-->/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      out.push({
        reason: m[1].trim(),
        createdAt: c && typeof c === 'object' && c.created_at != null ? String(c.created_at) : '',
        authorLogin,
      });
    }
  }
  return out;
}

// Có marker unfreeze MỚI HƠN lock mới nhất và do NGƯỜI CÓ QUYỀN (authorizedLogins) tạo không?
// Dùng để cho phép push override sau khi bị freeze (Issue #22): người dùng chủ động comment
// unfreeze kèm lý do → gate công nhận, vẫn bắt chạy lại CI + pre-review cho HEAD mới trước khi
// handoff lại GPT. Fail-closed: authorizedLogins rỗng/thiếu → KHÔNG ai unfreeze được; author
// ngoài danh sách → marker không có hiệu lực.
export function isUnfrozenAfter(comments, lockCreatedAt = '', { authorizedLogins = [] } = {}) {
  const allowed = Array.isArray(authorizedLogins) ? authorizedLogins.map((a) => String(a)) : [];
  if (allowed.length === 0) return false;
  const markers = parseUnfreezeMarkers(comments).filter((m) => m.authorLogin && allowed.includes(m.authorLogin));
  const newest = markers.pop();
  return Boolean(newest && newest.createdAt && (!lockCreatedAt || String(newest.createdAt) > String(lockCreatedAt)));
}
// Mỗi giai đoạn khóa HEAD (CI/pre-review PASS/GPT approval) chỉ có hiệu lực với đúng một full
// HEAD SHA. Hàm thuần xác định: PR hiện có "đang bị khóa" (frozen) không, và HEAD hiện tại có khớp
// lock hay không. Kết quả:
//   { frozen:false }                     — chưa handoff/duyệt → không áp gate
//   { frozen:true, valid:true, lockSha } — HEAD khớp lock → cho phép handoff/giữ approved
//   { frozen:true, valid:false, drift:true, lockSha } — HEAD đổi/lệch → invalidate, phải chạy lại
//   { frozen:true, valid:false, drift:true, lockSha:null, reason } — frozen nhưng KHÔNG có bằng
//     chứng PASS/approval nào khóa HEAD → fail-closed (không handoff GPT).
// Fail-closed: mọi bất định/thiếu bằng chứng → valid:false + drift:true (không tự cho handoff).
export function planHeadLock({ labels, comments, headSha, repository, prNumber, policyVersion, gptApprovers, localApprovers } = {}) {
  const norm = normalizeStatusLabels(labels);
  const hasGpt = (Array.isArray(labels) ? labels : []).map((l) => String(l && l.name ? l.name : l)).includes(AGENTS.gpt);
  // Gate CHỈ áp cho trạng thái "chờ bên ngoài" của vòng review: approved (đã duyệt) hoặc
  // review-requested ĐÃ CÓ agent:gpt (bàn tay GPT sau handoff). KHÔNG gồm `reviewing`
  // (trạng thái tạm chính orchestrator tự đặt ngay trước pre-review — sẽ tự ghi PASS marker mới
  // cho HEAD hiện tại trong cùng vòng, không drift) và KHÔNG gồm review-requested + agent:cline
  // (mới khởi đầu, chưa pre-review) → flow CI/pre-review chạy bình thường.
  const frozenStatus =
    norm.keepStatus === LABELS.approved
    || (norm.keepStatus === LABELS.reviewRequested && hasGpt);
  if (!frozenStatus) return { frozen: false };
  // PASS canonical (provenance + authorized author + key khớp) — PASS không canonical KHÔNG làm
  // bằng chứng khóa HEAD [GPT-REV-CHANGES-01]. Approval cũng đã lọc author/key qua latestApprovalShaAnyHead.
  const passRecords = collectPreReviewPassRecords(comments).filter((e) => isPreReviewPassCanonical(e, {
    preReviewApprovers: localApprovers, repository, prNumber, policyVersion,
  }));
  const pass = latestShaOf(passRecords, 'createdAt');
  const approval = latestApprovalShaAnyHead(comments, { repository, prNumber, policyVersion, gptApprovers, localApprovers });
  // [GPT-REV-CHANGES-01] Lock = loại bằng chứng (PASS | approval) MỚI NHẤT theo createdAt — KHÔNG
  // ưu tiên cứng approval > PASS. Nếu có approval cũ (lock A) rồi unfreeze → push B → PASS mới
  // (B), lock phải là PASS(B) để handoff B hợp lệ; chọn approval cũ sẽ chặn nhầm.
  const cand = [pass, approval].filter(Boolean);
  let lock = null;
  for (const c of cand) {
    if (!lock || (c.createdAt && (!lock.createdAt || String(c.createdAt) > String(lock.createdAt)))) lock = c;
  }
  const lockSha = lock ? lock.sha : null;
  const lockCreatedAt = lock ? lock.createdAt : '';
  if (!lockSha) {
    return {
      frozen: true, valid: false, drift: true, lockSha: null, lockCreatedAt: '',
      reason: 'PR đang ở trạng thái duyệt/handoff nhưng KHÔNG có bằng chứng PASS/approval nào khóa HEAD — không thể xác nhận lock, fail-closed.',
    };
  }
  const matches = String(lockSha).toLowerCase() === String(headSha || '').toLowerCase();
  if (matches) return { frozen: true, valid: true, drift: false, lockSha, lockCreatedAt };
  return {
    frozen: true, valid: false, drift: true, lockSha, lockCreatedAt,
    reason: `HEAD đã đổi sau giai đoạn khóa (lock ${String(lockSha).slice(0, 12)} → HEAD ${String(headSha || '').slice(0, 12)}) — trạng thái cũ vô hiệu, phải chạy lại CI + pre-review cho HEAD mới.`,
  };
}

// ---------------------------------------------------------------- pre-push guard (Issue #22)

// Quyết định LOCAL pre-push: branch đang push có thuộc PR open đang FROZEN không. Không dựa riêng
// vào orchestrator phát hiện sau push — từ chối push trước khi head sha drift lên remote.
//   allow khi: không có PR open cho branch; PR chưa frozen; HEAD khớp lock (uncommitted thay đổi
//             không đổi HEAD → không drift); hoặc có unfreeze marker hợp lệ (reason + mới hơn lock
//             + authorized author).
//   block khi: frozen (approved | review-requested+agent:gpt) mà HEAD lệch lock và chưa unfreeze
//             hợp lệ. Fail-closed: không lấy được thông tin PR đang frozen nếu đã biết PR tồn tại
//             → block (pr.failed=true).
export function decidePrePushGuard({ branch, headSha, pr = null, authorizedLogins = [] } = {}) {
  if (!branch) return { decision: 'allow', reason: 'không xác định được branch — bỏ qua' };
  if (!pr) return { decision: 'allow', reason: `branch ${branch} không có PR open — không áp freeze` };
  if (pr.failed) {
    return {
      decision: 'block', reason: `PR #${pr.number} tồn tại nhưng không đọc được trạng thái (labels/comments) — KHÔNG thể xác nhận không frozen (fail-closed)`,
    };
  }
  if (String(pr.state).toLowerCase() !== 'open') return { decision: 'allow', reason: `PR #${pr.number} không open — không áp freeze` };
  const hlock = planHeadLock({
    labels: pr.labels, comments: pr.comments, headSha,
    repository: pr.repository, prNumber: pr.number,
    policyVersion: pr.policyVersion, gptApprovers: pr.gptApprovers, localApprovers: pr.localApprovers,
  });
  if (!hlock.frozen || hlock.valid) return { decision: 'allow', reason: 'PR không frozen hoặc HEAD khớp lock (chưa drift)' };
  const unfrozen = isUnfrozenAfter(pr.comments, hlock.lockSha ? hlock.lockCreatedAt : '', { authorizedLogins });
  if (unfrozen) {
    return { decision: 'allow', reason: 'unfreeze marker hợp lệ (reason + mới hơn lock + authorized author) — push override được phép, bắt buộc chạy lại CI + pre-review sau push' };
  }
  return {
    decision: 'block', reason: `FROZEN: ${hlock.reason} Mở khóa bằng marker <!-- ai-pr-reviewer:unfreeze:reason=<lý do> --> từ user có quyền, hoặc dừng push.`,
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
// [GPT-REV-048] comments có thể là rich object {body} hoặc legacy string.
export function countReviewRounds(comments) {
  let max = 0;
  for (const t of Array.isArray(comments) ? comments : []) {
    const text = t && typeof t === 'object' && t.body != null ? String(t.body) : String(t || '');
    const m = text.match(/<!--\s*ai-pr-reviewer:round=(\d+)\s*-->/);
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
 * Pure [GPT-REV-046]: trích activation records KÈM METADATA (author login + comment id +
 * created_at) từ danh sách comment object GitHub API ({id, user:{login}, created_at, body}).
 * Chỉ nhận record có cú pháp hợp lệ qua parseActivationComment; marker hỏng → bỏ qua (fail-closed).
 */
export function collectActivationRecords(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!c || typeof c !== 'object') continue;
    const parsed = parseActivationComment(c.body);
    if (!parsed.active) continue;
    out.push({
      record: parsed.record,
      authorLogin: String((c.user && c.user.login) || ''),
      commentId: c.id != null ? String(c.id) : '',
      createdAt: String(c.created_at || ''),
    });
  }
  return out;
}

/**
 * Pure [GPT-REV-046]: xác minh activation steady-state CHỈ từ dữ liệu CÓ AUTHORITY —
 * không tin các trường tự khai báo trong body marker:
 *   1. author comment phải thuộc allowedRecorders do policy khai báo;
 *   2. wiringPr phải đúng repo/PR policy chỉ định (expectedWiringPr);
 *   3. wiring PR phải MERGED thật (wiringState đọc từ GitHub REST);
 *   4. wiringMergedSha phải khớp merge_commit_sha thực tế;
 *   5. gptApprovedHeadSha phải là head ĐÃ MERGE của wiring PR;
 *   6. trên wiring PR phải có GPT approval marker hợp lệ (isApprovalValid: reviewer agent:gpt,
 *      khóa đúng head đã merge + policyVersion hiện tại, không còn finding blocking).
 * Nhiều marker CHỈ chấp nhận khi nội dung record giống hệt nhau (duplicate); khác nhau → mâu thuẫn.
 * Fail-closed: bất kỳ điều kiện thiếu/sai/mâu thuẫn/lỗi IO (wiringState null) → { active:false }.
 */
export function planPhaseActivation({
  records, allowedRecorders, expectedWiringPr, wiringState, wiringApprovalRecords, policyVersion, gptApprovers,
} = {}) {
  const inactive = (reason) => ({ active: false, reason });
  if (!Array.isArray(records) || records.length === 0) return inactive('không có marker kích hoạt');
  const canon = (e) => JSON.stringify(e.record);
  if (new Set(records.map(canon)).size > 1) {
    return inactive(`có ${records.length} marker activation mâu thuẫn nhau`);
  }
  const entry = records[0];
  const rec = entry.record;
  const allowed = (Array.isArray(allowedRecorders) ? allowedRecorders : []).map((a) => String(a));
  if (!entry.authorLogin || !allowed.includes(entry.authorLogin)) {
    return inactive(`author "${entry.authorLogin || '(rỗng)'}" không thuộc allowedRecorders của policy`);
  }
  const ev = expectedWiringPr || {};
  if (!ev.repo || !ev.number) return inactive('policy thiếu expectedWiringPr (không thể xác minh phạm vi wiring PR)');
  const expected = `${ev.repo}#${ev.number}`.toLowerCase();
  if (String(rec.wiringPr || '').trim().toLowerCase() !== expected) {
    return inactive(`wiringPr "${rec.wiringPr}" không đúng PR policy chỉ định (${ev.repo}#${ev.number})`);
  }
  if (!wiringState || wiringState.error) return inactive('không đọc được trạng thái wiring PR từ GitHub (fail-closed)');
  if (wiringState.merged !== true) return inactive(`wiring PR chưa merge (state=${String(wiringState.state || '?')})`);
  if (String(rec.wiringMergedSha).toLowerCase() !== String(wiringState.mergeCommitSha || '').toLowerCase()) {
    return inactive('wiringMergedSha không khớp merge commit thực tế của wiring PR trên GitHub');
  }
  if (String(rec.gptApprovedHeadSha).toLowerCase() !== String(wiringState.headSha || '').toLowerCase()) {
    return inactive('gptApprovedHeadSha không phải head đã merge của wiring PR');
  }
  const approval = effectiveApproval(wiringApprovalRecords, {
    repository: ev.repo, prNumber: ev.number, headSha: rec.gptApprovedHeadSha, policyVersion,
    gptApprovers,
  });
  if (!approval) {
    return inactive('không có GPT approval hợp lệ khóa đúng head đã merge + policyVersion hiện tại trên wiring PR');
  }
  return { active: true, reason: 'activation hợp lệ: authority + merge + SHA + GPT approval đều khớp', approval };
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


