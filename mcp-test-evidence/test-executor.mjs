#!/usr/bin/env node
import assert from 'node:assert';
import { validateStep, validateGate, isEntrypointSafe, isArgsSafe, isExecutableAllowlisted, isFlagsAllowed, runGate, runStep, canonicalizeNodeArgs } from './executor.mjs';
import {
  cacheKey, manifestHash, envFingerprint, cacheDirPath, artifactDirPath,
  checkCache, writeCache, prepareRuntime, createLock, cleanupExpired, verifyCacheIntegrity,
} from './cache.mjs';
import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync, realpathSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Helper: mô phỏng binding identity của findReport (server.mjs) cho artifact tamper test.
function findReportTamper(artifactDir, reportId) {
  const safe = { ok: /^[0-9a-f]{16}$/.test(reportId), filePath: join(artifactDir, reportId + '.json') };
  if (!safe.ok) throw new Error('reportId invalid');
  const report = JSON.parse(readFileSync(safe.filePath, 'utf8'));
  if (report.reportId !== reportId) throw new Error('identity lệch (filename != reportId)');
  const canonical = report.headSha + ':' + report.manifestHash;
  void canonical;
  return report;
}

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
// GPT-REV-102 (hardened): forbidden executable + flag whitelist + MAX_STEP_ARGS.
assert.strictEqual(isExecutableAllowlisted('powershell'), false);
assert.strictEqual(isExecutableAllowlisted('bash'), false);
assert.strictEqual(isExecutableAllowlisted('cmd.exe'), false);
assert.strictEqual(isExecutableAllowlisted('node'), true);
assert.strictEqual(isExecutableAllowlisted('node.exe'), true);
assert.strictEqual(isFlagsAllowed('node', ['--check']), true);
assert.strictEqual(isFlagsAllowed('node', ['-v']), true);
assert.strictEqual(isFlagsAllowed('node', ['--version']), true);
assert.strictEqual(isFlagsAllowed('node', ['-e', 'x']), false, 'node -e (eval) bị cấm');
assert.strictEqual(isFlagsAllowed('node', ['-p', 'x']), false, 'node -p (print) bị cấm');
assert.strictEqual(isFlagsAllowed('node', ['--eval', 'x']), false, 'node --eval bị cấm');
assert.strictEqual(isFlagsAllowed('node', ['--inspect']), false, 'node --inspect bị cấm');
assert.strictEqual(isFlagsAllowed('node', ['--loader', 'x']), false, 'node --loader bị cấm');
assert.strictEqual(validateStep({ ...ok, args: ['-e', 'process.exit(1)'] }, mf, root).valid, false, 'flag -e bị block qua whitelist');
assert.strictEqual(validateStep({ ...ok, args: ['--inspect'] }, mf, root).valid, false, 'flag --inspect bị block qua whitelist');
assert.strictEqual(validateStep({ ...ok, command: 'powershell', args: ['-c', 'x'] }, mf, root).valid, false, 'forbidden executable bị block');
assert.strictEqual(validateStep({ ...ok, command: 'bash', args: ['-c', 'x'] }, mf, root).valid, false, 'forbidden executable bị block');
assert.strictEqual(validateStep({ ...ok, args: new Array(33).fill('a') }, mf, root).valid, false, 'vượt MAX_STEP_ARGS bị block');
assert.strictEqual(validateStep({ ...ok, args: new Array(32).fill('a') }, mf, root).valid, true, 'đúng MAX_STEP_ARGS được phép');
console.log('3. validateStep');

assert.deepStrictEqual(validateGate(mf, 'unit', root), { valid: true, errors: [] });
assert.strictEqual(validateGate(mf, 'missing', root).valid, false);
console.log('4. validateGate');

