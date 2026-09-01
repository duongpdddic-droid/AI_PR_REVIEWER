#!/usr/bin/env node
// gpt-approval.mjs — Cổng DUY NHẤT ghi nhận approval cuối của GPT lên PR (Issue #2 A3).
//
// USER-RELAY GATE (GPT-REV-032): script KHÔNG tự xác minh danh tính GPT — nó chỉ ghi nhận
// quyết định do NGƯỜI DÙNG relay qua lệnh này. Bắt buộc approval payload ràng buộc tuyệt đối:
// repository + prNumber + FULL HEAD SHA + policyVersion + decision ID.
// Thiếu/sai bất kỳ trường nào → từ chối, KHÔNG mutation. Không có code path tự động nào
// (orchestrator/pre-review) gọi gate này — chỉ người dùng chạy trực tiếp.
//
// THỨ TỰ MUTATION AN TOÀN (GPT-REV-033):
//   1. Kiểm tra toàn bộ preconditions (PR open, CI PASS, PRE_REVIEW_PASS tại HEAD, idempotent).
//   2. Xác thực payload khớp trạng thái thực tế của PR.
//   3. Đăng approval marker (khóa full HEAD SHA + policyVersion + decision ID) TRƯỚC.
//   4. Read-back comment xác nhận marker hợp lệ tại đúng HEAD.
//   5. SAU ĐÓ mới gỡ nhãn khác / gắn status:approved; mọi lệnh đều kiểm tra lỗi;
//      hỏng ở bước nào → phục hồi đảm bảo PR không bao giờ kết thúc ở approved thiếu marker.
//
// Usage:
//   node scripts/gpt-approval.mjs --repo owner/name --pr 12 \
//     --payload '{"repository":"owner/name","prNumber":12,"headSha":"<full40hex>","policyVersion":"2026-08-23.1","decisionId":"gpt-dec-001"}' \
//     [--note "trích quyết định GPT"]
//   node scripts/gpt-approval.mjs --repo owner/name --pr 12 --revoke "lý do"

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  AGENTS, LABELS, REVIEWER_LOCAL,
  buildApprovalMarker, canMutatePr, effectiveApproval, evaluateChecks,
  isApprovalValid, isManualApprovalValid, parseApprovalMarkers,
  validateApprovalPayload, computePolicyDigest,
} from './review-contract.mjs';
import { resolvePolicyForRepo } from './effective-policy.mjs';

// ---------------------------------------------------------------- IO adapter (DI cho test)

