#!/usr/bin/env node
// test-tg-notify.mjs — Telegram retry/evidence tests cho tg-notify-core.mjs (Issue #16, C2 của Issue #6).
// Pure logic: buildMessage escape, eventKey idempotency, NotificationStore SENT/retry/persist,
// withRetry backoff, watchdog silence levels + reset.
import assert from 'node:assert/strict';
import {
  buildMessage, eventKey, escapeHtml, nextSilenceState, NotificationStore,
  resetOnActivity, silenceTimeoutLevels, withRetry,
} from './tg-notify-core.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${(e && e.message) || e}`); process.exitCode = 1; }
};

// 1. buildMessage: escape HTML an toàn + đủ dòng bắt buộc.
{
  const msg = buildMessage({
    eventType: 'done', repo: 'o/r<svg>', ref: '#43', state: 'ready-for-gpt-review',
    summary: 'x < & > y', nextAction: 'review', link: 'https://github.com/x/pr/1',
  });
  assert.ok(msg.includes('Repo: o/r&lt;svg&gt;'), 'repo được escape');
  assert.ok(msg.includes('Chi tiết: x &lt; &amp; &gt; y'), 'summary được escape');
  assert.ok(msg.includes('Link: https://github.com/x/pr/1'), 'link giữ nguyên');
  assert.ok(!buildMessage({ eventType: 'không-có' }).includes('undefined'), 'eventType lạ không sinh undefined');
}

// 2. escapeHtml chỉ & < >.
assert.equal(escapeHtml('<a href="x">&"'), '&lt;a href="x"&gt;&amp;"');

// 3. eventKey: state đổi -> khóa đổi (gửi lại hợp lệ).
{
  const a = eventKey({ repo: 'r', ref: '#1', eventType: 'done', state: 's1' });
  const b = eventKey({ repo: 'r', ref: '#1', eventType: 'done', state: 's2' });
  assert.notEqual(a, b);
  assert.equal(a, 'r::#1::done::s1');
}

// 4. NotificationStore: retry sau lỗi gửi vẫn được phép; markSent rồi thì không gửi nữa (evidence idempotent).
{
  const store = new NotificationStore();
  const key = eventKey({ repo: 'r', ref: '#1', eventType: 'done', state: 'ok' });
  assert.equal(store.shouldSend(key), true);
  store.markSent(key);
  assert.equal(store.shouldSend(key), false, 'đã SENT không tạo tin thứ 2');
  assert.equal(store.has(key), true);
}
// 4b. Persistence: storage load/save injectable.
{
  let saved = null;
  const s1 = new NotificationStore({ load: () => null, save: (m) => { saved = m; } });
  s1.markSent('k1');
  assert.deepEqual(saved, { k1: true }, 'save được gọi khi markSent');
  const s2 = new NotificationStore({ load: () => saved, save: () => {} });
  assert.equal(s2.shouldSend('k1'), false, 'load lại trạng thái SENT từ storage');
}

// 5. withRetry: fail rồi success trong giới hạn; hết lượt ném lỗi cuối; delay theo số lần fail.
{
  let calls = 0;
  const out = await withRetry(async () => { calls++; if (calls < 3) throw new Error('tạm lỗi'); return 'OK'; },
    { attempts: 3, delayMs: 1, sleep: async () => {} });
  assert.equal(out, 'OK'); assert.equal(calls, 3);
  const delays = [];
  await assert.rejects(
    withRetry(async () => { throw new Error('lỗi cuối'); }, {
      attempts: 2, delayMs: 5, sleep: async (ms) => delays.push(ms),
    }),
    /lỗi cuối/,
  );
  assert.deepEqual(delays, [5], 'delay = delayMs * số lần đã fail');
}

// 6. Watchdog silence levels dựa timestamp thực tế; không arm -> none.
{
  const now = 1_000_000;
  assert.equal(silenceTimeoutLevels({ armedAt: 0, now, level1Ms: 30, level2Ms: 60 }), 'none', 'không armed -> none');
  assert.equal(silenceTimeoutLevels({ armedAt: now - 10, lastHeartbeat: 0, now, level1Ms: 30, level2Ms: 60 }), 'active');
  assert.equal(silenceTimeoutLevels({ armedAt: now - 31, lastHeartbeat: 0, now, level1Ms: 30, level2Ms: 60 }), 'level1');
  assert.equal(silenceTimeoutLevels({ armedAt: now - 61, lastHeartbeat: 0, now, level1Ms: 30, level2Ms: 60 }), 'level2');
}

// 7. nextSilenceState: mỗi cấp chỉ gửi 1 lần; active không gửi.
assert.deepEqual(nextSilenceState('active', 'level1'),
  { level: 'level1', shouldSend: true, eventType: 'timeout-level1' });
assert.equal(nextSilenceState('level1', 'level1').shouldSend, false, 'cùng cấp không lặp');
assert.equal(nextSilenceState('level1', 'active').shouldSend, false);

// 8. resetOnActivity trả heartbeat mới + active.
{
  const g = resetOnActivity({ armedAt: 1, lastHeartbeat: 2, silenceWarnLevel: 'level1' }, 999);
  assert.equal(g.lastHeartbeat, 999);
  assert.equal(g.silenceWarnLevel, 'active');
}

console.log(`\ntg-notify: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);
