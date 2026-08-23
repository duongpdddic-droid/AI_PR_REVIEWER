#!/usr/bin/env node
// test-effective-policy.mjs — Kiểm chứng resolver effective policy + chống drift (Issue #5,
// [GPT-REV-040]): canonical unavailable/version mismatch/invalid override/invariant override
// và merge precedence "AI_PR_REVIEWER global policy + QLDA project config". Exit 0/1.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_REPO, PROJECT_CONFIG_FILE,
  PolicyResolutionError, loadProjectReviewConfig, resolveEffectivePolicy,
} from './effective-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

// Canonical THẬT trong repo này (không fixture giả lập shape).
const canonical = JSON.parse(readFileSync(path.join(ROOT, '.github', 'ai-review-policy.json'), 'utf8'));
const projectConfigQldA = {
  configVersion: canonical.policyVersion,
  policySource: { repo: CANONICAL_REPO, ref: 'main', path: '.github/ai-review-policy.json', pinnedVersion: canonical.policyVersion },
  projectOverrides: {
    requiredChecks: ['Verify code and data'],
    additionalTestCommands: ['pnpm test:data'],
    protectedPaths: ['Backend/*.js'],
  },
};

// --- Happy path: global + project → effective ---
{
  const { policy, meta } = resolveEffectivePolicy(canonical, projectConfigQldA);
  assert.deepEqual(policy.requiredChecks, ['Verify code and data']); // project đè
  assert.equal(policy.finalReviewer, canonical.finalReviewer);       // global giữ nguyên
  assert.deepEqual(policy.reviewerPhases, canonical.reviewerPhases); // invariant nguyên vẹn
  assert.deepEqual(meta.appliedOverrides.sort(), ['additionalTestCommands', 'protectedPaths', 'requiredChecks']);
  assert.equal(meta.pinnedVersion, canonical.policyVersion);
  ok('effective = canonical global + allowed project overrides');
}

// --- Canonical không đọc được ---
{
  assert.throws(() => resolveEffectivePolicy(null, projectConfigQldA), (e) =>
    e instanceof PolicyResolutionError && e.code === 'BLOCKED_CANONICAL_UNAVAILABLE');
  ok('canonical null → BLOCKED_CANONICAL_UNAVAILABLE (không fallback bản local)');
}

// --- Canonical sai shape ---
{
  const broken = { ...canonical };
  delete broken.requiredChecks;
  assert.throws(() => resolveEffectivePolicy(broken, projectConfigQldA), (e) =>
    e.code === 'BLOCKED_CANONICAL_INVALID');
  const noContract = { ...canonical };
  delete noContract.projectPolicyContract;
  assert.throws(() => resolveEffectivePolicy(noContract, projectConfigQldA), (e) =>
    e.code === 'BLOCKED_CANONICAL_INVALID');
  ok('canonical sai validatePolicy / thiếu projectPolicyContract → BLOCKED_CANONICAL_INVALID');
}

// --- Version mismatch ---
{
  const cfg = JSON.parse(JSON.stringify(projectConfigQldA));
  cfg.policySource.pinnedVersion = '2099-01-01.1';
  assert.throws(() => resolveEffectivePolicy(canonical, cfg), (e) => e.code === 'BLOCKED_VERSION_MISMATCH');
  const noPin = { projectOverrides: {} };
  assert.throws(() => resolveEffectivePolicy(canonical, noPin), (e) => e.code === 'BLOCKED_VERSION_MISMATCH');
  ok('pinnedVersion lệch/thiếu pin → BLOCKED_VERSION_MISMATCH');
}

// --- Override không hợp lệ / chạm invariant ---
{
  const bad = JSON.parse(JSON.stringify(projectConfigQldA));
  bad.projectOverrides.maxReviewRounds = 99; // invariant locked
  assert.throws(() => resolveEffectivePolicy(canonical, bad), (e) => e.code === 'BLOCKED_INVARIANT_OVERRIDE');
  const bad2 = JSON.parse(JSON.stringify(projectConfigQldA));
  bad2.projectOverrides.tenKhoaLao = 1; // không thuộc whitelist
  assert.throws(() => resolveEffectivePolicy(canonical, bad2), (e) => e.code === 'BLOCKED_INVALID_OVERRIDE');
  ok('override invariant → BLOCKED_INVARIANT_OVERRIDE; khóa lạ → BLOCKED_INVALID_OVERRIDE');
}

// --- Repo không có project config → effective = canonical (backward-safe) ---
{
  const { policy, meta } = resolveEffectivePolicy(canonical, null);
  assert.deepEqual(policy, canonical);
  assert.equal(meta.appliedOverrides.length, 0);
  ok('không có project config → effective = canonical thuần');
}

// --- Drift detection: canonical không còn hợp đồng "mỗi repo giữ bản sao" ---
{
  assert.ok(canonical.projectPolicyContract, 'canonical phải khai báo projectPolicyContract');
  assert.ok(!/giu ban sao giong nhau/i.test(canonical.scope.note), 'scope.note phải bỏ mô hình mirror');
  assert.ok(Array.isArray(canonical.projectPolicyContract.allowedProjectOverrides));
  const proto = readFileSync(path.join(ROOT, 'docs', 'AGENT_HANDOFF_PROTOCOL.md'), 'utf8');
  assert.ok(!/Moi repo giu ban sao/i.test(proto), 'protocol không được mô tả lại mô hình mirror');
  ok('canonical + protocol đã loại mô hình mirror (chống protocol drift)');
}

console.log(`test-effective-policy: ${passed} asserts PASS`);
