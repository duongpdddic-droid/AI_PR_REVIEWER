#!/usr/bin/env node
// canonical-identity.mjs — Canonical Project Identity resolver (Issue #18).
// Chặn stale workspace root, wrong-repo, multi-root và sibling-worktree leakage.
// Lõi THUẦN (pure) + IO injectable để test; CLI wrapper ở cuối file cho live E2E.
//
// Nguyên tắc:
//   - workspaceRoots CHỈ là signal, KHÔNG phải authority duy nhất (Issue #18).
//   - Nguồn đối chiếu deterministic theo trọng số:
//       git remote (real worktree root)  >=  Project Registry identity
//       real worktree root / cwd         >=  event file path (containing worktree)
//       registry remote (manifest.repository)  >  workspaceRoots[0]
//   - Mâu thuẫn / không xác định duy nhất -> fail-closed: KHÔNG gán mù, KHÔNG inject
//     từ project khác; trả quarantine/no-op với reason machine-readable.
//   - Sibling worktree/repo cùng parent KHÔNG được nhận capture của nhau.
//
// public API (pure):
//   normalizeRemote(url) -> 'owner/name' canonical
//   gitRemoteOf(root, exec) -> remote normalized | null
//   canonicalRootOf(path, {fs, exec}) -> git top-level + realpath | null
//   worktreeRootContaining(filePath, {fs, exec}) -> worktree root chứa path | null
//   resolveCanonicalIdentity({registry, signals, io})
//   resolveForCapture({registry, signals, io})
//   resolveForRetrieval({registry, projectId, signals, io})
//   redactIdentity(identity)
//   REASON (codes machine-readable)
//
// Test: scripts/test-canonical-identity.mjs (fixture + negative isolation).

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- normalization

