#!/usr/bin/env node
/**
 * MCP Test Evidence Server — Issue #19 Phase 2: READ-ONLY Test Evidence MCP.
 *
 * Chỉ đọc test evidence theo Test Evidence Protocol v1 (reporter Phase 1). KHÔNG chạy
 * test, KHÔNG execute arbitrary shell, KHÔNG commit/push/label/merge/deploy.
 *
 * Tools (progressive disclosure):
 *   test_status          — trạng thái test (PASS/FAIL) cho headSha/reportId (summary compact).
 *   test_failures        — danh sách failure (code + step) — mức 1.
 *   test_failure_detail  — chi tiết 1 failure (detail đầy đủ, redacted) — mức 2.
 *   test_log_excerpt     — log excerpt của 1 failure (tối đa N dòng, mặc định 50) — mức 3.
 *   test_finding_map     — map finding → manifest step/gate/test để re-review 1 finding.
 *
 * Zero-dependency: MCP stdio (NDJSON JSON-RPC 2.0). Nguồn: artifact JSON trong
 * `.agent/test-evidence/` + manifest `.agent/test-manifest.json` + Project Registry
 * `.agent/project.json` (Bảo mật Issue #19 §D).
 *
 * Env (mặc định theo <root> = MCP_TEST_EVIDENCE_ROOT || CWD):
 *   MCP_TEST_EVIDENCE_REPO          canonical owner/repo (mặc định manifest.repository).
 *   MCP_TEST_EVIDENCE_MANIFEST      path manifest  (mặc định <root>/.agent/test-manifest.json).
 *   MCP_TEST_EVIDENCE_PROJECT       path project   (mặc định <root>/.agent/project.json).
 *   MCP_TEST_EVIDENCE_ARTIFACT_DIR  thư mục artifact (mặc định <root>/.agent/test-evidence).
 *   MCP_TEST_EVIDENCE_SKIP_REMOTE   =1 → bỏ check git remote (CHỈ cho test/deterministic).
 *
 * Chạy: node mcp-test-evidence/server.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadManifest, safePath, redactReport, redact, formatSummary, formatFailureDetail,
  validateReport, MAX_LOG_EXCERPT_LINES, computeReportId, computeManifestHash,
} from '../scripts/test-evidence-reporter.mjs';
import { runGate, validateGate, buildSandboxEnv, DEFAULT_STEP_TIMEOUT_MS } from './executor.mjs';
import { cacheKey, checkCache, writeCache, prepareRuntime, artifactDirPath, CACHE_TTL_MS, envFingerprint as computeEnvFingerprint, createLock, writeRuntimeReport } from './cache.mjs';
import { computeEnvironmentFingerprint } from '../scripts/test-evidence-reporter.mjs';

export const SERVER_INFO = { name: 'mcp-test-evidence', version: '0.1.0' };

const HEX40 = /^[0-9a-f]{40}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const MAX_EXCERPT_LINES = 500;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function rootOf(env = process.env) {
  return path.resolve(env.MCP_TEST_EVIDENCE_ROOT || process.cwd());
}

// GPT-REV-105 (Finding 1): server tự lấy real Git HEAD, không tin caller.
// Fallback manifest.headSha khi SKIP_REMOTE (test/deterministic).
function realGitHead(root, skipRemote) {
  if (skipRemote) return null; // null → caller ép dùng manifest.headSha
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8', cwd: root, windowsHide: true, timeout: 10_000,
    }).trim();
    return HEX40.test(out) ? out : null;
  } catch { return null; }
}

function buildContext(env = process.env) {
  const root = rootOf(env);
  const manifest = loadManifest(env.MCP_TEST_EVIDENCE_MANIFEST || '.agent/test-manifest.json', root);
  const project = readJson(env.MCP_TEST_EVIDENCE_PROJECT || path.join(root, '.agent', 'project.json'));
  const artifactDir = path.resolve(env.MCP_TEST_EVIDENCE_ARTIFACT_DIR || path.join(root, '.agent', 'test-evidence'));
  const repo = env.MCP_TEST_EVIDENCE_REPO || manifest.repository;
  const skipRemote = env.MCP_TEST_EVIDENCE_SKIP_REMOTE === '1';
  // GPT-REV-105: real Git HEAD — null khi skipRemote hoặc git fail.
  const realHead = realGitHead(root, skipRemote);
  // canonical manifestHash (runtime copy với headSha=HEAD nếu có realHead).
  const manifestForHash = realHead && manifest.headSha !== realHead
    ? { ...manifest, headSha: realHead }
    : manifest;
  const canonicalManifestHash = computeManifestHash(manifestForHash);
  // allowlisted envFingerprint (chỉ version/platform/arch).
  const canonicalEnvFingerprint = computeEnvironmentFingerprint();
  return { root, manifest, project, artifactDir, repo, skipRemote, realHead, canonicalManifestHash, canonicalEnvFingerprint };
}

function gitRemoteMatches(manifestRepo, root) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8', cwd: root, windowsHide: true, timeout: 10_000,
    }).trim();
    const norm = url
      .replace(/^git@[^:]+:/, 'https://github.com/')
      .replace(/\.git$/, '');
    return norm === `https://github.com/${manifestRepo}` ||
           norm === `https://github.com/${manifestRepo}.git`;
  } catch {
    return false;
  }
}

function assertSecurity(args, ctx) {
  if (args.projectId !== undefined && args.projectId !== null && ctx.project.projectId !== args.projectId) {
    throw new Error(`projectId '${args.projectId}' không khớp Project Registry ('${ctx.project.projectId}')`);
  }
  const repo = args.repo || ctx.repo;
  if (repo !== ctx.manifest.repository) {
    throw new Error(`repository '${repo}' không khớp manifest ('${ctx.manifest.repository}')`);
  }
  if (!ctx.skipRemote && !gitRemoteMatches(ctx.manifest.repository, ctx.root)) {
    throw new Error(`origin worktree không khớp manifest repository '${ctx.manifest.repository}'`);
  }
}

function listReports(artifactDir) {
  let entries;
  try {
    entries = readdirSync(artifactDir);
  } catch {
    return [];
  }
  const reports = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || !HEX16.test(name.replace(/\.json$/, ''))) continue;
    try {
      reports.push(readJson(path.join(artifactDir, name)));
    } catch { /* bỏ qua artifact hỏng */ }
  }
  return reports;
}

export function findReport(artifactDirs, { reportId, headSha, manifestHash }) {
  const dirs = Array.isArray(artifactDirs) ? artifactDirs : [artifactDirs];
  const hasId = reportId !== undefined && reportId !== null;
  const hasSha = headSha !== undefined && headSha !== null;
  if (hasId && hasSha) {
    throw new Error('chọn đúng 1 selector: reportId HOẶC headSha, không cả 2');
  }
  if (hasId) {
    if (typeof reportId !== 'string' || !HEX16.test(reportId)) {
      throw new Error('reportId: cần 16-hex (chống path traversal)');
    }
    // GPT-REV-105 (Finding 4): tìm report qua nhiều dir (committed + runtime store).
    for (const artifactDir of dirs) {
      const safe = safePath(reportId, artifactDir);
      if (!safe.ok) continue;
      let report;
      try { report = readJson(safe.filePath); } catch { continue; }
      const v = validateReport(report);
      if (!v.valid) continue;
      // bind identity tuyệt đối: filename/requested id === report.reportId === canonical(head+manifestHash)
      if (report.reportId !== reportId) continue;
      const canonical = computeReportId(report.headSha, report.manifestHash);
      if (report.reportId !== canonical) continue;
      return report;
    }
    throw new Error(`reportId ${reportId}: không có artifact hợp lệ (schema + canonical binding) trong ${dirs.length} dir`);
  }
  if (hasSha) {
    if (typeof headSha !== 'string' || !HEX40.test(headSha)) {
      throw new Error('headSha: cần full 40-hex');
    }
    const candidates = [];
    for (const artifactDir of dirs) {
      for (const r of listReports(artifactDir)) {
        if (r.headSha === headSha && validateReport(r).valid
          && r.reportId === computeReportId(r.headSha, r.manifestHash)) {
          candidates.push(r);
        }
      }
    }
    if (candidates.length === 0) {
      throw new Error(`head=${headSha}: không có report artifact hợp lệ (schema + canonical binding)`);
    }
    if (manifestHash !== undefined && manifestHash !== null) {
      const bound = candidates.filter((r) => r.manifestHash === manifestHash);
      if (bound.length === 1) return bound[0];
      if (bound.length === 0) {
        throw new Error(`head=${headSha}: không có report artifact khớp manifest hiện tại — yêu cầu reportId`);
      }
      throw new Error(`head=${headSha}: nhiều report khớp manifest hiện tại (ambiguous) — yêu cầu reportId`);
    }
    throw new Error(`head=${headSha}: ${candidates.length} report hợp lệ, thiếu binding manifest hiện tại — yêu cầu reportId`);
  }
  throw new Error('cần reportId hoặc headSha');
}

