#!/usr/bin/env node
// project-onboard.mjs - SHARED Agent Platform: project onboarding (status|register|onboard|repair|offboard|hook).
// Lives in AI_PR_REVIEWER/scripts/. ONE source of truth. Imported by:
//   - AI_PR_REVIEWER/scripts/onboard.mjs (thin CLI shim with env+flag discovery)
//   - any consumer (cline-mem-bridge, Soc_brain, QLDA_DTXD, ...) that wants to drive
//     onboarding programmatically without copying the implementation.
//
// Contract:
//   * Pure logic: no hard-coded paths. Every I/O is relative to opts.registryPath.
//   * Manifest is required input. The caller decides where it lives.
//   * Register/onboard is idempotent: re-running on a registered project is a no-op
//     success (action:"noop_already_onboarded" only when already present).
//   * Offboard is idempotent: no-op when projectId absent (action:"noop_not_found").
//   * NO mutation of caller-supplied registry object: pass it in, get a reloaded
//     registry back; on-disk state is the only ground-truth after writes.
//   * Hook deployment is delegated to the bridge-owned installer
//     (<bridgeHome>/install-hooks.js) which enforces fail-closed ownership.
//   * READINESS IS DERIVED, never persisted:
//       registry yes + hooks valid        => READY
//       registry yes + hooks invalid      => PARTIAL (reason codes)
//       registry no  + hooks exist        => PARTIAL (REGISTRY_MISSING)
//       registry no  + hooks absent       => NOT_ONBOARDED
//   * PARTIAL reason codes: HOOKS_MISSING | HOOKS_STALE | HOOK_COLLISION |
//       DUPLICATE_RISK | REGISTRY_MISSING | BRIDGE_NOT_CONFIGURED
//
// public API:
//   runOnboard(argv, env)              -> Promise<{ok,code,action?,sub,...}>
//   subStatus(opts)                    -> registry + hook state + readiness
//   subRegister(opts)                  -> registry-only onboard (idempotent)
//   subOnboard(opts)                   -> register + install hooks -> READY
//   subRepair(opts)                    -> force re-register + repair hooks
//   subOffboard(opts)                  -> remove bridge-owned hooks + unregister
//   subHookInstall/subHookRepair/subHookUpdate(opts) -> hook-only operations
//   resolveBridgeHome(opts)            -> discovery: --bridge-home > env > machine config
//   deriveReadiness(...)               -> {readiness, reasons[]}
//   HELP (string)
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';

export const FAIL_CODES = Object.freeze({ OK: 0, USER_ERROR: 2, REGISTRY_ERROR: 3, CONFIG_ERROR: 4 });
export const ACTOR_DEFAULT = 'shared-onboard';
export const BRIDGE_HOOK_VERSION = '1.0';
export const BRIDGE_MANIFEST = '.bridge-hooks.json';
export const BRIDGE_INSTALLER = 'install-hooks.js';
export const READY_CODES = Object.freeze({ READY: 'READY', PARTIAL: 'PARTIAL', NOT_ONBOARDED: 'NOT_ONBOARDED' });
export const BRIDGE_DISCOVERY_ORDER = ['--bridge-home', 'CLINE_MEM_BRIDGE_HOME', '~/.ai-pr-reviewer/config.json'];

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

// resolveBridgeHome: discovery contract for the cline-mem-bridge install location.
// Order (first hit wins):
//   1. opts.bridgeHome (--bridge-home, explicit)
//   2. env.CLINE_MEM_BRIDGE_HOME
//   3. shared machine-level config <homedir>/.ai-pr-reviewer/config.json -> { bridgeHome }
//      (env.AI_PR_BRIDGE_CONFIG overrides the config file path for tests/ops)
//   4. -> BRIDGE_NOT_CONFIGURED
// No $HOME scan for candidate repos; no hard-coded user dir; no per-project env.
export function resolveBridgeHome({ bridgeHome, env = process.env } = {}) {
  if (bridgeHome) return { ok: true, path: path.resolve(String(bridgeHome)) };
  if (env.CLINE_MEM_BRIDGE_HOME) return { ok: true, path: path.resolve(String(env.CLINE_MEM_BRIDGE_HOME)) };
  const cfgPath = env.AI_PR_BRIDGE_CONFIG || path.join(os.homedir(), '.ai-pr-reviewer', 'config.json');
  try {
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && typeof cfg.bridgeHome === 'string' && cfg.bridgeHome) {
        return { ok: true, path: path.resolve(cfg.bridgeHome), configPath: cfgPath };
      }
    }
  } catch { /* malformed config treated as not configured */ }
  return { ok: false, reason: 'BRIDGE_NOT_CONFIGURED', tried: BRIDGE_DISCOVERY_ORDER };
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


