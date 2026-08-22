#!/usr/bin/env node
// gpt-approval.mjs — Cổng DUY NHẤT ghi nhận approval cuối của GPT lên PR (Issue #2 A3).
//
// Người dùng (Bố) relay quyết định GPT vào đây; script tự kiểm chứng trước khi mutation:
//   1. PR còn open;
//   2. CI PASS theo policy tại HEAD (fail-closed: missing/unknown → từ chối);
//   3. Pre-review deterministic tại ĐÚNG HEAD này đã PRE_REVIEW_PASS;
//   4. Idempotent: approval trùng HEAD không ghi lần 2.
// Đạt hết → đăng comment chứa approval marker (khóa full HEAD SHA + policyVersion),
// gắn `status:approved`, gỡ nhãn trạng thái khác. Không đạt → exit 1, KHÔNG mutation.
//
// Usage:
//   node scripts/gpt-approval.mjs --repo owner/name --pr 12 [--note "trích quyết định GPT"]
//   node scripts/gpt-approval.mjs --repo owner/name --pr 12 --revoke "lý do"

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import {
  AGENTS, LABELS, REVIEWER_LOCAL,
  buildApprovalMarker, canMutatePr, evaluateChecks, parseApprovalMarkers,
} from './review-contract.mjs';

function gh(args, { input } = {}) {
  const res = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input: String(input) } : {}) });
  if (res.error || res.status !== 0) {
    throw new Error(`gh ${args.join(' ')} FAIL: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  }
  return res.stdout;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--pr') out.pr = Number(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--revoke') out.revoke = argv[++i] || 'người dùng thu hồi';
    else out._.push(a);
  }
  if (!out.repo || !out.pr) {
    console.error('Usage: node scripts/gpt-approval.mjs --repo owner/name --pr <number> [--note "..."] | --revoke "lý do"');
    process.exit(2);
  }
  return out;
}

function setApprovedLabels(repo, pr, { revoke = false } = {}) {
  const add = revoke ? [LABELS.reviewRequested] : [LABELS.approved];
  const remove = revoke
    ? [LABELS.approved]
    : [LABELS.reviewRequested, LABELS.reviewing, LABELS.changesRequested, LABELS.blocked, LABELS.queued, LABELS.readyForCline, LABELS.inProgress];
  for (const l of remove) {
    spawnSync('gh', ['pr', 'edit', String(pr), '--repo', repo, '--remove-label', l], { encoding: 'utf8' });
  }
  gh(['pr', 'edit', String(pr), '--repo', repo, '--add-label', add.join(',')]);
  const after = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'labels,state']));
  const names = (after.labels || []).map((l) => l.name);
  if (!names.includes(add[0])) throw new Error(`read-after-write FAIL: thiếu ${add[0]}`);
  const statuses = names.filter((l) => l.startsWith('status:'));
  if (statuses.length !== 1) throw new Error(`read-after-write FAIL: PR có ${statuses.length} status:* (${statuses.join(', ')})`);
  return names;
}

async function main() {
  const { repo, pr, note, revoke } = parseArgs(process.argv.slice(2));

  const view = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,headRefOid,labels']));
  const headSha = view.headRefOid;

  if (!canMutatePr(view.state)) {
    console.error(`TỪ CHỐI: PR ${repo}#${pr} state=${view.state} — chỉ PR open được mutation.`);
    process.exitCode = 1;
    return;
  }

  if (revoke) {
    setApprovedLabels(repo, pr, { revoke: true });
    gh(['pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'], {
      input: `🚫 Thu hồi approval: ${revoke}\n\nChuyển về \`status:review-requested\`, chờ ${AGENTS.gpt} review lại.\n<!-- ai-pr-reviewer:key=${repo}::${pr}::${headSha}::revoke -->`,
    });
    console.log(`ĐÃ THU HỒI approval trên ${repo}#${pr} (HEAD ${headSha.slice(0, 12)}).`);
    return;
  }

  // 1) Policy tại HEAD
  let policy;
  try {
    const b64 = gh(['api', `repos/${repo}/contents/.github/ai-review-policy.json?ref=${encodeURIComponent(headSha)}`, '--jq', '.content']);
    policy = JSON.parse(Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch (e) {
    console.error(`TỪ CHỐI (CI_UNKNOWN): không đọc được policy tại HEAD — ${String((e && e.message) || e).slice(0, 160)}`);
    process.exitCode = 1;
    return;
  }

  // 2) CI phải PASS (fail-closed)
  let checks;
  try { checks = JSON.parse(gh(['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,state'])); } catch { checks = null; }
  const ciState = evaluateChecks(policy, checks);
  if (ciState !== 'pass') {
    console.error(`TỪ CHỐI: CI=${ciState} — approval chỉ được ghi khi CI PASS (fail-closed).`);
    process.exitCode = 1;
    return;
  }

    // 3) Pre-review PASS tại đúng HEAD này
  const bodies = String(gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--jq', '[.[].body] | join("\\u0000")']) || '').split('\u0000');
  const passMarker = `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headSha} -->`;
  if (!bodies.some((b) => String(b).includes(passMarker))) {
    console.error(`TỪ CHỐI: chưa có ${REVIEWER_LOCAL} PRE_REVIEW_PASS cho HEAD ${headSha.slice(0, 12)} — chạy orchestrator pre-review trước.`);
    process.exitCode = 1;
    return;
  }

  // 4) Idempotent: approval GPT trùng HEAD đã tồn tại → không ghi lần 2
  const existing = parseApprovalMarkers(bodies).filter((r) =>
    String(r.headSha).toLowerCase() === headSha.toLowerCase()
    && String(r.repository) === repo && Number(r.prNumber) === pr
    && String(r.reviewer) === AGENTS.gpt);
  if (existing.length) {
    console.log(`BỎ QUA: approval ${AGENTS.gpt} cho HEAD ${headSha.slice(0, 12)} đã tồn tại (${existing.length} marker) — không ghi trùng.`);
    return;
  }

  const marker = buildApprovalMarker({
    repository: repo,
    prNumber: pr,
    reviewer: AGENTS.gpt,
    headSha,
    policyVersion: policy.policyVersion,
    ciEvidence: { ciState, checks: ((checks && checks.checks) || []).map((c) => `${c.name}=${c.state}`) },
    openBlockingFindings: 0,
    reviewedAt: new Date().toISOString(),
  });
  const body = [
    '## ✅ APPROVAL CUỐI — GPT (qua relay người dùng)',
    note ? `\n> ${note}` : '',
    '',
    `Quyết định của **${AGENTS.gpt}** đã được relay. CI PASS + ${REVIEWER_LOCAL} PRE_REVIEW_PASS tại HEAD \`${headSha}\`.`,
    'Merge/deploy vẫn do người dùng thực hiện.',
    '',
    marker,
  ].join('\n');

  setApprovedLabels(repo, pr);
  gh(['pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'], { input: body });
  console.log(`ĐÃ GHI approval ${AGENTS.gpt} cho ${repo}#${pr} tại HEAD ${headSha.slice(0, 12)} (policy ${policy.policyVersion}) — status:approved.`);
}

main().catch((e) => {
  console.error('[FATAL]', e && e.message ? e.message : e);
  process.exitCode = 1;
});

