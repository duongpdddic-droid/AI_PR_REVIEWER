#!/usr/bin/env node
// unified-orchestrator.mjs — Orchestrator review theo hợp đồng Issue #2.
//
// Vòng đời mỗi PR (read-before-mutation + read-after-write + idempotency):
//   status:review-requested → phân loại CI (fail-closed) →
//     CI PASS  → status:reviewing → semantic PRE-REVIEW deterministic →
//       PRE_REVIEW_PASS     → bàn giao GPT (status:review-requested + agent:gpt)
//       PRE_REVIEW_FINDINGS → status:changes-requested + agent:cline (+ [LOCAL-REV-NNN])
//     CI pending → chờ
//     CI fail/missing/unknown → status:changes-requested + agent:cline
//
// Bất biến bắt buộc:
//   - KHÔNG BAO GIỜ tự gắn status:approved từ CI hay pre-review.
//   - AI_PR_REVIEWER local reviewer tự gắn status:approved CHỈ ở steady-state khi đủ toàn bộ
//     evaluateSteadyApprovalGates (reviewerPhases.steadyState.approvalRequiresAllGates) + read-after-write,
//     theo nguồn kích hoạt máy đọc được (activationEvidence). Transition: KHÔNG tự approve.
//   - KHÔNG tạo issue [review-fix]; mọi vòng fix đi qua nhãn trên PR.
//   - Event muộn (headSha đổi, PR closed/merged) bị bỏ qua.
//   - Mọi mutation có khóa idempotency repo::pr::sha::policy::action trong comment.
//   - Telegram chỉ báo khi mutation thành công; lỗi gửi được retry và ghi evidence.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  AGENTS, DEFAULT_BLOCKING_SEVERITIES, LABELS, REVIEWER_LOCAL,
  canMutatePr, collectActivationRecords, countReviewRounds, evaluateChecks, evaluateDiffLimits,
  evaluateSteadyApprovalGates, gateOpenFindings, isStaleEvent, mutationKey,
  normalizeStatusLabels, planEscalationForPhase,
  planApprovalDrift, planCiRouting, planPhaseActivation, planPreReviewOutcome,
  planHeadLock, resolveReviewPhase, scanDiffForSecrets,
  isUnfrozenAfter,
} from './review-contract.mjs';
import { CANONICAL_REPO, resolvePolicyForRepo } from './effective-policy.mjs';
import { notifyRaw } from './telegram-gateway/adapter-ai-pr-reviewer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function defaultIo() {
  let cfg = null;
  return {
    get config() {
      if (cfg === null) {
        try { cfg = JSON.parse(readFileSync(path.join(HERE, '..', '.agent', 'config.json'), 'utf8')); }
        catch { cfg = {}; }
      }
      return cfg;
    },
    gh(args, { input } = {}) {
      const res = spawnSync('gh', args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...(input !== undefined ? { input: String(input) } : {}),
      });
      if (res.error || res.status !== 0) {
        throw new Error(`gh ${args.join(' ')} FAIL: ${(res.stderr || res.stdout || (res.error && res.error.message) || '').slice(0, 300)}`);
      }
      return res.stdout;
    },
    listReviewPRs(repo, label) {
      return JSON.parse(this.gh(['pr', 'list', '--repo', repo, '--label', label, '--state', 'open', '--json', 'number,title,url']) || '[]');
    },
    getPrView(repo, number) {
      const v = JSON.parse(this.gh(['pr', 'view', String(number), '--repo', repo, '--json',
        'state,headRefOid,labels,number,url,title,isDraft']));
      return { ...v, labels: (v.labels || []).map((l) => l.name), comments: [] };
    },
        listPrComments(repo, number) {
      // Trả về comment RICH objects {id, user:{login}, created_at, body} để giữ metadata
      // cho approval provenance (GPT-REV-048).
      const out = this.gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate',
        '--jq', `[.[] | ((.id // "") | tostring) + " " + ((.user.login) // "") + " " + ((.created_at) // "-") + " " + ((.body // "") | @base64)] | join("\\n")`]);
      return String(out || '').split('\n').filter(Boolean).map((line) => {
        const parts = line.split(' ');
        return {
          id: parts[0] || '',
          user: { login: parts[1] || '' },
          created_at: parts[2] || '',
          body: Buffer.from(parts.slice(3).join(' '), 'base64').toString('utf8'),
        };
      });
    },
    getPolicy(repo, ref) {
      // [GPT-REV-042] Không còn legacy mirror: project repo bắt buộc project config +
      // canonical từ đúng policySource.repo+full SHA+path; canonical repo dùng nội bộ.
      try {
        return resolvePolicyForRepo({
          repo,
          ref,
          fetchContent: (r, p, rr) => {
            const b64 = this.gh(['api', `repos/${r}/contents/${p}?ref=${encodeURIComponent(rr)}`, '--jq', '.content']);
            return Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8');
          },
        });
      } catch (e) {
        const code = (e && e.code) || 'BLOCKED_CANONICAL_UNAVAILABLE';
        return { policy: null, error: `${code}: ${String((e && e.message) || e).slice(0, 200)}` };
      }
    },
    // [GPT-REV-045][GPT-REV-046] Đọc comments Issue KÈM METADATA (id/author/created_at) để
    // xác thực authority của activation marker — không còn nối body thuần. Body encode base64
    // qua jq để an toàn newline/tab khi gh trả text.
    getIssueComments(repo, number) {
      const out = this.gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate',
        '--jq', `[.[] | ((.id // "")|tostring) + " " + ((.user.login) // "") + " " + ((.created_at) // "-") + " " + ((.body // "") | @base64)] | join("\\n")`]);
      return String(out || '').split('\n').filter(Boolean).map((line) => {
        const parts = line.split(' ');
        return {
          id: parts[0] || '',
          user: { login: parts[1] || '' },
          created_at: parts[2] || '',
          body: Buffer.from(parts.slice(3).join(' '), 'base64').toString('utf8'),
        };
      });
    },
    // [GPT-REV-046] Trạng thái THẬT của một PR từ GitHub REST: merged + merge_commit_sha +
    // head sha. Ném Error khi gh fail — caller xử lý fail-closed (giữ transition), KHÔNG nuốt.
    getPullState(repo, number) {
      return JSON.parse(this.gh(['api', `repos/${repo}/pulls/${number}`,
        '--jq', '{state:(.state//""),merged:(.merged//false),mergeCommitSha:(.merge_commit_sha//""),headSha:((.head.sha)//"")}']));
    },
    getChecks(repo, number) {
      try {
        return JSON.parse(this.gh(['pr', 'checks', String(number), '--repo', repo, '--json', 'name,state']));
      } catch {
        return null; // không đọc được checks → caller phân loại CI_UNKNOWN
      }
    },
    getPrDiff(repo, number) {
      try { return this.gh(['pr', 'diff', String(number), '--repo', repo]); } catch { return null; }
    },
    addLabels(repo, number, labels) {
      this.gh(['pr', 'edit', String(number), '--repo', repo, '--add-label', labels.join(',')]);
    },
    removeLabels(repo, number, labels) {
      for (const l of labels) this.gh(['pr', 'edit', String(number), '--repo', repo, '--remove-label', l]);
    },
    postComment(repo, number, body) {
      return this.gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], { input: body });
    },
    // Issue #15: route qua gateway (single source of truth). Gateway thực sự gửi async.
    notify(title, summary) {
      try {
        const id = notifyRaw(title, summary);
        return { ok: true, attempts: 1, evidence: 'QUEUED', detail: 'gateway outbound id=' + id };
      } catch (e) {
        return { ok: false, attempts: 0, evidence: 'FAILED', detail: String((e && e.message) || e).slice(0, 200) };
      }
    },
    log(level, msg) { console.error(`[${level}] ${msg}`); },
  };
}

