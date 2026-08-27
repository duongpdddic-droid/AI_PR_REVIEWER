#!/usr/bin/env node
// test-test-evidence.mjs — Test suite cho Test Evidence Protocol v1 (Issue #19 Phase 1).
// Assert-based, không framework. Exit 0 = PASS, 1 = FAIL.
import {
  computeEnvironmentFingerprint, computeManifestHash, computeReportId,
  formatCompactLine, formatFullJson, saveReport,
  validateReport, validateManifest, redact, redactReport,
  failureCodeFromStep, formatSummary, formatFailureDetail,
  loadManifest, safePath,
  MAX_PASS_JSON_BYTES,
} from './test-evidence-reporter.mjs';
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
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

// ── 36. loadManifest — valid file ──────────────────────────────────
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-'));
  const mf = { schemaVersion: '1.0', projectId: 'x', repository: 'o/r', headSha: SHA, gates: { v: [{ id: 's1', name: 'step1', command: 'node' }] } };
  writeFileSync(join(tmpDir, 'test-manifest.json'), JSON.stringify(mf), 'utf8');
  const loaded = loadManifest('test-manifest.json', tmpDir);
  eq('loadManifest returns object', typeof loaded, 'object');
  eq('loadManifest projectId', loaded.projectId, 'x');
  rmSync(tmpDir, { recursive: true, force: true });
}

// ── 37. safePath — valid hex16 ─────────────────────────────────────
{
  const sp = safePath('a'.repeat(16), '/tmp/artifacts');
  eq('safePath valid ok', sp.ok, true);
  tru('safePath valid filePath ends with reportId', sp.filePath.includes('aaaaaaaaaaaaaaaa.json'));
}

// ── 38. safePath — rejects non-hex ─────────────────────────────────
{
  const sp = safePath('../../etc/passwd', '/tmp/artifacts');
  eq('safePath traversal rejected', sp.ok, false);
}

// ── 39. safePath — rejects short id ────────────────────────────────
{
  const sp = safePath('abc', '/tmp/artifacts');
  eq('safePath short id rejected', sp.ok, false);
}

// ── 40. validateReport — rejects extra properties ──────────────────
{
  const v = validateReport({ ...passReport, extraField: 'bad' });
  eq('extra property rejected', v.valid, false);
  tru('extra property error message', v.errors.some((e) => e.includes('unexpected property')));
}

// ── 41. validateReport — rejects extra in failures ─────────────────
{
  const v = validateReport({
    ...failReport,
    failures: [{ code: 'STEP_X_FAIL', step: 'x', detail: 'd', extraField: 'bad' }],
  });
  eq('failure extra property rejected', v.valid, false);
}

// ── 42. validateReport — rejects bad failure code format ───────────
{
  const v = validateReport({
    ...failReport,
    failures: [{ code: 'lowercase', step: 'x', detail: 'd' }],
  });
  eq('bad failure code format rejected', v.valid, false);
}

// ── 43. validateManifest — rejects extra properties ────────────────
{
  const v = validateManifest({ ...m, extraField: 'bad' });
  eq('manifest extra property rejected', v.valid, false);
}

// ── 44. validateManifest — rejects empty projectId ─────────────────
{
  const v = validateManifest({ ...m, projectId: '' });
  eq('manifest empty projectId rejected', v.valid, false);
}

// ── 45. validateManifest — rejects empty headSha ───────────────────
{
  const v = validateManifest({ ...m, headSha: '' });
  eq('manifest empty headSha rejected', v.valid, false);
}

// ── 46. validateManifest — rejects step extra properties ───────────
{
  const v = validateManifest({ ...m, gates: { v: [{ id: 's1', name: 'x', command: 'node', extra: 'bad' }] } });
  eq('step extra property rejected', v.valid, false);
}

// ── 47. validateManifest — rejects invalid step timeout ────────────
{
  const v = validateManifest({ ...m, gates: { v: [{ id: 's1', name: 'x', command: 'node', timeout: -1 }] } });
  eq('step invalid timeout rejected', v.valid, false);
}

// ── 48. validateManifest — rejects non-array args ──────────────────
{
  const v = validateManifest({ ...m, gates: { v: [{ id: 's1', name: 'x', command: 'node', args: 'bad' }] } });
  eq('step non-array args rejected', v.valid, false);
}

// ── 49. redactReport — deep redact failures ────────────────────────
{
  const report = {
    ...failReport,
    failures: [{
      code: 'STEP_X_FAIL', step: 'x',
      detail: 'api_key = "supersecretkeyvalue1234567890"',
      logExcerpt: 'password = "hunter2" in log',
    }],
  };
  const redacted = redactReport(report);
  eq('redactReport detail redacted', redacted.failures[0].detail, '[REDACTED_API_KEY]');
  eq('redactReport logExcerpt redacted', redacted.failures[0].logExcerpt, '[REDACTED_SECRET] in log');
  tru('redactReport preserves original', report.failures[0].detail.includes('supersecretkey'));
}

