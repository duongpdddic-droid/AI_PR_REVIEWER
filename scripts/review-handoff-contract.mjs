#!/usr/bin/env node
// review-handoff-contract.mjs — Canonical REVIEW HANDOFF CONTRACT (Issue #32).
//
// Pure logic, ZERO IO. Mỗi hàm chỉ input+output, test deterministic (không dependency).
// Mục đích: chuẩn hóa bằng chứng handoff để reviewer độc lập đánh giá KHÔNG cần
// re-fetch toàn bộ diff GitHub. Contract canonical DUY NHẤT nằm tại repo này
// (scripts/review-handoff-contract.mjs); repo dự án KHÔNG copy contract, chỉ tham chiếu
// pin version (xem buildTaskPacket).
//
// Fail-closed: thiếu required section / thiếu exact HEAD / "all green" mâu thuẫn /
// thiếu terminal status / không resolve được contract reference / packet truncation
// → status PARTIAL_EVIDENCE (KHÔNG được request review handoff).

import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = '1.0.0';

// Terminal status hợp lệ — report phải kết thúc bằng ĐÚNG 1 trong các giá trị này.
export const TERMINAL_STATUSES = Object.freeze(['READY_FOR_REVIEW', 'BLOCKED', 'PARTIAL_EVIDENCE']);

// HEAD SHA chuẩn: full 40-hex (khóa HEAD theo approval gate — không chấp nhận short SHA).
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

// Path canonical của contract trong repo nguồn — reference pin phải trỏ đúng path này (GPT-REV-121).
export const CANONICAL_CONTRACT_PATH = 'scripts/review-handoff-contract.mjs';

// Repository canonical chứa contract (nguồn sự thật của chính contract này).
export const CANONICAL_CONTRACT_REPO = 'duongpdddic-droid/AI_PR_REVIEWER';

// ---------------------------------------------------------------------------
// Schema canonical — 10 sections + required fields (Issue #32 body).
// Mỗi section: { title, fields: [tên trường bắt buộc] }.
// ---------------------------------------------------------------------------
export const REQUIRED_SECTIONS = Object.freeze({
  identity: Object.freeze({
    title: 'Identity',
    fields: Object.freeze(['repository', 'issue', 'pullRequest', 'branch', 'headSha', 'baseSha', 'prState', 'noForcePushMergeDeploy']),
  }),
  scope: Object.freeze({
    title: 'Scope',
    fields: Object.freeze(['objective', 'acceptanceCriteria', 'changedFiles', 'exclusions', 'deviations']),
  }),
  codeEvidence: Object.freeze({
    title: 'Code evidence',
    fields: Object.freeze(['items']),
  }),
  findingResolution: Object.freeze({
    title: 'Finding resolution',
    fields: Object.freeze(['items']),
  }),
  tests: Object.freeze({
    title: 'Tests',
    fields: Object.freeze(['items']),
  }),
  verification: Object.freeze({
    title: 'Verification',
    fields: Object.freeze(['commands', 'exitCodes', 'passCount', 'failCount', 'diffCheck', 'worktreeStatus', 'remainingFailures']),
  }),
  safety: Object.freeze({
    title: 'Safety and mutation analysis',
    fields: Object.freeze(['inputsMutated', 'preExistingOverwrite', 'sharedPathnameTouched', 'toctouRace', 'accessOutsideWorktree', 'remoteMutation', 'rollbackScope']),
  }),
  unverifiedRisks: Object.freeze({
    title: 'Unverified risks',
    fields: Object.freeze(['items']),
  }),
  delivery: Object.freeze({
    title: 'Delivery',
    fields: Object.freeze(['commitSha', 'pushResult', 'prActions', 'headReadBack', 'noApprovalClaim']),
  }),
  terminalStatus: Object.freeze({
    title: 'Terminal status',
    fields: Object.freeze(['status']),
  }),
});

export const SECTION_IDS = Object.freeze(Object.keys(REQUIRED_SECTIONS));