// ---------------------------------------------------------------- mutation an toàn

// Gắn/gỡ nhãn theo plan, kèm read-after-write verify + tự chữa trạng thái multi-status.
// Ném Error khi GitHub từ chối hoặc dữ liệu sau ghi không khớp — KHÔNG nuốt lỗi.
export function applyHandoff(io, repo, prNumber, plan) {
  if (!canMutatePr(io.getPrView(repo, prNumber).state)) {
    throw new Error(`PR #${prNumber} không còn open — chặn mutation`);
  }
  if (plan.removeLabels && plan.removeLabels.length) io.removeLabels(repo, prNumber, plan.removeLabels);
  if (plan.addLabels && plan.addLabels.length) io.addLabels(repo, prNumber, plan.addLabels);

  const after = io.getPrView(repo, prNumber); // read-after-write
  const names = after.labels || [];
  const missing = (plan.addLabels || []).filter((l) => !names.includes(l));
  if (missing.length) throw new Error(`read-after-write FAIL: thiếu ${missing.join(', ')} trên PR #${prNumber}`);
  const lingering = (plan.removeLabels || []).filter((l) => names.includes(l));
  if (lingering.length) throw new Error(`read-after-write FAIL: vẫn còn ${lingering.join(', ')} trên PR #${prNumber}`);

  // Tự chữa: mỗi PR chỉ được có đúng một status:* (Issue #2 A5).
  const norm = normalizeStatusLabels(names);
  if (norm.remove.length) {
    io.removeLabels(repo, prNumber, norm.remove);
    const recheck = normalizeStatusLabels(io.getPrView(repo, prNumber).labels);
    if (recheck.remove.length) throw new Error(`Không chuẩn hóa được status labels: ${recheck.remove.join(', ')}`);
  }
  return { ok: true };
}

