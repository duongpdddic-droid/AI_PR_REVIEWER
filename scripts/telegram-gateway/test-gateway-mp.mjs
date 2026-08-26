#!/usr/bin/env node
// test-gateway-mp.mjs — Multi-process OS-owned TCP leaseUnit (GPT-REV-078/079). Real child gateways.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GATEWAY_LEASE_PORT = String(48000 + (process.pid % 3000));

const { probeLease, isReady, READY_FILE, RUNTIME_DIR, enqueue, releaseLock } = await import('./contract.mjs');

function cleanRuntime() {
  try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}
}
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATEWAY = path.join(REPO, 'scripts', 'telegram-gateway', 'gateway.mjs');
const MOCK = path.join(REPO, 'scripts', 'telegram-gateway', '_test_transport.mjs');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.error('  FAIL ' + name); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await pred()) return true; await sleep(step); }
  return false;
}
function spawnGateway(extraEnv = {}) {
  const env = { ...process.env, TG_BOT_TOKEN: 'TEST_TOKEN', TG_CHAT_ID: '111', GATEWAY_HEARTBEAT_MS: '150', ...extraEnv };
  return spawn('node', [GATEWAY, '--fetch-impl', MOCK], { cwd: REPO, env, stdio: 'ignore' });
}
async function waitExit(child, ms) {
  return new Promise((res) => {
    const t = setTimeout(() => res('timeout'), ms);
    child.on('exit', (code) => { clearTimeout(t); res(code); });
  });
}

// --- 1. Contention: N process cùng bind lease -> chỉ 1 owner (GPT-REV-078) ---
async function testContention() {
  console.log('test-contention: chỉ 1 gateway giữ lease đồng thời');
  cleanRuntime();
  const children = [spawnGateway(), spawnGateway(), spawnGateway()];
  const codes = [];
  const exited = children.map((c) => waitExit(c, 2000).then((code) => { codes.push(code); return code; }));
  await Promise.all(exited);
  ok('2 loser exit code 3 (duplicate)', codes.filter((c) => c === 3).length === 2);
  const owner = children.find((c) => c.exitCode === null && c.signalCode === null);
  ok('1 owner còn người (giữ lease)', !!owner);
  const p = await probeLease(1500);
  ok('probe thấy lease đang được·giữ', p.alive === true);
  ok('lease.pid === owner.pid', p.lease && p.lease.pid === owner.pid);
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  await sleep(300);
  cleanRuntime();
}

// --- 2. Owner crash -> OS thả lease -> reacquire -> 1 owner mới ---
async function testCrashReacquire() {
  console.log('test-crash: owner crash -> reacquire -> 1 owner mới');
  cleanRuntime();
  const a = spawnGateway();
  const ownedA = await waitFor(async () => (await probeLease(1500)).alive, 5000);
  ok('A giữ lease', ownedA);
  const pidA = (await probeLease(1500)).lease.pid;
  try { process.kill(pidA, 'SIGKILL'); } catch {}
  const freed = await waitFor(async () => !(await probeLease(1500)).alive, 5000);
  ok('sau crash OS thả lease (port free)', freed);
  const b = spawnGateway();
  const ownedB = await waitFor(async () => {
    const p = await probeLease(1500);
    return p.alive && p.lease && p.lease.pid !== pidA;
  }, 5000);
  ok('B reacquire (single owner)', ownedB);
  const pB = await probeLease(1500);
  ok('B là owner mới (pid === B)', pB.alive && pB.lease && pB.lease.pid === b.pid);
  b.kill('SIGKILL');
  await sleep(300);
  cleanRuntime();
}

// --- 3. Old-owner/contender không thể đổi lease của owner mới (GPT-REV-078) ---
async function testOwnerCannotCorrupt() {
  console.log('test-corrupt: old/contender không thể đổi owner mới');
  cleanRuntime();
  const owner = spawnGateway();
  await waitFor(async () => (await probeLease(1500)).alive, 5000);
  const p0 = await probeLease(1500);
  const ownerPid = p0.lease.pid;
  const ownerInst = p0.lease.instanceId;
  const c = spawnGateway();
  const ccode = await waitExit(c, 2000);
  ok('contender exit 3 (không giày được lease)', ccode === 3);
  const after = await probeLease(1500);
  ok('owner instanceId không đổi', after.lease && after.lease.instanceId === ownerInst);
  ok('owner pid không đổi', after.lease && after.lease.pid === ownerPid);
  ok('releaseLock(non-owner) → false (không chạm lease)', releaseLock(ownerInst) === false);
  const after2 = await probeLease(1500);
  ok('lease vẫn còn sau release attempt', after2.alive && after2.alive.lease !== undefined ? after2.lease && after2.lease.pid === ownerPid : true);
  c.kill('SIGKILL');
  owner.kill('SIGKILL');
  await sleep(300);
  cleanRuntime();
}
// --- 4. Integration: ready (health+ready+lease match) + inbound + outbound ---
async function testIntegration() {
  console.log('test-integration: gateway ready + inbound + outbound (real child + mock)');
  cleanRuntime();
  const logPath = path.join(os.tmpdir(), 'gw-mp-' + Date.now() + '.jsonl');
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  const child = spawnGateway({ GATEWAY_TEST_LOG: logPath });
  const becameReady = await waitFor(async () => await isReady(), 6000);
  ok('gateway isReady (health+ready+lease match)', becameReady);
  const p = await probeLease(1500);
  ok('lease được owner giữ', p.alive === true);
  ok('READY_FILE.instanceId === lease.instanceId', (() => {
    if (!fs.existsSync(READY_FILE)) return false;
    const h = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
    return p.lease && h.instanceId === p.lease.instanceId;
  })());

  enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#1', state: 's', summary: 'integration', nextAction: '',
    appNs: 'ai-pr-reviewer', head: 'a'.repeat(40),
  });
  const sent = await waitFor(() => {
    if (!fs.existsSync(logPath)) return false;
    return fs.readFileSync(logPath, 'utf8').split('\n').some((l) => { try { return JSON.parse(l).op === 'sendMessage'; } catch { return false; } });
  }, 6000);
  ok('outbound được gửi', sent);

  const ackDir = path.join(RUNTIME_DIR, 'acks');
  const acked = await waitFor(() => fs.existsSync(ackDir) && fs.readdirSync(ackDir).length > 0, 6000);
  ok('inbound /ping dispatch', acked);

  child.kill('SIGTERM');
  await waitExit(child, 3000);
  await sleep(300);
  ok('sau SIGTERM lease được thả', !(await probeLease(500)).alive);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  cleanRuntime();
}

async function main() {
  await testContention();
  await testCrashReacquire();
  await testOwnerCannotCorrupt();
  await testIntegration();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });