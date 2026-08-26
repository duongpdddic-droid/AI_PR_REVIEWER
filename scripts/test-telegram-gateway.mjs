#!/usr/bin/env node
// test-telegram-gateway.mjs — Gateway (Issue #15) tests (awaited harness, GPT-REV-081).
// Phủ: queue namespacing, namespace validation (traversal/allowlist), 429 retry, transport fail,
// idempotency (appNs/head), atomic single-instance lock + owner-only ops, routeUpdate,
// supervisor decision logic + gateway config-failure subprocess.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// env PHẢI set TRƯỚC import contract (constants đọc 1 lần).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgw-test-'));
process.env.AI_PR_REVIEWER_GATEWAY_DIR = TMP;
process.env.GATEWAY_ALLOWED_APPS = 'ai-pr-reviewer,appa,appb,qldadtxd';

const contract = await import('./telegram-gateway/contract.mjs');
const transport = await import('./telegram-gateway/transport.mjs');
const bridge = await import('./telegram-gateway/bridge.mjs');
const notifier = await import('./telegram-gateway/notifier.mjs');
const supervisor = await import('./telegram-gateway/supervisor.mjs');

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function cleanRuntime() {
  for (const p of [
    contract.OUTBOUND_DIR, contract.INBOUND_DIR, contract.DEADLETTER_DIR,
    contract.LOCK_FILE, contract.HEALTH_FILE, contract.READY_FILE,
  ]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

// 1. Queue namespacing.
test('queue namespacing per appNs/kind', () => {
  cleanRuntime();
  const a = contract.enqueue('appa', 'inbound', { x: 1 });
  const b = contract.enqueue('appb', 'inbound', { x: 2 });
  const o = contract.enqueue('appa', 'outbound', { eventType: 'done', repo: 'R', ref: '#1', state: 's', summary: 'o', nextAction: '', appNs: 'appa', head: 'a'.repeat(40) });
  assert.equal(contract.readQueue('appa', 'inbound').length, 1);
  assert.equal(contract.readQueue('appa', 'inbound')[0].id, a);
  assert.equal(contract.readQueue('appb', 'inbound').length, 1);
  assert.equal(contract.readQueue('appb', 'inbound')[0].id, b);
  assert.equal(contract.readQueue('appa', 'outbound').length, 1);
  assert.equal(contract.readQueue('appa', 'outbound')[0].id, o);
  assert.ok(contract.dequeue('appa', 'inbound', a));
  assert.equal(contract.readQueue('appa', 'inbound').length, 0);
  assert.ok(!contract.dequeue('appa', 'inbound', 'nope'));
});

// 2. routeUpdate: namespace + auth.
test('routeUpdate parses namespace + auth', () => {
  const chat = 816272951;
  const u = { update_id: 5, message: { chat: { id: chat }, text: '/qldadtxd:status now' } };
  const r = bridge.routeUpdate(u, { chatId: chat });
  assert.equal(r.appNs, 'qldadtxd'); assert.equal(r.command, 'status'); assert.equal(r.args, 'now');
  assert.equal(bridge.routeUpdate(u, { chatId: 999 }), null);
  const plain = { update_id: 6, message: { chat: { id: chat }, text: 'hello' } };
  assert.equal(bridge.routeUpdate(plain, { chatId: chat }), null);
  const def = { update_id: 7, message: { chat: { id: chat }, text: '/ping' } };
  assert.equal(bridge.routeUpdate(def, { chatId: chat }).appNs, 'ai-pr-reviewer');
});

// 2b. routeUpdate rejects traversal / unknown / invalid appNs (GPT-REV-077).
test('routeUpdate rejects invalid/unknown appNs', () => {
  const chat = 816272951;
  const cases = ['..', '../x', '/abs/path', 'c:\\\\x', '', 'a'.repeat(40), 'unknownapp', '/etc/passwd'];
  for (const app of cases) {
    const u = { update_id: 1, message: { chat: { id: chat }, text: '/' + app + ':status' } };
    assert.equal(bridge.routeUpdate(u, { chatId: chat }), null, 'should reject: ' + app);
  }
});

// 3. transport send success.
test('transport send success', async () => {
  const fetchMock = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const r = await transport.sendTelegram({ token: 'T', chatId: 'C', text: 'hi' }, { fetchImpl: fetchMock, sleep: async () => {} });
  assert.equal(r.ok, true); assert.equal(r.status, 200);
});

// 4. transport 429 retry then success.
test('transport 429 retry then success', async () => {
  let n = 0;
  const fetchMock = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'rate' };
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  const r = await transport.sendTelegram({ token: 'T', chatId: 'C', text: 'hi' }, { fetchImpl: fetchMock, sleep: async () => {} });
  assert.equal(r.ok, true); assert.equal(n, 2);
});

// 5. transport persistent failure -> ok false.
test('transport failure returns ok=false', async () => {
  const fetchMock = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' });
  const r = await transport.sendTelegram({ token: 'T', chatId: 'C', text: 'hi' }, { fetchImpl: fetchMock, sleep: async () => {}, attempts: 2 });
  assert.equal(r.ok, false); assert.equal(r.status, 500);
});

// 6. atomic single-instance lock + owner-only release/heartbeat (GPT-REV-078).
test('single instance lock: atomic acquire, duplicate, stale takeover, owner-only ops', () => {
  cleanRuntime();
  const acq1 = bridge.tryAcquireLock('inst-A');
  assert.equal(acq1.acquired, true);
  assert.equal(acq1.lock.instanceId, 'inst-A');
  // non-owner cannot release
  assert.equal(contract.releaseLock('inst-B'), false);
  assert.ok(contract.readLock());
  // non-owner cannot heartbeat
  const before = contract.readLock().lastHeartbeat;
  contract.touchHeartbeat('inst-B');
  assert.equal(contract.readLock().lastHeartbeat, before);
  // owner heartbeat
  contract.touchHeartbeat('inst-A');
  assert.ok(contract.readLock().lastHeartbeat >= before);
  // owner release
  assert.equal(contract.releaseLock('inst-A'), true);
  assert.equal(contract.readLock(), null);

  // duplicate refused
  cleanRuntime();
  bridge.tryAcquireLock('x');
  const acq2 = bridge.tryAcquireLock('y');
  assert.equal(acq2.acquired, false); assert.equal(acq2.reason, 'duplicate');
  contract.releaseLock('x');

  // stale -> takeover
  cleanRuntime();
  bridge.tryAcquireLock('x');
  const l = contract.readLock();
  l.lastHeartbeat = Date.now() - contract.STALE_MS - 1000;
  fs.writeFileSync(contract.LOCK_FILE, JSON.stringify(l));
  assert.equal(contract.isLockAlive(contract.readLock()), false);
  const acq3 = bridge.tryAcquireLock('z');
  assert.equal(acq3.acquired, true);
  assert.equal(acq3.lock.instanceId, 'z');
  contract.releaseLock('z');
});

// 7. isPidAlive false for dead pid.
test('isPidAlive false for dead pid', () => {
  assert.equal(contract.isPidAlive(9999999), false);
});

// 8. notifier.sendItem: success removes; failure keeps; invalid envelope deadlettered.
test('notifier sendItem success/failure/invalid', async () => {
  cleanRuntime();
  const cfg = { botToken: 'T', chatId: 'C' };
  contract.enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#1', state: 's', summary: 'x', nextAction: '', appNs: 'ai-pr-reviewer', head: 'a'.repeat(40),
  });
  let items = contract.readQueue('ai-pr-reviewer', 'outbound');
  assert.equal(items.length, 1);
  const okFetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const r1 = await notifier.sendItem(items[items.length-1], cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r1.sent, true);
  assert.equal(contract.readQueue('ai-pr-reviewer', 'outbound').length, 0);

  contract.enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#2', state: 's', summary: 'y', nextAction: '', appNs: 'ai-pr-reviewer', head: 'b'.repeat(40),
  });
  const items2 = contract.readQueue('ai-pr-reviewer', 'outbound');
  const failFetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' });
  const r2 = await notifier.sendItem(items2[0], cfg, { fetchImpl: failFetch, sleep: async () => {}, attempts: 1 });
  assert.equal(r2.sent, false);
  assert.equal(contract.readQueue('ai-pr-reviewer', 'outbound').length, 1); // giữ lại retry

  // invalid envelope (thiếu head) -> enqueue rejected fail-closed (không ghi file, không phát đi).
  cleanRuntime();
  assert.throws(() => contract.enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#3', state: 's', summary: 'z', nextAction: '', appNs: 'ai-pr-reviewer',
  }));
  assert.equal(contract.readQueue('ai-pr-reviewer', 'outbound').length, 0); // không ghi file
});

// 9. idempotency key includes appNs + head; cross-app/head not suppressed (GPT-REV-080).
test('idempotency across appNs and head', async () => {
  cleanRuntime();
  const cfg = { botToken: 'T', chatId: 'C' };
  const okFetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const base = { eventType: 'done', repo: 'R', ref: '#1', state: 's', summary: 'x', nextAction: '', appNs: 'ai-pr-reviewer', head: 'd'.repeat(40) };

  // same envelope twice -> second skipped
  contract.enqueue('ai-pr-reviewer', 'outbound', base);
  let items = contract.readQueue('ai-pr-reviewer', 'outbound');
  const r1 = await notifier.sendItem(items[items.length-1], cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r1.sent, true);
  contract.enqueue('ai-pr-reviewer', 'outbound', base);
  items = contract.readQueue('ai-pr-reviewer', 'outbound');
  const r2 = await notifier.sendItem(items[items.length-1], cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r2.sent, false); assert.equal(r2.skipped, true);

  // different head -> must send again
  contract.enqueue('ai-pr-reviewer', 'outbound', { ...base, head: 'c'.repeat(40) });
  items = contract.readQueue('ai-pr-reviewer', 'outbound');
  const r3 = await notifier.sendItem(items[items.length-1], cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r3.sent, true);

  // different appNs -> different key -> sends
  contract.enqueue('appa', 'outbound', { ...base, appNs: 'appa' });
  items = contract.readQueue('appa', 'outbound');
  const r4 = await notifier.sendItem(items[items.length-1], cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r4.sent, true);
});


