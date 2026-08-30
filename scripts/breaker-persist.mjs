// breaker-persist.mjs — persist circuit breaker state across CLI invocations (Issue #25 Finding 1)
// Runtime root ngoài repo (~/.ai-pr-reviewer/), atomic write, file lock, project/task namespace.
// YAGNI: không dùng DB/cache — chỉ JSON file + atomic rename + exclusive file lock.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
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

// Lock file chứa JSON owner: {pid, nonce, createdAt}. release chỉ xóa khi
// identity còn khớp. Recovery (stale lock) chỉ khi xác minh được PID đã chết.
// PID sống hoặc không xác minh được → fail-closed (acquire trả timeout).
function _pidAlive(pid) {
  // Cross-platform best-effort: signal 0 chỉ check process tồn tại.
  // Windows: process.kill(pid, 0) throw ESRCH nếu không có, EPERM nếu sống.
  try { process.kill(pid, 0); return true; }
  catch (err) {
    if (err.code === 'EPERM') return true; // sống, không có quyền
    return false; // ESRCH hoặc lỗi khác → coi như đã chết
  }
}
function _readLockOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && Number.isInteger(data.pid) && typeof data.nonce === 'string') return data;
    return null;
  } catch { return null; }
}
function _tryRecoverStaleLock(lockPath) {
  const owner = _readLockOwner(lockPath);
  if (!owner) return false; // corrupt owner record → KHÔNG tự ý xóa (fail-closed)
  if (!_pidAlive(owner.pid)) {
    try { unlinkSync(lockPath); return true; } catch { return false; }
  }
  return false; // PID sống → giữ nguyên, caller phải timeout
}

// acquireLock(path, timeoutMs=5000) -> {ok, fd, owner, error}
// Dùng fs.openSync flag 'wx' (tạo file exclusive; fail nếu đã tồn tại). Ghi
// owner record {pid, nonce, createdAt} ngay sau khi tạo để release/recovery
// xác minh identity.
export function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  const myNonce = randomUUID();
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      const owner = { pid: process.pid, nonce: myNonce, createdAt: Date.now() };
      try { writeFileSync(lockPath, JSON.stringify(owner), 'utf8'); } catch { /* best effort */ }
      return { ok: true, fd, owner, error: null };
    } catch (err) {
      lastErr = err;
      if (err.code === 'EEXIST' || err.code === 'EEXIT') {
        // Thử recovery nếu owner PID đã chết.
        if (_tryRecoverStaleLock(lockPath)) continue;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      return { ok: false, fd: null, owner: null, error: `lock acquire error: ${err.message}` };
    }
  }
  return { ok: false, fd: null, owner: null, error: `lock timeout after ${timeoutMs}ms: ${lastErr ? lastErr.message : 'unknown'}` };
}

