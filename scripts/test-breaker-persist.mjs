#!/usr/bin/env node
// test-breaker-persist.mjs — persist circuit breaker (Finding 1+2+3). Exit 0=PASS.

import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
  atomicWriteJson, readJsonSafe, acquireLock, releaseLock, withFileLock,
  loadBreaker, saveBreaker, buildBreakerNamespace, breakerFilePath,
  claimHalfOpenProbe, createPersistFunctions, _setFsOverride,
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
async function withRoot(fn, prefix) {
  const root = makeRoot(prefix);
  try { return await fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('atomicWriteJson + readJsonSafe round-trip', async () => {
  await withRoot(async (root) => {
    const f = join(root, 'x.json');
    atomicWriteJson(f, { ok: true, tools: { t: { state: 'OPEN' } } });
    const d = readJsonSafe(f);
    assert.equal(d.ok, true);
    assert.equal(d.tools.t.state, 'OPEN');
  });
});

test('readJsonSafe file thiếu/corrupt -> null', async () => {
  await withRoot(async (root) => {
    assert.equal(readJsonSafe(join(root, 'missing.json')), null);
    writeFileSync(join(root, 'bad.json'), '{not-json', 'utf8');
    assert.equal(readJsonSafe(join(root, 'bad.json')), null);
  });
});

test('loadBreaker file corrupt -> ok=false, KHÔNG reset thành default fresh', async () => {
  await withRoot(async (root) => {
    const f = breakerFilePath('ns-corrupt');
    writeFileSync(f, '{not-json', 'utf8');
    const r = loadBreaker('ns-corrupt');
    assert.equal(r.ok, false, 'corrupt file phải fail-closed');
    assert.equal(r.tools, null, 'corrupt file KHÔNG trả tools default');
    assert.ok(r.reason && typeof r.reason === 'string', 'phải có reason');
    const claim = claimHalfOpenProbe('ns-corrupt', 'tool', 1000, 5000);
    assert.equal(claim.claimed, false);
  });
});

test('loadBreaker file missing ok flag -> ok=false', async () => {
  await withRoot(async (root) => {
    const f = breakerFilePath('ns-no-ok');
    writeFileSync(f, JSON.stringify({ threshold: 3, cooldownMs: 1000, tools: {} }), 'utf8');
    const r = loadBreaker('ns-no-ok');
    assert.equal(r.ok, false);
    assert.match(r.reason, /ok=true/);
  });
});

test('buildBreakerNamespace -> breakerFilePath: a/b vs a_b khác file (raw hash chống collision)', async () => {
  await withRoot(async (root) => {
    const ns1 = buildBreakerNamespace('a/b', 'x');
    const ns2 = buildBreakerNamespace('a_b', 'x');
    assert.notEqual(ns1, ns2, 'namespace string phải khác (raw hash trước sanitize)');
    const f1 = breakerFilePath(ns1);
    const f2 = breakerFilePath(ns2);
    assert.notEqual(f1, f2, 'file path phải khác');
    assert.match(f1, /breaker-[A-Za-z0-9_.-]+\.json$/);
    assert.match(f2, /breaker-[A-Za-z0-9_.-]+\.json$/);
    assert.equal(buildBreakerNamespace('a/b', 'x'), buildBreakerNamespace('a/b', 'x'), 'deterministic');
  });
});

test('loadBreaker shape fail-closed: 8 case table-driven', async () => {
  await withRoot(async (root) => {
    const cases = [
      { ns: 'a', payload: { ok: true, threshold: 3, cooldownMs: 1000, tools: ['nope'] }, why: 'tools=array' },
      { ns: 'b', payload: { ok: true, threshold: '3', cooldownMs: 1000, tools: {} }, why: 'threshold=string' },
      { ns: 'c', payload: { ok: true, threshold: 0, cooldownMs: 1000, tools: {} }, why: 'threshold=0' },
      { ns: 'd', payload: { ok: true, threshold: 3, cooldownMs: -1, tools: {} }, why: 'cooldown<0' },
      { ns: 'e', payload: { ok: true, threshold: 3, cooldownMs: 1000, tools: { t: { state: 'BOGUS', failures: 1, openedAt: 0 } } }, why: 'state=BOGUS' },
      { ns: 'f', payload: { ok: true, threshold: 3, cooldownMs: 1000, tools: { t: { state: 'OPEN', failures: 1.5, openedAt: 0 } } }, why: 'failures=1.5' },
      { ns: 'g', payload: { ok: true, threshold: 3, cooldownMs: 1000, tools: { t: { state: 'OPEN', failures: 1, openedAt: -1 } } }, why: 'openedAt<0' },
      { ns: 'h', payload: { ok: true, threshold: 3, cooldownMs: 1000, tools: { t: { state: 'OPEN', failures: 1, openedAt: '1000' } } }, why: 'openedAt=string' },
    ];
    for (const c of cases) {
      const f = breakerFilePath(`ns-${c.ns}`);
      writeFileSync(f, JSON.stringify(c.payload), 'utf8');
      const r = loadBreaker(`ns-${c.ns}`);
      assert.equal(r.ok, false, `case ${c.why} phải fail-closed`);
    }
  });
});

test('loadBreaker: hợp lệ hoàn toàn -> ok=true với đầy đủ fields', async () => {
  await withRoot(async (root) => {
    const f = breakerFilePath('ns-ok');
    writeFileSync(f, JSON.stringify({
      ok: true, threshold: 5, cooldownMs: 2000,
      tools: { t: { state: 'CLOSED', failures: 0, openedAt: null } }
    }), 'utf8');
    const r = loadBreaker('ns-ok');
    assert.equal(r.ok, true);
    assert.equal(r.threshold, 5);
    assert.equal(r.cooldownMs, 2000);
  });
});

test('claimHalfOpenProbe: gặp corrupt state (shape invalid) -> ok=false', async () => {
  await withRoot(async (root) => {
    const f = breakerFilePath('ns-claim-corrupt');
    writeFileSync(f, JSON.stringify({
      ok: true, threshold: 3, cooldownMs: 1000,
      tools: { t: { state: 'BOGUS', failures: 3, openedAt: 1000 } }
    }), 'utf8');
    const claim = claimHalfOpenProbe('ns-claim-corrupt', 't', 1000, 5000);
    assert.equal(claim.ok, false, 'corrupt state phải fail-closed ở claim');
  });
});

test('acquireLock exclusive: lần 2 khi đang giữ -> timeout/fail', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'a.lock');
    const first = acquireLock(lockPath, 2000);
    assert.equal(first.ok, true);
    const second = acquireLock(lockPath, 300);
    assert.equal(second.ok, false);

    releaseLock(first.fd, lockPath, first.owner);
    const third = acquireLock(lockPath, 500);
    assert.equal(third.ok, true);
    releaseLock(third.fd, lockPath, third.owner);
  });
});

