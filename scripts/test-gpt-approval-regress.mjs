#!/usr/bin/env node
// test-gpt-approval-regress.mjs — Đóng vòng GPT-REV-136/137/138 (PR #37).
// Cover: real-FS defaultIo().readOperatorAck() (không mock), exact failedGates cardinality,
// finite non-negative count validation, FAIL audit redacted cho actor/root/digest/audit-path mismatch.
// Exit 0/1.

import { performManualApproval, defaultIo, NonAuditableBootstrapFailure } from './gpt-approval.mjs';
import { LABELS, computePolicyDigest } from './review-contract.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const results = [];
const eq = (name, got, want) => results.push({ name, ok: got === want, got, want });
const tru = (name, got) => results.push({ name, ok: Boolean(got), got });

const SHA = 'c'.repeat(40);

// [GPT-REV-136] Temp dirs thật: worktree + memory-bank + ack ngoài worktree.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-regress-'));
const WT = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-regress-wt-'));
const MB = path.join(WT, 'memory-bank');
fs.mkdirSync(MB, { recursive: true });
const AUDIT_ROOT = TMP;
const AUDIT_PATH = path.join(TMP, 'audit.jsonl');
const ACK_OUTSIDE = path.join(TMP, 'ack-ok.txt');
const ACK_IN_WT = path.join(WT, 'ack-in.txt');
const ACK_IN_MB = path.join(MB, 'ack-mb.txt');
function writeAck(p) {
  fs.writeFileSync(p, [
    'OPERATOR: bo',
    'REASON: PRE_REVIEW_DIFF_LIMIT',
    'ACK_AT: 2026-09-01T10:00:00Z',
    'ISSUE_REF: #36',
  ].join('\n'), 'utf8');
}
writeAck(ACK_OUTSIDE);
writeAck(ACK_IN_WT);
writeAck(ACK_IN_MB);

const POLICY = {
  policyVersion: '2026-09-02.1',
  requiredChecks: ['verify'],
  blockingSeverities: ['critical', 'important'],
  finalReviewer: 'agent:gpt',
  maxReviewRounds: 3,
  diffLimits: { maxLines: 1500 },
  approvalAuthorities: { gptApprovalCommentAuthors: ['user', 'gpt-account'], localApprovalCommentAuthors: ['user'], reviewerAuthorityAllowlist: ['gpt-account'] },
  manualException: {
    enabled: true, allowedReason: ['PRE_REVIEW_DIFF_LIMIT'],
    target: { repository: 'o/r', prNumber: 7, headSha: SHA, decisionId: 'regress-dec-001', activatedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    auditLogPath: AUDIT_PATH, auditLogRoot: AUDIT_ROOT, approvedCiWorkflows: ['Verify CI'],
  },
};
const POLICY_DIGEST = computePolicyDigest(POLICY);
const GPT_EVIDENCE = { url: 'https://github.com/o/r/issues/7#issuecomment-12345', commentId: '12345' };
const CI_RUN = { repository: 'o/r', headSha: SHA, status: 'completed', conclusion: 'success', workflow: 'Verify CI' };

function makeIo(opts = {}) {
  const pr = { state: opts.state ?? 'open', headRefOid: opts.headSha ?? SHA, labels: [...(opts.labels ?? [LABELS.reviewRequested])], comments: [] };
  const s = { mutations: [], audit: [] };
  const io = {
    getPrView() { return { state: pr.state, headRefOid: pr.headRefOid, labels: [...pr.labels] }; },
    resolveGitRoot() {
      if (opts.gitRootFails) throw new Error('git rev-parse FAIL');
      if (opts.gitRootForge) return path.resolve('/elsewhere');
      return path.resolve(opts.gitRoot ?? WT);
    },
    getPolicy() {
      if (opts.policyFails) throw new Error('gh api policy FAIL');
      return JSON.parse(JSON.stringify(opts.customPolicy || POLICY));
    },
    getCiRun() {
      if (opts.ciRunNotFound) return null;
      return { ...CI_RUN, ...(opts.ciRunOverride || {}) };
    },
    getGateState() {
      return {
        blockingStatusLabels: [], preReviewVerdict: 'PRE_REVIEW_FINDINGS',
        openBlockingFindings: 1, dependencyBlocks: 0, failedGates: ['PRE_REVIEW_DIFF_LIMIT'],
        ...(opts.gateStateOverride || {}),
      };
    },
    verifyGptEvidence(_repo, _pr, _ev, mockOpts) {
      const pol = opts.customPolicy || POLICY;
      return { headSha: SHA, policyVersion: pol.policyVersion, authorLogin: 'gpt-account', issuer: 'gpt-account', policyDigest: computePolicyDigest(pol), decisionId: String((mockOpts && mockOpts.decisionId) || base.decisionId), issuedAt: '2026-09-01T10:00:00Z', reviewDigest: 'a'.repeat(64) };
    },
    readOperatorAck() { return { operator: 'bo', reason: 'PRE_REVIEW_DIFF_LIMIT', ackAt: '2026-09-01T10:00:00Z', issueRef: '#36' }; },
    appendAuditLog(p, e) { s.mutations.push('audit'); s.audit.push(e); },
    readAuditLog() { return s.audit.length ? s.audit[s.audit.length - 1] : null; },
    readAuditEntries() { return [...s.audit]; },
    listPrComments() {
      return pr.comments.map((c, i) => ({ id: 'c' + i, user: { login: 'user' }, created_at: '-', body: String(c) }));
    },
    getCurrentUser() { return opts.currentUser ?? 'user'; },
    postComment(_r, _n, body) { s.mutations.push('comment'); pr.comments.push(body); },
    removeLabels(_r, _n, labels) { for (const l of labels) { const i = pr.labels.indexOf(l); if (i >= 0) pr.labels.splice(i, 1); } },
    addLabels(_r, _n, labels) { for (const l of labels) if (!pr.labels.includes(l)) pr.labels.push(l); },
    log() {},
  };
  return { io, pr, state: s };
}

const base = {
  repo: 'o/r', pr: 7, reason: 'PRE_REVIEW_DIFF_LIMIT', ciRunId: '42',
  gptEvidence: GPT_EVIDENCE, operatorAckPath: ACK_OUTSIDE, policyDigest: POLICY_DIGEST,
  decisionId: 'regress-dec-001', worktreeRoot: WT, auditLogPath: AUDIT_PATH,
};

async function expectThrow(name, fn, needle) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  tru(name + ' throws', threw && (!needle || String(threw.message).includes(needle)));
  return threw;
}

