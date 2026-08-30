// breaker-persist.mjs — persist circuit breaker state across CLI invocations (Issue #25 Finding 1).
// Runtime root ngoài repo (~/.ai-pr-reviewer/), atomic write + file lock. YAGNI: chỉ JSON + rename + exclusive lock.

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

// Lock file chứa JSON owner: {pid, nonce, createdAt}. release chỉ xóa khi identity
// còn khớp. Recovery (stale lock) chỉ khi xác minh được PID đã chết VÀ identity
// trên ổ đĩa vẫn khớp với record đã đọc ngay trước mutation (re-read race-aware).
// PID 'alive' hoặc 'unknown' → fail-closed.
function _pidAlive(pid) {
  // 3-state: ESRCH='dead' (chắc chắn chết), EPERM='alive' (sống, thiếu quyền),
  // mọi lỗi khác (EACCES, EINVAL, network fs) → 'unknown' (không xác minh được,
  // KHÔNG xóa). Chỉ 'dead' mới được phép recover.
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
    const raw = readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && Number.isInteger(data.pid) && typeof data.nonce === 'string') return data;
    return null;
  } catch { return null; }
}
// Race-aware recovery: đọc owner → check PID → re-read ngay trước mutation.
// Identity thay đổi → fail-closed (writer khác vừa ghi đè, không được xóa).
// Quarantine file cũ sang `.recover-<ts>` trước unlink (forensics).
function _tryRecoverStaleLock(lockPath) {
  const owner = _readLockOwner(lockPath);
  if (!owner) return false; // corrupt owner record → KHÔNG tự ý xóa (fail-closed)
  const state = _pidAlive(owner.pid);
  if (state !== 'dead') return false; // 'alive'|'unknown' → giữ nguyên
  // Re-read ngay trước mutation để chặn race: writer khác vừa ghi đè lock.
  const reread = _readLockOwner(lockPath);
  if (!reread || reread.pid !== owner.pid || reread.nonce !== owner.nonce) return false;
  try {
    renameSync(lockPath, `${lockPath}.recover-${Date.now()}`);
    return true;
  } catch { return false; }
}

// acquireLock(path, timeoutMs=5000) -> {ok, fd, owner, error}
// Dùng fs.openSync flag 'wx' (tạo file exclusive; fail nếu đã tồn tại). Ghi owner
// record {pid, nonce, createdAt} NGAY SAU khi tạo — ghi thành công mới return ok=true.
// Ghi lỗi → đóng fd + unlink lock vừa tạo (đúng lock của mình, an toàn vì 'wx').
export function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  const myNonce = randomUUID();
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      const owner = { pid: process.pid, nonce: myNonce, createdAt: Date.now() };
      try {
        writeFileSync(lockPath, JSON.stringify(owner), 'utf8');
      } catch (writeErr) {
        // Ghi owner fail → dọn đúng lock vừa tạo, KHÔNG trả ok=true.
        try { closeSync(fd); } catch { /* fd close vẫn tiếp tục */ }
        try { unlinkSync(lockPath); } catch { /* lock vừa mở bằng wx, mình là owner */ }
        lastErr = writeErr;
        continue; // retry cho đến khi hết timeout
      }
      return { ok: true, fd, owner, error: null };
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
// Thiếu owner / mismatch → KHÔNG unlink (fail-closed). Trả boolean.
export function releaseLock(fd, lockPath, expectedOwner) {
  try { closeSync(fd); } catch { /* fd close vẫn tiếp tục */ }
  if (!expectedOwner || typeof expectedOwner !== 'object'
      || !Number.isInteger(expectedOwner.pid) || typeof expectedOwner.nonce !== 'string') {
    return false; // thiếu/sai shape owner → fail-closed, KHÔNG unlink
  }
  const current = _readLockOwner(lockPath);
  if (current && current.pid === expectedOwner.pid && current.nonce === expectedOwner.nonce) {
    try { unlinkSync(lockPath); return true; } catch { return false; }
  }
  return false; // identity mismatch / file đã mất / record lệch → KHÔNG unlink
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
  // Sanitize ký tự nguy hiểm + 6-hex hash từ raw input chống collision: "a/b" vs "a_b"
  // sanitize thành cùng chuỗi nhưng raw hash khác nhau (key namespace, không chỉ filename).
  const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const raw = `${String(project || '')}\u0000${String(task || '')}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 6);
  return `${safe(project)}::${safe(task)}::${hash}`;
}

// Load breaker state. Fail-closed (Finding 2): file corrupt / sai shape → ok=false.
// Caller check ok trước khi ghi. File chưa có → fresh (ok=true).
const VALID_STATES = new Set(['CLOSED', 'OPEN', 'HALF_OPEN']);
function _fail(threshold, cooldownMs, reason) {
  return { ok: false, threshold, cooldownMs, tools: null, reason };
}
// Validate 1 entry tools[t] — trả reason nếu sai, null nếu hợp lệ.
function _validateEntry(t, e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return `breaker file tools[${t}] not a plain object`;
  if (!VALID_STATES.has(e.state)) return `breaker file tools[${t}].state invalid: ${e.state}`;
  if (typeof e.failures !== 'number' || !Number.isInteger(e.failures) || e.failures < 0) return `breaker file tools[${t}].failures invalid (must be integer >= 0)`;
  if (e.openedAt != null && (typeof e.openedAt !== 'number' || !Number.isFinite(e.openedAt) || e.openedAt < 0)) return `breaker file tools[${t}].openedAt invalid (must be number >= 0 or null)`;
  return null;
}
export function loadBreaker(namespace, { threshold = 3, cooldownMs = 60_000 } = {}) {
  const file = breakerFilePath(namespace);
  // Phân biệt "file chưa có" (fresh OK) vs "file corrupt" (fail-closed).
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

// createPersistFunctions(pureFailure, pureSuccess) -> { recordFailurePersist, recordSuccessPersist, claimHalfOpenProbe }
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
