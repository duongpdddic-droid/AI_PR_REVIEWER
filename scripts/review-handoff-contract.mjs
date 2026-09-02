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

// Category của finding — dùng để xác định finding fail-closed/mutation phải kèm negative assertion.
export const FINDING_CATEGORIES = Object.freeze(['type', 'failClosed', 'mutation']);

// Status finding mà evidence (code + test) là BẮT BUỘC; 'unresolved' không cần evidence.
export const FIXED_DISPUTED_STATUSES = Object.freeze(['fixed', 'disputed']);

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
  {
    code: 'CODE_EVIDENCE_NOT_DOCS_ONLY',
    section: 'codeEvidence',
    description: 'Ít nhất 1 mục code evidence phải là source code thật (file thực thi), không chỉ docs (.md/.txt/.html) — docs-only không phải code evidence để reviewer đánh giá offline',
    check: (r) => {
      const items = r.codeEvidence?.items;
      if (!Array.isArray(items) || items.length === 0) return false;
      return items.some((it) => it && typeof it.file === 'string' && !/\.(md|txt|html?|adoc|rst|csv)$/i.test(it.file));
    },
    message: 'codeEvidence chỉ gồm docs (không có source code thật) → không review offline được',
  },
  {
    code: 'FINDING_RESOLUTION_EVIDENCE_REQUIRED',
    section: 'findingResolution',
    description: 'Finding fixed|disputed phải liên kết code evidence (file + symbol/function/export) và test evidence cụ thể (name + location); finding loại failClosed/mutation phải kèm negativeAssertion/no-mutation evidence',
    check: (r) => {
      const items = r.findingResolution?.items;
      if (!Array.isArray(items) || items.length === 0) return false;
      return items.every((it) => {
        if (!it || typeof it !== 'object') return false;
        if (!FIXED_DISPUTED_STATUSES.includes(it.status)) return true; // unresolved không cần evidence
        const ev = it.evidence;
        if (!ev || typeof ev !== 'object') return false;
        const ce = Array.isArray(ev.codeEvidence) ? ev.codeEvidence : [];
        const te = Array.isArray(ev.testEvidence) ? ev.testEvidence : [];
        if (ce.length === 0 || te.length === 0) return false;
        const ceOk = ce.every((c) => c && typeof c === 'object' && typeof c.file === 'string' && typeof c.symbol === 'string');
        const teOk = te.every((t) => t && typeof t === 'object' && typeof t.name === 'string' && typeof t.location === 'string');
        if (!ceOk || !teOk) return false;
        // finding fail-closed/mutation (category) → bắt buộc negative assertion cụ thể
        if (it.category === 'failClosed' || it.category === 'mutation') {
          const negOk = te.some((t) => typeof t.negativeAssertion === 'string'
            && t.negativeAssertion.trim() !== ''
            && !/^(n\/?a|none|not applied|not applicable|[-—\s]*)$/i.test(t.negativeAssertion.trim()));
          if (!negOk) return false;
        }
        return true;
      });
    },
    message: 'Finding fixed/disputed thiếu code evidence (file+symbol) hoặc test evidence (name+location), hoặc finding failClosed/mutation thiếu negative assertion cụ thể',
  },
  {
    code: 'TESTS_NO_AGGREGATE_ONLY',
    section: 'tests',
    description: 'Không chấp nhận tổng test count (vd "108 PASS") hoặc chuỗi chung chung làm evidence duy nhất — mỗi tests item phải có setup + assertion cụ thể (không phải format số đếm)',
    check: (r) => {
      const items = r.tests?.items;
      if (!Array.isArray(items) || items.length === 0) return false;
      const AGG = /^\s*\d+\s*(\/\s*\d+)?\s*(PASS|FAIL|OK)\s*$/i;
      return items.every((it) => {
        if (!it || typeof it !== 'object') return false;
        const setup = typeof it.setup === 'string' ? it.setup.trim() : '';
        if (setup === '' || AGG.test(setup)) return false;
        const assertions = Array.isArray(it.assertions) ? it.assertions : [];
        if (assertions.length === 0) return false;
        if (assertions.every((a) => typeof a === 'string' && AGG.test(a))) return false;
        if (typeof it.location !== 'string' || it.location.trim() === '') return false;
        return true;
      });
    },
    message: 'tests phải có setup + assertion cụ thể (không dùng tổng count / chuỗi chung chung làm evidence duy nhất)',
  },
  {
    code: 'VERIFICATION_NONZERO_EXIT',
    section: 'verification',
    description: 'READY_FOR_REVIEW bị chặn nếu bất kỳ exitCode trong verification khác 0 (command failure) — không gọi all-green khi còn nonzero exit',
    check: (r) => {
      const v = r.verification ?? {};
      const codes = Array.isArray(v.exitCodes) ? v.exitCodes : [];
      const allGreen = r.terminalStatus?.status === 'READY_FOR_REVIEW';
      return !(allGreen && codes.some((c) => Number(c) !== 0));
    },
    message: 'READY_FOR_REVIEW nhưng có exit code khác 0 trong verification (command failure)',
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
    findingResolution: { items: [{ findingId: 'GPT-REV-000', severity: 'low', status: 'fixed', rootCause: 'n/a', fix: 'n/a (baseline)', category: 'type', evidence: { codeEvidence: [{ file: 'scripts/review-handoff-contract.mjs', symbol: 'validateHandoff' }], testEvidence: [{ name: 'happy path: report đủ 10 section → READY_FOR_REVIEW', location: 'scripts/test-review-handoff-contract.mjs', negativeAssertion: 'errors empty' }] } }] },
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
// GPT-REV-124 — incremental report chain: resolve previous report ref + verify
// digest/HEAD/identity/cycle, rồi hợp nhất evidence trước khi validate.
// Pure logic, ZERO IO — resolver được inject (server cung cấp IO qua gh).
// ---------------------------------------------------------------------------
const PREV_REPORT_REF_FIELDS = Object.freeze(['repo', 'issue', 'pr', 'commentId', 'headSha', 'reportDigest']);

export function verifyPreviousReportRef(report, { resolvePreviousReport, currentDigest = null } = {}) {
  const ref = report && typeof report === 'object' ? report.previousReportRef : undefined;
  if (ref === undefined || ref === null) {
    return { ok: true, incremental: false, previousReport: null, errors: [] };
  }
  if (typeof ref !== 'object' || Array.isArray(ref)) {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_REF_INVALID', section: 'previousReportRef', field: null, message: 'previousReportRef phải là structured object { repo, issue, pr, commentId, headSha, reportDigest }' }] };
  }
  const missing = PREV_REPORT_REF_FIELDS.filter((f) => ref[f] === undefined || ref[f] === null);
  if (missing.length > 0) {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_REF_INCOMPLETE', section: 'previousReportRef', field: missing.join(','), message: `previousReportRef thiếu ${missing.join(', ')}` }] };
  }
  if (typeof ref.headSha !== 'string' || !HEAD_SHA_RE.test(ref.headSha)) {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_HEAD_INVALID', section: 'previousReportRef', field: 'headSha', message: 'previousReportRef.headSha phải là full 40-hex (exact HEAD)' }] };
  }
  if (typeof ref.reportDigest !== 'string' || !/^[0-9a-f]{64}$/.test(ref.reportDigest)) {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_DIGEST_INVALID', section: 'previousReportRef', field: 'reportDigest', message: 'previousReportRef.reportDigest phải là 64-hex' }] };
  }
  let resolved = null;
  try {
    resolved = typeof resolvePreviousReport === 'function' ? resolvePreviousReport(ref) : null;
  } catch {
    resolved = null;
  }
  if (!resolved || resolved.resolved !== true || !resolved.report || typeof resolved.report !== 'object') {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_UNRESOLVED', section: 'previousReportRef', field: null, message: `Không resolve được previous report (ref: ${ref.repo}#${ref.issue} comment ${ref.commentId}) → fail-closed` }] };
  }
  const prev = resolved.report;
  const actualDigest = reportDigest(prev);
  if (actualDigest !== ref.reportDigest) {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_DIGEST_MISMATCH', section: 'previousReportRef', field: 'reportDigest', message: `Digest previous report ${actualDigest} ≠ ref ${ref.reportDigest}` }] };
  }
  const prevId = prev.identity ?? {};
  if (prevId.repository !== ref.repo || prevId.issue !== ref.issue || prevId.pullRequest !== ref.pr) {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_IDENTITY_MISMATCH', section: 'previousReportRef', field: 'identity', message: `Previous report identity không khớp ref (repo/issue/pr)` }] };
  }
  if (prevId.headSha !== ref.headSha) {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_HEAD_MISMATCH', section: 'previousReportRef', field: 'headSha', message: `Previous report HEAD ${prevId.headSha} ≠ ref ${ref.headSha} (stale/wrong ref)` }] };
  }
  const curDigest = currentDigest !== null ? currentDigest : reportDigest(report);
  const prevPrev = prev.previousReportRef;
  if (prevPrev && typeof prevPrev === 'object' && prevPrev.reportDigest === curDigest) {
    return { ok: false, incremental: true, previousReport: null, errors: [{ code: 'PREVIOUS_REPORT_CYCLE', section: 'previousReportRef', field: null, message: `Phát hiện reference cycle: previous report trỏ ngược về chính digest hiện tại ${curDigest}` }] };
  }
  return { ok: true, incremental: true, previousReport: prev, errors: [] };
}

// ---------------------------------------------------------------------------
// Hợp nhất evidence của previous report vào report hiện tại (current thắng, previous bổ sung
// phần chưa có) theo findingId/code-symbol/test-name. Dùng cho incremental report để đảm bảo
// review chain hiện hành đầy đủ evidence mà KHÔNG bắt lặp toàn bộ lịch sử.
export function mergeIncrementalEvidence(report, previousReport) {
  if (!previousReport || typeof previousReport !== 'object') return report;
  const out = { ...report };
  const curFindings = Array.isArray(report.findingResolution?.items) ? report.findingResolution.items : [];
  const prevFindings = Array.isArray(previousReport.findingResolution?.items) ? previousReport.findingResolution.items : [];
  const findingIds = new Set(curFindings.map((f) => f && f.findingId));
  const mergedFindings = [...curFindings];
  for (const pf of prevFindings) {
    if (pf && !findingIds.has(pf.findingId)) mergedFindings.push(pf);
  }
  if (mergedFindings.length > 0) out.findingResolution = { items: mergedFindings };

  const curCode = Array.isArray(report.codeEvidence?.items) ? report.codeEvidence.items : [];
  const prevCode = Array.isArray(previousReport.codeEvidence?.items) ? previousReport.codeEvidence.items : [];
  const codeKeys = new Set(curCode.map((c) => c && `${c.file}::${c.symbol}`));
  const mergedCode = [...curCode];
  for (const pc of prevCode) {
    const k = pc && `${pc.file}::${pc.symbol}`;
    if (k && !codeKeys.has(k)) mergedCode.push(pc);
  }
  if (mergedCode.length > 0) out.codeEvidence = { items: mergedCode };

  const curTests = Array.isArray(report.tests?.items) ? report.tests.items : [];
  const prevTests = Array.isArray(previousReport.tests?.items) ? previousReport.tests.items : [];
  const testKeys = new Set(curTests.map((t) => t && `${t.name}::${t.location}`));
  const mergedTests = [...curTests];
  for (const pt of prevTests) {
    const k = pt && `${pt.name}::${pt.location}`;
    if (k && !testKeys.has(k)) mergedTests.push(pt);
  }
  if (mergedTests.length > 0) out.tests = { items: mergedTests };

  const curRisks = Array.isArray(report.unverifiedRisks?.items) ? report.unverifiedRisks.items : [];
  const prevRisks = Array.isArray(previousReport.unverifiedRisks?.items) ? previousReport.unverifiedRisks.items : [];
  const mergedRisks = [...curRisks];
  for (const pr of prevRisks) {
    if (typeof pr === 'string' && !curRisks.includes(pr)) mergedRisks.push(pr);
  }
  out.unverifiedRisks = { items: mergedRisks };
  return out;
}

// ---------------------------------------------------------------------------
// GPT-REV-125 — finding marker schema + authoritative finding set (pure, IO-injected).
// Server derive authoritative expected findings cho exact repo/PR/HEAD từ canonical review state
// (structured review markers do reviewer authority hợp lệ tạo); caller KHÔNG quyết định tập finding.
// ---------------------------------------------------------------------------

// Finding code format theo policy reviewerCoderContract.findingCodeFormat: (GPT|LOCAL)-REV-NNN
// hoặc (GPT|LOCAL)-RULE-NNN. Không hard-code ID cụ thể.
export const FINDING_ID_RE = /^\[?(GPT|LOCAL)-(REV|RULE)-\d{3}\]?$/;

// Policy findingRequiredFields: severity/evidence/risk/expectedOutcome. Marker thiếu → malformed,
// KHÔNG được coi là finding authoritative (không scrape chuỗi GPT-REV-* tùy ý).
export const FINDING_REQUIRED_FIELDS = Object.freeze(['severity', 'evidence', 'risk', 'expectedOutcome']);

// Trạng thái đóng/withdraw — finding ở trạng thái này KHÔNG còn là mục tiêu bắt buộc resolve.
// By-authority chỉ có thể hạ finding bằng trạng thái này, không tự biến mất.
export const FINDING_TERMINAL_STATES = Object.freeze(['withdrawn', 'superseded', 'resolved', 'closed', 'accepted']);

// 'GPT-REV-118' → 'gpt' (authority key trong policy approvalAuthorities).
export function findingType(id) {
  const m = String(id).match(FINDING_ID_RE);
  return m ? m[1].toLowerCase() : null;
}

// Parse một review comment body → danh sách finding structured (VALID) + error.
// Chỉ chấp nhận block có header [XX-REV-NNN] + đủ FINDING_REQUIRED_FIELDS. Chuỗi GPT-REV-* lẻ loi
// (không đủ schema) → malformed → KHÔNG authoritative. Không scrape tùy ý.
export function parseReviewComment(body, { commentId = null, author = null, ts = null } = {}) {
  const findings = [];
  const errors = [];
  if (typeof body !== 'string') return { findings, errors: [{ code: 'REVIEW_COMMENT_NOT_STRING' }] };
  // Tách comment thành block bằng dòng heading [XX-REV-NNN] / [XX-RULE-NNN].
  const blocks = body.split(/\r?\n(?=\[(?:GPT|LOCAL)-(?:REV|RULE)-\d{3}\])/);
  for (const block of blocks) {
    const header = block.match(/\[(GPT|LOCAL)-(REV|RULE)-\d{3}\]/);
    if (!header) continue;
    const id = header[0].replace(/^\[|\]$/g, '');
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z][A-Za-z ]*):\s*(.*?)\s*$/);
      if (m) fields[m[1].trim().toLowerCase().replace(/\s+/g, '')] = m[2].trim();
    }
    const severity = fields['severity'];
    const evidence = fields['evidence'];
    const risk = fields['risk'];
    const expectedOutcome = fields['expectedoutcome'];
    const status = (fields['status'] || 'open').toLowerCase();
    if (severity === undefined || evidence === undefined || risk === undefined || expectedOutcome === undefined) {
      errors.push({ code: 'MALFORMED_FINDING_MARKER', findingId: id });
      continue; // malformed → không authoritative
    }
    findings.push({
      id, type: header[1].toLowerCase(),
      severity, evidence, risk, expectedOutcome, status,
      author, ts, commentId,
    });
  }
  return { findings, errors };
}

