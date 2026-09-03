#!/usr/bin/env node
// test-review-handoff-contract.mjs — Unit test Canonical REVIEW HANDOFF CONTRACT (Issue #32).
// Exit 0 = PASS, 1 = FAIL. ZERO IO — chỉ import pure module.
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION, TERMINAL_STATUSES, SECTION_IDS, REQUIRED_SECTIONS,
  sampleReport, validateHandoff, canRequestReview, contractContent, buildTaskPacket,
  verifyHandoffIdentity, validateCanonicalRef, contractContentHash, reportDigest,
  verifyPreviousReportRef, mergeIncrementalEvidence,
  CANONICAL_CONTRACT_PATH, CANONICAL_CONTRACT_REPO,
  FINDING_ID_RE, FINDING_REQUIRED_FIELDS, FINDING_TERMINAL_STATES,
  findingType, parseReviewComment, canonicalActiveFindings, sameFindingSet,
} from './review-handoff-contract.mjs';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// Helper: bỏ section/field để tạo report thiếu evidence.
const drop = (report, section) => { const r = { ...report, [section]: undefined }; return r; };
const dropField = (report, section, field) => {
  const r = { ...report, [section]: { ...report[section], [field]: undefined } };
  return r;
};

test('happy path: report đủ 10 section + authoritative context → READY_FOR_REVIEW + canRequestReview=true', () => {
  const r = validateHandoff(sampleReport(), { authoritativeFindings: ['GPT-REV-000'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'READY_FOR_REVIEW');
  assert.deepEqual(r.errors, []);
  assert.equal(canRequestReview(r), true);
});

test('CONTRACT_VERSION cố định + nằm trong report mẫu', () => {
  assert.equal(typeof CONTRACT_VERSION, 'string');
  assert.match(CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(sampleReport().contractVersion, CONTRACT_VERSION);
});

test('schema đủ 10 section theo Issue #32', () => {
  const expected = ['identity', 'scope', 'codeEvidence', 'findingResolution', 'tests', 'verification', 'safety', 'unverifiedRisks', 'delivery', 'terminalStatus'];
  assert.deepEqual(SECTION_IDS, expected);
  assert.equal(Object.keys(REQUIRED_SECTIONS).length, 10);
});

test('TERMINAL_STATUSES đúng 3 giá trị canonical', () => {
  assert.deepEqual(TERMINAL_STATUSES, ['READY_FOR_REVIEW', 'BLOCKED', 'PARTIAL_EVIDENCE']);
});

// Mỗi required section thiếu ĐỘC LẬP → không thể pass.
for (const id of SECTION_IDS) {
  test(`missing section ${id} → PARTIAL_EVIDENCE, có MISSING_SECTION`, () => {
    const r = validateHandoff(drop(sampleReport(), id));
    assert.equal(r.ok, false);
    assert.equal(r.status, 'PARTIAL_EVIDENCE');
    assert.ok(r.errors.some((e) => e.code === 'MISSING_SECTION' && e.section === id), `thiếu error MISSING_SECTION:${id}`);
  });
}

test('missing exact HEAD SHA → PARTIAL_EVIDENCE (MISSING_HEAD_SHA)', () => {
  const r1 = validateHandoff(dropField(sampleReport(), 'identity', 'headSha'));
  assert.equal(r1.status, 'PARTIAL_EVIDENCE');
  assert.ok(r1.errors.some((e) => e.code === 'MISSING_HEAD_SHA'));
  const r2 = validateHandoff(sampleReport({ identity: { headSha: 'abc123' } }));
  assert.equal(r2.status, 'PARTIAL_EVIDENCE');
  assert.ok(r2.errors.some((e) => e.code === 'MISSING_HEAD_SHA'), 'short SHA không phải exact HEAD');
});

test('test totals thiếu commands/exit code → PARTIAL_EVIDENCE (MISSING_VERIFICATION_COMMANDS)', () => {
  const r1 = validateHandoff(dropField(sampleReport(), 'verification', 'commands'));
  assert.equal(r1.status, 'PARTIAL_EVIDENCE');
  assert.ok(r1.errors.some((e) => e.code === 'MISSING_VERIFICATION_COMMANDS'));
  const r2 = validateHandoff(dropField(sampleReport(), 'verification', 'exitCodes'));
  assert.equal(r2.status, 'PARTIAL_EVIDENCE');
  assert.ok(r2.errors.some((e) => e.code === 'MISSING_VERIFICATION_COMMANDS'));
});

test('"all green" nhưng có failure được báo → PARTIAL_EVIDENCE (ALL_GREEN_WITH_FAILURE)', () => {
  const r = validateHandoff(sampleReport({
    verification: { failCount: 2, remainingFailures: ['test-x FAIL'] },
  }));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'ALL_GREEN_WITH_FAILURE'));
});

test('missing safety/mutation analysis → PARTIAL_EVIDENCE', () => {
  const r = validateHandoff(drop(sampleReport(), 'safety'));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'MISSING_SECTION' && e.section === 'safety'));
});

test('missing unverified-risks section → PARTIAL_EVIDENCE', () => {
  const r = validateHandoff(drop(sampleReport(), 'unverifiedRisks'));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'MISSING_SECTION' && e.section === 'unverifiedRisks'));
});

test('missing/invalid terminal status → PARTIAL_EVIDENCE (MISSING_OR_INVALID_TERMINAL_STATUS)', () => {
  const r1 = validateHandoff(drop(sampleReport(), 'terminalStatus'));
  assert.equal(r1.status, 'PARTIAL_EVIDENCE');
  assert.ok(r1.errors.some((e) => e.code === 'MISSING_OR_INVALID_TERMINAL_STATUS'));
  const r2 = validateHandoff(sampleReport({ terminalStatus: { status: 'DONE' } }));
  assert.equal(r2.status, 'PARTIAL_EVIDENCE');
  assert.ok(r2.errors.some((e) => e.code === 'MISSING_OR_INVALID_TERMINAL_STATUS'));
});

