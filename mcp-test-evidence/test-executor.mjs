#!/usr/bin/env node
import assert from 'node:assert';
import { validateStep, validateGate, isEntrypointSafe, isArgsSafe, runGate, runStep } from './executor.mjs';
import {
  cacheKey, manifestHash, envFingerprint, cacheDirPath, artifactDirPath,
  checkCache, writeCache, prepareRuntime, createLock, cleanupExpired,
} from './cache.mjs';
import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log('=== Executor tests ===');
assert.strictEqual(isEntrypointSafe('node', '/tmp'), true);
assert.strictEqual(isEntrypointSafe('../evil', '/tmp'), false);
assert.strictEqual(isEntrypointSafe('evil/script.js', '/tmp'), true);
console.log('1. isEntrypointSafe');

assert.strictEqual(isArgsSafe(['--check', 'foo.js']), true);
assert.strictEqual(isArgsSafe(['-e', 'console.log(1)']), false);
assert.strictEqual(isArgsSafe(['--eval', 'x']), false);
assert.strictEqual(isArgsSafe(['node']), true);
assert.strictEqual(isArgsSafe(['node', 'a;b']), false);
assert.strictEqual(isArgsSafe(['node', 'a&b']), false);
assert.strictEqual(isArgsSafe(['node', 'a|b']), false);
assert.strictEqual(isArgsSafe(['node', 'a$b']), false);
assert.strictEqual(isArgsSafe(['node', 'a<b>']), false);
assert.strictEqual(isArgsSafe(['node', 'a`b`']), false);
assert.strictEqual(isArgsSafe(['node', "a'b'"]), false);
assert.strictEqual(isArgsSafe(['node', 'a"b"']), false);
assert.strictEqual(isArgsSafe(['node', '\\']), false);
console.log('2. isArgsSafe');

const mf = { gates: { unit: [{ id: 'lint', name: 'lint', command: 'node', args: ['--check', 'src'] }] } };
const root = tmpdir();
const ok = { id: 'lint', name: 'lint', command: 'node', args: ['--check', 'src'] };
assert.deepStrictEqual(validateStep(ok, mf, root), { valid: true, errors: [] });
assert.strictEqual(validateStep({ ...ok, command: '../evil' }, mf, root).valid, false);
assert.strictEqual(validateStep({ ...ok, args: ['-e', 'x'] }, mf, root).valid, false);
assert.strictEqual(validateStep({ ...ok, args: ['x;y'] }, mf, root).valid, false);
assert.strictEqual(validateStep({ ...ok, timeout: -1 }, mf, root).valid, false);
assert.strictEqual(validateStep({ ...ok, timeout: 400000 }, mf, root).valid, false);
console.log('3. validateStep');

assert.deepStrictEqual(validateGate(mf, 'unit', root), { valid: true, errors: [] });
assert.strictEqual(validateGate(mf, 'missing', root).valid, false);
console.log('4. validateGate');
console.log('=== Cache tests ===');
const fakeRoot = join(tmpdir(), 'ai-pr-reviewer-evidence', 'testproj');
try { rmSync(fakeRoot, { recursive: true, force: true }); } catch {}
const proj = 'myproj';
const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 40 hex
const mhStr = 'ababababababababababababababababababababababababababababababababab'; // 64 hex
const efStr = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'; // 64 hex
const gid = 'unit';
const key = cacheKey(proj, head, mhStr, efStr, gid);
assert.strictEqual(/^[0-9a-f]{64}$/.test(key), true);
assert.strictEqual(cacheKey(proj, head, mhStr, efStr, gid), key, 'deterministic');
assert.notStrictEqual(cacheKey(proj, head, 'x', efStr, gid), key, 'sensitive to manifestHash');
assert.notStrictEqual(cacheKey(proj, head, mhStr, efStr, 'other'), key, 'sensitive to gate');
console.log('5. cacheKey');

assert.strictEqual(/^[0-9a-f]{64}$/.test(manifestHash('{"gates":{}}')), true);
assert.notStrictEqual(manifestHash('{"a":1}'), manifestHash('{"a":2}'), 'manifest content sensitive');
console.log('6. manifestHash');

const efSeeded = envFingerprint({ NODE_ENV: 'test', CI: 'true' });
assert.strictEqual(/^[0-9a-f]{64}$/.test(efSeeded), true);
assert.notStrictEqual(envFingerprint({ NODE_ENV: 'prod', CI: 'true' }), efSeeded, 'env sensitive');
console.log('7. envFingerprint');

const cd = cacheDirPath(key, fakeRoot);
const ad = artifactDirPath(key, fakeRoot);
assert.ok(cd.endsWith('cache' + sep + key.slice(0, 2)));
assert.ok(ad.endsWith('artifacts' + sep + key.slice(0, 2)));
console.log('8. cacheDirPath/artifactDirPath');