export function defaultIo() {
  function gh(args, { input } = {}) {
    const res = spawnSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...(input !== undefined ? { input: String(input) } : {}),
    });
    if (res.error || res.status !== 0) {
      throw new Error(`gh ${args.join(' ')} FAIL: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
    }
    return res.stdout;
  }
  return {
    getPrView(repo, number) {
      return JSON.parse(gh(['pr', 'view', String(number), '--repo', repo, '--json', 'state,headRefOid,labels']));
    },
    getPolicy(repo, ref) {
      // [GPT-REV-042] Không còn legacy mirror: fail-closed qua resolvePolicyForRepo (throw).
      return resolvePolicyForRepo({
        repo,
        ref,
        fetchContent: (r, p, rr) => {
          const b64 = gh(['api', `repos/${r}/contents/${p}?ref=${encodeURIComponent(rr)}`, '--jq', '.content']);
          return Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8');
        },
      }).policy;
    },
    getChecks(repo, number) {
      return JSON.parse(gh(['pr', 'checks', String(number), '--repo', repo, '--json', 'name,state']));
    },
    listPrComments(repo, number) {
      // [CLINE-FIX-051] Trả comment RICH {id, user:{login}, created_at, body} — bản legacy
      // ([.[].body] join) làm mọi marker thiếu provenance → read-back approval luôn FAIL.
      const out = gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate',
        '--jq', `[.[] | ((.id // "") | tostring) + " " + ((.user.login) // "") + " " + ((.created_at) // "-") + " " + ((.body // "") | @base64)] | join("\\n")`]);
      return String(out || '').split('\n').filter(Boolean).map((line) => {
        const parts = line.split(' ');
        return {
          id: parts[0],
          user: { login: parts[1] },
          created_at: parts[2],
          body: Buffer.from(parts.slice(3).join(' '), 'base64').toString('utf8'),
        };
      });
    },
    postComment(repo, number, body) {
      return gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], { input: body });
    },
    addLabels(repo, number, labels) {
      gh(['pr', 'edit', String(number), '--repo', repo, '--add-label', labels.join(',')]);
    },
    removeLabels(repo, number, labels) {
      for (const l of labels) gh(['pr', 'edit', String(number), '--repo', repo, '--remove-label', l]);
    },
    getCurrentUser() {
      const out = gh(['api', 'user', '--jq', '.login']);
      return String(out || '').trim();
    },
    // [Issue #36] Fetch CI run details từ GitHub Actions API.
    // Trả {repository, headSha, conclusion, workflow} hoặc null nếu không tìm thấy / JSON rỗng.
    getCiRun(repo, runId) {
      let out;
      try {
        out = gh(['api', 'repos/' + repo + '/actions/runs/' + String(runId), '--jq',
          '{repository: .repository.full_name, headSha: .head_sha, conclusion: .conclusion, workflow: .name}']);
      } catch (e) {
        // 404 hoặc lỗi khác → coi như không tìm thấy CI run (fail-closed ở caller).
        return null;
      }
      const parsed = JSON.parse(out);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        repository: String(parsed.repository || ''),
        headSha: String(parsed.headSha || ''),
        conclusion: String(parsed.conclusion || ''),
        workflow: String(parsed.workflow || ''),
      };
    },
    // [Issue #36] Verify GPT evidence: fetch comment + check author ∈ gptApprovers +
    // body tham chiếu headSha + policyVersion. Trả {headSha, policyVersion} hoặc null.
    verifyGptEvidence(repo, pr, gptEvidence, { gptApprovers, headSha, policyVersion, actorSelf }) {
      if (!gptEvidence || typeof gptEvidence !== 'object' || !gptEvidence.url || !gptEvidence.commentId) {
        throw new Error('gptEvidence phải là object {url, commentId}');
      }
      const urlRe = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)#issuecomment-(\d+)$/i;
      const um = urlRe.exec(String(gptEvidence.url));
      if (!um) throw new Error('URL không phải issuecomment URL canonical');
      const uOwner = um[1]; const uRepo = um[2]; const uNumber = um[3]; const uCommentId = um[4];
      if (uOwner + '/' + uRepo !== String(repo)) throw new Error('URL repo mismatch');
      if (Number(uNumber) !== Number(pr)) throw new Error('URL PR mismatch');
      if (uCommentId !== String(gptEvidence.commentId)) throw new Error('URL commentId mismatch');
      const comments = this.listPrComments(repo, pr);
      const match = comments.find((c) => String(c.id) === String(gptEvidence.commentId));
      if (!match) throw new Error('commentId không tồn tại trong PR comments');
      const author = String(match.user && match.user.login || '');
      if (!author) throw new Error('comment không có author login');
      if (!gptApprovers || !gptApprovers.includes(author)) {
        throw new Error('author "' + author + '" không thuộc gptApprovalCommentAuthors');
      }
      if (actorSelf && actorSelf === author) {
        throw new Error('self-authored: actor ' + actorSelf + ' là author của GPT evidence');
      }
      const bodyText = String(match.body || '');
      const bodyRef = bodyText.match(/(?:headSha|SHA|commit)[^\w]([0-9a-f]{40})/i);
      if (!bodyRef) throw new Error('GPT evidence body không tham chiếu headSha (40-hex)');
      if (String(bodyRef[1]).toLowerCase() !== String(headSha).toLowerCase()) {
        throw new Error('GPT evidence body tham chiếu headSha ' + bodyRef[1] + ' khác HEAD ' + headSha);
      }
      const bodyPol = bodyText.match(/(?:policyVersion|policy)[^\w]([\d.]+)/i);
      if (!bodyPol) throw new Error('GPT evidence body không tham chiếu policyVersion');
      if (String(bodyPol[1]) !== String(policyVersion)) {
        throw new Error('GPT evidence body tham chiếu policyVersion ' + bodyPol[1] + ' khác ' + policyVersion);
      }
      return { headSha: String(headSha).toLowerCase(), policyVersion: String(policyVersion), authorLogin: String(author) };
    },
    // [Issue #36] Read + parse operator ack file. Path phải ngoài worktree + ngoài memory-bank.
    // Trả {operator, reason, ackAt, issueRef} hoặc throw (invalid).
    readOperatorAck(ackPath, { worktreeRoot }) {
      if (!ackPath) throw new Error('operatorAckPath bắt buộc');
      const absPath = path.resolve(String(ackPath));
      if (worktreeRoot) {
        const wt = path.resolve(String(worktreeRoot));
        const rel = path.relative(wt, absPath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          throw new Error('operator ack file "' + absPath + '" nằm trong worktree (' + wt + ') — fail-closed');
        }
        const mbPath = path.join(wt, 'memory-bank');
        const relMb = path.relative(mbPath, absPath);
        if (!relMb.startsWith('..') && !path.isAbsolute(relMb)) {
          throw new Error('operator ack file "' + absPath + '" nằm trong memory-bank — fail-closed');
        }
      }
      const content = readFileSync(absPath, 'utf8');
      const lines = String(content).split(/\r?\n/);
      const out = { operator: '', reason: '', ackAt: '', issueRef: '' };
      for (const line of lines) {
        const m = line.match(/^([A-Z_]+):\s*(.+)$/);
        if (!m) continue;
        const key = m[1]; const val = m[2].trim();
        if (key === 'OPERATOR') out.operator = val;
        else if (key === 'REASON') out.reason = val;
        else if (key === 'ACK_AT') out.ackAt = val;
        else if (key === 'ISSUE_REF') out.issueRef = val;
      }
      if (!out.operator) throw new Error('operator ack file thiếu OPERATOR');
      if (!out.reason) throw new Error('operator ack file thiếu REASON');
      if (!out.ackAt) throw new Error('operator ack file thiếu ACK_AT');
      if (!out.issueRef) throw new Error('operator ack file thiếu ISSUE_REF');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(out.ackAt)) {
        throw new Error('ACK_AT không phải ISO8601: ' + out.ackAt);
      }
      return out;
    },
    // [Issue #36] Append JSONL entry vào audit log. Fail-closed: throw nếu không ghi được.
    appendAuditLog(logPath, entry) {
      if (!logPath) throw new Error('auditLogPath bắt buộc');
      const absPath = path.resolve(String(logPath));
      const dir = path.dirname(absPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(absPath, JSON.stringify(entry) + '\n', 'utf8');
    },
    log(level, msg) { console.error(`[${level}] ${msg}`); },
  };
}

