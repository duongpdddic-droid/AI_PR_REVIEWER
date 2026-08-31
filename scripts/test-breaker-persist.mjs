#!/usr/bin/env node
// test-breaker-persist.mjs — persist circuit breaker (Finding 1+2+3). Exit 0=PASS.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
// --acquire-child <lockPath>: acquire + hold 500ms + release, stdout JSON result
if (process.argv[2] === '--acquire-child') {
  const lockPath = process.argv[3];
  const r = acquireLock(lockPath, 250);
  process.stdout.write(JSON.stringify({ ok: r.ok, nonce: r.owner && r.owner.nonce, error: r.error || null }) + '\n');
  if (r.ok) { await new Promise((res) => setTimeout(res, 500)); releaseLock(r.fd, lockPath, r.owner); }
  process.exit(0);
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

test('atomicWriteJson + readJsonSafe round-trip; file thiếu/corrupt -> null', async () => {
  await withRoot(async (root) => {
    const f = join(root, 'x.json');
    atomicWriteJson(f, { ok: true, tools: { t: { state: 'OPEN' } } });
    const d = readJsonSafe(f);
    assert.equal(d.ok, true);
    assert.equal(d.tools.t.state, 'OPEN');
    assert.equal(readJsonSafe(join(root, 'missing.json')), null);
    writeFileSync(join(root, 'bad.json'), '{not-json', 'utf8');
    assert.equal(readJsonSafe(join(root, 'bad.json')), null);
  });
});

test('loadBreaker corrupt / missing ok flag -> ok=false fail-closed', async () => {
  await withRoot(async (root) => {
    const f = breakerFilePath('ns-corrupt');
    writeFileSync(f, '{not-json', 'utf8');
    const r = loadBreaker('ns-corrupt');
    assert.equal(r.ok, false, 'corrupt file phải fail-closed');
    assert.equal(r.tools, null, 'corrupt file KHÔNG trả tools default');
    assert.ok(r.reason && typeof r.reason === 'string', 'phải có reason');
    const claim = claimHalfOpenProbe('ns-corrupt', 'tool', 1000, 5000);
    assert.equal(claim.claimed, false);
    const f2 = breakerFilePath('ns-no-ok');
    writeFileSync(f2, JSON.stringify({ threshold: 3, cooldownMs: 1000, tools: {} }), 'utf8');
    const r2 = loadBreaker('ns-no-ok');
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /ok=true/);
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
    assert.match(buildBreakerNamespace('o/r', 'feat/x:y'), /^o_r::feat_x_y::[0-9a-f]{6}$/);
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

test('acquireLock: exclusive (lần 2 timeout), ghi owner record {pid, nonce}', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'a.lock');
    const first = acquireLock(lockPath, 2000);
    assert.equal(first.ok, true);
    assert.equal(first.owner.pid, process.pid);
    assert.ok(typeof first.owner.nonce === 'string' && first.owner.nonce.length > 0);
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.nonce, first.owner.nonce);
    const second = acquireLock(lockPath, 300);
    assert.equal(second.ok, false);
    releaseLock(first.fd, lockPath, first.owner);
    const third = acquireLock(lockPath, 500);
    assert.equal(third.ok, true);
    releaseLock(third.fd, lockPath, third.owner);
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

test('recovery fail-closed: orphan (RECOVERY_REQUIRED), alive/corrupt (timeout) — KHÔNG tự xóa', async () => {
  await withRoot(async (root) => {
    const specs = [
      { name: 'orphan.lock', payload: JSON.stringify({ pid: 999_999_999, nonce: 'old', createdAt: 0 }), match: /RECOVERY_REQUIRED/ },
      { name: 'alive.lock', payload: JSON.stringify({ pid: process.pid, nonce: 'stale-self', createdAt: 0 }), match: /timeout/ },
      { name: 'corrupt.lock', payload: 'not-json-at-all', match: /timeout/ },
    ];
    for (const s of specs) {
      const lockPath = join(root, s.name);
      writeFileSync(lockPath, s.payload, 'utf8');
      const r = acquireLock(lockPath, 200);
      assert.equal(r.ok, false, `${s.name} → fail-closed`);
      assert.match(r.error, s.match);
      assert.ok(existsSync(lockPath), `${s.name} không bị xóa`);
    }
    const list = readdirSync(root);
    assert.ok(!list.some((f) => f.startsWith('orphan.lock.recover-')), 'no auto-delete quarantine');
  });
});

test('interleaving thật: 2 child process claim đồng thời → đúng 1 thắng', async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, 'inter.lock');
    const child = (env) => new Promise((resolve) => {
      const c = spawn(process.execPath, [process.argv[1], '--acquire-child', lockPath],
        { env: { ...process.env, BREAKER_RUNTIME_ROOT: root, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d.toString(); });
      c.on('close', () => resolve(JSON.parse(out.trim())));
      c.on('error', () => resolve({ ok: false, error: 'spawn_fail' }));
    });
    const [a, b] = await Promise.all([child(), child()]);
    const winners = [a, b].filter((o) => o.ok);
    assert.equal(winners.length, 1, 'đúng 1 child acquire được');
    const loser = [a, b].find((o) => !o.ok);
    assert.ok(loser, '1 child thua');
    assert.match(loser.error || '', /timeout|RECOVERY_REQUIRED/);
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

test('withFileLock tự unlock; loadBreaker default + saveBreaker round-trip', async () => {
  await withRoot(async (root) => {
    let ran = 0;
    withFileLock('ns-lock', () => { ran += 1; return { ok: true }; });
    withFileLock('ns-lock', () => { ran += 1; return { ok: true }; });
    assert.equal(ran, 2);
    const reg0 = loadBreaker('proj::task');
    assert.equal(reg0.ok, true);
    assert.equal(reg0.threshold, 3);
    assert.equal(Object.keys(reg0.tools).length, 0);
    reg0.tools.t = { state: 'OPEN', failures: 3, openedAt: 1000 };
    saveBreaker('proj::task', reg0);
    assert.equal(loadBreaker('proj::task').tools.t.state, 'OPEN');
  });
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

test('acquireLock ghi owner record fail -> chỉ close fd, KHÔNG unlink pathname', async () => {
  // Review #5060996893: write-fail cleanup KHÔNG unlink pathname (TOCTOU nuốt lock khác).
  await withRoot(async (root) => {
    const lockPath = join(root, 'writefail.lock');
    let unlinked = 0, closed = 0, writes = 0, opens = 0;
    _setFsOverride({
      openSync: (p, flag) => { opens++; return 7; },
      readFileSync: () => '',
      renameSync: () => {},
      closeSync: () => { closed++; },
      unlinkSync: () => { unlinked++; },
      writeSync: (fd, buf, off, len) => {
        writes++;
        if (writes === 1) throw new Error('disk full');
        return len;
      },
    });
    try {
      // writeSync throw 1 lần → cleanup (close) → retry → OK. Verify KHÔNG unlink.
      const r = acquireLock(lockPath, 200);
      assert.equal(r.ok, true, 'sau cleanup write-fail, retry thành công');
      assert.equal(closed, 1, 'fd write-fail phải được close');
      assert.equal(unlinked, 0, 'KHÔNG được unlink pathname (TOCTOU-safe)');
      assert.equal(writes, 2, 'writeSync gọi 2 lần (1 throw, 1 success)');
      assert.equal(opens, 2, 'openSync 2 lần (1 fail, 1 success)');
      releaseLock(r.fd, lockPath, r.owner);
    } finally { _setFsOverride(null); }
  });
});

test('releaseLock honor _fs override closeSync (mock fd=7 không đóng fd thật)', async () => {
  // Regress SIGABRT: releaseLock phải dùng _fs lookup, không gọi closeSync thật với mock fd.
  await withRoot(async (root) => {
    const lockPath = join(root, 'rel.lock');
    let closedMock = 0;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: 'real', createdAt: 0 }), 'utf8');
    _setFsOverride({
      openSync: () => 7,
      writeSync: (fd, buf, off, len) => len,
      closeSync: (fd) => { closedMock++; },
      unlinkSync: () => {},
      readFileSync: (p) => p === lockPath ? JSON.stringify({ pid: process.pid, nonce: 'real', createdAt: 0 }) : '',
      renameSync: () => {},
    });
    try {
      const r = acquireLock(lockPath, 200);
      assert.equal(r.ok, true, 'mock openSync trả fd=7 + writeSync trả len');
      releaseLock(r.fd, lockPath, r.owner);
      assert.equal(closedMock, 1, 'releaseLock đã gọi closeSync qua _fs, không đóng fd thật');
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