test('acquireLock ghi owner record {pid, nonce} vào lock file', async () => {
  await withRoot(async (root) => {
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
  });
});

test('releaseLock: identity match xóa file, mismatch/thiếu/sai shape giữ nguyên', async () => {
  await withRoot(async (root) => {
    // happy: identity khớp → xóa.
  {
    const r = acquireLock(join(root, 'good.lock'), 1000);
    assert.equal(r.ok, true);
    assert.equal(releaseLock(r.fd, join(root, 'good.lock'), r.owner), true);
    assert.ok(!existsSync(join(root, 'good.lock')));
  }
    // fail-closed: identity mismatch / thiếu owner / shape invalid.
    const r = acquireLock(join(root, 'fail.lock'), 1000);
    assert.equal(r.ok, true);
    const fakeOwner = { pid: r.owner.pid, nonce: 'wrong' };
    for (const bad of [fakeOwner, undefined, null, {}, { pid: 1 }, { pid: 1, nonce: 123 }, 'string', 42]) {
      assert.equal(releaseLock(r.fd, join(root, 'fail.lock'), bad), false, `bad=${JSON.stringify(bad)} → fail-closed`);
    }
    assert.ok(existsSync(join(root, 'fail.lock')), 'fail-closed giữ nguyên file');
    releaseLock(r.fd, join(root, 'fail.lock'), r.owner);
  });
});

test('recovery: lock orphan (PID chết) -> acquireLock tự recover và thành công', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'orphan.lock');

    const fakeDeadPid = 999_999_999;
    writeFileSync(lockPath, JSON.stringify({ pid: fakeDeadPid, nonce: 'old', createdAt: 0 }), 'utf8');
    const r = acquireLock(lockPath, 2000);
    assert.equal(r.ok, true, 'acquireLock phải recover orphan lock');
    assert.equal(r.owner.pid, process.pid);

    const list = readdirSync(root);
    const hasQuarantine = list.some((f) => f.startsWith('orphan.lock.recover-'));
    assert.ok(hasQuarantine, 'recovery phải quarantine lock cũ sang .recover-<ts>');
    releaseLock(r.fd, lockPath, r.owner);
  });
});