// ---------------------------------------------------------------- helpers

function labelNames(view) {
  return (view.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

const OTHER_STATUSES = [
  LABELS.reviewRequested, LABELS.reviewing, LABELS.changesRequested,
  LABELS.blocked, LABELS.queued, LABELS.readyForCline, LABELS.inProgress,
];

// Phục hồi fail-closed: bảo đảm status:approved KHÔNG còn trên PR khi giao dịch lỗi.
async function ensureNotApproved(io, repo, pr, originalError) {
  let names = labelNames(io.getPrView(repo, pr));
  if (names.includes(LABELS.approved)) {
    try { io.removeLabels(repo, pr, [LABELS.approved]); } catch { /* báo lỗi gốc kèm trạng thái */ }
    names = labelNames(io.getPrView(repo, pr));
  }
  if (names.includes(LABELS.approved)) {
    throw new Error(`${originalError.message}; PHỤC HỒI THẤT BẠI: status:approved vẫn còn mà không chắc có marker — cần người dùng kiểm tra/chạy drift-repair.`);
  }
  throw new Error(`${originalError.message}; đã phục hồi: PR KHÔNG ở status:approved (marker nếu đã đăng sẽ bị drift-check vô hiệu hóa).`);
}

// ---------------------------------------------------------------- approval

export async function performApproval(io, { repo, pr, payload, note = '' }) {
  // --- Preconditions (chỉ đọc; chưa mutation gì) ---
  const view = io.getPrView(repo, pr);
  const headSha = view.headRefOid;
  if (!canMutatePr(view.state)) {
    throw new Error(`TỪ CHỐI: PR ${repo}#${pr} state=${view.state} — chỉ PR open được mutation.`);
  }

  let policy;
  try {
    policy = io.getPolicy(repo, headSha);
  } catch (e) {
    throw new Error(`TỪ CHỐI (CI_UNKNOWN): không đọc được policy tại HEAD — ${String((e && e.message) || e).slice(0, 160)}`);
  }

  const gptApprovers = policy && policy.approvalAuthorities && policy.approvalAuthorities.gptApprovalCommentAuthors;
  if (!Array.isArray(gptApprovers) || gptApprovers.length === 0) {
    throw new Error('TỪ CHỐI: policy thiếu approvalAuthorities.gptApprovalCommentAuthors — không xác định được actor được phép đăng GPT approval marker');
  }
  // [GPT-REV-049] Xác minh DANH TÍNH THẬT của actor đang đăng comment phải thuộc allowlist.
  // gh pr comment đăng dưới tư cách tài khoản gh đã xác thực; script từ chối nếu actor đó
  // không thuộc gptApprovalCommentAuthors (không một bot/third-party nào được giả GPT approval).
  const actor = io.getCurrentUser();
  if (!gptApprovers.includes(String(actor || ''))) {
    throw new Error(`TỪ CHỐI: actor "${String(actor || '(rỗng)')}" không thuộc approvalAuthorities.gptApprovalCommentAuthors — không được đăng GPT approval marker`);
  }

  let checks = null;
  try { checks = io.getChecks(repo, pr); } catch { checks = null; }
  const ciState = evaluateChecks(policy, checks);
  if (ciState !== 'pass') {
    throw new Error(`TỪ CHỐI: CI=${ciState} — approval chỉ được ghi khi CI PASS (fail-closed).`);
  }

  const bodies = io.listPrComments(repo, pr);
  const passMarker = `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headSha} -->`;
  // [GPT-REV-048] bodies có thể là rich comment object {body} hoặc legacy string.
  if (!bodies.some((b) => String(b && b.body != null ? b.body : b).includes(passMarker))) {
    throw new Error(`TỪ CHỐI: chưa có ${REVIEWER_LOCAL} PRE_REVIEW_PASS cho HEAD ${headSha.slice(0, 12)} — chạy orchestrator pre-review trước.`);
  }

  // Idempotent: approval trùng HEAD/repo/pr đã hợp lệ → không ghi lần 2.
  // [GPT-REV-048] r là kết quả parseApprovalMarkers {marker, commentId, authorLogin}; cần spread marker.
  // [GPT-REV-049] Duplicate detection: CHỈ marker do author thuộc gptApprovers mới tính là
  // approval hợp lệ. Marker giả (sai author) KHÔNG được coi là duplicate → không chặn việc
  // tạo approval hợp lệ mới, và không được nhận là approval thật.
  const existing = parseApprovalMarkers(bodies).filter((r) =>
    r.authorLogin && gptApprovers.includes(String(r.authorLogin))
      && isApprovalValid({ ...r.marker, commentId: r.commentId, authorLogin: r.authorLogin },
        { headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion, gptApprovers }).valid);
  if (existing.length) {
    return { mutated: false, skipped: 'duplicate', headSha, message: `BỎ QUA: approval ${AGENTS.gpt} cho HEAD ${headSha.slice(0, 12)} đã tồn tại (${existing.length} marker) — không ghi trùng.` };
  }

  // --- USER-RELAY PAYLOAD GATE (GPT-REV-032) — fail-closed trước mọi mutation ---
  const verdict = validateApprovalPayload(payload, {
    repository: repo, prNumber: pr, headSha, policyVersion: policy.policyVersion,
  });
  if (!verdict.ok) {
    throw new Error(`TỪ CHỐI (payload): ${verdict.error} — không mutation nào được thực hiện.`);
  }

  // --- GIAO DỊCH (GPT-REV-033): marker TRƯỚC → read-back → approved SAU ---
  const marker = buildApprovalMarker({
    repository: repo,
    prNumber: pr,
    reviewer: AGENTS.gpt,
    headSha,
    policyVersion: policy.policyVersion,
    decisionId: payload.decisionId,
    ciEvidence: { ciState, checks: ((checks && checks.checks) || []).map((c) => `${c.name}=${c.state}`) },
    openBlockingFindings: 0,
    reviewedAt: new Date().toISOString(),
  });
  const body = [
    '## ✅ APPROVAL CUỐI — GPT (quyết định relay bởi người dùng)',
    note ? `\n> ${note}` : '',
    '',
    `Decision ID: \`${payload.decisionId}\`. CI PASS + ${REVIEWER_LOCAL} PRE_REVIEW_PASS tại HEAD \`${headSha}\`.`,
    'Lưu ý: script ghi nhận quyết định do người dùng relay; tính đúng đắn của việc chuyển tiếp quyết định GPT thuộc về kênh relay con người.',
    'Merge/deploy vẫn do người dùng thực hiện.',
    '',
    marker,
  ].join('\n');

  io.postComment(repo, pr, body); // lỗi → ném ra, CHƯA mutation nhãn nào

  const afterComments = io.listPrComments(repo, pr);
  const recorded = effectiveApproval(afterComments, { headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion, gptApprovers });
  if (!recorded || String(recorded.decisionId || '') !== String(payload.decisionId)) {
    throw new Error('read-back FAIL: marker approval chưa ghi nhận được/không hợp lệ tại HEAD — giữ nguyên nhãn, KHÔNG gắn status:approved.');
  }

  try {
    io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.approved));
    io.addLabels(repo, pr, [LABELS.approved]);
    const finalNames = labelNames(io.getPrView(repo, pr));
    if (!finalNames.includes(LABELS.approved)) throw new Error(`read-after-write FAIL: thiếu ${LABELS.approved}`);
    const statuses = finalNames.filter((l) => l.startsWith('status:'));
    if (statuses.length !== 1) throw new Error(`read-after-write FAIL: PR có ${statuses.length} status:* (${statuses.join(', ')})`);
  } catch (e) {
    await ensureNotApproved(io, repo, pr, e instanceof Error ? e : new Error(String(e)));
  }

  return {
    mutated: true,
    skipped: null,
    headSha,
    message: `ĐÃ GHI approval ${AGENTS.gpt} cho ${repo}#${pr} tại HEAD ${headSha.slice(0, 12)} (policy ${policy.policyVersion}, decision ${payload.decisionId}) — status:approved.`,
  };
}