// ---- cline-mem-bridge hook integration --------------------------------------
// The bridge owns hook scripts + .bridge-hooks.json. We only invoke its installer.

export function hooksDirFor(worktreePath) {
  return worktreePath ? path.join(worktreePath, '.clinerules', 'hooks') : null;
}

function runInstaller(bridgeHome, args) {
  return new Promise((resolve) => {
    const installer = path.join(bridgeHome, BRIDGE_INSTALLER);
    if (!fs.existsSync(installer)) {
      resolve({ ok: false, reason: 'BRIDGE_INSTALLER_MISSING:' + installer });
      return;
    }
    execFile(process.execPath, [installer, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { resolve({ ok: false, reason: 'BRIDGE_INSTALLER_FAILED', message: (stderr || err.message || String(err)).slice(0, 500) }); return; }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { resolve({ ok: false, reason: 'BRIDGE_INSTALLER_BAD_JSON', stdout: String(stdout).slice(0, 500) }); }
    });
  });
}

// hookStatus: read-only check of bridge-owned hooks in a worktree.
//   {checkable:false, reason:'WORKTREE_REQUIRED'} when no worktreePath.
//   {checkable:true, ok:false, reason:'BRIDGE_NOT_CONFIGURED'} when bridge undiscoverable.
//   {checkable:true, ok:true, ...installer check report} otherwise.
export async function hookStatus({ worktreePath, bridgeHome, env = process.env } = {}) {
  const target = hooksDirFor(worktreePath);
  if (!target) return { checkable: false, reason: 'WORKTREE_REQUIRED' };
  const bh = resolveBridgeHome({ bridgeHome, env });
  if (!bh.ok) return { checkable: true, ok: false, reason: bh.reason, tried: bh.tried };
  const r = await runInstaller(bh.path, ['check', '--target', target, '--bridge-home', bh.path]);
  return { checkable: true, bridgeHome: bh.path, ...r };
}

// installHooks: install/repair bridge-owned hooks into a worktree.
export async function installHooks({ worktreePath, bridgeHome, env = process.env, force = false } = {}) {
  const target = hooksDirFor(worktreePath);
  if (!target) return { ok: false, reason: 'WORKTREE_REQUIRED' };
  const bh = resolveBridgeHome({ bridgeHome, env });
  if (!bh.ok) return { ok: false, reason: bh.reason, tried: bh.tried };
  const args = ['install', '--target', target, '--bridge-home', bh.path];
  if (force) args.push('--force');
  const r = await runInstaller(bh.path, args);
  return { ...r, bridgeHome: bh.path };
}

// removeHooks: remove ONLY bridge-owned hooks + manifest (fail-closed).
export async function removeHooks({ worktreePath, bridgeHome, env = process.env } = {}) {
  const target = hooksDirFor(worktreePath);
  if (!target) return { ok: false, reason: 'WORKTREE_REQUIRED' };
  const bh = resolveBridgeHome({ bridgeHome, env });
  if (!bh.ok) return { ok: false, reason: bh.reason, tried: bh.tried };
  const r = await runInstaller(bh.path, ['remove', '--target', target, '--bridge-home', bh.path]);
  return { ...r, bridgeHome: bh.path };
}

