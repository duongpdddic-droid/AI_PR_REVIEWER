// breaker-persist.mjs — persist circuit breaker state (Issue #25). YAGNI: JSON + rename + exclusive lock.

import { readFileSync, writeFileSync, writeSync, mkdirSync, existsSync, renameSync, unlinkSync, openSync, closeSync, fstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

// ---------- runtime root ----------
// Env override cho test: BREAKER_RUNTIME_ROOT
export function resolveRuntimeRoot() {
  return process.env.BREAKER_RUNTIME_ROOT || join(homedir(), '.ai-pr-reviewer');
}
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------- atomic write ----------

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


// ---------- file lock ----------
// Lock file = JSON {pid, nonce, createdAt}. Test seam via _setFsOverride.
let _fsOverride = null;
export function _setFsOverride(o) { _fsOverride = o; }
const _fs = (name) => (_fsOverride && _fsOverride[name]) || { openSync, writeFileSync, writeSync, renameSync, unlinkSync, readFileSync, closeSync }[name];

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
// MVP: no automatic stale-lock deletion/recovery. Owner dead/unknown/corrupt → caller
// nhận ok=false reason RECOVERY_REQUIRED, lock giữ nguyên; chỉ operator xóa sau xác minh.
function _tryRecoverStaleLock(lockPath) {
  const owner = _readLockOwner(lockPath);
  if (!owner) return { recovered: false, reason: 'RECOVERY_REQUIRED: lock owner unreadable' };
  if (_pidAlive(owner.pid) === 'dead') return { recovered: false, reason: 'RECOVERY_REQUIRED: lock owner PID is dead' };
  return { recovered: false, reason: 'RECOVERY_REQUIRED: lock held by another owner' };
}

// acquireLock(path, timeoutMs=5000) -> {ok, fd, owner, error}
// openSync('wx') tạo lock exclusive; ghi owner QUA FD (writeSync). Ghi fail (throw/short
// write) → closeSync fd, KHÔNG unlink pathname (file rỗng → contender thấy EEXIST
// fail-closed). Lock giữ bởi PID khác (dead/alive/unknown) → fail-closed RECOVERY_REQUIRED.
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
      // Ownership intrinsic: lưu fileId (dev+ino) của file VỪA TẠO qua fd — release xác
      // nhận pathname vẫn trỏ tới file của mình, không bao giờ move/unlink path người khác.
      let fileId = null;
      try { const st = fstatSync(fd); if (st && st.ino > 0) fileId = { dev: st.dev, ino: st.ino }; } catch { /* fallback: verify bằng nonce */ }
      return { ok: true, fd, owner: { pid: process.pid, nonce: myNonce, createdAt: Date.now(), fileId }, error: null };
    } catch (err) {
      lastErr = err;
      if (err.code === 'EEXIST' || err.code === 'EEXIT') {
        // No auto-recovery: chỉ inspect owner, không rename/unlink.
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

// releaseLock: ownership protocol — KHÔNG move/unlink pathname không do owner tạo.
//   Có fileId → stat(lockPath) phải trỏ CÙNG inode mới unlink (khác → lock đã bị thay,
//   fail-closed). Không fileId (test seam) → verify nonce+pid nội dung. Unlink fail →
//   {ok:false, RECOVERY_REQUIRED} (KHÔNG biến cleanup failure thành success).
// [test-seam] dùng _fs lookup để honor _setFsOverride (closeSync/unlinkSync).
export function releaseLock(fd, lockPath, expectedOwner) {
  try { _fs('closeSync')(fd); } catch { /* ignore */ }
  if (!expectedOwner || typeof expectedOwner !== 'object'
      || !Number.isInteger(expectedOwner.pid) || typeof expectedOwner.nonce !== 'string') {
    return { ok: false, reason: 'RECOVERY_REQUIRED: invalid owner metadata' };
  }
  if (expectedOwner.fileId && expectedOwner.fileId.ino > 0) {
    let st;
    try { st = statSync(lockPath); }
    catch { return { ok: false, reason: 'RECOVERY_REQUIRED: lock file missing' }; }
    if (st.ino !== expectedOwner.fileId.ino || st.dev !== expectedOwner.fileId.dev) {
      return { ok: false, reason: 'RECOVERY_REQUIRED: lock replaced by another owner' };
    }
  } else {
    const current = _readLockOwner(lockPath);
    if (!current || current.pid !== expectedOwner.pid || current.nonce !== expectedOwner.nonce) {
      return { ok: false, reason: 'RECOVERY_REQUIRED: lock not owned by caller' };
    }
  }
  try { _fs('unlinkSync')(lockPath); return { ok: true, reason: null }; }
  catch (e) { return { ok: false, reason: `RECOVERY_REQUIRED: unlink failed: ${e.message}` }; }
}

// withFileLock(namespace, fn, timeoutMs) -> fn result (luôn unlock trong finally)
export function withFileLock(namespace, fn, timeoutMs = 5000) {
  const root = resolveRuntimeRoot();
  ensureDir(root);
  const lockPath = join(root, `breaker-${safeFilePart(namespace)}.lock`);
  const { ok, fd, owner, error } = acquireLock(lockPath, timeoutMs);
  if (!ok) return { ok: false, error };
  try {
    return fn(namespace);
  } finally {
    releaseLock(fd, lockPath, owner);
  }
}

// ---------- breaker persistence ----------

// Windows-safe + collision-safe: thay ký tự nguy hiểm, giới hạn độ dài (MAX_PATH 260),
// short hash chống collision khi 2 project khác nhau sanitize thành cùng chuỗi.
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


// ---------- HALF_OPEN probe (atomic claim) ----------
// claimHalfOpenProbe: lock → load → check OPEN + cooldown → set HALF_OPEN → save → unlock.
// Fail-closed: reg.ok=false (corrupt shape) → ok=false, KHÔNG ghi.
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

// ---------- convenience wrappers ----------
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
