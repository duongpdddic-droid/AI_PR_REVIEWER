#!/usr/bin/env node
// test-memory-core.mjs — Persistent memory: guard verdict, consolidation, retrieval,
// stale-memory, graceful degradation (Issue #9 C1–C5 + AC).
// Assert-based (AAA), không framework, không phụ thuộc thứ tự.
import assert from 'node:assert/strict';
import {
  ALLOWED_KINDS, consolidateMemories, createMemoryStore, resolveState,
  retrieveMemories, validateObservation, withGracefulDegradation,
} from './memory-core.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${(e && e.message) || e}`); process.exitCode = 1; }
};

const prov = (task = 'issue-9') => ({ task, repo: 'duongpdddic-droid/AI_PR_REVIEWER', ref: 'feat/issue-9' });

// 1. Happy path: observation hợp lệ được append và load lại nguyên vẹn.
test('C2.happy: append + load roundtrip giữ provenance/timestamp', () => {
  let buf = '';
  const store = createMemoryStore({ file: 'mem.jsonl', io: { readFile: () => buf, appendFile: (f, s) => { buf += s; } } });
  const r = store.append({ kind: 'fix-pattern', content: 'Token expiry dùng <= không phải <', ts: '2026-08-25T01:00:00Z', provenance: prov() });
  assert.equal(r.stored, true);
  const loaded = store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].provenance.task, 'issue-9');
  assert.equal(loaded[0].ts, '2026-08-25T01:00:00Z');
});

// 2. Guard C1: memory KHÔNG được dùng để giả lập CI/approval/authorization.
test('C1.guard-verdict: cấm lưu ci-verdict/approval/merge-authorization', () => {
  for (const kind of ['ci-verdict', 'approval', 'merge-authorization']) {
    const v = validateObservation({ kind, content: 'CI PASS tại HEAD abc', ts: '2026-08-25T00:00:00Z', provenance: prov() });
    assert.equal(v.ok, false, `${kind} phải bị từ chối`);
    assert.match(v.error, /cấm lưu|authoritative/i);
  }
  // Bản ghi pointer (tham chiếu URL/SHA + thời điểm đọc) vẫn hợp lệ.
  const ok = validateObservation({
    kind: 'pointer',
    content: 'CI run 1234567890 SUCCESS quan sát tại 25/08 — xác minh lại bằng gh api trước khi tin',
    tags: ['ci'], ts: '2026-08-25T00:00:00Z', provenance: prov(),
  });
  assert.equal(ok.ok, true, 'pointer tham chiếu được phép');
});

// 3. Observation lỗi/không hợp lệ không ném — append trả stored:false kèm reason.
test('edge.invalid-obs: thiếu provenance/ts → stored:false không throw', () => {
  const store = createMemoryStore({ file: 'm.jsonl' });
  const r = store.append({ kind: 'decision', content: 'x' }); // thiếu provenance + ts
  assert.equal(r.stored, false);
  assert.match(r.reason, /provenance|timestamp/);
});

// 4. Storage failure → graceful degradation (không hỏng workflow caller).
test('AC.memory-failure-graceful: IO fail không ném, báo storage-failure', () => {
  const store = createMemoryStore({
    file: 'm.jsonl',
    io: { readFile: () => { throw new Error('EACCES'); }, appendFile: () => { throw new Error('EDISK FULL'); } },
  });
  const r = store.append({ kind: 'convention', content: 'pnpm only', ts: '2026-08-25T00:00:00Z', provenance: prov() });
  assert.equal(r.stored, false);
  assert.match(r.reason, /storage-failure/);
});

// 5. Load khoan dung: dòng corrupt/bản ghi sai schema bị skip + warning, không chết store.
test('C5.tolerant-load: corrupt line skip + warning', () => {
  const raw = [
    JSON.stringify({ kind: 'convention', content: 'a', ts: '2026-08-24T00:00:00Z', provenance: prov() }),
    '{broken json',
    JSON.stringify({ kind: 'not-a-kind', content: 'b', ts: '2026-08-24T00:00:00Z', provenance: prov() }),
  ].join('\n');
  const store = createMemoryStore({ file: 'm.jsonl', io: { readFile: () => raw } });
  const loaded = store.load();
  assert.equal(loaded.length, 1);
  assert.ok(store.warnings.length >= 2, `warnings=${JSON.stringify(store.warnings)}`);
});

