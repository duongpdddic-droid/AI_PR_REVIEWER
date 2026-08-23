#!/usr/bin/env node
// effective-policy.mjs — Resolver effective policy theo projectPolicyContract (Issue #5).
//
// Mô hình: AI_PR_REVIEWER global policy (canonical) + project-specific config
// (.github/project-review-policy.json của repo dự án) → effective policy.
// - Project override CHỈ được đặt các khóa nằm trong allowedProjectOverrides.
// - Mọi override chạm invariantLockedKeys → BLOCKED_INVARIANT_OVERRIDE.
// - Canonical không đọc được / sai shape → BLOCKED_CANONICAL_UNAVAILABLE / _INVALID.
// - pinnedVersion lệch canonical.policyVersion → BLOCKED_VERSION_MISMATCH.
// Fail-closed tuyệt đối: KHÔNG bao giờ rơi về "bản local cũ" khi resolution lỗi.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { POLICY_PATH, validatePolicy } from './review-contract.mjs';

export const CANONICAL_REPO = 'duongpdddic-droid/AI_PR_REVIEWER';
export const CANONICAL_PATH = POLICY_PATH;
export const PROJECT_CONFIG_FILE = '.github/project-review-policy.json';

// Lỗi chuẩn máy đọc được: code ∈ projectPolicyContract.failClosed + BLOCKED_PHASE_UNRESOLVED.
export class PolicyResolutionError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

function requireContract(canonicalPolicy) {
  const c = canonicalPolicy && canonicalPolicy.projectPolicyContract;
  if (!c || typeof c !== 'object'
    || !Array.isArray(c.allowedProjectOverrides) || !c.allowedProjectOverrides.length
    || !Array.isArray(c.invariantLockedKeys)) {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID', 'canonical thiếu projectPolicyContract hợp lệ');
  }
  return c;
}

/**
 * Pure: ghép canonical global policy với project config thành effective policy.
 * @returns {{policy: object, meta: {canonicalVersion, pinnedVersion|null, appliedOverrides: string[]}}}
 * @throws PolicyResolutionError với code fail-closed chuẩn.
 */
export function resolveEffectivePolicy(canonicalPolicy, projectConfig) {
  if (!canonicalPolicy || typeof canonicalPolicy !== 'object') {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_UNAVAILABLE', 'canonical policy không đọc được (null/undefined)');
  }
  const v = validatePolicy(canonicalPolicy);
  if (!v.ok) throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID', `canonical policy sai shape: ${v.error}`);
  const contract = requireContract(canonicalPolicy);

  // --- [GPT-REV-044] Enforce canonical identity from contract ---
  const canonIdentity = contract.canonicalRepo && contract.canonicalPath
    ? { repo: contract.canonicalRepo, path: contract.canonicalPath }
    : null;
  if (!canonIdentity) {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID', 'canonical policy thiếu projectPolicyContract.canonicalRepo/canonicalPath');
  }

  // Repo không khai báo project config (vd AI_PR_REVIEWER tự review) → effective = canonical.
  if (!projectConfig || typeof projectConfig !== 'object') {
    return { policy: canonicalPolicy, meta: { canonicalVersion: canonicalPolicy.policyVersion, pinnedVersion: null, appliedOverrides: [] } };
  }

  // Có project config → pin version là BẮT BUỘC (không cho phép "đang trôi").
  const src = projectConfig.policySource;
  if (!src || typeof src !== 'object' || !src.pinnedVersion) {
    throw new PolicyResolutionError('BLOCKED_VERSION_MISMATCH', 'project config thiếu policySource.pinnedVersion');
  }
  if (String(src.pinnedVersion) !== String(canonicalPolicy.policyVersion)) {
    throw new PolicyResolutionError('BLOCKED_VERSION_MISMATCH',
      `pin ${src.pinnedVersion} != canonical ${canonicalPolicy.policyVersion}`);
  }
  // [GPT-REV-044] Nếu project config cung cấp repo/path, PHẢI trùng khớp canonical identity.
  if (src.repo && src.repo !== canonIdentity.repo) {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID',
      `policySource.repo "${src.repo}" != canonical identity "${canonIdentity.repo}"`);
  }
  if (src.path && src.path !== canonIdentity.path) {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID',
      `policySource.path "${src.path}" != canonical identity "${canonIdentity.path}"`);
  }

  const overrides = projectConfig.projectOverrides || {};
  const allowed = new Set(contract.allowedProjectOverrides);
  for (const key of Object.keys(overrides)) {
    if (contract.invariantLockedKeys.includes(key)) {
      throw new PolicyResolutionError('BLOCKED_INVARIANT_OVERRIDE', `override chạm khóa bất biến "${key}"`);
    }
    if (!allowed.has(key)) {
      throw new PolicyResolutionError('BLOCKED_INVALID_OVERRIDE', `override "${key}" không thuộc allowedProjectOverrides`);
    }
  }
  // Precedence rõ ràng: canonical trước, project đè nguyên khối trên allowed keys.
  const merged = { ...canonicalPolicy, ...overrides };
  return {
    policy: merged,
    meta: {
      canonicalVersion: canonicalPolicy.policyVersion,
      pinnedVersion: String(src.pinnedVersion),
      appliedOverrides: Object.keys(overrides),
    },
  };
}