// releaseLock: chỉ xóa lock file khi owner identity còn khớp với record trong
// file. Nếu identity lệch (process khác đã chiếm lock, hoặc lock bị stale
// overwrite) → KHÔNG xóa, để tránh xóa nhầm lock của process khác.
export function releaseLock(fd, lockPath, expectedOwner) {
  let released = true;
  try { closeSync(fd); } catch { released = false; }
  if (expectedOwner && typeof expectedOwner === 'object') {
    const current = _readLockOwner(lockPath);
    if (current && current.pid === expectedOwner.pid && current.nonce === expectedOwner.nonce) {
      try { unlinkSync(lockPath); } catch { /* best effort */ }
    } else {
      released = false; // identity mismatch → KHÔNG xóa
    }
  } else {
    // Không truyền owner: giữ backward-compat (best-effort unlink).
    try { unlinkSync(lockPath); } catch { /* best effort */ }
  }
  return released;
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

// Windows-safe + collision-safe: thay thế ký tự nguy hiểm, giới hạn độ dài
// (Windows MAX_PATH 260), thêm short hash (8 hex) chống collision khi 2 project
// khác nhau sanitize thành cùng chuỗi (vd: "a/b" và "a_b" đều → "a_b").
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
  // Sanitize ký tự nguy hiểm cho namespace string (an toàn cho log/path) + 6-hex
  // hash từ raw input (projectId+taskId) chống collision: "a/b" vs "a_b" sanitize
  // thành cùng chuỗi nhưng raw hash khác nhau. Hash nằm ở namespace string (key)
  // chứ không chỉ ở filename — đảm bảo in-memory map giữa 2 caller không lẫn.
  const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const raw = `${String(project || '')}\u0000${String(task || '')}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 6);
  return `${safe(project)}::${safe(task)}::${hash}`;
}

// Load breaker state từ file.
// Fail-closed (Finding 2): nếu file corrupt hoặc sai shape, KHÔNG reset registry
// thành default fresh — trả về object với ok=false, kèm reason để caller biết cần
// khôi phục. Caller (recordFailurePersist/recordSuccessPersist/claimHalfOpenProbe)
// phải kiểm ok trước khi ghi (sẽ trả fail thay vì ghi đè).
//   - File chưa có: trả fresh registry (ok=true).
//   - File hợp lệ: trả {ok:true, threshold, cooldownMs, tools, ...}.
//   - File corrupt / sai shape: trả {ok:false, threshold, cooldownMs, tools:null, reason}.
export function loadBreaker(namespace, { threshold = 3, cooldownMs = 60_000 } = {}) {
  const file = breakerFilePath(namespace);
  // Phân biệt "file chưa có" (fresh registry OK) vs "file corrupt" (fail-closed):
  // existsSync = false → fresh; existsSync = true nhưng parse fail → fail-closed.
  const fileExists = existsSync(file);
  const data = readJsonSafe(file);
  if (!fileExists || data == null) {
    if (fileExists && data == null) {
      // File tồn tại nhưng JSON.parse fail → corrupt.
      return { ok: false, threshold, cooldownMs, tools: null, reason: `breaker file corrupt at ${file}` };
    }
    return { ok: true, threshold, cooldownMs, tools: Object.create(null) };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, threshold, cooldownMs, tools: null, reason: 'breaker file is not a JSON object' };
  }
  if (data.ok !== true) {
    return { ok: false, threshold, cooldownMs, tools: null, reason: 'breaker file missing ok=true flag' };
  }
  // Shape validation fail-closed (Finding 2): một trường sai → toàn bộ file
  // fail-closed, KHÔNG drop entry / sửa / reset về default fresh. Caller phải
  // kiểm ok trước khi ghi (đã enforce ở recordFailurePersist/recordSuccessPersist/
  // claimHalfOpenProbe).
  if (typeof data.threshold !== 'number' || !Number.isInteger(data.threshold) || data.threshold < 1) {
    return { ok: false, threshold, cooldownMs, tools: null, reason: 'breaker file threshold invalid (must be integer >= 1)' };
  }
  if (typeof data.cooldownMs !== 'number' || !Number.isInteger(data.cooldownMs) || data.cooldownMs < 0) {
    return { ok: false, threshold: data.threshold, cooldownMs, tools: null, reason: 'breaker file cooldownMs invalid (must be integer >= 0)' };
  }
  if (!data.tools || typeof data.tools !== 'object' || Array.isArray(data.tools)) {
    return { ok: false, threshold: data.threshold, cooldownMs: data.cooldownMs, tools: null, reason: 'breaker file tools must be plain object' };
  }
  const VALID_STATES = new Set(['CLOSED', 'OPEN', 'HALF_OPEN']);
  for (const [t, e] of Object.entries(data.tools)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, threshold: data.threshold, cooldownMs: data.cooldownMs, tools: null, reason: `breaker file tools[${t}] not a plain object` };
    }
    if (!VALID_STATES.has(e.state)) {
      return { ok: false, threshold: data.threshold, cooldownMs: data.cooldownMs, tools: null, reason: `breaker file tools[${t}].state invalid: ${e.state}` };
    }
    if (typeof e.failures !== 'number' || !Number.isInteger(e.failures) || e.failures < 0) {
      return { ok: false, threshold: data.threshold, cooldownMs: data.cooldownMs, tools: null, reason: `breaker file tools[${t}].failures invalid (must be integer >= 0)` };
    }
    if (e.openedAt != null && (typeof e.openedAt !== 'number' || !Number.isFinite(e.openedAt) || e.openedAt < 0)) {
      return { ok: false, threshold: data.threshold, cooldownMs: data.cooldownMs, tools: null, reason: `breaker file tools[${t}].openedAt invalid (must be number >= 0 or null)` };
    }
  }
  return data;
}

export function saveBreaker(namespace, registry) {
  atomicWriteJson(breakerFilePath(namespace), registry);
}


// ---------- HALF_OPEN probe (atomic claim) ----------

// claimHalfOpenProbe(namespace, tool, cooldownMs, now) -> {ok, claimed, registry, reason}
// Atomic: lock → load → check OPEN + cooldown elapsed → set HALF_OPEN → save → unlock.
// Fail-closed (Finding 2): reg.ok=false (corrupt shape) → ok=false, KHÔNG ghi.
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

// ---------- convenience wrappers (inject pure functions từ circuit-breaker.mjs) ----------

// createPersistFunctions(recordFailurePure, recordSuccessPure)
//   -> { recordFailurePersist, recordSuccessPersist, claimHalfOpenProbe }
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
