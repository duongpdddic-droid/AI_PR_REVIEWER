// breaker-persist.mjs — persist circuit breaker state across CLI invocations (Issue #25 Finding 1)
// Runtime root ngoài repo (~/.ai-pr-reviewer/), atomic write, file lock, project/task namespace.
// YAGNI: không dùng DB/cache — chỉ JSON file + atomic rename + exclusive file lock.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

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

// Windows-safe: namespace có '::' (không hợp lệ trong filename) -> gạch chân.
function safeFilePart(namespace) {
  return String(namespace || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function breakerFilePath(namespace) {
  return join(resolveRuntimeRoot(), `breaker-${safeFilePart(namespace)}.json`);
}

export function buildBreakerNamespace(project = 'default', task = 'default') {
  const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${safe(project)}::${safe(task)}`;
}

// Load breaker state từ file; nếu chưa có → tạo mới.
export function loadBreaker(namespace, { threshold = 3, cooldownMs = 60_000 } = {}) {
  const file = breakerFilePath(namespace);
  const data = readJsonSafe(file);
  if (data && data.ok && typeof data.threshold === 'number' && typeof data.cooldownMs === 'number') {
    const tools = data.tools || {};
    for (const [t, e] of Object.entries(tools)) {
      if (!e || !['CLOSED', 'OPEN', 'HALF_OPEN'].includes(e.state)) delete tools[t];
    }
    return { ...data, tools };
  }
  return { ok: true, threshold, cooldownMs, tools: Object.create(null) };
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
