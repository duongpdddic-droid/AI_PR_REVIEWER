#!/usr/bin/env node
// test-error-recovery.mjs — Error taxonomy + bounded recovery + telemetry (Issue #9 D/G).
// Failure injection qua chuỗi lỗi/runtime-output giả lập. Không framework, không phụ thuộc thứ tự.
import assert from 'node:assert/strict';
import {
  classifyError, planRecovery, recordExecutionEvent, summarizeByProvider,
} from './error-recovery.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${(e && e.message) || e}`); process.exitCode = 1; }
};

const identity = { taskId: 'issue-9', baseSha: 'fbe5b05111111111111111111111111111111111', issueNumber: 9 };

// 1. Taxonomy: provider failure injection phủ đủ nhóm chính.
test('D.classify-provider-failure: RATE_LIMIT/TIMEOUT/PROVIDER_ERROR/EMPTY', () => {
  assert.equal(classifyError('API error 429: too many requests'), 'RATE_LIMIT');
  assert.equal(classifyError(new Error('request ETIMEDOUT after 30000ms')), 'TIMEOUT');
  assert.equal(classifyError('502 Bad Gateway from upstream'), 'PROVIDER_ERROR');
  assert.equal(classifyError(''), 'EMPTY_RESPONSE');
  assert.equal(classifyError(null), 'EMPTY_RESPONSE');
});

// 2. Invalid tool call + context overflow + auth + unknown.
test('D.classify-others: INVALID_TOOL_CALL/CONTEXT_OVERFLOW/AUTH/UNKNOWN', () => {
  assert.equal(classifyError('Error: Unknown tool: deploy_prod'), 'INVALID_TOOL_CALL');
  assert.equal(classifyError('prompt is too long: 200000 tokens > max context length'), 'CONTEXT_OVERFLOW');
  assert.equal(classifyError('HTTP 401 Unauthorized: bad credentials'), 'AUTH_OR_CONFIG_ERROR');
  assert.equal(classifyError('một lỗi lạ hoàn toàn không khớp mẫu nào xyz'), 'UNKNOWN');
});

// 3. Bounded recovery: transient retry đúng budget rồi escalate.
test('AC.retry-exhaustion: hết 3 attempt → không retry nữa', () => {
  const p1 = planRecovery({ errorClass: 'RATE_LIMIT', attempts: 1, identity });
  assert.equal(p1.action, 'retry-backoff');
  assert.ok(p1.delayMs >= 1000, 'rate limit có backoff');
  const p3 = planRecovery({ errorClass: 'TIMEOUT', attempts: 3, identity });
  assert.equal(p3.action, 'escalate-blocked', 'attempts=3/max=3 → escalate');
});

// 4. Fallback mặc định KHÔNG round-robin mù; có chain tường minh mới fallback.
test('AC.no-blind-round-robin: default chain rỗng → escalate', () => {
  const p = planRecovery({ errorClass: 'PROVIDER_ERROR', attempts: 3, identity });
  assert.equal(p.action, 'escalate-blocked');
  assert.match(p.reason, /fallbackChain|round-robin/i);
});

// 5. Fallback KHÔNG bypass policy gate.
test('AC.fallback-policy-gate: gate không PASS → chặn fallback', () => {
  const chain = [{ provider: 'openrouter', model: 'free-x' }];
  const blocked = planRecovery({ errorClass: 'PROVIDER_ERROR', attempts: 3, fallbackChain: chain, policyGate: { passing: false }, identity });
  assert.equal(blocked.action, 'escalate-blocked');
  assert.match(blocked.reason, /bypass policy|không PASS/i);
  const allowed = planRecovery({ errorClass: 'PROVIDER_ERROR', attempts: 3, fallbackChain: chain, triedFallbackKeys: [], policyGate: { passing: true }, identity });
  assert.equal(allowed.action, 'fallback-model');
  assert.deepEqual(allowed.nextTarget, { provider: 'openrouter', model: 'free-x' });
});

