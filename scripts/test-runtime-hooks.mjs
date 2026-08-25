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
import { createRuntimeHooks } from './runtime-hooks.mjs';

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
    const h1 = createRuntimeHooks({ rootDir: root });
    const r = h1.recordObservation({
      kind: 'decision', content: 'Chọn JSONL stdlib thay DB', subjectKey: 'decision-storage',
      provenance: { task: 'issue-9' }, ts: '2026-08-25T00:00:00.000Z',
    });
    assert.equal(r.ok, true, 'recordObservation ok');
    const raw = fs.readFileSync(h1.paths.memory, 'utf8');
    assert.ok(raw.includes('JSONL stdlib thay DB'), 'byte thực sự ghi xuống file');

    // "Restart": instance mới cùng root → load lại được dữ liệu cũ.
    const h2 = createRuntimeHooks({ rootDir: root });
    const entries = h2.store.load();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'Chọn JSONL stdlib thay DB');
    assert.equal(entries[0].provenance.task, 'issue-9', 'provenance giữ nguyên qua restart');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INT.event-redacted-on-disk: telemetry event lồng secret → file KHÔNG chứa secret gốc', () => {
  const root = makeTempRoot();
  try {
    const h = createRuntimeHooks({ rootDir: root });
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
    const h = createRuntimeHooks({ rootDir: root });
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
    const h = createRuntimeHooks({ rootDir: root });
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
    const h = createRuntimeHooks({
      rootDir: root,
      io: {
        readFile: () => { throw new Error('disk exploded'); },
        appendFile: () => { throw new Error('disk full'); },
      },
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
    const h = createRuntimeHooks({ rootDir: root });
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
    const kept = createRuntimeHooks({ rootDir: root }).store.load();
    assert.ok(kept.length <= 3, `bounded growth: còn ${kept.length} <= 3`);
    assert.equal(kept[kept.length - 1].content, 'summary v4', 'bản ts MỚI NHẤT của subject thắng');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('INT.no-silent-store: store không có IO ghi → stored:false, không báo stored giả', () => {
  const root = makeTempRoot();
  try {
    // io:{} tường minh = caller từ chối IO → append phải stored:false (GPT-REV-059).
    const h = createRuntimeHooks({ rootDir: root, io: {} });
    const r = h.recordObservation({ kind: 'decision', content: 'no io', provenance: { task: 't' }, ts: '2026-08-25T00:00:00.000Z' });
    assert.equal(r.ok, false);
    assert.equal(r.stored, false);
    assert.equal(r.reason, 'no-storage-io');
    // Default (không truyền io) dùng fs thật → ghi byte thật.
    const hd = createRuntimeHooks({ rootDir: root });
    const rd = hd.recordObservation({ kind: 'pointer', content: 'https://github.com/x/y/pull/10', provenance: { task: 't' }, ts: '2026-08-25T00:00:00.000Z' });
    assert.equal(rd.ok, true, 'default fs io ghi thật');
    assert.ok(fs.existsSync(hd.paths.memory), 'file tồn tại sau append');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log(`\nruntime-hooks integration: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);