// Derive tập finding ID đang ACTIVE (bắt buộc resolve) từ list finding parsed + authority allowlist.
// authority = { gpt:[login], local:[login] } (từ policy approvalAuthorities) — reviewer principal có
// quyền tạo finding. Finding do actor KHÔNG có authority → bị bỏ qua (không authoritative).
// Finding ở FINDING_TERMINAL_STATES → loại khỏi active set (withdraw/superseded có authority).
// Fail-closed (GPT-REV-127): authority vắng/hỏng → AUTHORITY_UNAVAILABLE; gpt=[] và local=[] (empty
// allowlist) KHÔNG được coi là thành công rỗng → AUTHORITY_UNAVAILABLE; có finding type nhưng authority
// cho type đó rỗng → AUTHORITY_UNAVAILABLE; mọi finding đều do actor KHÔNG có authority tạo (unauthorized
// only) → AUTHORITY_UNAVAILABLE. KHÔNG silent drop review entries rồi coi authoritative set rỗng là ok.
export function canonicalActiveFindings(entries, { authority = null } = {}) {
  const errors = [];
  const typed = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || !e.id) continue;
    const t = findingType(e.id);
    if (!t) { errors.push({ code: 'FINDING_ID_UNKNOWN', findingId: String(e.id) }); continue; }
    typed.push({ ...e, type: t });
  }
  if (typed.length > 0) {
    // Authority bắt buộc hợp lệ (gpt + local đều là array) khi có finding để phân loại principal.
    const authorityValid = authority && typeof authority === 'object'
      && Array.isArray(authority.gpt) && Array.isArray(authority.local);
    if (!authorityValid) {
      return { ok: false, findings: [], errors: [{ code: 'AUTHORITY_UNAVAILABLE', message: 'Không có authority allowlist (gpt/local) để xác định reviewer principal của finding (fail-closed)' }] };
    }
    // Empty allowlist (gpt=[] và local=[]) → không reviewer principal có quyền → fail-closed.
    if (authority.gpt.length === 0 && authority.local.length === 0) {
      return { ok: false, findings: [], errors: [{ code: 'AUTHORITY_UNAVAILABLE', message: 'Authority allowlist rỗng (gpt=[] và local=[]) → không reviewer principal hợp lệ (fail-closed)' }] };
    }
    // Missing authority theo finding type (có finding 'gpt' nhưng authority.gpt rỗng) → fail-closed.
    for (const t of ['gpt', 'local']) {
      if (typed.some((e) => e.type === t) && authority[t].length === 0) {
        errors.push({ code: 'AUTHORITY_UNAVAILABLE', message: `Authority '${t}' rỗng nhưng có finding type '${t}' → fail-closed (không silent drop)` });
      }
    }
    // Nếu đã có error type-specific → fail-closed ngay (không đưa ra set rỗng).
    if (errors.some((e) => e.code === 'AUTHORITY_UNAVAILABLE')) {
      return { ok: false, findings: [], errors };
    }
    // Sắp theo thứ tự xuất hiện (comments theo thời gian) → trạng thái cuối cùng (withdraw) thắng.
    const latest = new Map();
    const byType = { gpt: new Set(authority.gpt), local: new Set(authority.local) };
    for (const e of typed) {
      const allow = byType[e.type];
      if (!allow || !allow.has(e.author)) continue; // actor không có reviewer authority → không authoritative
      latest.set(e.id, e.status); // giữ trạng thái cuối
    }
    // Unauthorized-only: có finding hợp lệ nhưng KHÔNG finding nào do actor có quyền tạo → fail-closed.
    if (latest.size === 0) {
      errors.push({ code: 'AUTHORITY_UNAVAILABLE', message: 'Mọi finding đều do actor KHÔNG có reviewer authority tạo → không xác định được authoritative set (fail-closed)' });
      return { ok: false, findings: [], errors };
    }
    const active = [];
    for (const [id, status] of latest) {
      if (!FINDING_TERMINAL_STATES.includes(status)) active.push(id);
    }
    return { ok: true, findings: active.sort(), errors };
  }
  // Không có finding nào trong review state (typed rỗng) → empty authoritative set là hợp lệ.
  return { ok: true, findings: [], errors };
}

