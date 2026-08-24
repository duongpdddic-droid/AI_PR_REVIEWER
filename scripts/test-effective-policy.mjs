#!/usr/bin/env node
// test-effective-policy.mjs — Kiểm chứng resolver effective policy + chống drift (Issue #5,
// [GPT-REV-040]): canonical unavailable/version mismatch/invalid override/invariant override
// và merge precedence "AI_PR_REVIEWER global policy + QLDA project config". Exit 0/1.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_PATH, CANONICAL_REPO, PROJECT_CONFIG_FILE,
  PolicyResolutionError, assertFullSha, loadProjectReviewConfig, resolveEffectivePolicy, resolvePolicyForRepo,
} from './effective-policy.mjs';
import { POLICY_PATH, scanDuplicateObjectKeys } from './review-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

// Canonical THẬT trong repo này (không fixture giả lập shape).
const canonical = JSON.parse(readFileSync(path.join(ROOT, '.github', 'ai-review-policy.json'), 'utf8'));
const projectConfigQldA = {
  configVersion: canonical.policyVersion,
  policySource: { repo: CANONICAL_REPO, ref: 'a'.repeat(40), path: '.github/ai-review-policy.json', pinnedVersion: canonical.policyVersion },
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

// --- [GPT-REV-049] Project override approvalAuthorities → BLOCKED_INVARIANT_OVERRIDE (allowlist không được ghi đè) ---
{
  const bad = JSON.parse(JSON.stringify(projectConfigQldA));
  bad.projectOverrides.approvalAuthorities = { gptApprovalCommentAuthors: ['evil'], localApprovalCommentAuthors: ['evil'] };
  assert.throws(() => resolveEffectivePolicy(canonical, bad), (e) => e.code === 'BLOCKED_INVARIANT_OVERRIDE');
  ok('project override approvalAuthorities → BLOCKED_INVARIANT_OVERRIDE (không ghi đè allowlist)');
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

// --- [GPT-REV-042] resolvePolicyForRepo: stale mirror không bao giờ được dùng ---
{
  const calls = [];
  const fetchContent = (repo, p, ref) => {
    calls.push({ repo, path: p, ref });
    if (p === POLICY_PATH && repo === 'duongpdddic-droid/QLDA_DTXD') {
      // stale mirror CŨ trên target repo — phải bị bỏ qua, không bao giờ đọc.
      return JSON.stringify({ ...canonical, policyVersion: '2000-01-01.0' });
    }
    if (p === PROJECT_CONFIG_FILE) return JSON.stringify(projectConfigQldA);
    if (repo === CANONICAL_REPO && p === CANONICAL_PATH) return JSON.stringify(canonical);
    throw new Error('404');
  };
  const { policy, meta } = resolvePolicyForRepo({ repo: 'duongpdddic-droid/QLDA_DTXD', ref: 'b'.repeat(40), fetchContent });
  assert.equal(policy.requiredChecks[0], 'Verify code and data');
  // Không một request nào đọc POLICY_PATH trên target repo (mirror stale).
  assert.ok(!calls.some((c) => c.repo === 'duongpdddic-droid/QLDA_DTXD' && c.path === POLICY_PATH),
    'stale mirror trên target repo không được đọc');
  // Canonical chỉ được tải từ đúng pinned full SHA.
  const canonCalls = calls.filter((c) => c.path === CANONICAL_PATH);
  assert.equal(canonCalls.length, 1);
  assert.equal(canonCalls[0].ref, projectConfigQldA.policySource.ref);
  assert.ok(meta.pinnedVersion === canonical.policyVersion);
  ok('project repo: bỏ qua stale mirror, canonical chỉ từ policySource full SHA');
}

// --- [GPT-REV-042] ref di động (main/branch) bị từ chối ---
{
  for (const badRef of ['main', 'develop', 'v1', String('c'.repeat(39))]) {
    const cfg = JSON.parse(JSON.stringify(projectConfigQldA));
    cfg.policySource.ref = badRef;
    assert.throws(
      () => resolvePolicyForRepo({
        repo: 'duongpdddic-droid/QLDA_DTXD', ref: 'd'.repeat(40),
        fetchContent: (_r, p) => (p === PROJECT_CONFIG_FILE ? JSON.stringify(cfg) : JSON.stringify(canonical)),
      }),
      (e) => e instanceof PolicyResolutionError && e.code === 'BLOCKED_CANONICAL_INVALID',
      `ref "${badRef}" phải bị từ chối`,
    );
  }
  assert.throws(() => assertFullSha('main'), (e) => e.code === 'BLOCKED_CANONICAL_INVALID');
  ok('policySource.ref di động (main/branch/39-hex) → BLOCKED_CANONICAL_INVALID');
}

// --- [GPT-REV-042] thiếu project config / canonical lỗi nguồn → fail-closed ---
{
  assert.throws(
    () => resolvePolicyForRepo({
      repo: 'duongpdddic-droid/QLDA_DTXD', ref: 'e'.repeat(40),
      fetchContent: () => { throw new Error('404'); },
    }),
    (e) => e.code === 'BLOCKED_CANONICAL_UNAVAILABLE',
  );
  assert.throws(
    () => resolvePolicyForRepo({
      repo: 'duongpdddic-droid/QLDA_DTXD', ref: 'f'.repeat(40),
      fetchContent: (_r, p) => {
        if (p === PROJECT_CONFIG_FILE) return JSON.stringify(projectConfigQldA);
        throw new Error('canonical gone');
      },
    }),
    (e) => e.code === 'BLOCKED_CANONICAL_UNAVAILABLE',
  );
  ok('thiếu project config hoặc canonical lỗi nguồn → BLOCKED_CANONICAL_UNAVAILABLE');
}

// --- [GPT-REV-042] canonical self-review dùng canonical nội bộ tại ref ---
{
  let saw;
  const out = resolvePolicyForRepo({
    repo: CANONICAL_REPO, ref: '1'.repeat(40),
    fetchContent: (r, p, rr) => { saw = { r, p, rr }; return JSON.stringify(canonical); },
  });
  assert.equal(out.policy.policyVersion, canonical.policyVersion);
  assert.deepEqual(saw, { r: CANONICAL_REPO, p: CANONICAL_PATH, rr: '1'.repeat(40) });
  ok('AI_PR_REVIEWER tự review → canonical nội bộ tại head ref');
}

// --- [GPT-REV-044] Canonical identity enforcement ---
{
  // Project config cung cấp repo khác → BLOCKED
  const cfg = JSON.parse(JSON.stringify(projectConfigQldA));
  cfg.policySource.repo = 'evil/attacker-policy';
  assert.throws(() => resolveEffectivePolicy(canonical, cfg), (e) =>
    e instanceof PolicyResolutionError && e.code === 'BLOCKED_CANONICAL_INVALID' && e.message.includes('policySource.repo'));
  ok('project config repo khác canonical identity → BLOCKED_CANONICAL_INVALID');
}
{
  // Project config cung cấp path khác → BLOCKED
  const cfg = JSON.parse(JSON.stringify(projectConfigQldA));
  cfg.policySource.path = '.github/fake-policy.json';
  assert.throws(() => resolveEffectivePolicy(canonical, cfg), (e) =>
    e instanceof PolicyResolutionError && e.code === 'BLOCKED_CANONICAL_INVALID' && e.message.includes('policySource.path'));
  ok('project config path khác canonical identity → BLOCKED_CANONICAL_INVALID');
}
{
  // Canonical contract thiếu canonicalRepo/canonicalPath → BLOCKED
  const broken = { ...canonical, projectPolicyContract: { ...canonical.projectPolicyContract } };
  delete broken.projectPolicyContract.canonicalRepo;
  delete broken.projectPolicyContract.canonicalPath;
  assert.throws(() => resolveEffectivePolicy(broken, projectConfigQldA), (e) =>
    e instanceof PolicyResolutionError && e.code === 'BLOCKED_CANONICAL_INVALID' && e.message.includes('canonicalRepo/canonicalPath'));
  ok('canonical contract thiếu canonicalRepo/canonicalPath → BLOCKED_CANONICAL_INVALID');
}
{
  // resolvePolicyForRepo: project config repo khác → BLOCKED (identity enforce ở resolveEffectivePolicy)
  const cfg = JSON.parse(JSON.stringify(projectConfigQldA));
  cfg.policySource.repo = 'evil/attacker-policy';
  assert.throws(
    () => resolvePolicyForRepo({
      repo: 'duongpdddic-droid/QLDA_DTXD', ref: 'g'.repeat(40),
      fetchContent: (r, p, rr) => {
        if (p === PROJECT_CONFIG_FILE) return JSON.stringify(cfg);
        return JSON.stringify(canonical);
      },
    }),
    (e) => e.code === 'BLOCKED_CANONICAL_INVALID' && e.message.includes('policySource.repo'),
  );
  ok('resolvePolicyForRepo: project config repo khác identity → BLOCKED_CANONICAL_INVALID');
}
{
  // resolvePolicyForRepo: canonical contract thiếu identity → BLOCKED (self-review)
  const brokenCanon = { ...canonical, projectPolicyContract: { ...canonical.projectPolicyContract } };
  delete brokenCanon.projectPolicyContract.canonicalRepo;
  delete brokenCanon.projectPolicyContract.canonicalPath;
  assert.throws(
    () => resolvePolicyForRepo({
      repo: CANONICAL_REPO, ref: 'h'.repeat(40),
      fetchContent: () => JSON.stringify(brokenCanon),
    }),
    (e) => e.code === 'BLOCKED_CANONICAL_INVALID' && e.message.includes('canonicalRepo/canonicalPath'),
  );
  ok('resolvePolicyForRepo self-review: canonical contract thiếu identity → BLOCKED_CANONICAL_INVALID');
}
{
  // Happy path: project config KHÔNG cung cấp repo/path (chỉ pin + ref + overrides) → PASS
  const cfg = JSON.parse(JSON.stringify(projectConfigQldA));
  delete cfg.policySource.repo;
  delete cfg.policySource.path;
  const { policy, meta } = resolveEffectivePolicy(canonical, cfg);
  assert.deepEqual(policy.requiredChecks, ['Verify code and data']);
  assert.equal(meta.pinnedVersion, canonical.policyVersion);
  ok('project config không có repo/path (chỉ pin+ref) → PASS, dùng default canonical');
}
{
  // Happy path: project config cung cấp repo/path TRÙNG khớp identity → PASS
  const cfg = JSON.parse(JSON.stringify(projectConfigQldA));
  cfg.policySource.repo = canonical.projectPolicyContract.canonicalRepo;
  cfg.policySource.path = canonical.projectPolicyContract.canonicalPath;
  const { policy: p2, meta: m2 } = resolveEffectivePolicy(canonical, cfg);
  assert.deepEqual(p2.requiredChecks, ['Verify code and data']);
  assert.equal(m2.pinnedVersion, canonical.policyVersion);
  ok('project config repo/path trùng khớp identity → PASS');
}

// --- [GPT-REV-045] Duplicate JSON keys trong canonical → BLOCKED_POLICY_DUPLICATE_KEYS ---
{
  const raw = readFileSync(path.join(ROOT, '.github', 'ai-review-policy.json'), 'utf8');
  // Canonical thật phải sạch duplicate keys (scan toàn văn).
  const dupScan = scanDuplicateObjectKeys(raw).duplicates.length;
  assert.equal(dupScan, 0);
  ok('canonical policy thật không có duplicate JSON keys');

  // Fixture duplicate key top-level → resolver fail-closed.
  const minified = JSON.stringify(JSON.parse(raw));
  const dupRaw = minified.replace('"finalReviewer":"agent:gpt"', '"finalReviewer":"agent:gpt","finalReviewer":"agent:gpt"');
  let threw = null;
  try {
    resolvePolicyForRepo({
      repo: CANONICAL_REPO,
      ref: 'b'.repeat(40),
      fetchContent: (_r, p) => (p === CANONICAL_PATH ? dupRaw : '{}'),
    });
  } catch (e) { threw = e; }
  assert.ok(threw instanceof PolicyResolutionError, 'phải ném PolicyResolutionError');
  assert.equal(threw.code, 'BLOCKED_POLICY_DUPLICATE_KEYS');
  ok('canonical duplicate JSON keys → BLOCKED_POLICY_DUPLICATE_KEYS fail-closed');

  // Canonical sạch → resolve bình thường qua cùng đường IO.
  const okRes = resolvePolicyForRepo({
    repo: CANONICAL_REPO,
    ref: 'b'.repeat(40),
    fetchContent: (_r, p) => (p === CANONICAL_PATH ? raw : '{}'),
  });
  assert.equal(okRes.policy.policyVersion, canonical.policyVersion);
  ok('canonical sạch → resolve bình thường');
}

console.log(`test-effective-policy: ${passed} asserts PASS`);
