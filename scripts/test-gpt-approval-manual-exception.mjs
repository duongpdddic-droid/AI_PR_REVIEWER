#!/usr/bin/env node
// test-gpt-approval-manual-exception.mjs â€” Test performManualApproval vá»›i mock io.
// Cover: 1 happy + 1 idempotency + 13+ fail-closed (Issue #36 + GPT amendment).
// Exit 0/1.

import { performManualApproval } from './gpt-approval.mjs';
import { LABELS, computePolicyDigest } from './review-contract.mjs';

const SHA = 'c'.repeat(40);
const SHA2 = 'd'.repeat(40);
const POLICY = {
  policyVersion: '2026-08-23.7',
  requiredChecks: ['verify'],
  blockingSeverities: ['critical', 'important'],
  finalReviewer: 'agent:gpt',
  maxReviewRounds: 3,
  diffLimits: { maxLines: 1500 },
  approvalAuthorities: { gptApprovalCommentAuthors: ['user', 'gpt-account'], localApprovalCommentAuthors: ['user'] },
  manualException: { enabled: true, allowedReason: ['PRE_REVIEW_DIFF_LIMIT'] },
};
const POLICY_DIGEST = computePolicyDigest(POLICY);
const GPT_EVIDENCE = { url: 'https://github.com/o/r/issues/7#issuecomment-12345', commentId: '12345' };
const CI_RUN = { repository: 'o/r', headSha: SHA, conclusion: 'success', workflow: 'verify' };

const results = [];
const eq = (name, got, want) => results.push({ name, ok: got === want, got, want });
const tru = (name, got) => results.push({ name, ok: Boolean(got), got });

function makeManualIo(opts = {}) {
  const pr = {
    state: opts.state ?? 'open',
    headRefOid: opts.headSha ?? SHA,
    labels: [...(opts.labels ?? [LABELS.reviewRequested])],
    comments: [...(opts.comments ?? [])],
  };
  const s = { mutations: [] };
  const io = {
    getPrView() { return { state: pr.state, headRefOid: pr.headRefOid, labels: [...pr.labels] }; },
    getPolicy() {
      if (opts.policyFails) throw new Error('gh api policy FAIL');
      return JSON.parse(JSON.stringify(opts.customPolicy || POLICY));
    },
    getCiRun() {
      if (opts.ciRunFails) throw new Error('gh api ci FAIL');
      if (opts.ciRunNotFound) return null;
      const override = opts.ciRunOverride || {};
      return { ...CI_RUN, ...override };
    },
    verifyGptEvidence() {
      if (opts.gptEvidenceFails) throw new Error(opts.gptEvidenceFailMsg || 'evidence FAIL');
      return { headSha: SHA.toLowerCase(), policyVersion: POLICY.policyVersion, authorLogin: 'gpt-account' };
    },
    readOperatorAck() {
      if (opts.ackFails) throw new Error(opts.ackFailMsg || 'invalid ack');
      return { operator: 'bo', reason: 'PRE_REVIEW_DIFF_LIMIT', ackAt: '2026-09-01T10:00:00Z', issueRef: '#36' };
    },
    appendAuditLog() {
      if (opts.auditFails) throw new Error('audit write FAIL');
      s.mutations.push('audit');
    },
    listPrComments() {
      return pr.comments.map((c, i) => {
        if (c && typeof c === 'object' && c.body != null) {
          return { id: c.id ?? 'c' + i, user: c.user ?? { login: 'user' }, created_at: c.created_at ?? '-', body: String(c.body) };
        }
        return { id: 'c' + i, user: { login: 'user' }, created_at: '-', body: String(c) };
      });
    },
    getCurrentUser() { return opts.currentUser ?? 'user'; },
    postComment(_r, _n, body) {
      if (opts.failPostComment) throw new Error('gh comment FAIL');
      s.mutations.push('comment');
      pr.comments.push(body);
    },
    removeLabels(_r, _n, labels) {
      if (opts.failRemoveLabels) throw new Error('gh remove-label FAIL');
      s.mutations.push('remove:' + labels.join('|'));
      for (const l of labels) { const i = pr.labels.indexOf(l); if (i >= 0) pr.labels.splice(i, 1); }
    },
    addLabels(_r, _n, labels) {
      s.mutations.push('add:' + labels.join('|'));
      for (const l of labels) if (!pr.labels.includes(l)) pr.labels.push(l);
    },
    log() {},
  };
  return { io, pr, state: s };
}

