// breaker-persist.mjs — persist circuit breaker state (Issue #25). YAGNI: JSON + rename + exclusive lock.
import { readFileSync, writeFileSync, writeSync, mkdirSync, existsSync, renameSync, unlinkSync, openSync, closeSync, fstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
export function resolveRuntimeRoot() {
  return process.env.BREAKER_RUNTIME_ROOT || join(homedir(), '.ai-pr-reviewer');
}
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
export function atomicWriteJson(filePath, data) {
  ensureDir(filePath.replace(/[/\\][^/\\]*$/, ''));
  const tmp = filePath + '.tmp.' + (randomUUID() || Date.now().toString(36));
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, filePath);
}
export function readJsonSafe(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let _fsOverride = null;
export function _setFsOverride(o) { _fsOverride = o; }
const _fs = (name) => (_fsOverride && _fsOverride[name]) || { openSync, writeFileSync, writeSync, renameSync, unlinkSync, readFileSync, closeSync, existsSync }[name];
function _pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (err) {
    if (err.code === 'EPERM') return 'alive';
    if (err.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}
function _readLockOwner(lockPath) {
  try {
    const data = JSON.parse(_fs('readFileSync')(lockPath, 'utf8'));
    if (data && typeof data === 'object' && Number.isInteger(data.pid) && typeof data.nonce === 'string') return data;
    return null;
  } catch { return null; }
}
// MVP: no auto stale-lock deletion/recovery — owner dead/unknown/corrupt → RECOVERY_REQUIRED, chỉ operator xóa sau xác minh.
function _tryRecoverStaleLock(lockPath) {
  const owner = _readLockOwner(lockPath);
  if (!owner) return { recovered: false, reason: 'RECOVERY_REQUIRED: lock owner unreadable' };
  if (_pidAlive(owner.pid) === 'dead') return { recovered: false, reason: 'RECOVERY_REQUIRED: lock owner PID is dead' };
  return { recovered: false, reason: 'RECOVERY_REQUIRED: lock held by another owner' };
}

// acquireLock: openSync('wx') exclusive; write fail (throw/short) → close fd, KHÔNG unlink (EEXIST fail-closed); lock khác PID → RECOVERY_REQUIRED.
export function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  let firstReason = null;
  const myNonce = randomUUID();
  const fs = _fs;
  // Write-fail cleanup: chỉ close fd, KHÔNG unlink pathname (TOCTOU-safe, review #5060996893).
  const cleanup = (fd) => { try { fs('closeSync')(fd); } catch { /* ignore */ } };
  while (Date.now() < deadline) {
    try {
      const fd = fs('openSync')(lockPath, 'wx');
      const buf = Buffer.from(JSON.stringify({ pid: process.pid, nonce: myNonce, createdAt: Date.now() }), 'utf8');
      let written = 0;
      try { written = fs('writeSync')(fd, buf, 0, buf.length, 0); }
      catch (writeErr) { cleanup(fd); lastErr = writeErr; continue; }
      if (written !== buf.length) { cleanup(fd); lastErr = new Error(`short write: ${written}/${buf.length}`); continue; }
      // Ownership intrinsic: fileId (dev+ino) của file VỪA TẠO qua fd — release không move/unlink path người khác.
      let fileId = null;
      try { const st = fstatSync(fd); if (st && st.ino > 0) fileId = { dev: st.dev, ino: st.ino }; } catch { /* fallback: verify bằng nonce */ }
      return { ok: true, fd, owner: { pid: process.pid, nonce: myNonce, createdAt: Date.now(), fileId }, error: null };
    } catch (err) {
      lastErr = err;
      if (err.code === 'EEXIST' || err.code === 'EEXIT') {
        const probe = _tryRecoverStaleLock(lockPath);
        if (probe.reason) { if (!firstReason) firstReason = probe.reason; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      return { ok: false, fd: null, owner: null, error: `lock acquire error: ${err.message}` };
    }
  }
  const reason = firstReason || (lastErr ? lastErr.message : 'unknown');
  return { ok: false, fd: null, owner: null, error: `lock timeout after ${timeoutMs}ms: ${reason}` };
}

// releaseLock: atomic rename → quarantine (unique nonce), verify nội dung, chỉ unlink quarantine — pathname chung không bao giờ bị unlink trực tiếp. [test-seam] _fs lookup.
export function releaseLock(fd, lockPath, expectedOwner) {
  try { _fs('closeSync')(fd); } catch { /* ignore */ }
  if (!expectedOwner || typeof expectedOwner !== 'object'
      || !Number.isInteger(expectedOwner.pid) || typeof expectedOwner.nonce !== 'string') {
    return { ok: false, reason: 'RECOVERY_REQUIRED: invalid owner metadata' };
  }
  // Guard 1: owner content match
  const current = _readLockOwner(lockPath);
  if (!current || current.pid !== expectedOwner.pid || current.nonce !== expectedOwner.nonce) {
    return { ok: false, reason: 'RECOVERY_REQUIRED: lock not owned by caller' };
  }
  // Atomic rename sang quarantine — intrinsic ownership via unique nonce path
  const qp = lockPath + '.release-' + expectedOwner.nonce;
  try { renameSync(lockPath, qp); }
  catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'RECOVERY_REQUIRED: lock file missing' };
    return { ok: false, reason: `RECOVERY_REQUIRED: rename failed: ${e.message}` };
  }
  // Guard 2: verify quarantined content is ours
  const moved = _readLockOwner(qp);
  if (!moved || moved.pid !== expectedOwner.pid || moved.nonce !== expectedOwner.nonce) {
    try { if (!_fs('existsSync')(lockPath)) renameSync(qp, lockPath); } catch {}
    return { ok: false, reason: 'RECOVERY_REQUIRED: lock replaced by another owner' };
  }
  // Unlink quarantine (tên riêng, không bao giờ đụng shared pathname)
  try { _fs('unlinkSync')(qp); return { ok: true, reason: null }; }
  catch (e) {
    try { if (!_fs('existsSync')(lockPath)) renameSync(qp, lockPath); } catch {}
    return { ok: false, reason: `RECOVERY_REQUIRED: unlink failed: ${e.message}` };
  }
}

// withFileLock: surface release failure, preserve callback exception.
export function withFileLock(namespace, fn, timeoutMs = 5000) {
  const root = resolveRuntimeRoot();
  ensureDir(root);
  const lockPath = join(root, `breaker-${safeFilePart(namespace)}.lock`);
  const { ok, fd, owner, error } = acquireLock(lockPath, timeoutMs);
  if (!ok) return { ok: false, error };
  let result;
  let fnErr = null;
  try { result = fn(namespace); }
  catch (e) { fnErr = e; }
  const release = releaseLock(fd, lockPath, owner);
  if (fnErr) throw fnErr;
  if (!release.ok) return { ok: false, error: release.reason, lockHeld: true, result };
  return result;
}

// Windows-safe + collision-safe: sanitize ký tự nguy hiểm, giới hạn độ dài, short hash chống collision.
const MAX_PART_LEN = 80;
const HASH_LEN = 8;
function _shortHash(s) {
  return createHash('sha256').update(String(s || '')).digest('hex').slice(0, HASH_LEN);
}
function safeFilePart(namespace) {
  const raw = String(namespace || '');
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const head = cleaned.slice(0, MAX_PART_LEN) || 'default';
  const hash = _shortHash(raw);
  return `${head}-${hash}`;
}
export function breakerFilePath(namespace) {
  return join(resolveRuntimeRoot(), `breaker-${safeFilePart(namespace)}.json`);
}
export function buildBreakerNamespace(project = 'default', task = 'default') {
  // Sanitize + 6-hex raw hash chống collision: "a/b" vs "a_b" sanitize cùng chuỗi nhưng raw hash khác.
  const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const raw = `${String(project || '')}\u0000${String(task || '')}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 6);
  return `${safe(project)}::${safe(task)}::${hash}`;
}

// Load breaker state. Fail-closed: file corrupt / sai shape → ok=false. File chưa có → fresh.
const VALID_STATES = new Set(['CLOSED', 'OPEN', 'HALF_OPEN']);
function _fail(threshold, cooldownMs, reason) {
  return { ok: false, threshold, cooldownMs, tools: null, reason };
}
function _validateEntry(t, e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return `breaker file tools[${t}] not a plain object`;
  if (!VALID_STATES.has(e.state)) return `breaker file tools[${t}].state invalid: ${e.state}`;
  if (typeof e.failures !== 'number' || !Number.isInteger(e.failures) || e.failures < 0) return `breaker file tools[${t}].failures invalid (must be integer >= 0)`;
  if (e.openedAt != null && (typeof e.openedAt !== 'number' || !Number.isFinite(e.openedAt) || e.openedAt < 0)) return `breaker file tools[${t}].openedAt invalid (must be number >= 0 or null)`;
  return null;
}
export function loadBreaker(namespace, { threshold = 3, cooldownMs = 60_000 } = {}) {
  const file = breakerFilePath(namespace);

  const fileExists = existsSync(file);
  const data = readJsonSafe(file);
  if (!fileExists) return { ok: true, threshold, cooldownMs, tools: Object.create(null) };
  if (data == null) return _fail(threshold, cooldownMs, `breaker file corrupt at ${file}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return _fail(threshold, cooldownMs, 'breaker file is not a JSON object');
  if (data.ok !== true) return _fail(threshold, cooldownMs, 'breaker file missing ok=true flag');
  const t = data.threshold, cd = data.cooldownMs;
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 1) return _fail(threshold, cooldownMs, 'breaker file threshold invalid (must be integer >= 1)');
  if (typeof cd !== 'number' || !Number.isInteger(cd) || cd < 0) return _fail(t, cooldownMs, 'breaker file cooldownMs invalid (must be integer >= 0)');
  if (!data.tools || typeof data.tools !== 'object' || Array.isArray(data.tools)) return _fail(t, cd, 'breaker file tools must be plain object');
  for (const [k, e] of Object.entries(data.tools)) {
    const r = _validateEntry(k, e);
    if (r) return _fail(t, cd, r);
  }
  return data;
}
export function saveBreaker(namespace, registry) {
  atomicWriteJson(breakerFilePath(namespace), registry);
}
export function claimHalfOpenProbe(namespace, tool, cooldownMs = 60_000, now = Date.now()) {
  return withFileLock(namespace, (ns) => {
    const reg = loadBreaker(ns, { cooldownMs });
    if (!reg.ok) return { ok: false, claimed: false, registry: reg, reason: reg.reason || 'broken breaker state' };
    const entry = (reg.tools || {})[tool];
    if (!entry) return { ok: true, claimed: false, registry: reg, reason: 'tool not found in breaker' };
    if (entry.state !== 'OPEN') return { ok: true, claimed: false, registry: reg, reason: `tool state is ${entry.state}, not OPEN` };
    const elapsed = now - (entry.openedAt || 0);
    if (elapsed < cooldownMs) {
      return { ok: true, claimed: false, registry: reg, reason: `cooldown ${Math.max(0, cooldownMs - elapsed)}ms remaining` };
    }
    const newEntry = { ...entry, state: 'HALF_OPEN', lastReason: 'probe_claimed' };
    const newReg = { ...reg, tools: { ...reg.tools, [tool]: newEntry } };
    saveBreaker(ns, newReg);
    return { ok: true, claimed: true, registry: newReg, reason: null };
  }, 5000);
}
export function createPersistFunctions(recordFailurePure, recordSuccessPure) {
  function recordFailurePersist(namespace, tool, reason = 'unspecified', now = Date.now()) {
    return withFileLock(namespace, (ns) => {
      const reg = loadBreaker(ns);
      if (!reg.ok) return { ok: false, registry: null, opened: false, error: 'broken breaker state' };
      const out = recordFailurePure(reg, tool, reason, now);
      if (!out.ok) return { ok: false, registry: null, opened: false, error: out.reason || 'recordFailure failed' };
      saveBreaker(ns, out.registry);
      return { ok: true, registry: out.registry, opened: out.opened };
    });
  }

  function recordSuccessPersist(namespace, tool) {
    return withFileLock(namespace, (ns) => {
      const reg = loadBreaker(ns);
      if (!reg.ok) return { ok: false, registry: null, recovered: false, error: 'broken breaker state' };
      const out = recordSuccessPure(reg, tool);
      if (!out.ok) return { ok: false, registry: null, recovered: false, error: out.reason || 'recordSuccess failed' };
      saveBreaker(ns, out.registry);
      return { ok: true, registry: out.registry, recovered: out.recovered };
    });
  }

  return { recordFailurePersist, recordSuccessPersist, claimHalfOpenProbe };
}
