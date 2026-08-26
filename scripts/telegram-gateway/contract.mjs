#!/usr/bin/env node
// contract.mjs — Shared contract cho Telegram Gateway (Issue #15).
// Single source of truth: mọi notify (outbound) và command (inbound) đi qua queue này.
// Runtime files (queue/lock/heartbeat/config/health) nằm NGOÀI repo tại ~/.ai-pr-reviewer/gateway/ (KHÔNG commit).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
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
export const LOCK_FILE = ''; // không còn dùng — OS-owned TCP lease (GPT-REV-078) thay thế file-lock.
export const HEALTH_FILE = path.join(RUNTIME_DIR, 'health.json');
export const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'heartbeat.json');
export const READY_FILE = path.join(RUNTIME_DIR, 'ready');
export const CONFIG_FILE = path.join(RUNTIME_DIR, 'config.json');
// GPT-REV-078 (Critical): single-instance qua OS-owned TCP lease — bind 1 port localhost độc quyền.
// OS đảm bảo chỉ 1 process bind được 1 (host,port) cùng lúc => không cần file-lock atomic, không cần
// stale-takeover scan (OS tự thả port khi owner chết), heartbeat không overwrite-file (owner = người giữ port).
export const LEASE_HOST = process.env.GATEWAY_LEASE_HOST || '127.0.0.1';
export const LEASE_PORT = Number(process.env.GATEWAY_LEASE_PORT || 47321);

export const STALE_MS = Number(process.env.GATEWAY_STALE_MS || 60_000);
export const HEARTBEAT_MS = Number(process.env.GATEWAY_HEARTBEAT_MS || 15_000);
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
  if (kind !== 'inbound' && kind !== 'outbound') throw new Error('enqueue kind không hợp lệ: ' + kind);
  // GPT-REV-080: outbound envelope phải validate TRƯỚC khi ghi file (fail-closed: sai -> throw, không ghi, không phát đi).
  if (kind === 'outbound') validateEnvelope(payload);
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

// GPT-REV-082: đọc TOÀN BỘ outbound bất kể appNs (shared OUTBOUND_DIR) để 1 notifier duy nhất
// xử lý mọi appNs đăng ký. Trả items sắp xếp theo enqueuedAt.
export function readOutboundAll() {
  if (!fs.existsSync(OUTBOUND_DIR)) return [];
  return fs.readdirSync(OUTBOUND_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(OUTBOUND_DIR, f), 'utf8')); } catch { return null; }
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
  return [f(p.appNs), f(p.repo), f(p.ref), f(p.eventType), f(p.state), f(p.head)].join('::');
}

export const HEAD_RE = /^[0-9a-f]{40}$/i;
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

// ---- Single-instance qua OS-owned TCP lease (GPT-REV-078 Critical) ----
// File-lock trước đây (openSync 'wx' + stale takeover + heartbeat overwrite + release unlink) bị
// check-then-mutate race: contender cũ/owner cũ có thể xóa/ghi đè trạng thái của owner mới. Thay bằng
// OS-owned primitive: bind 1 TCP port localhost độc quyền. OS đảm bảo chỉ 1 process giữ (host,port),
// và tự thả port khi owner chết/crash => không cần stale-scan, không cần unlink, không heartbeat-overwrite.
// Owner là người đang giữ port; người khác không đụng được owner vì port do kernel quản lý, không phải file.

let leaseServer = null; // net.Server đang giữ (nếu process này là owner)
let leaseOwner = null;  // { instanceId, pid } của owner (chỉ owner nhớ đúng state của mình)

function toLeaseInfo(instanceId) {
  return { instanceId, pid: process.pid, hostname: os.hostname(), startedAt: Date.now() };
}

function isLeaseHeld() { return leaseServer !== null && !leaseServer.closed; }

// Bind port độc quyền (OS-owned). Chỉ 1 process thành công; EADDRINUSE = đã có owner -> duplicate.
// Trong process này, nếu đang là owner thì trả lease hiện tại (giữ nguyên), không bind lại.
export function tryAcquireLease(instanceId) {
  return new Promise((resolve) => {
    if (isLeaseHeld()) return resolve({ acquired: false, reason: 'duplicate', lease: leaseOwner });
    const srv = net.createServer();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    srv.once('error', (err) => {
      if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        done({ acquired: false, reason: 'duplicate', lease: leaseOwner });
      } else {
        done({ acquired: false, reason: 'error', lease: null });
      }
    });
    srv.listen(LEASE_PORT, LEASE_HOST, () => {
      leaseServer = srv;
      leaseOwner = toLeaseInfo(instanceId);
      // Handshake: publich identity cho bên probe (supervisor/status) — chỉ đọc, không cho quyền.
      srv.on('connection', (sock) => {
        sock.setTimeout(1000);
        sock.on('timeout', () => { try { sock.destroy(); } catch {} });
        sock.on('error', () => {});
        try { sock.end(JSON.stringify({ instanceId: leaseOwner.instanceId, pid: leaseOwner.pid })); } catch {}
      });
      done({ acquired: true, lease: leaseOwner });
    });
  });
}