test('report không phải object → INVALID_REPORT fail-closed', () => {
  const r = validateHandoff(null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.equal(r.errors[0].code, 'INVALID_REPORT');
});

test('contractVersion mismatch → PARTIAL_EVIDENCE (CONTRACT_VERSION_MISMATCH)', () => {
  const r = validateHandoff(sampleReport({ contractVersion: '9.9.9' }));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'CONTRACT_VERSION_MISMATCH'));
});

test('BLOCKED hợp lệ khi report đầy đủ + status=BLOCKED → canRequestReview=false', () => {
  const r = validateHandoff(sampleReport({ terminalStatus: { status: 'BLOCKED' } }), { authoritativeFindings: ['GPT-REV-000'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(canRequestReview(r), false, 'BLOCKED không được request review');
});

test('PARTIAL_EVIDENCE không transition sang review-requested (gate chặn)', () => {
  const r = validateHandoff(drop(sampleReport(), 'safety'));
  assert.equal(canRequestReview(r), false);
  const invalid = validateHandoff(sampleReport({ terminalStatus: { status: 'PARTIAL_EVIDENCE' } }));
  assert.equal(canRequestReview(invalid), false);
});

test('mọi error đều có structured { code, section, field, message }', () => {
  const r = validateHandoff(drop(sampleReport(), 'codeEvidence'));
  for (const e of r.errors) {
    assert.ok(typeof e.code === 'string' && e.code.length > 0);
    assert.ok('section' in e && 'field' in e && typeof e.message === 'string');
  }
});

test('buildTaskPacket resolve được reference → mode=reference, bounded, không copy nội dung', () => {
  const p = buildTaskPacket({
    resolveRef: () => ({ resolved: true, ref: canonRef(CANONICAL_CONTRACT_REPO) }),
    registryRepos: [CANONICAL_CONTRACT_REPO],
  });
  assert.equal(p.ok, true);
  assert.equal(p.mode, 'reference');
  assert.equal(p.contractVersion, CONTRACT_VERSION);
  assert.equal(p.ref.repo, CANONICAL_CONTRACT_REPO);
  assert.ok(!p.content, 'reference mode không mang full content (bounded payload)');
});

test('không resolve được reference → inline toàn bộ content', () => {
  const p = buildTaskPacket({ resolveRef: () => ({ resolved: false }) });
  assert.equal(p.ok, true);
  assert.equal(p.mode, 'inline');
  assert.ok(typeof p.content === 'string' && p.content.includes(`v${CONTRACT_VERSION}`));
});

test('packet truncation (content vượt maxBytes) → fail-closed PACKET_TRUNCATED', () => {
  const p = buildTaskPacket({ resolveRef: () => ({ resolved: false }), maxBytes: 16 });
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => e.code === 'PACKET_TRUNCATED'));
});

test('contractContent chứa đủ 10 section + terminal status', () => {
  const c = contractContent();
  for (const id of SECTION_IDS) {
    assert.ok(c.includes(`[${id}]`), `contractContent thiếu section [${id}]`);
  }
  for (const ts of TERMINAL_STATUSES) {
    assert.ok(c.includes(ts));
  }
});


// ---------------------------------------------------------------------------
// Cross-repository (Issue #32 mandatory) — fixtures project-registry.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const FX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'project-registry');
const fxRepo = (name) => JSON.parse(readFileSync(path.join(FX_DIR, name), 'utf8')).repository;

const REPO_AIPR = fxRepo('ai-pr-reviewer.json');
const REPO_QLDA = fxRepo('qlda-dtxd.json');
const REPO_UNKNOWN = 'example-org/not-registered';

const HASH = contractContentHash();
const canonRef = (repo, overrides = {}) => ({
  repo,
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  path: CANONICAL_CONTRACT_PATH,
  contractVersion: CONTRACT_VERSION,
  contentHash: HASH,
  ...overrides,
});
const resolveCanon = (repo) => () => ({ resolved: true, ref: canonRef(repo) });

test('2 fixtures repo khác nhau nhận cùng pinned canonical contract version', () => {
  const reg = [REPO_AIPR, REPO_QLDA];
  const pa = buildTaskPacket({ resolveRef: resolveCanon(REPO_AIPR), registryRepos: reg });
  const pq = buildTaskPacket({ resolveRef: resolveCanon(REPO_QLDA), registryRepos: reg });
  assert.equal(pa.mode, 'reference');
  assert.equal(pq.mode, 'reference');
  assert.equal(pa.contractVersion, CONTRACT_VERSION);
  assert.equal(pq.contractVersion, CONTRACT_VERSION);
  assert.equal(pa.contractVersion, pq.contractVersion, 'cùng pinned version cho mọi repo');
  assert.equal(pa.ref.repo, REPO_AIPR);
  assert.equal(pq.ref.repo, REPO_QLDA);
});

test('target-repo handoff đủ evidence pass KHÔNG cần contract bản sao trong repo đó', () => {
  const reg = [REPO_AIPR, REPO_QLDA];
  const report = sampleReport({ identity: { repository: REPO_QLDA } });
  const r = validateHandoff(report, { registeredRepos: reg, authoritativeFindings: ['GPT-REV-000'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'READY_FOR_REVIEW');
  assert.equal(canRequestReview(r), true);
  // reference-mode packet không mang full content → không cần copy contract vào target repo
  const p = buildTaskPacket({ resolveRef: resolveCanon(REPO_QLDA), registryRepos: reg });
  assert.ok(!p.content);
});

test('unknown/unregistered repository → fail-closed UNKNOWN_REPOSITORY', () => {
  const reg = [REPO_AIPR, REPO_QLDA];
  const report = sampleReport({ identity: { repository: REPO_UNKNOWN } });
  const r = validateHandoff(report, { registeredRepos: reg });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'UNKNOWN_REPOSITORY'));
  assert.equal(canRequestReview(r), false);
});

test('contract-version mismatch trong packet → fail-closed (validate theo expectedVersion)', () => {
  const report = sampleReport({ contractVersion: '9.9.9' });
  const r = validateHandoff(report, { registeredRepos: [REPO_AIPR] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'CONTRACT_VERSION_MISMATCH'));
});

test('unresolved contract reference → fallback inline + truncation fail-closed', () => {
  const unresolved = buildTaskPacket({ resolveRef: () => ({ resolved: false }) });
  assert.equal(unresolved.ok, true);
  assert.equal(unresolved.mode, 'inline');
  const truncated = buildTaskPacket({ resolveRef: () => ({ resolved: false }), maxBytes: 16 });
  assert.equal(truncated.ok, false);
  assert.ok(truncated.errors.some((e) => e.code === 'PACKET_TRUNCATED'));
});

test('updating canonical contract không đổi packet đã cấp (bound pinned version)', () => {
  // Packet cấp với version hiện tại — contractVersion cố định trong packet.
  const issued = buildTaskPacket({ resolveRef: resolveCanon(REPO_AIPR), registryRepos: [REPO_AIPR] });
  assert.equal(issued.contractVersion, CONTRACT_VERSION);
  // Mô phỏng canonical đã nâng version lên 2.0.0: packet cũ vẫn giữ version 1.0.0 của nó.
  assert.notEqual(issued.contractVersion, '2.0.0');
  // Validator dùng expectedVersion 2.0.0 phải reject report cũ (mismatch) — không ngấm ngầm pass.
  const r = validateHandoff(sampleReport({ contractVersion: issued.contractVersion }), { expectedVersion: '2.0.0' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'CONTRACT_VERSION_MISMATCH'));
});


// ---------------------------------------------------------------------------
// GPT-REV-121 — canonical reference pin (KHÔNG chấp nhận arbitrary ref).
// ---------------------------------------------------------------------------
const FULL_SHA = '0123456789abcdef0123456789abcdef01234567';

test('validateCanonicalRef: ref hợp lệ (full pin) → ok', () => {
  const v = validateCanonicalRef(canonRef(CANONICAL_CONTRACT_REPO), { registryRepos: [CANONICAL_CONTRACT_REPO] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test('validateCanonicalRef: ref KHÔNG structured (string/@abc/@pinned/@0123) → REF_NOT_STRUCTURED', () => {
  for (const bad of ['duongpdddic-droid/AI_PR_REVIEWER@0123 scripts/review-handoff-contract.mjs', '@abc', '@pinned', '@0123', null, undefined, 42]) {
    const v = validateCanonicalRef(bad, { registryRepos: [CANONICAL_CONTRACT_REPO] });
    assert.equal(v.ok, false, `ref lạ '${String(bad)}' phải bị chặn`);
    assert.ok(v.errors.some((e) => e.code === 'REF_NOT_STRUCTURED'));
  }
});

test('validateCanonicalRef: short SHA / mutable branch-tag → REF_SHA_INVALID', () => {
  for (const sha of ['abc123', '0123', 'main', 'feat/issue-32-review-handoff-contract', 'HEAD']) {
    const v = validateCanonicalRef(canonRef(CANONICAL_CONTRACT_REPO, { commitSha: sha }), { registryRepos: [CANONICAL_CONTRACT_REPO] });
    assert.equal(v.ok, false, `commitSha '${sha}' phải bị chặn (không phải 40-hex)`);
    assert.ok(v.errors.some((e) => e.code === 'REF_SHA_INVALID'));
  }
});

test('validateCanonicalRef: path sai, repo sai, version sai, hash sai → REF_*_INVALID/MISMATCH', () => {
  const R = [CANONICAL_CONTRACT_REPO];
  const vPath = validateCanonicalRef(canonRef(CANONICAL_CONTRACT_REPO, { path: 'other/path.mjs' }), { registryRepos: R });
  assert.equal(vPath.ok, false); assert.ok(vPath.errors.some((e) => e.code === 'REF_PATH_INVALID'));
  const vRepo = validateCanonicalRef(canonRef('example-org/other'), { registryRepos: R });
  assert.equal(vRepo.ok, false); assert.ok(vRepo.errors.some((e) => e.code === 'REF_REPO_NOT_REGISTERED'));
  const vVer = validateCanonicalRef(canonRef(CANONICAL_CONTRACT_REPO, { contractVersion: '2.0.0' }), { registryRepos: R });
  assert.equal(vVer.ok, false); assert.ok(vVer.errors.some((e) => e.code === 'REF_VERSION_MISMATCH'));
  const vHash = validateCanonicalRef(canonRef(CANONICAL_CONTRACT_REPO, { contentHash: 'f'.repeat(64) }), { registryRepos: R });
  assert.equal(vHash.ok, false); assert.ok(vHash.errors.some((e) => e.code === 'REF_CONTENT_HASH_MISMATCH'));
});

test('buildTaskPacket: ref không verify được → fallback inline lossless (không reference)', () => {
  const cases = [
    () => ({ resolved: true, ref: 'duongpdddic-droid/AI_PR_REVIEWER@0123 scripts/review-handoff-contract.mjs' }),
    () => ({ resolved: true, ref: { repo: CANONICAL_CONTRACT_REPO, commitSha: 'abc123', path: CANONICAL_CONTRACT_PATH, contractVersion: CONTRACT_VERSION, contentHash: HASH } }),
    () => { throw new Error('resolver boom'); },
  ];
  for (const r of cases) {
    const p = buildTaskPacket({ resolveRef: r, registryRepos: [CANONICAL_CONTRACT_REPO] });
    assert.equal(p.mode, 'inline', `ref lạ phải fallback inline`);
    assert.ok(p.content && p.content.includes(`v${CONTRACT_VERSION}`), 'inline content đầy đủ');
  }
});
// ---------------------------------------------------------------------------
// GPT-REV-120 — inline contract lossless (SEMANTIC_RULES source duy nhất).
// ---------------------------------------------------------------------------
test('contractContent lossless: inline chứa đủ semantic constraints', () => {
  const content = contractContent();
  for (const keyword of ['exact HEAD', 'failure', 'static tracing', 'finding resolution', 'assertions', 'mutation analysis', 'noApprovalClaim', 'Terminal status']) {
    assert.ok(content.includes(keyword), `inline content thiếu semantic '${keyword}'`);
  }
});

test('validateHandoff: thiếu semantic rule (codeEvidence items) → PARTIAL_EVIDENCE', () => {
  const r = validateHandoff(sampleReport({ codeEvidence: { items: [{ file: 'x.js' }] } }));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'CODE_EVIDENCE_ITEMS_REQUIRED'));
});

// ---------------------------------------------------------------------------
// GPT-REV-118 — identity binding (chống replay/substitution).
// ---------------------------------------------------------------------------
const IDENTITY_CTX = { repo: REPO_AIPR, number: 32, pr: 33, prHeadSha: FULL_SHA };
const identityReport = () => sampleReport({
  identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: FULL_SHA },
});

test('verifyHandoffIdentity: exact identity + HEAD → ok (positive)', () => {
  const v = verifyHandoffIdentity(identityReport(), IDENTITY_CTX);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test('verifyHandoffIdentity: report repo A phát lại cho repo B → IDENTITY_REPOSITORY_MISMATCH', () => {
  const rep = sampleReport({ identity: { repository: REPO_QLDA, issue: 32, pullRequest: 33, headSha: FULL_SHA } });
  const v = verifyHandoffIdentity(rep, IDENTITY_CTX);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'IDENTITY_REPOSITORY_MISMATCH'));
});

test('verifyHandoffIdentity: issue khác → IDENTITY_ISSUE_MISMATCH', () => {
  const rep = sampleReport({ identity: { repository: REPO_AIPR, issue: 99, pullRequest: 33, headSha: FULL_SHA } });
  const v = verifyHandoffIdentity(rep, IDENTITY_CTX);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'IDENTITY_ISSUE_MISMATCH'));
});

