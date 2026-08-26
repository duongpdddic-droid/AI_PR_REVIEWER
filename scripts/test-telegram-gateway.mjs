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
// Lease dùng port riêng cho test để không chạm gateway thật trên máy (47321).
process.env.GATEWAY_LEASE_PORT = String(47000 + (process.pid % 2048));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const contract = await import('./telegram-gateway/contract.mjs');
const transport = await import('./telegram-gateway/transport.mjs');
const bridge = await import('./telegram-gateway/bridge.mjs');
const notifier = await import('./telegram-gateway/notifier.mjs');
const supervisor = await import('./telegram-gateway/supervisor.mjs');
const gateway = await import('./telegram-gateway/gateway.mjs');

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function cleanRuntime() {
  for (const p of [
    contract.OUTBOUND_DIR, contract.INBOUND_DIR, contract.DEADLETTER_DIR,
    contract.HEALTH_FILE, contract.READY_FILE, contract.LOCK_FILE,
  ]) {
    if (!p) continue; // LOCK_FILE rỗng (không còn dùng, thay bằng TCP lease)
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

// 6. OS-owned TCP lease: acquire, duplicate, owner-only ops (GPT-REV-078).
test('single instance lease: acquire, duplicate, owner-only release', async () => {
  cleanRuntime();
  const acq1 = await bridge.tryAcquireLock('inst-A');
  assert.equal(acq1.acquired, true);
  assert.equal(acq1.lock.instanceId, 'inst-A');
  assert.equal(acq1.lock.pid, process.pid);
  // non-owner cannot release (instanceId khác) — ganh từ khác process không có quyền.
  assert.equal(contract.releaseLock('inst-B'), false);
  assert.ok(contract.readLock());
  // heartbeat no-op (owner do OS giữ port) — không ghi file, không ném.
  assert.equal(contract.touchHeartbeat('inst-B'), null === contract.readLock() ? null : contract.readLock());
  assert.equal(contract.readLock().instanceId, 'inst-A'); // owner không đổi
  // owner release
  assert.equal(contract.releaseLock('inst-A'), true);
  assert.equal(contract.readLock(), null);

  // duplicate refused while held
  await sleep(60); // chờ OS thả port
  cleanRuntime();
  const a1 = await bridge.tryAcquireLock('x');
  assert.equal(a1.acquired, true);
  const a2 = await bridge.tryAcquireLock('y');
  assert.equal(a2.acquired, false); assert.equal(a2.reason, 'duplicate');
  assert.equal(contract.readLock().instanceId, 'x'); // owner 'x' không bị xáo
  contract.releaseLock('x');
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


// 10. supervisor decision logic (injected, deterministic) (GPT-REV-079/081 / lease model).
test('supervisor decision logic', async () => {
  cleanRuntime();
  const childPid = process.pid;
  let started = false;
  const rec = await supervisor.runSupervisorOnce({
    timeoutMs: 800,
    startGatewayFn: async () => {
      started = true;
      await contract.tryAcquireLock('s');
      contract.writeHealth({ status: 'ready', instanceId: 's', lastSuccessfulPoll: Date.now() });
      contract.writeReadyFlag('s');
      return childPid;
    },
    isReadyFn: contract.isReady, probeFn: contract.probeLease,
  });
  assert.equal(started, true);
  assert.equal(rec.action, 'recovered');
  contract.releaseLock('s');

  await sleep(80); // chờ OS thả lease
  cleanRuntime();
  const fail = await supervisor.runSupervisorOnce({ timeoutMs: 500, startGatewayFn: async () => childPid, isReadyFn: contract.isReady, probeFn: contract.probeLease });
  assert.equal(fail.action, 'recovery-failed');

  cleanRuntime();
  await contract.tryAcquireLock('s');
  contract.writeHealth({ status: 'ready', instanceId: 's', lastSuccessfulPoll: Date.now() });
  contract.writeReadyFlag('s');
  const ar = await supervisor.runSupervisorOnce({
    timeoutMs: 400, startGatewayFn: async () => { throw new Error('should not start'); }, isReadyFn: contract.isReady, probeFn: contract.probeLease,
  });
  assert.equal(ar.action, 'already-ready');
  contract.releaseLock('s');
});

// 11. gateway config-failure subprocess (real process exits non-zero, no ready) (GPT-REV-079).
test('gateway exits non-zero on missing config', async () => {
  cleanRuntime();
  const gw = path.resolve('scripts/telegram-gateway/gateway.mjs');
  const env = { ...process.env, AI_PR_REVIEWER_GATEWAY_DIR: TMP, TG_BOT_TOKEN: '', TG_CHAT_ID: '', GATEWAY_NO_LEGACY_CFG: '1' };
  const child = spawn(process.execPath, [gw, '--start'], { env });
  const code = await new Promise((res) => child.on('exit', (c) => res(c)));
  assert.notEqual(code, 0);
  assert.equal(await contract.isReady(), false);
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

// 16. OS-owned lease: owner không bị thay thế/lam hỏng bởi kẻ khác (GPT-REV-078).
test('lease owner cannot be replaced/corrupted by stranger', async () => {
  cleanRuntime();
  await bridge.tryAcquireLock('live');
  const p = await contract.probeLease();
  assert.equal(p.alive, true);
  assert.equal(p.lease.instanceId, 'live');
  assert.equal(contract.releaseLock('intruder'), false); // stranger không release được
  assert.equal(contract.readLock().instanceId, 'live'); // owner không đổi
  const after = await contract.probeLease();
  assert.equal(after.lease.instanceId, 'live'); // lease không bị xáo
  contract.releaseLock('live');
});

// 17. supervisor chứng minh restart bằng pid khớp lease (GPT-REV-079).
test('supervisor claims recovered only when child pid owns lease (GPT-REV-079)', async () => {
  cleanRuntime();
  const childPid = process.pid; // test process acts as the spawned child
  const rec = await supervisor.runSupervisorOnce({
    timeoutMs: 1000,
    startGatewayFn: async () => {
      const a = await contract.tryAcquireLock('mine');
      if (!a.acquired) throw new Error('acquire failed');
      contract.writeHealth({ status: 'ready', instanceId: 'mine', lastSuccessfulPoll: Date.now() });
      contract.writeReadyFlag('mine');
      return childPid;
    },
    isReadyFn: contract.isReady, probeFn: contract.probeLease,
  });
  assert.equal(rec.action, 'recovered');
  assert.equal(rec.pid, childPid);
  contract.releaseLock('mine');
});

test('supervisor detects ready not owned by spawned child (GPT-REV-079)', async () => {
  cleanRuntime();
  await bridge.tryAcquireLock('other'); // instance "khác" (pid = process này)
  contract.writeHealth({ status: 'ready', instanceId: 'other', lastSuccessfulPoll: Date.now() });
  contract.writeReadyFlag('other');
  const rec = await supervisor.runSupervisorOnce({
    timeoutMs: 1000,
    startGatewayFn: async () => 4242, // child ta spawn có pid 4242 != owner thật (process.pid)
    isReadyFn: contract.isReady, probeFn: contract.probeLease,
  });
  // probe.show Alive (owner đang giữ) -> nhưng health 'other' match owner -> isReady true ngay.
  assert.equal(rec.action, 'already-ready');
  contract.releaseLock('other');
});

test('supervisor monitors a LIVE but not-ready lease, never spawns (GPT-REV-079)', async () => {
  cleanRuntime();
  let started = false;
  // lease được giữ (pid = process.pid sống) nhưng chưa ready -> monitor, không spawn child
  await contract.tryAcquireLock('live-degraded');
  const rec = await supervisor.runSupervisorOnce({
    timeoutMs: 400, startGatewayFn: () => { started = true; return 4242; },
    isReadyFn: contract.isReady, probeFn: contract.probeLease,
  });
  assert.equal(started, false); // không spawn
  assert.equal(rec.action, 'monitor-degraded');
  assert.equal(rec.pid, process.pid);
  contract.releaseLock('live-degraded');
});

// 18. supervisor backoff + circuit breaker avoid restart storm (GPT-REV-079).
test('supervisor backoff + circuit breaker (GPT-REV-079)', () => {
  assert.equal(supervisor.computeBackoff(1), 60000);
  assert.equal(supervisor.computeBackoff(2), 120000);
  assert.equal(supervisor.computeBackoff(3), 240000);
  assert.equal(supervisor.computeBackoff(10), supervisor.MAX_BACKOFF_MS); // clamp
  assert.equal(supervisor.isCircuitOpen(1, 1000, 2000), false);
  assert.equal(supervisor.isCircuitOpen(5, 1000, 2000), true); // >=5 trong window
  assert.equal(supervisor.isCircuitOpen(5, 1000, 1000 + supervisor.FAIL_WINDOW_MS + 1), false); // quá window
});

// 19. notifier dequeues duplicate (skipped) outbound so queue does not grow (GPT-REV-083).
test('notifier dequeues duplicate outbound (GPT-REV-083)', async () => {
  cleanRuntime();
  const cfg = { botToken: 'T', chatId: 'C' };
  const okFetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const env = { eventType: 'done', repo: 'R83', ref: '#83', state: 's', summary: 'x', nextAction: '', appNs: 'ai-pr-reviewer', head: 'a'.repeat(40) };
  contract.enqueue('ai-pr-reviewer', 'outbound', env);
  let items = contract.readQueue('ai-pr-reviewer', 'outbound');
  const r1 = await notifier.sendItem(items[items.length - 1], cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r1.sent, true);
  contract.enqueue('ai-pr-reviewer', 'outbound', env); // same key -> duplicate
  items = contract.readQueue('ai-pr-reviewer', 'outbound');
  const r2 = await notifier.sendItem(items[items.length - 1], cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r2.sent, false); assert.equal(r2.skipped, true);
  assert.equal(contract.readQueue('ai-pr-reviewer', 'outbound').length, 0); // duplicate dequeued
});

// 20. gateway consumes inbound for all registered namespaces (GPT-REV-084).
test('gateway consumes inbound for all namespaces (GPT-REV-084)', () => {
  cleanRuntime();
  contract.enqueue('qldadtxd', 'inbound', { command: 'status', args: '', fromId: 'u', appNs: 'qldadtxd', updateId: 9001 });
  const ns = gateway.listInboundNamespaces();
  assert.ok(ns.includes('ai-pr-reviewer'));
  assert.ok(ns.includes('qldadtxd'));
  assert.equal(contract.readQueue('qldadtxd', 'inbound').length, 1);
  for (const n of ns) {
    for (const it of contract.readQueue(n, 'inbound')) contract.dequeue(n, 'inbound', it.id);
  }
  assert.equal(contract.readQueue('qldadtxd', 'inbound').length, 0);
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