// 6. Task identity sống sót nguyên vẹn qua mọi nhánh recovery.
test('AC.identity-survives: taskId/baseSha giữ nguyên qua retry/fallback/escalate', () => {
  const cases = [
    planRecovery({ errorClass: 'RATE_LIMIT', attempts: 1, identity }),
    planRecovery({ errorClass: 'PROVIDER_ERROR', attempts: 3, fallbackChain: [{ provider: 'p', model: 'm' }], policyGate: { passing: true }, identity }),
    planRecovery({ errorClass: 'AUTH_OR_CONFIG_ERROR', attempts: 1, identity }),
    planRecovery({ errorClass: 'CONTEXT_OVERFLOW', attempts: 3, identity }),
  ];
  for (const c of cases) assert.deepEqual(c.identity, identity, `action=${c.action} phải echo identity`);
});

// 7. AUTH_OR_CONFIG_ERROR escalate ngay — không dùng model khác để "vượt" auth.
test('edge.auth-config-error: escalate ngay, không retry/fallback', () => {
  const p = planRecovery({
    errorClass: 'AUTH_OR_CONFIG_ERROR', attempts: 0,
    fallbackChain: [{ provider: 'x', model: 'y' }], policyGate: { passing: true }, identity,
  });
  assert.equal(p.action, 'escalate-blocked');
});

// 8. CONTEXT_OVERFLOW và REPEATED_REASONING đi qua compact-then-retry rồi escalate.
test('edge.compact-then-retry: overflow/no-progress có compact trước khi bỏ', () => {
  assert.equal(planRecovery({ errorClass: 'CONTEXT_OVERFLOW', attempts: 1, identity }).action, 'compact-then-retry');
  assert.equal(planRecovery({ errorClass: 'REPEATED_REASONING', attempts: 2, identity }).action, 'compact-then-retry');
  assert.equal(planRecovery({ errorClass: 'REPEATED_REASONING', attempts: 3, identity }).action, 'escalate-blocked');
});

// 9. Fallback không lặp candidate đã thử (chain cạn → escalate).
test('edge.fallback-chain-cạn: triedFallbackKeys chặn lặp', () => {
  const p = planRecovery({
    errorClass: 'PROVIDER_ERROR', attempts: 3,
    fallbackChain: [{ provider: 'p', model: 'm' }], triedFallbackKeys: ['p/m'],
    policyGate: { passing: true }, identity,
  });
  assert.equal(p.action, 'escalate-blocked');
});

// 10. Telemetry: record redact secret + thống kê theo provider/model.
test('G.telemetry: redact secrets + summarize theo provider/model', () => {
  let evs = [];
  evs = recordExecutionEvent(evs, {
    taskId: 'issue-9', issue: 9, provider: 'anthropic', model: 'claude-x',
    attempt: 2, errorClass: 'RATE_LIMIT', outcome: 'recovered',
    note: 'token ghp_ABCDEFGHIJKLMNOPQR1234 bị lộ trong stderr',
  });
  evs = recordExecutionEvent(evs, {
    taskId: 'issue-9', provider: 'openai', model: 'gpt-y',
    attempt: 1, errorClass: 'TIMEOUT', outcome: 'failed', durationMs: 45000,
    msg: 'sk-abcdef1234567890abcdef in log',
  });
  assert.ok(!JSON.stringify(evs).includes('ghp_ABCDEFGHIJKLMNOPQ'), 'GitHub token đã redact');
  assert.ok(!JSON.stringify(evs).includes('sk-abcdef1234567890'), 'API key đã redact');
  assert.ok(JSON.stringify(evs).includes('[REDACTED]'));
  const sum = summarizeByProvider(evs);
  assert.equal(sum.anthropic['claude-x'].byErrorClass.RATE_LIMIT, 1);
  assert.equal(sum.openai['gpt-y'].outcomes.failed, 1);
  assert.equal(Object.keys(sum).length, 2);
});