// deriveReadiness: DERIVED state, never persisted. Combines registry + hook facts.
//   registry no  + any hook files present => PARTIAL ['REGISTRY_MISSING']
//   registry no  + no hooks               => NOT_ONBOARDED
//   registry yes + bridge not configured  => PARTIAL ['BRIDGE_NOT_CONFIGURED']
//   registry yes + hook report ready      => READY
//   registry yes + hook report risks      => PARTIAL [risks...]
export function deriveReadiness({ registryFound, hook, bridgeConfigured = true } = {}) {
  if (!registryFound) {
    const hooksPresent = hook && hook.checkable && hook.ok && Array.isArray(hook.events) && hook.events.some((e) => e.exists);
    return hooksPresent
      ? { readiness: READY_CODES.PARTIAL, reasons: ['REGISTRY_MISSING'] }
      : { readiness: READY_CODES.NOT_ONBOARDED, reasons: [] };
  }
  if (!bridgeConfigured) return { readiness: READY_CODES.PARTIAL, reasons: ['BRIDGE_NOT_CONFIGURED'] };
  if (!hook || !hook.checkable) return { readiness: READY_CODES.PARTIAL, reasons: ['WORKTREE_REQUIRED'] };
  if (!hook.ok) return { readiness: READY_CODES.PARTIAL, reasons: [hook.reason || 'HOOK_CHECK_FAILED'] };
  if (hook.ready) return { readiness: READY_CODES.READY, reasons: [] };
  return { readiness: READY_CODES.PARTIAL, reasons: Array.isArray(hook.risks) ? hook.risks : ['HOOKS_UNKNOWN'] };
}


// ---- subcommands ------------------------------------------------------------

// subStatus: registry lookup + optional hook state + derived readiness.
export async function subStatus({ manifest, manifestPath, registryPath, registryModulePath, worktreePath, bridgeHome, env = process.env } = {}) {
  const ml = loadManifestFromPath(manifestPath || (manifest && manifest.path));
  if (!ml.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: ml.reason };
  const m = manifest || ml.manifest;
  const rp = resolveRegistryPath({ registryPath, env });
  if (!rp.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rp.reason };
  let found = false;
  let e = null;
  if (fs.existsSync(rp.path)) {
    const rmm = resolveRegistryModule({ registryModulePath, env });
    if (!rmm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rmm.reason, tried: rmm.tried };
    const rm = await loadRegistryModule(rmm.url);
    if (!rm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rm.reason };
    const reg = rm.mod.loadRegistry({ registryPath: rp.path });
    e = entryFor(reg, m.projectId);
    found = Boolean(e);
  }
  const hook = worktreePath ? await hookStatus({ worktreePath, bridgeHome, env }) : { checkable: false, reason: 'WORKTREE_REQUIRED' };
  const ready = deriveReadiness({ registryFound: found, hook });
  const idFields = e
    ? { projectId: e.projectId, repository: e.repository, workspaceId: e.workspace && e.workspace.workspaceId, route: e.telegram && e.telegram.route, policyVersion: e.policy && e.policy.version }
    : { projectId: m.projectId, repository: m.repository };
  return {
    ok: true, code: FAIL_CODES.OK, found, ...idFields, registryPath: rp.path,
    hook, readiness: ready.readiness, reasons: ready.reasons,
  };
}

// subRegister: registry-only onboard (idempotent). No hook deployment.
export async function subRegister({ manifest, manifestPath, registryPath, registryModulePath, actualRemote, worktreePath, env = process.env, actor = ACTOR_DEFAULT } = {}) {
  const ml = loadManifestFromPath(manifestPath || (manifest && manifest.path));
  if (!ml.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: ml.reason };
  const m = manifest || ml.manifest;
  const rp = resolveRegistryPath({ registryPath, env });
  if (!rp.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rp.reason };
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
  return { ok: true, code: FAIL_CODES.OK, action: 'onboarded', projectId: m.projectId, registryPath: rp.path, registryModulePath: rmm.path, entry: r.registry && entryFor(r.registry, m.projectId) };
}

// subOnboard: full onboard = register + install hooks. Transaction per design:
// register succeeds + hook install fails -> registry REMAINS registered, action=partial.
export async function subOnboard({ manifest, manifestPath, registryPath, registryModulePath, actualRemote, worktreePath, bridgeHome, env = process.env, actor = ACTOR_DEFAULT } = {}) {
  const reg = await subRegister({ manifest, manifestPath, registryPath, registryModulePath, actualRemote, worktreePath, env, actor });
  if (!reg.ok) return reg;
  const hook = await installHooks({ worktreePath, bridgeHome, env });
  const status = worktreePath ? await hookStatus({ worktreePath, bridgeHome, env }) : { checkable: false, reason: 'WORKTREE_REQUIRED' };
  const ready = deriveReadiness({ registryFound: true, hook: status });
  const action = ready.readiness === READY_CODES.READY ? reg.action : 'partial';
  return {
    ok: true, code: FAIL_CODES.OK, action,
    projectId: reg.projectId, registryPath: reg.registryPath, registryModulePath: reg.registryModulePath,
    hook, readiness: ready.readiness, reasons: ready.reasons,
  };
}


// subRepair: force re-register + repair hooks. Deterministic convergence to READY.
export async function subRepair({ manifest, manifestPath, registryPath, registryModulePath, actualRemote, worktreePath, bridgeHome, env = process.env, actor = ACTOR_DEFAULT } = {}) {
  const ml = loadManifestFromPath(manifestPath || (manifest && manifest.path));
  if (!ml.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: ml.reason };
  const m = manifest || ml.manifest;
  const rp = resolveRegistryPath({ registryPath, env });
  if (!rp.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rp.reason };
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
  const hook = await installHooks({ worktreePath, bridgeHome, env });
  const status = worktreePath ? await hookStatus({ worktreePath, bridgeHome, env }) : { checkable: false, reason: 'WORKTREE_REQUIRED' };
  const ready = deriveReadiness({ registryFound: true, hook: status });
  const action = ready.readiness === READY_CODES.READY ? 'repaired' : 'partial';
  return {
    ok: true, code: FAIL_CODES.OK, action,
    projectId: m.projectId, registryPath: rp.path, registryModulePath: rmm.path,
    hook, readiness: ready.readiness, reasons: ready.reasons,
  };
}

// subOffboard: remove bridge-owned hooks (best-effort) then unregister. Registry is authoritative:
// even if the bridge is not configured, the registry entry is still removed.
export async function subOffboard({ manifest, manifestPath, registryPath, registryModulePath, worktreePath, bridgeHome, env = process.env, actor = ACTOR_DEFAULT } = {}) {
  const ml = loadManifestFromPath(manifestPath || (manifest && manifest.path));
  if (!ml.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: ml.reason };
  const m = manifest || ml.manifest;
  const rp = resolveRegistryPath({ registryPath, env });
  if (!rp.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rp.reason };
  const hook = worktreePath ? await removeHooks({ worktreePath, bridgeHome, env }) : { ok: false, reason: 'WORKTREE_REQUIRED' };
  const rmm = resolveRegistryModule({ registryModulePath, env });
  if (!rmm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rmm.reason, tried: rmm.tried };
  const rm = await loadRegistryModule(rmm.url);
  if (!rm.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: rm.reason };
  const reg = rm.mod.loadRegistry({ registryPath: rp.path });
  const r = rm.mod.removeProject({ projectId: m.projectId, registry: reg, registryPath: rp.path, actor });
  if (!r.ok) return { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: r.reason || 'REMOVE_FAILED', detail: r };
  return {
    ok: true, code: FAIL_CODES.OK,
    action: r.removed ? 'offboarded' : 'noop_not_found',
    projectId: m.projectId, registryPath: rp.path, registryModulePath: rmm.path,
    fingerprint: r.fingerprint || null, hook,
  };
}

// Hook-only subcommands: install / repair / update bridge-owned hooks into a worktree.
export async function subHookInstall({ worktreePath, bridgeHome, env = process.env, force = false } = {}) {
  const hook = await installHooks({ worktreePath, bridgeHome, env, force });
  if (!hook.ok) return { ok: false, code: FAIL_CODES.CONFIG_ERROR, message: hook.reason || 'HOOK_INSTALL_FAILED', hook };
  const status = await hookStatus({ worktreePath, bridgeHome, env });
  const ready = deriveReadiness({ registryFound: true, hook: status });
  return { ok: true, code: FAIL_CODES.OK, action: 'hook_' + hook.action, hook, readiness: ready.readiness, reasons: ready.reasons };
}

export async function subHookRepair(opts = {}) {
  return subHookInstall(opts);
}

export async function subHookUpdate(opts = {}) {
  return subHookInstall({ ...opts, force: true });
}