// Probe owner từ process khác hoặc chính mình. Chỉ xác nhận "alive" khi ĐỌC được identity handshake.
// Connect thành công tới socket đang đóng (lease vừa release) sẽ `end` ngay KHÔNG có data -> coi là not-alive,
// tránh giả owner. ECONNREFUSED / timeout -> not-alive. KHÔNG bind, KHÔNG steal.
export function probeLease(timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (isLeaseHeld()) return resolve({ alive: true, lease: leaseOwner });
    const sock = net.connect(LEASE_PORT, LEASE_HOST);
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); try { sock.destroy(); } catch {} resolve(r); } };
    const t = setTimeout(() => finish({ alive: false, lease: null }), timeoutMs);
    sock.on('data', (d) => { try { const o = JSON.parse(d.toString()); finish({ alive: true, lease: o }); } catch {} });
    sock.on('end', () => finish({ alive: false, lease: null })); // connect tới socket đã đóng -> không phải owner
    sock.on('error', () => finish({ alive: false, lease: null }));
  });
}

// OS-owned acquire wrapper (giữ API đối xứng với hệ thống cũ cho gateway/bridge).
export async function tryAcquireLock(instanceId) {
  const r = await tryAcquireLease(instanceId);
  if (r.acquired) return { acquired: true, lock: leaseOwner };
  return { acquired: false, reason: r.reason, lock: r.lease };
}

// Trạng thái lease hiện tại: nếu là owner -> info của mình; nếu không -> probe port để biết ai giữ.
export function readLock() { return isLeaseHeld() ? leaseOwner : null; }

// Thả lease (owner-only). Không có file để unlink — chỉ đóng server để kernel thả port.
export function releaseLock(instanceId) {
  if (!isLeaseHeld()) return false;
  if (instanceId && leaseOwner && leaseOwner.instanceId !== instanceId) return false;
  const srv = leaseServer;
  leaseServer = null; leaseOwner = null;
  try { if (!srv.closed) srv.close(); } catch {}
  return true;
}

// Heartbeat cũ (ghi file) KHÔNG còn — owner được OS giữ bằng port nên không cần heartbeat để chứng minh sống.
export function touchHeartbeat(instanceId) {
  return isLeaseHeld() ? leaseOwner : null;
}

// Lease còn sống <=> port đang được giữ (owner). Dùng probe cho view từ process khác.
export async function isLockAlive() { return (await probeLease()).alive; }

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}


// ---- Health / readiness (GPT-REV-079) ----
export function writeHealth(h) { ensureDir(RUNTIME_DIR); fs.writeFileSync(HEALTH_FILE, JSON.stringify(h, null, 2)); }
export function readHealth() { try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { return null; } }
// GPT-REV-078: readiness phải đúng SỐNG người giữ lease (probe port) + health + ready + poll gần nhất.
// KHÔNG còn đọc file-lock overwrite — owner được xác định bằng OS port đang được giữ và handshake identity.
export async function isReady(opts = {}) {
  const h = readHealth();
  if (!h || h.status !== 'ready') return false;
  if (!h.instanceId) return false;
  // Lease phải được giữ REAL bởi cùng instance (probe từ process này/khác đều đúng).
  const probe = await probeLease(opts.probeTimeoutMs);
  if (!probe.alive || !probe.lease) return false; // không ai giữ lease -> không ready (owner đã chết/crash)
  if (probe.lease.instanceId !== h.instanceId) return false; // ready của instance cũ sau crash -> không nhận
  if (!fs.existsSync(READY_FILE)) return false;
  try {
    const rdy = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
    if (rdy.instanceId !== h.instanceId) return false; // record ready phải của cùng instance
  } catch { return false; }
  const stale = opts.staleMs ?? STALE_MS;
  if (Date.now() - (h.lastSuccessfulPoll || 0) > stale) return false; // poll gần nhất phải ok
  return true;
}

// GPT-REV-079: publish ready chỉ khi health.ready + cùng instanceId (chống stale/mismatched).
export function writeReadyFlag(instanceId) {
  fs.writeFileSync(READY_FILE, JSON.stringify({ instanceId, at: Date.now() }, null, 2));
}
