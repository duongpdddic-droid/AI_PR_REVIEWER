#!/usr/bin/env node
// test-gateway-mp.mjs — Multi-process lock + integration (real child gateway + mock transport).
// GPT-REV-077/078/079/082 + Issue #15 readiness/inbound. KHÔNG unit — chạy thực tế 1+ process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLock, readHealth, isReady, READY_FILE, RUNTIME_DIR, enqueue,
} from './contract.mjs';

// Runtime shared -> dọn sạch trước/sau mỗi test (lock/health/ready/queue đều nằm trong RUNTIME_DIR).
function cleanRuntime() {
  try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); } catch {}
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATEWAY = path.join(REPO, 'scripts', 'telegram-gateway', 'gateway.mjs');
const MOCK = path.join(REPO, 'scripts', 'telegram-gateway', '_test_transport.mjs');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.error('  FAIL ' + name); } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(pred, timeoutMs, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (pred()) return true; await sleep(step); }
  return false;
}

function spawnGateway(extraEnv = {}) {
  const env = {
    ...process.env,
    TG_BOT_TOKEN: 'TEST_TOKEN', TG_CHAT_ID: '111',
    GATEWAY_HEARTBEAT_MS: '150',
    ...extraEnv,
  };
  const args = ['--fetch-impl', MOCK];
  return spawn('node', [GATEWAY, ...args], { cwd: REPO, env, stdio: 'ignore' });
}

async function waitExit(child, ms) {
  return new Promise((res) => {
    const t = setTimeout(() => res('timeout'), ms);
    child.on('exit', (code) => { clearTimeout(t); res(code); });
  });
}

// --- 1. Multi-process single-instance lock (GPT-REV-078) ---
async function testLock() {
  console.log('test-lock: chỉ 1 gateway được phép chạy đồng thời');
  cleanRuntime();
  const children = [spawnGateway(), spawnGateway(), spawnGateway()];
  const codes = [];
  const exited = children.map((c) => waitExit(c, 2000).then((code) => { codes.push(code); return code; }));
  await Promise.all(exited);
  // 2 loser exit code 3 (duplicate), 1 owner còn sống (chưa exit).
  const losers = codes.filter((c) => c === 3).length;
  ok('2 loser exit code 3', losers === 2);
  const owner = children.find((c) => c.exitCode === null && c.signalCode === null);
  ok('1 owner còn sống', !!owner);
  const lk = readLock();
  ok('lock tồn tại với instanceId', !!lk && !!lk.instanceId);
  // cleanup
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  await sleep(200);
  cleanRuntime();
}

// --- 2. Integration: gateway trở ready + inbound dispatch + outbound send (GPT-REV-079/082/#15) ---
async function testIntegration() {
  console.log('test-integration: gateway ready + inbound ack + outbound send');
  cleanRuntime();
  const logPath = path.join(os.tmpdir(), 'gw-test-log-' + Date.now() + '.jsonl');
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  const child = spawnGateway({ GATEWAY_TEST_LOG: logPath });
  const becameReady = await waitFor(() => isReady(), 5000);
  ok('gateway isReady sau startup poll', becameReady);
  ok('lock owner === health.instanceId', (() => {
    const h = readHealth(); const lk = readLock();
    return h && lk && h.instanceId === lk.instanceId && h.instanceId === JSON.parse(fs.readFileSync(READY_FILE, 'utf8')).instanceId;
  })());

  // enqueue outbound envelope hợp lệ (40-hex head) -> notifierLoop gửi qua mock
  enqueue('ai-pr-reviewer', 'outbound', {
    eventType: 'done', repo: 'R', ref: '#1', state: 's', summary: 'integration', nextAction: '',
    appNs: 'ai-pr-reviewer', head: 'a'.repeat(40),
  });
  const sent = await waitFor(() => {
    if (!fs.existsSync(logPath)) return false;
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.some((l) => { try { return JSON.parse(l).op === 'sendMessage'; } catch { return false; } });
  }, 5000);
  ok('outbound envelope được gửi qua transport', sent);

  // inbound /ping -> dispatchInbound ghi ack file
  const ackDir = path.join(RUNTIME_DIR, 'acks');
  const acked = await waitFor(() => fs.existsSync(ackDir) && fs.readdirSync(ackDir).length > 0, 5000);
  ok('inbound /ping được dispatch (ack file)', acked);

  // graceful shutdown -> lock + ready bị gỡ
  child.kill('SIGTERM');
  await waitExit(child, 2000);
  await sleep(200);
  ok('sau SIGTERM isReady=false (lock released)', !isReady());
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  cleanRuntime();
}

async function main() {
  await testLock();
  await testIntegration();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
