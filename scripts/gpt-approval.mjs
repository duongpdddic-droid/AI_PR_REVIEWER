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

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  AGENTS, LABELS, REVIEWER_LOCAL,
  buildApprovalMarker, canMutatePr, effectiveApproval, evaluateChecks,
  isApprovalValid, parseApprovalMarkers, validateApprovalPayload, POLICY_PATH,
} from './review-contract.mjs';
import { CANONICAL_PATH, CANONICAL_REPO, PROJECT_CONFIG_FILE, resolveEffectivePolicy } from './effective-policy.mjs';

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
      // 1) Canonical mirror legacy — backward-safe migration (Issue #5).
      try {
        const b64 = gh(['api', `repos/${repo}/contents/${POLICY_PATH}?ref=${encodeURIComponent(ref)}`, '--jq', '.content']);
        return JSON.parse(Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8'));
      } catch { /* 2) project config + resolver */ }
      // 2) Effective policy = canonical (AI_PR_REVIEWER) + project config; lỗi → throw fail-closed.
      const cfgB64 = gh(['api', `repos/${repo}/contents/${PROJECT_CONFIG_FILE}?ref=${encodeURIComponent(ref)}`, '--jq', '.content']);
      const projectConfig = JSON.parse(Buffer.from(String(cfgB64).replace(/\s+/g, ''), 'base64').toString('utf8'));
      const canB64 = gh(['api', `repos/${CANONICAL_REPO}/contents/${CANONICAL_PATH}?ref=main`, '--jq', '.content']);
      const canonical = JSON.parse(Buffer.from(String(canB64).replace(/\s+/g, ''), 'base64').toString('utf8'));
      return resolveEffectivePolicy(canonical, projectConfig).policy;
    },
    getChecks(repo, number) {
      return JSON.parse(gh(['pr', 'checks', String(number), '--repo', repo, '--json', 'name,state']));
    },
    listPrComments(repo, number) {
      const out = gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate', '--jq', '[.[].body] | join("\\u0000")']);
      return String(out || '').split('\u0000');
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

  let checks = null;
  try { checks = io.getChecks(repo, pr); } catch { checks = null; }
  const ciState = evaluateChecks(policy, checks);
  if (ciState !== 'pass') {
    throw new Error(`TỪ CHỐI: CI=${ciState} — approval chỉ được ghi khi CI PASS (fail-closed).`);
  }

  const bodies = io.listPrComments(repo, pr);
  const passMarker = `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headSha} -->`;
  if (!bodies.some((b) => String(b).includes(passMarker))) {
    throw new Error(`TỪ CHỐI: chưa có ${REVIEWER_LOCAL} PRE_REVIEW_PASS cho HEAD ${headSha.slice(0, 12)} — chạy orchestrator pre-review trước.`);
  }

  // Idempotent: approval trùng HEAD/repo/pr đã hợp lệ → không ghi lần 2.
  const existing = parseApprovalMarkers(bodies).filter((r) =>
    isApprovalValid(r, { headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion }).valid);
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
  const recorded = effectiveApproval(afterComments, { headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion });
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
    else out._.push(a);
  }
  if (!out.repo || !out.pr || (!out.revoke && !out.payloadRaw && !out.payloadFile)) {
    console.error([
      'Usage:',
      '  node scripts/gpt-approval.mjs --repo owner/name --pr <number> --payload \'<json>\' [--note "..."]',
      '    json: {"repository":"owner/name","prNumber":N,"headSha":"<full40hex>","policyVersion":"...","decisionId":"id-khong-trang"}',
      '  (hoặc --payload-file <path>)',
      '  node scripts/gpt-approval.mjs --repo owner/name --pr <number> --revoke "lý do"',
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

