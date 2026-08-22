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
//   - KHÔNG BAO GIỜ tự gắn status:approved từ CI hay pre-review; approval chỉ do GPT
//     ghi qua scripts/gpt-approval.mjs, khóa full HEAD SHA + policyVersion.
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
  AGENTS, DEFAULT_BLOCKING_SEVERITIES, LABELS, POLICY_PATH,
  canMutatePr, countReviewRounds, evaluateChecks, evaluateDiffLimits,
  gateOpenFindings, isStaleEvent, mutationKey, normalizeStatusLabels,
  planApprovalDrift, planCiRouting, planPreReviewOutcome, scanDiffForSecrets,
} from './review-contract.mjs';

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
      const out = this.gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate',
        '--jq', '[.[].body] | join("\\u0000")']);
      return String(out || '').split('\u0000');
    },
    getPolicy(repo, ref) {
      try {
        const b64 = this.gh(['api', `repos/${repo}/contents/${POLICY_PATH}?ref=${encodeURIComponent(ref)}`, '--jq', '.content']);
        return { policy: JSON.parse(Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8')) };
      } catch (e) {
        return { policy: null, error: String((e && e.message) || e).slice(0, 200) };
      }
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
    notify(title, summary) {
      const res = spawnSync(process.execPath, [path.join(HERE, 'notify-telegram.mjs'), title, summary], { encoding: 'utf8' });
      const ok = res.status === 0;
      return { ok, attempts: 1, evidence: ok ? 'SENT' : 'FAILED', detail: ((res.stderr || '') + (res.stdout || '')).trim().slice(0, 200) };
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
export function hasMarkerFor(comments, key) {
  const needle = `<!-- ai-pr-reviewer:key=${key} -->`;
  for (const t of comments || []) if (String(t).includes(needle)) return true;
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
      'block': `Vượt tối đa ${rounds} vòng fix — status:blocked, cần người dùng quyết định.`,
    }[outcome.action];
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



