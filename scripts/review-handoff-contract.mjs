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

export const CONTRACT_VERSION = '1.0.0';

// Terminal status hợp lệ — report phải kết thúc bằng ĐÚNG 1 trong các giá trị này.
export const TERMINAL_STATUSES = Object.freeze(['READY_FOR_REVIEW', 'BLOCKED', 'PARTIAL_EVIDENCE']);

// HEAD SHA chuẩn: full 40-hex (khóa HEAD theo approval gate — không chấp nhận short SHA).
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

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
    findingResolution: { items: [] },
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
export function validateHandoff(report, { expectedVersion = CONTRACT_VERSION } = {}) {
  const errors = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, status: 'PARTIAL_EVIDENCE', errors: [{ code: 'INVALID_REPORT', section: null, field: null, message: 'Report không phải object' }] };
  }
  if (report.contractVersion !== expectedVersion) {
    errors.push({ code: 'CONTRACT_VERSION_MISMATCH', section: null, field: 'contractVersion', message: `contractVersion phải là ${expectedVersion}` });
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
  // Missing exact HEAD → fail-closed.
  const head = report.identity && report.identity.headSha;
  if (typeof head !== 'string' || !HEAD_SHA_RE.test(head)) {
    errors.push({ code: 'MISSING_HEAD_SHA', section: 'identity', field: 'headSha', message: 'Thiếu hoặc sai định dạng exact HEAD SHA (cần 40-hex)' });
  }
  // Test totals không kèm commands/exit code → không phải evidence.
  const ver = report.verification;
  if (ver && typeof ver === 'object') {
    const hasCmd = Array.isArray(ver.commands) && ver.commands.length > 0;
    const hasCode = Array.isArray(ver.exitCodes) && ver.exitCodes.length > 0;
    if (!hasCmd || !hasCode) {
      errors.push({ code: 'MISSING_VERIFICATION_COMMANDS', section: 'verification', field: 'commands', message: 'Test totals phải kèm commands + exit code (thiếu → không phải evidence)' });
    }
    // "All green" mâu thuẫn failure được báo → fail-closed.
    const failures = Array.isArray(ver.remainingFailures) ? ver.remainingFailures : [];
    const failCount = Number.isInteger(ver.failCount) ? ver.failCount : 0;
    const allGreenClaim = report.terminalStatus && report.terminalStatus.status === 'READY_FOR_REVIEW';
    if (allGreenClaim && (failures.length > 0 || failCount > 0)) {
      errors.push({ code: 'ALL_GREEN_WITH_FAILURE', section: 'verification', field: 'remainingFailures', message: `Báo READY_FOR_REVIEW nhưng có failure được ghi nhận (failCount=${failCount}, remainingFailures=${failures.length})` });
    }
  }
  // Terminal status bắt buộc + hợp lệ.
  const ts = report.terminalStatus && report.terminalStatus.status;
  if (typeof ts !== 'string' || !TERMINAL_STATUSES.includes(ts)) {
    errors.push({ code: 'MISSING_OR_INVALID_TERMINAL_STATUS', section: 'terminalStatus', field: 'status', message: `Terminal status phải là 1 trong [${TERMINAL_STATUSES.join(', ')}]` });
  }
  const ok = errors.length === 0;
  const status = ok ? (TERMINAL_STATUSES.includes(ts) ? ts : 'PARTIAL_EVIDENCE') : 'PARTIAL_EVIDENCE';
  return { ok, status, errors };
}

// Gate: CHỈ report READY_FOR_REVIEW mới được phép request reviewer handoff.
export function canRequestReview(validationResult) {
  return Boolean(validationResult && validationResult.ok === true && validationResult.status === 'READY_FOR_REVIEW');
}


// ---------------------------------------------------------------------------
// Task packet — inject contract vào task packet/handoff prompt (Issue #32 §Integration).
// Dedup: static contract nằm ở 1 nơi canonical; packet tham chiếu pin version khi
// runtime resolve được, ngược lại inline toàn bộ content (fail-closed nếu truncate).
// ---------------------------------------------------------------------------
export function contractContent() {
  const lines = [`REVIEW HANDOFF CONTRACT v${CONTRACT_VERSION}`, ''];
  for (const id of SECTION_IDS) {
    const def = REQUIRED_SECTIONS[id];
    lines.push(`[${id}] ${def.title} — bắt buộc: ${def.fields.join(', ')}`);
  }
  lines.push('');
  lines.push(`Terminal status (đúng 1): ${TERMINAL_STATUSES.join(' | ')}`);
  return lines.join('\n');
}

// buildTaskPacket({ resolveRef, maxBytes })
//   resolveRef: () => { resolved: true, ref } | { resolved: false } — injectable (test), không IO trực tiếp.
//   maxBytes: giới hạn inline content (mặc định 8000).
// Trả { ok, mode: 'reference'|'inline', ref?|content?, errors? }.
export function buildTaskPacket({ resolveRef = () => ({ resolved: false }), maxBytes = 8000 } = {}) {
  let resolved;
  try {
    resolved = resolveRef();
  } catch {
    resolved = { resolved: false };
  }
  if (resolved && resolved.resolved === true && typeof resolved.ref === 'string' && resolved.ref.length > 0) {
    return { ok: true, mode: 'reference', ref: resolved.ref, contractVersion: CONTRACT_VERSION };
  }
  const content = contractContent();
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    return { ok: false, mode: 'inline', errors: [{ code: 'PACKET_TRUNCATED', section: null, field: null, message: `Contract content vượt maxBytes=${maxBytes} → fail-closed (truncation)` }] };
  }
  return { ok: true, mode: 'inline', content, contractVersion: CONTRACT_VERSION };
}

// CLI tự chạy: node scripts/review-handoff-contract.mjs → self-check + exit 0/1.
const IS_CLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/review-handoff-contract.mjs');
if (IS_CLI) {
  const happy = validateHandoff(sampleReport());
  const gate = canRequestReview(happy);
  const p = buildTaskPacket({ resolveRef: () => ({ resolved: true, ref: 'duongpdddic-droid/AI_PR_REVIEWER@0123 scripts/review-handoff-contract.mjs' }) });
  const tr = buildTaskPacket({ resolveRef: () => ({ resolved: false }), maxBytes: 16 });
  const out = { happy: happy.status, gate, refMode: p.mode, ref: p.ref, truncated: tr.ok, truncCode: tr.errors && tr.errors[0] && tr.errors[0].code };
  console.log(JSON.stringify(out));
  process.exit(happy.status === 'READY_FOR_REVIEW' && gate && p.mode === 'reference' && tr.ok === false ? 0 : 1);
}