// ---------------------------------------------------------------------------
// Semantic constraints — canonical source duy nhất (GPT-REV-120).
// Mỗi rule: { code, section, description, check(report) }.
// Validator VÀ contractContent() đều render từ source này → inline payload
// lossless (runtime không resolve reference vẫn nhận đủ semantic contract).
// ---------------------------------------------------------------------------
export const SEMANTIC_RULES = Object.freeze([
  {
    code: 'MISSING_HEAD_SHA',
    section: 'identity',
    description: 'headSha phải là exact HEAD: full 40-hex (không short SHA, không branch/tag)',
    check: (r) => typeof r.identity?.headSha === 'string' && HEAD_SHA_RE.test(r.identity.headSha),
    message: 'Thiếu hoặc sai định dạng exact HEAD SHA (cần 40-hex)',
  },
  {
    code: 'IDENTITY_BOUND_FIELDS',
    section: 'identity',
    description: 'Identity phải đủ repository, issue, pullRequest, branch, headSha, baseSha, prState, noForcePushMergeDeploy (khóa identity với dữ liệu server kiểm soát)',
    check: (r) => {
      const i = r.identity ?? {};
      return ['repository', 'issue', 'pullRequest', 'branch', 'headSha', 'baseSha', 'prState', 'noForcePushMergeDeploy'].every((f) => i[f] !== undefined && i[f] !== null);
    },
    message: 'Identity thiếu trường bind (repository/issue/pullRequest/branch/headSha/baseSha/prState/noForcePushMergeDeploy)',
  },
  {
    code: 'MISSING_VERIFICATION_COMMANDS',
    section: 'verification',
    description: 'Test totals phải kèm commands + exitCodes thực tế (không chỉ số đếm — intent không phải evidence)',
    check: (r) => {
      const v = r.verification ?? {};
      return Array.isArray(v.commands) && v.commands.length > 0 && Array.isArray(v.exitCodes) && v.exitCodes.length > 0;
    },
    message: 'Test totals phải kèm commands + exit code (thiếu → không phải evidence)',
  },
  {
    code: 'ALL_GREEN_WITH_FAILURE',
    section: 'verification',
    description: 'Báo READY_FOR_REVIEW nhưng vẫn còn failure (failCount/remainingFailures) → mâu thuẫn, fail-closed',
    check: (r) => {
      const v = r.verification ?? {};
      const failures = Array.isArray(v.remainingFailures) ? v.remainingFailures : [];
      const failCount = Number.isInteger(v.failCount) ? v.failCount : 0;
      const allGreen = r.terminalStatus?.status === 'READY_FOR_REVIEW';
      return !(allGreen && (failures.length > 0 || failCount > 0));
    },
    message: 'Báo READY_FOR_REVIEW nhưng có failure được ghi nhận (failCount/remainingFailures)',
  },
  {
    code: 'MISSING_OR_INVALID_TERMINAL_STATUS',
    section: 'terminalStatus',
    description: 'Terminal status phải là đúng 1 trong READY_FOR_REVIEW | BLOCKED | PARTIAL_EVIDENCE',
    check: (r) => typeof r.terminalStatus?.status === 'string' && TERMINAL_STATUSES.includes(r.terminalStatus.status),
    message: `Terminal status phải là 1 trong [${TERMINAL_STATUSES.join(', ')}]`,
  },
  {
    code: 'CODE_EVIDENCE_ITEMS_REQUIRED',
    section: 'codeEvidence',
    description: 'Mỗi mục code evidence phải có file, lines, symbol, before/after behavior, failClosedGates, mutationOrdering, excerpt, callerInput, mutations (đủ static tracing, không chỉ tên file)',
    check: (r) => {
      const items = r.codeEvidence?.items;
      if (!Array.isArray(items) || items.length === 0) return false;
      const req = ['file', 'lines', 'symbol', 'before', 'after', 'failClosedGates', 'mutationOrdering', 'excerpt', 'callerInput', 'mutations'];
      return items.every((it) => it && typeof it === 'object' && req.every((f) => it[f] !== undefined && it[f] !== null));
    },
    message: 'Mỗi mục code evidence thiếu file/lines/symbol/before/after/failClosedGates/mutationOrdering/excerpt/callerInput/mutations',
  },
  {
    code: 'FINDING_RESOLUTION_ITEMS_REQUIRED',
    section: 'findingResolution',
    description: 'Mỗi mục finding resolution phải có findingId, severity, status (fixed|disputed|unresolved), rootCause, fix; disputed bắt buộc kèm evidence',
    check: (r) => {
      const items = r.findingResolution?.items;
      if (!Array.isArray(items) || items.length === 0) return false;
      const req = ['findingId', 'severity', 'status', 'rootCause', 'fix'];
      const okStatus = ['fixed', 'disputed', 'unresolved'];
      return items.every((it) => it && typeof it === 'object'
        && req.every((f) => it[f] !== undefined && it[f] !== null)
        && okStatus.includes(it.status));
    },
    message: 'Mỗi mục finding resolution thiếu findingId/severity/status/rootCause/fix hoặc status lạ',
  },
  {
    code: 'TESTS_ITEMS_REQUIRED',
    section: 'tests',
    description: 'Mỗi mục tests phải có name, location, setup, assertions (đầy đủ, không chỉ "pass"), negativeAssertion, realFs, result, exitCode',
    check: (r) => {
      const items = r.tests?.items;
      if (!Array.isArray(items) || items.length === 0) return false;
      const req = ['name', 'location', 'setup', 'assertions', 'negativeAssertion', 'realFs', 'result', 'exitCode'];
      return items.every((it) => it && typeof it === 'object'
        && req.every((f) => it[f] !== undefined && it[f] !== null)
        && Array.isArray(it.assertions) && it.assertions.length > 0);
    },
    message: 'Mỗi mục tests thiếu name/location/setup/assertions/negativeAssertion/realFs/result/exitCode',
  },
  {
    code: 'SAFETY_FIELDS_REQUIRED',
    section: 'safety',
    description: 'Safety & mutation analysis phải khai đủ inputsMutated, preExistingOverwrite, sharedPathnameTouched, toctouRace, accessOutsideWorktree, remoteMutation, rollbackScope',
    check: (r) => {
      const s = r.safety ?? {};
      const req = ['inputsMutated', 'preExistingOverwrite', 'sharedPathnameTouched', 'toctouRace', 'accessOutsideWorktree', 'remoteMutation', 'rollbackScope'];
      return req.every((f) => s[f] !== undefined && s[f] !== null);
    },
    message: 'Safety thiếu trường mutation analysis (inputsMutated/preExistingOverwrite/sharedPathnameTouched/toctouRace/accessOutsideWorktree/remoteMutation/rollbackScope)',
  },
  {
    code: 'UNVERIFIED_RISKS_ITEMS_REQUIRED',
    section: 'unverifiedRisks',
    description: 'Unverified risks phải là mảng items liệt kê cụ thể (không claim verified khi còn risks chưa verify)',
    check: (r) => Array.isArray(r.unverifiedRisks?.items),
    message: 'unverifiedRisks phải là { items: [...] }',
  },
  {
    code: 'DELIVERY_NO_APPROVAL_CLAIM',
    section: 'delivery',
    description: 'Delivery phải khai commitSha (40-hex), pushResult, prActions, headReadBack=true, noApprovalClaim=true (agent không tự nhận reviewer approval)',
    check: (r) => {
      const d = r.delivery ?? {};
      return typeof d.commitSha === 'string' && HEAD_SHA_RE.test(d.commitSha)
        && typeof d.pushResult === 'string' && typeof d.prActions === 'string'
        && d.headReadBack === true && d.noApprovalClaim === true;
    },
    message: 'Delivery thiếu commitSha (40-hex)/pushResult/prActions hoặc headReadBack/noApprovalClaim chưa đúng',
  },
]);

