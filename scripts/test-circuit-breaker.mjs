#!/usr/bin/env node
// test-circuit-breaker.mjs — pure-logic test cho circuit breaker (Issue #25 Phase 4A).
// KHONG framework. Exit 0 = ALL PASS, 1 = co FAIL.
import assert from 'node:assert/strict';
import {
  BREAKER_STATES, BREAKER_REASONS,
  DEFAULT_THRESHOLD, DEFAULT_COOLDOWN_MS,
  createBreakerRegistry, recordFailure, recordSuccess,
  shouldPause, peek, summarize,
} from './circuit-breaker.mjs';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// 1. Constants
test('3 state CLOSED/OPEN/HALF_OPEN', () => {
  assert.equal(BREAKER_STATES.CLOSED, 'CLOSED');
  assert.equal(BREAKER_STATES.OPEN, 'OPEN');
  assert.equal(BREAKER_STATES.HALF_OPEN, 'HALF_OPEN');
});

test('Default threshold = 3, cooldown = 60s', () => {
  assert.equal(DEFAULT_THRESHOLD, 3);
  assert.equal(DEFAULT_COOLDOWN_MS, 60_000);
});

// 2. createBreakerRegistry
test('createBreakerRegistry default -> ok:true, threshold=3, cooldown=60000', () => {
  const r = createBreakerRegistry();
  assert.equal(r.ok, true);
  assert.equal(r.threshold, 3);
  assert.equal(r.cooldownMs, 60_000);
  assert.deepEqual(Object.keys(r.tools), []);
});

test('createBreakerRegistry threshold<1 hoặc cooldown<0 -> fail', () => {
  const r1 = createBreakerRegistry({ threshold: 0 });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, BREAKER_REASONS.INVALID_FAILURE_COUNT);
  const r2 = createBreakerRegistry({ cooldownMs: -1 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, BREAKER_REASONS.INVALID_FAILURE_COUNT);
});

// 3. recordFailure tăng đếm; đạt threshold -> OPEN
test('recordFailure 1, 2 -> CLOSED; 3 -> OPEN', () => {
  let r = createBreakerRegistry();
  const r1 = recordFailure(r, 'repo_status', 'err1', 1000);
  assert.equal(r1.opened, false);
  assert.equal(peek(r1.registry, 'repo_status').state, BREAKER_STATES.CLOSED);
  assert.equal(peek(r1.registry, 'repo_status').failures, 1);
  const r2 = recordFailure(r1.registry, 'repo_status', 'err2', 1100);
  assert.equal(r2.opened, false);
  assert.equal(peek(r2.registry, 'repo_status').failures, 2);
  const r3 = recordFailure(r2.registry, 'repo_status', 'err3', 1200);
  assert.equal(r3.opened, true);
  const p3 = peek(r3.registry, 'repo_status');
  assert.equal(p3.state, BREAKER_STATES.OPEN);
  assert.equal(p3.failures, 3);
  assert.equal(p3.entry.openedAt, 1200);
  assert.equal(p3.entry.lastReason, 'err3');
});

// 4. recordSuccess khi CLOSED: idempotent
test('recordSuccess khi CLOSED -> failures về 0, recovered=false', () => {
  let r = createBreakerRegistry();
  r = recordFailure(r, 'tool', 'e1', 1000).registry;
  const out = recordSuccess(r, 'tool');
  assert.equal(out.ok, true);
  assert.equal(out.recovered, false);
  assert.equal(peek(out.registry, 'tool').failures, 0);
  assert.equal(peek(out.registry, 'tool').state, BREAKER_STATES.CLOSED);
});

// 5. recordSuccess khi OPEN: recovered=true
test('recordSuccess khi OPEN -> recovered=true, CLOSED', () => {
  let r = createBreakerRegistry();
  r = recordFailure(r, 't', 'e1', 1000).registry;
  r = recordFailure(r, 't', 'e2', 1100).registry;
  r = recordFailure(r, 't', 'e3', 1200).registry;
  assert.equal(peek(r, 't').state, BREAKER_STATES.OPEN);
  const out = recordSuccess(r, 't');
  assert.equal(out.recovered, true);
  assert.equal(peek(out.registry, 't').state, BREAKER_STATES.CLOSED);
  assert.equal(peek(out.registry, 't').failures, 0);
});

// 6. shouldPause: CLOSED -> false
test('shouldPause CLOSED -> pause:false', () => {
  const r = createBreakerRegistry();
  const out = shouldPause(r, 't', 1000);
  assert.equal(out.pause, false);
  assert.equal(out.state, BREAKER_STATES.CLOSED);
});

// 7. shouldPause: OPEN trong cooldown -> true
test('shouldPause OPEN trong cooldown -> pause:true', () => {
  let r = createBreakerRegistry({ cooldownMs: 1000 });
  r = recordFailure(r, 't', 'e1', 1000).registry;
  r = recordFailure(r, 't', 'e2', 1100).registry;
  r = recordFailure(r, 't', 'e3', 1200).registry;
  const out = shouldPause(r, 't', 1500);
  assert.equal(out.pause, true);
  assert.equal(out.state, BREAKER_STATES.OPEN);
  assert.match(out.reason, /cooldown \d+ms remaining/);
});

// 8. shouldPause: OPEN sau cooldown -> false
test('shouldPause OPEN sau cooldown -> pause:false (probe allowed)', () => {
  let r = createBreakerRegistry({ cooldownMs: 1000 });
  r = recordFailure(r, 't', 'e1', 1000).registry;
  r = recordFailure(r, 't', 'e2', 1100).registry;
  r = recordFailure(r, 't', 'e3', 1200).registry;
  const out = shouldPause(r, 't', 2300);
  assert.equal(out.pause, false);
  assert.equal(out.state, BREAKER_STATES.OPEN);
  assert.match(out.reason, /probe allowed/);
});

// 9. Immutability
test('recordFailure KHONG mutate registry input', () => {
  const r0 = createBreakerRegistry();
  recordFailure(r0, 't', 'e1', 1000);
  recordFailure(r0, 't', 'e2', 1100);
  assert.equal(Object.keys(r0.tools).length, 0);
});

// 10. Independence: 2 tools độc lập
test('2 tools độc lập: t1 fail 3 -> OPEN, t2 vẫn CLOSED', () => {
  let r = createBreakerRegistry();
  r = recordFailure(r, 't1', 'e', 1000).registry;
  r = recordFailure(r, 't1', 'e', 1100).registry;
  r = recordFailure(r, 't1', 'e', 1200).registry;
  assert.equal(peek(r, 't1').state, BREAKER_STATES.OPEN);
  assert.equal(peek(r, 't2').state, BREAKER_STATES.CLOSED);
  assert.equal(shouldPause(r, 't2', 1200).pause, false);
});

// 11. Fail-closed: tool rỗng / không phải string
test('recordFailure/recordSuccess/shouldPause với tool không hợp lệ -> fail-closed', () => {
  const r = createBreakerRegistry();
  const a = recordFailure(r, '', 'e', 1000);
  assert.equal(a.ok, false);
  assert.equal(a.reason, BREAKER_REASONS.INVALID_TOOL);
  const b = recordFailure(r, null, 'e', 1000);
  assert.equal(b.ok, false);
  const c = recordSuccess(r, '');
  assert.equal(c.ok, false);
  const d = shouldPause(r, '');
  assert.equal(d.pause, true);
  const e = shouldPause(null, 't');
  assert.equal(e.pause, true);
});

// 12. summarize
test('summarize trả openTools/closedTools/total đúng', () => {
  let r = createBreakerRegistry();
  r = recordFailure(r, 'a', 'e', 1000).registry;
  r = recordFailure(r, 'a', 'e', 1100).registry;
  r = recordFailure(r, 'a', 'e', 1200).registry;
  r = recordFailure(r, 'b', 'e', 1000).registry;
  const s = summarize(r);
  assert.equal(s.ok, true);
  assert.equal(s.total, 2);
  assert.equal(s.openTools.length, 1);
  assert.equal(s.openTools[0], 'a');
  assert.equal(s.closedTools.length, 1);
  assert.equal(s.closedTools[0], 'b');
});

// 13. AC "3 lỗi liên tiếp -> pause, đợi human input" — test gián tiếp
test('Khi tool OPEN -> DoD có contract để chuyển BLOCKED', () => {
  let r = createBreakerRegistry();
  r = recordFailure(r, 'repo_diff', 'git error', 1000).registry;
  r = recordFailure(r, 'repo_diff', 'git error', 1100).registry;
  r = recordFailure(r, 'repo_diff', 'git error', 1200).registry;
  const entry = peek(r, 'repo_diff');
  assert.equal(entry.state, BREAKER_STATES.OPEN);
});

// 14. Custom threshold = 1
test('threshold=1: 1 failure đã mở OPEN', () => {
  const r = createBreakerRegistry({ threshold: 1 });
  const out = recordFailure(r, 't', 'e', 1000);
  assert.equal(out.opened, true);
  assert.equal(peek(out.registry, 't').state, BREAKER_STATES.OPEN);
});

// Chay
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.fn(); console.log(`PASS  ${c.name}`); pass++; }
  catch (e) { console.log(`FAIL  ${c.name}\n  ${e.message}`); fail++; }
}
console.log(`\nTotal: ${pass}/${pass+fail} PASS`);
if (fail > 0) { process.exit(1); }
else { process.exit(0); }