async function expectThrow(name, fn, needle) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  tru(name + ' throws', threw && (!needle || String(threw.message).includes(needle)));
  return threw;
}

const MANUAL_OPTS = {
  repo: 'o/r', pr: 7, reason: 'PRE_REVIEW_DIFF_LIMIT', ciRunId: '42',
  gptEvidence: GPT_EVIDENCE, operatorAckPath: '/tmp/ack.txt', policyDigest: POLICY_DIGEST,
  decisionId: 'manual-dec-001', worktreeRoot: '/worktree', auditLogPath: '/tmp/audit.jsonl',
};

function makeExistingMarker() {
  return '<!-- ai-review-approval:{"repository":"o/r","prNumber":7,"reviewer":"agent:gpt","headSha":"' + SHA +
    '","policyVersion":"2026-08-23.7","policyDigest":"' + POLICY_DIGEST +
    '","decisionId":"manual-dec-001","kind":"MANUAL_REVIEW_EXCEPTION_APPROVED","reason":"PRE_REVIEW_DIFF_LIMIT","ciRunId":"42","gptEvidence":{"url":"https://github.com/o/r/issues/7#issuecomment-12345","commentId":"12345","authorLogin":"gpt-account"},"operatorAck":{"source":"local-state","ackPath":"/tmp/ack.txt","operator":"bo","reason":"PRE_REVIEW_DIFF_LIMIT","ackAt":"2026-09-01T10:00:00Z","issueRef":"#36"},"openBlockingFindings":0,"reviewedAt":"2026-09-01T10:00:00Z"} -->';
}

