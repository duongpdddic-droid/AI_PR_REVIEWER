#!/usr/bin/env node
// project-onboard.mjs - SHARED Agent Platform: project onboarding (status|onboard|repair|offboard).
// Lives in AI_PR_REVIEWER/scripts/. ONE source of truth. Imported by:
//   - AI_PR_REVIEWER/scripts/onboard.mjs (thin CLI shim with env+flag discovery)
//   - any consumer (cline-mem-bridge, Soc_brain, QLDA_DTXD, ...) that wants to drive
//     onboarding programmatically without copying the implementation.
//
// Contract:
//   * Pure logic: no hard-coded paths. Every I/O is relative to opts.registryPath.
//   * Manifest is required input. The caller decides where it lives.
//   * Onboard is idempotent: re-running on a registered project is a no-op success
//     (action:"noop_already_onboarded" only when already present).
//   * Offboard is idempotent: no-op when projectId absent (action:"noop_not_found").
//   * NO mutation of caller-supplied registry object: pass it in, get a reloaded
//     registry back; on-disk state is the only ground-truth after writes.
//
// public API:
//   runOnboard(argv, env)              -> Promise<{ok,code,action?,sub,...}>
//   subOnboard(opts)                   -> Promise<{ok,code,action,projectId,registryPath}>
//   subStatus(opts)                    -> Promise<{ok,code,found,projectId?,...}>
//   subRepair(opts)                    -> Promise<{ok,code,action,projectId,registryPath}>
//   subOffboard(opts)                  -> Promise<{ok,code,action,projectId,registryPath}>
//   HELP (string)
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const FAIL_CODES = Object.freeze({ OK: 0, USER_ERROR: 2, REGISTRY_ERROR: 3, CONFIG_ERROR: 4 });
export const ACTOR_DEFAULT = 'shared-onboard';

// resolveRegistryModule: discovery contract for the shared project-registry module.
// Order (first hit wins):
//   1. opts.registryModulePath (explicit override)
//   2. env.AI_PR_REGISTRY_MODULE
//   3. env.AI_PR_REVIEWER_HOME + '/scripts/project-registry.mjs'
//   4. ~/.cline/AI_PR_REVIEWER/scripts/project-registry.mjs
const DEFAULT_AI_PR_HOME_WINDOWS = path.join(process.env.USERPROFILE || os.homedir(), '.cline', 'AI_PR_REVIEWER');
const DEFAULT_AI_PR_HOME_POSIX    = path.join(os.homedir(), '.cline', 'AI_PR_REVIEWER');
function defaultAiprHome() {
  return process.platform === 'win32' ? DEFAULT_AI_PR_HOME_WINDOWS : DEFAULT_AI_PR_HOME_POSIX;
}
export function resolveRegistryModule({ registryModulePath, env = process.env } = {}) {
  const candidates = [];
  if (registryModulePath) candidates.push(String(registryModulePath));
  if (env.AI_PR_REGISTRY_MODULE) candidates.push(String(env.AI_PR_REGISTRY_MODULE));
  if (env.AI_PR_REVIEWER_HOME) candidates.push(path.join(String(env.AI_PR_REVIEWER_HOME), 'scripts', 'project-registry.mjs'));
  candidates.push(path.join(defaultAiprHome(), 'scripts', 'project-registry.mjs'));
  for (const c of candidates) {
    try {
      const abs = path.resolve(c);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return { ok: true, url: pathToFileURL(abs).href, path: abs };
      }
    } catch { /* try next */ }
  }
  return { ok: false, reason: 'REGISTRY_MODULE_NOT_FOUND', tried: candidates };
}

// resolveRegistryPath: machine-local registry file path. May or may not exist.
//   1. opts.registryPath
//   2. env.AI_PR_REGISTRY_PATH
//   3. <homedir>/.ai-pr-reviewer/registry.json  (matches project-registry.mjs DEFAULT_REGISTRY_PATH)
export function resolveRegistryPath({ registryPath, env = process.env } = {}) {
  if (registryPath) return { ok: true, path: path.resolve(String(registryPath)) };
  if (env.AI_PR_REGISTRY_PATH) return { ok: true, path: path.resolve(String(env.AI_PR_REGISTRY_PATH)) };
  return { ok: true, path: path.join(os.homedir(), '.ai-pr-reviewer', 'registry.json') };
}