// 6. Consolidation: supersede theo subjectKey (mới thắng), dedupe content, cap bounded growth.
test('C4.consolidation: supersede + dedupe + cap, provenance giữ nguyên', () => {
  const e1 = { kind: 'fix-pattern', subjectKey: 'token-expiry', content: 'dùng < (sai)', ts: '2026-08-24T01:00:00Z', provenance: prov('issue-7') };
  const e2 = { kind: 'fix-pattern', subjectKey: 'token-expiry', content: 'dùng <= (đúng)', ts: '2026-08-25T01:00:00Z', provenance: prov('issue-9') };
  const dup = { kind: 'convention', content: 'pnpm only', ts: '2026-08-25T02:00:00Z', provenance: prov() };
  const dupCopy = { kind: 'convention', content: 'PNPM   ONLY', ts: '2026-08-25T03:00:00Z', provenance: prov() };
  const out = consolidateMemories([e1, e2, dup, dupCopy]);
  const subjects = out.filter((e) => e.subjectKey === 'token-expiry');
  assert.equal(subjects.length, 1, 'supersede: chỉ còn bản mới');
  assert.equal(subjects[0].ts, '2026-08-25T01:00:00Z');
  assert.equal(out.filter((e) => /\bpnpm\s+only\b/i.test(e.content)).length, 1, 'dedupe content trùng (chuẩn hoá hoa/thường + khoảng trắng)');
  // Bounded growth:
  const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'session-summary', content: `unique ${i}`, ts: `2026-08-01T00:${String(i).padStart(2, '0')}:00Z`, provenance: prov() }));
  const capped = consolidateMemories(many, { maxEntries: 10 });
  assert.equal(capped.length, 10, 'cap maxEntries');
  assert.equal(capped[0].content, 'unique 40', 'bỏ cũ nhất, giữ mới nhất');
});

// 7. Selective retrieval precision bằng fixture.
test('C4.retrieval-precision: query đúng chủ đề trả đúng entry', () => {
  const entries = [
    { kind: 'fix-pattern', content: 'clasp push cần full-verify PASS trước', tags: ['gas'], ts: '2026-08-20T00:00:00Z', provenance: prov() },
    { kind: 'workflow-failure', content: 'telegram 409 conflict khi chạy listen song song daemon', tags: ['telegram'], ts: '2026-08-21T00:00:00Z', provenance: prov() },
    { kind: 'decision', content: 'watchdog hibernate chỉ qua notify-telegram arm', tags: ['watchdog'], ts: '2026-08-22T00:00:00Z', provenance: prov() },
  ];
  const r = retrieveMemories(entries, { query: 'telegram conflict listen', limit: 2 });
  assert.ok(r.length >= 1);
  assert.match(r[0].entry.content, /409 conflict/, 'top hit đúng chủ đề telegram');
  const none = retrieveMemories(entries, { query: 'kubernetes helm' });
  assert.deepEqual(none.map((x) => x.entry.content), [], 'query không khớp → rỗng (không đoán)');
});

// 8. Stale memory: memory claim KHÔNG thắng evidence GitHub.
test('AC.stale-memory: resolveState ưu tiên authoritative evidence', () => {
  const r = resolveState({ memoryClaim: 'PR #8 approved (nhớ từ session cũ)', authoritativeEvidence: 'OPEN + status:review-requested' });
  assert.equal(r.source, 'github');
  assert.equal(r.state, 'OPEN + status:review-requested');
  assert.equal(r.memoryWasStale, true, 'memory lệch được phát hiện là stale');
  const noAuth = resolveState({ memoryClaim: 'CI pass run 123' });
  assert.equal(noAuth.source, 'memory-only-unverified', 'không có read-back → không xác nhận');
});

// 9. withGracefulDegradation: lỗi async không ném ra ngoài workflow (chạy ở IIFE cuối).

// 10. ALLOWED_KINDS đủ phạm vi C1.
test('unit.allowed-kinds', () => {
  for (const k of ['decision', 'fix-pattern', 'workflow-failure', 'provider-failure', 'convention', 'session-summary', 'unresolved-context', 'pointer']) {
    assert.ok(ALLOWED_KINDS.has(k), `thiếu kind ${k}`);
  }
});

// Chạy test async cuối cùng rồi tổng kết.
(async () => {
  await test('AC.graceful-degradation-wrapper: async fail → degraded:true, không ném', async () => {
    const bad = await withGracefulDegradation(async () => { throw new Error('store exploded'); }, []);
    assert.equal(bad.ok, false);
    assert.equal(bad.degraded, true);
    assert.deepEqual(bad.fallbackValue, []);
    const good = await withGracefulDegradation(async () => 42);
    assert.equal(good.ok, true);
    assert.equal(good.value, 42);
  });
  console.log(`\nmemory-core: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);
})();