(async () => {
  // 1. Happy path
  {
    const { io, pr, state } = makeManualIo();
    const r = await performManualApproval(io, { ...MANUAL_OPTS });
    tru('happy: mutated', r.mutated);
    eq('happy: no skip', r.skipped, null);
    tru('happy: comment posted', state.mutations.includes('comment'));
    tru('happy: audit written', state.mutations.includes('audit'));
    tru('happy: approved label', pr.labels.includes(LABELS.approved));
  }

  // 2. Idempotency: gá»i láº¡i cÃ¹ng evidence â†’ skip, khÃ´ng mutation má»›i
  {
    const { io, pr, state } = makeManualIo({ comments: [makeExistingMarker()], labels: [LABELS.reviewRequested, LABELS.approved] });
    const r = await performManualApproval(io, { ...MANUAL_OPTS });
    eq('idempotent: skipped', r.skipped, 'duplicate');
    tru('idempotent: no new mutation', state.mutations.length === 0);
    tru('idempotent: still approved', pr.labels.includes(LABELS.approved));
  }

  // 3. Reason khÃ¡c PRE_REVIEW_DIFF_LIMIT â†’ fail-closed
  await expectThrow('reason-wrong',
    async () => {
      const { io } = makeManualIo();
      await performManualApproval(io, { ...MANUAL_OPTS, reason: 'OTHER_REASON' });
    }, 'OTHER_REASON');

  // 4. PR state closed â†’ fail-closed
  await expectThrow('pr-closed',
    async () => {
      const { io } = makeManualIo({ state: 'closed' });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'PR open');

  // 5. CI run khÃ´ng tá»“n táº¡i â†’ fail-closed
  await expectThrow('ci-not-found',
    async () => {
      const { io } = makeManualIo({ ciRunNotFound: true });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'CI_FAIL');

  // 6. CI run conclusion != success â†’ fail-closed
  await expectThrow('ci-not-success',
    async () => {
      const { io } = makeManualIo({ ciRunOverride: { conclusion: 'failure' } });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'CI_FAIL');

  // 7. CI run thuá»™c repo khÃ¡c â†’ fail-closed
  await expectThrow('ci-repo-mismatch',
    async () => {
      const { io } = makeManualIo({ ciRunOverride: { repository: 'other/repo' } });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'CI_REPO_MISMATCH');

  // 8. CI run head_sha khÃ¡c â†’ fail-closed
  await expectThrow('ci-head-mismatch',
    async () => {
      const { io } = makeManualIo({ ciRunOverride: { headSha: SHA2 } });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'CI_HEAD_MISMATCH');

  // 9. GPT evidence khÃ´ng há»£p lá»‡ â†’ fail-closed
  await expectThrow('gpt-evidence-invalid',
    async () => {
      const { io } = makeManualIo({ gptEvidenceFails: true, gptEvidenceFailMsg: 'self-authored: mock' });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'GPT_EVIDENCE');

  // 10. Operator ack khÃ´ng há»£p lá»‡ â†’ fail-closed
  await expectThrow('ack-invalid',
    async () => {
      const { io } = makeManualIo({ ackFails: true, ackFailMsg: 'náº±m trong worktree â€” fail-closed' });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'OPERATOR_ACK');

  // 11. Policy digest sai â†’ fail-closed
  await expectThrow('policy-digest-wrong',
    async () => {
      const { io } = makeManualIo();
      await performManualApproval(io, { ...MANUAL_OPTS, policyDigest: '0'.repeat(64) });
    }, 'POLICY_DIGEST_MISMATCH');

  // 12. Policy khÃ´ng cÃ³ manualException â†’ fail-closed
  await expectThrow('policy-no-manual-exception',
    async () => {
      const noManualPolicy = JSON.parse(JSON.stringify(POLICY));
      delete noManualPolicy.manualException;
      const { io } = makeManualIo({ customPolicy: noManualPolicy });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'manualException');

  // 13. Audit log path thiáº¿u â†’ fail-closed
  await expectThrow('audit-path-missing',
    async () => {
      const { io } = makeManualIo();
      await performManualApproval(io, { ...MANUAL_OPTS, auditLogPath: '' });
    }, 'AUDIT_PATH');

  // 14. Audit log ghi lá»—i â†’ fail-closed (marker Ä‘Ã£ Ä‘Äƒng, cáº§n drift-repair)
  await expectThrow('audit-fail',
    async () => {
      const { io } = makeManualIo({ auditFails: true });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'AUDIT_FAIL');

  // 15. HEAD drift giá»¯a validation vÃ  mutation â†’ fail-closed
  await expectThrow('head-drift',
    async () => {
      let call = 0;
      const base = makeManualIo();
      base.io.getPrView = () => {
        call++;
        return call >= 2
          ? { state: 'open', headRefOid: SHA2, labels: [LABELS.reviewRequested] }
          : { state: 'open', headRefOid: SHA, labels: [LABELS.reviewRequested] };
      };
      await performManualApproval(base.io, { ...MANUAL_OPTS });
    }, 'HEAD_DRIFT');

  // 16. Actor khÃ´ng thuá»™c gptApprovers â†’ fail-closed
  await expectThrow('actor-not-approver',
    async () => {
      const { io } = makeManualIo({ currentUser: 'attacker' });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'gptApprovalCommentAuthors');

  // ================================================================
  // 17. Policy manualException.enabled !== true → fail-closed
  await expectThrow('policy-enabled-false',
    async () => {
      const disabledPolicy = JSON.parse(JSON.stringify(POLICY));
      disabledPolicy.manualException = { enabled: false, allowedReason: ['PRE_REVIEW_DIFF_LIMIT'] };
      const { io } = makeManualIo({ customPolicy: disabledPolicy });
      await performManualApproval(io, { ...MANUAL_OPTS });
    }, 'enabled');

  // Report
  // ================================================================
  const pass = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== TEST REPORT: gpt-approval-manual-exception ===');
  for (const r of results) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.name + (r.ok ? '' : ' â€” got=' + JSON.stringify(r.got) + ' want=' + JSON.stringify(r.want)));
  }
  console.log('Total: ' + pass + '/' + results.length + ' PASS');
  if (failed.length) {
    console.error('FAILED: ' + failed.map((r) => r.name).join(', '));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });


