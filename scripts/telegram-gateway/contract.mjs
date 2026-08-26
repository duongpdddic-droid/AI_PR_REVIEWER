#!/usr/bin/env node
// contract.mjs — Shared contract cho Telegram Gateway (Issue #15).
// Single source of truth: mọi notify (outbound) và command (inbound) đi qua queue này.
// Runtime files (queue/lock/heartbeat/config/health) nằm NGOÀI repo tại ~/.ai-pr-reviewer/gateway/ (KHÔNG commit).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EVENT_LABELS, buildMessage, eventKey, NotificationStore, withRetry, escapeHtml } from '../tg-notify-core.mjs';

export { EVENT_LABELS, buildMessage, eventKey, NotificationStore, withRetry, escapeHtml };

export const APP_NS = 'ai-pr-reviewer';
export const EVENT_TYPES = [
  'start', 'needs-input', 'blocked', 'done', 'test-fail', 'resume',
  'approved', 'merged', 'timeout-level1', 'timeout-level2',
];

export const RUNTIME_DIR = process.env.AI_PR_REVIEWER_GATEWAY_DIR
  || path.join(os.homedir(), '.ai-pr-reviewer', 'gateway');
export const QUEUE_DIR = path.join(RUNTIME_DIR, 'queue');
export const OUTBOUND_DIR = path.join(QUEUE_DIR, 'outbound');
export const INBOUND_DIR = path.join(QUEUE_DIR, 'inbound');
export const DEADLETTER_DIR = path.join(QUEUE_DIR, 'deadletter');
export const LOCK_FILE = path.join(RUNTIME_DIR, 'gateway.lock');
export const HEALTH_FILE = path.join(RUNTIME_DIR, 'health.json');
export const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'heartbeat.json');
export const READY_FILE = path.join(RUNTIME_DIR, 'ready');
export const CONFIG_FILE = path.join(RUNTIME_DIR, 'config.json');

export const STALE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
export const POLL_TIMEOUT_S = 30;

// --- App namespace validation (GPT-REV-077) ---
// appNs phải vừa đúng định dạng identifier an toàn, vừa nằm trong allowlist đăng ký.
// Cho phép cấu hình qua env GATEWAY_ALLOWED_APPS (comma-separated) để thêm app mới mà không đổi code.
export const ALLOWED_APPS = new Set(
  (process.env.GATEWAY_ALLOWED_APPS || `${APP_NS},qldadtxd`)
    .split(',').map((s) => s.trim()).filter(Boolean),
);
const APP_NS_RE = /^[a-z][a-z0-9-]{0,31}$/;
export function isValidAppNs(ns) {
  if (typeof ns !== 'string' || !ns) return false;
  if (!APP_NS_RE.test(ns)) return false;
  return ALLOWED_APPS.has(ns);
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// Đích inbound luôn là con của INBOUND_DIR (resolve + startsWith) — chặn path traversal.
function appInboundDir(appNs) {
  if (!isValidAppNs(appNs)) throw new Error('invalid appNs: ' + appNs);
  const root = path.resolve(INBOUND_DIR);
  const resolved = path.resolve(root, String(appNs));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('appInboundDir escapes runtime: ' + resolved);
  }
  return resolved;
}

let _seq = 0;
function nextId() {
  _seq += 1;
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${_seq}`;
}

// Enqueue một item. appNs phải hợp lệ (fail-closed: ném nếu không) — KHÔNG ghi file khi invalid.
export function enqueue(appNs, kind, payload) {
  if (!isValidAppNs(appNs)) throw new Error('enqueue rejected invalid appNs: ' + appNs);
  const id = nextId();
  const item = { id, appNs, kind, payload, enqueuedAt: Date.now() };
  const base = kind === 'inbound' ? appInboundDir(appNs) : OUTBOUND_DIR;
  ensureDir(base);
  const tmp = path.join(base, `${id}.tmp`);
  const final = path.join(base, `${id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(item, null, 2));
  fs.renameSync(tmp, final);
  return id;
}

export function readQueue(appNs, kind) {
  const base = kind === 'inbound' ? appInboundDir(appNs) : OUTBOUND_DIR;
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(base, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

export function dequeue(appNs, kind, id) {
  const base = kind === 'inbound' ? appInboundDir(appNs) : OUTBOUND_DIR;
  const p = path.join(base, `${id}.json`);
  if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} return true; }
  return false;
}

// Chuyển item invalid sang deadletter (tránh retry vô hạn trên envelope lỗi).
export function deadletter(appNs, kind, id, reason) {
  const base = kind === 'inbound' ? appInboundDir(appNs) : OUTBOUND_DIR;
  const p = path.join(base, `${id}.json`);
  if (!fs.existsSync(p)) return false;
  ensureDir(DEADLETTER_DIR);
  try {
    fs.renameSync(p, path.join(DEADLETTER_DIR, `${Date.now().toString(36)}-${reason}-${id}.json`));
    return true;
  } catch { return false; }
}

