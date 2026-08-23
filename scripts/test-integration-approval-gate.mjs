#!/usr/bin/env node
// test-integration-approval-gate.mjs — chạy performApproval/performRevoke trên mock io.
// Kiểm chứng GPT-REV-032 (user-relay payload gate) + GPT-REV-033 (thứ tự mutation an toàn,
// inject lỗi từng bước — không kịch bản nào kết thúc approved-thiếu-marker). Exit 0/1.

import { performApproval, performRevoke } from './gpt-approval.mjs';
import { LABELS } from './review-contract.mjs';

const SHA = 'c'.repeat(40);
const POLICY = {
  policyVersion: '2026-08-23.1',
  requiredChecks: ['verify'],
  blockingSeverities: ['critical', 'important'],
  finalReviewer: 'agent:gpt',
  maxReviewRounds: 3,
  diffLimits: { maxLines: 1500 },
};
const PASS_MARKER = `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${SHA} -->`;
const payload = () => ({ repository: 'o/r', prNumber: 7, headSha: SHA, policyVersion: POLICY.policyVersion, decisionId: 'gpt-dec-test-001' });

const results = [];
const eq = (name, got, want) => results.push({ name, ok: got === want, got, want });
const tru = (name, got) => results.push({ name, ok: Boolean(got), got });

function makeGateIo(opts = {}) {
  const pr = {
    state: opts.state ?? 'open',
    headRefOid: SHA,
    labels: [...(opts.labels ?? [LABELS.reviewRequested])],
    comments: [...(opts.comments ?? [])],
  };
  if (!opts.comments && !pr.comments.some((c) => c.includes(PASS_MARKER))) {
    pr.comments.unshift(`🟢 PRE_REVIEW_PASS ${PASS_MARKER}`);
  }
  const s = { mutations: [] };
  const io = {
    getPrView() { return { state: pr.state, headRefOid: pr.headRefOid, labels: [...pr.labels] }; },
    getPolicy() {
      if (opts.policyFails) throw new Error('gh api policy FAIL');
      return JSON.parse(JSON.stringify(POLICY));
    },
    getChecks() {
      if (opts.checksFail) throw new Error('gh checks FAIL');
      return { checks: [{ name: 'verify', state: opts.ciState ?? 'SUCCESS' }] };
    },
    // [GPT-REV-048] Trả về rich comment objects {id, user:{login}, created_at, body} để đồng bộ
    // với io thật (unified-orchestrator.listPrComments). pr.comments lưu body thuần.
    listPrComments() {
      let out = [...pr.comments].map((c, i) => ({
        id: `c${i}`, user: { login: 'user' }, created_at: '-',
        body: typeof c === 'string' ? c : String(c && c.body != null ? c.body : c),
      }));
      if (opts.readbackHidesMarker) out = out.filter((c) => !c.body.includes('ai-review-approval:'));
      return out;
    },
    postComment(_r, _n, body) {
      if (opts.failPostComment) throw new Error('gh comment FAIL');
      s.mutations.push('comment');
      pr.comments.push(body);
      return '#c1';
    },
    removeLabels(_r, _n, labels) {
      if (opts.failRemoveLabels) throw new Error('gh remove-label FAIL');
      s.mutations.push(`remove:${labels.join('|')}`);
      for (const l of labels) {
        const i = pr.labels.indexOf(l);
        if (i >= 0) pr.labels.splice(i, 1);
      }
    },
    addLabels(_r, _n, labels) {
      if (labels.includes(LABELS.approved) && opts.swallowAddApproved) return; // GitHub nuốt lệnh
      if (labels.includes(LABELS.approved) && opts.raceAddsStaleStatus && !pr.labels.includes(LABELS.reviewing)) pr.labels.push(LABELS.reviewing);
      s.mutations.push(`add:${labels.join('|')}`);
      for (const l of labels) if (!pr.labels.includes(l)) pr.labels.push(l);
    },
  };
  return { io, pr, state: s };
}

async function expectThrow(name, fn, needle) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  tru(`${name} ném lỗi`, threw && (!needle || String(threw.message).includes(needle)));
  return threw;
}

// A.1 Happy path: marker TRƯỚC → read-back → gỡ nhãn khác → approved; đúng 1 status:*.
{
  const { io, pr, state } = makeGateIo();
  const r = await performApproval(io, { repo: 'o/r', pr: 7, payload: payload(), note: 'GPT đồng ý' });
  tru('A.1 mutated', r.mutated === true);
  tru('A.1 kết thúc status:approved', pr.labels.includes(LABELS.approved));
  eq('A.1 duy nhất 1 status:*', pr.labels.filter((l) => l.startsWith('status:')).length, 1);
  eq('A.1 mutation đầu tiên là comment (marker trước nhãn)', state.mutations[0], 'comment');
  tru('A.1 remove trước add-approved',
    state.mutations.findIndex((m) => m.startsWith('remove:')) < state.mutations.indexOf('add:' + LABELS.approved));
  tru('A.1 marker chứa decision ID + full SHA', pr.comments.join('\n').includes(payload().decisionId) && pr.comments.join('\n').includes(SHA));
}

// A.2 Payload thiếu/sai từng trường → KHÔNG mutation nào.
{
  const cases = [
    ['repository', 'other/r'], ['prNumber', 8], ['headSha-ngắn', 'shortsha'],
    ['headSha-lệch', SHA.slice(0, 39) + 'd'], ['policyVersion', 'khác'], ['decisionId', ''],
  ];
  for (const [k, v] of cases) {
    const broken = payload();
    broken[k.replace(/-.*$/, '')] = v;
    if (k === 'headSha-lệch') broken.headSha = v;
    const { io, pr, state } = makeGateIo();
    await expectThrow(`A.2 sai ${k}`, () => performApproval(io, { repo: 'o/r', pr: 7, payload: broken }));
    eq(`A.2 ${k}: không comment`, state.mutations.filter((m) => m === 'comment').length, 0);
    tru(`A.2 ${k}: nhãn giữ nguyên`, pr.labels.join(',') === LABELS.reviewRequested);
  }
  const none = makeGateIo();
  await expectThrow('A.2 payload null', () => performApproval(none.io, { repo: 'o/r', pr: 7, payload: null }));
  tru('A.2 null: không mutation', none.state.mutations.length === 0 && none.pr.labels.join(',') === LABELS.reviewRequested);
}

// A.3 Preconditions fail → throw trước mọi mutation.
{
  const closed = makeGateIo({ state: 'merged' });
  await expectThrow('A.3 PR merged chặn', () => performApproval(closed.io, { repo: 'o/r', pr: 7, payload: payload() }));
  tru('A.3 merged không mutation', closed.state.mutations.length === 0);

  const ciFail = makeGateIo({ ciState: 'FAILURE' });
  await expectThrow('A.3 CI fail chặn', () => performApproval(ciFail.io, { repo: 'o/r', pr: 7, payload: payload() }));
  tru('A.3 CI fail không mutation', ciFail.state.mutations.length === 0);

  const noPass = makeGateIo({ comments: ['bình thường thôi'] });
  await expectThrow('A.3 thiếu PRE_REVIEW_PASS', () => performApproval(noPass.io, { repo: 'o/r', pr: 7, payload: payload() }), 'PRE_REVIEW_PASS');
  tru('A.3 thiếu pass-marker không mutation', noPass.state.mutations.length === 0);

  const badPolicy = makeGateIo({ policyFails: true });
  await expectThrow('A.3 policy không đọc được', () => performApproval(badPolicy.io, { repo: 'o/r', pr: 7, payload: payload() }), 'CI_UNKNOWN');
  tru('A.3 policy lỗi không mutation', badPolicy.state.mutations.length === 0);
}

// A.4 Read-back FAIL (marker bị nuốt/không đọc lại được) → KHÔNG đụng nhãn.
{
  const { io, pr, state } = makeGateIo({ readbackHidesMarker: true });
  await expectThrow('A.4 read-back fail', () => performApproval(io, { repo: 'o/r', pr: 7, payload: payload() }), 'read-back');
  tru('A.4 đã comment nhưng KHÔNG approved', state.mutations.includes('comment') && !pr.labels.includes(LABELS.approved));
}

// A.5 remove-labels FAIL giữa giao dịch → throw; approved chưa bao giờ được thêm.
{
  const { io, pr } = makeGateIo({ labels: [LABELS.reviewing], failRemoveLabels: true });
  await expectThrow('A.5 remove fail', () => performApproval(io, { repo: 'o/r', pr: 7, payload: payload() }), 'remove-label');
  tru('A.5 không approved', !pr.labels.includes(LABELS.approved));
  tru('A.5 reviewing còn nguyên', pr.labels.includes(LABELS.reviewing));
}

// A.6 add-label approved bị GitHub nuốt → read-after-write bắt được; phục hồi đảm bảo không approved.
{
  const { io, pr } = makeGateIo({ swallowAddApproved: true });
  await expectThrow('A.6 add nuốt lệnh', () => performApproval(io, { repo: 'o/r', pr: 7, payload: payload() }), 'read-after-write');
  tru('A.6 cuối cùng KHÔNG approved', !pr.labels.includes(LABELS.approved));
}

// A.7 Race: thêm approved xong vẫn còn status cũ (2 status:*) → phục hồi gỡ approved.
{
  const { io, pr } = makeGateIo({ raceAddsStaleStatus: true });
  await expectThrow('A.7 hai status:*', () => performApproval(io, { repo: 'o/r', pr: 7, payload: payload() }), 'read-after-write');
  tru('A.7 phục hồi xong KHÔNG approved-thiếu-marker', !pr.labels.includes(LABELS.approved));
}

// A.8 Idempotent: approval hợp lệ trùng HEAD tồn tại → skip, không comment thêm.
{
  const dup = makeGateIo();
  const first = await performApproval(dup.io, { repo: 'o/r', pr: 7, payload: payload() });
  const before = dup.pr.comments.length;
  const second = await performApproval(dup.io, { repo: 'o/r', pr: 7, payload: payload() });
  eq('A.8 lần 2 skipped=duplicate', second.skipped, 'duplicate');
  eq('A.8 không comment thêm', dup.pr.comments.length, before);
  tru('A.8 lần 1 mutated', first.mutated === true);
}

// A.9 Revoke: approved → review-requested, error-check đầy đủ.
{
  const { io, pr, state } = makeGateIo({ labels: [LABELS.approved] });
  const r = await performRevoke(io, { repo: 'o/r', pr: 7, reason: 'thay đổi HEAD' });
  tru('A.9 mutated', r.mutated === true);
  tru('A.9 về review-requested', pr.labels.includes(LABELS.reviewRequested) && !pr.labels.includes(LABELS.approved));
  eq('A.9 duy nhất 1 status:*', pr.labels.filter((l) => l.startsWith('status:')).length, 1);
  tru('A.9 có comment thu hồi', state.mutations.some((m) => m === 'comment'));
}

let fail = 0;
console.log('\n=== TEST INTEGRATION APPROVAL GATE ===');
for (const c of results) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${results.length - fail}/${results.length} PASS`);
process.exit(fail ? 1 : 0);


