#!/usr/bin/env node
/**
 * mcp-test-evidence/cache.mjs — Issue #19 Phase 3: Cache + artifact store.
 * Cache identity: sha256(projectId|headSha|manifestHash|envFingerprint|gate).
 * Runtime/artifacts ngoai Git repo. TTL 24h. PASS-only cache. Concurrent lock. Atomic write.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

export function createLock(root, key) {
  let lockFile, held = false;
  const getLockFile = () => {
    if (!lockFile) {
      const sub = key.slice(0, 2);
      const d = join(root, 'locks', sub);
      mkdirSync(d, { recursive: true });
      lockFile = join(d, key + '.lock');
    }
    return lockFile;
  };
  return {
    async acquire(timeoutMs = 5000) {
      const lf = getLockFile();
      const deadline = Date.now() + timeoutMs;
      while (existsSync(lf)) {
        if (Date.now() > deadline) throw new Error('LOCK_TIMEOUT:' + key);
        await new Promise(r => setTimeout(r, 100));
      }
      writeFileSync(lf, String(process.pid), { mode: 0o644 });
      held = true;
    },
    release() {
      if (held && lockFile) { held = false; try { unlinkSync(lockFile); } catch {} }
    },
    isLocked() { return lockFile ? existsSync(lockFile) : false; },
  };
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

export function checkCache(cacheDirP, key) {
  const metaFile = join(cacheDirP, key + '.meta.json');
  if (!existsSync(metaFile)) return { valid: false, reason: 'MISSING' };
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    const age = Date.now() - (meta.cachedAt || 0);
    if (age > CACHE_TTL_MS) return { valid: false, reason: 'TTL_EXPIRED', age };
    if (!meta.passed) return { valid: false, reason: 'NOT_PASS', passed: false };
    return { valid: true, cachedAt: meta.cachedAt, headSha: meta.headSha, gateId: meta.gateId };
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