test('recovery: lock còn owner PID sống -> acquireLock timeout, KHÔNG xóa nhầm', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'alive.lock');

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: 'stale-self', createdAt: 0 }), 'utf8');
    const r = acquireLock(lockPath, 300);
    assert.equal(r.ok, false, 'PID còn sống → fail-closed (timeout)');
    assert.match(r.error, /timeout/);
    
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(onDisk.nonce, 'stale-self', 'file không bị xóa nhầm');
  });
});

test('recovery: lock file corrupt (không parse được) -> fail-closed, KHÔNG xóa', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'corrupt.lock');
    writeFileSync(lockPath, 'not-json-at-all', 'utf8');
    const r = acquireLock(lockPath, 300);
    assert.equal(r.ok, false, 'corrupt owner → không được tự xóa → timeout');
    assert.ok(existsSync(lockPath), 'file corrupt vẫn còn');
  });
});

test('recovery: re-read race (identity swap) -> fail-closed, lock B còn nguyên', async () => {
  // Simulate writer khác ghi đè identity B giữa read+rename: read A stale, rename quarantine, verify B → identity lệch → restore + fail-closed. File gốc = B.
  await withRoot(async (root) => {
    const lockPath = join(root, 'race.lock');
    const pid = 999_999_998;
    writeFileSync(lockPath, JSON.stringify({ pid, nonce: 'B', createdAt: 0 }), 'utf8');
    _setFsOverride({
      openSync: (p, flag) => { if (flag === 'wx') { const e = new Error('exists'); e.code = 'EEXIST'; throw e; } return 7; },
      readFileSync: (p) => p === lockPath ? JSON.stringify({ pid, nonce: 'A', createdAt: 0 }) : p.startsWith(lockPath + '.recover-') ? JSON.stringify({ pid, nonce: 'B', createdAt: 0 }) : '',
      renameSync: () => {}, unlinkSync: () => {}, closeSync: () => {}, writeSync: () => 0,
    });
    try {
      const r = acquireLock(lockPath, 250);
      assert.equal(r.ok, false, 'recovery fail-closed khi identity đổi');
      assert.ok(existsSync(lockPath), 'lock gốc còn nguyên');
      assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).nonce, 'B', 'identity B giữ nguyên');
    } finally { _setFsOverride(null); }
  });
});

test('recovery: PID không xác minh được (unknown) -> KHÔNG xóa lock', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'unknown.lock');

    writeFileSync(lockPath, JSON.stringify({ pid: 12345, nonce: 'old', createdAt: 0 }), 'utf8');
    const orig = process.kill;
    process.kill = function (pid, sig) {
      const err = new Error(`mocked failure for pid=${pid}`);
      err.code = 'EACCES';
      throw err;
    };
    try {
      const r = acquireLock(lockPath, 300);
      assert.equal(r.ok, false, 'PID unknown → fail-closed (timeout)');
      assert.ok(existsSync(lockPath), 'unknown PID → KHÔNG xóa lock');
      const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
      assert.equal(onDisk.nonce, 'old', 'file giữ nguyên identity');
    } finally {
      process.kill = orig;
    }
  });
});

test('withFileLock chạy fn + tự unlock (gọi lại được)', async () => {
  await withRoot(async (root) => {
    let ran = 0;
    withFileLock('ns-lock', () => { ran += 1; return { ok: true }; });
    withFileLock('ns-lock', () => { ran += 1; return { ok: true }; });
    assert.equal(ran, 2);
  });
});

test('loadBreaker mới -> default; saveBreaker + loadBreaker round-trip', async () => {
  await withRoot(async (root) => {
    const reg0 = loadBreaker('proj::task');
    assert.equal(reg0.ok, true);
    assert.equal(reg0.threshold, 3);
    assert.equal(Object.keys(reg0.tools).length, 0);
    reg0.tools.t = { state: 'OPEN', failures: 3, openedAt: 1000 };
    saveBreaker('proj::task', reg0);
    assert.equal(loadBreaker('proj::task').tools.t.state, 'OPEN');
  });
});

test('buildBreakerNamespace sanitize + raw hash, deterministic', () => {
  assert.match(buildBreakerNamespace('o/r', 'feat/x:y'), /^o_r::feat_x_y::[0-9a-f]{6}$/);
  const ns = buildBreakerNamespace('a', 'b');
  assert.match(ns, /^a::b::[0-9a-f]{6}$/);
  assert.equal(buildBreakerNamespace('a', 'b'), ns, 'deterministic');
});

test('claimHalfOpenProbe persist: OPEN + cooldown elapsed -> claimed HALF_OPEN; còn cooldown -> false', async () => {
  await withRoot(async (root) => {
    const persist = createPersistFunctions(recordFailure, recordSuccess);
    for (let i = 0; i < 3; i++) persist.recordFailurePersist('ns', 't', `e${i}`, 1000 + i * 100);
    assert.equal(loadBreaker('ns').tools.t.state, 'OPEN');
    assert.equal(claimHalfOpenProbe('ns', 't', 1000, 1900).claimed, false, 'cooldown còn → false');
    const claim = claimHalfOpenProbe('ns', 't', 1000, 2500);
    assert.equal(claim.claimed, true);
    const after = loadBreaker('ns');
    assert.equal(after.tools.t.state, 'HALF_OPEN');
    assert.equal(after.tools.t.lastReason, 'probe_claimed');
  });
});

test('probe fail persist -> OPEN reset openedAt; probe success -> CLOSED', async () => {
  await withRoot(async (root) => {
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
  });
});

test('cross-process claim HALF_OPEN: 5 child đồng thời -> đúng 1 claimed', async () => {
  await withRoot(async (root) => {
    const persist = createPersistFunctions(recordFailure, recordSuccess);
    for (let i = 0; i < 3; i++) persist.recordFailurePersist('cp', 'tool', 'e', 1000 + i * 100);
    const tasks = Array.from({ length: 5 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath,
        [process.argv[1], '--probe-child', 'cp', 'tool', '5000', '1000'],
        { env: { ...process.env, BREAKER_RUNTIME_ROOT: root }, stdio: 'ignore' });
      child.on('error', (e) => resolve(-1));
      child.on('close', (code) => resolve(code));
    }));
    const codes = await Promise.all(tasks);
    assert.equal(codes.filter((c) => c === 0).length, 1, `expected 1 claimed, got codes=${codes.join(',')}`);
    assert.equal(loadBreaker('cp').tools.tool.state, 'HALF_OPEN');
  });
});

test('race A->B: A giữ lock, B acquire timeout; file của A còn nguyên identity A', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'race-ab.lock');
    const a = acquireLock(lockPath, 1000);
    assert.equal(a.ok, true);
    const aOwner = a.owner;
    const b = acquireLock(lockPath, 300);
    assert.equal(b.ok, false, 'B timeout vì A đang giữ');
    assert.match(b.error, /timeout/);

    assert.ok(existsSync(lockPath), 'A lock còn nguyên');
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(onDisk.pid, aOwner.pid, 'identity A còn nguyên');
    assert.equal(onDisk.nonce, aOwner.nonce, 'nonce A còn nguyên');
    releaseLock(a.fd, lockPath, aOwner);
  });
});

test('acquireLock ghi owner record fail -> closeSync+unlink+continue, KHÔNG return ok=true', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'writefail.lock');
    let unlinked = 0, closed = 0, writes = 0;
    _setFsOverride({
      openSync: () => 7, readFileSync: () => '', renameSync: () => {},
      closeSync: () => { closed++; }, unlinkSync: () => { unlinked++; },
      writeSync: (fd, buf, off, len) => {
        writes++;
        if (writes === 1) throw new Error('disk full');
        return len;
      },
    });
    try {
      // writeSync throw 1 lần → cleanup → retry → OK. Verify cleanup đúng 1 lần.
      const r = acquireLock(lockPath, 200);
      assert.equal(r.ok, true, 'sau cleanup write-fail, retry thành công');
      assert.equal(closed, 1, 'fd write-fail phải được close');
      assert.equal(unlinked, 1, 'lock write-fail phải được unlink');
      assert.equal(writes, 2, 'writeSync gọi 2 lần (1 throw, 1 success)');
      releaseLock(r.fd, lockPath, r.owner);
    } finally { _setFsOverride(null); }
  });
});

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