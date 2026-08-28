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
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadManifest, safePath, redactReport, redact, formatSummary, formatFailureDetail,
  validateReport, MAX_LOG_EXCERPT_LINES, computeReportId, computeManifestHash,
} from '../scripts/test-evidence-reporter.mjs';

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

function buildContext(env = process.env) {
  const root = rootOf(env);
  const manifest = loadManifest(env.MCP_TEST_EVIDENCE_MANIFEST || '.agent/test-manifest.json', root);
  const project = readJson(env.MCP_TEST_EVIDENCE_PROJECT || path.join(root, '.agent', 'project.json'));
  const artifactDir = path.resolve(env.MCP_TEST_EVIDENCE_ARTIFACT_DIR || path.join(root, '.agent', 'test-evidence'));
  const repo = env.MCP_TEST_EVIDENCE_REPO || manifest.repository;
  const skipRemote = env.MCP_TEST_EVIDENCE_SKIP_REMOTE === '1';
  return { root, manifest, project, artifactDir, repo, skipRemote };
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

export function findReport(artifactDir, { reportId, headSha, manifestHash }) {
  const hasId = reportId !== undefined && reportId !== null;
  const hasSha = headSha !== undefined && headSha !== null;
  if (hasId && hasSha) {
    throw new Error('chọn đúng 1 selector: reportId HOẶC headSha, không cả 2');
  }
  if (hasId) {
    if (typeof reportId !== 'string' || !HEX16.test(reportId)) {
      throw new Error('reportId: cần 16-hex (chống path traversal)');
    }
    const safe = safePath(reportId, artifactDir);
    if (!safe.ok) throw new Error(safe.reason);
    const report = readJson(safe.filePath);
    const v = validateReport(report);
    if (!v.valid) throw new Error(`report artifact sai schema: ${v.errors.join('; ')}`);
    // bind identity tuyệt đối: filename/requested id === report.reportId === canonical(head+manifestHash)
    if (report.reportId !== reportId) {
      throw new Error(`report artifact identity lệch: file=${reportId} reportId=${report.reportId}`);
    }
    const canonical = computeReportId(report.headSha, report.manifestHash);
    if (report.reportId !== canonical) {
      throw new Error(`report artifact reportId ${report.reportId} không khớp canonical (head+manifestHash)`);
    }
    return report;
  }
  if (hasSha) {
    if (typeof headSha !== 'string' || !HEX40.test(headSha)) {
      throw new Error('headSha: cần full 40-hex');
    }
    const candidates = listReports(artifactDir).filter(
      (r) => r.headSha === headSha && validateReport(r).valid
        && r.reportId === computeReportId(r.headSha, r.manifestHash),
    );
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
  if (args.headSha !== undefined && args.headSha !== null) {
    const manifestForHash = ctx.manifest.headSha === args.headSha
      ? ctx.manifest
      : { ...ctx.manifest, headSha: args.headSha };
    return findReport(ctx.artifactDir, {
      reportId: args.reportId,
      headSha: args.headSha,
      manifestHash: computeManifestHash(manifestForHash),
    });
  }
  return findReport(ctx.artifactDir, { reportId: args.reportId, headSha: args.headSha });
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

export function dispatch(name, args) {
  const ctx = buildContext();
  switch (name) {
    case 'test_status': return opStatus(args, ctx);
    case 'test_failures': return opFailures(args, ctx);
    case 'test_failure_detail': return opFailureDetail(args, ctx);
    case 'test_log_excerpt': return opLogExcerpt(args, ctx);
    case 'test_finding_map': return opFindingMap(args, ctx);
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
        return { jsonrpc: '2.0', id, result: textResult(dispatch(name, args ?? {})) };
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

