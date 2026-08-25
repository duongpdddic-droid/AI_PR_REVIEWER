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
import { buildCoderContext, buildStartupCapsule, fetchUnresolvedFindings, readConventions } from './autonomous-run.mjs';

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
    { body: '[GPT-REV-065]: OPEN — thiếu telemetry.' },
    { body: '- `[GPT-REV-064]`: **RESOLVED** — wiring OK.\n- `[GPT-REV-063]`: RESOLVED.' },
    { body: '### [GPT-REV-066] Important — vấn đề còn mở' },
  ]);
  const r = fetchUnresolvedFindings(65, { repo: 'o/r', ghFn: () => comments });
  assert.equal(r.source, 'github');
  assert.ok(r.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-065]')), '065 OPEN → unresolved');
  assert.ok(r.findings.some((f) => f.startsWith('[UNRESOLVED GPT-REV-066]')), '066 OPEN → unresolved');
  assert.ok(!r.findings.some((f) => f.includes('GPT-REV-064')), '064 RESOLVED (verdict mới nhất) → loại');
  assert.ok(!r.findings.some((f) => f.includes('GPT-REV-063')), '063 RESOLVED → loại');
  // Findings unresolved vào capsule ở vị trí protected.
  const ctx = buildCoderContext({ issueNumber: 65, issueBody: '## Phạm vi\nSửa foo.', findings: r.findings, budgetTokens: 400 });
  assert.ok(ctx.prompt.includes('[UNRESOLVED GPT-REV-065]'), 'finding unresolved nằm trong prompt coder');
  // Degrade: gh fail → findings rỗng, không ném.
  const bad = fetchUnresolvedFindings(65, { repo: 'o/r', ghFn: () => { throw new Error('network'); } });
  assert.deepEqual(bad, { findings: [], source: 'unavailable' });
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

console.log(`\nruntime-hooks integration: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);