export const SEMANTIC_RULE_CODES = Object.freeze(SEMANTIC_RULES.map((s) => s.code));

// ---------------------------------------------------------------------------
// Report mẫu hợp lệ (happy path) — dùng cho test. deepMerge để tạo biến thể thiếu field.
// ---------------------------------------------------------------------------
export function sampleReport(overrides = {}) {
  const base = {
    contractVersion: CONTRACT_VERSION,
    identity: {
      repository: 'duongpdddic-droid/AI_PR_REVIEWER',
      issue: 32,
      pullRequest: 40,
      branch: 'feat/issue-32-review-handoff-contract',
      headSha: '0123456789abcdef0123456789abcdef01234567',
      baseSha: '0123456789abcdef0123456789abcdef01234566',
      prState: 'Draft',
      noForcePushMergeDeploy: true,
    },
    scope: {
      objective: 'Add canonical Review Handoff Contract',
      acceptanceCriteria: ['canonical contract', 'validator', 'gate'],
      changedFiles: ['scripts/review-handoff-contract.mjs'],
      exclusions: [],
      deviations: [],
    },
    codeEvidence: { items: [{ file: 'scripts/review-handoff-contract.mjs', lines: '1-70', symbol: 'validateHandoff', before: 'missing', after: 'structured errors', failClosedGates: 'PARTIAL_EVIDENCE on missing section', mutationOrdering: 'validate before transition', excerpt: 'export function validateHandoff(...)', callerInput: 'report object', mutations: [] }] },
    findingResolution: { items: [{ findingId: 'GPT-REV-000', severity: 'low', status: 'fixed', rootCause: 'n/a', fix: 'n/a (baseline)' }] },
    tests: { items: [{ name: 'happy path', location: 'scripts/test-review-handoff-contract.mjs', setup: 'full report', interleaving: null, assertions: ['status READY_FOR_REVIEW'], negativeAssertion: 'errors empty', realFs: false, result: 'PASS', exitCode: 0 }] },
    verification: {
      commands: ['node scripts/test-review-handoff-contract.mjs'],
      exitCodes: [0],
      passCount: 1,
      failCount: 0,
      diffCheck: 'clean',
      worktreeStatus: 'clean',
      remainingFailures: [],
    },
    safety: {
      inputsMutated: false,
      preExistingOverwrite: false,
      sharedPathnameTouched: false,
      toctouRace: 'none',
      accessOutsideWorktree: false,
      remoteMutation: false,
      rollbackScope: 'only current invocation state',
    },
    unverifiedRisks: { items: [] },
    delivery: {
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      pushResult: 'pushed',
      prActions: 'Draft PR #40 opened',
      headReadBack: true,
      noApprovalClaim: true,
    },
    terminalStatus: { status: 'READY_FOR_REVIEW' },
  };
  return deepMerge(base, overrides);
}

// deepMerge — base + overrides (object lồng merge nông 1 cấp theo section; value thay thế).
function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Validator — trả { ok, status, errors: [{ code, section, field, message }] }.
// Fail-closed: bất kỳ lỗi nào → status PARTIAL_EVIDENCE (không bao giờ READY_FOR_REVIEW).
// ---------------------------------------------------------------------------
export function validateHandoff(report, { expectedVersion = CONTRACT_VERSION, registeredRepos = null } = {}) {
  const errors = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, status: 'PARTIAL_EVIDENCE', errors: [{ code: 'INVALID_REPORT', section: null, field: null, message: 'Report không phải object' }] };
  }
  if (report.contractVersion !== expectedVersion) {
    errors.push({ code: 'CONTRACT_VERSION_MISMATCH', section: null, field: 'contractVersion', message: `contractVersion phải là ${expectedVersion}` });
  }
  // Cross-repository (Issue #32): target repo phải thuộc registry được phép —
  // repo chưa đăng ký / lạ → fail-closed (unknown/unregistered repository).
  if (Array.isArray(registeredRepos)) {
    const repo = report.identity && report.identity.repository;
    if (typeof repo !== 'string' || !registeredRepos.includes(repo)) {
      errors.push({ code: 'UNKNOWN_REPOSITORY', section: 'identity', field: 'repository', message: `Repository chưa đăng ký hoặc không được phép: ${String(repo)}` });
    }
  }
  for (const id of SECTION_IDS) {
    const def = REQUIRED_SECTIONS[id];
    const value = report[id];
    if (value === undefined || value === null) {
      errors.push({ code: 'MISSING_SECTION', section: id, field: null, message: `Thiếu section: ${id} (${def.title})` });
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ code: 'INVALID_SECTION', section: id, field: null, message: `Section ${id} phải là object` });
      continue;
    }
    for (const f of def.fields) {
      if (value[f] === undefined || value[f] === null) {
        errors.push({ code: 'MISSING_FIELD', section: id, field: f, message: `Thiếu trường: ${id}.${f}` });
      }
    }
  }
  // Semantic constraints — render từ SEMANTIC_RULES (cùng source với contractContent).
  for (const rule of SEMANTIC_RULES) {
    try {
      if (!rule.check(report)) {
        errors.push({ code: rule.code, section: rule.section, field: rule.section, message: rule.message });
      }
    } catch {
      errors.push({ code: rule.code, section: rule.section, field: rule.section, message: `${rule.message} (exception khi check)` });
    }
  }
  const ok = errors.length === 0;
  const ts = report.terminalStatus && report.terminalStatus.status;
  const status = ok ? (TERMINAL_STATUSES.includes(ts) ? ts : 'PARTIAL_EVIDENCE') : 'PARTIAL_EVIDENCE';
  return { ok, status, errors };
}

// Gate: CHỈ report READY_FOR_REVIEW mới được phép request reviewer handoff.
export function canRequestReview(validationResult) {
  return Boolean(validationResult && validationResult.ok === true && validationResult.status === 'READY_FOR_REVIEW');
}

// ---------------------------------------------------------------------------
// GPT-REV-118 — identity binding (chống replay/substitution).
// So khớp report.identity với dữ liệu SERVER kiểm soát (không phải caller tự khai):
//   repository === repo, issue === number, pullRequest === pr, headSha === prHeadSha.
// headSha là exact PR HEAD đọc từ nguồn tin cậy (gh pr view) — KHÔNG chỉ check 40-hex.
// Mọi mismatch → { ok:false, errors } → server fail-closed TRƯỚC mọi mutation.
// ---------------------------------------------------------------------------
export function verifyHandoffIdentity(report, { repo, number, pr, prHeadSha, checkHead = true } = {}) {
  const errors = [];
  const id = report && typeof report === 'object' ? report.identity : null;
  if (!id || typeof id !== 'object') {
    return { ok: false, errors: [{ code: 'IDENTITY_MISSING', section: 'identity', field: null, message: 'handoffReport.identity bắt buộc để bind với dữ liệu server' }] };
  }
  if (id.repository !== repo) {
    errors.push({ code: 'IDENTITY_REPOSITORY_MISMATCH', section: 'identity', field: 'repository', message: `report.identity.repository=${id.repository} ≠ repo server=${repo}` });
  }
  if (id.issue !== number) {
    errors.push({ code: 'IDENTITY_ISSUE_MISMATCH', section: 'identity', field: 'issue', message: `report.identity.issue=${id.issue} ≠ issue server=${number}` });
  }
  if (id.pullRequest !== pr) {
    errors.push({ code: 'IDENTITY_PR_MISMATCH', section: 'identity', field: 'pullRequest', message: `report.identity.pullRequest=${id.pullRequest} ≠ pr server=${pr}` });
  }
  // Exact PR HEAD từ nguồn tin cậy — không chỉ check 40-hex (stale HEAD / random 40-hex bị chặn).
  // checkHead=false: giai đoạn 1 (server chưa đọc được PR HEAD) chỉ bind repo/issue/pr.
  if (checkHead) {
    if (typeof prHeadSha !== 'string' || !HEAD_SHA_RE.test(prHeadSha)) {
      errors.push({ code: 'PR_HEAD_UNREADABLE', section: 'identity', field: 'headSha', message: 'Không đọc được exact PR HEAD từ nguồn tin cậy (gh pr view) → fail-closed' });
    } else if (id.headSha !== prHeadSha) {
      errors.push({ code: 'IDENTITY_HEAD_SHA_MISMATCH', section: 'identity', field: 'headSha', message: `report.identity.headSha=${id.headSha} ≠ exact PR HEAD=${prHeadSha}` });
    }
  }
  return { ok: errors.length === 0, errors };
}