/** Chuẩn hóa git remote URL về 'owner/name' canonical (bỏ .git, scheme, www, cờ). */
export function normalizeRemote(url) {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  let m = u.match(/^(?:git@|ssh:\/\/git@)?([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) m = u.match(/^https?:\/\/(?:www\.)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const host = (m[1] || '').toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return null; // chỉ canonical GitHub identity
  const owner = (m[2] || '').toLowerCase();
  const name = (m[3] || '').toLowerCase();
  if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return `${owner}/${name}`;
}

/** Đọc git remote origin của một root thật (io). Trả normalized 'owner/name' | null. */
export function gitRemoteOf(root, exec) {
  try {
    const out = exec(['git', 'remote', 'get-url', 'origin'], { cwd: root });
    return normalizeRemote((out || '').trim());
  } catch {
    return null;
  }
}

/** Canonical root thật: git top-level (thắng cwd giả) + realpath (thắng symlink/junction). */
export function canonicalRootOf(p, { fsImpl = fs, exec = null } = {}) {
  if (!p || typeof p !== 'string') return null;
  let top = null;
  if (exec) {
    try {
      const out = exec(['git', 'rev-parse', '--show-toplevel'], { cwd: p });
      top = (out || '').trim();
      if (!top) return null;
    } catch {
      return null; // không phải git worktree -> không canonical
    }
  } else {
    top = p;
  }
  try {
    return fsImpl.realpathSync ? fsImpl.realpathSync(top) : path.resolve(top);
  } catch {
    return path.resolve(top);
  }
}

/** Worktree root thật chứa một đường dẫn bất kỳ (event file path). */
export function worktreeRootContaining(filePath, { fsImpl = fs, exec = null, maxDepth = 16 } = {}) {
  if (!filePath || typeof filePath !== 'string') return null;
  let cur = path.resolve(filePath);
  for (let i = 0; i < maxDepth; i++) {
    if (exec) {
      try {
        const out = exec(['git', 'rev-parse', '--show-toplevel'], { cwd: cur });
        const top = (out || '').trim();
        if (top) return canonicalRootOf(top, { fsImpl, exec });
      } catch { /* đi lên */ }
    }
    const gitDir = path.join(cur, '.git');
    try { if (fsImpl.statSync && fsImpl.statSync(gitDir).isDirectory()) return canonicalRootOf(cur, { fsImpl, exec }); } catch { /* noop */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
// ---------------------------------------------------------------- resolver core

export const REASON = Object.freeze({
  RESOLVED: 'RESOLVED',
  NO_REMOTE: 'NO_REMOTE',
  REGISTRY_EMPTY: 'REGISTRY_EMPTY',
  UNREGISTERED_REMOTE: 'UNREGISTERED_REMOTE',
  AMBIGUOUS_MULTI_ROOT: 'AMBIGUOUS_MULTI_ROOT',
  STALE_WORKSPACE_ROOT: 'STALE_WORKSPACE_ROOT',
  WORKSPACE_ROOT_CONFLICT: 'WORKSPACE_ROOT_CONFLICT',
  EVENT_OUTSIDE_WORKTREE: 'EVENT_OUTSIDE_WORKTREE',
  SIBLING_WORKTREE_LEAK: 'SIBLING_WORKTREE_LEAK',
  REMOTE_REGISTRY_MISMATCH: 'REMOTE_REGISTRY_MISMATCH',
  WORKTREE_UNRESOLVED: 'WORKTREE_UNRESOLVED',
  PROJECT_NOT_REGISTERED: 'PROJECT_NOT_REGISTERED',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
});

function registryProjects(registry) {
  if (!registry || typeof registry !== 'object') return [];
  const arr = registry.projects;
  return Array.isArray(arr) ? arr.filter((p) => p && p.projectId) : [];
}

function projectByRemote(projects, remote) {
  if (!remote) return [];
  return projects.filter((p) => {
    const repo = (p.repository || '').toLowerCase().replace(/^https?:\/\/(?:www\.)?github\.com\//, '').replace(/\.git$/, '');
    return repo === remote || p.repository === remote;
  });
}

/** Resolve canonical identity từ nhiều nguồn (pure). */
export function resolveCanonicalIdentity({ registry, signals = {}, io = {} } = {}) {
  const projects = registryProjects(registry);
  const exec = io.exec || ((args, opts) => execFileSync(args[0], args.slice(1), { encoding: 'utf8', cwd: opts.cwd }));
  const fsImpl = io.fs || fs;
  const cwd = signals.cwd || process.cwd();
  const workspaceRoots = Array.isArray(signals.workspaceRoots) ? signals.workspaceRoots.filter(Boolean) : [];
  const eventFile = signals.eventFile;

  const sources = { cwd, workspaceRoots, eventFile, remote: null, worktreeRoot: null, eventRoot: null };

  // Bước 1: real worktree root từ cwd — authority mạnh nhất.
  const worktreeRoot = canonicalRootOf(cwd, { fsImpl, exec });
  sources.worktreeRoot = worktreeRoot;
  if (!worktreeRoot) {
    return { status: 'error', projectId: null, reason: REASON.WORKTREE_UNRESOLVED, sources, quarantine: true };
  }

  // Bước 2: git remote từ real worktree root.
  const remote = gitRemoteOf(worktreeRoot, exec);
  sources.remote = remote;
  if (!remote) {
    return { status: 'error', projectId: null, reason: REASON.NO_REMOTE, sources, quarantine: true };
  }

  // Bước 3: wrong-repo gate — remote phải khớp ĐÚNG MỘT entry registry.
  const byRemote = projectByRemote(projects, remote);
  if (byRemote.length === 0) {
    return { status: 'unregistered', projectId: null, reason: REASON.UNREGISTERED_REMOTE, sources, quarantine: true };
  }
  if (byRemote.length > 1) {
    return { status: 'ambiguous', projectId: null, reason: REASON.AMBIGUOUS_MULTI_ROOT, sources, quarantine: true };
  }
  const regProject = byRemote[0];
  const regWorktree = regProject.workspace && regProject.workspace.worktree
    ? canonicalRootOf(regProject.workspace.worktree, { fsImpl, exec })
    : null;

  // Bước 4: registry worktree (nếu khai báo) phải khớp real worktree root.
  // Không resolve được (không phải git) hoặc lệch -> fail-closed (REMOTE_REGISTRY_MISMATCH).
  if (regProject.workspace && regProject.workspace.worktree && (!regWorktree || regWorktree !== worktreeRoot)) {
    return { status: 'ambiguous', projectId: null, reason: REASON.REMOTE_REGISTRY_MISMATCH, sources, quarantine: true };
  }

  // Bước 5: event file path phải nằm trong canonical worktree (file events gate).
  let eventRoot = null;
  if (eventFile) {
    eventRoot = worktreeRootContaining(eventFile, { fsImpl, exec });
    sources.eventRoot = eventRoot;
    if (!eventRoot) {
      return { status: 'error', projectId: null, reason: REASON.EVENT_OUTSIDE_WORKTREE, sources, quarantine: true };
    }
    if (eventRoot !== worktreeRoot) {
      const eventRemote = gitRemoteOf(eventRoot, exec);
      const byEventRemote = eventRemote ? projectByRemote(projects, eventRemote) : [];
      if (byEventRemote.length === 1 && byEventRemote[0].projectId !== regProject.projectId) {
        return { status: 'ambiguous', projectId: null, reason: REASON.SIBLING_WORKTREE_LEAK, sources, quarantine: true };
      }
      return { status: 'error', projectId: null, reason: REASON.EVENT_OUTSIDE_WORKTREE, sources, quarantine: true };
    }
  }


  // Bước 6: workspaceRoots CHỈ là signal — không thắng registry+remote+real cwd (stale gate).
  const resolved = { projectId: regProject.projectId, remote, worktreeRoot, regProject };
  if (workspaceRoots.length > 0) {
    const ws0 = workspaceRoots[0];
    const ws0Root = canonicalRootOf(ws0, { fsImpl, exec });
    sources.workspaceRootsResolved = workspaceRoots.map((w) => canonicalRootOf(w, { fsImpl, exec }));
    if (!ws0Root || ws0Root !== worktreeRoot) {
      resolved.staleWorkspaceRoot = true;
      resolved.workspaceRootConflict = Boolean(ws0Root && ws0Root !== worktreeRoot);
    }
    // Multi-root: mỗi root thật map đúng 1 project, tất cả khớp project cwd.
    const distinct = [...new Set(sources.workspaceRootsResolved.filter(Boolean))];
    if (distinct.length > 1) {
      const mapped = [];
      for (const r of distinct) {
        const rRemote = gitRemoteOf(r, exec);
        const byR = rRemote ? projectByRemote(projects, rRemote) : [];
        if (byR.length === 1) mapped.push({ root: r, projectId: byR[0].projectId });
      }
      if (mapped.length !== distinct.length || mapped.some((m) => m.projectId !== regProject.projectId)) {
        resolved.multiRoot = { distinct, mapped };
        return { status: 'ambiguous', projectId: null, reason: REASON.AMBIGUOUS_MULTI_ROOT, sources, quarantine: true };
      }
    }
  }

  return { status: 'resolved', projectId: resolved.projectId, reason: REASON.RESOLVED, sources, quarantine: false, resolved };
}

/** Capture decision: mâu thuẫn/ambiguity -> quarantine, không inject từ project khác. */
export function resolveForCapture({ registry, signals = {}, io = {} } = {}) {
  const r = resolveCanonicalIdentity({ registry, signals, io });
  if (r.status !== 'resolved' || !r.projectId) {
    return { ok: false, projectId: null, quarantine: true, reason: r.reason, sources: r.sources };
  }
  return { ok: true, projectId: r.projectId, quarantine: false, reason: REASON.RESOLVED, sources: r.sources };
}

/** Retrieval decision: explicit read-only search PHẢI yêu cầu project canonical (Activation gate). */
export function resolveForRetrieval({ registry, projectId, signals = {}, io = {} } = {}) {
  if (!projectId) return { ok: false, allowed: false, quarantine: true, reason: REASON.PROJECT_NOT_REGISTERED };
  const projects = registryProjects(registry);
  if (!projects.some((p) => p.projectId === projectId)) {
    return { ok: false, allowed: false, quarantine: true, reason: REASON.PROJECT_NOT_REGISTERED };
  }
  const r = resolveCanonicalIdentity({ registry, signals, io });
  if (r.status !== 'resolved' || !r.projectId) {
    return { ok: false, allowed: false, quarantine: true, reason: r.reason, sources: r.sources };
  }
  if (r.projectId !== projectId) {
    return { ok: false, allowed: false, quarantine: true, reason: REASON.IDENTITY_MISMATCH, sources: r.sources };
  }
  return { ok: true, allowed: true, quarantine: false, reason: REASON.RESOLVED, sources: r.sources };
}

/** Redact absolute home/PII khỏi output evidence (Issue #18 AC). */
export function redactIdentity(identity, { home = process.env.USERPROFILE || '' } = {}) {
  if (!identity || typeof identity !== 'object') return identity;
  const out = JSON.parse(JSON.stringify(identity));
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = v;
      if (home) s = s.split(home).join('~');
      s = s.replace(/[A-Za-z]:[\\/][^\s"]+/g, (m) => '<abs>');
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v; }
    return v;
  };
  return walk(out);
}

// ---------------------------------------------------------------- CLI (live E2E)

export async function runCli(argv, env = process.env) {
  const args = argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) { flags[a.slice(0, eq)] = a.slice(eq + 1); }
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) { flags[a] = args[++i]; }
    else flags[a] = true;
  }
  const sub = flags._sub || (args[0] && !args[0].startsWith('--') ? args[0] : null) || 'capture';

  const registryPath = flags.registry || env.AI_PR_REGISTRY_PATH || path.join(env.USERPROFILE || '', '.ai-pr-reviewer', 'registry.json');
  let registry = { projects: [] };
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { /* trống */ }

  const signals = {
    cwd: flags.cwd || process.cwd(),
    workspaceRoots: flags['workspace-roots'] ? flags['workspace-roots'].split(path.delimiter) : undefined,
    eventFile: flags['event-file'] || undefined,
  };

  const io = {
    exec: (cmdArgs, opts) => execFileSync(cmdArgs[0], cmdArgs.slice(1), { encoding: 'utf8', cwd: opts.cwd }),
    fs,
  };

  let result;
  switch (sub) {
    case 'capture':
      result = resolveForCapture({ registry, signals, io });
      break;
    case 'retrieval':
      result = resolveForRetrieval({ registry, projectId: flags.project, signals, io });
      break;
    case 'resolve':
      result = resolveCanonicalIdentity({ registry, signals, io });
      break;
    default:
      result = { ok: false, error: `UNKNOWN_SUBCOMMAND:${sub}` };
  }
  process.stdout.write(JSON.stringify(redactIdentity(result)) + '\n');
  process.exit(result && result.status === 'resolved' || (result && result.ok === true) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv).catch((e) => {
    process.stderr.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }) + '\n');
    process.exit(1);
  });
}
