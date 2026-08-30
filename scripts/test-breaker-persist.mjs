#!/usr/bin/env node
// test-breaker-persist.mjs — persist circuit breaker (Finding 1) + git lock negative (Finding 4).
// KHÔNG framework. Exit 0 = ALL PASS, 1 = có FAIL.

import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
  atomicWriteJson, readJsonSafe, acquireLock, releaseLock, withFileLock,
  loadBreaker, saveBreaker, buildBreakerNamespace, breakerFilePath,
  claimHalfOpenProbe, createPersistFunctions,
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

// 1b. corrupt breaker state fail-closed (Finding 2)
test('loadBreaker file corrupt -> ok=false, KHÔNG reset thành default fresh', () => {
  const root = makeRoot();
  try {
    const f = breakerFilePath('ns-corrupt');
    // Write malformed JSON trực tiếp vào path breaker (giả lập file bị hỏng).
    writeFileSync(f, '{not-json', 'utf8');
    const r = loadBreaker('ns-corrupt');
    assert.equal(r.ok, false, 'corrupt file phải fail-closed');
    assert.equal(r.tools, null, 'corrupt file KHÔNG trả tools default');
    assert.ok(r.reason && typeof r.reason === 'string', 'phải có reason');
    // claim probe phải fail-closed khi state corrupt.
    const claim = claimHalfOpenProbe('ns-corrupt', 'tool', 1000, 5000);
    assert.equal(claim.claimed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadBreaker file missing ok flag -> ok=false', () => {
  const root = makeRoot();
  try {
    const f = breakerFilePath('ns-no-ok');
    writeFileSync(f, JSON.stringify({ threshold: 3, cooldownMs: 1000, tools: {} }), 'utf8');
    const r = loadBreaker('ns-no-ok');
    assert.equal(r.ok, false);
    assert.match(r.reason, /ok=true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 1c. namespace hash chống collision (Finding 1)
test('breakerFilePath: 2 namespace sanitize giống nhau vẫn khác file (hash collision-safe)', () => {
  const root = makeRoot();
  try {
    // "a/b" và "a_b" đều sanitize thành "a_b" — nếu không có hash, cùng file → bug.
    const f1 = breakerFilePath('proj::a/b');
    const f2 = breakerFilePath('proj::a_b');
    assert.notEqual(f1, f2, 'collision: phải khác file path');
    // Cả 2 đều Windows-safe (chỉ chứa [A-Za-z0-9_.-]).
    assert.match(f1, /breaker-[A-Za-z0-9_.-]+\.json$/);
    assert.match(f2, /breaker-[A-Za-z0-9_.-]+\.json$/);
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

// 5. CROSS-PROCESS: spawn 5 child đồng thời cùng claim 1 namespace -> chỉ 1 thắng (Finding 1 + Finding 7)
// Dùng spawn (async) + Promise.all để các process race thật; spawnSync tuần tự sẽ miss race.
test('cross-process claim HALF_OPEN: 5 child đồng thời -> đúng 1 claimed', async () => {
  const root = makeRoot();
  try {
    const persist = createPersistFunctions(recordFailure, recordSuccess);
    for (let i = 0; i < 3; i++) persist.recordFailurePersist('cp', 'tool', 'e', 1000 + i * 100);
    const now = 5000;
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(new Promise((resolve) => {
        const child = spawn(process.execPath,
          [process.argv[1], '--probe-child', 'cp', 'tool', String(now), '1000'],
          { env: { ...process.env, BREAKER_RUNTIME_ROOT: root } });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', (code) => resolve({ code, out }));
      }));
    }
    const results = await Promise.all(tasks);
    const claimed = results.filter((r) => r.code === 0).length;
    assert.equal(claimed, 1, `expected 1 claimed, got ${claimed} (codes=${results.map((r) => r.code).join(',')})`);
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