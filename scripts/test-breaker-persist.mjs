#!/usr/bin/env node
// test-breaker-persist.mjs — persist circuit breaker (Finding 1) + git lock negative (Finding 4).
// KHÔNG framework. Exit 0 = ALL PASS, 1 = có FAIL.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
  atomicWriteJson, readJsonSafe, acquireLock, releaseLock, withFileLock,
  loadBreaker, saveBreaker, buildBreakerNamespace, claimHalfOpenProbe, createPersistFunctions,
} from './breaker-persist.mjs';
import { recordFailure, recordSuccess } from './circuit-breaker.mjs';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// ---------- child mode: --probe-child <ns> <tool> <now> <cooldownMs> ----------
if (process.argv[2] === '--probe-child') {
  const ns = process.argv[3];
  const tool = process.argv[4];
  const now = Number(process.argv[5]);
  const cooldown = Number(process.argv[6]);
  const out = claimHalfOpenProbe(ns, tool, cooldown, now);
  process.exit(out.claimed ? 0 : 1);
}

function makeRoot(prefix = 'breaker-persist-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.env.BREAKER_RUNTIME_ROOT = root;
  return root;
}

// 1. atomicWriteJson + readJsonSafe
test('atomicWriteJson + readJsonSafe round-trip', () => {
  const root = makeRoot();
  try {
    const f = join(root, 'x.json');
    atomicWriteJson(f, { ok: true, tools: { t: { state: 'OPEN' } } });
    const d = readJsonSafe(f);
    assert.equal(d.ok, true);
    assert.equal(d.tools.t.state, 'OPEN');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readJsonSafe file thiếu/corrupt -> null', () => {
  const root = makeRoot();
  try {
    assert.equal(readJsonSafe(join(root, 'missing.json')), null);
    writeFileSync(join(root, 'bad.json'), '{not-json', 'utf8');
    assert.equal(readJsonSafe(join(root, 'bad.json')), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 2. file lock exclusive
test('acquireLock exclusive: lần 2 khi đang giữ -> timeout/fail', () => {
  const root = makeRoot();
  try {
    const lockPath = join(root, 'a.lock');
    const first = acquireLock(lockPath, 2000);
    assert.equal(first.ok, true);
    const second = acquireLock(lockPath, 300);
    assert.equal(second.ok, false);
    releaseLock(first.fd, lockPath);
    const third = acquireLock(lockPath, 500);
    assert.equal(third.ok, true);
    releaseLock(third.fd, lockPath);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withFileLock chạy fn + tự unlock (gọi lại được)', () => {
  const root = makeRoot();
  try {
    let ran = 0;
    withFileLock('ns-lock', () => { ran += 1; return { ok: true }; });
    withFileLock('ns-lock', () => { ran += 1; return { ok: true }; });
    assert.equal(ran, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 3. loadBreaker / saveBreaker round-trip + namespace
test('loadBreaker mới -> default; saveBreaker + loadBreaker round-trip', () => {
  const root = makeRoot();
  try {
    const reg0 = loadBreaker('proj::task');
    assert.equal(reg0.ok, true);
    assert.equal(reg0.threshold, 3);
    assert.equal(Object.keys(reg0.tools).length, 0);
    reg0.tools.t = { state: 'OPEN', failures: 3, openedAt: 1000, lastReason: 'e' };
    saveBreaker('proj::task', reg0);
    const reg1 = loadBreaker('proj::task');
    assert.equal(reg1.tools.t.state, 'OPEN');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildBreakerNamespace sanitize ký tự nguy hiểm', () => {
  assert.equal(buildBreakerNamespace('o/r', 'feat/x:y'), 'o_r::feat_x_y');
  assert.equal(buildBreakerNamespace('a', 'b'), 'a::b');
});

// 4. claimHalfOpenProbe persist
test('claimHalfOpenProbe persist: OPEN + cooldown elapsed -> claimed, state HALF_OPEN trên file', () => {
  const root = makeRoot();
  try {
    const persist = createPersistFunctions(recordFailure, recordSuccess);
    for (let i = 0; i < 3; i++) persist.recordFailurePersist('ns', 't', `e${i}`, 1000 + i * 100);
    const opened = loadBreaker('ns');
    assert.equal(opened.tools.t.state, 'OPEN');
    const claim = claimHalfOpenProbe('ns', 't', 1000, 2500);
    assert.equal(claim.claimed, true);
    const after = loadBreaker('ns');
    assert.equal(after.tools.t.state, 'HALF_OPEN');
    assert.equal(after.tools.t.lastReason, 'probe_claimed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claimHalfOpenProbe persist còn cooldown -> claimed=false', () => {
  const root = makeRoot();
  try {
    const persist = createPersistFunctions(recordFailure, recordSuccess);
    for (let i = 0; i < 3; i++) persist.recordFailurePersist('ns', 't', 'e', 1000 + i * 100);
    const claim = claimHalfOpenProbe('ns', 't', 1000, 1900);
    assert.equal(claim.claimed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('probe fail persist -> OPEN reset openedAt; probe success -> CLOSED', () => {
  const root = makeRoot();
  try {
    const persist = createPersistFunctions(recordFailure, recordSuccess);
    for (let i = 0; i < 3; i++) persist.recordFailurePersist('ns', 't', 'e', 1000 + i * 100);
    const claim = claimHalfOpenProbe('ns', 't', 1000, 2500);
    assert.equal(claim.claimed, true);
    persist.recordFailurePersist('ns', 't', 'probe failed', 2600);
    let s = loadBreaker('ns');
    assert.equal(s.tools.t.state, 'OPEN');
    assert.equal(s.tools.t.openedAt, 2600);
    claimHalfOpenProbe('ns', 't', 1000, 4000);
    persist.recordSuccessPersist('ns', 't');
    s = loadBreaker('ns');
    assert.equal(s.tools.t.state, 'CLOSED');
    assert.equal(s.tools.t.failures, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 5. CROSS-PROCESS: spawn 5 child cùng claim 1 namespace -> chỉ 1 thắng (Finding 1)
test('cross-process claim HALF_OPEN: 5 child song song -> đúng 1 claimed', () => {
  const root = makeRoot();
  try {
    const persist = createPersistFunctions(recordFailure, recordSuccess);
    for (let i = 0; i < 3; i++) persist.recordFailurePersist('cp', 'tool', 'e', 1000 + i * 100);
    const now = 5000;
    const children = [];
    for (let i = 0; i < 5; i++) {
      const r = spawnSync(process.execPath, [process.argv[1], '--probe-child', 'cp', 'tool', String(now), '1000'], {
        encoding: 'utf8',
        env: { ...process.env, BREAKER_RUNTIME_ROOT: root },
      });
      children.push(r.status);
    }
    const claimed = children.filter((s) => s === 0).length;
    assert.equal(claimed, 1, `expected 1 claimed, got ${claimed}`);
    const after = loadBreaker('cp');
    assert.equal(after.tools.tool.state, 'HALF_OPEN');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 6. Negative: git lock hai repo song song (Finding 4)
test('git lock negative: cwd repo A nhưng expected repo B -> fail', async () => {
  const root = makeRoot();
  try {
    const repoA = join(root, 'repoA');
    const repoB = join(root, 'repoB');
    for (const [dir, origin] of [[repoA, 'https://github.com/o/repoA.git'], [repoB, 'https://github.com/o/repoB.git']]) {
      mkdirSync(dir, { recursive: true });
      runGit(['init', '-b', 'main'], dir);
      runGit(['config', 'user.email', 't@t'], dir);
      runGit(['config', 'user.name', 't'], dir);
      writeFileSync(join(dir, 'f.txt'), 'x', 'utf8');
      runGit(['add', '.'], dir);
      runGit(['commit', '-m', 'init'], dir);
      runGit(['remote', 'add', 'origin', origin], dir);
    }
    const mod = await import('./execution-broker.mjs');
    const bad = mod.createGitContext({ cwd: repoA, expectedRepo: 'o/repoB' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /repo mismatch/);
    const good = mod.createGitContext({ cwd: repoA, expectedRepo: 'o/repoA' });
    assert.equal(good.ok, true);
    assert.equal(good.repo, 'o/repoA');
    const badHead = mod.createGitContext({ cwd: repoA, expectedHeadSha: 'f'.repeat(40) });
    assert.equal(badHead.ok, false);
    assert.match(badHead.error, /HEAD mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Chay
let pass = 0, fail = 0;
(async () => {
  for (const c of cases) {
    try { await c.fn(); console.log(`PASS  ${c.name}`); pass++; }
    catch (e) { console.log(`FAIL  ${c.name}\n  ${e.message}`); fail++; }
  }
  console.log(`\nTotal: ${pass}/${pass + fail} PASS`);
  if (fail > 0) process.exit(1);
  else process.exit(0);
})();