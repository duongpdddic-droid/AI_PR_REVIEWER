#!/usr/bin/env node
// test-evidence-reporter.mjs — Test Evidence Protocol v1 (Issue #19 Phase 1).
// Compact reporter: PASS mặc định 1 dòng, FAIL chỉ failure codes + reportId.
// JSON PASS ≤4 KB. Chi tiết lưu artifact, đọc progressive disclosure.
// Schema validation, redaction, output limits. Không arbitrary shell.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPORT_SCHEMA_VERSION = '1.0';
const MAX_PASS_JSON_BYTES = 4096;
const MAX_LOG_EXCERPT_LINES = 50;

function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function computeEnvironmentFingerprint() {
  return sha256hex(`${process.version}|${process.platform}|${process.arch}`);
}

export function computeManifestHash(manifest) {
  const { environmentFingerprint: _, generatedAt: __, ...rest } = manifest;
  return sha256hex(JSON.stringify(rest));
}

export function computeReportId(headSha, manifestHash) {
  return sha256hex(`${headSha}:${manifestHash}`).slice(0, 16);
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
  return JSON.stringify(report, null, 2);
}

// ── Artifact storage ───────────────────────────────────────────────
export function saveReport(report, artifactDir) {
  const dir = path.resolve(artifactDir || path.join(process.cwd(), '.agent', 'test-evidence'));
  mkdirSync(dir, { recursive: true });
  const json = formatFullJson(report);
  if (Buffer.byteLength(json, 'utf8') > MAX_PASS_JSON_BYTES && report.passed) {
    throw new Error(`PASS report JSON exceeds ${MAX_PASS_JSON_BYTES} bytes`);
  }
  const filePath = path.join(dir, `${report.reportId}.json`);
  writeFileSync(filePath, json, 'utf8');
  return filePath;
}

// ── Schema validation (minimal, no deps) ───────────────────────────
export function validateReport(report) {
  const errors = [];
  for (const f of ['schemaVersion', 'headSha', 'passed', 'tests', 'duration', 'reportId', 'manifestHash']) {
    if (!(f in report)) errors.push(`missing: ${f}`);
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
  if (!/^[0-9a-f]{16}$/.test(report.reportId)) errors.push('reportId: invalid');
  if (!report.passed) {
    if (!Array.isArray(report.failureCodes) || !report.failureCodes.length) errors.push('failureCodes: required for FAIL');
    if (typeof report.blocking !== 'number' || report.blocking < 1) errors.push('blocking: >= 1 for FAIL');
  }
  return { valid: errors.length === 0, errors };
}

export function validateManifest(manifest) {
  const errors = [];
  for (const f of ['schemaVersion', 'projectId', 'repository', 'headSha', 'gates']) {
    if (!(f in manifest)) errors.push(`missing: ${f}`);
  }
  if (errors.length) return { valid: false, errors };
  if (manifest.schemaVersion !== '1.0') errors.push('schemaVersion: must be "1.0"');
  if (typeof manifest.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(manifest.repository)) errors.push('repository: invalid');
  if (!manifest.gates || typeof manifest.gates !== 'object') errors.push('gates: not object');
  else {
    for (const [gid, steps] of Object.entries(manifest.gates)) {
      if (!Array.isArray(steps)) { errors.push(`gates.${gid}: not array`); continue; }
      for (const [i, s] of steps.entries()) {
        if (!s.id || typeof s.id !== 'string') errors.push(`gates.${gid}[${i}]: missing id`);
        if (!s.command || typeof s.command !== 'string') errors.push(`gates.${gid}[${i}]: missing command`);
        if (s.command && !/^[a-z0-9._/-]+$/i.test(s.command)) errors.push(`gates.${gid}[${i}]: command not allowlisted`);
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

// ── Failure code generation ────────────────────────────────────────
export function failureCodeFromStep(stepId) {
  return `STEP_${stepId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FAIL`;
}

// ── Progressive disclosure ─────────────────────────────────────────
export function formatSummary(report) {
  if (report.passed) return formatCompactLine(report);
  const lines = [formatCompactLine(report)];
  for (const f of (report.failures || [])) {
    lines.push(`  [${f.code}] ${f.step}: ${f.detail.slice(0, 120)}`);
  }
  return lines.join('\n');
}

export function formatFailureDetail(report, failureIndex) {
  const f = (report.failures || [])[failureIndex];
  if (!f) return null;
  const lines = [`Code: ${f.code}`, `Step: ${f.step}`, `Detail: ${f.detail}`];
  if (f.logExcerpt) {
    const excerpt = f.logExcerpt.split('\n').slice(0, MAX_LOG_EXCERPT_LINES).join('\n');
    lines.push(`Log excerpt (${MAX_LOG_EXCERPT_LINES} lines max):`, excerpt);
  }
  return lines.join('\n');
}

export { MAX_PASS_JSON_BYTES, MAX_LOG_EXCERPT_LINES };
