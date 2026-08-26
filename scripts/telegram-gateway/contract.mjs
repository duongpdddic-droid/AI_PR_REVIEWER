#!/usr/bin/env node
// contract.mjs — Shared contract cho Telegram Gateway (Issue #15).
// Single source of truth: mọi notify (outbound) và command (inbound) đi qua queue này.
// Runtime files (queue/lock/heartbeat/config) nằm NGOÀI repo tại ~/.ai-pr-reviewer/gateway/ (KHÔNG commit).
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
export const LOCK_FILE = path.join(RUNTIME_DIR, 'gateway.lock');
export const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'heartbeat.json');
export const READY_FILE = path.join(RUNTIME_DIR, 'ready');
export const CONFIG_FILE = path.join(RUNTIME_DIR, 'config.json');

// Ngưỡng: heartbeat cũ hơn STALE_MS -> instance bị coi là chết (cho phép takeover).
export const STALE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
export const POLL_TIMEOUT_S = 30;

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function appInboundDir(appNs) { return path.join(INBOUND_DIR, String(appNs || APP_NS)); }

let _seq = 0;
function nextId() {
  _seq += 1;
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${_seq}`;
}

// Enqueue một item (outbound notify hoặc inbound command) vào queue, atomic write (tmp -> rename).
export function enqueue(appNs, kind, payload) {
  const id = nextId();
  const item = { id, appNs: appNs || APP_NS, kind, payload, enqueuedAt: Date.now() };
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

export function listApps() {
  if (!fs.existsSync(INBOUND_DIR)) return [];
  return fs.readdirSync(INBOUND_DIR).filter((d) => {
    try { return fs.statSync(path.join(INBOUND_DIR, d)).isDirectory(); } catch { return false; }
  });
}

// ---- Lock / heartbeat (single instance, chống 409 conflict) ----
export function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}

export function writeLock(instanceId, pid) {
  ensureDir(RUNTIME_DIR);
  const lock = { instanceId, pid, startedAt: Date.now(), lastHeartbeat: Date.now() };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2));
  return lock;
}

export function touchHeartbeat(lock) {
  if (!lock) lock = readLock();
  if (!lock) return null;
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

export function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}
