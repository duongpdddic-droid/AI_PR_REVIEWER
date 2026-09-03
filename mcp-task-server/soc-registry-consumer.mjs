#!/usr/bin/env node
/**
 * soc-registry-consumer.mjs — Read-only consumer of canonical Soc_brain #17 Project Registry.
 *
 * Đọc `~/.soc-brain/registry/projects.json` theo canonical schema v1.0.0, fail-closed.
 * KHÔNG writer/migration/project-creation — consumer-only.
 *
 * ponytail: Khi @soc/project-registry artifact (Soc_brain #17) ship, swap import sang artifact.
 * Module này là interim consumer, không duplicate writer/migration/creation.
 */
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, resolve } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Canonical registry path (SOC_PROJECT_REGISTRY_PATH override là control-plane bootstrap boundary).
export const DEFAULT_SOC_REGISTRY_PATH = join(os.homedir(), '.soc-brain', 'registry', 'projects.json');

// Legacy registry path (AI_PR_REVIEWER cũ — split-brain detection).
export const LEGACY_REGISTRY_PATH = join(os.homedir(), '.ai-pr-reviewer', 'registry.json');

// Schema version supported.
export const SUPPORTED_REGISTRY_SCHEMA = '1.0.0';

// Repository regex: owner/repo
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Trả canonical registry path: env SOC_PROJECT_REGISTRY_PATH (nếu hợp lệ) hoặc default.
 * Validate fail-closed: path absolute, ngoài worktree, không symlink/junction escape.
 */
export function resolveCanonicalRegistryPath({ override = null, cwd = process.cwd() } = {}) {
  const raw = override ?? process.env.SOC_PROJECT_REGISTRY_PATH ?? '';
  if (!raw) return DEFAULT_SOC_REGISTRY_PATH;
  if (typeof raw !== 'string' || !isAbsolute(raw)) {
    throw new Error('SOC_PROJECT_REGISTRY_PATH không hợp lệ: phải là absolute path');
  }
  const abs = resolve(raw);
  const rel = relative(cwd, abs);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('SOC_PROJECT_REGISTRY_PATH không được nằm trong worktree');
  }
  // Symlink/junction escape check
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      throw new Error('SOC_PROJECT_REGISTRY_PATH không được là symlink');
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      const parent = dirname(abs);
      try {
        const pstat = lstatSync(parent);
        if (pstat.isSymbolicLink()) {
          throw new Error('SOC_PROJECT_REGISTRY_PATH parent không được là symlink');
        }
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      }
    } else if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  return abs;
}

/**
 * Đọc và parse canonical registry.
 * ENOENT → REGISTRY_MISSING fail-closed (không fallback legacy).
 * JSON parse fail → REGISTRY_MALFORMED.
 * IO fail → REGISTRY_UNREADABLE.
 */
export function readCanonicalRegistry({ registryPath = DEFAULT_SOC_REGISTRY_PATH } = {}) {
  let raw;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, errors: ['REGISTRY_MISSING: canonical registry chưa được tạo; Soc_brain #17 hoặc AI_PR_REVIEWER #34 cần provision'] };
    }
    return { ok: false, errors: [`REGISTRY_UNREADABLE: ${err.message}`] };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`REGISTRY_MALFORMED: JSON parse fail — ${err.message}`] };
  }
  return { ok: true, data };
}

/**
 * Validate schema v1.0.0 của canonical Soc_brain registry.
 * Reject: unsupported schema version, missing/invalid fields, duplicate identity,
 * path-inside-worktree, symlink-escape, secret/credential data, digest mismatch.
 * Trả { ok, errors }.
 */
