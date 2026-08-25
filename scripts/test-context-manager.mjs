#!/usr/bin/env node
// test-context-manager.mjs — Context compact/budget/progressive disclosure (Issue #9 B1–B3).
// Assert-based (AAA), không framework, không phụ thuộc thứ tự.
import assert from 'node:assert/strict';
import { compactTranscript, estimateTokens, extractProtectedSpans, selectiveLoad } from './context-manager.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${(e && e.message) || e}`); process.exitCode = 1; }
};

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const filler = (n) => Array.from({ length: n }, (_, i) => `history line ${i}: log cũ vô nghĩa`).join('\n');

// 1. Long-context: transcript dài có unresolved finding + full SHA — compact KHÔNG mất chúng.
test('B3.long-task: unresolved finding + full SHA sống sót qua compaction', () => {
  const entries = [
    { kind: 'task', text: 'Fix Issue #9 theo AC' },
    ...Array.from({ length: 40 }, (_, i) => ({ kind: 'tool-result', text: filler(20) + ` (chunk ${i})` })),
    { kind: 'finding', text: `[LOCAL-REV-003] Missing authz check at scripts/x.js:42 — risk: IDOR. Expected: deny non-owner.` },
    { kind: 'evidence', text: `Verified CI run 123 tại HEAD ${SHA} SUCCESS` },
    ...Array.from({ length: 40 }, (_, i) => ({ kind: 'history', text: filler(20) + ` (old ${i})` })),
  ];
  const r = compactTranscript({ entries, budgetTokens: 400 });
  const allText = [...r.kept.map((e) => e.text), r.summary ? r.summary.text : ''].join('\n');
  assert.ok(allText.includes('[LOCAL-REV-003]'), 'finding ID còn nguyên');
  assert.ok(allText.includes(SHA), 'full SHA còn nguyên');
  assert.ok(r.kept.some((e) => e.kind === 'finding'), 'finding entry được giữ');
});

// 2. Approval invariant + Decision Gate giữ nguyên văn qua compaction.
test('B3.approval-invariant: approval state không mất qua compaction', () => {
  const entries = [
    { kind: 'policy-invariant', text: 'Approval chỉ hợp lệ khi khóa đúng full HEAD SHA + policyVersion.' },
    { kind: 'decision-gate', text: 'Decision Gate: merge do người dùng chốt sau GPT approval.' },
    ...Array.from({ length: 60 }, (_, i) => ({ kind: 'history', text: filler(30) + ` (${i})` })),
  ];
  const r = compactTranscript({ entries, budgetTokens: 200 });
  assert.ok(r.kept.some((e) => e.kind === 'policy-invariant'), 'policy-invariant giữ nguyên văn');
  assert.ok(r.kept.some((e) => e.kind === 'decision-gate'), 'decision-gate giữ nguyên văn');
});

// 3. Open acceptance criteria ("- [ ]") sống sót: entry chứa AC được protect, phần còn lại compact.
test('B3.open-ac: acceptance criteria mở không bị compact mất', () => {
  const acEntry = { kind: 'history', text: 'plan còn dở:\n- [ ] AC chưa xong: mapping AC→evidence\n- [ ] AC chưa xong: CI read-back' };
  const entries = [
    ...Array.from({ length: 50 }, (_, i) => ({ kind: 'history', text: `old ${i}` })),
    acEntry,
  ];
  const r = compactTranscript({ entries, budgetTokens: 100 });
  const sumText = r.summary ? r.summary.text : '';
  assert.ok(r.dropped > 0, 'có entry bị compact');
  assert.ok(r.kept.some((e) => e.text.includes('- [ ] AC chưa xong')), 'entry chứa AC mở được giữ');
  assert.ok(sumText.startsWith('[compacted'), 'summary ghi evidence compaction');
});

// 4. Budget được enforce: tổng token sau compact không tràn vô kiểm soát.
test('B3.budget-enforced: totalTokens <= budget + phần protected nhỏ', () => {
  const entries = [
    { kind: 'task', text: 'current task nhỏ' },
    ...Array.from({ length: 100 }, (_, i) => ({ kind: 'tool-result', text: filler(50) + ` t${i}` })),
  ];
  const r = compactTranscript({ entries, budgetTokens: 300 });
  assert.ok(r.totalTokens <= 300 + estimateTokens('current task nhỏ') + 10,
    `totalTokens=${r.totalTokens} phải sát budget`);
  assert.equal(r.overBudget, false);
});

// 5. Protected vượt budget vẫn giữ (không drop state) + overBudget=true để caller escalate.
test('edge.protected-over-budget: không drop protected, báo overBudget', () => {
  const entries = [{ kind: 'decision-gate', text: 'Decision Gate: ' + 'x'.repeat(5000) }];
  const r = compactTranscript({ entries, budgetTokens: 10 });
  assert.equal(r.kept.length, 1, 'protected không bị drop');
  assert.equal(r.overBudget, true, 'overBudget=true để caller escalate');
});