test('verifyHandoffIdentity: PR khác → IDENTITY_PR_MISMATCH', () => {
  const rep = sampleReport({ identity: { repository: REPO_AIPR, issue: 32, pullRequest: 77, headSha: FULL_SHA } });
  const v = verifyHandoffIdentity(rep, IDENTITY_CTX);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'IDENTITY_PR_MISMATCH'));
});

test('verifyHandoffIdentity: stale HEAD / random 40-hex → IDENTITY_HEAD_SHA_MISMATCH', () => {
  const rep = sampleReport({ identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' } });
  const v = verifyHandoffIdentity(rep, IDENTITY_CTX);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'IDENTITY_HEAD_SHA_MISMATCH'));
  const rep2 = sampleReport({ identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: '1111111111111111111111111111111111111111' } });
  const v2 = verifyHandoffIdentity(rep2, IDENTITY_CTX);
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.code === 'IDENTITY_HEAD_SHA_MISMATCH'));
});

test('verifyHandoffIdentity: PR head không đọc được → PR_HEAD_UNREADABLE', () => {
  const v = verifyHandoffIdentity(identityReport(), { ...IDENTITY_CTX, prHeadSha: undefined });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'PR_HEAD_UNREADABLE'));
});

test('verifyHandoffIdentity: thiếu identity section → IDENTITY_MISSING', () => {
  const rep = { ...sampleReport(), identity: undefined };
  const v = verifyHandoffIdentity(rep, IDENTITY_CTX);
test('reportDigest deterministic + sha256 hex 64', () => {
  const r = sampleReport();
  const d1 = reportDigest(r);
  const d2 = reportDigest(sampleReport());
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
});

test('reportDigest thay đổi khi report thay đổi', () => {
  const d1 = reportDigest(sampleReport());
  const changed = reportDigest(sampleReport({ identity: { headSha: '0'.repeat(40) } }));
  assert.notEqual(changed, d1);
});

test('reportDigest chỉ dựa trên contractVersion + 10 sections canonical (extra key không ảnh hưởng)', () => {
  const r = sampleReport();
  r.extraJunk = 'should-not-change-digest';
  assert.equal(reportDigest(r), reportDigest(sampleReport()));
});

test('reportDigest ignore thứ tự key (stableStringify)', () => {
  const r1 = sampleReport();
  const r2 = sampleReport();
  // Đảo thứ tự key trong section scope (delete + re-add, GIỮ NGUYÊN giá trị).
  const s = r2.scope;
  delete s.acceptanceCriteria;
  delete s.changedFiles;
  s.acceptanceCriteria = ['canonical contract', 'validator', 'gate'];
  s.changedFiles = ['scripts/review-handoff-contract.mjs'];
  assert.equal(reportDigest(r1), reportDigest(r2));
});
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'IDENTITY_MISSING'));
});




