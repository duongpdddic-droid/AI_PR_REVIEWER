// breaker-persist.mjs — persist circuit breaker state across CLI invocations (Issue #25).
// Runtime root ngoài repo, atomic write + file lock. YAGNI: JSON + rename + exclusive lock.

import { readFileSync, writeFileSync, writeSync, mkdirSync, existsSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
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


// ---------- file lock (exclusive via 'wx' + owner identity) ----------

// Lock file = JSON owner {pid, nonce, createdAt}. release chỉ xóa khi identity còn
// khớp. PID check 3-state: 'alive'|'dead'|'unknown' — chỉ 'dead' mới recover.
// Test seam _setFsOverride cho phép inject mock fs (cover race + write-fail).
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
// Atomic recovery-claim: rename lock → lock.recover-<ts> (atomic trên cùng FS, không
// TOCTOU). Identity lệch → restore + fail-closed; rename fail → fail-closed.
function _tryRecoverStaleLock(lockPath) {
  const owner = _readLockOwner(lockPath);
  if (!owner || _pidAlive(owner.pid) !== 'dead') return false;
  const quarantine = `${lockPath}.recover-${Date.now()}`;
  try { _fs('renameSync')(lockPath, quarantine); } catch { return false; }
  const moved = _readLockOwner(quarantine);
  if (!moved || moved.pid !== owner.pid || moved.nonce !== owner.nonce) {
    try { _fs('renameSync')(quarantine, lockPath); } catch { /* caller sẽ thấy EEXIST */ }
    return false;
  }
  return true;
}

// acquireLock(path, timeoutMs=5000) -> {ok, fd, owner, error}
// openSync('wx') tạo lock exclusive; ghi owner QUA FD (writeSync), kiểm tra bytes.
// Ghi fail (throw hoặc short write) → closeSync+unlinkSync đúng lock của mình, retry.
export function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  const myNonce = randomUUID();
  const fs = _fs;
  const cleanup = (fd) => { try { fs('closeSync')(fd); } catch { /* ignore */ } try { fs('unlinkSync')(lockPath); } catch { /* wx owner */ } };
  while (Date.now() < deadline) {
    try {
      const fd = fs('openSync')(lockPath, 'wx');
      const buf = Buffer.from(JSON.stringify({ pid: process.pid, nonce: myNonce, createdAt: Date.now() }), 'utf8');
      let written = 0;
      try { written = fs('writeSync')(fd, buf, 0, buf.length, 0); }
      catch (writeErr) { cleanup(fd); lastErr = writeErr; continue; }
      if (written !== buf.length) { cleanup(fd); lastErr = new Error(`short write: ${written}/${buf.length}`); continue; }
      return { ok: true, fd, owner: { pid: process.pid, nonce: myNonce, createdAt: Date.now() }, error: null };
    } catch (err) {
      lastErr = err;
      if (err.code === 'EEXIST' || err.code === 'EEXIT') {
        if (_tryRecoverStaleLock(lockPath)) continue;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      return { ok: false, fd: null, owner: null, error: `lock acquire error: ${err.message}` };
    }
  }
  return { ok: false, fd: null, owner: null, error: `lock timeout after ${timeoutMs}ms: ${lastErr ? lastErr.message : 'unknown'}` };
}

// releaseLock: chỉ xóa lock khi expectedOwner được truyền VÀ identity còn khớp.
// Thiếu owner / mismatch → KHÔNG unlink (fail-closed).
export function releaseLock(fd, lockPath, expectedOwner) {
  try { closeSync(fd); } catch { /* ignore */ }
  if (!expectedOwner || typeof expectedOwner !== 'object'
      || !Number.isInteger(expectedOwner.pid) || typeof expectedOwner.nonce !== 'string') {
    return false;
  }
  const current = _readLockOwner(lockPath);
  if (current && current.pid === expectedOwner.pid && current.nonce === expectedOwner.nonce) {
    try { unlinkSync(lockPath); return true; } catch { return false; }
  }
  return false;
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

// claimHalfOpenProbe(namespace, tool, cooldownMs, now) -> {ok, claimed, registry, reason}
// Atomic: lock → load → check OPEN + cooldown → set HALF_OPEN → save → unlock.
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