// resolveReport: lookup theo headSha hash canonical giống reporter — hash manifest RUNTIME
// sau khi thay headSha bằng requested HEAD (GPT-REV-098). Reporter (full-verify) giữ file manifest
// immutable (headSha stale) nhưng bind artifact bằng `{...manifest, headSha: currentHead}`. Áp
// đồng quy tắc đó ở đây để test_status({headSha}) đọc đúng artifact canonical. reportId lookup
// độc lập (đã bind canonical sớm trong findReport, không phụ thuộc manifest hiện tại).
function resolveReport(args, ctx) {
  // GPT-REV-105 (Finding 4): tìm report trong cả committed artifact dir và runtime
  // artifact store (nơi test_run ghi CompactReport). test_status/failures/detail/log
  // đều đọc được report do test_run tạo ra.
  const { root: runtimeRootDir } = prepareRuntime(args.projectId || ctx.project.projectId, ctx.root);
  const runtimeArtifactDir = artifactDirPath(cacheKey(args.projectId || ctx.project.projectId, 'x', 'x', 'x', 'x'), runtimeRootDir);
  const dirs = Array.from(new Set([ctx.artifactDir, runtimeArtifactDir]));
  if (args.headSha !== undefined && args.headSha !== null) {
    const manifestForHash = ctx.manifest.headSha === args.headSha
      ? ctx.manifest
      : { ...ctx.manifest, headSha: args.headSha };
    return findReport(dirs, {
      reportId: args.reportId,
      headSha: args.headSha,
      manifestHash: computeManifestHash(manifestForHash),
    });
  }
  return findReport(dirs, { reportId: args.reportId, headSha: args.headSha });
}

function normalizeIndex(v, size) {
  if (!Number.isInteger(v) || v < 0 || v >= size) {
    throw new Error(`failureIndex ${v} ngoài phạm vi (${size} failures)`);
  }
  return v;
}

function clampLines(v) {
  if (v === undefined || v === null) return MAX_LOG_EXCERPT_LINES;
  if (!Number.isInteger(v) || v < 1) throw new Error('maxLines: cần số nguyên dương');
  return Math.min(v, MAX_EXCERPT_LINES);
}

function collectFindings(manifest, report) {
  const stepIndex = new Map();
  for (const [gid, steps] of Object.entries(manifest.gates || {})) {
    for (const s of steps || []) stepIndex.set(s.id, { gate: gid, ...s });
  }
  return (report.failures || []).map((f) => {
    const m = stepIndex.get(f.step);
    return {
      code: f.code,
      step: f.step,
      gate: m?.gate ?? null,
      test: m ? { id: m.id, name: m.name, command: m.command, args: m.args ?? [] } : null,
      detail: redact(f.detail),
    };
  });
}