// ---------------------------------------------------------------------------
// GPT-REV-124 — READY_FOR_REVIEW gắn với review/finding context hiện hành.
// ---------------------------------------------------------------------------
const IDX = (fid) => ({ findingId: fid, severity: 'high', status: 'fixed', rootCause: 'r', fix: 'f', category: 'failClosed',
  evidence: { codeEvidence: [{ file: 'server.mjs', symbol: 'task_handoff' }], testEvidence: [{ name: 'handoff no-mutation ' + fid, location: 'test-server.mjs', negativeAssertion: 'label #35 KHÔNG đổi' }] } });

const weakReport = () => sampleReport({
  codeEvidence: { items: [{ file: 'docs/REVIEW_HANDOFF_CONTRACT.md', lines: '113-115', symbol: 'bullets', before: 'x', after: 'y', failClosedGates: 'x', mutationOrdering: 'x', excerpt: 'x', callerInput: 'x', mutations: [] }] },
  findingResolution: { items: [{ findingId: 'GPT-REV-123', severity: 'low', status: 'fixed', rootCause: 'r', fix: 'f', category: 'type',
    evidence: { codeEvidence: [{ file: 'docs/REVIEW_HANDOFF_CONTRACT.md', symbol: 'section' }], testEvidence: [{ name: 'suite', location: 'node test.mjs', negativeAssertion: 'n/a' }] } }] },
  tests: { items: [{ name: 'test suite', location: 'node test.mjs', setup: 'all tests', interleaving: null, assertions: ['108 PASS'], negativeAssertion: 'n/a', realFs: false, result: '108 PASS', exitCode: 0 }] },
});