export function validateRegistrySchema(data, { cwd = process.cwd() } = {}) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['REGISTRY_MALFORMED: root phải là object'] };
  }
  if (data.$schemaVersion !== SUPPORTED_REGISTRY_SCHEMA) {
    errors.push(`REGISTRY_UNSUPPORTED_SCHEMA: hỗ trợ ${SUPPORTED_REGISTRY_SCHEMA}, nhận '${data.$schemaVersion ?? '(missing)'}'`);
  }
  if (typeof data.revision !== 'number' || !Number.isInteger(data.revision) || data.revision < 0) {
    errors.push('REGISTRY_REVISION_INVALID: revision phải là non-negative integer');
  }
  if (typeof data.updatedAt !== 'string' || !data.updatedAt) {
    errors.push('REGISTRY_MISSING_UPDATED_AT: updatedAt là bắt buộc');
  }
  if (typeof data.contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(data.contentDigest)) {
    errors.push('REGISTRY_DIGEST_MISSING_OR_INVALID: contentDigest phải là lowercase hex SHA-256 64 ký tự');
  }
  if (!data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) {
    errors.push('REGISTRY_MALFORMED: projects phải là object keyed by projectId');
    return { ok: false, errors };
  }
  const seenProjectIds = new Set();
  const seenRepositories = new Set();
  const seenWorkspaceIds = new Set();
  for (const [pid, p] of Object.entries(data.projects)) {
    if (typeof p !== 'object' || p === null) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' không phải object`);
      continue;
    }
    if (typeof p.projectId !== 'string' || !p.projectId) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' thiếu hoặc sai projectId`);
    } else if (seenProjectIds.has(p.projectId)) {
      errors.push(`REGISTRY_DUPLICATE_IDENTITY: duplicate projectId '${p.projectId}'`);
    } else {
      seenProjectIds.add(p.projectId);
    }
    if (typeof p.canonicalRepository !== 'string' || !REPO_RE.test(p.canonicalRepository)) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' canonicalRepository phải là owner/repo`);
    } else if (seenRepositories.has(p.canonicalRepository)) {
      errors.push(`REGISTRY_DUPLICATE_IDENTITY: duplicate repository '${p.canonicalRepository}'`);
    } else {
      seenRepositories.add(p.canonicalRepository);
    }
    if (typeof p.canonicalRoot !== 'string' || p.canonicalRoot.length < 3) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' thiếu hoặc sai canonicalRoot`);
    } else {
      try {
        const rootStat = lstatSync(p.canonicalRoot);
        if (rootStat.isSymbolicLink()) {
          errors.push(`REGISTRY_PATH_ESCAPE: canonicalRoot '${p.canonicalRoot}' không được là symlink`);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') errors.push(`REGISTRY_PATH_UNREADABLE: canonicalRoot '${p.canonicalRoot}' — ${e.message}`);
      }
      const rel = relative(cwd, p.canonicalRoot);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        errors.push(`REGISTRY_PATH_INSIDE_WORKTREE: canonicalRoot '${p.canonicalRoot}' nằm trong worktree`);
      }
    }
    if (typeof p.status !== 'string' || !p.status) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' thiếu status`);
    }
    if (typeof p.registeredAt !== 'string' || !p.registeredAt) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' thiếu registeredAt`);
    }
    if (p.capabilities !== undefined && (!Array.isArray(p.capabilities) || p.capabilities.some((c) => typeof c !== 'string' || !c))) {
      errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' capabilities phải là mảng string không rỗng`);
    }
    if (p.worktreeRoots !== undefined) {
      if (!Array.isArray(p.worktreeRoots) || p.worktreeRoots.some((w) => typeof w !== 'string' || !w)) {
        errors.push(`REGISTRY_PROJECT_INVALID: project '${pid}' worktreeRoots phải là mảng string`);
      }
    }
    if (p.workspaceId && typeof p.workspaceId === 'string') {
      if (seenWorkspaceIds.has(p.workspaceId)) {
        errors.push(`REGISTRY_DUPLICATE_IDENTITY: duplicate workspaceId '${p.workspaceId}'`);
      } else {
        seenWorkspaceIds.add(p.workspaceId);
      }
    }
    if (p.canonicalRepository && /(token|secret|password|apikey|privatekey)/i.test(p.canonicalRepository)) {
      errors.push(`REGISTRY_SECRET: canonicalRepository '${p.canonicalRepository}' chứa secret pattern`);
    }
  }
  if (data.contentDigest && /^[0-9a-f]{64}$/.test(data.contentDigest)) {
    const computed = computeRegistryDigest(data);
    if (computed !== data.contentDigest) {
      errors.push(`REGISTRY_DIGEST_MISMATCH: computed=${computed}, declared=${data.contentDigest}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Compute SHA-256 digest over canonical JSON serialization.
 * ponytail: khi @soc/project-registry artifact ship, swap sang RFC 8785 JCS đầy đủ.
 * Hiện tại dùng sorted-key serialization (như stableStringify) — đủ cho consumer detect
 * corruption/tamper; JCS chuẩn sẽ do writer (Soc_brain #17) định nghĩa.
 */
export function computeRegistryDigest(data) {
  const { contentDigest: _ignored, ...rest } = data;
  return crypto.createHash('sha256').update(canonicalStringify(rest)).digest('hex');
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

/**
 * Phát hiện split-brain: legacy registry active (có projects) + canonical chưa tồn tại/rỗng,
 * hoặc legacy active + canonical tồn tại nhưng chưa migrated (canonical rỗng/unreadable).
 * Trả { ok, splitBrain, errors }.
 */
export function detectSplitBrain({ registryPath = DEFAULT_SOC_REGISTRY_PATH, legacyPath = LEGACY_REGISTRY_PATH } = {}) {
  const canonicalExists = existsSync(registryPath);
  if (!existsSync(legacyPath)) return { ok: true, splitBrain: false };
  let legacyActive = false;
  try {
    const legacyData = JSON.parse(readFileSync(legacyPath, 'utf8'));
    legacyActive = Array.isArray(legacyData?.projects) && legacyData.projects.length > 0;
  } catch {
    legacyActive = false;
  }
  if (!legacyActive) return { ok: true, splitBrain: false };
  if (!canonicalExists) {
    return { ok: false, splitBrain: true, errors: ['REGISTRY_SPLIT_BRAIN: legacy active (AI_PR_REVIEWER) nhưng canonical Soc_brain chưa tồn tại; cần migrate trước'] };
  }
  try {
    const canonicalData = JSON.parse(readFileSync(registryPath, 'utf8'));
    const canonCount = typeof canonicalData?.projects === 'object' && !Array.isArray(canonicalData.projects)
      ? Object.keys(canonicalData.projects).length : 0;
    if (canonCount === 0) {
      return { ok: false, splitBrain: true, errors: ['REGISTRY_SPLIT_BRAIN: canonical registry rỗng nhưng legacy active'] };
    }
  } catch {
    return { ok: false, splitBrain: true, errors: ['REGISTRY_SPLIT_BRAIN: canonical registry unreadable nhưng legacy active'] };
  }
  return { ok: true, splitBrain: false };
}

/**
 * Đọc canonical registry → validate → extract canonicalRepository từ projects object.
 * Fail-closed: missing/malformed/unreadable/unsupported/split-brain/empty → ok:false.
 * Trả { ok, repos, errors }.
 */
export function loadRegistryRepos({ registryPath = DEFAULT_SOC_REGISTRY_PATH, cwd = process.cwd(), legacyPath = LEGACY_REGISTRY_PATH } = {}) {
  const sb = detectSplitBrain({ registryPath, legacyPath });
  if (!sb.ok) return { ok: false, repos: [], errors: sb.errors };
  const read = readCanonicalRegistry({ registryPath });
  if (!read.ok) return { ok: false, repos: [], errors: read.errors };
  const valid = validateRegistrySchema(read.data, { cwd });
  if (!valid.ok) return { ok: false, repos: [], errors: valid.errors };
  const repos = [];
  for (const [pid, p] of Object.entries(read.data.projects)) {
    if (p && typeof p.canonicalRepository === 'string' && REPO_RE.test(p.canonicalRepository) && !repos.includes(p.canonicalRepository)) {
      repos.push(p.canonicalRepository);
    }
  }
  if (repos.length === 0) {
    return { ok: false, repos: [], errors: ['REGISTRY_EMPTY: không có project nào có canonicalRepository hợp lệ'] };
  }
  return { ok: true, repos, errors: [] };
}