/** IO: đọc project review config từ root repo dự án. Không tồn tại → null (repo thuần canonical). */
export function loadProjectReviewConfig(projectRoot) {
  try {
    return JSON.parse(readFileSync(path.join(projectRoot, PROJECT_CONFIG_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * IO: đọc canonical policy từ nguồn cục bộ khả dụng, thứ tự cố định:
 * env AI_PR_POLICY_PATH → chính repo AIPR → sibling ../AI_PR_REVIEWER → ./_canonical/AI_PR_REVIEWER (CI checkout).
 * Trả {policy, path} hoặc {policy:null, error} — KHÔNG fallback về bản sao trong project.
 */
export function loadCanonicalPolicyLocal(projectRoot) {
  const candidates = [];
  if (process.env.AI_PR_POLICY_PATH) candidates.push(process.env.AI_PR_POLICY_PATH);
  const here = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.resolve(here, '..', '.github', CANONICAL_PATH)); // chính repo AIPR
  candidates.push(path.resolve(projectRoot, '..', 'AI_PR_REVIEWER', '.github', CANONICAL_PATH));
  candidates.push(path.resolve(projectRoot, '_canonical', 'AI_PR_REVIEWER', '.github', CANONICAL_PATH));
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.projectPolicyContract) return { policy: parsed, path: p };
    } catch { /* thử nguồn kế tiếp */ }
  }
  return { policy: null, error: 'BLOCKED_CANONICAL_UNAVAILABLE: không đọc được canonical từ bất kỳ nguồn cục bộ nào' };
}

/**
 * Pure: chọn nguồn canonical theo Issue #5 + [GPT-REV-042] + [GPT-REV-044].
 * - Repo canonical tự review → canonical nội bộ tại `ref` (head SHA của PR canonical).
 * - Project repo → BẮT BUỘC project config; canonical chỉ được tải từ đúng
 *   `policySource.repo + policySource.ref (full 40-hex SHA) + policySource.path`.
 *   KHÔNG BAO GIỜ đọc `.github/ai-review-policy.json` trên target repo
 *   (legacy mirror đã bỏ — stale mirror không được dùng làm nguồn policy).
 * - [GPT-REV-044] canonical identity (repo/path) được khóa bởi projectPolicyContract.
 *   project config KHÔNG được override canonical identity.
 * - Mọi lệch shape/ref/thiếu nguồn → PolicyResolutionError fail-closed.
 * @param {{repo: string, ref: string, fetchContent: (repo:string,path:string,ref:string)=>string}} p
 * @returns {{policy: object, meta?: object}} meta có mặt khi đi qua project config.
 */
export function resolvePolicyForRepo({ repo, ref, fetchContent }) {
  if (typeof fetchContent !== 'function') {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_UNAVAILABLE', 'thiếu fetchContent IO');
  }
  if (repo === CANONICAL_REPO) {
    let raw;
    try { raw = fetchContent(CANONICAL_REPO, CANONICAL_PATH, ref); }
    catch (e) { throw new PolicyResolutionError('BLOCKED_CANONICAL_UNAVAILABLE', `canonical nội bộ không đọc được tại ${ref}: ${String((e && e.message) || e).slice(0, 160)}`); }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID', `canonical nội bộ sai JSON: ${String((e && e.message) || e).slice(0, 160)}`); }
    const v = validatePolicy(parsed);
    if (!v.ok) throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID', `canonical nội bộ sai shape: ${v.error}`);
    // [GPT-REV-044] canonical tự review cũng phải có identity hợp lệ trong contract.
    const contract = requireContract(parsed);
    if (!contract.canonicalRepo || !contract.canonicalPath) {
      throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID', 'canonical policy thiếu projectPolicyContract.canonicalRepo/canonicalPath');
    }
    return { policy: parsed };
  }

  // Project repo: đọc project config trên target repo tại ref.
  let projectConfig;
  try {
    projectConfig = JSON.parse(fetchContent(repo, PROJECT_CONFIG_FILE, ref));
  } catch {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_UNAVAILABLE',
      `${repo} thiếu/không đọc được ${PROJECT_CONFIG_FILE} tại ${ref} — project repo bắt buộc khai báo policySource pin canonical`);
  }
  const src = projectConfig && projectConfig.policySource;
  if (!src || typeof src !== 'object' || !src.ref) {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID', 'project config thiếu policySource.ref');
  }
  assertFullSha(src.ref);
  // [GPT-REV-044] canonical repo/path: dùng default từ hằng số (không lấy từ project config để không cho override).
  const cRepo = CANONICAL_REPO;
  const cPath = CANONICAL_PATH;
  let canonical;
  try { canonical = JSON.parse(fetchContent(cRepo, cPath, src.ref)); }
  catch (e) { throw new PolicyResolutionError('BLOCKED_CANONICAL_UNAVAILABLE',
    `canonical không đọc được từ ${cRepo}@${src.ref}:${cPath} — ${String((e && e.message) || e).slice(0, 120)}`); }
  return resolveEffectivePolicy(canonical, projectConfig);
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** Ref di động (main/branch/tag ngắn) bị từ chối — pin phải là full commit SHA. */
export function assertFullSha(ref) {
  if (!FULL_SHA_RE.test(String(ref || ''))) {
    throw new PolicyResolutionError('BLOCKED_CANONICAL_INVALID',
      `policySource.ref phải là full 40-hex commit SHA, nhận: "${ref}"`);
  }
}

/**
 * IO: fetch canonical từ raw.githubusercontent (repo public). Trả {policy}|{policy:null,error}.
 * ref BẮT BUỘC full 40-hex SHA — mặc định 'main' đã bỏ ([GPT-REV-042]).
 */
export async function fetchCanonicalPolicyRaw({ repo = CANONICAL_REPO, ref } = {}) {
  if (!FULL_SHA_RE.test(String(ref || ''))) {
    return { policy: null, error: `BLOCKED_CANONICAL_INVALID: ref phải là full 40-hex SHA, nhận: "${ref}"` };
  }
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${CANONICAL_PATH}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { policy: null, error: `BLOCKED_CANONICAL_UNAVAILABLE: HTTP ${res.status} từ ${url}` };
    const parsed = JSON.parse(await res.text());
    if (!parsed || typeof parsed !== 'object') return { policy: null, error: 'BLOCKED_CANONICAL_UNAVAILABLE: nội dung không phải object' };
    return { policy: parsed, path: url };
  } catch (e) {
    return { policy: null, error: `BLOCKED_CANONICAL_UNAVAILABLE: ${(e && e.message) || e}` };
  }
}

