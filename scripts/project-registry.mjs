#!/usr/bin/env node
// project-registry.mjs — Shared Agent Platform: Project Registry + versioned manifest (Issue #14).
// Fail-closed: validator trả {ok:false, errors} khi vi phạm; không throw ngoài test cố ý.
// Registry machine-local NGOÀI worktree (không commit vào Git). Không chạm Claude Mem hooks/retrieval.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_SCHEMA_VERSION = '1.0';
export const MIN_SCHEMA_VERSION = '1.0';

// Machine-local registry path (NGOÀI worktree, ngoài Git).
export const DEFAULT_REGISTRY_DIR = path.join(os.homedir(), '.ai-pr-reviewer');
export const DEFAULT_REGISTRY_PATH = path.join(DEFAULT_REGISTRY_DIR, 'registry.json');
export const SCHEMA_URL = new URL('./project-manifest-schema.json', import.meta.url);
export const SCHEMA_PATH = fileURLToPath(SCHEMA_URL);

// Ownership matrix: mỗi capability có ĐÚNG MỘT canonical owner.
export const OWNERSHIP_MATRIX = [
  { capability: 'telegram-transport', owner: 'platform', ownerRef: 'shared-telegram-gateway' },
  { capability: 'telegram-routing', owner: 'platform', ownerRef: 'shared-telegram-gateway' },
  { capability: 'github-intake', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'review-policy', owner: 'control-plane', ownerRef: 'AI_PR_REVIEWER' },
  { capability: 'label-state-machine', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'approval-merge-preflight', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'context-routing', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'project-manifest', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'product-code', owner: 'project', ownerRef: 'project-repo' },
  { capability: 'deploy-adapter', owner: 'project', ownerRef: 'project-repo' },
  { capability: 'verify-adapter', owner: 'project', ownerRef: 'project-repo' },
  { capability: 'claude-mem-namespace', owner: 'project', ownerRef: 'claude-mem' },
];

// Project overrides bị giới hạn bằng allowlist.
export const ALLOWED_OVERRIDES = ['policy', 'verifyAdapter', 'telegramRoute', 'deploy.humanAuthorization'];
export function isAllowedOverride(key) { return ALLOWED_OVERRIDES.includes(key); }

// Secret patterns (fail-closed: phát hiện -> reject).
const SECRET_PATTERNS = [
  /(api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9]{8,}/i,
  /AKIA[0-9A-Z]{16}/,
  /(password|secret|token|private[_-]?key)\s*[:=]\s*['"][^'"]{6,}/i,
  /-----BEGIN (RSA |EC |)PRIVATE KEY-----/,
  /(mongodb|postgres|mysql|redis):\/\/[^\s:]+:[^\s@]+@/i,
];
// Absolute machine path patterns (fail-closed: không commit path máy).
const SECRET_KEY_RE = /(token|secret|password|apikey|privatekey)/i;

const ABSOLUTE_PATH_PATTERNS = [/^[A-Za-z]:[\\/]/, /^\/(?:home|Users|root|mnt|var|etc|tmp)\b/, /^~[\\/]/];

function scanStrings(value, patterns) {
  const hits = [];
  const walk = (v) => {
    if (typeof v === 'string') { for (const p of patterns) if (p.test(v)) hits.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return hits;
}
export function scanForSecrets(value) {
  const hits = [];
  const walk = (v, key) => {
    if (typeof key === 'string' && SECRET_KEY_RE.test(key)) hits.push(`secret-key:${key}`);
    if (typeof v === 'string') { for (const p of SECRET_PATTERNS) if (p.test(v)) hits.push(v); }
    else if (Array.isArray(v)) v.forEach((it) => walk(it));
    else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) walk(val, k);
  };
  walk(value);
  return hits;
}
export function scanForAbsolutePaths(value) { return scanStrings(value, ABSOLUTE_PATH_PATTERNS); }

export function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// Fail-closed validation. Thiếu repo identity -> reject. Secret/absolute path -> reject. Stale schema -> cần migrate.
export function validateManifest(manifest, opts = {}) {
  const errors = [];
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const minV = opts.minSchemaVersion || MIN_SCHEMA_VERSION;
  if (!/^\d+\.\d+$/.test(String(m.schemaVersion || ''))) errors.push('SCHEMA_VERSION_INVALID');
  if (!m.projectId || typeof m.projectId !== 'string') errors.push('MISSING_PROJECT_ID');
  if (!m.repository || typeof m.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(m.repository))
    errors.push('MISSING_REPO_IDENTITY');
  if (!m.workspace || typeof m.workspace !== 'object' || !m.workspace.workspaceId) errors.push('MISSING_WORKSPACE_ID');
  if (!m.projectType) errors.push('MISSING_PROJECT_TYPE');
  if (!m.policy || !m.policy.version) errors.push('MISSING_POLICY_PIN');
  if (!m.verify || !m.verify.adapter) errors.push('MISSING_VERIFY_ADAPTER');
  if (!m.deploy || typeof m.deploy.humanAuthorization !== 'boolean') errors.push('MISSING_DEPLOY_AUTHZ');
  if (!m.telegram || !m.telegram.route) errors.push('MISSING_TELEGRAM_ROUTE');
  if (!m.memory || !m.memory.provider || !m.memory.namespace) errors.push('MISSING_MEMORY_NAMESPACE');
  const secrets = scanForSecrets(m);
  if (secrets.length) errors.push('CONTAINS_SECRET:' + secrets.length);
  const abs = scanForAbsolutePaths(m);
  if (abs.length) errors.push('CONTAINS_ABSOLUTE_PATH:' + abs.length);
  if (m.schemaVersion && compareVersion(m.schemaVersion, minV) < 0) errors.push('STALE_SCHEMA:' + m.schemaVersion);
  if (m.schemaVersion && compareVersion(m.schemaVersion, SUPPORTED_SCHEMA_VERSION) > 0) errors.push('UNSUPPORTED_SCHEMA_VERSION:' + m.schemaVersion);
  if (Array.isArray(m.allowedOverrides))
    for (const k of m.allowedOverrides) if (!isAllowedOverride(k)) errors.push('OVERRIDE_NOT_ALLOWED:' + k);
  const schema = loadSchema();
  if (schema) errors.push(...validateAgainstSchema(m, schema));
  return { ok: errors.length === 0, errors, manifest: m };
}

function loadSchema() {
  try { return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')); } catch { return null; }
}

// Thực thi JSON Schema (subset được schema dùng): required, type, pattern, enum, minLength, nested required, array items enum.
function validateAgainstSchema(m, schema) {
  const errs = [];
  for (const k of (schema.required || [])) if (!(k in m)) errs.push('SCHEMA_MISSING_' + String(k).toUpperCase());
  const props = schema.properties || {};
  for (const [k, def] of Object.entries(props)) {
    if (!(k in m)) continue;
    const v = m[k];
    if (def.type === 'object') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) { errs.push('SCHEMA_TYPE_' + k.toUpperCase()); continue; }
      for (const rk of (def.required || [])) if (!(rk in v)) errs.push('SCHEMA_MISSING_' + k.toUpperCase() + '_' + String(rk).toUpperCase());
    }
    if (def.type === 'array' && Array.isArray(v) && def.items && def.items.enum) {
      for (const it of v) if (!def.items.enum.includes(it)) errs.push('SCHEMA_ENUM_' + k.toUpperCase() + '_ITEM');
    }
    if (typeof v === 'string') {
      if (def.pattern && !new RegExp(def.pattern).test(v)) errs.push('SCHEMA_PATTERN_' + k.toUpperCase());
      if (def.enum && !def.enum.includes(v)) errs.push('SCHEMA_ENUM_' + k.toUpperCase());
      if (def.minLength && v.length < def.minLength) errs.push('SCHEMA_MINLEN_' + k.toUpperCase());
    }
  }
  return errs;
}

export function loadRegistry({ registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  try {
    const obj = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!obj.projects) obj.projects = [];
    return obj;
  } catch (e) {
    if (e.code === 'ENOENT') return { schemaVersion: SUPPORTED_SCHEMA_VERSION, projects: [] };
    throw e;
  }
}

export function saveRegistry({ registry, registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

// Phát hiện projectId / repository / telegramRoute / workspaceId trùng.
export function detectConflicts({ registry, manifest }) {
  const conflicts = [];
  const projects = (registry && registry.projects) || [];
  for (const p of projects) {
    if (p.projectId && manifest.projectId && p.projectId === manifest.projectId) {
      // Cùng project (update/idempotent): chỉ conflict nếu repository (identity) khác -> collision.
      if (p.repository !== manifest.repository) conflicts.push({ type: 'projectId', value: manifest.projectId });
      continue;
    }
    if (p.repository && manifest.repository && p.repository === manifest.repository) conflicts.push({ type: 'repository', value: manifest.repository });
    if (p.telegram && manifest.telegram && p.telegram.route && manifest.telegram.route && p.telegram.route === manifest.telegram.route) conflicts.push({ type: 'telegramRoute', value: manifest.telegram.route });
    if (p.workspace && manifest.workspace && p.workspace.workspaceId && manifest.workspace.workspaceId && p.workspace.workspaceId === manifest.workspace.workspaceId) conflicts.push({ type: 'workspaceId', value: manifest.workspace.workspaceId });
  }
  return conflicts;
}

// Workspace remote phải khớp manifest trước mọi mutation.
export function assertWorkspaceRemote({ manifest, actualRemote, canonicalRemote }) {
  const expected = canonicalRemote || (manifest.repository ? 'https://github.com/' + manifest.repository + '.git' : null);
  if (!expected) return { ok: false, reason: 'NO_EXPECTED_REMOTE' };
  if (actualRemote !== expected) return { ok: false, reason: 'REMOTE_MISMATCH', actual: actualRemote, expected };
  return { ok: true };
}

export function registerProject({ manifest, registry, registryPath = DEFAULT_REGISTRY_PATH, actualRemote, canonicalRemote }) {
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, stage: 'validate', errors: v.errors };
  const conflicts = detectConflicts({ registry, manifest });
  if (conflicts.length) return { ok: false, stage: 'conflict', conflicts };
  const rc = assertWorkspaceRemote({ manifest, actualRemote, canonicalRemote });
  if (!rc.ok) return { ok: false, stage: 'remote', ...rc };
  registry.projects = registry.projects || [];
  const idx = registry.projects.findIndex((p) => p.projectId === manifest.projectId);
  if (idx >= 0) registry.projects[idx] = manifest; else registry.projects.push(manifest);
  saveRegistry({ registry, registryPath });
  return { ok: true, registry };
}

// Migration N->N+1 (up) và rollback (down).
export function migrateManifest({ manifest, toVersion = SUPPORTED_SCHEMA_VERSION }) {
  const m = JSON.parse(JSON.stringify(manifest || {}));
  const from = m.schemaVersion || '0.9';
  if (compareVersion(toVersion, from) > 0) {
    m.schemaVersion = toVersion;
    if (!m.workspace) m.workspace = { workspaceId: m.projectId || 'unknown' };
    if (!m.policy) m.policy = { version: 'current' };
    if (!m.verify) m.verify = { adapter: 'pnpm-verify' };
    if (!m.deploy) m.deploy = { capability: false, humanAuthorization: true };
    if (!m.telegram) m.telegram = { route: 'default' };
    if (!m.memory) m.memory = { provider: 'claude-mem', namespace: m.projectId || 'unknown' };
    if (!Array.isArray(m.allowedOverrides)) m.allowedOverrides = [];
    return { ok: true, direction: 'up', manifest: m };
  }
  if (compareVersion(toVersion, from) < 0) {
    // Rollback thực sự: giữ nguyên mọi trường dữ liệu, chỉ đổi marker schemaVersion.
    const down = { ...m, schemaVersion: toVersion };
    return { ok: true, direction: 'down', manifest: down };
  }
  return { ok: true, direction: 'none', manifest: m };
}

// Đảm bảo mỗi capability có đúng 1 canonical owner.
export function assertSingleOwner(matrix = OWNERSHIP_MATRIX) {
  const seen = new Map();
  for (const e of matrix) {
    if (seen.has(e.capability)) return { ok: false, duplicate: e.capability };
    seen.set(e.capability, e.owner);
  }
  return { ok: true, count: seen.size };
}

// Registry lưu ngoài worktree (không commit vào Git).
export function registryOutsideWorktree(registryPath = DEFAULT_REGISTRY_PATH, cwd = process.cwd()) {
  const abs = path.resolve(registryPath);
  const rel = path.relative(cwd, abs);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return { outside: !inside, path: abs };
}