// So sánh 2 tập finding ID bằng nhau (không quan tâm thứ tự, dedupe) — dùng cho caller assertion.
export function sameFindingSet(a, b) {
  const sa = new Set((Array.isArray(a) ? a : []).map(String));
  const sb = new Set((Array.isArray(b) ? b : []).map(String));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Validator — trả { ok, status, errors: [{ code, section, field, message }] }.
// Fail-closed: bất kỳ lỗi nào → status PARTIAL_EVIDENCE (không bao giờ READY_FOR_REVIEW).
// GPT-REV-124: nếu report khai previousReportRef và resolvePreviousReport được cấp → resolve +
// verify digest/HEAD/identity/cycle + hợp nhất evidence TRƯỚC mọi check; lỗi chain → fail-closed.
// expectedFindings (array findingId) = review/finding context hiện hành: mọi finding bắt buộc phải
// có resolution trong chain (không hard-code ID).
// ---------------------------------------------------------------------------
export function validateHandoff(report, { expectedVersion = CONTRACT_VERSION, registeredRepos = null, authoritativeFindings = null, resolvePreviousReport = null } = {}) {
  const errors = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, status: 'PARTIAL_EVIDENCE', errors: [{ code: 'INVALID_REPORT', section: null, field: null, message: 'Report không phải object' }] };
  }
  // GPT-REV-124 — incremental chain: nếu report khai previousReportRef và resolver được cấp →
  // resolve + verify digest/HEAD/identity/cycle rồi hợp nhất evidence TRƯỚC mọi check; lỗi chain
  // → fail-closed (không merge, KHÔNG READY_FOR_REVIEW).
  let working = report;
  if (typeof resolvePreviousReport === 'function' && report && report.previousReportRef) {
    const chain = verifyPreviousReportRef(report, { resolvePreviousReport });
    if (!chain.ok) {
      return { ok: false, status: 'PARTIAL_EVIDENCE', errors: chain.errors };
    }
    working = mergeIncrementalEvidence(report, chain.previousReport);
  }
  if (working.contractVersion !== expectedVersion) {
    errors.push({ code: 'CONTRACT_VERSION_MISMATCH', section: null, field: 'contractVersion', message: `contractVersion phải là ${expectedVersion}` });
  }
  // Cross-repository (Issue #32): target repo phải thuộc registry được phép —
  // repo chưa đăng ký / lạ → fail-closed (unknown/unregistered repository).
  if (Array.isArray(registeredRepos)) {
    const repo = working.identity && working.identity.repository;
    if (typeof repo !== 'string' || !registeredRepos.includes(repo)) {
      errors.push({ code: 'UNKNOWN_REPOSITORY', section: 'identity', field: 'repository', message: `Repository chưa đăng ký hoặc không được phép: ${String(repo)}` });
    }
  }
  for (const id of SECTION_IDS) {
    const def = REQUIRED_SECTIONS[id];
    const value = working[id];
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
      if (!rule.check(working)) {
        errors.push({ code: rule.code, section: rule.section, field: rule.section, message: rule.message });
      }
    } catch {
      errors.push({ code: rule.code, section: rule.section, field: rule.section, message: `${rule.message} (exception khi check)` });
    }
  }
  // GPT-REV-126: authoritative context BẮT BUỘC — omitted/undefined/null → fail-closed.
  // KHÔNG được READY_FOR_REVIEW khi thiếu authoritativeFindings (không schema-only lọt qua gate).
  if (!Array.isArray(authoritativeFindings)) {
    errors.push({ code: 'AUTHORITATIVE_FINDINGS_REQUIRED', section: 'findingResolution', field: 'authoritativeFindings', message: 'authoritativeFindings bắt buộc (mảng) khi validate handoff — omitted/undefined/null → fail-closed' });
  }
  // GPT-REV-125 — authoritative finding set (server derive từ canonical review state, KHÔNG tin caller):
  // mọi finding bắt buộc phải được resolve ĐÚNG tập authoritative (không subset/superset/duplicate/unknown).
  if (Array.isArray(authoritativeFindings)) {
    const items = working.findingResolution?.items ?? [];
    const ids = items.map((it) => it && it.findingId).filter((x) => typeof x === 'string' && x !== '');
    // ID-shape gate: mọi findingId trong authoritative set phải khớp FINDING_ID_RE
    // (GPT-REV-125) — caller KHÔNG được nhét finding tùy ý vào authoritative chain.
    for (const fid of authoritativeFindings) {
      if (typeof fid !== 'string' || !FINDING_ID_RE.test(fid)) {
        errors.push({ code: 'FINDING_ID_UNKNOWN', section: 'findingResolution', field: 'findingId', message: `Finding ${fid} trong authoritative set không khớp FINDING_ID_RE (GPT|LOCAL)-(REV|RULE)-\\d{3}` });
      }
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !FINDING_ID_RE.test(id)) {
        errors.push({ code: 'FINDING_ID_UNKNOWN', section: 'findingResolution', field: 'findingId', message: `Finding ${id} trong findingResolution không khớp FINDING_ID_RE (GPT|LOCAL)-(REV|RULE)-\\d{3}` });
      }
    }
    const authSet = new Set(authoritativeFindings);
    const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    for (const d of dup) {
      errors.push({ code: 'FINDING_RESOLUTION_DUPLICATE', section: 'findingResolution', field: 'findingId', message: `Finding ${d} xuất hiện nhiều lần trong findingResolution (duplicate → fail-closed)` });
    }
    for (const fid of authoritativeFindings) {
      if (!ids.includes(fid)) {
        errors.push({ code: 'UNRESOLVED_FINDING_IN_CHAIN', section: 'findingResolution', field: 'findingId', message: `Finding ${fid} (authoritative) chưa được resolve trong findingResolution (bắt buộc thuộc review chain hiện hành)` });
      }
    }
    for (const id of ids) {
      if (!authSet.has(id)) {
        errors.push({ code: 'UNRESOLVED_EXTRA_FINDING', section: 'findingResolution', field: 'findingId', message: `Finding ${id} nằm ngoài authoritative set (superset → fail-closed)` });
      }
    }
  }
  const ok = errors.length === 0;
  const ts = working.terminalStatus && working.terminalStatus.status;
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
