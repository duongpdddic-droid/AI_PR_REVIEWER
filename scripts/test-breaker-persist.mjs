#!/usr/bin/env node
// test-breaker-persist.mjs — persist circuit breaker (Finding 1) + git lock negative (Finding 4).
// KHÔNG framework. Exit 0 = ALL PASS, 1 = có FAIL.

import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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

// 1c. namespace hash chống collision (Finding 1) — end-to-end:
// buildBreakerNamespace raw hash trước sanitize → a/b vs a_b phải khác file.
test('buildBreakerNamespace -> breakerFilePath: a/b vs a_b khác file (raw hash chống collision)', () => {
  const root = makeRoot();
  try {
    const ns1 = buildBreakerNamespace('a/b', 'x');
    const ns2 = buildBreakerNamespace('a_b', 'x');
    assert.notEqual(ns1, ns2, 'namespace string phải khác (raw hash trước sanitize)');
    const f1 = breakerFilePath(ns1);
    const f2 = breakerFilePath(ns2);
    assert.notEqual(f1, f2, 'file path phải khác');
    assert.match(f1, /breaker-[A-Za-z0-9_.-]+\.json$/);
    assert.match(f2, /breaker-[A-Za-z0-9_.-]+\.json$/);
    // Sanity: cùng input → cùng namespace (deterministic).
    assert.equal(buildBreakerNamespace('a/b', 'x'), buildBreakerNamespace('a/b', 'x'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 1d. loadBreaker shape validation fail-closed (Finding 2)
test('loadBreaker: tools không phải plain object -> ok=false', () => {
  const root = makeRoot();
  try {
    const f = breakerFilePath('ns-array-tools');
    writeFileSync(f, JSON.stringify({ ok: true, threshold: 3, cooldownMs: 1000, tools: ['nope'] }), 'utf8');
    const r = loadBreaker('ns-array-tools');
    assert.equal(r.ok, false);
    assert.match(r.reason, /plain object/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadBreaker: threshold không phải integer >= 1 -> ok=false', () => {
  const root = makeRoot();
  try {
    for (const [label, bad] of [['string', '3'], ['float', 3.5], ['zero', 0], ['negative', -1], ['null', null]]) {
      const f = breakerFilePath(`ns-th-${label}`);
      writeFileSync(f, JSON.stringify({ ok: true, threshold: bad, cooldownMs: 1000, tools: {} }), 'utf8');
      const r = loadBreaker(`ns-th-${label}`);
      assert.equal(r.ok, false, `threshold=${label} phải fail-closed`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadBreaker: cooldownMs < 0 -> ok=false', () => {
  const root = makeRoot();
  try {
    const f = breakerFilePath('ns-cd');
    writeFileSync(f, JSON.stringify({ ok: true, threshold: 3, cooldownMs: -1, tools: {} }), 'utf8');
    const r = loadBreaker('ns-cd');
    assert.equal(r.ok, false);
    assert.match(r.reason, /cooldownMs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadBreaker: entry có state invalid -> ok=false, KHÔNG drop silently', () => {
  const root = makeRoot();
  try {
    const f = breakerFilePath('ns-state');
    writeFileSync(f, JSON.stringify({
      ok: true, threshold: 3, cooldownMs: 1000,
      tools: { t1: { state: 'OPEN', failures: 3, openedAt: 1000 }, t2: { state: 'BOGUS' } }
    }), 'utf8');
    const r = loadBreaker('ns-state');
    assert.equal(r.ok, false, '1 entry sai → toàn file fail-closed');
    assert.match(r.reason, /state invalid/);
    // Verify file không bị mutate.
    const onDisk = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(onDisk.tools.t2.state, 'BOGUS', 'file không bị sửa');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadBreaker: entry failures không phải integer >= 0 -> ok=false', () => {
  const root = makeRoot();
  try {
    for (const [label, bad] of [['string', '1'], ['float', 1.5], ['negative', -1]]) {
      const f = breakerFilePath(`ns-f-${label}`);
      writeFileSync(f, JSON.stringify({
        ok: true, threshold: 3, cooldownMs: 1000,
        tools: { t: { state: 'OPEN', failures: bad, openedAt: 1000 } }
      }), 'utf8');
      const r = loadBreaker(`ns-f-${label}`);
      assert.equal(r.ok, false, `failures=${label} phải fail-closed`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadBreaker: entry openedAt invalid -> ok=false', () => {
  const root = makeRoot();
  try {
    // NaN không round-trip qua JSON nên test thủ công bằng cách inject trực tiếp
    // (viết JSON.stringify sẽ biến NaN thành null, làm test mất ý nghĩa).
    // Ở đây test các giá trị stringify đúng nhưng vẫn invalid.
    for (const [label, bad] of [['string', '1000'], ['negative', -1]]) {
      const f = breakerFilePath(`ns-o-${label}`);
      writeFileSync(f, JSON.stringify({
        ok: true, threshold: 3, cooldownMs: 1000,
        tools: { t: { state: 'OPEN', failures: 1, openedAt: bad } }
      }), 'utf8');
      const r = loadBreaker(`ns-o-${label}`);
      assert.equal(r.ok, false, `openedAt=${label} phải fail-closed`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadBreaker: hợp lệ hoàn toàn -> ok=true với đầy đủ fields', () => {
  const root = makeRoot();
  try {
    const f = breakerFilePath('ns-ok');
    writeFileSync(f, JSON.stringify({
      ok: true, threshold: 5, cooldownMs: 2000,
      tools: { t: { state: 'CLOSED', failures: 0, openedAt: null } }
    }), 'utf8');
    const r = loadBreaker('ns-ok');
    assert.equal(r.ok, true);
    assert.equal(r.threshold, 5);
    assert.equal(r.cooldownMs, 2000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claimHalfOpenProbe: gặp corrupt state (shape invalid) -> ok=false', () => {
  const root = makeRoot();
  try {
    const f = breakerFilePath('ns-claim-corrupt');
    writeFileSync(f, JSON.stringify({
      ok: true, threshold: 3, cooldownMs: 1000,
      tools: { t: { state: 'BOGUS', failures: 3, openedAt: 1000 } }
    }), 'utf8');
    const claim = claimHalfOpenProbe('ns-claim-corrupt', 't', 1000, 5000);
    assert.equal(claim.ok, false, 'corrupt state phải fail-closed ở claim');
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

// 2b. lock owner identity (Finding 3)
// acquireLock ghi {pid, nonce} vào lock file; release chỉ xóa khi identity
// còn khớp; recovery chỉ khi xác minh được PID đã chết.
test('acquireLock ghi owner record {pid, nonce} vào lock file', () => {
  const root = makeRoot();
  try {
    const lockPath = join(root, 'owner.lock');
    const r = acquireLock(lockPath, 1000);
    assert.equal(r.ok, true);
    assert.ok(r.owner, 'phải trả owner');
    assert.equal(r.owner.pid, process.pid);
    assert.ok(typeof r.owner.nonce === 'string' && r.owner.nonce.length > 0);
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.nonce, r.owner.nonce);
    releaseLock(r.fd, lockPath, r.owner);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseLock identity mismatch -> KHÔNG xóa file', () => {
  const root = makeRoot();
  try {
    const lockPath = join(root, 'mismatch.lock');
    const r = acquireLock(lockPath, 1000);
    assert.equal(r.ok, true);
    // Giả lập owner khác (nonce khác, pid khác) — release không được xóa.
    const fakeOwner = { pid: r.owner.pid, nonce: 'different-nonce' };
    const released = releaseLock(r.fd, lockPath, fakeOwner);
    assert.equal(released, false);
    assert.ok(existsSync(lockPath), 'file vẫn còn do identity mismatch');
    // Cleanup: release đúng identity.
    releaseLock(r.fd, lockPath, r.owner);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseLock identity khớp -> xóa file (normal path)', () => {
  const root = makeRoot();
  try {
    const lockPath = join(root, 'good.lock');
    const r = acquireLock(lockPath, 1000);
    assert.equal(r.ok, true);
    const released = releaseLock(r.fd, lockPath, r.owner);
    assert.equal(released, true);
    assert.ok(!existsSync(lockPath), 'file đã bị xóa');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovery: lock orphan (PID chết) -> acquireLock tự recover và thành công', () => {
  const root = makeRoot();
  try {
    const lockPath = join(root, 'orphan.lock');
    // Fake orphan lock: PID chắc chắn không tồn tại (PID 999999999 hoặc rất cao).
    // Trên Windows + Linux PID namespace lớn; dùng 1 số rất cao để chắc chắn dead.
    const fakeDeadPid = 999_999_999;
    writeFileSync(lockPath, JSON.stringify({ pid: fakeDeadPid, nonce: 'old', createdAt: 0 }), 'utf8');
    const r = acquireLock(lockPath, 2000);
    assert.equal(r.ok, true, 'acquireLock phải recover orphan lock');
    assert.equal(r.owner.pid, process.pid);
    releaseLock(r.fd, lockPath, r.owner);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovery: lock còn owner PID sống -> acquireLock timeout, KHÔNG xóa nhầm', () => {
  const root = makeRoot();
  try {
    const lockPath = join(root, 'alive.lock');
    // PID sống: chính process hiện tại nhưng nonce khác (giả lập stale entry
    // từ chính process — _pidAlive trả true → giữ lock).
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: 'stale-self', createdAt: 0 }), 'utf8');
    const r = acquireLock(lockPath, 300);
    assert.equal(r.ok, false, 'PID còn sống → fail-closed (timeout)');
    assert.match(r.error, /timeout/);
    // Lock file còn nguyên (PID sống nên không tự ý xóa).
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(onDisk.nonce, 'stale-self', 'file không bị xóa nhầm');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recovery: lock file corrupt (không parse được) -> fail-closed, KHÔNG xóa', () => {
  const root = makeRoot();
  try {
    const lockPath = join(root, 'corrupt.lock');
    writeFileSync(lockPath, 'not-json-at-all', 'utf8');
    const r = acquireLock(lockPath, 300);
    assert.equal(r.ok, false, 'corrupt owner → không được tự xóa → timeout');
    assert.ok(existsSync(lockPath), 'file corrupt vẫn còn');
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

test('buildBreakerNamespace sanitize ký tự nguy hiểm + raw hash', () => {
  // Sau khi thêm raw hash, namespace có định dạng <safe_proj>::<safe_task>::<6hex>.
  const ns1 = buildBreakerNamespace('o/r', 'feat/x:y');
  assert.match(ns1, /^o_r::feat_x_y::[0-9a-f]{6}$/);
  // Input clean: chỉ khác hash, format vẫn đúng.
  const ns2 = buildBreakerNamespace('a', 'b');
  assert.match(ns2, /^a::b::[0-9a-f]{6}$/);
  // Cùng input → cùng hash (deterministic).
  assert.equal(buildBreakerNamespace('a', 'b'), ns2);
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

// 6. Negative: git lock hai repo song song (Finding 4) — DEFER to follow-up PR
// (cần execution-broker.mjs#createGitContext, đã defer ra khỏi PR #28).
// test('git lock negative: cwd repo A nhưng expected repo B -> fail', async () => { ... });

// (runGit helper removed — was only used by deferred git lock negative test)

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