const repoProp = { type: 'string', description: 'Canonical owner/repo (mặc định manifest.repository)' };
const projectIdProp = { type: 'string', description: 'projectId từ Project Registry (.agent/project.json)' };
const reportIdProp = { type: 'string', pattern: '^[0-9a-f]{16}$', description: 'reportId 16-hex (dấu vết từ compact line)' };
const headShaProp = { type: 'string', pattern: '^[0-9a-f]{40}$', description: 'Full 40-hex HEAD SHA' };
const failureIndexProp = { type: 'integer', minimum: 0, description: 'Index trong failures[*] (bắt đầu 0)' };

export const TOOLS = [
  { name: 'test_run',
    description: 'Chạy gate đã allowlist trong manifest; lưu artifact + cache (PASS chỉ).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: projectIdProp,
        repo: repoProp,
        headSha: headShaProp,
        gate: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$', description: 'gateId trong manifest.gates' },
        manifestHash: { type: 'string', pattern: '^[0-9a-f]+', description: 'SHA256 hex của manifest JSON' },
        envFingerprint: { type: 'string', pattern: '^[0-9a-f]+', description: 'SHA256 của envSnapshot' },
        envSnapshot: { type: 'object', description: 'Chỉ dùng cho fingerprint; metadata tùy chọn cho cache' },
        forceOverwrite: { type: 'boolean', description: 'Nếu true, ghi đè artifact pass cũ (mặc định false)' },
      },
      required: ['headSha', 'gate', 'manifestHash', 'envFingerprint', 'projectId'],
    } },
  { name: 'test_status',
    description: 'Trạng thái test cho headSha/reportId: compact summary PASS/FAIL, tests, blocking, failureCodes. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { projectId: projectIdProp, repo: repoProp, reportId: reportIdProp, headSha: headShaProp,
        gate: { type: 'string', description: 'Tên gate để chú thích (không bắt buộc)' } },
      oneOf: [{ required: ['reportId'] }, { required: ['headSha'] }],
    } },
  { name: 'test_failures',
    description: 'Danh sách failure (code + step) của 1 report — progressive disclosure mức 1. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { projectId: projectIdProp, repo: repoProp, reportId: reportIdProp, headSha: headShaProp },
      oneOf: [{ required: ['reportId'] }, { required: ['headSha'] }],
    } },
  { name: 'test_failure_detail',
    description: 'Chi tiết đầy đủ 1 failure (redacted) — mức 2. Cần failureIndex từ test_failures. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { projectId: projectIdProp, repo: repoProp, reportId: reportIdProp, headSha: headShaProp,
        failureIndex: failureIndexProp },
      required: ['failureIndex'],
      oneOf: [{ required: ['reportId'] }, { required: ['headSha'] }],
    } },
  { name: 'test_log_excerpt',
    description: 'Log excerpt của 1 failure — mức 3. Tối đa maxLines dòng (mặc định 50, cap 500). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { projectId: projectIdProp, repo: repoProp, reportId: reportIdProp, headSha: headShaProp,
        failureIndex: failureIndexProp,
        maxLines: { type: 'integer', minimum: 1, description: 'Số dòng tối đa (mặc định 50, cap 500)' } },
      required: ['failureIndex'],
      oneOf: [{ required: ['reportId'] }, { required: ['headSha'] }],
    } },
  { name: 'test_finding_map',
    description: 'Map finding → manifest step/gate/test — re-review 1 finding không cần nạp cả PR. Lọc theo findingCode nếu cho. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { projectId: projectIdProp, repo: repoProp, reportId: reportIdProp, headSha: headShaProp,
        findingCode: { type: 'string', description: 'Failure code (vd STEP_X_FAIL) để lọc' } },
      oneOf: [{ required: ['reportId'] }, { required: ['headSha'] }],
    } },
  { name: 'test_verify_identity',
    description: 'Server tự tính real identity (Finding 1): real Git HEAD + canonical manifestHash + allowlisted envFingerprint. Caller CHỈ assert expected value (expectHeadSha/expectManifestHash/expectEnvFingerprint); mismatch → fail-closed. KHÔNG gắn status:approved.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: projectIdProp, repo: repoProp,
        gate: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$', description: 'gateId trong manifest.gates' },
        expectHeadSha: { type: 'string', pattern: '^[0-9a-f]{40}$', description: 'Optional: expected real Git HEAD để assert (fail-closed nếu lệch)' },
        expectManifestHash: { type: 'string', pattern: '^[0-9a-f]+', description: 'Optional: expected canonical manifestHash' },
        expectEnvFingerprint: { type: 'string', pattern: '^[0-9a-f]+', description: 'Optional: expected allowlisted envFingerprint' },
      },
      required: ['gate', 'projectId'],
    } },
];

