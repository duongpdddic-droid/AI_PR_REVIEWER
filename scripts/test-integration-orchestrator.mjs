#!/usr/bin/env node
// test-integration-orchestrator.mjs — chạy processOneCycle trên mock gh (không mạng).
// Kiểm chứng hành vi end-to-end của unified-orchestrator theo hợp đồng Issue #2:
// idempotency, read-after-write, fail-closed khi thiếu dữ liệu, event muộn, drift approval.
// Exit 0 = PASS, 1 = FAIL.

import { processOneCycle, processPr, applyHandoff } from './unified-orchestrator.mjs';
import { LABELS, AGENTS, buildApprovalMarker } from './review-contract.mjs';

const SHA = 'c'.repeat(40);
const POLICY = {
  policyVersion: '2026-08-22.1',
  requiredChecks: ['verify'],
  blockingSeverities: ['critical', 'high'],
  finalReviewer: 'agent:gpt',
  maxReviewRounds: 3,
  diffLimits: { maxLines: 100 },
};

const results = [];
const eq = (name, got, want) => results.push({ name, ok: got === want, got, want });
const tru = (name, got) => results.push({ name, ok: Boolean(got), got });

// ---------------------------------------------------------------- mock gh

function makeIo(opts = {}) {
  const pr = {
    number: opts.number ?? 7,
    title: 'PR test',
    url: 'https://github.com/o/r/pull/7',
    state: opts.state ?? 'open',
    headRefOid: opts.headSha ?? SHA,
    isDraft: false,
    labels: [...(opts.labels ?? [LABELS.reviewRequested])],
    comments: [...(opts.comments ?? [])],
  };
  const state = {
    mutationLog: [],
    notifications: [],
    logs: [],
    getPrViewCalls: 0,
  };
  const io = {
    config: { targetRepos: ['o/r'] },
    listReviewPRs(_repo, label) {
      if (!pr.state || pr.state !== 'open') return [];
      return pr.labels.includes(label) ? [{ number: pr.number, title: pr.title, url: pr.url }] : [];
    },
    getPrView() {
      state.getPrViewCalls++;
      // Giả lập event muộn: lần đọc thứ N trở đi trả SHA mới (nếu cấu hình).
      const flipAfter = opts.shaFlipsAtCall ?? Infinity;
      const sha = state.getPrViewCalls >= flipAfter ? (opts.newHeadSha ?? SHA) : pr.headRefOid;
      return { number: pr.number, title: pr.title, url: pr.url, state: pr.state, headRefOid: sha, labels: [...pr.labels], comments: [] };
    },
    listPrComments() { return [...pr.comments]; },
    getPolicy(_repo, ref) {
      if (opts.policyMissingFor === ref || opts.policyMissing) return { policy: null, error: '404' };
      return { policy: JSON.parse(JSON.stringify(POLICY)) };
    },
    getChecks() {
      if (opts.checksUnreadable) return null;
      return { checks: opts.checks ?? [{ name: 'verify', state: 'SUCCESS' }] };
    },
    getPrDiff() { return opts.diff ?? '+const a = 1;\n'; },
    addLabels(_repo, _number, labels) {
      state.mutationLog.push({ type: 'addLabels', labels: [...labels] });
      if (opts.failAdding?.some((l) => labels.includes(l))) return; // giả lập GitHub nuốt lệnh
      for (const l of labels) if (!pr.labels.includes(l)) pr.labels.push(l);
    },
    removeLabels(_repo, _number, labels) {
      state.mutationLog.push({ type: 'removeLabels', labels: [...labels] });
      for (const l of labels) {
        const i = pr.labels.indexOf(l);
        if (i >= 0) pr.labels.splice(i, 1);
      }
    },
    postComment(_repo, _number, body) {
      state.mutationLog.push({ type: 'comment' });
      pr.comments.push(body);
      return 'https://github.com/o/r/pull/7#issuecomment-1';
    },
    notify(title, summary) {
      state.notifications.push({ title, summary });
      if (opts.notifyFails) return { ok: false, attempts: 3, evidence: 'FAILED', detail: 'mock fail' };
      return { ok: true, attempts: 1, evidence: 'SENT', detail: '' };
    },
    log(level, msg) { state.logs.push(`[${level}] ${msg}`); },
  };
  return { io, pr, state };
}

// ---------------------------------------------------------------- các kịch bản

// I.1 Happy path: CI pass + diff sạch → PRE_REVIEW_PASS → bàn giao GPT, không approved.
{
  const { io, pr, state } = makeIo();
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  eq('I.1 không lỗi', cycle.errors.length, 0);
  tru('I.1 PR được xử lý', cycle.results.length === 1 && !cycle.results[0].skipped);
  tru('I.1 agent:gpt gắn', pr.labels.includes(AGENTS.gpt));
  tru('I.1 review-requested giữ', pr.labels.includes(LABELS.reviewRequested));
  tru('I.1 reviewing đã gỡ', !pr.labels.includes(LABELS.reviewing));
  tru('I.1 KHÔNG status:approved', !pr.labels.includes(LABELS.approved));
  const body = pr.comments.join('\n');
  tru('I.1 comment PRE_REVIEW_PASS', body.includes('PRE_REVIEW_PASS'));
  tru('I.1 marker idempotency', body.includes(`ai-pr-reviewer:key=o/r::7::${SHA}::2026-08-22.1::pre-review:PRE_REVIEW_PASS`));
  tru('I.1 marker pre-review theo SHA', body.includes(`pre-review=PRE_REVIEW_PASS:${SHA}`));
  eq('I.1 telegram 1 lần SENT', state.notifications.length === 1 && state.notifications[0].title === 'Kết quả pre-review', true);
}

