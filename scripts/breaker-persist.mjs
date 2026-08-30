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


// ---------- file lock (exclusive via 'wx') ----------

// acquireLock(path, timeoutMs=5000) -> {ok, fd, error}
// Dùng fs.openSync flag 'wx' (tạo file exclusive; fail nếu đã tồn tại).
export function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      return { ok: true, fd, error: null };
    } catch (err) {
      lastErr = err;
      if (err.code === 'EEXIST' || err.code === 'EEXIT') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      return { ok: false, fd: null, error: `lock acquire error: ${err.message}` };
    }
  }
  return { ok: false, fd: null, error: `lock timeout after ${timeoutMs}ms: ${lastErr ? lastErr.message : 'unknown'}` };
}

export function releaseLock(fd, lockPath) {
  try { closeSync(fd); } catch { /* best effort */ }
  try { unlinkSync(lockPath); } catch { /* best effort */ }
}

// withFileLock(namespace, fn, timeoutMs) -> fn result (luôn unlock trong finally)
export function withFileLock(namespace, fn, timeoutMs = 5000) {
  const root = resolveRuntimeRoot();
  ensureDir(root);
  const lockPath = join(root, `breaker-${safeFilePart(namespace)}.lock`);
  const { ok, fd, error } = acquireLock(lockPath, timeoutMs);
  if (!ok) return { ok: false, error };
  try {
    return fn(namespace);
  } finally {
    releaseLock(fd, lockPath);
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
  // Sanitize ký tự nguy hiểm cho namespace string (dùng làm key trong code,
  // an toàn cho log). Hash chống collision được safeFilePart áp dụng khi ghi file.
  const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${safe(project)}::${safe(task)}`;
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
  if (typeof data.threshold !== 'number' || typeof data.cooldownMs !== 'number') {
    return { ok: false, threshold, cooldownMs, tools: null, reason: 'breaker file missing/invalid threshold/cooldownMs' };
  }
  // Validate tools entries (drop invalid silently vẫn an toàn, không reset registry).
  const tools = data.tools || {};
  for (const [t, e] of Object.entries(tools)) {
    if (!e || !['CLOSED', 'OPEN', 'HALF_OPEN'].includes(e.state)) delete tools[t];
  }
  return { ...data, tools, ok: true };
}

export function saveBreaker(namespace, registry) {
  atomicWriteJson(breakerFilePath(namespace), registry);
}


// ---------- HALF_OPEN probe (atomic claim) ----------

// claimHalfOpenProbe(namespace, tool, cooldownMs, now) -> {ok, claimed, registry, reason}
// Atomic: lock → load → check OPEN + cooldown elapsed → set HALF_OPEN → save → unlock.
export function claimHalfOpenProbe(namespace, tool, cooldownMs = 60_000, now = Date.now()) {
  return withFileLock(namespace, (ns) => {
    const reg = loadBreaker(ns, { cooldownMs });
    if (!reg.ok) return { ok: true, claimed: false, registry: reg, reason: 'broken breaker state' };
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