// ---------------------------------------------------------------------------
// Task packet — inject contract vào task packet/handoff prompt (Issue #32 §Integration).
// Dedup: static contract nằm ở 1 nơi canonical; packet tham chiếu pin version khi
// runtime resolve được, ngược lại inline toàn bộ content (fail-closed nếu truncate).
// ---------------------------------------------------------------------------
// contractContent — inline payload LOSSESS: render đủ required fields + semantic
// constraints từ SEMANTIC_RULES (cùng source với validator — GPT-REV-120).
export function contractContent() {
  const lines = [`REVIEW HANDOFF CONTRACT v${CONTRACT_VERSION}`, ''];
  for (const id of SECTION_IDS) {
    const def = REQUIRED_SECTIONS[id];
    lines.push(`[${id}] ${def.title} — bắt buộc: ${def.fields.join(', ')}`);
    const rules = SEMANTIC_RULES.filter((s) => s.section === id);
    for (const r of rules) {
      lines.push(`  - ${r.description}`);
    }
  }
  lines.push('');
  lines.push(`Terminal status (đúng 1): ${TERMINAL_STATUSES.join(' | ')}`);
  return lines.join('\n');
}

// contractContentHash — fingerprint của inline content (GPT-REV-120/121):
// equivalence gate giữa docs, validator và inline packet; reference pin binding.
export function contractContentHash() {
  return createHash('sha256').update(contractContent()).digest('hex');
}

// stableStringify — JSON deterministic (sort key) cho digest không phụ thuộc thứ tự key.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// reportDigest — fingerprint bền vững của report đã validate (GPT-REV-122):
// CHỈ dựa trên contractVersion + 10 sections canonical; extra key / thứ tự key không ảnh hưởng.
// Dùng để bind report persisted với exact HEAD + contract version (phát hiện stale report).
export function reportDigest(report) {
  const canon = {};
  if (report && report.contractVersion !== undefined) canon.contractVersion = report.contractVersion;
  for (const id of SECTION_IDS) {
    if (report && report[id] !== undefined) canon[id] = report[id];
  }
  return createHash('sha256').update(stableStringify(canon)).digest('hex');
}

// ---------------------------------------------------------------------------
// GPT-REV-121 — canonical reference pin.
// Ref hợp lệ = structured object: { repo, commitSha, path, contractVersion, contentHash }.
// KHÔNG chấp nhận arbitrary string (short SHA / branch/tag / @pinned / @0123).
// ---------------------------------------------------------------------------
export function validateCanonicalRef(ref, { registryRepos = null, contentHash = null } = {}) {
  const errors = [];
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    return { ok: false, errors: [{ code: 'REF_NOT_STRUCTURED', section: null, field: null, message: 'Reference phải là structured object { repo, commitSha, path, contractVersion, contentHash }' }] };
  }
  const { repo, commitSha, path, contractVersion, contentHash: refHash } = ref;
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    errors.push({ code: 'REF_REPO_INVALID', section: null, field: 'repo', message: `repo không đúng dạng owner/name: ${String(repo)}` });
  } else if (Array.isArray(registryRepos) && !registryRepos.includes(repo)) {
    errors.push({ code: 'REF_REPO_NOT_REGISTERED', section: null, field: 'repo', message: `repo chưa đăng ký trong registry: ${repo}` });
  }
  if (typeof commitSha !== 'string' || !HEAD_SHA_RE.test(commitSha)) {
    errors.push({ code: 'REF_SHA_INVALID', section: null, field: 'commitSha', message: `commitSha phải là full 40-hex (không short SHA/branch/tag): ${String(commitSha)}` });
  }
  if (path !== CANONICAL_CONTRACT_PATH) {
    errors.push({ code: 'REF_PATH_INVALID', section: null, field: 'path', message: `path phải là ${CANONICAL_CONTRACT_PATH}` });
  }
  if (contractVersion !== CONTRACT_VERSION) {
    errors.push({ code: 'REF_VERSION_MISMATCH', section: null, field: 'contractVersion', message: `contractVersion phải là ${CONTRACT_VERSION}` });
  }
  const expectedHash = contentHash ?? contractContentHash();
  if (typeof refHash !== 'string' || refHash !== expectedHash) {
    errors.push({ code: 'REF_CONTENT_HASH_MISMATCH', section: null, field: 'contentHash', message: 'contentHash không khớp inline content hiện tại (contract đã đổi hoặc hash sai)' });
  }
  return { ok: errors.length === 0, errors };
}