// 10. supervisor decision logic (injected, deterministic) (GPT-REV-079/081).
test('supervisor decision logic', async () => {
  cleanRuntime();
  let started = false;
  const rec = await supervisor.runSupervisorOnce({
    timeoutMs: 800,
    startGatewayFn: () => {
      started = true;
      contract.tryAcquireLock('s'); // lock owner sống, instanceId 's'
      contract.writeHealth({ status: 'ready', instanceId: 's', lastHeartbeat: Date.now(), lastSuccessfulPoll: Date.now() });
      contract.writeReadyFlag('s');
    },
    isReadyFn: contract.isReady,
  });
  assert.equal(started, true);
  assert.equal(rec.action, 'recovered');

  cleanRuntime();
  const fail = await supervisor.runSupervisorOnce({ timeoutMs: 500, startGatewayFn: () => {}, isReadyFn: contract.isReady });
  assert.equal(fail.action, 'recovery-failed');

  cleanRuntime();
  contract.tryAcquireLock('s');
  contract.writeHealth({ status: 'ready', instanceId: 's', lastHeartbeat: Date.now(), lastSuccessfulPoll: Date.now() });
  contract.writeReadyFlag('s');
  const ar = await supervisor.runSupervisorOnce({
    timeoutMs: 400, startGatewayFn: () => { throw new Error('should not start'); }, isReadyFn: contract.isReady,
  });
  assert.equal(ar.action, 'already-ready');
});

// 11. gateway config-failure subprocess (real process exits non-zero, no ready) (GPT-REV-079).
test('gateway exits non-zero on missing config', async () => {
  cleanRuntime();
  const gw = path.resolve('scripts/telegram-gateway/gateway.mjs');
  const env = { ...process.env, AI_PR_REVIEWER_GATEWAY_DIR: TMP, TG_BOT_TOKEN: '', TG_CHAT_ID: '' };
  const child = spawn(process.execPath, [gw, '--start'], { env });
  const code = await new Promise((res) => child.on('exit', (c) => res(c)));
  assert.notEqual(code, 0);
  assert.equal(contract.isReady(), false);
});

// 12. routeUpdate: user allowlist + reject forwarded/channel (GPT-REV-077).
test('routeUpdate user allowlist + reject forwarded/channel', () => {
  const chat = 816272951;
  const mk = (text, fromId) => ({ update_id: 9, message: { chat: { id: chat }, from: fromId ? { id: fromId } : undefined, text } });
  const auth = { chatId: chat, userIds: new Set(['u1']) };
  assert.equal(bridge.routeUpdate(mk('/ping', 'u1'), auth).fromId, 'u1');
  assert.equal(bridge.routeUpdate(mk('/ping', 'u2'), auth), null); // không trong allowlist
  assert.equal(bridge.routeUpdate(mk('/ping'), auth), null); // forwarded/channel (không from) -> reject fail-closed
});

// 13. HEAD_RE 40-hex + gatewayEventKey per repo/ref/head (GPT-REV-080).
test('HEAD_RE 40-hex + gatewayEventKey distinguishes', () => {
  assert.equal(contract.HEAD_RE.test('a'.repeat(40)), true);
  assert.equal(contract.HEAD_RE.test('deadbeef'), false); // 8 hex -> reject
  assert.equal(contract.HEAD_RE.test('g'.repeat(40)), false); // non-hex -> reject
  const a = { appNs: 'ai-pr-reviewer', repo: 'R', ref: '#1', eventType: 'done', state: 's', head: 'a'.repeat(40) };
  const b = { ...a, head: 'b'.repeat(40) };
  const c = { ...a, repo: 'R2' };
  assert.notEqual(contract.gatewayEventKey(a), contract.gatewayEventKey(b)); // head phân biệt
  assert.notEqual(contract.gatewayEventKey(a), contract.gatewayEventKey(c)); // repo phân biệt
});

// 14. enqueue outbound validates envelope before write (fail-closed) (GPT-REV-080).
test('enqueue outbound validates envelope before write', () => {
  cleanRuntime();
  assert.throws(() => contract.enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#1', state: 's', summary: 'x', nextAction: '', appNs: 'ai-pr-reviewer', head: 'deadbeef',
  }));
  assert.equal(contract.readQueue('ai-pr-reviewer', 'outbound').length, 0); // không ghi file
  assert.throws(() => contract.enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#2', state: 's', summary: 'y', nextAction: '', appNs: 'ai-pr-reviewer',
  }));
  // inbound KHÔNG validate head -> ghi được
  contract.enqueue('ai-pr-reviewer', 'inbound', { text: '/ping' });
  assert.equal(contract.readQueue('ai-pr-reviewer', 'inbound').length, 1);
});

// 15. processOutbound sends all registered appNs in one pass (GPT-REV-082).
test('processOutbound handles multiple appNs in one pass', async () => {
  cleanRuntime();
  const cfg = { botToken: 'T', chatId: 'C' };
  contract.enqueue('ai-pr-reviewer', 'outbound', { eventType: 'done', repo: 'R15a', ref: '#15a', state: 's', summary: 'x', nextAction: '', appNs: 'ai-pr-reviewer', head: 'a'.repeat(40) });
  contract.enqueue('qldadtxd', 'outbound', { eventType: 'done', repo: 'Q15b', ref: '#15b', state: 's', summary: 'y', nextAction: '', appNs: 'qldadtxd', head: 'b'.repeat(40) });
  const okFetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const r = await notifier.processOutbound(cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r.processed, 2);
  assert.equal(r.sent, 2);
  assert.equal(contract.readQueue('ai-pr-reviewer', 'outbound').length, 0);
  assert.equal(contract.readQueue('qldadtxd', 'outbound').length, 0);
});

// Chạy tuần tự, đếm SAU KHI await xong (GPT-REV-081).
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (e) {
    failed += 1;
    console.error('FAIL ' + name + ': ' + ((e && e.message) || e));
    process.exitCode = 1;
  }
}
console.log('\ntelegram-gateway: ' + passed + ' PASS, ' + failed + ' FAIL' + (failed ? ' (có FAIL)' : ''));
if (failed) process.exitCode = 1;
