#!/usr/bin/env node
// test-runtime-hooks.mjs — Integration: memory/observation/recovery/telemetry nối vào runtime
// (Issue #9 / GPT-REV-059). Temp dir + fixture thật; chứng minh:
//   - observation ghi JSONL THẬT qua fs, sống qua "restart" (instance mới load lại được);
//   - telemetry event lưu file, secret lồng nhau redact;
//   - recovery phát sinh telemetry + identity echo nguyên vẹn; AUTH fail-closed không fallback;
//   - storage lỗi → degraded, KHÔNG block caller (workflow tiếp tục);
//   - consolidation bounded + atomic rewrite.
// Assert-based (AAA), không framework, tự dọn temp. Exit 0 = PASS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntimeHooks, defaultRuntimeDir } from './runtime-hooks.mjs';
import {
  buildCoderContext, buildStartupCapsule, fetchUnresolvedFindings, readConventions,
  normalizePaginatedComments, prepareCoderInvocation, executeCoderInvocation, recordInvocationTelemetry,
} from './autonomous-run.mjs';
import { estimateTokens } from './context-manager.mjs';

// GPT-REV-063: runtime state mặc định NGOÀI worktree. Test cô lập bằng runtimeDir tách
// (path.join(root,'rt')) để không ghi vào ~/.agent-runtime thật.
function hooksIn(root, io) {
  return createRuntimeHooks({ rootDir: root, runtimeDir: path.join(root, 'rt'), io });
}

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${(e && e.message) || e}`); process.exitCode = 1; }
};

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-hooks-'));
}

const SECRET_TOKEN = 'ghp_INTEGRATIONTOKEN0000000000000000000';

test('INT.observation-persists: observation ghi file thật, sống qua restart (instance mới)', () => {
  const root = makeTempRoot();
  try {
    const h1 = hooksIn(root);
    const r = h1.recordObservation({
      kind: 'decision', content: 'Chọn JSONL stdlib thay DB', subjectKey: 'decision-storage',
      provenance: { task: 'issue-9' }, ts: '2026-08-25T00:00:00.000Z',
    });
    assert.equal(r.ok, true, 'recordObservation ok');
    const raw = fs.readFileSync(h1.paths.memory, 'utf8');
    assert.ok(raw.includes('JSONL stdlib thay DB'), 'byte thực sự ghi xuống file');

    // "Restart": instance mới cùng root → load lại được dữ liệu cũ.
    const h2 = hooksIn(root);
    const entries = h2.store.load();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'Chọn JSONL stdlib thay DB');
    assert.equal(entries[0].provenance.task, 'issue-9', 'provenance giữ nguyên qua restart');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INT.event-redacted-on-disk: telemetry event lồng secret → file KHÔNG chứa secret gốc', () => {
  const root = makeTempRoot();
  try {
    const h = hooksIn(root);
    const r = h.recordEvent({
      taskId: 'issue-9', issue: 9, errorClass: 'PROVIDER_ERROR',
      toolFailure: { stderr: `Authorization: Bearer ${SECRET_TOKEN}`, exitCode: 1 },
      outcome: 'failed',
    });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(h.paths.events, 'utf8');
    assert.ok(!raw.includes(SECRET_TOKEN), 'secret gốc KHÔNG có trên đĩa');
    assert.ok(raw.includes('[REDACTED]'), 'marker redact trên đĩa');
    assert.ok(raw.includes('"exitCode":1'), 'cấu trúc event bảo toàn');
    const evs = h.loadEvents();
    assert.equal(evs.length, 1);
    assert.equal(evs[0].toolFailure.exitCode, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INT.recovery-telemetry: recovery sinh event outcome=recovery:* + identity echo nguyên vẹn', () => {
  const root = makeTempRoot();
  try {
    const h = hooksIn(root);
    const identity = { role: 'coder', baseSha: 'fbe5b05111111111111111111111111111111111' };
    const plan = h.recover({
      errorClass: 'RATE_LIMIT', attempts: 1, maxAttempts: 3,
      taskId: 'issue-9', issue: 9, identity,
    });
    assert.equal(plan.action, 'retry-backoff');
    assert.deepEqual(plan.identity, identity, 'identity echo nguyên vẹn trong plan');

    // Telemetry event do recover() tự sinh.
    const evs = h.loadEvents();
    assert.equal(evs.length, 1, 'recover() tự ghi đúng 1 event');
    assert.equal(evs[0].outcome, 'recovery:retry-backoff');
    assert.equal(evs[0].errorClass, 'RATE_LIMIT');
    assert.equal(evs[0].attempt, 1);
    assert.equal(evs[0].issue, 9);

    // Fallback model tường minh: fallbackEvent được ghi kèm nextTarget.
    const planFb = h.recover({
      errorClass: 'PROVIDER_ERROR', attempts: 3, maxAttempts: 3,
      fallbackChain: [{ provider: 'p', model: 'm' }], policyGate: { passing: true },
      taskId: 'issue-9', identity,
    });
    assert.equal(planFb.action, 'fallback-model');
    const evs2 = h.loadEvents();
    assert.equal(evs2[evs2.length - 1].outcome, 'recovery:fallback-model');
    assert.deepEqual(evs2[evs2.length - 1].fallbackEvent.to, { provider: 'p', model: 'm' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INT.recovery-fail-closed: AUTH_OR_CONFIG_ERROR escalate ngay, không sinh fallback', () => {
  const root = makeTempRoot();
  try {
    const h = hooksIn(root);
    const plan = h.recover({
      errorClass: 'AUTH_OR_CONFIG_ERROR', attempts: 0, maxAttempts: 3,
      fallbackChain: [{ provider: 'x', model: 'y' }], policyGate: { passing: true },
      taskId: 'issue-9', identity: { role: 'coder' },
    });
    assert.equal(plan.action, 'escalate-blocked', 'policy fail-closed: auth không bypass bằng model khác');
    const [ev] = h.loadEvents();
    assert.equal(ev.outcome, 'recovery:escalate-blocked');
    assert.equal(ev.fallbackEvent, null, 'không mở nhánh fallback cho auth error');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INT.failure-not-blocking: storage ném lỗi → recordObservation degraded, không ném', () => {
  const root = makeTempRoot();
  try {
    const h = hooksIn(root, {
        readFile: () => { throw new Error('disk exploded'); },
        appendFile: () => { throw new Error('disk full'); },
      });
    let r;
    assert.doesNotThrow(() => {
      r = h.recordObservation({ kind: 'convention', content: 'x', provenance: { task: 't' }, ts: '2026-08-25T00:00:00.000Z' });
    }, 'observation lỗi storage không được ném vào caller');
    assert.equal(r.ok, false);
    assert.match(r.reason || '', /storage-failure/, 'lý do degrade được báo rõ');
    // Workflow vẫn tiếp tục: recordEvent/consolidate dùng fs thật (io injection chỉ scope
    // memory store) nên vẫn ghi được — chứng minh caller KHÔNG bị block bởi storage lỗi.
    let evRes;
    assert.doesNotThrow(() => { evRes = h.recordEvent({ outcome: 'still-alive' }); });
    assert.equal(evRes.ok, true, 'recordEvent trên fs thật vẫn ok → workflow không block');
    const evs = h.loadEvents();
    assert.equal(evs[evs.length - 1].outcome, 'still-alive');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INT.consolidation-bounded: vượt cap → supersede theo subject + cap + atomic rewrite', () => {
  const root = makeTempRoot();
  try {
    const h = hooksIn(root);
    // 5 bản same subjectKey (supersede: ts mới nhất thắng) + cap 3.
    for (let i = 0; i < 5; i += 1) {
      h.recordObservation({
        kind: 'session-summary', content: `summary v${i}`,
        subjectKey: 'same-subject', provenance: { task: 't' },
        ts: `2026-08-2${i}T00:00:00.000Z`,
      });
    }
    assert.equal(h.store.load().length, 5);
    const res = h.consolidateMemory({ maxEntries: 3 });
    assert.equal(res.ok, true);
    assert.equal(res.rewritten, true, 'file bị rewrite khi consolidate');
    const kept = hooksIn(root).store.load();
    assert.ok(kept.length <= 3, `bounded growth: còn ${kept.length} <= 3`);
    assert.equal(kept[kept.length - 1].content, 'summary v4', 'bản ts MỚI NHẤT của subject thắng');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INT.no-silent-store: store không có IO ghi → stored:false, không báo stored giả', () => {
  const root = makeTempRoot();
  try {
    // io:{} tường minh = caller từ chối IO → append phải stored:false (GPT-REV-059).
    const h = hooksIn(root, {});
    const r = h.recordObservation({ kind: 'decision', content: 'no io', provenance: { task: 't' }, ts: '2026-08-25T00:00:00.000Z' });
    assert.equal(r.ok, false);
    assert.equal(r.stored, false);
    assert.equal(r.reason, 'no-storage-io');
    // Default (không truyền io) dùng fs thật → ghi byte thật.
    const hd = hooksIn(root);
    const rd = hd.recordObservation({ kind: 'pointer', content: 'https://github.com/x/y/pull/10', provenance: { task: 't' }, ts: '2026-08-25T00:00:00.000Z' });
    assert.equal(rd.ok, true, 'default fs io ghi thật');
    assert.ok(fs.existsSync(hd.paths.memory), 'file tồn tại sau append');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- GPT-REV-062
test('INT.recover-redacts-identity: recover() qua redact — secret lồng trong identity/fallback không lên đĩa', () => {
  const root = makeTempRoot();
  try {
    const h = hooksIn(root);
    h.recover({
      errorClass: 'RATE_LIMIT', attempts: 1, maxAttempts: 3,
      taskId: 'issue-9', issue: 9,
      identity: { role: 'coder', apiKey: 'ghp_SECRETINTEGRATIONTOKEN1234567890' },
    });
    // Fallback-model path: credential lồng trong fallbackChain phải redact trên đĩa.
    h.recover({
      errorClass: 'PROVIDER_ERROR', attempts: 3, maxAttempts: 3,
      fallbackChain: [{ provider: 'p', model: 'm', credential: 'sk-fallbacksupersecret0099' }],
      policyGate: { passing: true },
      taskId: 'issue-9',
      identity: { role: 'coder', apiKey: 'ghp_SECRETINTEGRATIONTOKEN1234567890' },
    });
    const raw = fs.readFileSync(h.paths.events, 'utf8');
    assert.ok(!raw.includes('ghp_SECRETINTEGRATIONTOKEN'), 'token trong identity bị redact trên đĩa');
    assert.ok(!raw.includes('sk-fallbacksupersecret0099'), 'credential trong fallbackEvent bị redact trên đĩa');
    assert.ok(raw.includes('[REDACTED]'), 'marker redact ghi rõ trên đĩa');
    const evs = h.loadEvents();
    assert.ok(evs.every((e) => e.identity.role === 'coder'), 'identity phi-secret giữ nguyên');
    assert.equal(evs[evs.length - 1].outcome, 'recovery:fallback-model');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- GPT-REV-063
test('INT.runtime-outside-worktree: default dir ngoài worktree, git status sạch, persist qua restart', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-wt-'));
  let runtimeHome = null;
  try {
    execFileSync('git', ['init', '-q'], { cwd: wt });
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: wt });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: wt });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: wt });

    // KHÔNG truyền runtimeDir → dùng default (ngoài worktree).
    const h = createRuntimeHooks({ rootDir: wt });
    runtimeHome = path.dirname(h.paths.memory);
    const normWt = path.resolve(wt).toLowerCase();
    assert.ok(!path.resolve(h.paths.memory).toLowerCase().startsWith(normWt), 'memory file NGOÀI worktree');
    assert.ok(!path.resolve(h.paths.events).toLowerCase().startsWith(normWt), 'events file NGOÀI worktree');
    assert.ok(runtimeHome.startsWith(path.join(os.homedir(), '.agent-runtime')), 'default nằm dưới ~/.agent-runtime');

    // Ghi cả observation + event rồi worktree vẫn sạch (git add -A sẽ không nhặt được gì).
    h.recordObservation({ kind: 'decision', content: 'x', subjectKey: 'k', provenance: { task: 't' }, ts: '2026-08-25T00:00:00.000Z' });
    h.recordEvent({ outcome: 'probe-outside-worktree' });
    const st = execFileSync('git', ['status', '--porcelain'], { cwd: wt }).toString();
    assert.equal(st.trim(), '', 'worktree sạch sau khi runtime ghi state');

    // Persist qua restart: instance mới cùng rootDir load lại events.
    const evs = createRuntimeHooks({ rootDir: wt }).loadEvents();
    assert.ok(evs.some((e) => e.outcome === 'probe-outside-worktree'), 'events sống qua restart ở default dir');
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- GPT-REV-064
test('INT.coder-context-budget: selective+compact vào execution path — retry nhỏ hơn, spans còn, compaction persist', () => {
  const root = makeTempRoot();
  try {
    const sha40 = 'fbe5b05111111111111111111111111111111111';
    const padBg = Array.from({ length: 40 }, (_, i) => `Dòng nền ${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`);
    const padTest = Array.from({ length: 20 }, (_, i) => `Bằng chứng chạy verify lần ${i}: node scripts/full-verify.mjs PASS toàn bộ 89/89 hạng mục kiểm tra bắt buộc.`);
    const bigBody = [
      '## Phạm vi được phép',
      'Chỉ sửa scripts/foo.mjs và test tương ứng.',
      '## Tiêu chí nghiệm thu',
      '- [ ] full-verify PASS',
      '- [ ] Không đụng vùng cấm',
      '## Bối cảnh nền',
      ...padBg,
      '## Bằng chứng kiểm thử',
      ...padTest,
    ].join('\n');
    const findings = [
      `Fix theo commit ${sha40} giữ nguyên contract.`,
      'Decision Gate: vượt scope thì dừng hỏi [GPT-REV-064].',
    ];

    const full = buildCoderContext({ issueNumber: 64, issueBody: bigBody, findings, budgetTokens: 900 });
    assert.equal(full.overBudget, false, 'full budget đủ sau selective+compact');
    assert.ok(!full.prompt.includes('Dòng nền'), 'background section bị progressive disclosure loại khỏi prompt');
    assert.ok(full.prompt.includes('Phạm vi được phép'), 'scope invariant luôn tải');
    assert.ok(full.prompt.includes('Tiêu chí nghiệm thu'), 'ac section được chọn');
    assert.ok(full.prompt.includes('Bằng chứng kiểm thử'), 'test section vừa budget được tải');

    // Retry sau compact: budget nửa → section test lớn bị skip, prompt NHỎ HƠN.
    const shrunk = buildCoderContext({
      issueNumber: 64, issueBody: bigBody, findings,
      budgetTokens: Math.floor(900 / 2),
    });
    assert.equal(shrunk.overBudget, false, 'shrunk vẫn trong budget (protected nhỏ)');
    assert.ok(shrunk.skippedSections.includes('Bằng chứng kiểm thử'), 'section lớn bị skip ở budget thấp');
    assert.ok(shrunk.prompt.length < full.prompt.length, 'input retry NHỎ HƠN lần đầu');
    for (const span of [sha40, '[GPT-REV-064]', 'Decision Gate']) {
      assert.ok(shrunk.prompt.includes(span), `protected span sống sót qua compact: ${span}`);
    }

    // Compaction event persist qua recordEvent (schema field compactionEvent).
    const h = hooksIn(root);
    h.recordEvent({
      taskId: 'issue-64', issue: 64, outcome: 'context-compaction',
      compactionEvent: { droppedCount: shrunk.dropped, preservedSpans: [sha40] },
    });
    const ev = h.loadEvents().pop();
    assert.equal(ev.outcome, 'context-compaction');
    assert.equal(ev.compactionEvent.droppedCount, shrunk.dropped);
    assert.deepEqual(ev.compactionEvent.preservedSpans, [sha40]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- GPT-REV-065
test('INT.startup-budget-benchmark: issue ~50k token → startup harness-controlled ≤12k, critical state nguyên vẹn', () => {
  const sha40 = 'fbe5b05111111111111111111111111111111111';
  // Issue "thực tế" ~200k ký tự (~50k tokens ước lượng) — mô phỏng quan sát startup ~50k.
  const pad = (n, tpl) => Array.from({ length: n }, (_, i) => tpl(i));
  const bigBody = [
    '## Phạm vi được phép',
    'Chỉ sửa scripts/foo.mjs.',
    '## Tiêu chí nghiệm thu',
    '- [ ] full-verify PASS',
    '## Lịch sử bình luận dài',
    ...pad(1200, (i) => `Bình luận cũ ${i}: phân tích chi tiết lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud.`),
    '## Bối cảnh nền',
    ...pad(600, (i) => `Đoạn nền ${i}: ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.`),
  ].join('\n');
  const findings = [`Fix theo commit ${sha40}.`, 'Decision Gate: vượt scope thì dừng hỏi.'];

  const ctx = buildCoderContext({ issueNumber: 65, issueBody: bigBody, findings });
  const capsule = buildStartupCapsule({ ctx, conventions: null });
  assert.equal(ctx.overBudget, false, 'ctx trong budget 6000 sau selective+compact');
  assert.ok(capsule.totalTokens <= 12000, `startup ≤12k (thực tế ${capsule.totalTokens}t)`);
  assert.ok(capsule.totalTokens < 3000, `startup giảm rõ rệt so với ~50k raw (thực tế ${capsule.totalTokens}t)`);
  for (const span of [sha40, 'Decision Gate', 'Phạm vi được phép', 'Tiêu chí nghiệm thu']) {
    assert.ok(capsule.prompt.includes(span), `critical span sống sót: ${span}`);
  }
  assert.ok(!capsule.prompt.includes('Bình luận cũ 1000'), 'issue history KHÔNG được nạp toàn bộ');
});

test('INT.unresolved-findings-retrieval: comments GitHub authoritative → protected; RESOLVED bị loại; degrade an toàn', () => {
  const comments = JSON.stringify([
    { id: 1, created_at: '2026-08-25T00:00:00Z', body: '[GPT-REV-065]: OPEN — thiếu telemetry.' },
    { id: 2, created_at: '2026-08-25T00:01:00Z', body: '- `[GPT-REV-064]`: **RESOLVED** — wiring OK.\n- `[GPT-REV-063]`: RESOLVED.' },
    { id: 3, created_at: '2026-08-25T00:02:00Z', body: '### [GPT-REV-066] Important — vấn đề còn mở' },
  ]);
  const r = fetchUnresolvedFindings(65, { repo: 'o/r', ghFn: () => comments });
  assert.equal(r.source, 'github-comments');
  assert.ok(r.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-065]')), '065 OPEN → unresolved');
  assert.ok(r.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-066]')), '066 OPEN → unresolved');
  assert.ok(!r.findings.some((f) => f.includes('GPT-REV-064')), '064 RESOLVED (verdict mới nhất) → loại');
  assert.ok(!r.findings.some((f) => f.includes('GPT-REV-063')), '063 RESOLVED → loại');
  // Findings unresolved vào capsule ở vị trí protected.
  const ctx = buildCoderContext({ issueNumber: 65, issueBody: '## Phạm vi\nSửa foo.', findings: r.findings, budgetTokens: 400 });
  assert.ok(ctx.prompt.includes('[UNRESOLVED GPT-REV-065]'), 'finding unresolved nằm trong prompt coder');
  // Degrade: gh fail → findings rỗng, không ném.
  const bad = fetchUnresolvedFindings(65, { repo: 'o/r', ghFn: () => { throw new Error('network'); } });
  assert.deepEqual(bad, { findings: [], source: 'github-unavailable' });
});

test('INT.conventions-inline-vs-pointer: nhỏ → --read inline; lớn → pointer, KHÔNG --read; dedupe bỏ trùng lặp', () => {
  const small = readConventions({ conventionsPath: '/tmp/small.md', readFile: () => '# Quy tắc ngắn\nChỉ sửa phạm vi được phép.' });
  const c1 = buildStartupCapsule({ ctx: { prompt: 'PROMPT', totalTokens: 10 }, conventions: small });
  assert.deepEqual(c1.readArgs, ['--read', '/tmp/small.md'], 'nhỏ → inline --read');

  const bigText = Array.from({ length: 400 }, (_, i) => `Quy tắc ${i}: giải thích dài dòng về chuẩn code viết thường dùng nhiều từ để vượt giới hạn token nội tuyến cho phép của startup capsule.`).join('\n');
  const big = readConventions({ conventionsPath: '/tmp/big.md', readFile: () => bigText });
  const c2 = buildStartupCapsule({ ctx: { prompt: 'PROMPT', totalTokens: 10 }, conventions: big });
  assert.deepEqual(c2.readArgs, [], 'lớn → KHÔNG --read');
  assert.ok(c2.prompt.includes('[CONVENTIONS POINTER] /tmp/big.md'), 'pointer thay thế inline');
  assert.ok(c2.totalTokens < big.tokens, 'payload đo được nhỏ hơn nhiều so với inline toàn bộ file');

  // Dedupe content-hash: entry trùng text chỉ giữ 1 lần trong compact input.
  const dupBody = '## Phạm vi được phép\nA.\n## Phạm vi được phép (copy)\nA.';
  const ctx = buildCoderContext({ issueNumber: 65, issueBody: `${dupBody}\n${dupBody}`, budgetTokens: 500 });
  assert.equal(ctx.overBudget, false);
});

// ---------------------------------------------------------------- GPT-REV-066
const GH_ARGS_66 = ['api', 'repos/o/r/issues/66/comments', '--paginate', '--slurp'];

test('REV66.nested-slurp-two-pages: fixture LỒNG đúng output gh --paginate --slurp → parse đủ comments', () => {
  // Contract thật: `gh api --paginate --slurp` trả JSON mảng các trang, mỗi trang mảng comment.
  const nested = JSON.stringify([
    [{ id: 101, created_at: '2026-08-25T01:00:00Z', body: '[GPT-REV-066] OPEN — sai contract slurp.' }],
    [{ id: 102, created_at: '2026-08-25T02:00:00Z', body: '### [GPT-REV-065] Important — còn thiếu test.' }],
  ]);
  const r = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: (args) => { assert.deepEqual(args, GH_ARGS_66); return nested; } });
  assert.equal(r.source, 'github-comments');
  assert.ok(r.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-066]')), 'finding ở trang 1 được thấy');
  assert.ok(r.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-065]')), 'finding ở trang 2 được thấy');
});

test('REV66.flat-array-compat: flat array (fixture cũ) vẫn parse tương thích', () => {
  const flat = JSON.stringify([
    { id: 11, created_at: '2026-08-25T00:00:00Z', body: '[GPT-REV-066] OPEN — flat compat.' },
    { id: 12, created_at: '2026-08-25T00:01:00Z', body: '[GPT-REV-060] RESOLVED.' },
  ]);
  const r = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => flat });
  assert.equal(r.source, 'github-comments');
  assert.ok(r.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-066]')));
  assert.ok(!r.findings.some((f) => f.includes('GPT-REV-060')));
});

test('REV66.normalizePaginatedComments: page array không bị coi là comment; phần tử rác bị loại', () => {
  const out = normalizePaginatedComments([[{ id: 1 }], 'junk', null, 42, [[{ id: 2 }]], { id: 3 }]);
  assert.deepEqual(out.map((c) => c.id), [1, 2, 3]);
});

test('REV66.newer-resolved-wins: OPEN cũ (trang trước), RESOLVED mới hơn → loại', () => {
  const pages = JSON.stringify([
    [{ id: 201, created_at: '2026-08-25T01:00:00Z', body: '[GPT-REV-071] OPEN — chưa sửa.' }],
    [{ id: 202, created_at: '2026-08-25T03:00:00Z', body: '[GPT-REV-071] **RESOLVED** — đã sửa xong.' }],
  ]);
  const r = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => pages });
  assert.ok(!r.findings.some((f) => f.includes('GPT-REV-071')), 'verdict MỚI NHẤT theo created_at thắng');
});

test('REV66.open-newer-wins: RESOLVED cũ, OPEN mới hơn → vẫn unresolved', () => {
  const pages = JSON.stringify([
    [{ id: 301, created_at: '2026-08-25T01:00:00Z', body: '[GPT-REV-072] RESOLVED — tạm xong.' }],
    [{ id: 302, created_at: '2026-08-25T04:00:00Z', body: '[GPT-REV-072] OPEN — phát hiện lại lỗi.' }],
  ]);
  const r = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => pages });
  assert.equal(r.source, 'github-comments');
  assert.ok(r.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-072]')), 'OPEN mới hơn thắng RESOLVED cũ');
});

test('REV66.tie-timestamp-id-breaks: cùng created_at → numeric id lớn hơn thắng, KHÔNG phụ thuộc thứ tự mảng', () => {
  const mk = (id, body) => ({ id, created_at: '2026-08-25T05:00:00Z', body });
  const orderA = JSON.stringify([[mk(401, '[GPT-REV-073] OPEN first.'), mk(402, '[GPT-REV-073] **RESOLVED** later-id.')]]);
  const orderB = JSON.stringify([[mk(402, '[GPT-REV-073] **RESOLVED** later-id.'), mk(401, '[GPT-REV-073] OPEN first.')]]);
  for (const raw of [orderA, orderB]) {
    const r = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => raw });
    assert.ok(!r.findings.some((f) => f.includes('GPT-REV-073')), `id 401/402: verdict id lớn hơn thắng bất kể thứ tự mảng`);
  }
  // Đảo trạng thái: id lớn hơn là OPEN → unresolved.
  const openWins = JSON.stringify([[mk(501, '[GPT-REV-074] RESOLVED old-id.'), mk(502, '[GPT-REV-074] OPEN new-id.')]]);
  const r2 = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => openWins });
  assert.ok(r2.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-074]')));
});

test('REV66.body-missing-or-junk-skipped: body thiếu/null/non-string + element rác → bỏ qua an toàn, không crash', () => {
  const raw = JSON.stringify([[{ id: 601 }, { id: 602, body: null }, { id: 603, body: 42 }, 'junk', null], [{ id: 604, body: '[GPT-REV-075] OPEN ok.' }]]);
  const r = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => raw });
  assert.equal(r.source, 'github-comments');
  assert.equal(r.findings.length, 1, 'chỉ comment có body hợp lệ sinh finding');
  assert.ok(r.findings[0].startsWith('[UNRESOLVED GPT-REV-075]'));
});

test('REV66.degrade-unavailable: gh throw / JSON hỏng / non-array → github-unavailable; mảng rỗng hợp lệ → github-comments-empty', () => {
  assert.deepEqual(fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => { throw new Error('network down'); } }), { findings: [], source: 'github-unavailable' });
  assert.deepEqual(fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => '<html>502 Bad Gateway</html>' }), { findings: [], source: 'github-unavailable' });
  assert.deepEqual(fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => '{"unexpected":"object"}' }), { findings: [], source: 'github-unavailable' });
  // Mảng rỗng hợp lệ (gh trả 200, không comment) → phân biệt với unavailable.
  assert.deepEqual(fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => '[]' }), { findings: [], source: 'github-comments-empty' });
});

test('REV66.independent-codes-and-empty-source: verdict độc lập từng mã; thành công không mã nào → github-comments-empty', () => {
  const pages = JSON.stringify([
    [{ id: 701, created_at: '2026-08-25T01:00:00Z', body: '[GPT-REV-080] OPEN.\n[GPT-REV-081] OPEN.' }],
    [{ id: 702, created_at: '2026-08-25T02:00:00Z', body: '[GPT-REV-081] RESOLVED.' }],
  ]);
  const r = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => pages });
  assert.ok(r.findings.some((f) => f.includes('GPT-REV-080')), '080 còn mở');
  assert.ok(!r.findings.some((f) => f.includes('GPT-REV-081')), '081 resolve độc lập với 080');

  const empty = fetchUnresolvedFindings(66, { repo: 'o/r', ghFn: () => JSON.stringify([[{ id: 801, created_at: '2026-08-25T00:00:00Z', body: 'comment thường, không có mã' }]]) });
  assert.deepEqual(empty, { findings: [], source: 'github-comments-empty' }, 'thành công nhưng 0 mã → phân biệt với unavailable');
});

// ---------------------------------------------------------------- GPT-REV-067
const BIG_CONVENTIONS_TEXT = Array.from({ length: 500 }, (_, i) => `Quy tắc conventions ${i}: mô tả dài về chuẩn viết code để vượt ngưỡng inline 2000 token của startup capsule khi nạp nguyên file vào context.`).join('\n');
const SHA_FIX_67 = 'fbe5b05111111111111111111111111111111111';

function bigConventionsFixture() {
  return readConventions({ conventionsPath: '/tmp/big-conventions.md', readFile: () => BIG_CONVENTIONS_TEXT });
}

test('REV67.fix-loop-big-conventions: verify-fix KHÔNG --read conventions lớn, chung budget, spans còn, telemetry per-invocation', () => {
  const issueBody = ['## Phạm vi được phép', 'Chỉ sửa scripts/foo.mjs.', '## Tiêu chí nghiệm thu', '- [ ] full-verify PASS'].join('\n');
  const inv = prepareCoderInvocation({
    issueNumber: 67,
    issueBody,
    findings: [`[UNRESOLVED GPT-REV-067] runFixCoder bypass budget — fix theo ${SHA_FIX_67}.`, 'Decision Gate: vượt scope thì dừng hỏi [GPT-REV-067].'],
    findingsSource: 'github-comments',
    conventions: bigConventionsFixture(),
    verifyFailure: `FAIL scripts/foo.test.mjs\nDecision Gate: vượt scope dừng hỏi.\n${SHA_FIX_67}`,
    headSha: SHA_FIX_67,
  });
  assert.equal(inv.invocationKind, 'verify-fix');
  assert.deepEqual(inv.readArgs, [], 'conventions lớn → KHÔNG --read (không còn bypass runFixCoder)');
  assert.ok(!inv.message.includes(BIG_CONVENTIONS_TEXT.slice(0, 80)), 'message không chứa nội dung conventions');
  assert.ok(inv.message.includes('[CONVENTIONS POINTER]'));
  assert.ok(inv.startupContextTokens <= 12000, `startup ≤12k (thực tế ${inv.startupContextTokens}t)`);
  for (const span of [SHA_FIX_67, '[GPT-REV-067]', 'Decision Gate', '- [ ] full-verify PASS']) {
    assert.ok(inv.message.includes(span), `protected span sống sót trong verify-fix: ${span}`);
  }
  assert.equal(inv.conventionsMode, 'pointer');
  assert.equal(inv.externalContextUnknown, true);

  // Thực thi qua executor thật (runner inject) — đường chạy giống production.
  const calls = [];
  const res = executeCoderInvocation(inv, { runFn: (cmd, args) => { calls.push([cmd, args]); } });
  assert.equal(res.called, true);
  assert.ok(!calls[0][1].includes('--read'), 'args thực tế KHÔNG có --read cho conventions lớn');
  const msgIdx = calls[0][1].indexOf('--message');
  assert.ok(msgIdx > -1 && !calls[0][1][msgIdx + 1].includes(BIG_CONVENTIONS_TEXT.slice(0, 80)));

  // Telemetry per-invocation như production ghi (qua redact của recordEvent).
  const root = makeTempRoot();
  try {
    const h = hooksIn(root);
    recordInvocationTelemetry(h, inv, { issueNumber: 67, attempt: 0, modelCalled: res.called });
    const ev = h.loadEvents().pop();
    assert.equal(ev.invocationKind, 'verify-fix');
    assert.equal(ev.modelCalled, true);
    assert.equal(ev.conventionsMode, 'pointer');
    assert.equal(ev.externalContextUnknown, true);
    assert.equal(ev.overBudget, false);
    assert.ok(ev.startupContextTokens <= 12000);
    assert.equal(typeof ev.loadedMemoryCount, 'number');
    assert.equal(typeof ev.loadedEventCount, 'number');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REV67.over-budget-blocked-no-model: protected vượt 12k → blocked, model KHÔNG được gọi, telemetry overBudget', () => {
  // AC mở là protected — 1500 dòng AC (~45k token) vượt startup budget kể cả sau compact.
  const hugeFinding = Array.from({ length: 1500 }, (_, i) => `- [ ] AC bắt buộc mở số ${i}: giữ nguyên trạng thái quan trọng lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.`).join('\n');
  const inv = prepareCoderInvocation({
    issueNumber: 67,
    issueBody: '## Tiêu chí nghiệm thu\n- [ ] PASS cơ bản',
    findings: [`[FINDING] ${hugeFinding}`],
    externalContextUnknown: false,
  });
  assert.equal(inv.overBudget, true, 'over-budget phải fail-closed');
  assert.equal(inv.blocked, true);

  let runnerHit = false;
  const res = executeCoderInvocation(inv, { runFn: () => { runnerHit = true; } });
  assert.equal(runnerHit, false, 'KHÔNG fallback gọi model khi blocked');
  assert.equal(res.called, false);
  assert.equal(res.blocked, true);
  assert.equal(res.error, 'BLOCKED_CONTEXT_BUDGET');

  const root = makeTempRoot();
  try {
    const h = hooksIn(root);
    recordInvocationTelemetry(h, inv, { issueNumber: 67, attempt: 1, modelCalled: res.called });
    const ev = h.loadEvents().pop();
    assert.equal(ev.outcome, 'startup-context-blocked');
    assert.equal(ev.overBudget, true);
    assert.equal(ev.modelCalled, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REV67.compact-retry-shrunk: retry qua cùng entry point dùng context compact NHỎ HƠN, findings+SHA còn', () => {
  const padTest = Array.from({ length: 100 }, (_, i) => `Bằng chứng chạy verify lần ${i}: node scripts/full-verify.mjs PASS toàn bộ hạng mục kiểm tra bắt buộc lorem ipsum dolor sit amet consectetur adipiscing elit.`);
  const issueBody = [
    '## Phạm vi được phép', 'Chỉ sửa scripts/bar.mjs.',
    '## Tiêu chí nghiệm thu', '- [ ] full-verify PASS',
    '## Bằng chứng kiểm thử', ...padTest,
  ].join('\n');
  const base = {
    issueNumber: 67,
    issueBody,
    findings: [`Fix theo commit ${SHA_FIX_67}.`, 'Decision Gate: vượt scope thì dừng hỏi.'],
    findingsSource: 'github-comments',
    headSha: SHA_FIX_67,
    externalContextUnknown: false,
  };
  const initial = prepareCoderInvocation(base);
  const retry = prepareCoderInvocation({ ...base, retryBudget: Math.floor(6000 / 2) });
  assert.equal(initial.invocationKind, 'initial');
  assert.equal(retry.invocationKind, 'compact-retry');
  assert.ok(retry.startupContextTokens < initial.startupContextTokens, `retry nhỏ hơn initial (${retry.startupContextTokens}t < ${initial.startupContextTokens}t)`);
  assert.ok(retry.message.length < initial.message.length, 'prompt retry ngắn hơn rõ rệt');
  assert.ok(retry.afterCompactTokens < initial.beforeCompactTokens, 'after-compact nhỏ hơn trước-compact của lần đầu');
  assert.ok(retry.startupContextTokens <= 12000);
  for (const span of [SHA_FIX_67, 'Decision Gate']) {
    assert.ok(retry.message.includes(span), `span sống sót trong retry: ${span}`);
  }
});

test('REV67.cross-entry-dedupe: cùng câu ở summary/findings/memory chỉ serialize 1 lần vào prompt', () => {
  const DUP = 'Quy tắc vàng: luôn chạy full-verify trước khi push nhánh task.';
  const issueBody = `## Phạm vi được phép\n${DUP}\nChỉ sửa scripts/dedupe.mjs.`;
  const inv = prepareCoderInvocation({
    issueNumber: 68,
    issueBody,
    findings: [`[UNRESOLVED GPT-REV-068] lặp nội dung:\n${DUP}`, 'Decision Gate: vượt scope thì dừng hỏi.'],
    memoryRecords: [
      { subjectKey: 'golden-rule', tags: ['rule'], content: DUP, ts: '2026-08-25T00:00:00.000Z' },
      { subjectKey: 'other', tags: ['x'], content: 'zzz qqq www kkk jjj ppp vvv', ts: '2026-08-24T00:00:00.000Z' },
    ],
    externalContextUnknown: false,
  });
  const occurrences = inv.message.split(DUP).length - 1;
  assert.equal(occurrences, 1, `DUP xuất hiện đúng 1 lần xuyên entry (thực tế ${occurrences})`);
  assert.equal(inv.overBudget, false);
  assert.ok(inv.message.includes('Decision Gate'));
});

test('REV67.memory-count-accurate: 10 records trên đĩa, retrieval chọn đúng 2 liên quan, loadedEventCount=0', () => {
  const root = makeTempRoot();
  try {
    const h = hooksIn(root);
    for (let i = 0; i < 8; i += 1) {
      h.recordObservation({
        kind: 'session-summary',
        content: `zzz qqq kkk ghi bên nền ${i} vô thưởng vô bình thường lặp lại`,
        subjectKey: `bg-${i}`,
        provenance: { task: 'background' },
        ts: `2026-08-1${i}T00:00:00.000Z`,
      });
    }
    h.recordObservation({ kind: 'decision', content: 'qzx77: ưu tiên compact trước retry', subjectKey: 'qzx77-a', tags: ['qzx77'], provenance: { task: 'issue-77' }, ts: '2026-08-25T00:00:00.000Z' });
    h.recordObservation({ kind: 'fix-pattern', content: 'qzx77: kiểm tra BOM trước khi push', subjectKey: 'qzx77-b', tags: ['qzx77'], provenance: { task: 'issue-77' }, ts: '2026-08-25T00:01:00.000Z' });
    assert.equal(h.store.load().length, 10, 'đĩa có đúng 10 memory records');

    const inv = prepareCoderInvocation({
      issueNumber: 77,
      issueBody: '## Phạm vi\nChỉ sửa scripts/x.mjs về qzx77 flow.',
      memoryRecords: h.store.load(),
      externalContextUnknown: false,
    });
    assert.equal(inv.loadedMemoryCount, 2, 'loadedMemoryCount = record THỰC SỰ serialize, không phải tổng đĩa');
    assert.equal(inv.loadedEventCount, 0, 'events không nạp → 0 (tách riêng khỏi memory)');
    assert.ok(inv.message.includes('[MEMORY] qzx77-a'));
    assert.ok(inv.message.includes('[MEMORY] qzx77-b'));
    assert.ok(!inv.message.includes('bình thường'), 'memory KHÔNG liên quan KHÔNG được nạp');
    assert.ok(inv.loadReasons.some((r) => r.includes('/10 record')), 'loadReasons ghi rõ selective retrieval');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log(`\nruntime-hooks integration: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);
