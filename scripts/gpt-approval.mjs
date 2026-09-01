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
          '{repository: .repository.full_name, headSha: .head_sha, status: .status, conclusion: .conclusion, workflow: .name, workflowId: (.workflow_id // 0)}']);
      } catch (e) {
        // 404 hoặc lỗi khác → coi như không tìm thấy CI run (fail-closed ở caller).
        return null;
      }
      const parsed = JSON.parse(out);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        repository: String(parsed.repository || ''),
        headSha: String(parsed.headSha || ''),
        status: String(parsed.status || ''),
        conclusion: String(parsed.conclusion || ''),
        workflow: String(parsed.workflow || ''),
        workflowId: Number(parsed.workflowId || 0),
      };
    },
    // [GPT-REV-128] Authoritative pre-review/gate/finding/dependency state tại exact HEAD.
    // Không tin caller tự khai báo "chỉ có diff-limit": derive từ PR comments + labels thật.
    // Trả { blockingStatusLabels, preReviewVerdict, openBlockingFindings, dependencyBlocks, failedGates }.
    getGateState(repo, pr, headSha) {
      const view = this.getPrView(repo, pr);
      const names = labelNames(view);
      const blockingStatusLabels = names.filter((l) =>
        l === LABELS.blocked || l === LABELS.changesRequested || l === LABELS.queued || l === LABELS.inProgress);
      const comments = this.listPrComments(repo, pr);
      const hs = String(headSha || '').toLowerCase();
      let preReviewVerdict = null;
      let findingsCount = 0;
      let dependencyBlocks = 0;
      let failedGates = [];
      for (const c of comments) {
        const body = c && typeof c === 'object' && c.body != null ? String(c.body) : String(c || '');
        if (body.includes(`pre-review=PRE_REVIEW_PASS:${hs}`)) preReviewVerdict = 'PRE_REVIEW_PASS';
        if (body.includes(`pre-review=PRE_REVIEW_FINDINGS:${hs}`)) {
          preReviewVerdict = 'PRE_REVIEW_FINDINGS';
          findingsCount = (body.match(/####\s*\[LOCAL-REV-\d+\]/g) || []).length;
        }
        const depMatches = body.match(/dependency-block[:=][^\s]+/g) || [];
        dependencyBlocks += depMatches.length;
        const gateMatches = body.match(/failed-gate[:=]([A-Z_]+)/g) || [];
        failedGates = failedGates.concat(gateMatches.map((m) => m.replace(/failed-gate[:=]/, '')));
      }
      return {
        blockingStatusLabels,
        preReviewVerdict,
        openBlockingFindings: findingsCount,
        dependencyBlocks,
        failedGates,
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
      // [GPT-REV-129] worktreeRoot BẮT BUỘC (không còn optional): thiếu → fail-closed.
      if (!worktreeRoot) throw new Error('worktreeRoot bắt buộc cho containment check — không tin path rời rạc (GPT-REV-129)');
      const absPath = path.resolve(String(ackPath));
      const wt = path.resolve(String(worktreeRoot));
      const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
      const realWt = real(wt);
      const rel = path.relative(realWt, real(absPath));
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        throw new Error('operator ack file "' + absPath + '" nằm trong worktree (' + wt + ') — fail-closed');
      }
      const mbPath = path.join(realWt, 'memory-bank');
      const relMb = path.relative(mbPath, real(absPath));
      if (!relMb.startsWith('..') && !path.isAbsolute(relMb)) {
        throw new Error('operator ack file "' + absPath + '" nằm trong memory-bank — fail-closed');
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
    // [GPT-REV-129] Audit path phải đến từ policy manualException.auditLogPath/auditLogRoot
    // (không tin caller tự đặt path rời rạc); containment: dưới auditLogRoot, ngoài worktree,
    // ngoài memory-bank. [GPT-REV-130] Ghi audit TRƯỚC khi đăng marker (marker không bao giờ
    // tồn tại mà thiếu audit — orphan không xảy ra).
    appendAuditLog(logPath, entry) {
      if (!logPath) throw new Error('auditLogPath bắt buộc');
      const absPath = path.resolve(String(logPath));
      const dir = path.dirname(absPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(absPath, JSON.stringify(entry) + '\n', 'utf8');
    },
    // [GPT-REV-130] Read audit state: trả entry JSONL cuối cùng của audit log hoặc null.
    readAuditLog(logPath) {
      if (!logPath || !existsSync(String(logPath))) return null;
      const lines = String(readFileSync(String(logPath), 'utf8')).split(/\r?\n/).filter(Boolean);
      if (!lines.length) return null;
      try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
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
    throw new Error('TỪ CHỐI: PR ' + repo + '#' + pr + ' state=' + view.state + ' — chỉ PR open được mutation.');
  }
  let policy;
  try {
    policy = io.getPolicy(repo, headSha);
  } catch (e) {
    throw new Error('TỪ CHỐI (CI_UNKNOWN): không đọc được policy tại HEAD — ' + String((e && e.message) || e).slice(0, 160));
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
    throw new Error('TỪ CHỐI: actor "' + actor + '" không thuộc gptApprovalCommentAuthors — không được relay approval.');
  }
  const allowedReasons = Array.isArray(manualPolicy.allowedReason) ? manualPolicy.allowedReason.map(String) : [];
  if (!allowedReasons.includes(String(reason || ''))) {
    throw new Error('TỪ CHỐI: reason "' + reason + '" không thuộc [' + allowedReasons.join(', ') + '] — manual path chỉ waive reason được phép.');
  }
  if (String(decisionId || '').trim() === '' || /\s/.test(String(decisionId || ''))) {
    throw new Error('TỪ CHỐI: decisionId bắt buộc, không chứa khoảng trắng.');
  }
  if (!/^[0-9a-f]{40}$/i.test(String(headSha || ''))) {
    throw new Error('TỪ CHỐI: headSha "' + headSha + '" không phải full 40-hex.');
  }
  // [GPT-REV-129] worktreeRoot BẮT BUỘC: không thể containment check nếu thiếu.
  if (!worktreeRoot) {
    throw new Error('TỪ CHỐI (WORKTREE_ROOT): worktreeRoot bắt buộc — không thể kiểm tra containment (GPT-REV-129).');
  }

  // --- 2. Verify CI run qua GitHub API (khong tin client-side) ---
  // [GPT-REV-131] Bat buoc: status==='completed', conclusion==='success',
  // workflow thuoc policy manualException.approvedCiWorkflows (approved workflow identity).
  let ciRun;
  try {
    ciRun = io.getCiRun(repo, ciRunId);
  } catch (e) {
    throw new Error('TỪ CHỐI (CI_NOT_FOUND): không đọc được CI run ' + ciRunId + ' — ' + String((e && e.message) || e).slice(0, 160));
  }
  if (ciRun && ciRun.repository && String(ciRun.repository) !== String(repo)) {
    throw new Error('TỪ CHỐI (CI_REPO_MISMATCH): CI run thuộc repo "' + ciRun.repository + '" không khớp "' + repo + '".');
  }
  if (ciRun && String(ciRun.headSha || '').toLowerCase() !== String(headSha).toLowerCase()) {
    throw new Error('TỪ CHỐI (CI_HEAD_MISMATCH): CI head_sha "' + ciRun.headSha + '" không khớp PR head "' + headSha + '".');
  }
  if (!ciRun || String(ciRun.status || '') !== 'completed') {
    throw new Error('TỪ CHỐI (CI_NOT_COMPLETED): CI run ' + ciRunId + ' status="' + (ciRun && ciRun.status) + '" — yêu cầu completed (GPT-REV-131).');
  }
  if (!ciRun || String(ciRun.conclusion || '') !== 'success') {
    throw new Error('TỪ CHỐI (CI_FAIL): CI run ' + ciRunId + ' conclusion="' + (ciRun && ciRun.conclusion) + '" — yêu cầu success.');
  }
  const approvedWorkflows = Array.isArray(manualPolicy.approvedCiWorkflows) ? manualPolicy.approvedCiWorkflows.map(String) : [];
  if (approvedWorkflows.length > 0 && !approvedWorkflows.includes(String(ciRun.workflow || ''))) {
    throw new Error('TỪ CHỐI (CI_WORKFLOW_NOT_APPROVED): workflow "' + ciRun.workflow + '" không thuộc [' + approvedWorkflows.join(', ') + '] (GPT-REV-131).');
  }

  // --- 3. Verify GPT evidence (canonical artifact, không self-authored) ---
  let verifiedGptEvidence;
  try {
    verifiedGptEvidence = io.verifyGptEvidence(repo, pr, gptEvidence, { gptApprovers, headSha, policyVersion: policy.policyVersion, actorSelf: actor });
  } catch (e) {
    throw new Error('TỪ CHỐI (GPT_EVIDENCE): ' + String((e && e.message) || e).slice(0, 200));
  }

  // --- 4. Verify operator ack (file ngoài worktree + ngoài memory-bank) ---
  // [GPT-REV-129] worktreeRoot bắt buộc (đã check bước 1); containment realpath.
  let verifiedOperatorAck;
  try {
    verifiedOperatorAck = io.readOperatorAck(operatorAckPath, { worktreeRoot });
  } catch (e) {
    throw new Error('TỪ CHỐI (OPERATOR_ACK): ' + String((e && e.message) || e).slice(0, 200));
  }

  // --- 5. [GPT-REV-128] Authoritative gate state tại exact HEAD ---
  // Chứng minh PRE_REVIEW_DIFF_LIMIT là blocker DUY NHẤT: pre-review verdict phải là
  // PRE_REVIEW_FINDINGS với đúng 1 finding blocking (diff-limit); không có blocking status,
  // dependency block, hay failed gate khác. openBlockingFindings DERIVE từ gate state
  // (không synthesize 0).
  let gate;
  try {
    gate = io.getGateState(repo, pr, headSha);
  } catch (e) {
    throw new Error('TỪ CHỐI (GATE_STATE): ' + String((e && e.message) || e).slice(0, 200));
  }
  const blockingStatusLabels = Array.isArray(gate.blockingStatusLabels) ? gate.blockingStatusLabels : [];
  if (blockingStatusLabels.length) {
    throw new Error('TỪ CHỐI (STATUS_BLOCKED): PR đang ở trạng thái blocking [' + blockingStatusLabels.join(', ') + '] — không được waive (GPT-REV-128).');
  }
  if (String(gate.preReviewVerdict || '') !== 'PRE_REVIEW_FINDINGS') {
    throw new Error('TỪ CHỐI (NO_DIFF_LIMIT_FINDING): pre-review verdict="' + gate.preReviewVerdict + '" — cần PRE_REVIEW_FINDINGS tại HEAD (GPT-REV-128).');
  }
  if (Number(gate.openBlockingFindings || 0) !== 1) {
    throw new Error('TỪ CHỐI (BLOCKER_COUNT): openBlockingFindings=' + gate.openBlockingFindings + ' — cần đúng 1 blocker (diff-limit) (GPT-REV-128).');
  }
  if (Number(gate.dependencyBlocks || 0) > 0) {
    throw new Error('TỪ CHỐI (DEPENDENCY_BLOCK): có ' + gate.dependencyBlocks + ' dependency block — không được waive (GPT-REV-128).');
  }
  const otherGates = (Array.isArray(gate.failedGates) ? gate.failedGates : []).filter((g) => g !== 'PRE_REVIEW_DIFF_LIMIT');
  if (otherGates.length) {
    throw new Error('TỪ CHỐI (OTHER_GATE_FAIL): failed gates khác diff-limit: [' + otherGates.join(', ') + '] (GPT-REV-128).');
  }
  // Derive: 1 blocker (diff-limit) được waive → còn 0. Không synthesize.
  const openBlockingFindings = Math.max(0, Number(gate.openBlockingFindings || 0) - 1);

  // --- 6. [GPT-REV-129] Audit path từ policy (không tin caller path rời rạc) ---
  const policyAuditPath = manualPolicy.auditLogPath ? String(manualPolicy.auditLogPath) : '';
  const auditRoot = manualPolicy.auditLogRoot ? String(manualPolicy.auditLogRoot) : '';
  if (!policyAuditPath || !auditRoot) {
    throw new Error('TỪ CHỐI (AUDIT_POLICY): policy manualException.auditLogPath/auditLogRoot bắt buộc (GPT-REV-129).');
  }
  const expandHome = (p) => (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(2)) : p;
  const resolvedAuditPath = path.resolve(expandHome(policyAuditPath));
  const resolvedAuditRoot = path.resolve(expandHome(auditRoot));
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  // CLI override nếu có PHẢI khớp policy path (strict compare realpath).
  if (auditLogPath && path.resolve(String(auditLogPath)) !== resolvedAuditPath) {
    throw new Error('TỪ CHỐI (AUDIT_PATH_MISMATCH): --audit-log-path "' + auditLogPath + '" khác policy path "' + resolvedAuditPath + '" (GPT-REV-129).');
  }
  const relRoot = path.relative(real(resolvedAuditRoot), real(resolvedAuditPath));
  if (relRoot.startsWith('..') || path.isAbsolute(relRoot)) {
    throw new Error('TỪ CHỐI (AUDIT_OUTSIDE_ROOT): audit path "' + resolvedAuditPath + '" ngoài auditLogRoot "' + resolvedAuditRoot + '" (GPT-REV-129).');
  }
  const wtReal = real(path.resolve(String(worktreeRoot)));
  const relWt = path.relative(wtReal, real(resolvedAuditPath));
  if (!relWt.startsWith('..') && !path.isAbsolute(relWt)) {
    throw new Error('TỪ CHỐI (AUDIT_IN_WORKTREE): audit path "' + resolvedAuditPath + '" nằm trong worktree (GPT-REV-129).');
  }
  const relMb = path.relative(path.join(wtReal, 'memory-bank'), real(resolvedAuditPath));
  if (!relMb.startsWith('..') && !path.isAbsolute(relMb)) {
    throw new Error('TỪ CHỐI (AUDIT_IN_MEMORY_BANK): audit path "' + resolvedAuditPath + '" nằm trong memory-bank (GPT-REV-129).');
  }

  // --- 7. Compute policy digest + build manual ctx ---
  let expectedPolicyDigest;
  try {
    expectedPolicyDigest = computePolicyDigest(policy);
  } catch (e) {
    throw new Error('TỪ CHỐI (POLICY_DIGEST): ' + String((e && e.message) || e).slice(0, 120));
  }
  if (String(policyDigest || '').toLowerCase() !== String(expectedPolicyDigest).toLowerCase()) {
    throw new Error('TỪ CHỐI (POLICY_DIGEST_MISMATCH): policyDigest="' + policyDigest + '" != computed "' + expectedPolicyDigest + '" — policy đã đổi, không approve.');
  }

  const manualCtx = {
    manualExceptionPolicy: manualPolicy, gptApprovers, actorSelf: actor,
    verifiedCiRun: ciRun, verifiedGptEvidence, verifiedOperatorAck,
    expectedPolicyDigest: String(expectedPolicyDigest).toLowerCase(),
  };

  // --- 8. Re-read exact state TRƯỚC mutation (drift check) ---
  const view2 = io.getPrView(repo, pr);
  if (String(view2.headRefOid || '').toLowerCase() !== String(headSha).toLowerCase()) {
    throw new Error('TỪ CHỐI (HEAD_DRIFT): PR HEAD đổi giữa validation và mutation (' + headSha.slice(0, 12) + ' → ' + String(view2.headRefOid || '').slice(0, 12) + ') — fail-closed.');
  }
  if (!canMutatePr(view2.state)) {
    throw new Error('TỪ CHỐI: PR state đổi thành ' + view2.state + ' — không mutation.');
  }

  // --- 9. [GPT-REV-130] Audit TRƯỚC marker (transaction state) + idempotency/repair ---
  // Giao dịch: audit PASS phải tồn tại TRƯỚC khi marker được coi là hoàn chỉnh.
  // Ghi audit trước → nếu audit fail, chưa có marker nào (không orphan). Retry: marker có
  // sẵn + audit PASS → duplicate; marker có sẵn nhưng audit thiếu → repair (ghi audit) rồi
  // tiếp tục labels. effectiveApproval yêu cầu auditVerified + auditWritten (contract đã thêm).
  const auditEntry = {
    timestamp: new Date().toISOString(), repository: repo, prNumber: pr, headSha, reason, ciRunId,
    gptEvidence: String(gptEvidence && gptEvidence.url || ''), operatorAckPath,
    policyVersion: policy.policyVersion, policyDigest: String(expectedPolicyDigest),
    decisionId, result: 'PASS', failureReason: null,
  };
  const lastAudit = io.readAuditLog ? io.readAuditLog(resolvedAuditPath) : null;
  const auditPassed = lastAudit && String(lastAudit.decisionId || '') === String(decisionId) && lastAudit.result === 'PASS';
  if (!auditPassed) {
    try {
      io.appendAuditLog(resolvedAuditPath, auditEntry);
    } catch (e) {
      throw new Error('TỪ CHỐI (AUDIT_FAIL): ' + String((e && e.message) || e).slice(0, 160) + ' — chưa có marker (ghi audit trước marker).');
    }
  }

  // Existing marker + audit đủ → duplicate (idempotent, không ghi trùng).
  const existing = parseApprovalMarkers(io.listPrComments(repo, pr)).filter((r) =>
    r.authorLogin && gptApprovers.includes(String(r.authorLogin))
      && isApprovalValid({ ...r.marker, commentId: r.commentId, authorLogin: r.authorLogin },
        { ...manualCtx, auditVerified: true, headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion }).valid);
  if (existing.length) {
    // [GPT-REV-130] Repair/resume: marker + audit PASS da du nhung labels chua approved
    // (truoc do labels fail giua chung) → apply labels de kha phuc, khong bo qua im lang.
    const currentNames = labelNames(io.getPrView(repo, pr));
    if (!currentNames.includes(LABELS.approved)) {
      io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.approved));
      io.addLabels(repo, pr, [LABELS.approved]);
      const finalNames = labelNames(io.getPrView(repo, pr));
      if (!finalNames.includes(LABELS.approved)) {
        throw new Error('RESUME_FAIL: marker + audit PASS ton tai nhung khong gan duoc status:approved — can nguoi dung kiem tra.');
      }
      return { mutated: true, skipped: null, headSha, message: 'RESUME: marker + audit PASS da ton tai, da kha phuc status:approved.' };
    }
    return { mutated: false, skipped: 'duplicate', headSha, message: 'BO QUA: manual approval cho HEAD ' + headSha.slice(0, 12) + ' da ton tai (' + existing.length + ' marker + audit PASS) — idempotent, khong ghi trung.' };
  }

  // --- 10. Mutation order (GPT-REV-033 + GPT-REV-130): audit đã ghi → marker comment ---
  const probeMarker = {
    repository: repo, prNumber: pr, reviewer: AGENTS.gpt, headSha,
    policyVersion: policy.policyVersion, policyDigest: String(expectedPolicyDigest).toLowerCase(),
    decisionId, kind: 'MANUAL_REVIEW_EXCEPTION_APPROVED', reason: String(reason),
    ciRunId: String(ciRunId), gptEvidence: { ...gptEvidence, authorLogin: verifiedGptEvidence ? verifiedGptEvidence.authorLogin : '' },
    operatorAck: verifiedOperatorAck ? { source: 'local-state', ackPath: operatorAckPath, operator: verifiedOperatorAck.operator, reason: String(reason), ackAt: verifiedOperatorAck.ackAt, issueRef: verifiedOperatorAck.issueRef } : null,
    openBlockingFindings, reviewedAt: new Date().toISOString(),
    auditWritten: true, auditRef: String(decisionId),
  };
  const preVerdict = isManualApprovalValid({ ...probeMarker, commentId: 'probe', authorLogin: actor }, { ...manualCtx, auditVerified: true });
  if (!preVerdict.valid) {
    throw new Error('TỪ CHỐI (MANUAL_VALIDATION): ' + preVerdict.reason);
  }
  const marker = buildApprovalMarker(probeMarker);
  const body = [
    '## ✅ APPROVAL CUỐI — GPT (manual exception, PRE_REVIEW_DIFF_LIMIT)',
    note ? '\n> ' + note : '',
    '',
    'Reason: \`' + reason + '\`. CI run \`' + ciRunId + '\` SUCCESS tại HEAD \`' + headSha + '\`.',
    'Policy: \`' + policy.policyVersion + '\` (digest \`' + String(expectedPolicyDigest).slice(0, 12) + '…\`).',
    'Audit: PASS tại \`' + resolvedAuditPath + '\`.',
    'Lưu ý: path này chỉ waive \`PRE_REVIEW_DIFF_LIMIT\`; mọi blocker/finding/dependency khác vẫn fail-closed.',
    'Merge/deploy vẫn do người dùng thực hiện.',
    '', marker,
  ].join('\n');
  io.postComment(repo, pr, body);

  const afterComments = io.listPrComments(repo, pr);
  const recorded = effectiveApproval(afterComments, { ...manualCtx, auditVerified: true, headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion });
  if (!recorded || String(recorded.decisionId || '') !== String(decisionId)) {
    throw new Error('read-back FAIL: manual approval marker chưa ghi nhận được tại HEAD — giữ nguyên nhãn, KHÔNG gắn status:approved.');
  }

  // --- 11. Labels SAU (approved chỉ khi marker + audit đều thành công) ---
  try {
    io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.approved));
    io.addLabels(repo, pr, [LABELS.approved]);
    const finalNames = labelNames(io.getPrView(repo, pr));
    if (!finalNames.includes(LABELS.approved)) throw new Error('read-after-write FAIL: thiếu ' + LABELS.approved);
    const statuses = finalNames.filter((l) => l.startsWith('status:'));
    if (statuses.length !== 1) throw new Error('read-after-write FAIL: PR có ' + statuses.length + ' status:* (' + statuses.join(', ') + ')');
  } catch (e) {
    await ensureNotApproved(io, repo, pr, e instanceof Error ? e : new Error(String(e)));
  }

  return {
    mutated: true, skipped: null, headSha,
    message: 'ĐÃ GHI manual approval ' + AGENTS.gpt + ' cho ' + repo + '#' + pr + ' tại HEAD ' + headSha.slice(0, 12) + ' (reason ' + reason + ', policy ' + policy.policyVersion + ', decision ' + decisionId + ') — status:approved.',
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
    && out.policyDigest && out.decisionId && out.worktreeRoot;
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
      '    --policy-digest <sha256hex> --decision-id id-khong-trang --worktree-root <git worktree root> \\',
      '    [--audit-log-path <path> (bắt buộc khớp policy manualException.auditLogPath)] [--note "..."]',
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