// GPT-REV-105 (Finding 2): canonicalize script path cho command=node, SAU cờ Node.
// Tuyệt đối KHÔNG có nhánh `first.startsWith("-") => return args`. Phải tìm script
// operand kể cả khi flag đứng trước (vd `node --check <path>`).
{
  // script relative trong root → resolve + realpath.
  const scriptRel = 'scripts/sample.js';
  const scriptAbs = join(root, scriptRel);
  mkdirSync(join(scriptAbs, '..'), { recursive: true });
  writeFileSync(scriptAbs, 'console.log("ok")');
  const canon = canonicalizeNodeArgs({ id: 'x', command: 'node', args: [scriptRel] }, root);
  assert.ok(canon.length === 1 && canon[0] === realpathSync(scriptAbs), 'canonicalize trả absolute realpath trong root');
  // absolute path script → bị cấm (Windows C:\ hoặc POSIX /).
  let threwAbs = false;
  try { canonicalizeNodeArgs({ id: 'x', command: 'node', args: [scriptAbs] }, root); } catch { threwAbs = true; }
  assert.strictEqual(threwAbs, true, 'absolute script path bị cấm (sandbox escape)');
  // traversal → bị cấm.
  let threwTrav = false;
  try { canonicalizeNodeArgs({ id: 'x', command: 'node', args: ['../escape.js'] }, root); } catch { threwTrav = true; }
  assert.strictEqual(threwTrav, true, 'traversal script path bị cấm');
  // REGRESSION Finding 2: flag đứng TRƯỚC script path → vẫn canonicalize script operand.
  // `node --check scripts/sample.js` → ['--check', realpath(scriptAbs)].
  const flagFirst = canonicalizeNodeArgs({ id: 'x', command: 'node', args: ['--check', scriptRel] }, root);
  assert.deepStrictEqual(flagFirst, ['--check', realpathSync(scriptAbs)],
    'flag --check trước script → script operand được canonicalize, KHÔNG giữ nguyên');
  // Không có script operand (chỉ flag) → trả nguyên args.
  const noScript = canonicalizeNodeArgs({ id: 'x', command: 'node', args: ['--version'] }, root);
  assert.deepStrictEqual(noScript, ['--version'], 'không có script operand → trả nguyên args');
  // Value-taking flag (`--input-type`) kèm value → value KHÔNG bị coi là script operand.
  const valueFlag = canonicalizeNodeArgs({ id: 'x', command: 'node', args: ['--input-type', 'module', scriptRel] }, root);
  assert.deepStrictEqual(valueFlag, ['--input-type', 'module', realpathSync(scriptAbs)],
    'value-taking flag --input-type module trước script → script operand canonicalized');
}
console.log('5. canonicalizeNodeArgs (Finding 2)');

