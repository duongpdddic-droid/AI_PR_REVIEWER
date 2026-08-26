#!/usr/bin/env node
// test-telegram-gateway.mjs — Gateway (Issue #15) tests: queue namespacing, 429 retry,
// transport fail, idempotency, single-instance lock, routeUpdate, supervisor self-heal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgw-test-'));
process.env.AI_PR_REVIEWER_GATEWAY_DIR = TMP; // set TRƯỚC import contract

const contract = await import('./telegram-gateway/contract.mjs');
const transport = await import('./telegram-gateway/transport.mjs');
const bridge = await import('./telegram-gateway/bridge.mjs');
const notifier = await import('./telegram-gateway/notifier.mjs');

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('PASS ' + name); passed++; }
  catch (e) { console.error('FAIL ' + name + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

// 1. Queue namespacing.
test('queue namespacing per appNs/kind', () => {
  const a = contract.enqueue('appA', 'inbound', { x: 1 });
  const b = contract.enqueue('appB', 'inbound', { x: 2 });
  const o = contract.enqueue('appA', 'outbound', { x: 3 });
  assert.equal(contract.readQueue('appA', 'inbound').length, 1);
  assert.equal(contract.readQueue('appA', 'inbound')[0].id, a);
  assert.equal(contract.readQueue('appB', 'inbound').length, 1);
  assert.equal(contract.readQueue('appB', 'inbound')[0].id, b);
  assert.equal(contract.readQueue('appA', 'outbound').length, 1);
  assert.equal(contract.readQueue('appA', 'outbound')[0].id, o);
  assert.ok(contract.dequeue('appA', 'inbound', a));
  assert.equal(contract.readQueue('appA', 'inbound').length, 0);
  assert.ok(!contract.dequeue('appA', 'inbound', 'nope'));
});

// 2. routeUpdate: namespace + auth.
test('routeUpdate parses namespace + auth', () => {
  const u = { update_id: 5, message: { chat: { id: 816272951 }, text: '/qldadtxd:status now' } };
  const r = bridge.routeUpdate(u, 816272951);
  assert.equal(r.appNs, 'qldadtxd'); assert.equal(r.command, 'status'); assert.equal(r.args, 'now');
  assert.equal(bridge.routeUpdate(u, 999), null);
  const plain = { update_id: 6, message: { chat: { id: 816272951 }, text: 'hello' } };
  assert.equal(bridge.routeUpdate(plain, 816272951), null);
  const def = { update_id: 7, message: { chat: { id: 816272951 }, text: '/ping' } };
  assert.equal(bridge.routeUpdate(def, 816272951).appNs, 'ai-pr-reviewer');
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
    n++;
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

// 6. single instance lock: duplicate refused; stale -> takeover.
test('single instance lock duplicate + stale takeover', () => {
  const acq1 = bridge.tryAcquireLock('inst-1');
  assert.equal(acq1.acquired, true);
  const acq2 = bridge.tryAcquireLock('inst-2');
  assert.equal(acq2.acquired, false); assert.equal(acq2.reason, 'duplicate');
  const lock = contract.readLock();
  lock.lastHeartbeat = Date.now() - contract.STALE_MS - 1000;
  fs.writeFileSync(contract.LOCK_FILE, JSON.stringify(lock));
  assert.equal(contract.isLockAlive(contract.readLock()), false);
  const acq3 = bridge.tryAcquireLock('inst-3');
  assert.equal(acq3.acquired, true);
  contract.releaseLock();
});

// 7. isPidAlive false for dead pid.
test('isPidAlive false for dead pid', () => {
  assert.equal(contract.isPidAlive(9999999), false);
});

// 8. notifier.sendItem success -> markSent + dequeue; failure -> stays.
test('notifier sendItem success removes item; failure keeps', async () => {
  // dọn queue outbound còn sót từ test trước (dir outbound không namespaced theo appNs)
  for (const f of fs.readdirSync(contract.OUTBOUND_DIR)) { try { fs.unlinkSync(path.join(contract.OUTBOUND_DIR, f)); } catch {} }
  const cfg = { botToken: 'T', chatId: 'C' };
  contract.enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#1', state: 's', summary: 'x', nextAction: '',
  });
  const items = contract.readQueue('ai-pr-reviewer', 'outbound');
  assert.equal(items.length, 1);
  const okFetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const r1 = await notifier.sendItem(items[0], cfg, { fetchImpl: okFetch, sleep: async () => {} });
  assert.equal(r1.sent, true);
  assert.equal(contract.readQueue('ai-pr-reviewer', 'outbound').length, 0);
  contract.enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#2', state: 's', summary: 'y', nextAction: '',
  });
  const failFetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' });
  const items2 = contract.readQueue('ai-pr-reviewer', 'outbound');
  const r2 = await notifier.sendItem(items2[0], cfg, { fetchImpl: failFetch, sleep: async () => {}, attempts: 1 });
  assert.equal(r2.sent, false);
  assert.equal(contract.readQueue('ai-pr-reviewer', 'outbound').length, 1); // giữ lại retry
});

// 9. supervisor self-heal: stale lock detected (isLockAlive false -> supervisor spawns lại).
test('supervisor detects dead/stale instance', () => {
  const acq = bridge.tryAcquireLock('sup-1');
  assert.equal(acq.acquired, true);
  const l = contract.readLock();
  l.lastHeartbeat = Date.now() - contract.STALE_MS - 5000;
  fs.writeFileSync(contract.LOCK_FILE, JSON.stringify(l));
  assert.equal(contract.isLockAlive(contract.readLock()), false); // supervisor sẽ startGateway
  contract.releaseLock();
});

console.log('\ntelegram-gateway: ' + passed + ' PASS' + (process.exitCode ? ' (có FAIL)' : ''));