const prep = prepareRuntime('testproj', join(tmpdir(), 'fake-git-root'));
assert.strictEqual(prep.isOutsideGit, true);
assert.ok(existsSync(join(prep.root, 'cache')));
assert.ok(existsSync(join(prep.root, 'artifacts')));
assert.ok(existsSync(join(prep.root, 'locks')));
console.log('9. prepareRuntime');

assert.deepStrictEqual(checkCache(cd, key), { valid: false, reason: 'MISSING' });
console.log('10. checkCache miss');

const fakeResult = {
  passed: true, total: 1, passedCount: 1, failedCount: 0, duration: 123,
  failureCodes: [],
  stepResults: [{ id: 'lint', name: 'lint', command: 'node', args: ['--check'], exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false, duration: 100 }],
};
writeCache({ projectId: proj, headSha: head, gateId: gid, manifestHash: mhStr, envFingerprint: efStr }, fakeResult, key, fakeRoot);
const hit = checkCache(cd, key);
assert.strictEqual(hit.valid, true);
assert.strictEqual(hit.headSha, head);
assert.strictEqual(hit.gateId, gid);
console.log('11. writeCache + checkCache hit');

(async () => {
  // FAIL không cache — key riêng
  const failKey = cacheKey(proj, head, mhStr, efStr, 'failgate');
  const failCd = cacheDirPath(failKey, fakeRoot);
  const failResult = { passed: false, total: 1, passedCount: 0, failedCount: 1, duration: 5, failureCodes: ['STEP_X_FAIL'], stepResults: [] };
  writeCache({ projectId: proj, headSha: head, gateId: 'failgate', manifestHash: mhStr, envFingerprint: efStr }, failResult, failKey, fakeRoot);
  assert.strictEqual(checkCache(failCd, failKey).valid, false, 'FAIL không được cache');
  console.log('12. FAIL không cache');

  // lock — concurrent owner bị chặn
  const lock = createLock(fakeRoot, key);
  await lock.acquire(100);
  assert.strictEqual(lock.isLocked(), true, 'sau acquire khóa giữ');
  const lock2 = createLock(fakeRoot, key);
  let timedOut = false;
  try { await lock2.acquire(150); } catch (e) { timedOut = /LOCK_TIMEOUT/.test(e.message); }
  lock.release();
  assert.strictEqual(timedOut, true, 'concurrent lock chặn owner 2');
  assert.strictEqual(lock.isLocked(), false, 'release mở khóa');
  console.log('13. lock');

    // cleanup expired — key 'deadbeef' → sub 'de'
  const expireKey = 'deadbeef';
  const exCd = cacheDirPath(expireKey, fakeRoot);
  const exAd = artifactDirPath(expireKey, fakeRoot);
  mkdirSync(exCd, { recursive: true });
  const oldMeta = join(exCd, expireKey + '.meta.json');
  writeFileSync(oldMeta, JSON.stringify({ cachedAt: Date.now() - (25 * 60 * 60 * 1000), passed: true, headSha: head, gateId: gid }));
  mkdirSync(exAd, { recursive: true });
  const oldArt = join(exAd, expireKey + '.artifact.json');
  writeFileSync(oldArt, JSON.stringify({ passed: true }));
  cleanupExpired(fakeRoot);
  assert.strictEqual(existsSync(oldMeta), false, 'meta expired bị xóa');
  assert.strictEqual(existsSync(oldArt), false, 'artifact expired bị xóa');
  console.log('14. cleanupExpired');

  // E2E: runGate PASS (node --check trên file tồn tại) + FAIL (command lỗi)
  const validManifest = {
    gates: {
      e2epass: [{ id: 'chk', name: 'check-self', command: 'node', args: ['--version'] }],
      e2efail: [{ id: 'fail', name: 'fail-cmd', command: 'node', args: ['-e', 'process.exit(1)'] }],
    },
  };
  const e2eRoot = join(fakeRoot, 'e2e');
  mkdirSync(e2eRoot, { recursive: true });
  const passRes = await runGate(validManifest, 'e2epass', { root: e2eRoot, cwd: e2eRoot });
  assert.strictEqual(passRes.passed, true);
  assert.strictEqual(passRes.total, 1);
  // E2E fail: validateGate blocks '-e' flag → GATE_INVALID (safe path)
  const failRes = await runGate(validManifest, 'e2efail', { root: e2eRoot, cwd: e2eRoot });
  assert.strictEqual(failRes.passed, false);
  // runStep direct: actual spawn of node --version (true command, exit 0)
  const stepRes = await runStep({ id: 'v', name: 'ver', command: process.execPath, args: ['--version'] }, { cwd: e2eRoot });
  assert.strictEqual(stepRes.exitCode, 0);
  assert.ok(/^v?\d+\.\d+\.\d+/.test(stepRes.stdout.trim()), 'node version output');
  console.log('15. E2E runGate + runStep');

  try { rmSync(fakeRoot, { recursive: true, force: true }); } catch {}
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
