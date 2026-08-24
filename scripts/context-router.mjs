#!/usr/bin/env node
// context-router.mjs — Selective context loading (Issue #6 B1-B3).
// Bootstrap nho + module theo vai tro/task; global safety invariants LUON duoc tai;
// module thieu, version sai, routing khong xac dinh, vuot budget -> fail-closed BLOCKED_*.
// Core pure (inject io) de test; wrapper IO doc tu repo root.

import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_REL_PATH = 'scripts/context-manifest.json';

export class ContextRoutingError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

/** Doc + validate manifest routing. */
export function loadManifest(rootDir, relPath = MANIFEST_REL_PATH) {
  let raw;
  try { raw = fs.readFileSync(path.join(rootDir, relPath), 'utf8'); }
  catch (e) { throw new ContextRoutingError('BLOCKED_MANIFEST_UNAVAILABLE', `manifest khong doc duoc: ${relPath} — ${(e && e.message) || e}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new ContextRoutingError('BLOCKED_MANIFEST_INVALID', `manifest sai JSON: ${(e && e.message) || e}`); }
  const v = validateManifest(parsed);
  if (!v.ok) throw new ContextRoutingError('BLOCKED_MANIFEST_INVALID', v.error);
  return parsed;
}

/** Shape check toi thieu cho manifest. Tra {ok, error}. */
export function validateManifest(m) {
  if (!m || typeof m !== 'object') return { ok: false, error: 'manifest khong phai object' };
  if (!m.modules || typeof m.modules !== 'object') return { ok: false, error: 'thieu modules{}' };
  for (const [name, mod] of Object.entries(m.modules)) {
    if (!mod || typeof mod.path !== 'string' || !Number.isInteger(mod.version)) {
      return { ok: false, error: `module "${name}" thieu path(string)/version(int)` };
    }
  }
  if (!Array.isArray(m.invariants) || !m.invariants.length) return { ok: false, error: 'thieu invariants[]' };
  for (const inv of m.invariants) {
    if (!m.modules[inv]) return { ok: false, error: `invariant "${inv}" khong co trong modules{}` };
  }
  if (!m.routing || typeof m.routing !== 'object') return { ok: false, error: 'thieu routing{}' };
  for (const [task, list] of Object.entries(m.routing)) {
    if (!Array.isArray(list)) return { ok: false, error: `routing.${task} khong phai array` };
    for (const n of list) if (!m.modules[n]) return { ok: false, error: `routing.${task} tham chieu module khong ton tai: "${n}"` };
  }
  if (!m.budget || !Number.isInteger(m.budget.maxTokensPerTask) || m.budget.maxTokensPerTask <= 0) {
    return { ok: false, error: 'thieu budget.maxTokensPerTask (int > 0)' };
  }
  return { ok: true };
}

function moduleVersionFromContent(content) {
  const match = String(content).slice(0, 500).match(/module-version:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Pure: chon module cho task hien tai. Moi bat thuong -> ContextRoutingError BLOCKED_*.
 * @param {object} manifest manifest da validate
 * @param {{repo?: string|null, taskType: string}} input
 * @param {{root?: string, exists?: (p:string)=>boolean, readFile?: (p:string)=>string}} io inject cho test
 * @returns {{bootstrap: string, taskType: string, repo: string|null,
 *            modules: Array<{name,path,version,tokens}>, totalTokens: number}}
 */
export function routeContext(manifest, { repo = null, taskType }, io = {}) {
  const root = io.root || '.';
  const exists = io.exists || ((p) => fs.existsSync(p));
  const readFile = io.readFile || ((p) => fs.readFileSync(p, 'utf8'));

  if (!taskType || !manifest.routing[taskType]) {
    throw new ContextRoutingError('BLOCKED_TASK_TYPE_UNKNOWN',
      `taskType "${taskType}" khong co trong manifest.routing (${Object.keys(manifest.routing).join(', ')})`);
  }

  // invariants luon di dau; cong module cua task type.
  const wanted = [...new Set([...manifest.invariants, ...manifest.routing[taskType]])];

  // Module co appliesToRepos chi tu dong tai cho repo duoc khai bao.
  for (const [name, mod] of Object.entries(manifest.modules)) {
    if (Array.isArray(mod.appliesToRepos) && repo && mod.appliesToRepos.includes(repo) && !wanted.includes(name)) {
      wanted.push(name);
    }
  }

  const modules = [];
  let totalTokens = 0;
  for (const name of wanted) {
    const mod = manifest.modules[name];
    if (!mod) throw new ContextRoutingError('BLOCKED_MODULE_MISSING', `module "${name}" khong khai bao trong manifest.modules`);
    const abs = path.join(root, mod.path);
    if (!exists(abs)) {
      throw new ContextRoutingError('BLOCKED_MODULE_MISSING', `file module "${name}" khong ton tai: ${mod.path}`);
    }
    const content = readFile(abs);
    const fileVersion = moduleVersionFromContent(content);
    if (fileVersion === null) {
      throw new ContextRoutingError('BLOCKED_MODULE_INVALID', `module "${name}" thieu header "module-version: <int>" trong 500 ky tu dau`);
    }
    if (fileVersion !== mod.version) {
      throw new ContextRoutingError('BLOCKED_MODULE_VERSION_STALE',
        `module "${name}": file version ${fileVersion} != manifest ${mod.version} — stale module khong thang canonical version`);
    }
    const tokens = Math.ceil(String(content).length / 4);
    totalTokens += tokens;
    modules.push({ name, path: mod.path, version: fileVersion, tokens });
  }

  if (totalTokens > manifest.budget.maxTokensPerTask) {
    throw new ContextRoutingError('BLOCKED_BUDGET_EXCEEDED',
      `context ${totalTokens} tokens > budget ${manifest.budget.maxTokensPerTask}`);
  }

  return { bootstrap: manifest.bootstrap, taskType, repo, modules, totalTokens };
}
