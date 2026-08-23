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
 * IO: fetch canonical từ raw.githubusercontent (repo public). Trả {policy}|{policy:null,error}.
 */
export async function fetchCanonicalPolicyRaw({ repo = CANONICAL_REPO, ref = 'main' } = {}) {
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

