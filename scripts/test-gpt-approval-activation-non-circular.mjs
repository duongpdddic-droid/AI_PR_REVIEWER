#!/usr/bin/env node
// test-gpt-approval-activation-non-circular.mjs — GPT-REV-139.
// Chứng minh activation KHÔNG tự-quy chiếu (non-circular): authority của manualException đến từ
// policy tại canonical default-branch TIP (policySourceCommit), là một commit KHÁC hoàn toàn với
// target PR HEAD mà activation nhắm tới. Chạy đúng gate performManualApproval với policy thật
// (manualException.enabled=true, target trỏ TARGET_PR_HEAD ổn định) và chứng minh App evidence hợp
// lệ được chấp nhận; sau đó chứng minh KHÔNG mutation cho từng negative case.
// Exit 0/1.
import { performManualApproval } from './gpt-approval.mjs';
import { AGENTS, LABELS, computePolicyDigest, parseApprovalMarkers } from './review-contract.mjs';
import { CANONICAL_REPO, CANONICAL_PATH } from './effective-policy.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-139-'));
const TEST_AUDIT_ROOT = TEST_TMP;
const TEST_AUDIT_PATH = path.join(TEST_TMP, 'audit.jsonl');
const TEST_WORKTREE = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-139-wt-'));
const TEST_ACK_PATH = path.join(TEST_TMP, 'ack.txt');
fs.writeFileSync(TEST_ACK_PATH, ['OPERATOR: bo', 'REASON: PRE_REVIEW_DIFF_LIMIT', 'ACK_AT: 2026-09-01T10:00:00Z', 'ISSUE_REF: #36'].join('\n'), 'utf8');
// Rule 08 temp-hygiene: dọn dir tạm ngoài repo trong finally; idempotent + an toàn (recursive có force).
function cleanup() {
  for (const p of [TEST_TMP, TEST_WORKTREE]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}

// [GPT-REV-139] HAI commit hoàn toàn khác nhau:
const TARGET_PR_HEAD = 'c'.repeat(40);         // target PR HEAD (review target identity)
const POLICY_SOURCE_COMMIT = '9'.repeat(40);    // canonical default-branch tip (policy identity)

const POLICY = {
  policyVersion: '2026-09-02.2',
  requiredChecks: ['verify'],
  blockingSeverities: ['critical'],
  finalReviewer: 'agent:gpt',
  maxReviewRounds: 3,
  diffLimits: { maxLines: 1500 },
  approvalAuthorities: {
    gptApprovalCommentAuthors: ['user', 'gpt-account'],
    localApprovalCommentAuthors: ['user'],
    reviewerAuthorityAllowlist: ['gpt-account'],
  },
  projectPolicyContract: {
    canonicalRepo: CANONICAL_REPO, canonicalPath: CANONICAL_PATH,
    allowedProjectOverrides: ['manualException', 'diffLimits'],
    invariantLockedKeys: ['policyVersion', 'finalReviewer'],
  },
  // [GPT-REV-139] Policy chứa manualException ENABLED, target trỏ TARGET_PR_HEAD ổn định.
  manualException: {
    enabled: true,
    allowedReason: ['PRE_REVIEW_DIFF_LIMIT'],
    target: {
      repository: 'o/r', prNumber: 7, headSha: TARGET_PR_HEAD, decisionId: 'manual-dec-001',
      activatedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    },
    auditLogPath: TEST_AUDIT_PATH, auditLogRoot: TEST_AUDIT_ROOT,
    approvedCiWorkflows: ['Verify CI'],
  },
};
const POLICY_DIGEST = computePolicyDigest(POLICY);
const GPT_EVIDENCE = { url: 'https://github.com/o/r/issues/7#issuecomment-12345', commentId: '12345' };

const results = [];
const eq = (n, g, w) => results.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => results.push({ name: n, ok: Boolean(g), got: Boolean(g) });
function makeIo(opts = {}) {
  const HEAD = opts.headSha ?? TARGET_PR_HEAD;
  const labels = [...(opts.labels ?? [LABELS.reviewRequested])];
  const comments = [...(opts.comments ?? [])];
  const s = { mutations: [], audit: [], policyCalls: [] };
  let srcCall = 0;
  const io = {
    getPrView() { return { state: 'open', headRefOid: HEAD, labels: [...labels] }; },
    resolveCanonicalSource() {
      srcCall++;
      let sc = opts.canonicalSha ?? POLICY_SOURCE_COMMIT;
      // [GPT-REV-138] performManualApproval resolve canonical source 2 lần: lần đầu (srcCall=1) lúc
      // đọc policy, lần 2 (srcCall=2) re-resolve NGAY TRƯỚC mutation. Đổi tip ở lần 2 để chứng minh
      // drift giữa resolution & mutation → CANONICAL_SOURCE_DRIFT, không approval.
      if (opts.driftTip && srcCall >= 2) sc = opts.driftTip;
      return { repo: CANONICAL_REPO, ref: 'main', sourceCommit: sc, path: CANONICAL_PATH };
    },
    getPolicy(repo, ref, policySourceRef) {
      s.policyCalls.push({ repo, ref, policySourceRef });
      // performManualApproval nhận policy object TRỰC TIẾP (không wrap {policy,meta}).
      if (opts.policyOverride) return opts.policyOverride;
      return POLICY;
    },
    getCurrentUser() { return opts.currentUser ?? 'user'; },
    getCiRun() {
      if (opts.ciRunNotFound) return null;
      return { repository: 'o/r', headSha: HEAD, status: 'completed', conclusion: 'success', workflow: 'Verify CI' };
    },
    verifyGptEvidence(_r, _p, _ev, mockOpts) {
      if (opts.evidenceUnauthorized) throw new Error('evidence không thuộc reviewer principal allowlist / self-authored — không hợp lệ');
      return {
        headSha: HEAD, policyVersion: POLICY.policyVersion, authorLogin: 'gpt-account',
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
    resolveGitRoot() { return path.resolve(TEST_WORKTREE); },
    listPrComments() { return comments.map((c, i) => ({ id: 'c' + i, user: { login: 'user' }, created_at: '-', body: String(c && c.body != null ? c.body : c) })); },
    postComment(_r, _n, body) { s.mutations.push('comment'); comments.push({ id: 'c' + comments.length, user: { login: 'user' }, created_at: '-', body: String(body) }); },
    removeLabels(_r, _n, ls) { s.mutations.push('remove:' + ls.join('|')); for (const l of ls) { const i = labels.indexOf(l); if (i >= 0) labels.splice(i, 1); } },
    addLabels(_r, _n, ls) { s.mutations.push('add:' + ls.join('|')); for (const l of ls) if (!labels.includes(l)) labels.push(l); },
    appendAuditLog(_p, entry) { s.mutations.push('audit'); s.audit.push(entry); },
    readAuditEntries() { return [...s.audit]; },
    readAuditLog() { return s.audit.length ? s.audit[s.audit.length - 1] : null; },
    deleteAuditLog() { s.mutations.push('audit-delete'); s.audit = []; },
    log() {},
  };
  return { io, s };
}

async function expectThrow(name, fn, needle) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  results.push({ name, ok: threw && (!needle || String(threw.message).includes(needle)) });
  return threw;
}

function lastApprovalMarker(comments) {
  const parsed = parseApprovalMarkers(comments.map((c, i) => ({ id: 'c' + i, user: { login: 'user' }, created_at: '-', body: String(c && c.body != null ? c.body : c) })));
  return parsed.length ? parsed[parsed.length - 1].marker : null;
}

// Sanctioned failure (GPT-REV-138) vẫn ghi FAIL audit (có trusted destination) — đó là bản ghi từ
// chối, KHÔNG phải approval. Invariant "không approval" = không marker, không label approval,
// không audit PASS. FAIL audit được phép.
function assertRejected(io, s) {
  const mk = lastApprovalMarker(io.listPrComments());
  const noApproveMarker = !mk;
  const noApproveLabels = !s.mutations.some((m) => String(m) === 'comment' || String(m).startsWith('add:'));
  const noPassAudit = !s.audit.some((a) => a && a.result === 'PASS');
  return noApproveMarker && noApproveLabels && noPassAudit;
}

const MANUAL_OPTS = {
  repo: 'o/r', pr: 7, reason: 'PRE_REVIEW_DIFF_LIMIT', ciRunId: '42',
  gptEvidence: GPT_EVIDENCE, operatorAckPath: TEST_ACK_PATH, policyDigest: POLICY_DIGEST,
  decisionId: 'manual-dec-001', worktreeRoot: TEST_WORKTREE, auditLogPath: TEST_AUDIT_PATH,
};

(async () => {
try {
  // --- H1. Hai commit hoàn toàn khác nhau (non-circular structural invariant) ---
  tru('H1: policySourceCommit != targetPrHead', POLICY_SOURCE_COMMIT !== TARGET_PR_HEAD);
  tru('H1: manualException target head == targetPrHead', POLICY.manualException.target.headSha === TARGET_PR_HEAD);

  // --- H2-H6. Gate thật: App evidence hợp lệ được chấp nhận, non-circular ---
  {
    const { io, s } = makeIo();
    const r = await performManualApproval(io, { ...MANUAL_OPTS });
    tru('H2: mutated (valid App evidence accepted)', r.mutated);
    const mk = lastApprovalMarker(io.listPrComments());
    eq('H3: marker policySource.sourceCommit', mk && mk.policySource.sourceCommit, POLICY_SOURCE_COMMIT);
    eq('H4: marker headSha == targetPrHead', mk && mk.headSha, TARGET_PR_HEAD);
    tru('H5: NON-CIRCULAR — policy source commit != target PR head', mk && mk.policySource.sourceCommit !== mk.headSha);
    tru('H6: activation target binds exact targetPrHead', POLICY.manualException.target.headSha === mk.headSha);
    tru('H2: marker auditWritten', mk && mk.auditWritten === true);
    tru('H2: audit PASS', s.audit.length === 1 && s.audit[0].result === 'PASS');
  }

  // --- N1. stale target HEAD (invocation head != target.headSha) → KHÔNG approval ---
  {
    const { io, s } = makeIo({ headSha: 'b'.repeat(40) });
    await expectThrow('N1: stale target HEAD', async () => performManualApproval(io, { ...MANUAL_OPTS }), 'MANUAL_TARGET_HEAD_MISMATCH');
    tru('N1: khong approval', assertRejected(io, s));
  }
  // --- N2. changed policy digest → KHÔNG approval ---
  {
    const { io, s } = makeIo();
    await expectThrow('N2: changed policy digest', async () => performManualApproval(io, { ...MANUAL_OPTS, policyDigest: 'f'.repeat(64) }), 'POLICY_DIGEST_MISMATCH');
    tru('N2: khong approval', assertRejected(io, s));
  }
  // --- N3. changed policy source (canonical tip drift giữa resolution & mutation) → KHÔNG approval ---
  {
    const { io, s } = makeIo({ driftTip: 'a'.repeat(40) });
    await expectThrow('N3: changed policy source', async () => performManualApproval(io, { ...MANUAL_OPTS }), 'CANONICAL_SOURCE_DRIFT');
    tru('N3: khong approval', assertRejected(io, s));
  }
  // --- N4. expired activation window → KHÔNG approval ---
  // activatedAt/expiresAt đều trong QUÁ KHỨ (expiresAt > activatedAt, ttl=0 bỏ qua TTL) → now sau
  // expiresAt → MANUAL_TARGET_EXPIRED.
  {
    const exp = { ...POLICY, manualException: { ...POLICY.manualException, target: { ...POLICY.manualException.target, activatedAt: '2025-01-01T00:00:00Z', expiresAt: '2025-06-01T00:00:00Z' } } };
    const { io, s } = makeIo({ policyOverride: exp });
    await expectThrow('N4: expired window', async () => performManualApproval(io, { ...MANUAL_OPTS, policyDigest: computePolicyDigest(exp) }), 'MANUAL_TARGET_EXPIRED');
    tru('N4: khong approval', assertRejected(io, s));
  }
  // --- N5. unauthorized/self-authored evidence → KHÔNG approval ---
  {
    const { io, s } = makeIo({ evidenceUnauthorized: true });
    await expectThrow('N5: unauthorized evidence', async () => performManualApproval(io, { ...MANUAL_OPTS }), 'GPT_EVIDENCE');
    tru('N5: khong approval', assertRejected(io, s));
  }
  // --- N6. replay tới PR khác (prNumber != target.prNumber) → KHÔNG approval ---
  {
    const { io, s } = makeIo();
    await expectThrow('N6: replay to another PR', async () => performManualApproval(io, { ...MANUAL_OPTS, pr: 8 }), 'MANUAL_TARGET_PR_MISMATCH');
    tru('N6: khong approval', assertRejected(io, s));
  }

  const failed = results.filter((r) => !r.ok);
  const terse = [];
  for (const k of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6']) {
    const g = results.filter((r) => r.name.startsWith(k + ':'));
    if (g.length && g.every((r) => r.ok)) terse.push(k);
  }
  console.log('GPT-REV-139 non-circular activation PASS:', terse.join(', '));
  if (failed.length) {
    console.error('FAIL (' + failed.length + '/' + results.length + '):');
    for (const f of failed) console.error(' - ' + f.name + ' expected=' + JSON.stringify(f.want) + ' got=' + JSON.stringify(f.got));
    cleanup();
    process.exit(1);
  }
  console.log('ALL ' + results.length + ' assertions PASS');
  cleanup();
  process.exit(0);
} catch (e) {
  cleanup();
  console.error('UNEXPECTED: ' + String((e && e.stack) || e));
  process.exit(1);
}
})();