export function loadManifestFromPath(manifestPath) {
  if (!manifestPath) return { ok: false, reason: 'MANIFEST_PATH_REQUIRED' };
  const abs = path.resolve(manifestPath);
  if (!fs.existsSync(abs)) return { ok: false, reason: 'MANIFEST_NOT_FOUND:' + abs };
  let m;
  try { m = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { return { ok: false, reason: 'MANIFEST_PARSE_ERROR:' + (e.message || 'parse') }; }
  return { ok: true, manifest: m, path: abs };
}

export function actualRemoteFor(worktreePath) {
  if (!worktreePath) return null;
  try {
    const r = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: worktreePath, encoding: 'utf8' });
    return r.trim();
  } catch { return null; }
}

export async function loadRegistryModule(registryModuleUrl) {
  if (!registryModuleUrl) return { ok: false, reason: 'REGISTRY_MODULE_URL_REQUIRED' };
  try {
    const mod = await import(registryModuleUrl);
    const required = ['loadRegistry', 'saveRegistry', 'validateManifest', 'registerProject', 'removeProject', 'detectConflicts', 'assertWorkspaceRemote'];
    const missing = required.filter((k) => !(k in mod));
    if (missing.length) return { ok: false, reason: 'REGISTRY_MODULE_INCOMPLETE', missing };
    return { ok: true, mod };
  } catch (e) {
    return { ok: false, reason: 'REGISTRY_MODULE_IMPORT_FAILED:' + ((e && e.message) || String(e)) };
  }
}

function entryFor(registry, projectId) {
  if (!registry || !Array.isArray(registry.projects)) return null;
  return registry.projects.find((p) => p && p.projectId === projectId) || null;
}

export async function subStatus({ manifest, manifestPath, registryPath, registryModulePath, env = process.env } = {}) {
  const ml = loadManifestFromPath(manifestPath || (manifest && manifest.path));
  if (!ml.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: ml.reason };
  const m = manifest || ml.manifest;
  const rp = resolveRegistryPath({ registryPath, env });
  if (!rp.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rp.reason };
  const found = fs.existsSync(rp.path);
  if (!found) {
    return { ok: true, code: FAIL_CODES.OK, found: false, projectId: m.projectId, repository: m.repository, registryPath: rp.path };
  }
  const rmm = resolveRegistryModule({ registryModulePath, env });
  if (!rmm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rmm.reason, tried: rmm.tried };
  const rm = await loadRegistryModule(rmm.url);
  if (!rm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rm.reason };
  const reg = rm.mod.loadRegistry({ registryPath: rp.path });
  const e = entryFor(reg, m.projectId);
  if (!e) {
    return { ok: true, code: FAIL_CODES.OK, found: false, projectId: m.projectId, repository: m.repository, registryPath: rp.path };
  }
  return {
    ok: true, code: FAIL_CODES.OK, found: true,
    projectId: e.projectId, repository: e.repository,
    workspaceId: e.workspace && e.workspace.workspaceId,
    route: e.telegram && e.telegram.route,
    policyVersion: e.policy && e.policy.version,
    registryPath: rp.path,
  };
}