// Idempotency: action đã phát hành cho đúng khóa (repo::pr::sha::policy::action) thì bỏ qua.
// [GPT-REV-048] comments có thể là rich object {body} hoặc legacy string.
export function hasMarkerFor(comments, key) {
  const needle = `<!-- ai-pr-reviewer:key=${key} -->`;
  for (const t of comments || []) {
    const body = t && typeof t === 'object' && t.body != null ? String(t.body) : String(t);
    if (body.includes(needle)) return true;
  }
  return false;
}

function markerBlock(key, extraMarker = '') {
  return `\n<!-- ai-pr-reviewer:key=${key} -->${extraMarker}`;
}

// ---------------------------------------------------------------- semantic PRE-REVIEW (deterministic)

// Chạy pre-review thuần trên diff. Verdict CHỈ là PRE_REVIEW_PASS | PRE_REVIEW_FINDINGS.
// Đây là pre-review; tuyệt đối không sinh approval hay status:approved.
export function runSemanticPreReview(policy, diffText) {
  let findings;
  let decisionGate = null;
  if (diffText === null || diffText === undefined) {
    findings = [{
      severity: 'important',
      status: 'open',
      fileSymbol: '(toàn bộ diff)',
      evidence: 'Không đọc được diff của PR',
      risk: 'Pre-review mù — không thể xác nhận an toàn',
      requiredFix: 'Kiểm tra lại PR/diff rồi yêu cầu review lại',
      acceptanceCriteria: 'Diff đọc được và pre-review chạy trọn vẹn',
    }];
  } else {
    findings = scanDiffForSecrets(diffText);
    const lim = evaluateDiffLimits(policy, diffText);
    if (lim.over) {
      // Vượt giới hạn quy mô diff là blocking + Decision Gate (GPT-REV-031):
      // KHÔNG trả Cline như lỗi code thông thường và KHÔNG handoff approval.
      decisionGate = 'diff-limit';
      findings.push({
        severity: 'critical',
        status: 'open',
        fileSymbol: `(diff ${lim.lines} dòng churn (${lim.added}+/${lim.removed}-) > giới hạn ${lim.limit})`,
        evidence: `Diff vượt diffLimits.maxLines theo metric additions-plus-deletions của policy`,
        risk: 'Review chất lượng thấp khi quy mô diff vượt ngưỡng; Decision Gate kích thước bị vô hiệu',
        requiredFix: 'Tách PR nhỏ hơn HOẶC người dùng ghi nhận ngoại lệ qua Decision Gate (status:blocked)',
        acceptanceCriteria: `Tổng dòng thêm+xóa (churn) <= ${lim.limit} hoặc có ngoại lệ người dùng`,
      });
    }
  }
  const openBlocking = gateOpenFindings(findings, (policy && policy.blockingSeverities) || DEFAULT_BLOCKING_SEVERITIES);
  const verdict = openBlocking.length ? 'PRE_REVIEW_FINDINGS' : 'PRE_REVIEW_PASS';
  return { verdict, findings, openBlocking, decisionGate };
}

function formatFindingsComment(findings, round) {
  if (!findings.length) return '';
  const lines = findings.map((f, i) => {
    const n = String(i + 1).padStart(3, '0');
    return [
      `#### [LOCAL-REV-${n}] (${f.severity}${f.status === 'resolved' ? ', đã xử lý' : ''})`,
      `- Vị trí: ${f.fileSymbol}`,
      `- Bằng chứng: ${f.evidence}`,
      `- Rủi ro: ${f.risk}`,
      `- Fix bắt buộc: ${f.requiredFix}`,
      `- Tiêu chí đạt: ${f.acceptanceCriteria}`,
    ].join('\n');
  });
  return `${lines.join('\n\n---\n\n')}\n\nVòng fix hiện tại: ${round}. Sửa xong push thẳng lên nhánh PR (KHÔNG tạo issue [review-fix]) — orchestrator sẽ tự pre-review lại.`;
}

// ---------------------------------------------------------------- activation có authority (GPT-REV-046)