// I.2 Idempotency: chạy lại cùng HEAD (labels bị đặt lại) → skip, không comment/mutation thêm.
{
  const { io, pr } = makeIo({
    labels: [LABELS.reviewRequested],
    comments: [`🟢 **PRE_REVIEW_PASS** ...\n<!-- ai-pr-reviewer:key=o/r::7::${SHA}::2026-08-22.1::pre-review:PRE_REVIEW_PASS --> <!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${SHA} -->`],
  });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  eq('I.2 không lỗi', cycle.errors.length, 0);
  tru('I.2 bị skip', Boolean(cycle.results[0].skipped));
  eq('I.2 không mutation', pr.comments.length, 1);
}

// I.3 CI fail → changes-requested + agent:cline, không approve.
{
  const { io, pr } = makeIo({ checks: [{ name: 'verify', state: 'FAILURE' }] });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  eq('I.3 không lỗi', cycle.errors.length, 0);
  tru('I.3 changes-requested', pr.labels.includes(LABELS.changesRequested));
  tru('I.3 agent:cline', pr.labels.includes(AGENTS.cline));
  tru('I.3 KHÔNG approved/reviewing', !pr.labels.includes(LABELS.approved) && !pr.labels.includes(LABELS.reviewing));
  tru('I.3 comment nêu fail-closed', pr.comments.join('\n').includes('fail-closed'));
}

// I.4 Policy thiếu tại HEAD → CI_UNKNOWN → request-fix (fail-closed), không dừng chu kỳ.
{
  const { io, pr } = makeIo({ policyMissing: true });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  eq('I.4 không lỗi', cycle.errors.length, 0);
  tru('I.4 changes-requested', pr.labels.includes(LABELS.changesRequested));
  tru('I.4 comment CI_UNKNOWN', pr.comments.join('\n').includes('CI_UNKNOWN'));
}

// I.5 Required check thiếu trên PR → missing → request-fix.
{
  const { io, pr } = makeIo({ checks: [{ name: 'lint', state: 'SUCCESS' }] });
  await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  tru('I.5 changes-requested', pr.labels.includes(LABELS.changesRequested));
}

// I.6 Secret trong diff → PRE_REVIEW_FINDINGS + [LOCAL-REV-001], trả Cline.
{
  const { io, pr } = makeIo({ diff: "+const apiKey = 'AKIAIOSFODNN7EXAMPLE';\n" });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  eq('I.6 không lỗi', cycle.errors.length, 0);
  tru('I.6 changes-requested + cline', pr.labels.includes(LABELS.changesRequested) && pr.labels.includes(AGENTS.cline));
  const body = pr.comments.join('\n');
  tru('I.6 finding LOCAL-REV-001 critical', body.includes('[LOCAL-REV-001]') && body.includes('critical'));
  tru('I.6 marker round=1', body.includes('ai-pr-reviewer:round=1'));
  tru('I.6 KHÔNG approved', !pr.labels.includes(LABELS.approved));
}

// I.7 Approval-drift: approved mà không có marker hợp lệ → gỡ hiệu lực về review-requested.
{
  const { io, pr } = makeIo({ labels: [LABELS.approved] });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  eq('I.7 không lỗi', cycle.errors.length, 0);
  tru('I.7 gỡ approved', !pr.labels.includes(LABELS.approved));
  tru('I.7 về review-requested + gpt', pr.labels.includes(LABELS.reviewRequested) && pr.labels.includes(AGENTS.gpt));
  // Approval hợp lệ cho HEAD → không drift, PR bị skip (chờ người dùng merge).
  const marker = buildApprovalMarker({ repository: 'o/r', prNumber: 7, reviewer: AGENTS.gpt, headSha: SHA, policyVersion: POLICY.policyVersion, openBlockingFindings: 0, reviewedAt: '2026-08-22T01:00:00Z' });
  const t2 = makeIo({ labels: [LABELS.approved], comments: [`approval ${marker}`] });
  const cycle2 = await processOneCycle(t2.io, { dryRun: false, repos: ['o/r'] });
  eq('I.7 approval hợp lệ → được quét', cycle2.results.length, 1);
  tru('I.7 skip chờ merge', String(cycle2.results[0].skipped || '').includes('approved'));
  eq('I.7 không lỗi', cycle2.errors.length, 0);
  eq('I.7 không comment mới', t2.pr.comments.length, 1);
}

// I.8 PR closed/merged → không mutation (event muộn).
{
  const { io, pr } = makeIo({ state: 'merged' });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  eq('I.8 merged không được quét', cycle.results.length, 0);
  eq('I.8 không lỗi chu kỳ', cycle.errors.length, 0);
}

// I.9 Event muộn giữa chừng: SHA đổi sau lần đọc đầu → skip.
{
  const { io, pr } = makeIo({ shaFlipsAtCall: 2, newHeadSha: SHA.replace('c', 'd') });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  tru('I.9 skip do headSha đổi', String(cycle.results[0]?.skipped || '').includes('headSha'));
  eq('I.9 không mutation', pr.comments.length, 0);
}

// I.10 Read-after-write FAIL: GitHub nuốt lệnh add-label → ghi nhận error, KHÔNG báo thành công.
{
  const { io, state } = makeIo({ failAdding: [LABELS.reviewing] });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  eq('I.10 ghi nhận 1 lỗi', cycle.errors.length, 1);
  tru('I.10 lỗi nêu read-after-write', cycle.errors[0].includes('read-after-write'));
  eq('I.10 KHÔNG telegram thành công', state.notifications.filter((n) => n.title === 'Kết quả pre-review').length, 0);
}

// I.11 agent:gpt đã gắn (chờ GPT quyết định cuối) → orchestrator bỏ qua.
{
  const { io, pr } = makeIo({ labels: [LABELS.reviewRequested, AGENTS.gpt] });
  const cycle = await processOneCycle(io, { dryRun: false, repos: ['o/r'] });
  tru('I.11 skip chờ GPT', String(cycle.results[0]?.skipped || '').includes('GPT'));
  eq('I.11 không mutation', pr.comments.length, 0);
}

// I.12 Đa repo: mỗi repo dùng đúng policy của chính nó (không trộn policy giữa 2 repo).
{
  const reposState = {
    'o/r1': { labels: [LABELS.reviewRequested], comments: [] },
    'o/r2': { labels: [LABELS.reviewRequested], comments: [] },
  };
  const io = {
    config: { targetRepos: ['o/r1', 'o/r2'] },
    listReviewPRs(repo) { return [{ number: 1, title: `t-${repo}`, url: '#' }]; },
    getPrView(repo) {
      return { number: 1, title: `t-${repo}`, url: '#', state: 'open', headRefOid: SHA, labels: [...reposState[repo].labels], comments: [] };
    },
    listPrComments(repo) { return [...reposState[repo].comments]; },
    getPolicy(repo) {
      if (repo === 'o/r2') return { policy: { ...POLICY, policyVersion: 'KHÁC' } };
      return { policy: JSON.parse(JSON.stringify(POLICY)) };
    },
    getChecks() { return { checks: [{ name: 'verify', state: 'SUCCESS' }] }; },
    getPrDiff() { return '+const a = 1;\n'; },
    addLabels(repo, _n, labels) { for (const l of labels) if (!reposState[repo].labels.includes(l)) reposState[repo].labels.push(l); },
    removeLabels(repo, _n, labels) { reposState[repo].labels = reposState[repo].labels.filter((l) => !labels.includes(l)); },
    postComment(repo, _n, body) { reposState[repo].comments.push(body); return '#' ; },
    notify() { return { ok: true, attempts: 1, evidence: 'SENT', detail: '' }; },
    log() {},
  };
  const cycle = await processOneCycle(io, { dryRun: false });
  eq('I.12 xử lý đủ 2 PR', cycle.results.length, 2);
  eq('I.12 không lỗi', cycle.errors.length, 0);
  const r2 = cycle.results.find((r) => r.repo === 'o/r2');
  tru('I.12 r2 pre-review pass theo policy riêng', Boolean(r2 && r2.preReview && r2.preReview.verdict === 'PRE_REVIEW_PASS'));
  tru('I.12 r2 idempotency key dùng version của r2', reposState['o/r2'].comments.join('').includes(`::${SHA}::KHÁC::pre-review`));
}

// I.13 applyHandoff trực tiếp: từ chối mutation trên PR đóng.
{
  const closed = makeIo({ state: 'closed' });
  let threw = null;
  try { applyHandoff(closed.io, 'o/r', 7, { addLabels: ['x'], removeLabels: [] }); } catch (e) { threw = e; }
  tru('I.13 chặn mutation PR đóng', threw && String(threw.message).includes('không còn open'));
}

// I.14 Dry-run: KHÔNG mutation nào xảy ra.
{
  const { io, pr, state } = makeIo();
  const cycle = await processOneCycle(io, { dryRun: true, repos: ['o/r'] });
  eq('I.14 không lỗi', cycle.errors.length, 0);
  eq('I.14 không comment', pr.comments.length, 0);
  eq('I.14 không telegram', state.notifications.length, 0);
  eq('I.14 nhãn giữ nguyên', pr.labels.join(','), LABELS.reviewRequested);
}

let fail = 0;
console.log('\n=== TEST INTEGRATION ORCHESTRATOR ===');
for (const c of results) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${results.length - fail}/${results.length} PASS`);
process.exit(fail ? 1 : 0);