export async function subOnboard({ manifest, manifestPath, registryPath, registryModulePath, actualRemote, worktreePath, env = process.env, actor = ACTOR_DEFAULT } = {}) {
  const ml = loadManifestFromPath(manifestPath || (manifest && manifest.path));
  if (!ml.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: ml.reason };
  const m = manifest || ml.manifest;
  const rp = resolveRegistryPath({ registryPath, env });
  const rmm = resolveRegistryModule({ registryModulePath, env });
  if (!rmm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rmm.reason, tried: rmm.tried };
  const rm = await loadRegistryModule(rmm.url);
  if (!rm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rm.reason };
  const v = rm.mod.validateManifest(m);
  if (!v.ok) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: 'MANIFEST_INVALID', errors: v.errors };
  const reg = rm.mod.loadRegistry({ registryPath: rp.path });
  const existing = entryFor(reg, m.projectId);
  if (existing) {
    return { ok: true, code: FAIL_CODES.OK, action: 'noop_already_onboarded', projectId: m.projectId, registryPath: rp.path, registryModulePath: rmm.path };
  }
  const ar = actualRemote != null ? actualRemote : (worktreePath ? actualRemoteFor(worktreePath) : null);
  if (!ar) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: 'ACTUAL_REMOTE_REQUIRED' };
  const conflicts = rm.mod.detectConflicts({ registry: reg, manifest: m });
  if (conflicts.length) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: 'CONFLICTS', conflicts };
  const rc = rm.mod.assertWorkspaceRemote({ manifest: m, actualRemote: ar });
  if (!rc.ok) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: rc.reason || 'REMOTE_MISMATCH', actual: rc.actual, expected: rc.expected };
  const r = rm.mod.registerProject({ manifest: m, registry: reg, registryPath: rp.path, actualRemote: ar });
  if (!r.ok) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: r.reason || 'REGISTER_FAILED', errors: r.errors, conflicts: r.conflicts };
  const reloaded = rm.mod.loadRegistry({ registryPath: rp.path });
  const e = entryFor(reloaded, m.projectId);
  return { ok: true, code: FAIL_CODES.OK, action: 'onboarded', projectId: m.projectId, registryPath: rp.path, registryModulePath: rmm.path, entry: e };
}

export async function subRepair({ manifest, manifestPath, registryPath, registryModulePath, actualRemote, worktreePath, env = process.env, actor = ACTOR_DEFAULT } = {}) {
  const ml = loadManifestFromPath(manifestPath || (manifest && manifest.path));
  if (!ml.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: ml.reason };
  const m = manifest || ml.manifest;
  const rp = resolveRegistryPath({ registryPath, env });
  const rmm = resolveRegistryModule({ registryModulePath, env });
  if (!rmm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rmm.reason, tried: rmm.tried };
  const rm = await loadRegistryModule(rmm.url);
  if (!rm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rm.reason };
  const v = rm.mod.validateManifest(m);
  if (!v.ok) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: 'MANIFEST_INVALID', errors: v.errors };
  const reg = rm.mod.loadRegistry({ registryPath: rp.path });
  const ar = actualRemote != null ? actualRemote : (worktreePath ? actualRemoteFor(worktreePath) : null);
  if (!ar) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: 'ACTUAL_REMOTE_REQUIRED' };
  const conflicts = rm.mod.detectConflicts({ registry: reg, manifest: m });
  if (conflicts.length) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: 'CONFLICTS', conflicts };
  const rc = rm.mod.assertWorkspaceRemote({ manifest: m, actualRemote: ar });
  if (!rc.ok) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: rc.reason || 'REMOTE_MISMATCH', actual: rc.actual, expected: rc.expected };
  const r = rm.mod.registerProject({ manifest: m, registry: reg, registryPath: rp.path, actualRemote: ar, force: true });
  if (!r.ok) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: r.reason || 'REPAIR_FAILED', errors: r.errors, conflicts: r.conflicts };
  const reloaded = rm.mod.loadRegistry({ registryPath: rp.path });
  const e = entryFor(reloaded, m.projectId);
  return { ok: true, code: FAIL_CODES.OK, action: 'repaired', projectId: m.projectId, registryPath: rp.path, registryModulePath: rmm.path, entry: e };
}

export async function subOffboard({ manifest, manifestPath, registryPath, registryModulePath, env = process.env, actor = ACTOR_DEFAULT } = {}) {
  const ml = loadManifestFromPath(manifestPath || (manifest && manifest.path));
  if (!ml.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: ml.reason };
  const m = manifest || ml.manifest;
  const rp = resolveRegistryPath({ registryPath, env });
  const rmm = resolveRegistryModule({ registryModulePath, env });
  if (!rmm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rmm.reason, tried: rmm.tried };
  const rm = await loadRegistryModule(rmm.url);
  if (!rm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rm.reason };
  const reg = rm.mod.loadRegistry({ registryPath: rp.path });
  const r = rm.mod.removeProject({ projectId: m.projectId, registry: reg, registryPath: rp.path, actor });
  if (!r.ok) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: r.reason || 'REMOVE_FAILED', detail: r };
  return { ok: true, code: FAIL_CODES.OK, action: r.removed ? 'offboarded' : 'noop_not_found', projectId: m.projectId, registryPath: rp.path, registryModulePath: rmm.path, fingerprint: r.fingerprint || null };
}

export const HELP = 'usage: node onboard.mjs <subcommand> [options]\n\nSubcommands:\n  status            show whether the manifest project is registered\n  onboard           register the project (idempotent: noop if already present)\n  repair            force re-register (re-validate, may overwrite if content changed)\n  offboard          remove the project entry (idempotent: noop if absent)\n  --help, -h        show this help\n\nOptions:\n  --manifest <path>         path to .agent/project.json (default: env.MANIFEST_PATH or ./agent/project.json)\n  --registry <path>         machine-local registry.json (default: env.AI_PR_REGISTRY_PATH or ~/.ai-pr-reviewer/registry.json)\n  --module <file-or-url>    path or file:// URL to project-registry.mjs (default: env.AI_PR_REGISTRY_MODULE or env.AI_PR_REVIEWER_HOME + /scripts/project-registry.mjs)\n  --remote <url>            explicit actualRemote (skips git lookup; required if not in a git worktree)\n  --worktree <path>         path to a git worktree; remote is read via git remote get-url origin\n  --actor <name>            actor label for audit (default: shared-onboard)\n\nEnv vars (override defaults; flag overrides env):\n  AI_PR_REGISTRY_PATH       path to registry.json\n  AI_PR_REGISTRY_MODULE     path or file:// URL to project-registry.mjs\n  AI_PR_REVIEWER_HOME       dir containing scripts/project-registry.mjs\n  MANIFEST_PATH             default manifest location\n\nDiscovery order for the registry module (first hit wins): --module > AI_PR_REGISTRY_MODULE > AI_PR_REVIEWER_HOME/scripts/project-registry.mjs > ~/.cline/AI_PR_REVIEWER/scripts/project-registry.mjs';

function parseOnboardArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') && !a.startsWith('-')) continue;
    const eq = a.indexOf('=');
    let k, v;
    if (eq >= 0) { k = a.slice(0, eq); v = a.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) { k = a; v = argv[++i]; }
    else { k = a; v = true; }
    flags[k.replace(/^-+/, '')] = v;
  }
  return flags;
}

export async function runOnboard(argv, env = process.env) {
  // argv shape: [subcommand, ...flags] (caller strips node+script)
  const sub = argv[0];
  if (sub === '--help' || sub === '-h' || sub === undefined) {
    return { ok: true, code: FAIL_CODES.OK, help: true, helpText: HELP };
  }
  const flags = parseOnboardArgs(argv.slice(1));
  const opts = {
    manifestPath: flags.manifest || env.MANIFEST_PATH,
    registryPath: flags.registry,
    registryModulePath: flags.module,
    actualRemote: typeof flags.remote === 'string' ? flags.remote : undefined,
    worktreePath: flags.worktree,
    actor: flags.actor || ACTOR_DEFAULT,
    env,
  };
  let r;
  try {
    switch (sub) {
      case 'status':   r = await subStatus(opts); break;
      case 'onboard':  r = await subOnboard(opts); break;
      case 'repair':   r = await subRepair(opts); break;
      case 'offboard': r = await subOffboard(opts); break;
      default: r = { ok: false, code: FAIL_CODES.USER_ERROR, message: 'UNKNOWN_SUBCOMMAND:' + sub };
    }
  } catch (e) {
    r = { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: 'UNCAUGHT:' + ((e && e.message) || String(e)) };
  }
  return r;
}