// buildTaskPacket({ resolveRef, maxBytes, registryRepos, contentHash })
//   resolveRef: () => { resolved: true, ref } | { resolved: false } — injectable (test), không IO trực tiếp.
//     ref phải là canonical structured object (GPT-REV-121); không verify được → fallback inline lossless.
//   maxBytes: giới hạn inline content (mặc định 8000).
//   registryRepos: danh sách repo registered (optional — ref repo phải thuộc registry nếu truyền).
//   contentHash: hash inline hiện tại (optional — mặc định contractContentHash()).
// Trả { ok, mode: 'reference'|'inline', ref?|content?, errors? }.
export function buildTaskPacket({ resolveRef = () => ({ resolved: false }), maxBytes = 8000, registryRepos = null, contentHash = null } = {}) {
  let resolved;
  try {
    resolved = resolveRef();
  } catch {
    resolved = { resolved: false }; // resolver exception → fallback inline (GPT-REV-121)
  }
  if (resolved && resolved.resolved === true && resolved.ref !== undefined && resolved.ref !== null) {
    const v = validateCanonicalRef(resolved.ref, { registryRepos, contentHash });
    if (v.ok) {
      return { ok: true, mode: 'reference', ref: resolved.ref, contractVersion: CONTRACT_VERSION, contentHash: contentHash ?? contractContentHash() };
    }
    // ref không verify được → fallback inline lossless (KHÔNG chấp nhận arbitrary ref)
  }
  const content = contractContent();
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    return { ok: false, mode: 'inline', errors: [{ code: 'PACKET_TRUNCATED', section: null, field: null, message: `Contract content vượt maxBytes=${maxBytes} → fail-closed (truncation)` }] };
  }
  return { ok: true, mode: 'inline', content, contractVersion: CONTRACT_VERSION, contentHash: contentHash ?? contractContentHash() };
}

// CLI tự chạy: node scripts/review-handoff-contract.mjs → self-check + exit 0/1.
const IS_CLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/review-handoff-contract.mjs');
if (IS_CLI) {
  const happy = validateHandoff(sampleReport());
  const gate = canRequestReview(happy);
  const hash = contractContentHash();
  const canonRef = { repo: CANONICAL_CONTRACT_REPO, commitSha: '0123456789abcdef0123456789abcdef01234567', path: CANONICAL_CONTRACT_PATH, contractVersion: CONTRACT_VERSION, contentHash: hash };
  const p = buildTaskPacket({ resolveRef: () => ({ resolved: true, ref: canonRef }), registryRepos: [CANONICAL_CONTRACT_REPO] });
  const bad = buildTaskPacket({ resolveRef: () => ({ resolved: true, ref: 'duongpdddic-droid/AI_PR_REVIEWER@0123 scripts/review-handoff-contract.mjs' }) });
  const tr = buildTaskPacket({ resolveRef: () => ({ resolved: false }), maxBytes: 16 });
  const out = { happy: happy.status, gate, refMode: p.mode, badMode: bad.mode, truncated: tr.ok, truncCode: tr.errors && tr.errors[0] && tr.errors[0].code };
  console.log(JSON.stringify(out));
  process.exit(happy.status === 'READY_FOR_REVIEW' && gate && p.mode === 'reference' && bad.mode === 'inline' && tr.ok === false ? 0 : 1);
}