test('GPT-REV-124: report như comment 5486779460 (thiếu 118-121 + docs-only + aggregate count) → PARTIAL_EVIDENCE', () => {
  const r = validateHandoff(weakReport(), { authoritativeFindings: ['GPT-REV-118', 'GPT-REV-119', 'GPT-REV-120', 'GPT-REV-121'] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  const codes = r.errors.map((e) => e.code);
  assert.ok(codes.includes('UNRESOLVED_FINDING_IN_CHAIN'), 'thiếu 118-121 → UNRESOLVED_FINDING_IN_CHAIN');
  assert.ok(codes.includes('CODE_EVIDENCE_NOT_DOCS_ONLY'), 'docs-only → CODE_EVIDENCE_NOT_DOCS_ONLY');
  assert.ok(codes.includes('TESTS_NO_AGGREGATE_ONLY'), 'aggregate count → TESTS_NO_AGGREGATE_ONLY');
  assert.equal(canRequestReview(r), false);
});

test('GPT-REV-124: finding fixed thiếu code-link → FINDING_RESOLUTION_EVIDENCE_REQUIRED', () => {
  const r = validateHandoff(sampleReport({ findingResolution: { items: [{ findingId: 'G', severity: 'low', status: 'fixed', rootCause: 'r', fix: 'f', category: 'type', evidence: { codeEvidence: [], testEvidence: [{ name: 't', location: 'l', negativeAssertion: '' }] } }] } }));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'FINDING_RESOLUTION_EVIDENCE_REQUIRED'));
});

test('GPT-REV-124: finding fixed thiếu test-link → FINDING_RESOLUTION_EVIDENCE_REQUIRED', () => {
  const r = validateHandoff(sampleReport({ findingResolution: { items: [{ findingId: 'G', severity: 'low', status: 'fixed', rootCause: 'r', fix: 'f', category: 'type', evidence: { codeEvidence: [{ file: 'server.mjs', symbol: 'task_handoff' }], testEvidence: [] } }] } }));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'FINDING_RESOLUTION_EVIDENCE_REQUIRED'));
});

test('GPT-REV-124: finding failClosed thiếu negative assertion → FINDING_RESOLUTION_EVIDENCE_REQUIRED', () => {
  const r = validateHandoff(sampleReport({ findingResolution: { items: [{ findingId: 'G', severity: 'high', status: 'fixed', rootCause: 'r', fix: 'f', category: 'failClosed', evidence: { codeEvidence: [{ file: 'server.mjs', symbol: 'task_handoff' }], testEvidence: [{ name: 't', location: 'l', negativeAssertion: 'n/a' }] } }] } }));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'FINDING_RESOLUTION_EVIDENCE_REQUIRED'));
});

test('GPT-REV-124: unresolved finding không cần evidence → READY_FOR_REVIEW', () => {
  const r = validateHandoff(sampleReport({ findingResolution: { items: [{ findingId: 'GPT-REV-118', severity: 'high', status: 'unresolved', rootCause: 'r', fix: '' }] } }), { authoritativeFindings: ['GPT-REV-118'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'READY_FOR_REVIEW');
});

test('GPT-REV-124: verification exitCode≠0 khi báo READY_FOR_REVIEW → VERIFICATION_NONZERO_EXIT', () => {
  const r = validateHandoff(sampleReport({ verification: { commands: ['node t'], exitCodes: [0, 1], passCount: 1, failCount: 0, diffCheck: 'clean', worktreeStatus: 'clean', remainingFailures: [] } }));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'VERIFICATION_NONZERO_EXIT'));
});

test('GPT-REV-124: verification 153/154 (failCount=1 + remainingFailures) → ALL_GREEN_WITH_FAILURE', () => {
  const r = validateHandoff(sampleReport({ verification: { commands: ['node t'], exitCodes: [1], passCount: 153, failCount: 1, diffCheck: 'dirty', worktreeStatus: 'dirty', remainingFailures: ['git diff --check fails'] } }));
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'ALL_GREEN_WITH_FAILURE'));
});


// --- Incremental chain: previousReportRef resolve + digest/HEAD/cycle ---
const FULL_HEAD = 'f1ea7f7419e2447ffedbb6c4496bebf049481d95';
const mkPrevReport = (overrides = {}) => sampleReport({
  identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: FULL_HEAD },
  findingResolution: { items: [IDX('GPT-REV-118'), IDX('GPT-REV-119'), IDX('GPT-REV-120'), IDX('GPT-REV-121')] },
  ...overrides,
});
const mkCurReport = (overrides = {}) => sampleReport({
  identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: FULL_HEAD },
  previousReportRef: { repo: REPO_AIPR, issue: 32, pr: 33, commentId: '5486779460', headSha: FULL_HEAD, reportDigest: reportDigest(mkPrevReport()) },
  findingResolution: { items: [IDX('GPT-REV-122'), IDX('GPT-REV-123'), IDX('GPT-REV-124')] },
  ...overrides,
});
const resolveTo = (rep) => () => ({ resolved: true, report: rep });