// ── 50. formatFullJson — redacts secrets in output ─────────────────
{
  const report = {
    ...failReport,
    failures: [{
      code: 'STEP_X_FAIL', step: 'x',
      detail: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test',
      logExcerpt: 'mongodb://user:pass@host:27017/db',
    }],
  };
  const json = formatFullJson(report);
  eq('formatFullJson no Bearer token', json.includes('eyJhbGciOiJIUzI1NiJ9.test'), false);
  eq('formatFullJson no conn string', json.includes('mongodb://user:pass'), false);
}

// ── 51. saveReport — rejects invalid report ────────────────────────
{
  let threw = false;
  try { saveReport({ bad: true }, '/tmp'); } catch { threw = true; }
  eq('saveReport rejects invalid', threw, true);
}

// ── 52. saveReport — rejects bad reportId ──────────────────────────
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-'));
  const bad = { ...passReport, reportId: 'zzzzzzzzzzzzzzzz' };
  let threw = false;
  try { saveReport(bad, tmpDir); } catch { threw = true; }
  eq('saveReport rejects bad reportId', threw, true);
  rmSync(tmpDir, { recursive: true, force: true });
}

// ── 53. saveReport — writes redacted content ───────────────────────
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'ev-test-'));
  const report = {
    ...failReport,
    failures: [{
      code: 'STEP_X_FAIL', step: 'x',
      detail: 'api_key = "supersecretkeyvalue1234567890"',
      logExcerpt: 'token = "ghp_abc123def456"',
    }],
  };
  const fpath = saveReport(report, tmpDir);
  const content = readFileSync(fpath, 'utf8');
  eq('saved file no plaintext secret', content.includes('supersecretkeyvalue1234567890'), false);
  eq('saved file no plaintext token', content.includes('ghp_abc123def456'), false);
  tru('saved file has REDACTED_API_KEY', content.includes('[REDACTED_API_KEY]'));
  rmSync(tmpDir, { recursive: true, force: true });
}

// ── 54. formatSummary — redacts secrets in FAIL output ─────────────
{
  const report = {
    ...failReport,
    failures: [{ code: 'STEP_X_FAIL', step: 'x', detail: 'password = "hunter2" leaked' }],
  };
  const summary = formatSummary(report);
  eq('summary no plaintext password', summary.includes('hunter2'), false);
  tru('summary has REDACTED', summary.includes('[REDACTED_SECRET]'));
}

// ── 55. formatFailureDetail — redacts secrets ──────────────────────
{
  const report = {
    ...failReport,
    failures: [{
      code: 'STEP_X_FAIL', step: 'x',
      detail: 'api_key = "supersecretkeyvalue1234567890"',
      logExcerpt: 'Bearer eyJhbGciOiJIUzI1NiJ9.test',
    }],
  };
  const detail = formatFailureDetail(report, 0);
  eq('detail redacted api_key', detail.includes('supersecretkeyvalue1234567890'), false);
  eq('detail redacted Bearer', detail.includes('eyJhbGciOiJIUzI1NiJ9.test'), false);
}

// ── 56. loadManifest — throws on missing file ──────────────────────
{
  let threw = false;
  try { loadManifest('nonexistent.json', '/tmp'); } catch { threw = true; }
  eq('loadManifest throws on missing', threw, true);
}

// ── 57. evidence pipeline builds canonical report (mirrors full-verify --evidence) ──
{
  const manifest = loadManifest('.agent/test-manifest.json', process.cwd());
  const mv = validateManifest(manifest);
  tru('pipeline manifest valid', mv.valid);
  const manifestHash = computeManifestHash(manifest);
  const report = {
    schemaVersion: '1.0',
    headSha: SHA,
    passed: true,
    tests: { passed: 5, failed: 0, total: 5 },
    duration: 1234,
    reportId: computeReportId(SHA, manifestHash),
    manifestHash,
    blocking: 0,
    failureCodes: [],
    failures: [],
  };
  const rv = validateReport(report);
  tru('pipeline report valid', rv.valid);
  const line = formatCompactLine(report);
  eq('pipeline line format', line, `VERIFY PASS head=${SHA} tests=5/5 blocking=0 duration=1234ms report=${report.reportId}`);
}

// ── 58. manifest load + validate in pipeline ───────────────────────
{
  const loaded = loadManifest('.agent/test-manifest.json', process.cwd());
  const v = validateManifest(loaded);
  tru('self-repo manifest valid', v.valid);
}

// ── Runner ─────────────────────────────────────────────────────────
let fail = 0;
console.log('\\n=== TEST TEST-EVIDENCE ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);
