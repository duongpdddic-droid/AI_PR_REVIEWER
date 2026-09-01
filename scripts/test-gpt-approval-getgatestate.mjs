#!/usr/bin/env node
// test-gpt-approval-getgatestate.mjs — Test getGateState đọc MỘT artifact canonical có provenance
// (GPT-REV-133): khóa full HEAD + policyVersion + policyDigest + author allowlist.
// Cover: valid FINDINGS/PASS, sai author, stale HEAD, sai digest, thiếu artifact → fail-closed.
// Exit 0/1.

import { defaultIo } from './gpt-approval.mjs';

const SHA = 'c'.repeat(40);
const SHA2 = 'd'.repeat(40);
const POL = '2026-09-02.0';
const DIG = 'a'.repeat(64);
const REPO = 'o/r';
const PR = 7;

const results = [];
const eq = (name, got, want) => results.push({ name, ok: got === want, got, want });
const deepEq = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

const artifact = ({ headSha = SHA, verdict = 'PRE_REVIEW_FINDINGS', digest = DIG, author = 'user', failedGates = ['PRE_REVIEW_DIFF_LIMIT'], open = 1, dep = 0, policy = POL, version = 1 } = {}) => ({
  id: 'c1',
  user: { login: author },
  created_at: '2026-09-01T10:00:00Z',
  body: `<!-- ai-pr-reviewer:pre-review-artifact:${JSON.stringify({ version, repository: REPO, prNumber: PR, headSha, policyVersion: policy, policyDigest: digest, verdict, decisionGate: verdict === 'PRE_REVIEW_FINDINGS' ? 'diff-limit' : null, failedGates, openBlockingFindings: open, dependencyBlocks: dep })} -->`,
});

// Build io mock quanh getGateState thật (chỉ override getPrView + listPrComments).
function makeIo(comments, labels = []) {
  const io = defaultIo();
  io.getPrView = () => ({ state: 'open', headRefOid: SHA, labels: [...labels] });
  io.listPrComments = () => [...comments];
  return io;
}

const EXPECT = { policyVersion: POL, policyDigest: DIG, artifactAuthors: ['user', 'bot'] };

(function run() {
  // 1. Valid FINDINGS artifact → gate = FINDINGS, đúng 1 blocker diff-limit.
  {
    const io = makeIo([artifact()]);
    const g = io.getGateState(REPO, PR, SHA, EXPECT);
    eq('findings: verdict', g.preReviewVerdict, 'PRE_REVIEW_FINDINGS');
    eq('findings: openBlockingFindings', g.openBlockingFindings, 1);
    deepEq('findings: failedGates', g.failedGates, ['PRE_REVIEW_DIFF_LIMIT']);
    eq('findings: dep', g.dependencyBlocks, 0);
  }
  // 2. Valid PASS artifact → gate = PASS.
  {
    const io = makeIo([artifact({ verdict: 'PRE_REVIEW_PASS', failedGates: [], open: 0 })]);
    const g = io.getGateState(REPO, PR, SHA, EXPECT);
    eq('pass: verdict', g.preReviewVerdict, 'PRE_REVIEW_PASS');
    eq('pass: openBlockingFindings', g.openBlockingFindings, 0);
  }
  // 3. Sai author (không thuộc allowlist) → bỏ, không có canonical → fail-closed.
  {
    const io = makeIo([artifact({ author: 'attacker' })]);
    const g = io.getGateState(REPO, PR, SHA, EXPECT);
    eq('wrong-author: null verdict', g.preReviewVerdict, null);
  }
  // 4. Stale HEAD khác → bỏ → null verdict.
  {
    const io = makeIo([artifact({ headSha: SHA2 })]);
    const g = io.getGateState(REPO, PR, SHA, EXPECT);
    eq('stale-head: null verdict', g.preReviewVerdict, null);
  }
  // 5. Sai policyDigest → bỏ → null verdict.
  {
    const io = makeIo([artifact({ digest: 'f'.repeat(64) })]);
    const g = io.getGateState(REPO, PR, SHA, EXPECT);
    eq('wrong-digest: null verdict', g.preReviewVerdict, null);
  }
  // 6. Thiếu artifact → null verdict (fail-closed).
  {
    const io = makeIo([{ id: 'c1', user: { login: 'user' }, body: '<!-- ai-pr-reviewer:key=abc -->' }]);
    const g = io.getGateState(REPO, PR, SHA, EXPECT);
    eq('missing: null verdict', g.preReviewVerdict, null);
  }
  // 7. Artifact mới nhất đúng HEAD ghi đè artifact cũ cùng HEAD (duyệt tuần tự).
  {
    const io = makeIo([
      artifact({ open: 3, verdict: 'PRE_REVIEW_FINDINGS' }),
      artifact({ open: 1, verdict: 'PRE_REVIEW_FINDINGS' }),
    ]);
    const g = io.getGateState(REPO, PR, SHA, EXPECT);
    eq('last-wins: openBlockingFindings', g.openBlockingFindings, 1);
  }
  // 8. blocking status labels không được bỏ qua.
  {
    const io = makeIo([artifact()], ['status:blocked']);
    const g = io.getGateState(REPO, PR, SHA, EXPECT);
    deepEq('blocking labels', g.blockingStatusLabels, ['status:blocked']);
  }

  const pass = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== TEST REPORT: gpt-approval-getgatestate ===');
  for (const r of results) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.name + (r.ok ? '' : ' — got=' + JSON.stringify(r.got) + ' want=' + JSON.stringify(r.want)));
  }
  console.log('Total: ' + pass + '/' + results.length + ' PASS');
  if (failed.length) console.error('FAILED: ' + failed.map((r) => r.name).join(', '));
  process.exit(failed.length ? 1 : 0);
})();