test('GPT-REV-124: incremental resolve đúng previous (cùng HEAD + digest) + merge → READY_FOR_REVIEW cho 118-124', () => {
  const r = validateHandoff(mkCurReport(), { resolvePreviousReport: resolveTo(mkPrevReport()), authoritativeFindings: ['GPT-REV-118', 'GPT-REV-119', 'GPT-REV-120', 'GPT-REV-121', 'GPT-REV-122', 'GPT-REV-123', 'GPT-REV-124'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'READY_FOR_REVIEW');
});

test('GPT-REV-124: previousReportRef thiếu → PREVIOUS_REPORT_REF_INCOMPLETE', () => {
  const cur = sampleReport({ previousReportRef: { repo: REPO_AIPR, issue: 32, pr: 33 } });
  const r = validateHandoff(cur, { resolvePreviousReport: resolveTo(mkPrevReport()) });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'PREVIOUS_REPORT_REF_INCOMPLETE'));
});

test('GPT-REV-124: missing previous report (resolver unresolved) → PREVIOUS_REPORT_UNRESOLVED', () => {
  const r = validateHandoff(mkCurReport(), { resolvePreviousReport: () => ({ resolved: false }) });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'PREVIOUS_REPORT_UNRESOLVED'));
});

test('GPT-REV-124: wrong digest (HEAD lệch) → PREVIOUS_REPORT_DIGEST_MISMATCH', () => {
  const prev = mkPrevReport({ identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: '0'.repeat(40) } });
  const cur = sampleReport({
    identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: FULL_HEAD },
    previousReportRef: { repo: REPO_AIPR, issue: 32, pr: 33, commentId: '1', headSha: '0'.repeat(40), reportDigest: reportDigest(prev) },
  });
  const r = validateHandoff(cur, { resolvePreviousReport: resolveTo(mkPrevReport()) });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'PREVIOUS_REPORT_DIGEST_MISMATCH'));
});

test('GPT-REV-124: wrong HEAD (resolver trả HEAD khác ref) → PREVIOUS_REPORT_HEAD_MISMATCH', () => {
  const prev = mkPrevReport({ identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: '0'.repeat(40) } });
  const cur = sampleReport({
    identity: { repository: REPO_AIPR, issue: 32, pullRequest: 33, headSha: FULL_HEAD },
    previousReportRef: { repo: REPO_AIPR, issue: 32, pr: 33, commentId: '1', headSha: FULL_HEAD, reportDigest: reportDigest(prev) },
  });
  const r = validateHandoff(cur, { resolvePreviousReport: resolveTo(prev) });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'PREVIOUS_REPORT_HEAD_MISMATCH'));
});

test('GPT-REV-124: cycle (previous trỏ ngược về chính digest hiện tại) → PREVIOUS_REPORT_CYCLE', () => {
  const cur = mkCurReport();
  const prev = mkPrevReport({ previousReportRef: { repo: REPO_AIPR, issue: 32, pr: 33, commentId: '1', headSha: FULL_HEAD, reportDigest: reportDigest(cur) } });
  const r = validateHandoff(cur, { resolvePreviousReport: resolveTo(prev) });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'PREVIOUS_REPORT_CYCLE'));
});

test('GPT-REV-124: mergeIncrementalEvidence hợp nhất finding/code/test (current thắng)', () => {
  const merged = mergeIncrementalEvidence(mkCurReport(), mkPrevReport());
  const ids = merged.findingResolution.items.map((f) => f.findingId).sort();
  assert.deepEqual(ids, ['GPT-REV-118', 'GPT-REV-119', 'GPT-REV-120', 'GPT-REV-121', 'GPT-REV-122', 'GPT-REV-123', 'GPT-REV-124']);
  assert.ok(merged.codeEvidence.items.length > 0);
  assert.ok(merged.tests.items.length > 0);
});


// ---------------------------------------------------------------------------
// GPT-REV-125 — derive authoritative finding set; caller expectedFindings
// chỉ là assertion; fail-closed trên subset/superset/duplicate/unknown/missing authority.
// ---------------------------------------------------------------------------
const AUTHORITY = { gpt: ['gpt-reviewer-bot'], local: ['local-reviewer-bot'] };
const parseSample = (i, status = 'open') => parseReviewComment(
  `[GPT-REV-${String(i).padStart(3, '0')}]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: ${status}`,
  { author: 'gpt-reviewer-bot', ts: `2026-09-02T0${i}:00:00Z`, commentId: i },
);

test('GPT-REV-125: findingType map (GPT|LOCAL)-REV-NNN → gpt|local', () => {
  assert.equal(findingType('GPT-REV-118'), 'gpt');
  assert.equal(findingType('LOCAL-REV-001'), 'local');
  assert.equal(findingType('LOCAL-RULE-042'), 'local');
  assert.equal(findingType('bogus'), null);
});

test('GPT-REV-125: FINDING_REQUIRED_FIELDS đúng 4 field (severity/evidence/risk/expectedOutcome)', () => {
  assert.deepEqual([...FINDING_REQUIRED_FIELDS].sort(), ['evidence', 'expectedOutcome', 'risk', 'severity']);
});

test('GPT-REV-125: parseReviewComment — plain body có chuỗi GPT-REV-* không marker → rỗng', () => {
  const r = parseReviewComment('xem thêm GPT-REV-118 ở đâu đó\n[GPT-REV-119]\nseverity: low');
  assert.equal(r.findings.length, 0);
  assert.ok(r.errors.some((e) => e.code === 'MALFORMED_FINDING_MARKER'));
});

test('GPT-REV-125: parseReviewComment — marker đủ schema → 1 finding', () => {
  const r = parseReviewComment('[GPT-REV-118]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: open');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].id, 'GPT-REV-118');
});

test('GPT-REV-125: canonicalActiveFindings — actor không có authority → bỏ qua', () => {
  const entries = [parseSample(118).findings[0], parseSample(119).findings[0]];
  entries[1].author = 'imposter';
  const r = canonicalActiveFindings(entries, { authority: AUTHORITY });
  assert.deepEqual(r.findings, ['GPT-REV-118']);
});

test('GPT-REV-125: canonicalActiveFindings — missing authority khi có finding → fail-closed', () => {
  const r = canonicalActiveFindings([parseSample(118).findings[0]], { authority: null });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'AUTHORITY_UNAVAILABLE');
});

