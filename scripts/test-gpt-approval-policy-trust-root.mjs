#!/usr/bin/env node
// test-gpt-approval-policy-trust-root.mjs — GPT-REV-137.
// Tách bạch policy identity (server-resolved canonical source commit) khỏi review target identity
// (PR HEAD): approval authority đến từ policySourceRef, TUYỆT ĐỐI không từ PR HEAD cho canonical
// self-review. Cover A-K deterministic invariant. Exit 0/1.

import { performApproval, performManualApproval, performRevoke } from './gpt-approval.mjs';
import {
  LABELS, AGENTS, computePolicyDigest, buildApprovalMarker, parseApprovalMarkers,
} from './review-contract.mjs';
import { CANONICAL_REPO, CANONICAL_PATH, resolvePolicyForRepo } from './effective-policy.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// [GPT-REV-138] Manual path cần audit path + worktree + ack file real-FS (realpathSync fail-closed).
const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-137-'));
const TEST_AUDIT_ROOT = TEST_TMP;
const TEST_AUDIT_PATH = path.join(TEST_TMP, 'audit.jsonl');
const TEST_WORKTREE = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-137-wt-'));
const TEST_ACK_PATH = path.join(TEST_TMP, 'ack.txt');
fs.writeFileSync(TEST_ACK_PATH, [
  'OPERATOR: bo', 'REASON: PRE_REVIEW_DIFF_LIMIT',
  'ACK_AT: 2026-09-01T10:00:00Z', 'ISSUE_REF: #36',
].join('\n'), 'utf8');