// GPT-REV-105 (Finding 3): concurrent lock thực (cross-process) + owner-only + stale-safe.
{
  const lockRoot = join(tmpdir(), 'ai-pr-reviewer-lock-test');
  try { rmSync(lockRoot, { recursive: true, force: true }); } catch {}
  mkdirSync(lockRoot, { recursive: true });
  const lockKey = 'concurrentreallock00000000000000000000000000000000000000000000000000000000000000';
  const cacheMod = JSON.stringify(pathToFileURL(join(process.cwd(), 'mcp-test-evidence', 'cache.mjs')).href);
  // Child (PID khác) giữ khóa 700ms rồi release → test parent (PID khác) bị chặn.
  const holdScript = join(lockRoot, 'lockhold.mjs');
  writeFileSync(holdScript, `
import { createLock } from ${cacheMod};
const lock = createLock(${JSON.stringify(lockRoot)}, ${JSON.stringify(lockKey)});
(async () => {
  await lock.acquire(5000);
  await new Promise(r => setTimeout(r, 2500));
  lock.release();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(3); });
`);
  const child = spawn(process.execPath, [holdScript], { stdio: 'ignore' });
  const lock = createLock(lockRoot, lockKey);
  // Đợi child thực sự giữ khóa (lockfile xuất hiện + owner = child pid) trước khi parent thử.
  const deadlineWait = Date.now() + 5000;
  while (Date.now() < deadlineWait) {
    if (existsSync(lock.lockFile)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Parent (PID khác với child) cố acquire cùng key → phải timeout (child đang giữ).
  let parentTimedOut = false;
  try { await lock.acquire(800); } catch (e) { parentTimedOut = /LOCK_TIMEOUT/.test(e.message); }
  assert.strictEqual(parentTimedOut, true, 'cross-process: parent bị chặn bởi child giữ khóa (LOCK_TIMEOUT)');
  await new Promise((res) => child.on('exit', res)); // đợi child xong

  // owner-only release: parent tạo lock, child (PID khác) gọi release → KHÔNG xóa lockfile.
  const ownKey = 'owneronlylock00000000000000000000000000000000000000000000000000000000000000';
  const ownLock = createLock(lockRoot, ownKey);
  await ownLock.acquire(1000);
  const ownChild = join(lockRoot, 'ownchild.mjs');
  writeFileSync(ownChild, `
import { createLock } from ${cacheMod};
const lock = createLock(${JSON.stringify(lockRoot)}, ${JSON.stringify(ownKey)});
lock.release(); // PID khác → không được xóa lockfile của owner
process.exit(0);
`);
  await new Promise((res) => { const c = spawn(process.execPath, [ownChild], { stdio: 'ignore' }); c.on('exit', res); });
  assert.strictEqual(ownLock.isLocked(), true, 'owner-only release: child (PID khác) không xóa lockfile của owner');
  ownLock.release();

  // stale-safe: lockfile ghi PID không tồn tại → acquire phá được ngay.
  const staleKey = 'stalelock0000000000000000000000000000000000000000000000000000000000000000';
  const staleLock = createLock(lockRoot, staleKey);
  writeFileSync(staleLock.lockFile, String(999999));
  await staleLock.acquire(1000);
  assert.strictEqual(staleLock.isLocked(), true, 'stale lock (PID chết) bị break');
  staleLock.release();

  // REGRESSION Finding 4: lockfile ghi identity <pid>:<nonce>. stale PID hoặc corrupted
  // content → atomic quarantine rename (KHÔNG read-then-unlink), rồi wx open retry.
  const qKey = 'quarantinelock000000000000000000000000000000000000000000000000000000000000000';
  const qLock = createLock(lockRoot, qKey);
  // Pre-seed lockfile với PID 999999 (không alive) + nonce giả.
  writeFileSync(qLock.lockFile, '999999:fake-nonce-xyz');
  await qLock.acquire(1000);
  // Sau acquire: lockfile phải chứa identity mới của qLock (pid:nonce), KHÔNG phải '999999:fake-nonce-xyz'.
  const owner = readFileSync(qLock.lockFile, 'utf8').trim();
  assert.ok(/^\d+:[a-f0-9]+$/.test(owner), 'Finding 4: lockfile mới có dạng <pid>:<hex-nonce>');
  assert.ok(!owner.startsWith('999999'), 'Finding 4: owner cũ (PID 999999) bị quarantine, không còn ở lockfile');
  qLock.release();
  // Release: rename tới .released-<nonce>, lockfile gốc không còn ở path cũ.
  assert.strictEqual(qLock.isLocked(), false, 'Finding 4: release atomic quarantine → lockfile biến mất');
  // Tìm file quarantine được tạo ra (audit trail).
  const lockDir = join(lockRoot, 'locks', qKey.slice(0, 2));
  const leftovers = readdirSync(lockDir).filter(f => f.includes(qKey));
  assert.ok(leftovers.some(f => /\.stale-|\.released-/.test(f)),
    'Finding 4: file quarantine (.stale-... hoặc .released-...) tồn tại để audit');
}
console.log('6. concurrent lock thực (cross-process) + owner-only release + stale-safe (Finding 3+4)');

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

// GPT-REV-103 (hardened): verifyCacheIntegrity phát tampered/swapped meta.
// Đọc meta thật từ disk để xác minh integrity (hit trả về subset, không có cacheKey).
const realMeta = JSON.parse(readFileSync(join(cd, key + '.meta.json'), 'utf8'));
assert.strictEqual(verifyCacheIntegrity(realMeta, key), true, 'meta ghi đúng key hợp lệ');
const tampered = { ...realMeta, cacheKey: '0'.repeat(64), projectId: 'evil' };
assert.strictEqual(verifyCacheIntegrity(tampered, key), false, 'cacheKey sai bị phát');
const swapped = { ...realMeta, gateId: 'other' };
assert.strictEqual(verifyCacheIntegrity(swapped, key), false, 'recomputed key lệch do gateId đổi');
const directHit = checkCache(cd, key);
assert.strictEqual(directHit.manifestHash, mhStr, 'hit trả về manifestHash');
assert.strictEqual(directHit.envFingerprint, efStr, 'hit trả về envFingerprint');
console.log('11c. verifyCacheIntegrity (meta thật)');

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

  // GPT-REV-105 (Finding 4): artifact tamper — test_run ghi CompactReport vào runtime
  // store; report bị sửa (reportId lệch) phải bị read tools từ chối (canonical binding).
  {
    const tamperKey = 'artifacttamper000000000000000000000000000000000000000000000000000000';
    const tamperCd = cacheDirPath(tamperKey, fakeRoot);
    const tamperAd = artifactDirPath(tamperKey, fakeRoot);
    mkdirSync(tamperAd, { recursive: true });
    const realReportId = 'a1b2c3d4e5f6a7b8';
    // ghi report hợp lệ.
    writeFileSync(join(tamperAd, realReportId + '.json'), JSON.stringify({
      schemaVersion: '1.0', headSha: head, passed: true,
      tests: { passed: 1, failed: 0, total: 1 }, duration: 5,
      reportId: realReportId, manifestHash: mhStr, blocking: 0, failureCodes: [], failures: [],
    }));
    const okRep = findReportTamper(tamperAd, realReportId);
    assert.strictEqual(okRep.reportId, realReportId, 'report hợp lệ đọc được');
    // tamper: sửa reportId trong file khác với filename → phải từ chối.
    const tamperedId = 'f9e8d7c6b5a4f9e8';
    writeFileSync(join(tamperAd, tamperedId + '.json'), JSON.stringify({
      schemaVersion: '1.0', headSha: head, passed: true,
      tests: { passed: 1, failed: 0, total: 1 }, duration: 5,
      reportId: '0000000000000000', manifestHash: mhStr, blocking: 0, failureCodes: [], failures: [],
    }));
    let threwTamper = false;
    try { findReportTamper(tamperAd, tamperedId); } catch { threwTamper = true; }
    assert.strictEqual(threwTamper, true, 'artifact tamper (reportId lệch) bị từ chối');
  }
  console.log('16. artifact tamper (Finding 4)');

  // GPT-REV-106 (Finding 3): stale-lock race — đọc identity A, atomic-swap lockfile
  // thành B giữa observation và quarantine → B KHÔNG bị mất. Test bằng test hook
  // __quarantineForTest: mô phỏng race bằng cách set lockFile = identity A, gọi
  // __quarantineForTest(A) nhưng ngay trước khi nó re-read, swap lockFile thành B
  // (thông qua side effect: trong test này, gọi __quarantineForTest với observed=A
  // nhưng lockFile hiện tại đã là B) → phải trả race_detected, KHÔNG rename.
  {
    const raceKey = 'racetest' + '0'.repeat(58);
    const raceRoot = join(tmpdir(), 'fake-race-' + Date.now());
    const raceLock = createLock(raceRoot, raceKey);
    const lockPath = raceLock.lockFile;
    // Identity A: PID chết (giả), nonce A.
    const identA = '99999:aaaaaaaaaaaaaaaa';
    writeFileSync(lockPath, identA);
    // Atomic swap lockFile thành identity B (mô phỏng process khác đã quarantine A
    // rồi ghi B với identity khác). Trong test, swap = writeFileSync lại với B
    // (lockfile path như nhau, content đã đổi).
    const identB = '88888:bbbbbbbbbbbbbbbb';
    writeFileSync(lockPath, identB);
    // Gọi quarantine với observed=A, nhưng lockfile hiện tại = B → race detected.
    const r = raceLock.__quarantineForTest(identA);
    assert.strictEqual(r.ok, false, 'race: identity đã đổi → ok=false');
    assert.strictEqual(r.reason, 'race_detected', 'race: reason=race_detected');
    // Verify lockfile vẫn còn identity B (KHÔNG bị rename nhầm).
    assert.strictEqual(readFileSync(lockPath, 'utf8').trim(), identB, 'race: B vẫn còn identity nguyên vẹn');
    // Verify không có stale file nào được tạo (vì rename không xảy ra).
    const dir = dirname(lockPath);
    const stale = readdirSync(dir).filter(f => f.startsWith(basename(lockPath) + '.stale-'));
    assert.strictEqual(stale.length, 0, 'race: không tạo stale file (rename đã bị chặn)');
    // Cleanup: rename thật với observed=B để lockfile B được move ra stale (đúng).
    const r2 = raceLock.__quarantineForTest(identB);
    assert.strictEqual(r2.ok, true, 'sau khi re-read đồng bộ → rename OK');
    const stale2 = readdirSync(dir).filter(f => f.startsWith(basename(lockPath) + '.stale-'));
    assert.strictEqual(stale2.length, 1, 'sau rename: 1 stale file');
    assert.ok(stale2[0].includes('bbbbbbbbbbbbbbbb'), 'stale file suffix chứa identity B (KHÔNG chứa A)');
    try { rmSync(raceRoot, { recursive: true, force: true }); } catch {}
  }
  console.log('17. stale-lock race (Finding 3)');

  try { rmSync(fakeRoot, { recursive: true, force: true }); } catch {}
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });