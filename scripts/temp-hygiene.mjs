#!/usr/bin/env node
// temp-hygiene.mjs — TEMP HYGIENE bắt buộc (policy .clinerules/08-temp-hygiene.md).
// Quản lý tài nguyên tạm (file/dir/process) của 1 phiên chạy:
//   - temp root riêng, bên ngoài repo; mỗi phiên 1 dir con theo sessionId.
//   - session manifest liệt kê chính xác file/dir/process phiên tạo.
//   - ownership marker (.session-owner-<sessionId>) gắn mỗi dir phiên tạo.
//   - cleanup chạy trong finally; idempotent; hoạt động PASS/FAIL/timeout.
//   - chỉ xóa target: trong temp root + sessionId đúng + có ownership marker
//     (không recursive-delete theo path rỗng/env chưa resolve/wildcard/repo/HOME).
//   - kill process theo PID do phiên tạo; không kill theo tên process chung.
//   - sau cleanup: read-back bắt buộc; không hoàn tất → verdict POC_CLEANUP_FAILED
//     + liệt kê absolute leftover (redact user path).
//   - recoverSession(sessionId): recovery riêng, idempotent, chỉ xóa resource có marker.
// Zero dependency.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const DEFAULT_TEMP_ROOT = () => path.join(os.tmpdir(), 'ai-pr-reviewer-temp-v1');
const MANIFEST_NAME = '.session-manifest.json';
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(SLEEP_BUF, 0, 0, ms);
const hex = (n) => randomBytes(n).toString('hex');

// --- validators / path safety ---
export const isSafeSessionId = (id) => typeof id === 'string' && /^[0-9a-f]{1,64}$/.test(id);

// target nằm TRONG root (resolve + so prefix), không phải chính root.
export const isInside = (rootDir, target) => {
  const r = path.resolve(rootDir);
  const t = path.resolve(target);
  return t !== r && t.startsWith(r + path.sep);
};

export const isAlive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  // POSIX: process bị kill thành zombie (state 'Z') vẫn đang trong bảng process,
  // nhưng đã dead. kill(pid,0) trên zombie vẫn thành công → false positive
  // khiến cleanup báo POC_CLEANUP_FAILED. Đọc /proc/<pid>/stat để loại zombie.
  if (process.platform !== 'win32') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // format: pid (comm) state ... — state là ký tự sau dấu ')' cuối cùng.
      const close = stat.lastIndexOf(')');
      const state = close >= 0 && close + 2 <= stat.length ? stat[close + 2] : '';
      if (state === 'Z') return false;
    } catch { /* không đọc được /proc → fall back xuống kill(pid,0) */ }
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
};

// canonical realpath (giải symlink/junction). null nếu không tồn tại.
export const realPathOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// target thực sự (sau giải symlink/junction) có nằm trong root không.
export const isCanonicalInside = (rootDir, target) => {
  const r = realPathOrNull(rootDir);
  const t = realPathOrNull(target);
  if (!r || !t) return false;
  return t !== r && t.startsWith(r + path.sep);
};

// kiểm symlink / junction (reparse point) — bị từ chối xóa theo policy.
const isSymlink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// workspace snapshot: các dòng `git status --porcelain` (null nếu không phải git repo).
export const snapshotWorkspace = (projectDir) => {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').split('\n').filter(Boolean).sort();
};

// diff workspace so với snapshot trước → path thay đổi.
export const workspaceChange = (projectDir, before) => {
  if (before == null) return [];
  const after = snapshotWorkspace(projectDir) || [];
  return after.filter((l) => !before.includes(l)).concat(before.filter((l) => !after.includes(l)));
};

// dừng process do phiên tạo theo PID (không kill theo tên process chung).
// Chống PID reuse: trước khi kill, xác minh owner identity của process (khác PID).
// Không đọc được cmdline / identity lệch → KHÔNG kill → trả vào `unverified` (fail-closed).
export const sp_procCommandLine = (pid) => {
  if (!Number.isInteger(pid)) return null;
  if (os.platform() === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  }
  const p = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  return p.status === 0 ? (p.stdout || '').trim() : null;
};

// Xác minh process có thuộc phiên này không (beyond PID): cmdline phải chứa identity.
// query fail / không đọc được → false (fail-closed, không kill).
export const verifyProcessIdentity = (rec, sessionId) => {
  if (!rec || !Number.isInteger(rec.pid)) return false;
  if (!isAlive(rec.pid)) return false;
  const cmd = sp_procCommandLine(rec.pid);
  if (!cmd) return false;
  const identity = rec.identity || sessionId;
  return Boolean(identity) && cmd.includes(String(identity));
};

// opts: number (timeoutMs cũ) | { timeoutMs, sessionId }
export const stopTrackedProcesses = (processes = [], opts = {}) => {
  const timeoutMs = typeof opts === 'number' ? opts : (opts.timeoutMs || 1500);
  const sessionId = typeof opts === 'object' ? (opts.sessionId || null) : null;
  const killed = [];
  const unverified = [];
  for (const rec of processes) {
    if (!rec || !isAlive(rec.pid)) continue;
    if (sessionId && !verifyProcessIdentity(rec, sessionId)) { unverified.push(rec.pid); continue; }
    try { process.kill(rec.pid, 'SIGTERM'); } catch { /* đã đi/chưa thể kill */ }
    const deadline = Date.now() + timeoutMs;
    while (isAlive(rec.pid) && Date.now() < deadline) sleep(20);
    if (isAlive(rec.pid)) { try { process.kill(rec.pid, 'SIGKILL'); } catch {} }
    killed.push(rec.pid);
  }
  return { killed, unverified };
};

// --- ownership marker ---
const markerPath = (dir, id) => path.join(dir, `.session-owner-${id}`);
export const ensureOwnershipMarker = (dir, id) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(markerPath(dir, id), JSON.stringify({ sessionId: id }));
};
export const hasOwnershipMarker = (dir, id) => {
  try {
    const raw = fs.readFileSync(markerPath(dir, id), 'utf8');
    return JSON.parse(raw).sessionId === id;
  } catch {
    return false;
  }
};

// redact user path (HOME/username) khỏi absolute target khi báo cáo leftover.
export const redactHome = (p) => String(p)
  .replace(os.homedir(), '~')
  .replace(new RegExp(os.userInfo().username, 'g'), '<USER>');
// --- session manager ---
export function createSessionManager({ sessionId, tempRoot = DEFAULT_TEMP_ROOT(), projectRoot = null, purpose = '' } = {}) {
  const id = sessionId || hex(16);
  if (!isSafeSessionId(id)) throw new Error(`temp-hygiene: sessionId không an toàn: "${id}"`);
  const root = path.resolve(tempRoot);
  if (projectRoot) {
    const pr = path.resolve(projectRoot);
    if (root === pr || root.startsWith(pr + path.sep)) throw new Error('temp root không được nằm trong repo/workspace thật');
  }
  fs.mkdirSync(root, { recursive: true });
  const homeDir = path.join(root, id);
  if (fs.existsSync(homeDir)) throw new Error(`temp-hygiene: dir phiên đã tồn tại: ${homeDir}`);
  fs.mkdirSync(homeDir, { recursive: false });

  const manifest = { version: 1, sessionId: id, purpose, createdAt: new Date().toISOString(), homeDir, dirs: [homeDir], files: [], processes: [] };
  ensureOwnershipMarker(homeDir, id);
  const save = () => fs.writeFileSync(path.join(homeDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  save();

  const assertInside = (p) => { if (!isInside(homeDir, p)) throw new Error(`path thoát session dir: ${p}`); };

  const mgr = {
    sessionId: id, tempRoot: root, homeDir, manifest,
    createDir(rel) {
      const d = path.join(homeDir, rel);
      assertInside(d);
      fs.mkdirSync(d, { recursive: true });
      ensureOwnershipMarker(d, id);
      if (!manifest.dirs.includes(d)) manifest.dirs.push(d);
      save();
      return d;
    },
    createFile(rel, content) {
      const p = path.join(homeDir, rel);
      assertInside(p);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      ensureOwnershipMarker(path.dirname(p), id);
      if (!manifest.files.includes(p)) manifest.files.push(p);
      save();
      return p;
    },
    spawnProcess(cmd, args = [], opts = {}) {
      const child = spawn(cmd, args, opts);
      // identity owner ngoài PID: caller phải đính identity (vd: chuỗi sessionId)
      // vào args/env/cmdline của process để verifyProcessIdentity khớp.
      manifest.processes.push({ pid: child.pid, cmd, args, identity: opts.identity || id });
      save();
      return child;
    },
    cleanup(opts = {}) { return cleanupSession(mgr, opts); },
  };
  return mgr;
}

// --- cleanup + read-back ---
export function cleanupSession(mgr, { timeoutMs = 1500, projectRoot = null, workspaceBefore = null } = {}) {
  const { manifest, homeDir } = mgr;
  const rootDir = path.resolve(path.dirname(homeDir));
  const sessionId = mgr.sessionId;
  const res = { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [], killed: [], unverified: [], readBack: null, errors: [] };

  // 1. dừng đúng child process phiên tạo: xác minh owner identity (chống PID reuse).
  const stp = stopTrackedProcesses(manifest.processes || [], { timeoutMs, sessionId });
  res.killed = stp.killed;
  res.unverified = stp.unverified;

  // 2. xóa target liệt kê trong manifest (deep nhất trước). Chỉ target trong root,
  //    không symlink/junction, target thực (realpath) phải trong root (chống escape).
  const targets = [...(manifest.files || []), ...(manifest.dirs || [])];
  targets.sort((a, b) => path.resolve(b).length - path.resolve(a).length);
  for (const t of targets) {
    if (!isInside(rootDir, t)) { res.errors.push(`outside allowed root: ${redactHome(t)}`); res.leftover.push(redactHome(t)); continue; }
    if (/\.session-(owner|manifest)/.test(path.basename(t))) continue; // marker/manifest tự quản ở bước 3
    if (isSymlink(t)) {
      res.errors.push(`refuse symlink/junction: ${redactHome(t)}`);
      res.leftover.push(redactHome(t));
      continue;
    }
    if (realPathOrNull(t) === null) continue; // đã xóa/sẵn hết → idempotent, không leftover
    if (!isCanonicalInside(rootDir, t)) {
      res.errors.push(`refuse target thoát root: ${redactHome(t)}`);
      res.leftover.push(redactHome(t));
      continue;
    }
    try {
      fs.rmSync(t, { recursive: fs.existsSync(t) && fs.statSync(t).isDirectory(), force: true });
      res.removed.push(redactHome(t));
    } catch (e) {
      res.errors.push(String((e && e.message) || e));
      res.leftover.push(redactHome(t));
    }
  }

  // 3. xóa dir phiên (cùng marker + manifest): path đã validate = root/<sessionId>,
  //    và realpath phải nằm trong root (từ chối nếu homeDir là symlink/junction thoát).
  try {
    if (fs.existsSync(homeDir)) {
      if (isSymlink(homeDir) || !isCanonicalInside(rootDir, homeDir)) {
        res.errors.push(`refuse xóa homeDir symlink/junction thoát root: ${redactHome(homeDir)}`);
        res.leftover.push(redactHome(homeDir));
      } else {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }
  } catch (e) {
    res.errors.push(String((e && e.message) || e));
    res.leftover.push(redactHome(homeDir));
  }

  // 4. read-back: workspace/poc hết, marker/manifest hết, process con hết, repo không đổi.
  const homeGone = !fs.existsSync(homeDir);
  const procGone = (manifest.processes || []).every((p) => !isAlive(p.pid));
  const ws = projectRoot ? workspaceChange(projectRoot, workspaceBefore) : null;
  const workspaceUnchanged = !projectRoot || (ws && ws.length === 0);
  res.readBack = { homeGone, processesGone: procGone, workspaceUnchanged };
  res.leftover = res.leftover.map(redactHome);

  const ok = homeGone && procGone && res.leftover.length === 0 && res.errors.length === 0 && workspaceUnchanged;
  res.verdict = ok ? 'CLEAN' : 'POC_CLEANUP_FAILED';
  return res;
}

// --- recovery theo sessionId (idempotent, chỉ xóa resource có marker) ---
export function recoverSession({ sessionId, tempRoot = DEFAULT_TEMP_ROOT() }) {
  if (!isSafeSessionId(sessionId)) throw new Error(`temp-hygiene: sessionId không an toàn: "${sessionId}"`);
  const root = path.resolve(tempRoot);
  const home = path.join(root, sessionId);
  if (!fs.existsSync(home)) return { verdict: 'CLEAN', removed: [], leftover: [], errors: [] }; // idempotent
  if (!isInside(root, home) || isSymlink(home) || !isCanonicalInside(root, home)) {
    return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['symlink/junction hoặc thoát root'] };
  }
  if (!hasOwnershipMarker(home, sessionId)) {
    return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['thiếu ownership marker — không tự xóa'] };
  }
  try {
    const proc = JSON.parse(fs.readFileSync(path.join(home, MANIFEST_NAME), 'utf8')).processes || [];
    const stp = stopTrackedProcesses(proc, { timeoutMs: 800, sessionId });
    if (stp.unverified.length > 0) {
      return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: ['process unverified (PID reuse nghi ngờ) — chưa kill'] };
    }
  } catch { /* manifest hỏng không chặn xóa dir có marker */ }
  try {
    fs.rmSync(home, { recursive: true, force: true });
    const gone = !fs.existsSync(home);
    return { verdict: gone ? 'CLEAN' : 'POC_CLEANUP_FAILED', removed: gone ? [redactHome(home)] : [], leftover: gone ? [] : [redactHome(home)], errors: [] };
  } catch (e) {
    return { verdict: 'POC_CLEANUP_FAILED', removed: [], leftover: [redactHome(home)], errors: [String((e && e.message) || e)] };
  }
}