// Tổng hợp bằng chứng activation steady-state từ nguồn CÓ AUTHORITY theo policy khai báo
// (reviewerPhases.steadyState.activationEvidence):
//   - comments Issue (kèm author/id) → collectActivationRecords;
//   - trạng thái thật của wiring PR (merged + merge commit SHA + head SHA) qua GitHub REST;
//   - approval markers trên wiring PR (bodies) để verify GPT approval khóa head đã merge.
// Bất kỳ lỗi IO nào (gh fail, thiếu method) → NÉM cho caller xử lý fail-closed (giữ transition).
export function resolvePhaseActivation(io, policy) {
  const ev = policy && policy.reviewerPhases && policy.reviewerPhases.phases
    && policy.reviewerPhases.phases.steadyState
    && policy.reviewerPhases.phases.steadyState.activationEvidence;
  if (!ev || ev.type !== 'issue-comment-marker' || !ev.repo || !ev.issue) {
    return { active: false, reason: 'policy thiếu khai báo activationEvidence' };
  }
  const records = collectActivationRecords(io.getIssueComments(ev.repo, ev.issue));
  let wiringState = null;
  let wiringApprovalRecords = [];
  const wp = ev.expectedWiringPr;
  if (wp && wp.repo && wp.number) {
    wiringState = io.getPullState(wp.repo, wp.number);
    // [GPT-REV-048] Giữ comment RICH objects (metadata id/author) thay vì chỉ body string.
    wiringApprovalRecords = io.getIssueComments(wp.repo, wp.number);
  }
  return planPhaseActivation({
    records,
    allowedRecorders: ev.allowedRecorders,
    expectedWiringPr: wp,
    wiringState,
    wiringApprovalRecords,
    policyVersion: policy.policyVersion,
    gptApprovers: policy.approvalAuthorities && policy.approvalAuthorities.gptApprovalCommentAuthors,
  });
}

// ---------------------------------------------------------------- vòng xử lý 1 PR