test('GPT-REV-125: canonicalActiveFindings — terminal state (withdrawn/superseded/resolved) → loại khỏi active', () => {
  const entries = [
    parseSample(118).findings[0],
    parseSample(119, 'withdrawn').findings[0],
    parseSample(120, 'superseded').findings[0],
    parseSample(121, 'resolved').findings[0],
  ];
  const r = canonicalActiveFindings(entries, { authority: AUTHORITY });
  assert.deepEqual(r.findings, ['GPT-REV-118']);
});

test('GPT-REV-125: sameFindingSet — order/dup bỏ qua, khác tỷ lệ → false', () => {
  assert.equal(sameFindingSet(['GPT-REV-118', 'GPT-REV-119'], ['GPT-REV-119', 'GPT-REV-118']), true);
  assert.equal(sameFindingSet(['GPT-REV-118', 'GPT-REV-118'], ['GPT-REV-118']), true);
  assert.equal(sameFindingSet(['GPT-REV-118'], ['GPT-REV-119']), false);
  assert.equal(sameFindingSet([], []), true);
});

test('GPT-REV-127: canonicalActiveFindings — empty allowlist (gpt=[] và local=[]) → AUTHORITY_UNAVAILABLE', () => {
  const e = parseSample(118, 'open').findings[0];
  const r = canonicalActiveFindings([e], { authority: { gpt: [], local: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'AUTHORITY_UNAVAILABLE');
});

test('GPT-REV-127: canonicalActiveFindings — thiếu authority theo finding type (finding gpt nhưng gpt=[]) → AUTHORITY_UNAVAILABLE', () => {
  const e = parseSample(118, 'open').findings[0];
  const r = canonicalActiveFindings([e], { authority: { gpt: [], local: ['human-admin'] } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((er) => er.code === 'AUTHORITY_UNAVAILABLE'));
});

test('GPT-REV-127: canonicalActiveFindings — unauthorized-only (mọi finding do actor KHÔNG có quyền) → AUTHORITY_UNAVAILABLE', () => {
  const e = parseSample(118, 'open').findings[0];
  e.author = 'imposter';
  const r = canonicalActiveFindings([e], { authority: AUTHORITY });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((er) => er.code === 'AUTHORITY_UNAVAILABLE'));
});

test('GPT-REV-127: canonicalActiveFindings — valid configured authority → đúng active set (positive)', () => {
  const entries = [parseSample(118, 'open').findings[0], parseSample(119, 'open').findings[0]];
  const r = canonicalActiveFindings(entries, { authority: AUTHORITY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, ['GPT-REV-118', 'GPT-REV-119']);
});


test('GPT-REV-126: validateHandoff — authoritativeFindings omitted → AUTHORITATIVE_FINDINGS_REQUIRED, KHÔNG READY', () => {
  const r = validateHandoff(sampleReport());
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'AUTHORITATIVE_FINDINGS_REQUIRED'));
  assert.equal(canRequestReview(r), false, 'thiếu authoritative context → không request review');
});

test('GPT-REV-126: validateHandoff — authoritativeFindings null → AUTHORITATIVE_FINDINGS_REQUIRED, KHÔNG READY', () => {
  const r = validateHandoff(sampleReport(), { authoritativeFindings: null });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'AUTHORITATIVE_FINDINGS_REQUIRED'));
  assert.equal(canRequestReview(r), false);
});

test('GPT-REV-126: validateHandoff — authoritativeFindings malformed (không phải array) → AUTHORITATIVE_FINDINGS_REQUIRED', () => {
  const r = validateHandoff(sampleReport(), { authoritativeFindings: 'GPT-REV-118' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'AUTHORITATIVE_FINDINGS_REQUIRED'));
  assert.equal(canRequestReview(r), false);
});

test('GPT-REV-125: validateHandoff — caller báo `[]` trong khi authoritative có finding → UNRESOLVED_FINDING_IN_CHAIN', () => {
  const r = validateHandoff(sampleReport(), { authoritativeFindings: ['GPT-REV-118'] });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'UNRESOLVED_FINDING_IN_CHAIN' && e.message.includes('GPT-REV-118')));
});

test('GPT-REV-125: validateHandoff — caller subset (thiếu 120 trong authoritative) → UNRESOLVED_FINDING_IN_CHAIN', () => {
  // items chỉ resolve 118,119; authoritative yêu cầu 118,119,120 → thiếu 120.
  const items = [
    { findingId: 'GPT-REV-118', severity: 'high', status: 'fixed', rootCause: 'r', fix: 'f', category: 'failClosed',
      evidence: { codeEvidence: [{ file: 'server.mjs', symbol: 'task_handoff' }], testEvidence: [{ name: 't', location: 'l', negativeAssertion: 'caller expectedFindings từ chối thiếu 120' }] } },
    { findingId: 'GPT-REV-119', severity: 'high', status: 'fixed', rootCause: 'r', fix: 'f', category: 'failClosed',
      evidence: { codeEvidence: [{ file: 'server.mjs', symbol: 'task_handoff' }], testEvidence: [{ name: 't', location: 'l', negativeAssertion: 'caller expectedFindings từ chối thiếu 120' }] } },
  ];
  const r = validateHandoff(sampleReport({ findingResolution: { items } }), { authoritativeFindings: ['GPT-REV-118', 'GPT-REV-119', 'GPT-REV-120'] });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'UNRESOLVED_FINDING_IN_CHAIN' && e.message.includes('GPT-REV-120')));
  assert.ok(!r.errors.some((e) => e.code === 'UNRESOLVED_EXTRA_FINDING'), 'subset caller không phạm superset');
});


test('GPT-REV-125: validateHandoff — caller superset thêm 120 → UNRESOLVED_EXTRA_FINDING', () => {
  const items = [IDX('GPT-REV-118'), IDX('GPT-REV-119'), IDX('GPT-REV-120')];
  const r = validateHandoff(sampleReport({ findingResolution: { items } }), { authoritativeFindings: ['GPT-REV-118', 'GPT-REV-119'] });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'UNRESOLVED_EXTRA_FINDING' && e.message.includes('GPT-REV-120')));
});

test('GPT-REV-125: validateHandoff — duplicate findingId → FINDING_RESOLUTION_DUPLICATE', () => {
  const items = [IDX('GPT-REV-118'), IDX('GPT-REV-118')];
  const r = validateHandoff(sampleReport({ findingResolution: { items } }), { authoritativeFindings: ['GPT-REV-118'] });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'FINDING_RESOLUTION_DUPLICATE'));
});

test('GPT-REV-125: validateHandoff — unknown findingId → FINDING_ID_UNKNOWN', () => {
  const r = validateHandoff(sampleReport(), { authoritativeFindings: ['bogus-id'] });
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'FINDING_ID_UNKNOWN' && e.message.includes('bogus-id')));
});

test('GPT-REV-125: validateHandoff — exact set khớp authoritative → READY_FOR_REVIEW', () => {
  const items = [IDX('GPT-REV-118'), IDX('GPT-REV-119')];
  const r = validateHandoff(sampleReport({ findingResolution: { items } }), { authoritativeFindings: ['GPT-REV-118', 'GPT-REV-119'] });
  assert.equal(r.status, 'READY_FOR_REVIEW');
});

test('GPT-REV-132: validateHandoff — authoritative rỗng + items rỗng → READY_FOR_REVIEW (hết deadlock)', () => {
  // GPT-REV-132: zero-authoritative-findings giờ là trạng thái hand-off được.
  // items=[] là structurally hợp lệ (empty array, `.every` trên [] → true) — không phạm
  // FINDING_RESOLUTION_ITEMS_REQUIRED / FINDING_RESOLUTION_EVIDENCE_REQUIRED; exact-set validation:
  // authoritative=[] + items=[] → 2 set rỗng khớp nhau (không có UNRESOLVED_*).
  const r = validateHandoff(sampleReport({ findingResolution: { items: [] } }), { authoritativeFindings: [] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'READY_FOR_REVIEW');
  assert.deepEqual(r.errors, []);
});

test('GPT-REV-132: empty items là structurally valid (không phạm 2 rule semantic findingResolution)', () => {
  const r = validateHandoff(sampleReport({ findingResolution: { items: [] } }), { authoritativeFindings: [] });
  assert.ok(!r.errors.some((e) => e.code === 'FINDING_RESOLUTION_ITEMS_REQUIRED'), 'empty items không được phạm FINDING_RESOLUTION_ITEMS_REQUIRED');
  assert.ok(!r.errors.some((e) => e.code === 'FINDING_RESOLUTION_EVIDENCE_REQUIRED'), 'empty items không được phạm FINDING_RESOLUTION_EVIDENCE_REQUIRED');
});

test('GPT-REV-132: authoritative=[] + extra/synthetic finding → UNRESOLVED_EXTRA_FINDING (superset fail-closed)', () => {
  const r = validateHandoff(sampleReport({ findingResolution: { items: [IDX('GPT-REV-999')] } }), { authoritativeFindings: [] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'UNRESOLVED_EXTRA_FINDING' && e.message.includes('GPT-REV-999')));
});

test('GPT-REV-132: authoritative=[F1] + items=[] → UNRESOLVED_FINDING_IN_CHAIN (missing fail-closed)', () => {
  const r = validateHandoff(sampleReport({ findingResolution: { items: [] } }), { authoritativeFindings: ['GPT-REV-118'] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'UNRESOLVED_FINDING_IN_CHAIN' && e.message.includes('GPT-REV-118')));
});

test('GPT-REV-132: authoritative=[F1] + exact resolved F1 → READY_FOR_REVIEW (không weaken exact-set)', () => {
  const r = validateHandoff(sampleReport({ findingResolution: { items: [IDX('GPT-REV-118')] } }), { authoritativeFindings: ['GPT-REV-118'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'READY_FOR_REVIEW');
  assert.deepEqual(r.errors, []);
});

test('GPT-REV-132: validateHandoff — missing authoritativeFindings → AUTHORITATIVE_FINDINGS_REQUIRED fail-closed', () => {
  const r = validateHandoff(sampleReport());
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'AUTHORITATIVE_FINDINGS_REQUIRED'));
});

test('GPT-REV-132: validateHandoff — null authoritativeFindings → AUTHORITATIVE_FINDINGS_REQUIRED fail-closed', () => {
  const r = validateHandoff(sampleReport(), { authoritativeFindings: null });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'PARTIAL_EVIDENCE');
  assert.ok(r.errors.some((e) => e.code === 'AUTHORITATIVE_FINDINGS_REQUIRED'));
});

test('GPT-REV-132: derivation failure không được ngụy trang thành success-empty (canonicalActiveFindings ok=false)', () => {
  // Khi không xác định được reviewer authority (derivation failure) → canonicalActiveFindings
  // trả { ok:false, findings:[] } — KHÔNG phải empty-set thành công. Server PHẢI gate on !ok
  // (xem deriveAuthoritativeFindings trong mcp-task-server/server.mjs) trước khi thả [] vào validate.
  const r = canonicalActiveFindings([parseSample(118).findings[0]], { authority: { gpt: [], local: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.findings.length, 0);
  assert.equal(r.errors[0].code, 'AUTHORITY_UNAVAILABLE');
});


// Runner — đếm PASS/FAIL, exit 1 nếu có lỗi.
let passed = 0;
const failed = [];
for (const c of cases) {
  try {
    c.fn();
    passed += 1;
  } catch (e) {
    failed.push({ name: c.name, error: e.message });
    console.error(`FAIL: ${c.name}\n  ${e.message}`);
  }
}
console.log(`test-review-handoff-contract: ${passed}/${cases.length} PASS`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}
