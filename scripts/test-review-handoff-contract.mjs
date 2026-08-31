#!/usr/bin/env node
// test-review-handoff-contract.mjs — Unit test Canonical REVIEW HANDOFF CONTRACT (Issue #32).
// Exit 0 = PASS, 1 = FAIL. ZERO IO — chỉ import pure module.
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION, TERMINAL_STATUSES, SECTION_IDS, REQUIRED_SECTIONS,
  sampleReport, validateHandoff, canRequestReview, contractContent, buildTaskPacket,
  verifyHandoffIdentity, validateCanonicalRef, contractContentHash, reportDigest,
  CANONICAL_CONTRACT_PATH, CANONICAL_CONTRACT_REPO,
} from './review-handoff-contract.mjs';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// Helper: bỏ section/field để tạo report thiếu evidence.
const drop = (report, section) => { const r = { ...report, [section]: undefined }; return r; };
const dropField = (report, section, field) => {
  const r = { ...report, [section]: { ...report[section], [field]: undefined } };
  return r;
};

test('happy path: report đủ 10 section → READY_FOR_REVIEW + canRequestReview=true', () => {
  const r = validateHandoff(sampleReport());
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
  const r = validateHandoff(sampleReport({ terminalStatus: { status: 'BLOCKED' } }));
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
  const r = validateHandoff(report, { registeredRepos: reg });
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

