#!/usr/bin/env node
// full-verify.mjs — orchestrator verify DUY NHẤT trước khi bàn giao PR.
// Khung dự án mới (AI_PR_REVIEWER): phiên bản tổng quát, KHÔNG gắn với GAS/CSV/HTML.
// Chạy tuần tự mọi bước, KHÔNG dừng khi 1 bước fail; tổng kết cuối bằng bảng PASS/FAIL.
// Các bước:
//   1) node --check mọi file .js/.mjs trong scripts/ + gốc + src/ (nếu có)
//   2) Quét BOM (U+FEFF) trên toàn bộ file text của dự án
//   3) Quét duplicate top-level function theo từng file JS scan
//   4) Chạy scripts/test-pure-logic.mjs nếu tồn tại (test runner) — thiếu thì bỏ qua (không lỗi)
//   5) Behavior map: refresh qua extract-behavior-map.mjs nếu có + so baseline nếu có; thiếu baseline -> skip
// Tự dọn file tạm (05-terminal-safety.md §3). Exit 0 = ALL PASS, 1 = có FAIL.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const node = process.execPath;
const results = [];
const add = (name, ok, detail = '') => results.push({ name, ok, detail });
const startTime = Date.now();

const tmpFiles = [];
const tmp = (ext = '.mjs') => {
  const p = path.join(os.tmpdir(), `fv-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  tmpFiles.push(p);
  return p;
};
const cleanup = () => { for (const p of tmpFiles) { try { fs.unlinkSync(p); } catch {} } };

const walkJs = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === '.git') continue; walk(p); }
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
    }
  };
  walk(dir);
  return out;
};

const rootJs = [...walkJs(path.join(ROOT, 'scripts'))];
if (fs.existsSync(path.join(ROOT, 'src'))) rootJs.push(...walkJs(path.join(ROOT, 'src')));
const jsFiles = [...new Set(rootJs)].sort();

try {
  // 1. node --check
  if (jsFiles.length === 0) {
    add('node --check (không có file JS — skip)', true, 'skip');
  } else {
    for (const f of jsFiles) {
      const r = spawnSync(node, ['--check', f], { encoding: 'utf8' });
      add(`node --check ${path.relative(ROOT, f).split(path.sep).join('/')}`, r.status === 0, r.status === 0 ? '' : (r.stderr || '').trim().split('\n').slice(0, 3).join(' | '));
    }
  }

  // 2. BOM scan (U+FEFF) trên file text liên quan
  const mdGlob = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_archive'));
  const textFiles = [
    ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).map((f) => path.join('scripts', f)),
    ...mdGlob(path.join(ROOT, '.clinerules')).map((f) => path.join('.clinerules', f)),
    ...mdGlob(path.join(ROOT, 'memory-bank')).map((f) => path.join('memory-bank', f)),
    ...fs.existsSync(path.join(ROOT, 'docs')) ? mdGlob(path.join(ROOT, 'docs')).map((f) => path.join('docs', f)) : [],
    ...fs.existsSync(path.join(ROOT, '.agent')) ? fs.readdirSync(path.join(ROOT, '.agent')).filter((f) => f.endsWith('.md') || f.endsWith('.json')).map((f) => path.join('.agent', f)) : [],
    ...(fs.existsSync(path.join(ROOT, 'package.json')) ? ['package.json'] : []),
  ];
  let bom = 0;
  for (const f of textFiles) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) bom++;
  }
  add(`BOM scan (U+FEFF = 0) trên ${textFiles.length} file`, bom === 0, bom === 0 ? '' : `${bom} file có BOM`);

  // 3. duplicate top-level function THEO TỪNG FILE (mỗi file là 1 runtime/scope riêng)
  const collectNames = (src) => {
    const names = [];
    for (const line of src.split('\n')) {
      if (/^\s/.test(line)) continue;
      let mm = line.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (!mm) mm = line.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|\()/);
      if (mm) names.push(mm[1]);
    }
    return names;
  };
  for (const f of jsFiles) {
    const ns = collectNames(fs.readFileSync(f, 'utf8'));
    const dup = [...new Set(ns.filter((n, i) => ns.indexOf(n) !== i))];
    add(`Dup top-level fn ${path.relative(ROOT, f).split(path.sep).join('/')} = 0`, dup.length === 0, dup.length ? 'trùng: ' + dup.join(', ') : '');
  }

  // 4. test suites (nếu tồn tại) — Issue #6 C2: một lệnh pnpm verify tổng hợp mọi gate.
  const optionalSuites = [
    'test-pure-logic.mjs',
    'test-pre-push-guard.mjs',
    'test-integration-orchestrator.mjs',
    'test-integration-approval-gate.mjs',
    'test-integration-review-runtime.mjs',
    'test-effective-policy.mjs',
    'test-review-phases.mjs',
    'test-gpt-approval-manual-exception.mjs',
    'test-gpt-approval-getgatestate.mjs',
    'test-context-routing.mjs',
    'test-context-manager.mjs',
    'test-memory-core.mjs',
    'test-error-recovery.mjs',
    'test-runtime-hooks.mjs',
    'test-tg-notify.mjs',
    'test-protocol-drift.mjs',
    'test-project-registry.mjs',
    'test-test-evidence.mjs',
    'test-temp-hygiene.mjs',
  ];
  // GPT-REV-104: đăng ký test suite của MCP Test Evidence (Issue #19 Phase 3) nằm
  // ngoài scripts/ để full-verify tự chạy như 1 gate tổng hợp.
  const mcpSuites = [
    'mcp-test-evidence/test-executor.mjs',
    'mcp-test-evidence/test-server.mjs',
  ];
  const resolveSuite = (s) => {
    const direct = path.join(ROOT, s);
    if (fs.existsSync(direct)) return direct;
    // Suite trong scripts/ — root cause fix: entry không prefix `scripts/` (Issue #36).
    return path.join(ROOT, 'scripts', s);
  };
  for (const suite of [...optionalSuites, ...mcpSuites]) {
    const f = resolveSuite(suite);
    if (!fs.existsSync(f)) { add(`${suite} (bỏ qua — chưa tồn tại)`, true, 'skip'); continue; }
    const r = spawnSync(node, [f], { encoding: 'utf8', env: { ...process.env, FULL_VERIFY_CHILD: '1' } });
    add(suite, r.status === 0, r.status === 0 ? '' : (r.stdout || r.stderr || '').trim().split('\n').filter((l) => /FAIL|Error|assert/i.test(l)).slice(-3).join(' | ') || (r.stderr || '').trim().split('\n').slice(-3).join(' | '));
  }

  // 4b. git diff --check (whitespace errors / conflict markers trong thay đổi staged+unstaged).
  {
    const gd = spawnSync('git', ['diff', '--check'], { encoding: 'utf8', cwd: ROOT });
    const ok = gd.status === 0;
    add('git diff --check', ok, ok ? '' : (gd.stdout || gd.stderr || '').trim().split('\n').slice(0, 3).join(' | '));
  }

  // 5. behavior map: refresh + baseline compare (baseline thiếu -> skip, không fail)
  const extractMap = path.join(ROOT, 'scripts', 'extract-behavior-map.mjs');
  if (fs.existsSync(extractMap) && jsFiles.length > 0) {
    const rm = spawnSync(node, [extractMap], { encoding: 'utf8' });
    add('Refresh behavior map (extract-behavior-map.mjs)', rm.status === 0, rm.status === 0 ? '' : (rm.stderr || '').trim().split('\n').slice(0, 3).join(' | '));
  } else {
    add('Refresh behavior map (bỏ qua — chưa có nguồn/extractor)', true, 'skip');
  }

  const base = path.join(ROOT, 'scripts', 'behavior-map-baseline.json');
  const cur = path.join(ROOT, 'scripts', 'behavior-map-current.json');
  if (fs.existsSync(base) && fs.existsSync(cur)) {
    const same = fs.readFileSync(base, 'utf8') === fs.readFileSync(cur, 'utf8');
    add('Behavior map baseline compare', same, same ? '' : 'baseline và current lệch nhau — chạy pnpm test:baseline nếu thay đổi đã chủ đích');
  } else {
    add('Behavior map baseline compare (bỏ qua — chưa có baseline)', true, 'skip');
  }
} finally {
  cleanup();
}

const pass = results.filter((r) => r.ok).length;

// --evidence: compact one-line output (Test Evidence Protocol v1)
const evidenceMode = process.argv.includes('--evidence');
if (evidenceMode) {
  const { loadManifest, computeManifestHash, computeReportId, validateReport, validateManifest, redactReport, saveReport, failureCodeFromStep, formatCompactLine } = await import('./test-evidence-reporter.mjs');
  const headSha = (() => {
    try {
      const { stdout } = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT });
      return (stdout || '').trim();
    } catch { return 'unknown'; }
  })();
  const failed = results.filter((r) => !r.ok);
  const duration = Date.now() - startTime;

  // Load + validate manifest fail-closed
  let manifest, manifestHash;
  try {
    manifest = loadManifest('.agent/test-manifest.json', ROOT);
  } catch (e) {
    console.error(formatCompactLine({ passed: false, headSha, blocking: 1, failureCodes: ['MANIFEST_LOAD_FAIL'], reportId: '0'.repeat(16), tests: { passed: pass, failed: failed.length + 1, total: results.length } }));
    process.exit(1);
  }
  {
    const mv = validateManifest(manifest);
    if (!mv.valid) { console.error(formatCompactLine({ passed: false, headSha, blocking: 1, failureCodes: ['MANIFEST_INVALID'], reportId: '0'.repeat(16), tests: { passed: pass, failed: failed.length + 1, total: results.length } })); process.exit(1); }
  }
  manifestHash = computeManifestHash(manifest);

  // GPT-REV-090: runtime manifest copy (headSha=HEAD) for hash; file stays immutable
  const manifestForHash = manifest.headSha === headSha
    ? manifest
    : { ...manifest, headSha };
  manifestHash = computeManifestHash(manifestForHash);

  // Build report via canonical pipeline
  const report = {
    schemaVersion: '1.0',
    headSha,
    passed: failed.length === 0,
    tests: { passed: pass, failed: failed.length, total: results.length },
    duration,
    reportId: computeReportId(headSha, manifestHash),
    manifestHash,
    blocking: failed.length,
    failureCodes: failed.map((r) => failureCodeFromStep(r.name)),
    failures: failed.map((r) => ({
      code: failureCodeFromStep(r.name),
      step: r.name,
      detail: r.detail || 'no detail',
    })),
  };

  const rv = validateReport(report);
  if (!rv.valid) {
    const failReport = { ...report, passed: false, blocking: 1, failureCodes: ['ARTIFACT_WRITE_FAIL'], failures: [{ code: 'ARTIFACT_WRITE_FAIL', step: 'evidence', detail: `report invalid: ${rv.errors.join('; ')}` }] };
    console.error(formatCompactLine(failReport));
    process.exit(1);
  }

  // GPT-REV-091: saveReport failure → VERIFY FAIL (not swallowed, not stack trace)
  try {
    saveReport(redactReport(report), path.join(ROOT, '.agent', 'test-evidence'));
  } catch (e) {
    const failReport = { ...report, passed: false, blocking: 1, failureCodes: ['ARTIFACT_WRITE_FAIL'], failures: [{ code: 'ARTIFACT_WRITE_FAIL', step: 'evidence', detail: e.message || String(e) }] };
    console.error(formatCompactLine(failReport));
    process.exit(1);
  }
  console.log(formatCompactLine(report));
} else {
  const w = Math.max(10, ...results.map((r) => r.name.length));
  const bar = (s) => '─'.repeat(s);
  console.log('\n=== FULL-VERIFY REPORT ===');
  console.log('┌' + bar(w + 2) + '┬───────┬──────────────────────────────────────┐');
  for (const r of results) {
    console.log('│ ' + r.name.padEnd(w) + ' │ ' + (r.ok ? 'PASS' : 'FAIL').padEnd(5) + ' │ ' + (r.detail || '').slice(0, 38).padEnd(38) + ' │');
  }
  console.log('└' + bar(w + 2) + '┴───────┴──────────────────────────────────────┘');
  console.log(`Tổng: ${pass}/${results.length} PASS`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);