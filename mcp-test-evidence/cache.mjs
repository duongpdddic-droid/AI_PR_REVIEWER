#!/usr/bin/env node
/**
 * mcp-test-evidence/cache.mjs — Issue #19 Phase 3: Cache + artifact store.
 * Cache identity: sha256(projectId|headSha|manifestHash|envFingerprint|gate).
 * Runtime/artifacts ngoai Git repo. TTL 24h. PASS-only cache. Concurrent lock. Atomic write.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { computeReportId, saveReport } from '../scripts/test-evidence-reporter.mjs';

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheKey(projectId, headSha, manifestHash, envFingerprint, gate) {
  const raw = [projectId, headSha, manifestHash, envFingerprint, gate].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

export function sha256hex(str) { return createHash('sha256').update(str).digest('hex'); }
export function manifestHash(manifestContent) { return sha256hex(manifestContent); }

export function envFingerprint(envSnapshot) {
  const keys = Object.keys(envSnapshot).sort();
  const repr = keys.map(k => k + '=' + envSnapshot[k]).join('\x00');
  return sha256hex(repr);
}

export function runtimeRoot(projectId) {
  const base = process.env.XDG_RUNTIME_DIR || tmpdir();
  const safeId = String(projectId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(base, 'ai-pr-reviewer-evidence', safeId);
}

export function cacheDirPath(key, root) {
  return join(root, 'cache', key.slice(0, 2));
}

export function artifactDirPath(key, root) {
  return join(root, 'artifacts', key.slice(0, 2));
}

// GPT-REV-105 (hardened): một implementation lock duy nhất — atomic `wx` open
// (không TOCTOU), chỉ owner (PID + nonce ghi trong lockfile) mới được release, stale-safe
// (PID không còn chạy → atomic quarantine rename rồi retry, KHÔNG read-then-unlink path
// có thể đã bị thay). Lockfile content = `<pid>:<nonce>` (hex random 16 bytes).
//
// Finding 4 (GPT-REV-105): stale-lock takeover phải dùng lock nonce/identity + atomic
// quarantine rename; cấm read PID rồi unlink path có thể đã bị thay. Rename trong cùng
// FS là atomic; lockfile sau rename không còn ở vị trí cũ → wx open retry sẽ thắng.
export function createLock(root, key) {
  const sub = key.slice(0, 2);
  const d = join(root, 'locks', sub);
  mkdirSync(d, { recursive: true });
  const lockFile = join(d, key + '.lock');
  // Per-instance nonce; kết hợp với PID làm identity. Mỗi process spawn nonce mới.
  const myNonce = createHash('sha256').update(String(process.pid) + ':' + Math.random() + ':' + Date.now()).digest('hex').slice(0, 16);
  let held = false;
  let myIdentity = null; // '<pid>:<nonce>' khi đã acquire

  function pidAlive(pid) {
    if (!pid || pid <= 0) return false;
    // process.kill(pid, 0): không throw → alive; ESRCH → chết; EPERM → alive (tồn tại).
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  // Atomic quarantine: rename lockfile ra tên unique → nếu rename thành công, lockfile
  // cũ đã bị loại bỏ nguyên tử (cùng FS), wx open retry sẽ thắng. Nếu lockfile đã bị
  // unlink bởi owner trước đó → rename sẽ throw ENOENT → an toàn bỏ qua.
  // Suffix dùng nonce đọc từ lockfile (nếu có) + timestamp + pid hiện tại để tránh va chạm.
  function quarantineLockFile(observedNonce) {
    const suffix = observedNonce
      ? observedNonce.slice(0, 8) + '-' + Date.now() + '-' + process.pid
      : 'corrupt-' + Date.now() + '-' + process.pid;
    const quarantine = lockFile + '.stale-' + suffix;
    try {
      renameSync(lockFile, quarantine);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async acquire(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let fd;
        try {
          fd = openSync(lockFile, 'wx', 0o644); // atomic: fail nếu đã tồn tại
          myIdentity = process.pid + ':' + myNonce;
          writeSync(fd, myIdentity);
          closeSync(fd);
          held = true;
          return;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          // Stale-safe: đọc identity (pid:nonce), kiểm tra owner có thật sự còn sống
          // (PID reuse defense) HOẶC lockfile corrupt. KHÔNG đụng vào lock của một instance
          // KHÁC trong CÙNG process — chúng chia sẻ PID, chỉ phân biệt bằng nonce; nếu
          // lấy nhầm, hai instance có thể ghi đè cache key lẫn nhau.
          // KHÔNG dùng read-then-unlink (TOCTOU): dùng atomic quarantine rename.
          let ownerPid = null;
          let ownerNonce = null;
          let corrupt = false;
          try {
            const raw = readFileSync(lockFile, 'utf8').trim();
            const parts = raw.split(':');
            const pidStr = parts[0];
            const nonce = parts[1];
            const pidN = Number(pidStr);
            if (Number.isFinite(pidN) && pidN > 0) {
              ownerPid = pidN;
              ownerNonce = typeof nonce === 'string' && /^[a-f0-9]+$/.test(nonce) ? nonce : null;
            } else {
              corrupt = true;
            }
          } catch { corrupt = true; }
          // Stale takeover decision (chỉ quyết định trên PID, KHÔNG trên nonce trong cùng
          // process). Cùng PID + nonce khác = instance khác của CHÍNH process này vẫn đang
          // giữ lock → KHÔNG stale (chờ owner release). Khác PID = process khác đang giữ;
          // chỉ stale khi PID khác đã chết HOẶC lockfile corrupt. PID reuse scenario
          // (process mới lấy lại PID cũ + nonce cũ) được phát hiện qua pidAlive=false
          // hoặc corrupt → quarantine an toàn.
          const isStale = corrupt
            || ownerPid === null
            || (ownerPid !== process.pid && !pidAlive(ownerPid));
          if (isStale) {
            if (quarantineLockFile(ownerNonce)) continue;
            // Quarantine fail (lockfile đã bị owner release giữa lúc đọc) → retry wx open.
          }
          if (Date.now() > deadline) throw new Error('LOCK_TIMEOUT:' + key);
          await new Promise(r => setTimeout(r, 50));
        }
      }
    },
    release() {
      if (!held) return;
      held = false;
      // Owner-only: chỉ xóa nếu lockfile identity (pid:nonce) khớp chính mình.
      // Dùng rename tới quarantine (atomic), KHÔNG unlink thẳng: nếu lockfile đã bị
      // quarantine/remove bởi người khác giữa lúc check, rename fail an toàn.
      try {
        const owner = readFileSync(lockFile, 'utf8').trim();
        if (owner === myIdentity) {
          // Atomic quarantine để tránh unlink path có thể đã bị thay.
          try { renameSync(lockFile, lockFile + '.released-' + myNonce); } catch { /* already gone */ }
        }
      } catch { /* lockfile đã mất → coi như đã release */ }
    },
    isLocked() { return existsSync(lockFile); },
    get lockFile() { return lockFile; },
    get identity() { return myIdentity; },
    get nonce() { return myNonce; },
  };
}