export const HELP = 'usage: node onboard.mjs <subcommand> [options]\n\nSubcommands:\n  status            registry + hook state + derived readiness (READY|PARTIAL|NOT_ONBOARDED)\n  register          registry-only onboarding (idempotent: noop if already present)\n  onboard           register + install bridge-owned hooks (idempotent; action=partial if hooks fail)\n  repair            force re-register + repair hooks (converges to READY)\n  offboard          remove bridge-owned hooks + unregister (idempotent)\n  hook install      install bridge-owned hooks into --worktree\n  hook repair       repair bridge-owned hooks in --worktree\n  hook update       force-rewrite bridge-owned hooks in --worktree (new template)\n  --help, -h        show this help\n\nOptions:\n  --manifest <path>         path to .agent/project.json (default: env.MANIFEST_PATH or ./agent/project.json)\n  --registry <path>         machine-local registry.json (default: env.AI_PR_REGISTRY_PATH or ~/.ai-pr-reviewer/registry.json)\n  --module <file-or-url>    path or file:// URL to project-registry.mjs (default: env.AI_PR_REGISTRY_MODULE or env.AI_PR_REVIEWER_HOME + /scripts/project-registry.mjs)\n  --remote <url>            explicit actualRemote (skips git lookup; required if not in a git worktree)\n  --worktree <path>         path to a git worktree; hooks go to <worktree>/.clinerules/hooks, remote read via git\n  --bridge-home <path>      cline-mem-bridge install dir (default: env.CLINE_MEM_BRIDGE_HOME, then ~/.ai-pr-reviewer/config.json)\n  --actor <name>            actor label for audit (default: shared-onboard)\n\nEnv vars (override defaults; flag overrides env):\n  AI_PR_REGISTRY_PATH       path to registry.json\n  AI_PR_REGISTRY_MODULE     path or file:// URL to project-registry.mjs\n  AI_PR_REVIEWER_HOME       dir containing scripts/project-registry.mjs\n  CLINE_MEM_BRIDGE_HOME     cline-mem-bridge install dir\n  AI_PR_BRIDGE_CONFIG       path to bridge config.json (default ~/.ai-pr-reviewer/config.json)\n  MANIFEST_PATH             default manifest location\n\nReadiness (DERIVED, never persisted):\n  registry + hooks valid    READY\n  registry + hooks invalid  PARTIAL [HOOKS_MISSING|HOOKS_STALE|HOOK_COLLISION|DUPLICATE_RISK|BRIDGE_NOT_CONFIGURED]\n  hooks only                PARTIAL [REGISTRY_MISSING]\n  neither                   NOT_ONBOARDED\n\nDiscovery order for the registry module (first hit wins): --module > AI_PR_REGISTRY_MODULE > AI_PR_REVIEWER_HOME/scripts/project-registry.mjs > ~/.cline/AI_PR_REVIEWER/scripts/project-registry.mjs\nBridge discovery order: --bridge-home > CLINE_MEM_BRIDGE_HOME > ~/.ai-pr-reviewer/config.json';

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
  // argv shape: [subcommand, ...flags] (caller strips node+script).
  // 'hook <verb>' is a two-word subcommand.
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
    bridgeHome: typeof flags['bridge-home'] === 'string' ? flags['bridge-home'] : undefined,
    actor: flags.actor || ACTOR_DEFAULT,
    env,
  };
  let r;
  try {
    switch (sub) {
      case 'status':   r = await subStatus(opts); break;
      case 'register': r = await subRegister(opts); break;
      case 'onboard':  r = await subOnboard(opts); break;
      case 'repair':   r = await subRepair(opts); break;
      case 'offboard': r = await subOffboard(opts); break;
      case 'hook': {
        const verb = argv[1];
        if (verb === 'install') r = await subHookInstall(opts);
        else if (verb === 'repair') r = await subHookRepair(opts);
        else if (verb === 'update') r = await subHookUpdate(opts);
        else r = { ok: false, code: FAIL_CODES.USER_ERROR, message: 'UNKNOWN_HOOK_VERB:' + verb };
        break;
      }
      default: r = { ok: false, code: FAIL_CODES.USER_ERROR, message: 'UNKNOWN_SUBCOMMAND:' + sub };
    }
  } catch (e) {
    r = { ok: false, code: FAIL_CODES.REGISTRY_ERROR, message: 'UNCAUGHT:' + ((e && e.message) || String(e)) };
  }
  return r;
}

