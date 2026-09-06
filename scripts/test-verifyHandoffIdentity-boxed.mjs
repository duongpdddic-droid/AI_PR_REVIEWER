// test-verifyHandoffIdentity-boxed.mjs — Focused deterministic test for the boxed-Number
// identity comparison defect in verifyHandoffIdentity (review-handoff-contract.mjs).
// Exit 0 = PASS, 1 = FAIL. ZERO IO — chỉ import pure module.
import assert from 'node:assert/strict';
import { verifyHandoffIdentity } from './review-handoff-contract.mjs';

const REPO = 'owner/repo';
const ISSUE = 75;
const PR = 76;
const HEAD = 'bbe60817b5f5988bfaa62305cab5d752299c467a';

const baseReport = () => ({
  identity: { repository: REPO, issue: ISSUE, pullRequest: PR, headSha: HEAD },
});

const ctx = { repo: REPO, number: ISSUE, pr: PR, prHeadSha: HEAD };

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

console.log('verifyHandoffIdentity — identity-boundary canonicalization');

// 1. primitive vs primitive equal → PASS (baseline)
test('primitive vs primitive equal → ok=true, no errors', () => {
  const v = verifyHandoffIdentity(baseReport(), ctx);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

// 2. boxed numeric vs primitive equivalent → PASS (regression: AI_PR_REVIEWER task_handoff bug)
test('new Number(issue) vs primitive number ctx.issue → ok=true, no errors', () => {
  const rep = {
    identity: {
      repository: REPO,
      issue: new Number(ISSUE),
      pullRequest: new Number(PR),
      headSha: HEAD,
    },
  };
  const v = verifyHandoffIdentity(rep, ctx);
  assert.equal(v.ok, true, `expected ok=true, got errors=${JSON.stringify(v.errors)}`);
  assert.deepEqual(v.errors, []);
});

test('string-typed issue/PR in report (decimal digit) vs number ctx → ok=true', () => {
  const rep = {
    identity: {
      repository: REPO,
      issue: String(ISSUE),
      pullRequest: String(PR),
      headSha: HEAD,
    },
  };
  const v = verifyHandoffIdentity(rep, ctx);
  assert.equal(v.ok, true, `expected ok=true, got errors=${JSON.stringify(v.errors)}`);
  assert.deepEqual(v.errors, []);
});

// 3. different issue → FAIL
test('issue 99 vs ctx.number 75 → IDENTITY_ISSUE_MISMATCH', () => {
  const rep = {
    identity: { repository: REPO, issue: 99, pullRequest: PR, headSha: HEAD },
  };
  const v = verifyHandoffIdentity(rep, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'IDENTITY_ISSUE_MISMATCH'),
    `expected IDENTITY_ISSUE_MISMATCH in ${JSON.stringify(v.errors)}`);
});

// 4. different PR → FAIL
test('PR 999 vs ctx.pr 76 → IDENTITY_PR_MISMATCH', () => {
  const rep = {
    identity: { repository: REPO, issue: ISSUE, pullRequest: 999, headSha: HEAD },
  };
  const v = verifyHandoffIdentity(rep, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'IDENTITY_PR_MISMATCH'),
    `expected IDENTITY_PR_MISMATCH in ${JSON.stringify(v.errors)}`);
});

// 5. different repository → FAIL
test('repository owner/other vs ctx.repo owner/repo → IDENTITY_REPOSITORY_MISMATCH', () => {
  const rep = {
    identity: { repository: 'owner/other', issue: ISSUE, pullRequest: PR, headSha: HEAD },
  };
  const v = verifyHandoffIdentity(rep, ctx);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'IDENTITY_REPOSITORY_MISMATCH'),
    `expected IDENTITY_REPOSITORY_MISMATCH in ${JSON.stringify(v.errors)}`);
});

console.log(`\n${passed}/6 identity-boundary tests passed`);