export async function processPr(io, repo, number, { dryRun } = {}) {
  const result = { repo, pr: number, skipped: null, mutated: false, notified: null, error: null };

  const view = io.getPrView(repo, number); // read-before-mutation: dữ liệu tươi
  if (!canMutatePr(view.state)) {
    result.skipped = `state=${view.state} (event muộn trên PR đóng/merge)`;
    return result;
  }
  const headSha = view.headRefOid;
  const comments = io.listPrComments(repo, number);

  // Approval-drift: approved mà thiếu approval GPT hợp lệ cho HEAD → gỡ hiệu lực.
  const policyNow = io.getPolicy(repo, headSha);
  const drift = planApprovalDrift({
    labels: view.labels, comments, headSha,
    repository: repo, prNumber: number,
    policyVersion: policyNow.policy ? policyNow.policy.policyVersion : undefined,
    localApprovers: policyNow.policy && policyNow.policy.approvalAuthorities
      ? policyNow.policy.approvalAuthorities.localApprovalCommentAuthors
      : undefined,
    gptApprovers: policyNow.policy && policyNow.policy.approvalAuthorities
      ? policyNow.policy.approvalAuthorities.gptApprovalCommentAuthors
      : undefined,
  });
  if (drift.drift) {
    const key = mutationKey({ repository: repo, prNumber: number, headSha, policyVersion: 'drift-check', action: 'invalidate-approval' });
    if (hasMarkerFor(comments, key)) { result.skipped = 'drift đã ghi nhận cho HEAD này'; return result; }
    if (!dryRun) {
      applyHandoff(io, repo, number, { addLabels: drift.addLabels, removeLabels: drift.removeLabels });
      io.postComment(repo, number, `${drift.comment}${markerBlock(key)}`);
    }
    result.mutated = true;
    if (!dryRun) {
      result.notified = io.notify('Approval-drift bị vô hiệu', `${repo}#${number} — approval cũ lệch HEAD/policy, chuyển về status:review-requested, chờ GPT review lại.`);
    }
    return result;
  }

  // HEAD-Lock Lifecycle (Issue #22): pre-review/approval/CI khóa chặt full HEAD SHA. Nếu PR
  // đang ở trạng thái duyệt/handoff (reviewing | review-requested | approved) mà HEAD đổi so
  // lock (hoặc thiếu bằng chứng khóa HEAD) → invalidate trạng thái cũ, trả về Cline chạy lại
  // CI + pre-review cho HEAD mới. KHÔNG bao giờ handoff GPT / giữ approved với HEAD drift.
  const aa = policyNow && policyNow.policy ? policyNow.policy.approvalAuthorities : null;
  const hlock = planHeadLock({
    labels: view.labels,
    comments,
    headSha,
    repository: repo,
    prNumber: number,
    policyVersion: aa && policyNow.policy ? policyNow.policy.policyVersion : undefined,
    gptApprovers: aa ? aa.gptApprovalCommentAuthors : undefined,
    localApprovers: aa ? aa.localApprovalCommentAuthors : undefined,
  });
  if (hlock.frozen && !hlock.valid) {
    const unfrozen = isUnfrozenAfter(comments, hlock.lockSha ? hlock.lockCreatedAt : '', {
      authorizedLogins: [CANONICAL_REPO.split('/')[0]],
    });
    const hkey = mutationKey({
      repository: repo, prNumber: number, headSha,
      policyVersion: hlock.lockSha && policyNow.policy ? policyNow.policy.policyVersion : 'unknown',
      action: 'head-lock-invalidate',
    });
    if (hasMarkerFor(comments, hkey)) { result.skipped = 'HEAD-lock invalidation đã ghi nhận cho HEAD này'; return result; }
    if (!dryRun) {
      applyHandoff(io, repo, number, {
        addLabels: [LABELS.reviewRequested, AGENTS.cline],
        removeLabels: view.labels.filter((l) => ![LABELS.reviewRequested, AGENTS.cline].includes(l)),
      });
      io.postComment(repo, number, [
        `🔓 **HEAD-LOCK DRIFT** — ${hlock.reason}`,
        `Trạng thái cũ đã bị vô hiệu. Chuyển lại \`status:review-requested\` + \`${AGENTS.cline}\`: phải chạy lại CI + pre-review cho HEAD mới \`${String(headSha || '').slice(0, 12)}\` rồi mới được handoff lại ${AGENTS.gpt}.`,
        unfrozen
          ? `⚠️ Đã ghi nhận unfreeze marker — push override được cho phép, nhưng vẫn bắt buộc chạy lại CI + pre-review cho HEAD mới trước khi handoff lại ${AGENTS.gpt}.`
          : `Muốn sửa tiếp sau freeze: thêm marker \`<!-- ai-pr-reviewer:unfreeze:reason=<lý do> -->\` (mới hơn lần khóa HEAD) để mở khóa cho push override — nhưng vẫn PHẢI chạy lại CI + pre-review.`,
        `${markerBlock(hkey)}`,
      ].join('\n\n'));
    }
    result.mutated = true;
    result.preReview = { verdict: 'HEAD_LOCK_DRIFT', outcome: 'unfreeze-request', lockSha: hlock.lockSha };
    if (!dryRun) {
      result.notified = io.notify('HEAD-Lock drift bị vô hiệu', `${repo}#${number}: HEAD đổi sau giai đoạn khóa → chuyển về ${AGENTS.cline} chạy lại CI + pre-review.`);
    }
    return result;
  }

  // Đã approved hợp lệ (không drift) → dừng, chờ người dùng merge/deploy.
  if (normalizeStatusLabels(view.labels).keepStatus === LABELS.approved) {
    result.skipped = 'status:approved hợp lệ — chờ người dùng merge/deploy';
    return result;
  }

  // Đang chờ GPT quyết định cuối → orchestrator không đụng nữa.
  if (view.labels.includes(AGENTS.gpt)) {
    result.skipped = 'đang chờ GPT phê duyệt cuối (agent:gpt)';
    return result;
  }

  const { policy } = policyNow;

  // Fail-closed hạ tầng policy (Issue #5 + GPT-REV-039): canonical/project resolution lỗi
  // là lỗi hạ tầng review (BLOCKED_*), KHÔNG phải lỗi code của PR → status:blocked hỏi người
  // dùng, KHÔNG rơi về "bản local cũ", KHÔNG trả coder như CI_UNKNOWN thông thường.
  if (!policy && /BLOCKED_/.test(String(policyNow.error || ''))) {
    const key = mutationKey({ repository: repo, prNumber: number, headSha, policyVersion: 'unknown', action: 'block-policy-unresolved' });
    if (!hasMarkerFor(comments, key)) {
      if (!dryRun) {
        applyHandoff(io, repo, number, { addLabels: [LABELS.blocked], removeLabels: view.labels.filter((l) => l !== LABELS.blocked) });
        io.postComment(repo, number, [
          `⛔ **${String(policyNow.error).split(':')[0]}** — không phân giải được effective policy (canonical ${CANONICAL_REPO} + project config).`,
          `Fail-closed theo \`projectPolicyContract\`: không approve, không tự suy đoán từ bản local cũ.`,
          `${markerBlock(key)}`,
        ].join('\n\n'));
      }
      result.mutated = true;
    } else {
      result.skipped = 'block-policy-unresolved đã phát hành cho HEAD này';
    }
    result.error = String(policyNow.error || '').slice(0, 200);
    return result;
  }

  const ciState = evaluateChecks(policy, io.getChecks(repo, number));

  // Chặn event muộn giữa chừng: đọc lại lần nữa để chắc chắn headSha chưa đổi.
  const fresh = io.getPrView(repo, number);
  if (isStaleEvent({ eventHeadSha: headSha, currentHeadSha: fresh.headRefOid })) {
    result.skipped = `headSha đổi giữa chừng (${headSha.slice(0, 8)} → ${fresh.headRefOid.slice(0, 8)})`;
    return result;
  }

  const plan = planCiRouting({ ciState });
  if (plan.action === 'wait') { result.skipped = 'CI pending'; return result; }

  const key = mutationKey({
    repository: repo, prNumber: number, headSha,
    policyVersion: policy ? policy.policyVersion : 'unknown',
    action: plan.action,
  });
  // Idempotency cho cả hai nhánh của start-semantic-review: verdict đã phát hành cho HEAD này
  // thì không lặp lại mutation nào (kể cả việc đặt lại status:reviewing).
  let preVerdictKeyHit = false;
  if (plan.action === 'start-semantic-review') {
    preVerdictKeyHit =
      hasMarkerFor(comments, mutationKey({ repository: repo, prNumber: number, headSha, policyVersion: policy ? policy.policyVersion : 'unknown', action: 'pre-review:PRE_REVIEW_PASS' }))
      || hasMarkerFor(comments, mutationKey({ repository: repo, prNumber: number, headSha, policyVersion: policy ? policy.policyVersion : 'unknown', action: 'pre-review:PRE_REVIEW_FINDINGS' }));
  }
  if (hasMarkerFor(comments, key) || preVerdictKeyHit) {
    result.skipped = `action đã phát hành cho HEAD này (${plan.action})`;
    return result;
  }

  if (!dryRun) applyHandoff(io, repo, number, { addLabels: plan.addLabels, removeLabels: plan.removeLabels });
  result.mutated = true;

  if (plan.action !== 'start-semantic-review') {
    if (!dryRun) {
      io.postComment(repo, number, `${plan.comment}${markerBlock(key)}`);
      result.notified = io.notify('PR trả Cline sửa (fail-closed)', `${repo}#${number}: CI=${ciState}. Chi tiết trong comment PR.`);
    }
    result.ciState = ciState;
    return result;
  }

  // CI PASS → pre-review deterministic trên diff (không bao giờ approve).
  const diff = io.getPrDiff(repo, number);
  const pre = runSemanticPreReview(policy, diff);
  const rounds = countReviewRounds(comments);
  const outcome = planPreReviewOutcome({
    verdict: pre.verdict,
    round: rounds,
    maxRounds: policy ? policy.maxReviewRounds : 3,
    decisionGate: pre.decisionGate,
  });
  // [GPT-REV-045][GPT-REV-046] Activation state máy đọc được VÀ có authority: marker phải do
  // actor được policy cho phép đăng, wiring PR đúng phạm vi policy chỉ định, merged THẬT với
  // merge SHA khớp GitHub, GPT approval hợp lệ khóa đúng head đã merge + policyVersion hiện tại.
  // Fail-closed: mọi sai lệch/lỗi IO/mâu thuẫn → giữ transition (GPT duyệt mọi PR), không approve.
  let runtimeWiringMerged = false;
  try {
    const act = resolvePhaseActivation(io, policy);
    runtimeWiringMerged = act.active === true;
    if (!act.active && act.reason) io.log('warn', `[activation] giữ transition: ${act.reason}`);
  } catch (e) {
    io.log('warn', `[activation] lỗi bằng chứng → transition fail-closed: ${String((e && e.message) || e).slice(0, 200)}`);
    runtimeWiringMerged = false;
  }
  const phaseInfo = resolveReviewPhase(policy || {}, { runtimeWiringMerged });

  const escalation = planEscalationForPhase(phaseInfo, {
    verdict: pre.verdict, decisionGate: pre.decisionGate, openBlockingCount: pre.openBlocking.length,
  });

  if (phaseInfo.phase === 'blocked' || escalation.action === 'block') {
    outcome.action = 'block-phase-unresolved';
    outcome.addLabels = [LABELS.blocked];
    outcome.removeLabels = [LABELS.reviewing, AGENTS.cline];
  } else if (escalation.action === 'local-accept-candidate' && !pre.decisionGate) {
    // Steady-state: đủ gate mới ghi local approval; mỗi gate thiếu → fail-closed escalate-gpt.
    // Pre-check 5 gate trước ghi (readAfterWriteOk tạm true — sẽ verify thật bằng read-after-write).
    const gates = evaluateSteadyApprovalGates({
      ciState: 'pass',
      passMarkerPresent: pre.verdict === 'PRE_REVIEW_PASS',
      headSha,
      policyValid: true,
      policyVersionMatch: true,
      openBlockingCount: pre.openBlocking.length,
      readAfterWriteOk: true,
    });
    if (!gates.ok) {
      const failed = gates.gates.filter((g) => !g.pass).map((g) => g.gate).join(',');
      outcome.action = 'escalate-gpt';
      outcome.addLabels = [LABELS.reviewRequested, AGENTS.gpt];
      outcome.removeLabels = [LABELS.reviewing, AGENTS.cline];
      if (!dryRun) {
        io.postComment(repo, number,
          `⚠️ Steady-state đủ điều kiện pha nhưng gate FAIL (${failed}) → fail-closed, bàn giao GPT. KHÔNG gắn status:approved.`);
      }
    } else {
      const approvalPayload = {
        repository: repo, prNumber: number, reviewer: REVIEWER_LOCAL, headSha,
        policyVersion: policy.policyVersion,
        decisionId: `steady-local-${headSha.slice(0, 16)}`,
        ciEvidence: { requiredChecks: policy.requiredChecks, state: 'pass' },
        openBlockingFindings: pre.openBlocking.length,
        reviewedAt: new Date().toISOString(),
      };
      const approvalMarker = `<!-- ai-review-approval:${JSON.stringify(approvalPayload)} -->`;
      const outKey = mutationKey({
        repository: repo, prNumber: number, headSha,
        policyVersion: policy.policyVersion, action: 'steady-local-approve',
      });
      if (dryRun) {
        result.preReview = { verdict: pre.verdict, outcome: 'local-approved', gates: gates.gates };
        return result;
      }
      io.postComment(repo, number,
        `✅ **LOCAL APPROVAL (steady-state)** — đủ ${gates.gates.length} gate, không blocking. Bàn giao quyết định merge/deploy cho người dùng.\n\n${approvalMarker}${markerBlock(outKey)}`);
      // Read-after-write: xác nhận marker thực sự ghi được trước khi chuyển status:approved.
      const afterComments = io.listPrComments(repo, number);
      const readBackOk = afterComments.some(
        (t) => String(t).includes(approvalMarker) || String(t).includes(JSON.stringify(approvalPayload)),
      );
      // Gate cuối cùng với bằng chứng read-after-write THẬT.
      const finalGates = evaluateSteadyApprovalGates({
        ciState: 'pass',
        passMarkerPresent: pre.verdict === 'PRE_REVIEW_PASS',
        headSha,
        policyValid: true,
        policyVersionMatch: true,
        openBlockingCount: pre.openBlocking.length,
        readAfterWriteOk: readBackOk,
      });
      if (!finalGates.ok) {
        result.notified = io.notify('Local approval read-after-write FAIL',
          `${repo}#${number}: marker không xuất hiện sau ghi — fail-closed, KHÔNG gắn status:approved.`);
        outcome.action = 'escalate-gpt';
        outcome.addLabels = [LABELS.reviewRequested, AGENTS.gpt];
        outcome.removeLabels = [LABELS.reviewing, AGENTS.cline];
      } else {
        applyHandoff(io, repo, number, { addLabels: [LABELS.approved], removeLabels: [LABELS.reviewing, AGENTS.cline] });
        result.preReview = { verdict: pre.verdict, outcome: 'local-approved', gates: gates.gates };
        result.notified = io.notify('Local approval (steady-state)',
          `${repo}#${number}: đủ ${gates.gates.length} gate → status:approved cục bộ; người dùng merge/deploy.`);
        return result;
      }
    }
  }
  // transition / escalate-gpt: giữ hành vi handoff/request-fix/block-decision-gate hiện tại phía dưới.

  const outKey = mutationKey({
    repository: repo, prNumber: number, headSha,
    policyVersion: policy ? policy.policyVersion : 'unknown',
    action: `pre-review:${pre.verdict}`,
  });
  if (!dryRun) {
    const parts = [];
    if (pre.verdict === 'PRE_REVIEW_PASS') {
      parts.push(`🟢 **PRE_REVIEW_PASS** — pre-review deterministic sạch. Bàn giao GPT (${AGENTS.gpt}) phê duyệt cuối.`);
    } else {
      parts.push(`🔴 **PRE_REVIEW_FINDINGS** — ${pre.openBlocking.length} finding Critical/Important đang mở:\n\n${formatFindingsComment(pre.openBlocking, rounds + 1)}`);
      if (outcome.action === 'block') {
        parts.push(`⛔ Vượt maxReviewRounds (${rounds}/${policy ? policy.maxReviewRounds : 3}) — chuyển \`status:blocked\`, cần người dùng quyết định.`);
      } else if (outcome.action === 'block-decision-gate') {
        parts.push(`⛔ **DECISION GATE** — vượt giới hạn quy mô diff theo policy (\`diffLimits.maxLines\`, metric additions-plus-deletions): KHÔNG handoff approval, KHÔNG trả Cline như lỗi code thông thường. Chuyển \`status:blocked\` — người dùng quyết định tách PR nhỏ hơn hoặc ghi nhận ngoại lệ.`);
      }
    }
    if (outcome.action === 'block-phase-unresolved') {
      parts.push(`⛔ **BLOCKED_PHASE_UNRESOLVED** — \`reviewerPhases\` trong effective policy thiếu/mất shape: không thể xác định pha transition/steady-state an toàn. Fail-closed: KHÔNG handoff, KHÔNG approve. Sửa policy canonical rồi chạy lại.`);
    }
    // Chỉ vòng request-fix mới tăng bộ đếm round; block/decision-gate không phải vòng fix.
    const roundMarker = outcome.action === 'request-fix' ? ` <!-- ai-pr-reviewer:round=${rounds + 1} -->` : '';
    const extraMarker = pre.verdict === 'PRE_REVIEW_PASS'
      ? ` <!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headSha} -->`
      : roundMarker;
    parts.push(markerBlock(outKey, extraMarker));
    io.postComment(repo, number, parts.join('\n\n'));
  }

  if (!dryRun) {
    applyHandoff(io, repo, number, { addLabels: outcome.addLabels, removeLabels: outcome.removeLabels });
    result.preReview = { verdict: pre.verdict, openBlocking: pre.openBlocking.length, decisionGate: pre.decisionGate, outcome: outcome.action };

    const summary = {
      'handoff-gpt': `PRE_REVIEW_PASS — bàn giao GPT phê duyệt cuối (status:review-requested + agent:gpt).`,
      'request-fix': `PRE_REVIEW_FINDINGS (${pre.openBlocking.length} blocking) — trả Cline sửa qua nhãn PR.`,
      'block-decision-gate': `Diff vượt giới hạn policy (${pre.decisionGate}) — status:blocked, Decision Gate: người dùng quyết định.`,
      'block-phase-unresolved': `reviewerPhases hỏng trong effective policy — status:blocked, fail-closed.`,
      'block': `Vượt tối đa ${rounds} vòng fix — status:blocked, cần người dùng quyết định.`,
    }[outcome.action] || `Kết quả pre-review: ${outcome.action}`;
    result.notified = io.notify('Kết quả pre-review', `${repo}#${number}: ${summary}`);
  }
  return result;
}

// ---------------------------------------------------------------- vòng xử lý toàn bộ

export async function processOneCycle(io, { dryRun = true, repos } = {}) {
  const targets = repos || (io.config && io.config.targetRepos) || [];
  if (!targets.length) {
    return { dryRun, repos: [], results: [], errors: ['Không có targetRepos trong .agent/config.json'] };
  }
  const results = [];
  const errors = [];
  // Quét cả review-requested lẫn reviewing (crash giữa chừng → reviewing phải được nhặt lại).
  for (const repo of targets) {
    let prs = [];
    try {
      // Quét cả review-requested / reviewing (crash giữa chừng → nhặt lại) và approved
      // (để phát hiện approval-drift gỡ hiệu lực approval cũ).
      const seen = new Set();
      for (const label of [LABELS.reviewRequested, LABELS.reviewing, LABELS.approved]) {
        for (const p of await io.listReviewPRs(repo, label)) {
          if (!seen.has(p.number)) { seen.add(p.number); prs.push(p); }
        }
      }
    } catch (e) {
      errors.push(`${repo}: list PR FAIL — ${(e && e.message) || e}`);
      continue;
    }
    for (const p of prs) {
      try {
        results.push(await processPr(io, repo, p.number, { dryRun }));
      } catch (e) {
        const msg = `${repo}#${p.number}: ${(e && e.message) || e}`;
        errors.push(msg);
        io.log('ERROR', `processPr FAIL — ${msg}`);
      }
    }
  }
  return { dryRun, repos: targets, results, errors };
}

// ---------------------------------------------------------------- CLI

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const dryRun = !execute;
  const io = defaultIo();
  const cycle = await processOneCycle(io, { dryRun });
  console.log(JSON.stringify(cycle, null, 2));
  if (cycle.errors.length) {
    io.log('ERROR', `Chu kỳ kết thúc với ${cycle.errors.length} lỗi — KHÔNG coi là thành công.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[FATAL]', e);
    process.exitCode = 1;
  });
}