// GPT-REV-105: build canonical CompactReport (schema v1) từ kết quả runGate và
// persist vào runtime artifact store. reportId = computeReportId(headSha, manifestHash).
// Chặn absolute path / traversal khi lưu (safePath trong saveReport).
export function writeRuntimeReport({ projectId, headSha, manifestHash, gateId, envFingerprint }, result, root) {
  const reportId = computeReportId(headSha, manifestHash);
  const failures = (result.stepResults || [])
    .filter(sr => sr.exitCode !== 0 || sr.timedOut || sr.stdoutTruncated || sr.stderrTruncated)
    .map(sr => ({
      code: `STEP_${String(sr.id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FAIL`,
      step: sr.id,
      detail: `command=${sr.command} args=${JSON.stringify(sr.args)} exitCode=${sr.exitCode} timedOut=${!!sr.timedOut}`,
      logExcerpt: (sr.stderr || sr.stdout || '').slice(0, 4000),
    }));
  const report = {
    schemaVersion: '1.0',
    headSha,
    passed: result.passed,
    tests: { passed: result.passedCount, failed: result.failedCount, total: result.total },
    duration: result.duration,
    reportId,
    manifestHash,
    blocking: result.passed ? 0 : Math.max(1, failures.length),
    failureCodes: result.failureCodes || [],
    failures,
    environmentFingerprint: envFingerprint,
  };
  const artifactDir = artifactDirPath(cacheKey(projectId, headSha, manifestHash, envFingerprint, gateId), root);
  saveReport(report, artifactDir);
  return { reportId, artifactDir };
}

