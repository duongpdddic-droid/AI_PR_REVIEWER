#!/usr/bin/env node
// test-review-handoff-contract.mjs — Unit test Canonical REVIEW HANDOFF CONTRACT (Issue #32).
// Exit 0 = PASS, 1 = FAIL. ZERO IO — chỉ import pure module.
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION, TERMINAL_STATUSES, SECTION_IDS, REQUIRED_SECTIONS,
  sampleReport, validateHandoff, canRequestReview, contractContent, buildTaskPacket,
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
  const p = buildTaskPacket({ resolveRef: () => ({ resolved: true, ref: 'duongpdddic-droid/AI_PR_REVIEWER@0123456789abcdef scripts/review-handoff-contract.mjs' }) });
  assert.equal(p.ok, true);
  assert.equal(p.mode, 'reference');
  assert.equal(p.contractVersion, CONTRACT_VERSION);
  assert.ok(p.ref.startsWith('duongpdddic-droid/AI_PR_REVIEWER@'));
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

test('2 fixtures repo khác nhau nhận cùng pinned canonical contract version', () => {
  const pa = buildTaskPacket({ resolveRef: () => ({ resolved: true, ref: `${REPO_AIPR}@abc scripts/review-handoff-contract.mjs` }) });
  const pq = buildTaskPacket({ resolveRef: () => ({ resolved: true, ref: `${REPO_QLDA}@abc scripts/review-handoff-contract.mjs` }) });
  assert.equal(pa.mode, 'reference');
  assert.equal(pq.mode, 'reference');
  assert.equal(pa.contractVersion, CONTRACT_VERSION);
  assert.equal(pq.contractVersion, CONTRACT_VERSION);
  assert.equal(pa.contractVersion, pq.contractVersion, 'cùng pinned version cho mọi repo');
  assert.ok(pa.ref.includes(REPO_AIPR) && pq.ref.includes(REPO_QLDA));
});

test('target-repo handoff đủ evidence pass KHÔNG cần contract bản sao trong repo đó', () => {
  const reg = [REPO_AIPR, REPO_QLDA];
  const report = sampleReport({ identity: { repository: REPO_QLDA } });
  const r = validateHandoff(report, { registeredRepos: reg });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'READY_FOR_REVIEW');
  assert.equal(canRequestReview(r), true);
  // reference-mode packet không mang full content → không cần copy contract vào target repo
  const p = buildTaskPacket({ resolveRef: () => ({ resolved: true, ref: `${REPO_QLDA}@abc scripts/review-handoff-contract.mjs` }) });
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
  const issued = buildTaskPacket({ resolveRef: () => ({ resolved: true, ref: `${REPO_AIPR}@pinned scripts/review-handoff-contract.mjs` }) });
  assert.equal(issued.contractVersion, CONTRACT_VERSION);
  // Mô phỏng canonical đã nâng version lên 2.0.0: packet cũ vẫn giữ version 1.0.0 của nó.
  assert.notEqual(issued.contractVersion, '2.0.0');
  // Validator dùng expectedVersion 2.0.0 phải reject report cũ (mismatch) — không ngấm ngầm pass.
  const r = validateHandoff(sampleReport({ contractVersion: issued.contractVersion }), { expectedVersion: '2.0.0' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'CONTRACT_VERSION_MISMATCH'));
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