const SHA = 'c'.repeat(40);            // target PR HEAD
const CANONICAL_SHA = '9'.repeat(40);  // server-resolved canonical source commit (policy identity)
const POLICY = {
  policyVersion: '2026-09-02.1',
  requiredChecks: ['verify'],
  blockingSeverities: ['critical', 'important'],
  finalReviewer: 'agent:gpt',
  maxReviewRounds: 3,
  diffLimits: { maxLines: 1500 },
  approvalAuthorities: { gptApprovalCommentAuthors: ['user', 'gpt-account'], localApprovalCommentAuthors: ['user'], reviewerAuthorityAllowlist: ['gpt-account'] },
  projectPolicyContract: {
    canonicalRepo: CANONICAL_REPO, canonicalPath: CANONICAL_PATH,
    allowedProjectOverrides: ['manualException', 'diffLimits'],
    invariantLockedKeys: ['policyVersion', 'finalReviewer'],
  },
  manualException: {
    enabled: true, allowedReason: ['PRE_REVIEW_DIFF_LIMIT'],
    target: { repository: 'o/r', prNumber: 7, headSha: SHA, decisionId: 'manual-dec-001', activatedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    auditLogPath: TEST_AUDIT_PATH, auditLogRoot: TEST_AUDIT_ROOT, approvedCiWorkflows: ['Verify CI'],
  },
};
const POLICY_DIGEST = computePolicyDigest(POLICY);
const PASS_MARKER = `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${SHA} -->`;
const GPT_EVIDENCE = { url: 'https://github.com/o/r/issues/7#issuecomment-12345', commentId: '12345' };
const CI_RUN = { repository: 'o/r', headSha: SHA, status: 'completed', conclusion: 'success', workflow: 'Verify CI' };

const results = [];
const eq = (name, got, want) => results.push({ name, ok: got === want, got, want });
const tru = (name, got) => results.push({ name, ok: Boolean(got), got });

function makeIo(opts = {}) {
  const pr = {
    state: opts.state ?? 'open', headRefOid: opts.headSha ?? SHA,
    labels: [...(opts.labels ?? [LABELS.reviewRequested])],
    comments: [...(opts.comments ?? [PASS_MARKER])],
  };
  const s = { mutations: [], audit: [], policyCalls: [] };
  const sourceCommit = opts.sourceCommitInvalid ? 'not-a-40-hex' : (opts.canonicalSha ?? CANONICAL_SHA);
  const fetchContent = (_r, p) => JSON.stringify(POLICY);
  const io = {
    getPrView() { return { state: pr.state, headRefOid: pr.headRefOid, labels: [...pr.labels] }; },
    // [GPT-REV-137] Server-resolved canonical source — TACH BIET khoi PR HEAD.
    resolveCanonicalSource() {
      if (opts.sourceResolveThrows) throw new Error('gh api canonical FAIL');
      return { repo: CANONICAL_REPO, ref: 'main', sourceCommit, path: CANONICAL_PATH };
    },
    getPolicy(repo, ref, policySourceRef) {
      s.policyCalls.push({ repo, ref, policySourceRef });
      if (opts.getPolicyThrows) throw new Error(opts.getPolicyThrowMsg || 'BLOCKED_CANONICAL_INVALID: bat buoc policySourceRef');
      if (opts.realResolve) return resolvePolicyForRepo({ repo, ref, policySourceRef, fetchContent });
      return JSON.parse(JSON.stringify(POLICY));
    },
    getCurrentUser() { return opts.currentUser ?? 'user'; },
    getChecks() { return { checks: [{ name: 'verify', state: 'SUCCESS' }] }; },
    listPrComments() {
      return pr.comments.map((c, i) => {
        if (c && typeof c === 'object' && c.body != null) {
          return { id: c.id ?? 'c' + i, user: c.user ?? { login: 'user' }, created_at: c.created_at ?? '-', body: String(c.body) };
        }
        return { id: 'c' + i, user: { login: 'user' }, created_at: '-', body: String(c) };
      });
    },
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
    // --- manual path extras ---
    resolveGitRoot() { return path.resolve(opts.gitRoot ?? TEST_WORKTREE); },
    getCiRun() {
      if (opts.ciRunNotFound) return null;
      return { ...CI_RUN, ...(opts.ciRunOverride || {}) };
    },
    verifyGptEvidence(_r, _p, _ev, mockOpts) {
      return {
        headSha: SHA, policyVersion: POLICY.policyVersion, authorLogin: 'gpt-account',
        issuer: 'gpt-account', policyDigest: POLICY_DIGEST,
        decisionId: String((mockOpts && mockOpts.decisionId) || 'manual-dec-001'),
        issuedAt: '2026-09-01T10:00:00Z', reviewDigest: 'a'.repeat(64),
      };
    },
    readOperatorAck() { return { operator: 'bo', reason: 'PRE_REVIEW_DIFF_LIMIT', ackAt: '2026-09-01T10:00:00Z', issueRef: '#36' }; },
    getGateState() {
      return {
        blockingStatusLabels: [], preReviewVerdict: 'PRE_REVIEW_FINDINGS',
        openBlockingFindings: 1, dependencyBlocks: 0, failedGates: ['PRE_REVIEW_DIFF_LIMIT'],
      };
    },
    appendAuditLog(_p, entry) { s.mutations.push('audit'); s.audit.push(entry); },
    readAuditEntries() { return [...s.audit]; },
    readAuditLog() { return s.audit.length ? s.audit[s.audit.length - 1] : null; },
    deleteAuditLog() { s.mutations.push('audit-delete'); s.audit = []; },
    log() {},
  };
  return { io, pr, state: s };
}

const APPROVAL_PAYLOAD = {
  repository: 'o/r', prNumber: 7, headSha: SHA,
  policyVersion: POLICY.policyVersion, decisionId: 'decision-001',
  evidenceUrl: 'https://github.com/o/r/actions/runs/1', actor: 'user',
};
const MANUAL_OPTS = {
  repo: 'o/r', pr: 7, reason: 'PRE_REVIEW_DIFF_LIMIT', ciRunId: '42',
  gptEvidence: GPT_EVIDENCE, operatorAckPath: TEST_ACK_PATH, policyDigest: POLICY_DIGEST,
  decisionId: 'manual-dec-001', worktreeRoot: TEST_WORKTREE, auditLogPath: TEST_AUDIT_PATH,
};

async function expectThrow(name, fn, needle) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  results.push({ name, ok: threw && (!needle || String(threw.message).includes(needle)) });
  return threw;
}


function lastApprovalMarker(pr) {
  const parsed = parseApprovalMarkers(pr.comments.map((c, i) => ({ id: 'c' + i, user: { login: 'user' }, created_at: '-', body: String(c) })));
  return parsed.length ? parsed[parsed.length - 1].marker : null;
}

(async () => {
  // --- A. Canonical self-review doc policy tai policySourceRef, KHONG phai ref (PR HEAD) ---
  {
    let saw;
    const out = resolvePolicyForRepo({
      repo: CANONICAL_REPO, ref: SHA, policySourceRef: CANONICAL_SHA,
      fetchContent: (r, p, rr) => { saw = { r, p, rr }; return JSON.stringify(POLICY); },
    });
    eq('A: policy version tu source', out.policy.policyVersion, POLICY.policyVersion);
    eq('A: fetch tai policySourceRef', saw.rr, CANONICAL_SHA);
    tru('A: fetch KHONG phai PR HEAD', saw.rr !== SHA);
  }
  // --- B. Thieu policySourceRef -> fail-closed (chan fixed-point self-reference) ---
  {
    const e = await expectThrow('B: thieu policySourceRef',
      async () => resolvePolicyForRepo({ repo: CANONICAL_REPO, ref: SHA, fetchContent: () => JSON.stringify(POLICY) }), 'policySourceRef');
    tru('B: code BLOCKED_CANONICAL_INVALID', e && e.code === 'BLOCKED_CANONICAL_INVALID');
  }
  // --- C. policySourceRef di dong (khong full 40-hex) -> fail-closed ---
  {
    for (const bad of ['main', 'develop', 'v1', 'c'.repeat(39)]) {
      const e = await expectThrow('C: source di dong ' + bad,
        async () => resolvePolicyForRepo({ repo: CANONICAL_REPO, ref: SHA, policySourceRef: bad, fetchContent: () => JSON.stringify(POLICY) }), 'full 40-hex');
      tru('C: code BLOCKED_CANONICAL_INVALID ' + bad, e && e.code === 'BLOCKED_CANONICAL_INVALID');
    }
  }
  // --- D. performApproval resolve canonical source va truyen sourceCommit vao getPolicy ---
  {
    const { io, state } = makeIo();
    const r = await performApproval(io, { repo: 'o/r', pr: 7, payload: APPROVAL_PAYLOAD });
    tru('D: mutated', r.mutated);
    eq('D: getPolicy nhan policySourceRef = canonical', state.policyCalls[0].policySourceRef, CANONICAL_SHA);
    tru('D: getPolicy ref = PR HEAD (target)', state.policyCalls[0].ref === SHA);
    tru('D: policySourceRef != target ref', state.policyCalls[0].policySourceRef !== state.policyCalls[0].ref);
  }
  // --- E. Marker carry policySource/operator/reviewerPrincipals tach bach khoi headSha ---
  {
    const { io, pr } = makeIo();
    await performApproval(io, { repo: 'o/r', pr: 7, payload: APPROVAL_PAYLOAD });
    const mk = lastApprovalMarker(pr);
    tru('E: marker co policySource', mk && mk.policySource);
    eq('E: policySource.sourceCommit', mk && mk.policySource.sourceCommit, CANONICAL_SHA);
    eq('E: policySource.repo', mk && mk.policySource.repo, CANONICAL_REPO);
    eq('E: operator = actor', mk && mk.operator, 'user');
    tru('E: reviewerPrincipals tu policy allowlist', Array.isArray(mk && mk.reviewerPrincipals) && mk.reviewerPrincipals.includes('gpt-account'));
    tru('E: target nhan dien qua headSha', mk && mk.headSha === SHA);
    tru('E: identity tach bach (source != headSha)', mk && mk.policySource.sourceCommit !== mk.headSha);
  }
  // --- F. performManualApproval: marker + audit deu co policySource/operator/reviewerPrincipals ---
  {
    const { io, pr, state } = makeIo();
    const r = await performManualApproval(io, { ...MANUAL_OPTS });
    tru('F: mutated', r.mutated);
    const mk = lastApprovalMarker(pr);
    eq('F: marker policySource.sourceCommit', mk && mk.policySource.sourceCommit, CANONICAL_SHA);
    eq('F: marker operator', mk && mk.operator, 'user');
    tru('F: marker reviewerPrincipals', Array.isArray(mk && mk.reviewerPrincipals) && mk.reviewerPrincipals.includes('gpt-account'));
    const audit = state.audit[0];
    tru('F: audit viet', audit && audit.result === 'PASS');
    eq('F: audit policySource.sourceCommit', audit && audit.policySource.sourceCommit, CANONICAL_SHA);
    eq('F: audit operator', audit && audit.operator, 'user');
    tru('F: audit reviewerPrincipals', Array.isArray(audit && audit.reviewerPrincipals) && audit.reviewerPrincipals.includes('gpt-account'));
  }
  // --- G. resolveCanonicalSource tra SHA sai -> CI_UNKNOWN, khong mutation ---
  {
    const { io, state } = makeIo({ sourceCommitInvalid: true, realResolve: true });
    await expectThrow('G: source SHA khong hop le',
      async () => performApproval(io, { repo: CANONICAL_REPO, pr: 7, payload: APPROVAL_PAYLOAD }), 'CI_UNKNOWN');
    tru('G: khong mutation', state.mutations.length === 0);
  }
  // --- H. getPolicy bi chan (canonical blocked) -> khong approval, khong mutation ---
  {
    const { io, state } = makeIo({ getPolicyThrows: true, getPolicyThrowMsg: 'BLOCKED_CANONICAL_INVALID: bat buoc policySourceRef' });
    await expectThrow('H: getPolicy bi chan',
      async () => performApproval(io, { repo: CANONICAL_REPO, pr: 7, payload: APPROVAL_PAYLOAD }), 'CI_UNKNOWN');
    tru('H: khong mutation', state.mutations.length === 0);
  }
  // --- I. Revoke idempotent: da co marker revoke + khong con approved -> skip, khong dang trung ---
  {
    const prevRevoke = 'revoke\\n<!-- ai-pr-reviewer:key=o/r::7::' + SHA + '::revoke -->';
    const { io, state } = makeIo({ comments: [prevRevoke], labels: [LABELS.reviewRequested], headSha: SHA });
    const r = await performRevoke(io, { repo: 'o/r', pr: 7, reason: 'test' });
    eq('I: skipped', r.skipped, 'already-revoked');
    tru('I: khong mutation moi', state.mutations.length === 0);
  }

  // --- J. Revoke lan dau: mutated, dat review-requested, xoa approved, dang marker revoke ---
  {
    const { io, pr } = makeIo({ labels: [LABELS.approved], headSha: SHA });
    const r = await performRevoke(io, { repo: 'o/r', pr: 7, reason: 'da co approval moi sai nguon' });
    tru('J: mutated', r.mutated);
    tru('J: xoa approved', pr.labels.includes(LABELS.approved) === false);
    tru('J: review-requested', pr.labels.includes(LABELS.reviewRequested));
    tru('J: dang marker revoke', pr.comments.some((c) => String(c).includes('::' + SHA + '::revoke')));
  }
  // --- K. buildApprovalMarker nhan identity tach bach (policySource tu server source, target qua headSha) ---
  {
    const marker = buildApprovalMarker({
      repository: 'o/r', prNumber: 7, reviewer: AGENTS.gpt, headSha: SHA,
      policyVersion: POLICY.policyVersion, decisionId: 'dec-k',
      policySource: { repo: CANONICAL_REPO, ref: 'main', sourceCommit: CANONICAL_SHA, path: CANONICAL_PATH },
      operator: 'user', reviewerPrincipals: ['gpt-account'],
    });
    const parsed = JSON.parse(marker.replace(/^<!-- ai-review-approval:/, '').replace(/ -->$/, ''));
    eq('K: policySource.sourceCommit', parsed.policySource.sourceCommit, CANONICAL_SHA);
    eq('K: operator', parsed.operator, 'user');
    tru('K: reviewerPrincipals', Array.isArray(parsed.reviewerPrincipals) && parsed.reviewerPrincipals.includes('gpt-account'));
    tru('K: policy identity tach bach khoi target', parsed.policySource.sourceCommit !== parsed.headSha);
  }

  // ------------------------------------------------------------------ report
  const failed = results.filter((r) => !r.ok);
  const terse = [];
  for (const k of 'ABCDEFGHIJK') {
    const group = results.filter((r) => r.name.startsWith(k + ':'));
    if (group.length && group.every((r) => r.ok)) terse.push(k);
  }
  console.log('GPT-REV-137 deterministic PASS:', terse.join(', '));
  if (failed.length) {
    console.error('FAIL (' + failed.length + '/' + results.length + '):');
    for (const f of failed) console.error(' - ' + f.name + ' expected=' + JSON.stringify(f.want) + ' got=' + JSON.stringify(f.got));
    process.exit(1);
  }
  console.log('ALL ' + results.length + ' assertions PASS');
  process.exit(0);
})();