// 6. Budget sai -> fail-closed.
test('edge.invalid-budget: budgetTokens <= 0 throw BLOCKED_BUDGET_INVALID', () => {
  assert.throws(() => compactTranscript({ entries: [], budgetTokens: 0 }), /BLOCKED_BUDGET_INVALID/);
  assert.throws(() => selectiveLoad({ index: [], neededTags: ['x'], budgetTokens: -1 }), /BLOCKED_BUDGET_INVALID/);
});

// 7. Selective retrieval: chỉ tải entry liên quan; invariant luôn tải kể cả khi hết budget.
test('B3.selective-retrieval: chỉ tải tag liên quan, invariant luôn tải', () => {
  const index = [
    { name: '_invariants', invariant: true, tags: [], content: 'INVARIANT CONTENT' },
    { name: 'coder-guide', tags: ['coder'], content: 'C' },
    { name: 'reviewer-guide', tags: ['reviewer'], content: 'R' },
    { name: 'policy-detail', tags: ['policy'], content: 'P' },
  ];
  const r = selectiveLoad({ index, neededTags: ['coder'], budgetTokens: 1000 });
  assert.deepEqual(r.loaded.map((l) => l.name).sort(), ['_invariants', 'coder-guide'],
    'chỉ invariant + coder được tải');
  // Entry không khớp tag không phải candidate → không nằm loaded lẫn skipped.
  assert.deepEqual(r.skipped, []);
  const tight = selectiveLoad({ index, neededTags: ['coder', 'reviewer'], budgetTokens: 5 });
  assert.ok(tight.loaded.some((l) => l.name === '_invariants'), 'invariant không bị budget chặn');
  assert.deepEqual(tight.skipped.sort(), ['coder-guide', 'reviewer-guide'],
    'candidate hết budget bị skip, không tải');
  assert.ok(!tight.loaded.some((l) => l.name === 'policy-detail'), 'tag ngoài needed không bao giờ tải');
});

// 8. extractProtectedSpans nhận diện SHA/finding-ID/Decision Gate.
test('unit.extract-protected-spans', () => {
  const spans = extractProtectedSpans(`head ${SHA} tail [CLINE-FIX-049] và Decision Gate đang mở cho PR #8`);
  assert.ok(spans.includes(SHA));
  assert.ok(spans.includes('[CLINE-FIX-049]'));
  assert.ok(spans.some((s) => s.startsWith('Decision Gate')));
});

// 9. GPT-REV-060 negative: unprotected-only transcript, tombstone summary đẩy vượt budget
//    → overBudget=true (không phụ thuộc có protected entry).
test('edge.unprotected-summary-over-budget: summary đẩy vượt budget vẫn báo overBudget', () => {
  // 2 entries history thuần (không protected): 1 vừa khít budget, 1 bị drop → summary cộng thêm.
  const bigText = 'x'.repeat(200); // ~50 tokens
  const r = compactTranscript({
    entries: [
      { kind: 'history', text: bigText },
      { kind: 'history', text: `${bigText} dropped part` }, // bị drop vì tràn → sinh tombstone
    ],
    budgetTokens: 50,
  });
  assert.equal(r.dropped, 1, 'entry thứ 2 bị compact');
  assert.ok(r.summary, 'có tombstone summary');
  assert.ok(r.totalTokens > 50, `totalTokens=${r.totalTokens} phải vượt budget`);
  assert.equal(r.overBudget, true, 'overBudget=true dù KHÔNG có protected entry');
});

// 10. GPT-REV-060 negative: nhiều invariants vượt budget → vẫn bảo toàn nhưng báo overBudget.
test('edge.invariants-over-budget: invariants giữ nguyên + overBudget=true để escalate', () => {
  const inv = (n) => ({ name: `_inv${n}`, invariant: true, tags: [], content: 'I'.repeat(100) });
  const index = [inv(1), inv(2), inv(3)];
  const r = selectiveLoad({ index, neededTags: ['coder'], budgetTokens: 10 });
  assert.equal(r.loaded.length, 3, 'mọi invariant vẫn được tải');
  assert.ok(r.overBudget === true, 'overBudget=true — caller phải escalate/compact tiếp');
  assert.ok(r.totalTokens > 10);
});

// 11. GPT-REV-060: kết quả không bao giờ im lặng nhận là budget-enforced khi vượt.
test('edge.never-silent-over-budget: mọi trường hợp vượt đều có cờ', () => {
  const cases = [
    compactTranscript({ entries: [{ kind: 'decision-gate', text: 'Decision Gate: ' + 'y'.repeat(300) }], budgetTokens: 5 }),
    compactTranscript({ entries: [{ kind: 'history', text: 'z'.repeat(400) }], budgetTokens: 5 }),
    selectiveLoad({ index: [{ name: 'i', invariant: true, tags: [], content: 'w'.repeat(80) }], neededTags: ['x'], budgetTokens: 4 }),
  ];
  for (const r of cases) {
    if (r.totalTokens > (r.kept ? 5 : 4)) {
      assert.equal(r.overBudget, true, `totalTokens=${r.totalTokens} nhưng overBudget sai`);
    }
  }
});

console.log(`\ncontext-manager: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);