function opStatus(args, ctx) {
  assertSecurity(args, ctx);
  const report = resolveReport(args, ctx);
  const red = redactReport(report);
  return {
    projectId: ctx.project.projectId,
    repository: ctx.manifest.repository,
    headSha: report.headSha,
    passed: report.passed,
    tests: report.tests,
    duration: report.duration,
    blocking: report.blocking ?? 0,
    failureCodes: report.failureCodes ?? [],
    reportId: report.reportId,
    summary: formatSummary(red),
  };
}

function opFailures(args, ctx) {
  assertSecurity(args, ctx);
  const report = resolveReport(args, ctx);
  const red = redactReport(report);
  const list = (red.failures || []).map((f) => ({ code: f.code, step: f.step }));
  return { reportId: report.reportId, headSha: report.headSha, count: list.length, failures: list };
}

function opFailureDetail(args, ctx) {
  assertSecurity(args, ctx);
  const report = resolveReport(args, ctx);
  const idx = normalizeIndex(args.failureIndex, (report.failures || []).length);
  const detail = formatFailureDetail(report, idx);
  return { reportId: report.reportId, headSha: report.headSha, failureIndex: idx, failure: detail };
}

function opLogExcerpt(args, ctx) {
  assertSecurity(args, ctx);
  const report = resolveReport(args, ctx);
  const idx = normalizeIndex(args.failureIndex, (report.failures || []).length);
  const f = redactReport(report).failures[idx];
  const maxLines = clampLines(args.maxLines);
  const text = f.logExcerpt ?? '';
  const lines = text.split('\n');
  return {
    reportId: report.reportId,
    headSha: report.headSha,
    failureIndex: idx,
    code: f.code,
    maxLines,
    truncated: lines.length > maxLines,
    logExcerpt: lines.slice(0, maxLines).join('\n'),
  };
}

function opFindingMap(args, ctx) {
  assertSecurity(args, ctx);
  const report = resolveReport(args, ctx);
  let findings = collectFindings(ctx.manifest, redactReport(report));
  if (args.findingCode !== undefined && args.findingCode !== null) {
    findings = findings.filter((f) => f.code === args.findingCode);
    if (findings.length === 0) throw new Error(`không tìm thấy finding code '${args.findingCode}'`);
  }
  return { reportId: report.reportId, headSha: report.headSha, passed: report.passed, findings };
}

// ── test_run: allowlisted executor + cache + artifact store ─────────────────
function buildCacheDir(root, key) {
  return path.join(root, 'cache', key.slice(0, 2));
}

function createLockSync(root, key) {
  let lockFile, held = false;
  const getLockFile = () => {
    if (!lockFile) {
      const sub = key.slice(0, 2);
      const d = path.join(root, 'locks', sub);
      mkdirSync(d, { recursive: true });
      lockFile = path.join(d, key + '.lock');
    }
    return lockFile;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return {
    async acquire(timeoutMs = 5000) {
      const lf = getLockFile();
      const deadline = Date.now() + timeoutMs;
      while (existsSync(lf)) {
        if (Date.now() > deadline) throw new Error('LOCK_TIMEOUT:' + key);
        await sleep(100);
      }
      writeFileSync(lf, String(process.pid), { mode: 0o644 });
      held = true;
    },
    release() {
      if (held && lockFile) { held = false; try { unlinkSync(lockFile); } catch {} }
    },
  };
}

async function opTestRun(args, ctx) {
  assertSecurity(args, ctx);
  const { projectId, headSha, gate, manifestHash, envFingerprint, forceOverwrite } = args;
  // Validate gate trong manifest
  const gateValidation = validateGate(ctx.manifest, gate, ctx.root);
  if (!gateValidation.valid) {
    throw new Error(`gate '${gate}' không hợp lệ: ${gateValidation.errors.join('; ')}`);
  }
  // Validate headSha
  if (!HEX40.test(headSha)) throw new Error('headSha: cần full 40-hex');
  // Validate manifestHash, envFingerprint hex
  if (!/^[0-9a-f]+$/i.test(manifestHash)) throw new Error('manifestHash: cần hex');
  if (!/^[0-9a-f]+$/i.test(envFingerprint)) throw new Error('envFingerprint: cần hex');
  // Tính cache identity
  const key = cacheKey(projectId, headSha, manifestHash, envFingerprint, gate);
  const { root: runtimeRoot } = prepareRuntime(projectId, ctx.root);
  const cdPath = buildCacheDir(runtimeRoot, key);
  const cached = checkCache(cdPath, key);
  if (cached.valid && !forceOverwrite) {
    const rep = writeRuntimeReport({ projectId, headSha, manifestHash, gateId: gate, envFingerprint }, cached.result, runtimeRoot);
    return { cached: true, projectId, headSha, gate, cacheKey: key, reportId: rep.reportId, passed: true, source: 'cache' };
  }
  const lock = createLock(runtimeRoot, key);
  await lock.acquire();
  try {
    const cached2 = checkCache(buildCacheDir(runtimeRoot, key), key);
    if (cached2.valid && !forceOverwrite) {
      const rep = writeRuntimeReport({ projectId, headSha, manifestHash, gateId: gate, envFingerprint }, cached2.result, runtimeRoot);
      return { cached: true, projectId, headSha, gate, cacheKey: key, reportId: rep.reportId, passed: true, source: 'cache' };
    }
    const result = await runGate(ctx.manifest, gate, { root: ctx.root });
    // GPT-REV-105 (Finding 4): test_run tạo canonical CompactReport vào runtime
    // artifact store; read tools (test_status/failures/detail/log) đọc được qua reportId.
    const rep = writeRuntimeReport({ projectId, headSha, manifestHash, gateId: gate, envFingerprint }, result, runtimeRoot);
    if (result.passed) {
      writeCache({ projectId, headSha, gateId: gate, manifestHash, envFingerprint }, result, key, runtimeRoot);
    }
    return {
      cached: false, projectId, headSha, gate, cacheKey: key, reportId: rep.reportId,
      artifactDir: rep.artifactDir,
      duration: result.duration, passed: result.passed,
      failureCodes: result.failureCodes, source: 'executor',
    };
  } finally {
    lock.release();
  }
}

// ── test_verify_identity: server tự tính real identity (Finding 1) ───────────
// Server lấy real Git HEAD, canonical manifestHash, allowlisted envFingerprint.
// Caller CHỈ được assert expected value; mismatch → fail-closed. Bỏ self-prove
// tuần hoàn (REV-101): không còn tự-reference, không gắn status:approved.
function opVerifyIdentity(args, ctx) {
  assertSecurity(args, ctx);
  const { projectId, gate } = args;
  if (!ctx.manifest.gates || !Array.isArray(ctx.manifest.gates[gate])) {
    throw new Error(`gate '${gate}' không tồn tại trong manifest`);
  }
  // realGitHead: dùng HEAD git thật nếu có, ngược lại manifest.headSha (SKIP_REMOTE/test).
  const realHead = ctx.realHead || ctx.manifest.headSha;
  if (!HEX40.test(realHead)) throw new Error('real HEAD: cần full 40-hex');
  // canonical manifestHash tính bởi server (runtime copy với headSha=realHead).
  const manifestForHash = ctx.manifest.headSha !== realHead
    ? { ...ctx.manifest, headSha: realHead }
    : ctx.manifest;
  const canonicalManifestHash = computeManifestHash(manifestForHash);
  // allowlisted envFingerprint (chỉ version/platform/arch).
  const canonicalEnvFingerprint = computeEnvironmentFingerprint();
  const key = cacheKey(projectId, realHead, canonicalManifestHash, canonicalEnvFingerprint, gate);

  // Caller được assert expected; nếu truyền thì phải khớp (fail-closed).
  const mismatch = {};
  if (args.expectHeadSha !== undefined && args.expectHeadSha !== null && args.expectHeadSha !== realHead) {
    mismatch.headSha = { expected: args.expectHeadSha, actual: realHead };
  }
  if (args.expectManifestHash !== undefined && args.expectManifestHash !== null && args.expectManifestHash !== canonicalManifestHash) {
    mismatch.manifestHash = { expected: args.expectManifestHash, actual: canonicalManifestHash };
  }
  if (args.expectEnvFingerprint !== undefined && args.expectEnvFingerprint !== null && args.expectEnvFingerprint !== canonicalEnvFingerprint) {
    mismatch.envFingerprint = { expected: args.expectEnvFingerprint, actual: canonicalEnvFingerprint };
  }
  if (Object.keys(mismatch).length > 0) {
    const err = new Error('IDENTITY_MISMATCH (fail-closed): ' + JSON.stringify(mismatch));
    err.code = 'IDENTITY_MISMATCH';
    err.mismatch = mismatch;
    throw err;
  }
  return {
    selfComputed: true,
    server: SERVER_INFO,
    projectId, gate,
    headSha: realHead,
    manifestHash: canonicalManifestHash,
    envFingerprint: canonicalEnvFingerprint,
    cacheKey: key,
    note: 'Server tự tính real identity; caller chỉ assert expected. KHÔNG gắn status:approved (pre-reviewer).',
  };
}

export async function dispatch(name, args) {
  const ctx = buildContext();
  switch (name) {
    case 'test_run': return await opTestRun(args, ctx);
    case 'test_status': return opStatus(args, ctx);
    case 'test_failures': return opFailures(args, ctx);
    case 'test_failure_detail': return opFailureDetail(args, ctx);
    case 'test_log_excerpt': return opLogExcerpt(args, ctx);
    case 'test_finding_map': return opFindingMap(args, ctx);
    case 'test_verify_identity': return opVerifyIdentity(args, ctx);
    default: throw new Error(`Tool không tồn tại: ${name}`);
  }
}
// ── MCP stdio transport (NDJSON JSON-RPC 2.0) ─────────────────────
function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      } };
    }
    if (method.startsWith('notifications/')) return undefined;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    if (method === 'tools/call') {
      const { name, arguments: args } = params ?? {};
      try {
        // GPT-REV-100: await dispatch trước khi stringify — thiếu await thì textResult
        // nhận Promise (JSON.stringify(Promise) === '{}'), client không thấy kết quả.
        return { jsonrpc: '2.0', id, result: textResult(await dispatch(name, args ?? {})) };
      } catch (err) {
        return { jsonrpc: '2.0', id, result: textResult({ error: err.message }, true) };
      }
    }
    if (!isNotification) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    return undefined;
  } catch (err) {
    if (isNotification) return undefined;
    return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message } };
  }
}

async function main() {
  process.stderr.write(`[${SERVER_INFO.name}] khởi động, repo=${buildContext().repo}\n`);
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify(
          { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        continue;
      }
      const res = await handleRequest(msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[${SERVER_INFO.name}] fatal: ${err.message}\n`);
    process.exit(1);
  });
}