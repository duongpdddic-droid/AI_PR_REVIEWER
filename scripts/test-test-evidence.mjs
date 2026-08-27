#!/usr/bin/env node
// test-test-evidence.mjs — Test suite cho Test Evidence Protocol v1 (Issue #19 Phase 1).
// Assert-based, không framework. Exit 0 = PASS, 1 = FAIL.
import {
  computeEnvironmentFingerprint, computeManifestHash, computeReportId,
  formatCompactLine, formatFullJson, saveReport,
  validateReport, validateManifest, redact,
  failureCodeFromStep, formatSummary, formatFailureDetail,
  MAX_PASS_JSON_BYTES,
} from './test-evidence-reporter.mjs';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, val) => checks.push({ name, ok: Boolean(val), got: val, want: true });
const approx = (name, got, min, max) => checks.push({ name, ok: got >= min && got <= max, got, want: `${min}..${max}` });

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

// ── 1. computeEnvironmentFingerprint ───────────────────────────────
const fp1 = computeEnvironmentFingerprint();
const fp2 = computeEnvironmentFingerprint();
eq('fingerprint is string', typeof fp1, 'string');
eq('fingerprint 16+ hex', /^[0-9a-f]{16,}$/.test(fp1), true);
eq('fingerprint deterministic', fp1, fp2);

// ── 2. computeManifestHash ─────────────────────────────────────────
const manifest = { schemaVersion: '1.0', projectId: 'test', repository: 'o/r', headSha: SHA, gates: {} };
const h1 = computeManifestHash(manifest);
const h2 = computeManifestHash({ ...manifest, environmentFingerprint: 'ignore', generatedAt: 'ignore' });
eq('manifestHash ignores meta', h1, h2);
eq('manifestHash changes with data', h1 === computeManifestHash({ ...manifest, projectId: 'other' }) ? 'SAME' : 'DIFF', 'DIFF');

// ── 3. computeReportId ─────────────────────────────────────────────
const rid1 = computeReportId(SHA, h1);
const rid2 = computeReportId(SHA, h1);
eq('reportId 16 hex', /^[0-9a-f]{16}$/.test(rid1), true);
eq('reportId deterministic', rid1, rid2);
tru('reportId changes with SHA', computeReportId(SHA2, h1) !== rid1);

// ── 4. formatCompactLine — PASS ───────────────────────────────────
const passReport = {
  schemaVersion: '1.0', headSha: SHA, passed: true,
  tests: { passed: 10, failed: 0, total: 10 },
  duration: 1234, blocking: 0, failureCodes: [],
  reportId: rid1, manifestHash: h1,
};
const passLine = formatCompactLine(passReport);
eq('PASS line starts VERIFY PASS', passLine.startsWith('VERIFY PASS'), true);
eq('PASS line contains head', passLine.includes(`head=${SHA}`), true);
eq('PASS line contains tests', passLine.includes('tests=10/10'), true);
eq('PASS line contains blocking=0', passLine.includes('blocking=0'), true);
eq('PASS line contains report', passLine.includes(`report=${rid1}`), true);

// ── 5. formatCompactLine — FAIL ────────────────────────────────────
const failReport = {
  ...passReport, passed: false, blocking: 2,
  tests: { passed: 8, failed: 2, total: 10 },
  failureCodes: ['STEP_SYNTAX_FAIL', 'STEP_UNIT_FAIL'],
  failures: [
    { code: 'STEP_SYNTAX_FAIL', step: 'syntax-check', detail: 'Unexpected token' },
    { code: 'STEP_UNIT_FAIL', step: 'unit-test', detail: 'Assertion failed' },
  ],
};
const failLine = formatCompactLine(failReport);
eq('FAIL line starts VERIFY FAIL', failLine.startsWith('VERIFY FAIL'), true);
eq('FAIL line contains blocking=2', failLine.includes('blocking=2'), true);
eq('FAIL line contains both codes', failLine.includes('STEP_SYNTAX_FAIL'), true);
tru('FAIL line has second code', failLine.includes('STEP_UNIT_FAIL'));

// ── 6. formatFullJson ──────────────────────────────────────────────
const json = formatFullJson(passReport);
eq('formatFullJson is valid JSON', typeof JSON.parse(json), 'object');

// ── 7. saveReport — PASS within 4KB ────────────────────────────────
const tmpDir = mkdtempSync(join(tmpdir(), 'te-'));
try {
  const savedPath = saveReport(passReport, tmpDir);
  const savedJson = readFileSync(savedPath, 'utf8');
  const saved = JSON.parse(savedJson);
  eq('saved report headSha', saved.headSha, SHA);
  eq('saved report passed', saved.passed, true);
  approx('PASS JSON bytes <= 4096', Buffer.byteLength(savedJson, 'utf8'), 1, MAX_PASS_JSON_BYTES);
  eq('artifact filename is reportId.json', readdirSync(tmpDir).length, 1);
} finally { rmSync(tmpDir, { recursive: true, force: true }); }

// ── 8. saveReport FAIL can exceed 4KB ──────────────────────────────
const bigFail = {
  ...failReport, reportId: rid1, manifestHash: h1,
  failures: Array.from({ length: 20 }, (_, i) => ({
    code: `FAIL_${i}`, step: `step${i}`, detail: 'x'.repeat(300),
  })),
};
const tmpDir2 = mkdtempSync(join(tmpdir(), 'te-'));
try {
  const p = saveReport(bigFail, tmpDir2);
  tru('FAIL report saved (can exceed 4KB)', p.endsWith(`${rid1}.json`));
} finally { rmSync(tmpDir2, { recursive: true, force: true }); }

// ── 9. saveReport PASS exceeding 4KB throws ────────────────────────
const hugePass = {
  ...passReport, failures: [{ code: 'X', step: 's', detail: 'y'.repeat(5000) }],
};
const tmpDir3 = mkdtempSync(join(tmpdir(), 'te-'));
try {
  let threw = false;
  try { saveReport(hugePass, tmpDir3); } catch { threw = true; }
  tru('PASS report > 4KB throws', threw);
} finally { rmSync(tmpDir3, { recursive: true, force: true }); }

// ── 10. validateReport — valid PASS ────────────────────────────────
const v1 = validateReport(passReport);
tru('valid PASS report', v1.valid);
eq('valid PASS errors empty', v1.errors.length, 0);

// ── 11. validateReport — valid FAIL ────────────────────────────────
const v2 = validateReport(failReport);
tru('valid FAIL report', v2.valid);

// ── 12. validateReport — missing fields ────────────────────────────
const v3 = validateReport({});
eq('missing fields detected', v3.valid, false);
tru('has missing error', v3.errors.some((e) => e.includes('missing')));

// ── 13. validateReport — bad headSha ───────────────────────────────
const v4 = validateReport({ ...passReport, headSha: 'not-hex' });
eq('bad headSha rejected', v4.valid, false);

// ── 14. validateReport — tests mismatch ────────────────────────────
const v5 = validateReport({ ...passReport, tests: { passed: 5, failed: 5, total: 11 } });
eq('tests mismatch rejected', v5.valid, false);

// ── 15. validateReport — FAIL without failureCodes ─────────────────
const v6 = validateReport({ ...failReport, failureCodes: [] });
eq('FAIL empty failureCodes rejected', v6.valid, false);

// ── 16. validateReport — FAIL without blocking ─────────────────────
const v7 = validateReport({ ...failReport, blocking: 0 });
eq('FAIL blocking=0 rejected', v7.valid, false);

// ── 17. validateReport — bad reportId ──────────────────────────────
const v8 = validateReport({ ...passReport, reportId: 'zzz' });
eq('bad reportId rejected', v8.valid, false);

// ── 18. validateManifest — valid ───────────────────────────────────
const m = { schemaVersion: '1.0', projectId: 'p', repository: 'o/r', headSha: SHA, gates: { verify: [{ id: 's1', name: 'step1', command: 'node' }] } };
const vm1 = validateManifest(m);
tru('valid manifest', vm1.valid);

// ── 19. validateManifest — bad command ─────────────────────────────
const vm2 = validateManifest({ ...m, gates: { verify: [{ id: 's1', name: 'x', command: 'rm -rf /' }] } });
eq('bad command rejected', vm2.valid, false);
tru('bad command error', vm2.errors.some((e) => e.includes('allowlisted')));

// ── 20. validateManifest — missing fields ──────────────────────────
const vm3 = validateManifest({});
eq('empty manifest rejected', vm3.valid, false);

// ── 21. redact API key ─────────────────────────────────────────────
const r1 = redact('api_key = "supersecretkeyvalue1234567890"');
eq('redact API key', r1, '[REDACTED_API_KEY]');

// ── 22. redact AWS key ─────────────────────────────────────────────
const r2 = redact('AKIAIOSFODNN7EXAMPLE');
eq('redact AWS key', r2, '[REDACTED_AWS]');

// ── 23. redact password ────────────────────────────────────────────
const r3 = redact('password = "hunter2"');
eq('redact password', r3, '[REDACTED_SECRET]');

// ── 24. redact Bearer ──────────────────────────────────────────────
const r4 = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test');
eq('redact Bearer', r4, 'Authorization: Bearer [REDACTED]');

// ── 25. redact connection string ───────────────────────────────────
const r5 = redact('mongodb://user:pass@host:27017/db');
eq('redact conn string', r5, '[REDACTED_CONN]');

// ── 26. redact private key ─────────────────────────────────────────
const r6 = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----');
eq('redact private key', r6, '[REDACTED_KEY]');

// ── 27. redact no-op ───────────────────────────────────────────────
const r7 = redact('normal text with no secrets');
eq('redact clean text unchanged', r7, 'normal text with no secrets');

// ── 28. failureCodeFromStep ────────────────────────────────────────
eq('failureCodeFromStep basic', failureCodeFromStep('syntax'), 'STEP_SYNTAX_FAIL');
eq('failureCodeFromStep complex', failureCodeFromStep('unit-test'), 'STEP_UNIT_TEST_FAIL');

// ── 29. formatSummary — PASS ───────────────────────────────────────
const s1 = formatSummary(passReport);
eq('summary PASS same as compact', s1, passLine);

// ── 30. formatSummary — FAIL ───────────────────────────────────────
const s2 = formatSummary(failReport);
tru('summary FAIL includes code', s2.includes('STEP_SYNTAX_FAIL'));
tru('summary FAIL includes detail', s2.includes('Unexpected token'));

// ── 31. formatFailureDetail ────────────────────────────────────────
const det = {
  ...failReport, reportId: rid1, manifestHash: h1,
  failures: [{ code: 'STEP_X_FAIL', step: 'x', detail: 'something broke', logExcerpt: 'line1\nline2\nline3' }],
};
const fd = formatFailureDetail(det, 0);
eq('detail includes code', fd.includes('STEP_X_FAIL'), true);
eq('detail includes step', fd.includes('x'), true);
eq('detail includes logExcerpt', fd.includes('line1'), true);

// ── 32. formatFailureDetail — out of range ─────────────────────────
eq('detail OOR returns null', formatFailureDetail(det, 99), null);

// ── 33. formatFailureDetail — no excerpt ───────────────────────────
const detNoLog = { ...det, failures: [{ code: 'C', step: 's', detail: 'd' }] };
const fd2 = formatFailureDetail(detNoLog, 0);
eq('detail without excerpt works', fd2.includes('C'), true);
eq('detail without excerpt no Log line', fd2.includes('Log excerpt'), false);

// ── 34. JSON report size limit ─────────────────────────────────────
const pj = formatFullJson(passReport);
approx('PASS JSON compact', Buffer.byteLength(pj, 'utf8'), 100, MAX_PASS_JSON_BYTES);

// ── 35. validateReport — bad schemaVersion ─────────────────────────
const vBadPV = validateReport({ ...passReport, schemaVersion: '2.0' });
eq('bad schemaVersion rejected', vBadPV.valid, false);

// ── 36. validateManifest — bad schemaVersion ──────────────────────
const vmBadPV = validateManifest({ ...m, schemaVersion: '2.0' });
eq('manifest bad schemaVersion rejected', vmBadPV.valid, false);

// ── Runner ─────────────────────────────────────────────────────────
let fail = 0;
console.log('\\n=== TEST TEST-EVIDENCE ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);
