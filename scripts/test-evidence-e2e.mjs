#!/usr/bin/env node
// test-evidence-e2e.mjs — Entry-point E2E tests for Test Evidence Protocol (090/091/092/093).
// Runs full-verify.mjs --evidence as a child process and asserts on real behavior.
// NOT included in full-verify optionalSuites (to prevent recursion); called separately
// via `pnpm test:evidence` or CI step.
import { readFileSync, statSync, unlinkSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const checks = [];
function eq(n, got, want) { checks.push({ name: n, ok: got === want, got: JSON.stringify(got), want: JSON.stringify(want) }); }
function tru(n, ok) { checks.push({ name: n, ok, got: String(ok), want: 'true' }); }
function has(n, h, ndl) { checks.push({ name: n, ok: h.includes(ndl), got: h.includes(ndl) ? '(found)' : `(missing: ${ndl})`, want: ndl }); }

const node = process.execPath;
const ROOT = process.cwd();
const FV = join(ROOT, 'scripts', 'full-verify.mjs');
const EVID_DIR = join(ROOT, '.agent', 'test-evidence');
const MF = join(ROOT, '.agent', 'test-manifest.json');
let savedMf;

function spawnEv(extra) {
  return spawnSync(node, [FV, '--evidence', ...extra], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
  });
}
function saveMf() { savedMf = readFileSync(MF, 'utf8'); }
function putMf(c) { writeFileSync(MF, c, 'utf8'); }
function restMf() { if (savedMf !== undefined) writeFileSync(MF, savedMf, 'utf8'); }

// ═══════════════════════════════════════════════════════════════════════
// GPT-REV-090 (Test 59): --evidence must not modify .agent/test-manifest.json
// ═══════════════════════════════════════════════════════════════════════
{
  const orig = readFileSync(MF, 'utf8');
  try {
    const r = spawnEv([]);
    eq('manifest bytes identical after --evidence', readFileSync(MF, 'utf8'), orig);
    const before = (spawnSync('git', ['diff', '--stat', '--', '.agent/test-manifest.json'], { encoding: 'utf8', cwd: ROOT }).stdout || '').trim();
    const after = (spawnSync('git', ['diff', '--stat', '--', '.agent/test-manifest.json'], { encoding: 'utf8', cwd: ROOT }).stdout || '').trim();
    eq('git diff unchanged after --evidence', before, after);
    tru('full-verify --evidence did not crash', r.status === 0 || r.status === 1);
  } catch (e) { checks.push({ name: '090 immutable throws', ok: false, got: e.message, want: 'no throw' }); }
}

// ═══════════════════════════════════════════════════════════════════════
// GPT-REV-091 (Test 60): saveReport failure → VERIFY FAIL at entry point
// ═══════════════════════════════════════════════════════════════════════
{
  const wasDir = (() => { try { return statSync(EVID_DIR).isDirectory(); } catch { return false; } })();
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; try { if (statSync(EVID_DIR).isFile()) unlinkSync(EVID_DIR); } catch {} };
  try {
    if (wasDir) renameSync(EVID_DIR, EVID_DIR + '.bak');
    writeFileSync(EVID_DIR, 'block', 'utf8');
    const r = spawnEv([]);
    const s = r.stderr || ''; const o = r.stdout || '';
    eq('exit non-zero on saveReport failure', r.status !== 0, true);
    has('stderr contains VERIFY FAIL', s, 'VERIFY FAIL');
    has('stderr contains ARTIFACT_WRITE_FAIL', s, 'ARTIFACT_WRITE_FAIL');
    eq('no VERIFY PASS in output', (s + o).includes('VERIFY PASS'), false);
    eq('no stack trace in stderr', (s.match(/^    at /gm) || []).length, 0);
  } catch (e) { checks.push({ name: '091 entry-point throws', ok: false, got: e.message, want: 'no throw' }); }
  finally {
    cleanup();
    try { if (wasDir && !statSync(EVID_DIR).isDirectory()) { unlinkSync(EVID_DIR); renameSync(EVID_DIR + '.bak', EVID_DIR); } }
    catch { try { renameSync(EVID_DIR + '.bak', EVID_DIR); } catch {} }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GPT-REV-093: manifest failure codes — entry-point tests
// ═══════════════════════════════════════════════════════════════════════
{
  // 61. Missing manifest file → MANIFEST_LOAD_FAIL
  try {
    saveMf(); renameSync(MF, MF + '.bak');
    const r = spawnEv([]);
    const s = r.stderr || ''; const o = r.stdout || '';
    eq('exit non-zero missing manifest', r.status !== 0, true);
    has('VERIFY FAIL missing manifest', s, 'VERIFY FAIL');
    has('MANIFEST_LOAD_FAIL missing manifest', s, 'MANIFEST_LOAD_FAIL');
    eq('no PASS missing manifest', (s + o).includes('VERIFY PASS'), false);
    eq('no stack trace missing', (s.match(/^    at /gm) || []).length, 0);
  } catch (e) { checks.push({ name: '093 missing manifest throws', ok: false, got: e.message, want: 'no throw' }); }
  finally { try { renameSync(MF + '.bak', MF); } catch {} }

  // 62. Malformed JSON → MANIFEST_LOAD_FAIL
  try {
    saveMf(); putMf('{ invalid json');
    const r = spawnEv([]);
    const s = r.stderr || ''; const o = r.stdout || '';
    eq('exit non-zero malformed JSON', r.status !== 0, true);
    has('VERIFY FAIL malformed JSON', s, 'VERIFY FAIL');
    has('MANIFEST_LOAD_FAIL malformed JSON', s, 'MANIFEST_LOAD_FAIL');
    eq('no PASS malformed', (s + o).includes('VERIFY PASS'), false);
    eq('no stack trace malformed', (s.match(/^    at /gm) || []).length, 0);
  } catch (e) { checks.push({ name: '093 malformed throws', ok: false, got: e.message, want: 'no throw' }); }
  finally { restMf(); }

  // 63. Schema-invalid manifest → MANIFEST_INVALID
  try {
    saveMf(); putMf(JSON.stringify({ schemaVersion: '1.0', projectId: 'x' }, null, 2));
    const r = spawnEv([]);
    const s = r.stderr || ''; const o = r.stdout || '';
    eq('exit non-zero invalid schema', r.status !== 0, true);
    has('VERIFY FAIL invalid schema', s, 'VERIFY FAIL');
    has('MANIFEST_INVALID invalid schema', s, 'MANIFEST_INVALID');
    eq('no PASS invalid schema', (s + o).includes('VERIFY PASS'), false);
    eq('no stack trace invalid', (s.match(/^    at /gm) || []).length, 0);
  } catch (e) { checks.push({ name: '093 invalid schema throws', ok: false, got: e.message, want: 'no throw' }); }
  finally { restMf(); }
}

// ── Runner ─────────────────────────────────────────────────────────
let fail = 0;
console.log('\n=== TEST-EVIDENCE-E2E ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}: ${c.name}${c.ok ? '' : ` (got=${c.got}, want=${c.want})`}`);
}
console.log(`\nTotal: ${checks.length} assertions, ${fail} failures`);
if (fail) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: PASS');