function ensureDir(filePath) {
  mkdirSync(filePath.replace(/[/\\][^/\\]*$/, ''), { recursive: true });
}

function atomicWrite(filePath, content) {
  ensureDir(filePath);
  const tmp = filePath + '.tmp-' + Date.now() + '-' + process.pid;
  writeFileSync(tmp, content, { encoding: 'utf8' });
  renameSync(tmp, filePath);
}

// GPT-REV-103 (hardened): xác minh identity của cache bằng cách recompute key từ
// các trường định danh trong meta, đối chiếu với key yêu cầu. Ngăn tampered/
// swapped meta khớp nhầm key (server-proven identity).
export function verifyCacheIntegrity(meta, key) {
  if (!meta || typeof meta !== 'object') return false;
  // meta phải ghi chính key để đối chiếu trực tiếp.
  if (meta.cacheKey !== key) return false;
  // recompute độc lập từ các trường định danh (defense-in-depth).
  const recomputed = cacheKey(
    meta.projectId, meta.headSha, meta.manifestHash, meta.envFingerprint, meta.gateId,
  );
  return recomputed === key;
}

export function checkCache(cacheDirP, key) {
  const metaFile = join(cacheDirP, key + '.meta.json');
  if (!existsSync(metaFile)) return { valid: false, reason: 'MISSING' };
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    const age = Date.now() - (meta.cachedAt || 0);
    if (age > CACHE_TTL_MS) return { valid: false, reason: 'TTL_EXPIRED', age };
    if (!meta.passed) return { valid: false, reason: 'NOT_PASS', passed: false };
    if (!verifyCacheIntegrity(meta, key)) return { valid: false, reason: 'IDENTITY_MISMATCH' };
    return { valid: true, cachedAt: meta.cachedAt, headSha: meta.headSha, gateId: meta.gateId, manifestHash: meta.manifestHash, envFingerprint: meta.envFingerprint };
  } catch { return { valid: false, reason: 'CORRUPTED' }; }
}

export function writeCache(meta, result, key, root) {
  if (!result.passed) return;
  const cd = cacheDirPath(key, root);
  const ad = artifactDirPath(key, root);
  const metaFile = join(cd, key + '.meta.json');
  const artifactFile = join(ad, key + '.artifact.json');
  const redactedResult = {
    passed: result.passed, total: result.total, passedCount: result.passedCount,
    failedCount: result.failedCount, duration: result.duration,
    failureCodes: result.failureCodes,
    stepResults: (result.stepResults || []).map(sr => ({
      id: sr.id, name: sr.name, command: sr.command, args: sr.args,
      exitCode: sr.exitCode, timedOut: sr.timedOut,
      stdoutTruncated: sr.stdoutTruncated, stderrTruncated: sr.stderrTruncated,
      duration: sr.duration,
    })),
  };
  atomicWrite(metaFile, JSON.stringify({ ...meta, cacheKey: key, cachedAt: Date.now(), passed: result.passed }));
  atomicWrite(artifactFile, JSON.stringify(redactedResult, null, 2));
}

export function cleanupExpired(root) {
  try {
    const cr = join(root, 'cache');
    if (!existsSync(cr)) return;
    for (const sub of readdirSync(cr)) {
      const sp = join(cr, sub);
      if (!existsSync(sp) || !/^[a-f0-9]{2}$/.test(sub)) continue;
      for (const f of readdirSync(sp)) {
        if (!f.endsWith('.meta.json')) continue;
        const mp = join(sp, f);
        try {
          const meta = JSON.parse(readFileSync(mp, 'utf8'));
          if (Date.now() - (meta.cachedAt || 0) > CACHE_TTL_MS) {
            const key = f.replace('.meta.json', '');
            try { unlinkSync(join(artifactDirPath(key, root), key + '.artifact.json')); } catch {}
            unlinkSync(mp);
          }
        } catch {}
      }
    }
  } catch {}
}

export function prepareRuntime(projectId, gitRoot) {
  const root = runtimeRoot(projectId);
  const isOutsideGit = !resolve(root).startsWith(resolve(gitRoot));
  mkdirSync(join(root, 'cache'), { recursive: true });
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  mkdirSync(join(root, 'locks'), { recursive: true });
  return { root, isOutsideGit };
}