export function listApps() {
  if (!fs.existsSync(INBOUND_DIR)) return [];
  return fs.readdirSync(INBOUND_DIR).filter((d) => {
    try { return fs.statSync(path.join(INBOUND_DIR, d)).isDirectory(); } catch { return false; }
  });
}

// Idempotency key (GPT-REV-080): appNs/projectId + repo + ref + eventType + state + full HEAD SHA.
// Hai app/project khác nhau hoặc HEAD thay đổi -> khóa khác -> không suppress nhầm.
export function gatewayEventKey(p) {
  const f = (v) => String(v ?? '');
  return [f(p.appNs), f(p.projectId || p.repo), f(p.repo), f(p.ref), f(p.eventType), f(p.state), f(p.head)].join('::');
}

const HEAD_RE = /^[0-9a-f]{7,40}$/i;
// Validate envelope fail-closed trước enqueue/send (GPT-REV-080).
export function validateEnvelope(p) {
  const errs = [];
  if (!isValidAppNs(p && p.appNs)) errs.push('appNs');
  if (!(p && p.repo)) errs.push('repo');
  if (!(p && p.eventType)) errs.push('eventType');
  if (!(p && p.state)) errs.push('state');
  if (!(p && p.head) || !HEAD_RE.test(String(p.head))) errs.push('head');
  if (errs.length) throw new Error('invalid envelope fields: ' + errs.join(','));
  return true;
}

// ---- Lock (atomic single instance, chống 409) — GPT-REV-078 ----
export function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}

function lockContent(instanceId) {
  return { instanceId, pid: process.pid, startedAt: Date.now(), lastHeartbeat: Date.now() };
}

// Chiếm lock bằng primitive atomic: openSync 'wx' fail nếu file đã tồn tại -> chỉ 1 winner.
// Nếu đã có lock: alive -> duplicate (stand down); stale -> takeover qua rename (verify ownership).
export function tryAcquireLock(instanceId) {
  ensureDir(RUNTIME_DIR);
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    try { fs.writeFileSync(LOCK_FILE, JSON.stringify(lockContent(instanceId))); }
    finally { try { fs.closeSync(fd); } catch {} }
  } catch (e) {
    if (e.code === 'EEXIST') {
      const existing = readLock();
      if (isLockAlive(existing)) return { acquired: false, reason: 'duplicate', lock: existing };
      return takeoverLock(instanceId);
    }
    throw e;
  }
  return { acquired: true, lock: readLock() };
}

function takeoverLock(instanceId) {
  const tmp = `${LOCK_FILE}.takeover-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(lockContent(instanceId)));
  try { fs.renameSync(tmp, LOCK_FILE); }
  catch { try { fs.unlinkSync(tmp); } catch {} return { acquired: false, reason: 'lost-takeover', lock: readLock() }; }
  const now = readLock();
  if (now && now.instanceId === instanceId) return { acquired: true, lock: now };
  return { acquired: false, reason: 'lost-takeover', lock: now };
}

// Owner-only heartbeat: chỉ instance sở hữu lock mới được cập nhật.
export function touchHeartbeat(lock, instanceId) {
  if (!lock) lock = readLock();
  if (!lock) return null;
  if (instanceId && lock.instanceId !== instanceId) return lock;
  const next = { ...lock, lastHeartbeat: Date.now() };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

export function isLockAlive(lock, now = Date.now(), staleMs = STALE_MS) {
  if (!lock || typeof lock.pid !== 'number') return false;
  if (!isPidAlive(lock.pid)) return false;
  return now - (lock.lastHeartbeat || 0) <= staleMs;
}

// Chỉ owner (instanceId khớp) mới release được; trả false nếu không phải owner.
// Không truyền instanceId (admin override, ví dụ --stop) -> force release.
export function releaseLock(instanceId) {
  const cur = readLock();
  if (cur && instanceId && cur.instanceId !== instanceId) return false;
  try { fs.unlinkSync(LOCK_FILE); return true; } catch { return false; }
}

// ---- Health / readiness (GPT-REV-079) ----
export function writeHealth(h) { ensureDir(RUNTIME_DIR); fs.writeFileSync(HEALTH_FILE, JSON.stringify(h, null, 2)); }
export function readHealth() { try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { return null; } }
export function isReady(opts = {}) {
  const h = readHealth();
  if (!h || h.status !== 'ready') return false;
  if (!fs.existsSync(READY_FILE)) return false;
  const stale = opts.staleMs ?? STALE_MS;
  return Date.now() - (h.lastHeartbeat || 0) <= stale;
}