// 11. GPT-REV-061: secret trong object lồng nhau phải bị redact (không chỉ string top-level).
test('G.redact-nested-object: toolFailure.stderr chứa Bearer token → redact đệ quy', () => {
  const token = 'ghp_A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';
  const evs = recordExecutionEvent([], {
    taskId: 'issue-9', issue: 9, errorClass: 'PROVIDER_ERROR',
    toolFailure: { stderr: `Authorization: Bearer ${token}`, exitCode: 1 },
    compactionEvent: { preservedSpans: ['password=hunter2secretval'], droppedCount: 3 },
    fallbackEvent: { to: { provider: 'p', model: 'm' }, note: 'auth "Bearer sk-XYZABCDEF12345678"' },
  });
  const s = JSON.stringify(evs);
  assert.ok(!s.includes(token), 'GitHub token lồng trong object đã redact');
  assert.ok(!s.includes('hunter2secretval'), 'secret dạng key=value trong object lồng redact');
  assert.ok(!s.includes('sk-XYZABCDEF12345678'), 'OpenAI-style key trong nested note redact');
  assert.ok(s.includes('[REDACTED]'), 'marker redact hiện diện');
  // Cấu trúc object được bảo toàn (chỉ giá trị nhạy cảm bị thay).
  const rec = evs[0];
  assert.equal(rec.toolFailure.exitCode, 1, 'field không nhạy cảm giữ nguyên');
  assert.deepEqual(rec.fallbackEvent.to, { provider: 'p', model: 'm' });
});

// 12. GPT-REV-061: array lồng nhau + unknown evidence field cũng redact.
test('G.redact-array-unknown-field: mảng object chứa secret → redact hết', () => {
  const evs = recordExecutionEvent([], {
    errorClass: 'TIMEOUT',
    evidenceLogs: [{ msg: 'Bearer abcDEF123ghiJKL456' }, { msg: 'clean line' }, ['nested ghp_QRSTUVWXYZ0123456789abcdefghij']],
  });
  const s = JSON.stringify(evs);
  assert.ok(!s.includes('Bearer abcDEF123ghiJKL456'));
  assert.ok(!s.includes('ghp_QRSTUVWXYZ0123'));
  assert.ok(s.includes('clean line'), 'giá trị sạch giữ nguyên');
});

// 13. GPT-REV-061: circular input KHÔNG treo/không ném; oversized input bị cắt.
test('edge.redact-guards: circular → [Circular]; depth/node vượt → [TRUNCATED]', () => {
  const a = { name: 'self', note: 'token ghp_CIRCULARTEST000000000000000000000' };
  a.self = a;
  const out = recordExecutionEvent([], { errorClass: 'UNKNOWN', weirdField: a });
  const s = JSON.stringify(out);
  assert.ok(!s.includes('ghp_CIRCULARTEST'), 'secret qua circular path vẫn redact');
  assert.ok(s.includes('[Circular]'), 'cycle bị đánh dấu, không treo');
  // Deep nesting vượt depth guard.
  let deep = { v: 'sk-DEEPSECRETKET12345678' };
  for (let i = 0; i < 10; i += 1) deep = { w: deep };
  const deepOut = JSON.stringify(recordExecutionEvent([], { deep }));
  assert.ok(deepOut.includes('[TRUNCATED]') || !deepOut.includes('sk-DEEPSECRET'), 'depth guard hoạt động');
  // Oversize: > MAX_REDACT_NODES node.
  const many = { list: Array.from({ length: 600 }, (_, i) => ({ i: String(i), t: `tok${i}` })) };
  const bigOut = JSON.stringify(recordExecutionEvent([], { many }));
  assert.ok(bigOut.includes('[TRUNCATED]'), 'oversized input bị cắt để không phình log');
});

console.log(`\nerror-recovery: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);