// ---------------------------------------------------------------- manual approval (Issue #36)

// [Issue #36] Sanctioned degraded path: cho phép ghi GPT approval khi pre-review fail vì
// PRE_REVIEW_DIFF_LIMIT (diff > policy.diffLimits.maxLines). KHÔNG phải alternate approval
// source — chỉ waive đúng reason đó; mọi blocker/finding/dependency khác vẫn fail-closed.
// Evidence bắt buộc (GPT amendment 2026-09-01): reason ∈ manualException.allowedReason;
// CI run verify qua io.getCiRun; GPT evidence canonical không self-authored; operator ack
// file ngoài worktree + memory-bank; policyDigest SHA-256. Mutation order (GPT-REV-033):
// validate ALL → re-read state → marker → read-back → audit log → labels SAU.
export async function performManualApproval(io, {
  repo, pr, reason, ciRunId, gptEvidence, operatorAckPath, policyDigest,
  decisionId, note = '', worktreeRoot = '', auditLogPath = '',
}) {
  // --- 1. Preconditions (chỉ đọc) ---
  const view = io.getPrView(repo, pr);
  const headSha = view.headRefOid;
  if (!canMutatePr(view.state)) {
    throw new Error(`TỪ CHỐI: PR ${repo}#${pr} state=${view.state} — chỉ PR open được mutation.`);
  }

  let policy;
  try {
    policy = io.getPolicy(repo, headSha);
  } catch (e) {
    throw new Error(`TỪ CHỐI (CI_UNKNOWN): không đọc được policy tại HEAD — ${String((e && e.message) || e).slice(0, 160)}`);
  }
  const manualPolicy = policy && policy.manualException;
  if (!manualPolicy || typeof manualPolicy !== 'object' || manualPolicy.enabled !== true) {
    throw new Error('TỪ CHỐI: policy manualException.enabled !== true — manual path chưa được bật (fail-closed).');
  }
  const gptApprovers = policy && policy.approvalAuthorities && policy.approvalAuthorities.gptApprovalCommentAuthors;
  if (!Array.isArray(gptApprovers) || gptApprovers.length === 0) {
    throw new Error('TỪ CHỐI: policy thiếu approvalAuthorities.gptApprovalCommentAuthors.');
  }
  const actor = io.getCurrentUser();
  if (!gptApprovers.includes(String(actor || ''))) {
    throw new Error(`TỪ CHỐI: actor "${actor}" không thuộc gptApprovalCommentAuthors — không được relay approval.`);
  }
  const allowedReasons = Array.isArray(manualPolicy.allowedReason) ? manualPolicy.allowedReason.map(String) : [];
  if (!allowedReasons.includes(String(reason || ''))) {
    throw new Error(`TỪ CHỐI: reason "${reason}" không thuộc [${allowedReasons.join(', ')}] — manual path chỉ waive reason được phép.`);
  }
  if (String(decisionId || '').trim() === '' || /\s/.test(String(decisionId || ''))) {
    throw new Error('TỪ CHỐI: decisionId bắt buộc, không chứa khoảng trắng.');
  }
  if (!/^[0-9a-f]{40}$/i.test(String(headSha || ''))) {
    throw new Error(`TỪ CHỐI: headSha "${headSha}" không phải full 40-hex.`);
  }

  // --- 2. Verify CI run qua GitHub API (không tin client-side) ---
  let ciRun;
  try {
    ciRun = io.getCiRun(repo, ciRunId);
  } catch (e) {
    throw new Error(`TỪ CHỐI (CI_NOT_FOUND): không đọc được CI run ${ciRunId} — ${String((e && e.message) || e).slice(0, 160)}`);
  }
  if (ciRun && ciRun.repository && String(ciRun.repository) !== String(repo)) {
    throw new Error(`TỪ CHỐI (CI_REPO_MISMATCH): CI run thuộc repo "${ciRun.repository}" không khớp "${repo}".`);
  }
  if (ciRun && String(ciRun.headSha || '').toLowerCase() !== String(headSha).toLowerCase()) {
    throw new Error(`TỪ CHỐI (CI_HEAD_MISMATCH): CI head_sha "${ciRun.headSha}" không khớp PR head "${headSha}".`);
  }
  if (!ciRun || String(ciRun.conclusion || '') !== 'success') {
    throw new Error(`TỪ CHỐI (CI_FAIL): CI run ${ciRunId} conclusion="${ciRun && ciRun.conclusion}" — yêu cầu success.`);
  }

  // --- 3. Verify GPT evidence (canonical artifact, không self-authored) ---
  let verifiedGptEvidence;
  try {
    verifiedGptEvidence = io.verifyGptEvidence(repo, pr, gptEvidence, { gptApprovers, headSha, policyVersion: policy.policyVersion, actorSelf: actor });
  } catch (e) {
    throw new Error(`TỪ CHỐI (GPT_EVIDENCE): ${String((e && e.message) || e).slice(0, 200)}`);
  }

  // --- 4. Verify operator ack (file ngoài worktree + ngoài memory-bank) ---
  let verifiedOperatorAck;
  try {
    verifiedOperatorAck = io.readOperatorAck(operatorAckPath, { worktreeRoot });
  } catch (e) {
    throw new Error(`TỪ CHỐI (OPERATOR_ACK): ${String((e && e.message) || e).slice(0, 200)}`);
  }

  // --- 5. Compute policy digest + build manual ctx ---
  let expectedPolicyDigest;
  try {
    expectedPolicyDigest = computePolicyDigest(policy);
  } catch (e) {
    throw new Error(`TỪ CHỐI (POLICY_DIGEST): ${String((e && e.message) || e).slice(0, 120)}`);
  }
  if (String(policyDigest || '').toLowerCase() !== String(expectedPolicyDigest).toLowerCase()) {
    throw new Error(`TỪ CHỐI (POLICY_DIGEST_MISMATCH): policyDigest="${policyDigest}" != computed "${expectedPolicyDigest}" — policy đã đổi, không approve.`);
  }

  const manualCtx = {
    manualExceptionPolicy: manualPolicy, gptApprovers, actorSelf: actor,
    verifiedCiRun: ciRun, verifiedGptEvidence, verifiedOperatorAck,
    expectedPolicyDigest: String(expectedPolicyDigest).toLowerCase(),
  };
  const probeMarker = {
    repository: repo, prNumber: pr, reviewer: AGENTS.gpt, headSha,
    policyVersion: policy.policyVersion, policyDigest: String(expectedPolicyDigest).toLowerCase(),
    decisionId, kind: 'MANUAL_REVIEW_EXCEPTION_APPROVED', reason: String(reason),
    ciRunId: String(ciRunId), gptEvidence: { ...gptEvidence, authorLogin: verifiedGptEvidence ? verifiedGptEvidence.authorLogin : '' },
    operatorAck: verifiedOperatorAck ? { source: 'local-state', ackPath: operatorAckPath, operator: verifiedOperatorAck.operator, reason: String(reason), ackAt: verifiedOperatorAck.ackAt, issueRef: verifiedOperatorAck.issueRef } : null,
    openBlockingFindings: 0, reviewedAt: new Date().toISOString(),
  };
  const preVerdict = isManualApprovalValid({ ...probeMarker, commentId: 'probe', authorLogin: actor }, manualCtx);
  if (!preVerdict.valid) {
    throw new Error(`TỪ CHỐI (MANUAL_VALIDATION): ${preVerdict.reason}`);
  }

  // --- 6. Re-read exact state TRƯỚC mutation (drift check, GPT amendment) ---
  const view2 = io.getPrView(repo, pr);
  if (String(view2.headRefOid || '').toLowerCase() !== String(headSha).toLowerCase()) {
    throw new Error(`TỪ CHỐI (HEAD_DRIFT): PR HEAD đổi giữa validation và mutation (${headSha.slice(0, 12)} → ${String(view2.headRefOid || '').slice(0, 12)}) — fail-closed.`);
  }
  if (!canMutatePr(view2.state)) {
    throw new Error(`TỪ CHỐI: PR state đổi thành ${view2.state} — không mutation.`);
  }
  const existing = parseApprovalMarkers(io.listPrComments(repo, pr)).filter((r) =>
    r.authorLogin && gptApprovers.includes(String(r.authorLogin))
      && isApprovalValid({ ...r.marker, commentId: r.commentId, authorLogin: r.authorLogin },
        { headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion, gptApprovers, manualExceptionPolicy: manualPolicy, verifiedCiRun: ciRun, verifiedGptEvidence, verifiedOperatorAck, expectedPolicyDigest: String(expectedPolicyDigest).toLowerCase() }).valid);
  if (existing.length) {
    return { mutated: false, skipped: 'duplicate', headSha, message: `BỎ QUA: manual approval cho HEAD ${headSha.slice(0, 12)} đã tồn tại (${existing.length} marker) — idempotent, không ghi trùng.` };
  }

  // --- 7. Mutation order (GPT-REV-033): marker comment TRƯỚC ---
  const marker = buildApprovalMarker(probeMarker);
  const body = [
    '## ✅ APPROVAL CUỐI — GPT (manual exception, PRE_REVIEW_DIFF_LIMIT)',
    note ? `\n> ${note}` : '',
    '',
    `Reason: \`${reason}\`. CI run \`${ciRunId}\` SUCCESS tại HEAD \`${headSha}\`.`,
    `Policy: \`${policy.policyVersion}\` (digest \`${String(expectedPolicyDigest).slice(0, 12)}…\`).`,
    'Lưu ý: path này chỉ waive `PRE_REVIEW_DIFF_LIMIT`; mọi blocker/finding/dependency khác vẫn fail-closed.',
    'Merge/deploy vẫn do người dùng thực hiện.',
    '', marker,
  ].join('\n');
  io.postComment(repo, pr, body);

  const afterComments = io.listPrComments(repo, pr);
  const recorded = effectiveApproval(afterComments, { headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion, gptApprovers, manualExceptionPolicy: manualPolicy, verifiedCiRun: ciRun, verifiedGptEvidence, verifiedOperatorAck, expectedPolicyDigest: String(expectedPolicyDigest).toLowerCase() });
  if (!recorded || String(recorded.decisionId || '') !== String(decisionId)) {
    throw new Error('read-back FAIL: manual approval marker chưa ghi nhận được tại HEAD — giữ nguyên nhãn, KHÔNG gắn status:approved.');
  }

  // --- 8. Audit log (ngoài worktree; lỗi ghi audit → fail-closed, chưa đổi label) ---
  if (!auditLogPath) {
    throw new Error('TỪ CHỐI (AUDIT_PATH): auditLogPath bắt buộc — không thể ghi evidence manual approval.');
  }
  try {
    io.appendAuditLog(auditLogPath, {
      timestamp: new Date().toISOString(), repository: repo, prNumber: pr, headSha, reason, ciRunId,
      gptEvidence: String(gptEvidence && gptEvidence.url || ''), operatorAckPath,
      policyVersion: policy.policyVersion, policyDigest: String(expectedPolicyDigest),
      result: 'PASS', failureReason: null,
    });
  } catch (e) {
    throw new Error(`TỪ CHỐI (AUDIT_FAIL): ${String((e && e.message) || e).slice(0, 160)} — marker đã đăng, cần drift-repair.`);
  }

  // --- 9. Labels SAU (approved chỉ khi marker + audit đều thành công) ---
  try {
    io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.approved));
    io.addLabels(repo, pr, [LABELS.approved]);
    const finalNames = labelNames(io.getPrView(repo, pr));
    if (!finalNames.includes(LABELS.approved)) throw new Error(`read-after-write FAIL: thiếu ${LABELS.approved}`);
    const statuses = finalNames.filter((l) => l.startsWith('status:'));
    if (statuses.length !== 1) throw new Error(`read-after-write FAIL: PR có ${statuses.length} status:* (${statuses.join(', ')})`);
  } catch (e) {
    await ensureNotApproved(io, repo, pr, e instanceof Error ? e : new Error(String(e)));
  }

  return {
    mutated: true, skipped: null, headSha,
    message: `ĐÃ GHI manual approval ${AGENTS.gpt} cho ${repo}#${pr} tại HEAD ${headSha.slice(0, 12)} (reason ${reason}, policy ${policy.policyVersion}, decision ${decisionId}) — status:approved.`,
  };
}
// ---------------------------------------------------------------- revoke