(async () => {
  // ================================================== GPT-REV-136: real-FS readOperatorAck

  // 136.1 — ack hợp lệ ngoài worktree/memory-bank → parse OK
  {
    const io = defaultIo();
    const out = io.readOperatorAck(ACK_OUTSIDE, { worktreeRoot: WT });
    eq('136 ack outside: operator', out.operator, 'bo');
    eq('136 ack outside: issueRef', out.issueRef, '#36');
  }

  // 136.2 — ack NẰM trong worktree → reject (fail-closed)
  {
    const io = defaultIo();
    let threw = null;
    try { io.readOperatorAck(ACK_IN_WT, { worktreeRoot: WT }); } catch (e) { threw = e; }
    tru('136 ack in worktree: reject', threw && String(threw.message).includes('worktree'));
  }

  // 136.3 — ack NẰM trong memory-bank → reject (fail-closed)
  {
    const io = defaultIo();
    let threw = null;
    try { io.readOperatorAck(ACK_IN_MB, { worktreeRoot: WT }); } catch (e) { threw = e; }
    tru('136 ack in memory-bank: reject', threw && String(threw.message).includes('memory-bank'));
  }

  // 136.4 — ack qua symlink/reparse escape (platform hỗ trợ) → reject
  {
    const io = defaultIo();
    const link = path.join(TMP, 'ack-escape-link.txt');
    let canLink = true;
    try { fs.unlinkSync(link); } catch { /* chưa tồn tại */ }
    try { fs.symlinkSync(ACK_IN_WT, link); } catch { canLink = false; } // thiếu quyền → skip, không fail.
    if (canLink) {
      let threw = null;
      try { io.readOperatorAck(link, { worktreeRoot: WT }); } catch (e) { threw = e; }
      tru('136 ack through symlink escape: reject', threw && String(threw.message).includes('worktree'));
    } else {
      tru('136 ack through symlink escape: skipped (no symlink privilege)', true);
    }
  }

  // ================================================== GPT-REV-137: gate state negative

  // 137.1 — failedGates rỗng → reject
  await expectThrow('137 failedGates empty',
    async () => {
      const { io } = makeIo({ gateStateOverride: { preReviewVerdict: 'PRE_REVIEW_FINDINGS', openBlockingFindings: 1, dependencyBlocks: 0, failedGates: [] } });
      await performManualApproval(io, { ...base });
    }, 'FAILED_GATES_NOT_DIFF_LIMIT_ONLY');

  // 137.2 — duplicate PRE_REVIEW_DIFF_LIMIT → reject
  await expectThrow('137 failedGates duplicate',
    async () => {
      const { io } = makeIo({ gateStateOverride: { openBlockingFindings: 1, dependencyBlocks: 0, failedGates: ['PRE_REVIEW_DIFF_LIMIT', 'PRE_REVIEW_DIFF_LIMIT'] } });
      await performManualApproval(io, { ...base });
    }, 'FAILED_GATES_NOT_DIFF_LIMIT_ONLY');

  // 137.3 — diff-limit + gate khác → reject
  await expectThrow('137 failedGates diff+other',
    async () => {
      const { io } = makeIo({ gateStateOverride: { openBlockingFindings: 1, dependencyBlocks: 0, failedGates: ['PRE_REVIEW_DIFF_LIMIT', 'SOME_OTHER_GATE'] } });
      await performManualApproval(io, { ...base });
    }, 'FAILED_GATES_NOT_DIFF_LIMIT_ONLY');

  // 137.4 — openBlockingFindings NaN → reject
  await expectThrow('137 openBlockingFindings NaN',
    async () => {
      const { io } = makeIo({ gateStateOverride: { openBlockingFindings: 'x', dependencyBlocks: 0, failedGates: ['PRE_REVIEW_DIFF_LIMIT'] } });
      await performManualApproval(io, { ...base });
    }, 'BLOCKER_COUNT_MALFORMED');

  // 137.5 — dependencyBlocks negative → reject
  await expectThrow('137 dependencyBlocks negative',
    async () => {
      const { io } = makeIo({ gateStateOverride: { openBlockingFindings: 1, dependencyBlocks: -1, failedGates: ['PRE_REVIEW_DIFF_LIMIT'] } });
      await performManualApproval(io, { ...base });
    }, 'DEPENDENCY_BLOCKS_MALFORMED');

  // 137.6 — openBlockingFindings float → reject
  await expectThrow('137 openBlockingFindings float',
    async () => {
      const { io } = makeIo({ gateStateOverride: { openBlockingFindings: 1.5, dependencyBlocks: 0, failedGates: ['PRE_REVIEW_DIFF_LIMIT'] } });
      await performManualApproval(io, { ...base });
    }, 'BLOCKER_COUNT_MALFORMED');

  // 137.7 — happy: failedGates đúng exact + counts hợp lệ → PASS
  {
    const { io, state } = makeIo({});
    const r = await performManualApproval(io, { ...base });
    tru('137 happy: mutated', r.mutated);
    tru('137 happy: audit written', state.mutations.includes('audit'));
  }

  // ================================================== GPT-REV-138: FAIL audit redacted + non-auditable

  // 138.1 — actor rejection → ghi FAIL audit redacted (KHÔNG message thô, KHÔNG ack path)
  {
    const { io, state } = makeIo({ currentUser: 'attacker' });
    await expectThrow('138 actor-reject throws', async () => performManualApproval(io, { ...base }), 'gptApprovalCommentAuthors');
    const last = state.audit[state.audit.length - 1];
    tru('138 actor-reject: audit written', Boolean(last) && last.result === 'FAIL');
    tru('138 actor-reject: no raw message', !('message' in last));
    tru('138 actor-reject: no ack path', !('operatorAckPath' in last));
  }

  // 138.2 — worktree root mismatch → NonAuditableBootstrapFailure (KHÔNG destination an toàn)
  {
    const { io, state } = makeIo({ gitRootForge: true }); // trustedRoot='/elsewhere', CLI=WT → mismatch
    const e = await expectThrow('138 root-mismatch throws', async () => performManualApproval(io, { ...base }), 'WORKTREE_ROOT_MISMATCH');
    tru('138 root-mismatch: NonAuditable class', e instanceof NonAuditableBootstrapFailure);
    tru('138 root-mismatch: no audit', state.audit.length === 0);
  }

  // 138.3 — policy digest computation failure (policyDigest lệch computed) → FAIL redacted
  {
    const { io, state } = makeIo({});
    await expectThrow('138 policy-digest mismatch throws', async () => performManualApproval(io, { ...base, policyDigest: '0'.repeat(64) }), 'POLICY_DIGEST_MISMATCH');
    const last = state.audit[state.audit.length - 1];
    tru('138 policy-digest mismatch: audit FAIL', Boolean(last) && last.result === 'FAIL' && last.failureCode === 'POLICY_DIGEST_MISMATCH');
  }

  // 138.4 — audit-path mismatch → NonAuditableBootstrapFailure (chưa có destination canonical)
  {
    const { io, state } = makeIo({});
    const e = await expectThrow('138 audit-path mismatch throws', async () => performManualApproval(io, { ...base, auditLogPath: path.join(TMP, 'OTHER.jsonl') }), 'AUDIT_PATH_MISMATCH');
    tru('138 audit-path mismatch: NonAuditable class', e instanceof NonAuditableBootstrapFailure);
    tru('138 audit-path mismatch: no audit', state.audit.length === 0);
  }

  // ---------------------------------------------------------------- report
  const pass = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== TEST REPORT: gpt-approval-regress ===');
  for (const r of results) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.name + (r.ok ? '' : ' — got=' + JSON.stringify(r.got) + ' want=' + JSON.stringify(r.want)));
  }
  console.log('Total: ' + pass + '/' + results.length + ' PASS');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(WT, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('[FATAL]', e && e.message ? e.message : e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(WT, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
});
