#!/usr/bin/env node
// test-evidence-reporter.mjs — Test Evidence Protocol v1 (Issue #19 Phase 1).
// Compact reporter: PASS mặc định 1 dòng, FAIL chỉ failure codes + reportId.
// JSON PASS ≤4 KB. Chi tiết lưu artifact, đọc progressive disclosure.
// Schema validation, redaction, output limits. Không arbitrary shell.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPORT_SCHEMA_VERSION = '1.0';
const MAX_PASS_JSON_BYTES = 4096;
const MAX_LOG_EXCERPT_LINES = 50;

// GPT-REV-106 (Finding 2): gateId là trường hợp lệ trong report — canonical binding
// reportId đã bind gateId, nên report phải mang gateId để read tools verify identity
// (hai gate cùng head+manifest có reportId khác nhau, không ghi đè).
const REPORT_FIELDS = new Set([
  'schemaVersion', 'headSha', 'passed', 'tests', 'duration', 'reportId',
  'manifestHash', 'blocking', 'failureCodes', 'failures', 'environmentFingerprint', 'artifacts', 'gateId',
]);
const MANIFEST_FIELDS = new Set([
  'schemaVersion', 'projectId', 'repository', 'headSha', 'gates', 'environmentFingerprint', 'generatedAt',
]);
const FAILURE_FIELDS = new Set(['code', 'step', 'detail', 'logExcerpt']);

function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// ── Manifest loading ───────────────────────────────────────────────
export function loadManifest(manifestPath, cwd) {
  const p = path.resolve(cwd || process.cwd(), manifestPath || '.agent/test-manifest.json');
  const raw = readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

// ── Path traversal guard ───────────────────────────────────────────
export function safePath(reportId, dir) {
  if (!/^[0-9a-f]{16}$/.test(reportId)) return { ok: false, reason: 'reportId: invalid hex 16' };
  const resolved = path.resolve(dir, `${reportId}.json`);
  const root = path.resolve(dir);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return { ok: false, reason: `path traversal: resolved ${resolved} escapes ${root}` };
  }
  return { ok: true, filePath: resolved };
}

export function computeEnvironmentFingerprint() {
  return sha256hex(`${process.version}|${process.platform}|${process.arch}`);
}

export function computeManifestHash(manifest) {
  const { environmentFingerprint: _, generatedAt: __, ...rest } = manifest;
  return sha256hex(JSON.stringify(rest));
}

// GPT-REV-106 (Finding 2): 2 gate cùng HEAD + manifest phải có reportId KHÁC nhau.
// Canonical binding: reportId = sha256(headSha|manifestHash|gateId)[:16]. Phase 2
// read-only dùng 2-arg (backward compat); Phase 3 runtime report (writeRuntimeReport)
// dùng 3-arg để gate-specific. Overload: nếu gateId falsy → giữ legacy 2-trường
// (Phase 2 artifact đã seed theo công thức cũ, không phá compat).
export function computeReportId(headSha, manifestHash, gateId) {
  const raw = gateId
    ? `${headSha}|${manifestHash}|${gateId}`
    : `${headSha}:${manifestHash}`;
  return sha256hex(raw).slice(0, 16);
}

// ── Compact formatting ─────────────────────────────────────────────
export function formatCompactLine(report) {
  if (report.passed) {
    const { headSha, tests, duration, reportId } = report;
    return `VERIFY PASS head=${headSha} tests=${tests.passed}/${tests.total} blocking=0 duration=${duration}ms report=${reportId}`;
  }
  const { headSha, blocking, failureCodes, reportId } = report;
  const codes = (failureCodes || []).join(',');
  return `VERIFY FAIL head=${headSha} blocking=${blocking} codes=${codes} report=${reportId}`;
}

export function formatFullJson(report) {
  return JSON.stringify(redactReport(report), null, 2);
}

// ── Artifact storage ───────────────────────────────────────────────
export function saveReport(report, artifactDir) {
  const v = validateReport(report);
  if (!v.valid) throw new Error(`saveReport: invalid report: ${v.errors.join('; ')}`);
  const dir = path.resolve(artifactDir || path.join(process.cwd(), '.agent', 'test-evidence'));
  mkdirSync(dir, { recursive: true });
  const safe = safePath(report.reportId, dir);
  if (!safe.ok) throw new Error(`saveReport: ${safe.reason}`);
  const redacted = redactReport(report);
  const json = formatFullJson(redacted);
  if (Buffer.byteLength(json, 'utf8') > MAX_PASS_JSON_BYTES && report.passed) {
    throw new Error(`PASS report JSON exceeds ${MAX_PASS_JSON_BYTES} bytes`);
  }
  writeFileSync(safe.filePath, json, 'utf8');
  return safe.filePath;
}

// ── Schema validation (strict — rejects extra properties) ──────────
export function validateReport(report) {
  const errors = [];
  const required = ['schemaVersion', 'headSha', 'passed', 'tests', 'duration', 'reportId', 'manifestHash'];
  for (const f of required) {
    if (!(f in report)) errors.push(`missing: ${f}`);
  }
  for (const key of Object.keys(report)) {
    if (!REPORT_FIELDS.has(key)) errors.push(`unexpected property: ${key}`);
  }
  if (errors.length) return { valid: false, errors };
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) errors.push(`schemaVersion: want "${REPORT_SCHEMA_VERSION}"`);
  if (typeof report.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(report.headSha)) errors.push('headSha: invalid');
  if (typeof report.passed !== 'boolean') errors.push('passed: not boolean');
  const t = report.tests;
  if (!t || typeof t !== 'object') errors.push('tests: not object');
  else {
    for (const k of ['passed', 'failed', 'total']) {
      if (!Number.isInteger(t[k]) || t[k] < 0) errors.push(`tests.${k}: invalid`);
    }
    if (t.passed + t.failed !== t.total) errors.push('tests: passed+failed != total');
  }
  if (!Number.isInteger(report.duration) || report.duration < 0) errors.push('duration: invalid');
  if (typeof report.reportId !== 'string' || !/^[0-9a-f]{16}$/.test(report.reportId)) errors.push('reportId: invalid');
  if (!report.passed) {
    if (!Array.isArray(report.failureCodes) || !report.failureCodes.length) errors.push('failureCodes: required for FAIL');
    if (typeof report.blocking !== 'number' || report.blocking < 1) errors.push('blocking: >= 1 for FAIL');
  }
  if (Array.isArray(report.failures)) {
    for (const [i, f] of report.failures.entries()) {
      if (!f.code || !/^[A-Z][A-Z0-9_-]*$/.test(f.code)) errors.push(`failures[${i}].code: invalid`);
      if (!f.step || typeof f.step !== 'string') errors.push(`failures[${i}].step: required`);
      if (typeof f.detail !== 'string') errors.push(`failures[${i}].detail: required string`);
      for (const fk of Object.keys(f)) {
        if (!FAILURE_FIELDS.has(fk)) errors.push(`failures[${i}]: unexpected property ${fk}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateManifest(manifest) {
  const errors = [];
  const required = ['schemaVersion', 'projectId', 'repository', 'headSha', 'gates'];
  for (const f of required) {
    if (!(f in manifest)) errors.push(`missing: ${f}`);
  }
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(key)) errors.push(`unexpected property: ${key}`);
  }
  if (errors.length) return { valid: false, errors };
  if (manifest.schemaVersion !== '1.0') errors.push('schemaVersion: must be "1.0"');
  if (typeof manifest.projectId !== 'string' || !manifest.projectId) errors.push('projectId: required');
  if (typeof manifest.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(manifest.repository)) errors.push('repository: invalid');
  if (typeof manifest.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.headSha)) errors.push('headSha: invalid (must be 40-hex)');
  if (!manifest.gates || typeof manifest.gates !== 'object') errors.push('gates: not object');
  else {
    for (const [gid, steps] of Object.entries(manifest.gates)) {
      if (!Array.isArray(steps)) { errors.push(`gates.${gid}: not array`); continue; }
      for (const [i, s] of steps.entries()) {
        if (!s.id || typeof s.id !== 'string') errors.push(`gates.${gid}[${i}]: missing id`);
        if (!s.name || typeof s.name !== 'string') errors.push(`gates.${gid}[${i}]: missing name`);
        if (!s.command || typeof s.command !== 'string') errors.push(`gates.${gid}[${i}]: missing command`);
        if (s.command && !/^[a-z0-9._/-]+$/i.test(s.command)) errors.push(`gates.${gid}[${i}]: command not allowlisted`);
        if (s.args !== undefined && !Array.isArray(s.args)) errors.push(`gates.${gid}[${i}]: args not array`);
        if (s.timeout !== undefined && (typeof s.timeout !== 'number' || s.timeout <= 0)) errors.push(`gates.${gid}[${i}]: timeout invalid`);
        if (s.blocking !== undefined && typeof s.blocking !== 'boolean') errors.push(`gates.${gid}[${i}]: blocking not boolean`);
        for (const sk of Object.keys(s)) {
          if (!['id', 'name', 'command', 'args', 'timeout', 'blocking'].includes(sk)) {
            errors.push(`gates.${gid}[${i}]: unexpected property ${sk}`);
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// ── Redaction ──────────────────────────────────────────────────────
const REDACT_PATTERNS = [
  [/(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}['"]?/gi, '[REDACTED_API_KEY]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS]'],
  [/(?:password|secret|token|authorization)\s*[:=]\s*['"][^'"]+['"]/gi, '[REDACTED_SECRET]'],
  [/-----BEGIN (?:RSA |EC |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |)PRIVATE KEY-----/g, '[REDACTED_KEY]'],
  [/(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]+/gi, '[REDACTED_CONN]'],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]'],
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  let r = text;
  for (const [pat, rep] of REDACT_PATTERNS) r = r.replace(pat, rep);
  return r;
}

/** Deep-redact failures[].detail + failures[].logExcerpt trước save/format. */
export function redactReport(report) {
  const r = { ...report };
  if (Array.isArray(r.failures)) {
    r.failures = r.failures.map((f) => ({
      ...f,
      detail: redact(f.detail),
      logExcerpt: f.logExcerpt ? redact(f.logExcerpt) : f.logExcerpt,
    }));
  }
  return r;
}

// ── Failure code generation ────────────────────────────────────────
export function failureCodeFromStep(stepId) {
  return `STEP_${stepId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FAIL`;
}

// ── Progressive disclosure (redacted) ─────────────────────────────
export function formatSummary(report) {
  if (report.passed) return formatCompactLine(report);
  const redacted = redactReport(report);
  const lines = [formatCompactLine(redacted)];
  for (const f of (redacted.failures || [])) {
    lines.push(`  [${f.code}] ${f.step}: ${f.detail.slice(0, 120)}`);
  }
  return lines.join('\n');
}

export function formatFailureDetail(report, failureIndex) {
  const redacted = redactReport(report);
  const f = (redacted.failures || [])[failureIndex];
  if (!f) return null;
  const lines = [`Code: ${f.code}`, `Step: ${f.step}`, `Detail: ${f.detail}`];
  if (f.logExcerpt) {
    const excerpt = f.logExcerpt.split('\n').slice(0, MAX_LOG_EXCERPT_LINES).join('\n');
    lines.push(`Log excerpt (${MAX_LOG_EXCERPT_LINES} lines max):`, excerpt);
  }
  return lines.join('\n');
}

export { MAX_PASS_JSON_BYTES, MAX_LOG_EXCERPT_LINES };