export async function performRevoke(io, { repo, pr, reason }) {
  const view = io.getPrView(repo, pr);
  const headSha = view.headRefOid;
  if (!canMutatePr(view.state)) {
    throw new Error(`TỪ CHỐI: PR ${repo}#${pr} state=${view.state} — chỉ PR open được mutation.`);
  }
  io.removeLabels(repo, pr, [LABELS.approved]);
  io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.reviewRequested));
  io.addLabels(repo, pr, [LABELS.reviewRequested]);
  const finalNames = labelNames(io.getPrView(repo, pr));
  if (!finalNames.includes(LABELS.reviewRequested)) throw new Error(`read-after-write FAIL: thiếu ${LABELS.reviewRequested}`);
  const statuses = finalNames.filter((l) => l.startsWith('status:'));
  if (statuses.length !== 1) throw new Error(`read-after-write FAIL: PR có ${statuses.length} status:* (${statuses.join(', ')})`);
  io.postComment(repo, pr, `🚫 Thu hồi approval: ${reason}\n\nChuyển về \`status:review-requested\`, chờ ${AGENTS.gpt} review lại.\n<!-- ai-pr-reviewer:key=${repo}::${pr}::${headSha}::revoke -->`);
  return { mutated: true, headSha, message: `ĐÃ THU HỒI approval trên ${repo}#${pr} (HEAD ${headSha.slice(0, 12)}).` };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--pr') out.pr = Number(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--payload') out.payloadRaw = argv[++i];
    else if (a === '--payload-file') out.payloadFile = argv[++i];
    else if (a === '--revoke') out.revoke = argv[++i] || 'người dùng thu hồi';
    // [Issue #36] Manual exception flags
    else if (a === '--manual-approval') out.manualApproval = true;
    else if (a === '--reason') out.reason = argv[++i];
    else if (a === '--ci-run-id') out.ciRunId = argv[++i];
    else if (a === '--gpt-evidence-url') out.gptEvidenceUrl = argv[++i];
    else if (a === '--gpt-evidence-comment-id') out.gptEvidenceCommentId = argv[++i];
    else if (a === '--operator-ack-file') out.operatorAckFile = argv[++i];
    else if (a === '--policy-digest') out.policyDigest = argv[++i];
    else if (a === '--decision-id') out.decisionId = argv[++i];
    else if (a === '--worktree-root') out.worktreeRoot = argv[++i];
    else if (a === '--audit-log-path') out.auditLogPath = argv[++i];
    else out._.push(a);
  }
  const hasNormal = out.repo && out.pr && (out.payloadRaw || out.payloadFile);
  const hasRevoke = out.repo && out.pr && out.revoke;
  const hasManual = out.manualApproval && out.repo && out.pr && out.reason && out.ciRunId
    && out.gptEvidenceUrl && out.gptEvidenceCommentId && out.operatorAckFile
    && out.policyDigest && out.decisionId && out.auditLogPath;
  if (!hasNormal && !hasRevoke && !hasManual) {
    console.error([
      'Usage:',
      '  node scripts/gpt-approval.mjs --repo owner/name --pr <number> --payload \'<json>\' [--note "..."]',
      '    json: {"repository":"owner/name","prNumber":N,"headSha":"<full40hex>","policyVersion":"...","decisionId":"id-khong-trang"}',
      '  (hoặc --payload-file <path>)',
      '  node scripts/gpt-approval.mjs --repo owner/name --pr <number> --revoke "lý do"',
      '',
      '  # Manual exception (Issue #36, reason=PRE_REVIEW_DIFF_LIMIT only):',
      '  node scripts/gpt-approval.mjs --repo owner/name --pr <number> --manual-approval \\',
      '    --reason PRE_REVIEW_DIFF_LIMIT --ci-run-id <numeric> \\',
      '    --gpt-evidence-url "https://github.com/owner/repo/issues/<pr>#issuecomment-<id>" \\',
      '    --gpt-evidence-comment-id <id> --operator-ack-file <path OUTSIDE worktree> \\',
      '    --policy-digest <sha256hex> --decision-id id-khong-trang --audit-log-path <path outside worktree>',
      '    [--worktree-root <path>] [--note "..."]',
    ].join('\n'));
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const io = defaultIo();
  if (args.revoke) {
    const r = await performRevoke(io, { repo: args.repo, pr: args.pr, reason: args.revoke });
    console.log(r.message);
    return;
  }
  if (args.manualApproval) {
    const r = await performManualApproval(io, {
      repo: args.repo,
      pr: args.pr,
      reason: args.reason,
      ciRunId: args.ciRunId,
      gptEvidence: { url: args.gptEvidenceUrl, commentId: args.gptEvidenceCommentId },
      operatorAckPath: args.operatorAckFile,
      policyDigest: args.policyDigest,
      decisionId: args.decisionId,
      note: args.note || '',
      worktreeRoot: args.worktreeRoot || '',
      auditLogPath: args.auditLogPath,
    });
    console.log(r.message);
    return;
  }
  let payload;
  try {
    payload = JSON.parse(args.payloadFile ? readFileSync(args.payloadFile, 'utf8') : args.payloadRaw);
  } catch (e) {
    console.error(`TỪ CHỐI: --payload không phải JSON hợp lệ — ${(e && e.message) || e}`);
    process.exitCode = 2;
    return;
  }
  const r = await performApproval(io, { repo: args.repo, pr: args.pr, payload, note: args.note || '' });
  console.log(r.message);
}

// Chỉ chạy CLI khi được gọi trực tiếp (import từ test không kích hoạt main).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[FATAL]', e && e.message ? e.message : e);
    process.exitCode = 1;
  });
}

