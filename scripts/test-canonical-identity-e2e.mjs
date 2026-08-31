#!/usr/bin/env node
// test-canonical-identity-e2e.mjs — LIVE E2E cho Canonical Project Identity (Issue #18 AC).
// Clone thật AI_PR_REVIEWER + cline-auto-capture-e2e + Soc_brain vào session temp root
// (08-temp-hygiene: ownership marker + cleanup trong finally), resolver chạy git thật,
// negative isolation (project A không nhận observation của B). Clone fail -> SKIP, exit 0.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSessionManager, redactHome } from './temp-hygiene.mjs';
import {
  normalizeRemote, resolveCanonicalIdentity, resolveForCapture, resolveForRetrieval,
  redactIdentity, REASON,
} from './canonical-identity.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '..');
const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });
const falsyE = (name, got) => checks.push({ name, ok: !got, got });

const PROJECTS = [
  { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER', cwd: REPO_ROOT },
  { projectId: 'cline-e2e', repository: 'duongpdddic-droid/cline-auto-capture-e2e' },
  { projectId: 'soc-brain', repository: 'duongpdddic-droid/Soc_brain' },
];

const mgr = createSessionManager({ purpose: 'issue-18-live-e2e', projectRoot: REPO_ROOT });
const git = (args, cwd, opts = {}) => spawnSync('git', args, { encoding: 'utf8', cwd, ...opts });
const clones = {};
let cloneOk = true;
let skipped = false;

try {
  for (const p of PROJECTS) {
    if (p.cwd) continue;
    const parent = mgr.createDir('repos');
    const dir = path.join(parent, p.projectId.replace(/[^a-z0-9-]/gi, '-'));
    const r = git(['clone', '--depth', '1', `https://github.com/${p.repository}.git`, dir], REPO_ROOT, { timeout: 120000 });
    if (r.status !== 0) {
      console.log(`SKIP: clone ${p.repository} fail (${(r.stderr || r.stdout || '').trim().slice(0, 200)}) — offline?`);
      cloneOk = false;
      break;
    }
    clones[p.projectId] = dir;
  }
  if (!cloneOk) { console.log('canonical-identity e2e: SKIP (offline)'); skipped = true; } else {
    // Registry fixture từ remote THẬT của từng clone.
    const registry = { schemaVersion: '1.0', projects: [] };
    for (const p of PROJECTS) {
      const cwd = p.cwd || clones[p.projectId];
      const r = git(['remote', 'get-url', 'origin'], cwd);
      if (r.status !== 0) throw new Error(`không đọc remote ${p.projectId}`);
      registry.projects.push({ projectId: p.projectId, repository: normalizeRemote(r.stdout.trim()) });
    }
    const io = {
      exec: (args, opts) => {
        const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', cwd: opts.cwd });
        if (r.status !== 0) throw new Error((r.stderr || '').trim() || `exit ${r.status}`);
        return r.stdout;
      },
      fs,
    };

    // AC1: session gán đúng project theo cwd thật.
    for (const p of PROJECTS) {
      const cwd = p.cwd || clones[p.projectId];
      const res = resolveCanonicalIdentity({ registry, signals: { cwd }, io });
      eq(`E2E AC1 ${p.projectId} resolved`, res.status, 'resolved');
      eq(`E2E AC1 ${p.projectId} projectId`, res.projectId, p.projectId);
      falsyE(`E2E AC1 ${p.projectId} không quarantine`, res.quarantine);
    }

    // AC3: stale workspaceRoots[0] không thắng registry+remote+real cwd.
    {
      const res = resolveCanonicalIdentity({
        registry,
        signals: { cwd: REPO_ROOT, workspaceRoots: [path.join(os.tmpdir(), 'stale-non-existent-worktree')] },
        io,
      });
      eq('E2E AC3 stale ws0 -> resolved ai-pr-reviewer', res.projectId, 'ai-pr-reviewer');
      tru('E2E AC3 staleWorkspaceRoot flagged', res.resolved.staleWorkspaceRoot);
    }

    // AC5: event file thuộc sibling repo + cwd AI_PR_REVIEWER -> không leak.
    {
      const siblingFile = path.join(clones['cline-e2e'], 'README.md');
      const res = resolveCanonicalIdentity({ registry, signals: { cwd: REPO_ROOT, eventFile: siblingFile }, io });
      eq('E2E AC5 event sibling -> SIBLING_WORKTREE_LEAK', res.reason, REASON.SIBLING_WORKTREE_LEAK);
      tru('E2E AC5 quarantine', res.quarantine);
    }

    // AC9 negative: project A không nhận observation/artifact của B (live).
    {
      const cA = resolveForCapture({ registry, signals: { cwd: REPO_ROOT }, io });
      const cB = resolveForCapture({ registry, signals: { cwd: clones['cline-e2e'] }, io });
      tru('E2E AC9 capture A != B', cA.projectId !== cB.projectId);
      eq('E2E AC9 capture A = ai-pr-reviewer', cA.projectId, 'ai-pr-reviewer');
      eq('E2E AC9 capture B = cline-e2e', cB.projectId, 'cline-e2e');
      const leak = resolveForRetrieval({ registry, projectId: 'cline-e2e', signals: { cwd: REPO_ROOT }, io });
      falsyE('E2E AC9 retrieval B từ cwd A -> NOT allowed', leak.allowed);
      eq('E2E AC9 retrieval lệch -> IDENTITY_MISMATCH', leak.reason, REASON.IDENTITY_MISMATCH);
    }

    // Redact absolute home khỏi evidence.
    {
      const ev = redactIdentity({ sources: { cwd: REPO_ROOT } });
      const s = JSON.stringify(ev);
      tru('E2E redact home khỏi evidence', !s.includes(os.homedir()) || ev.sources.cwd.includes('~') || s.includes('<abs>'));
    }
  }
} finally {
  const clean = mgr.cleanup();
  if (clean.verdict !== 'POC_CLEANUP_PASS') {
    console.error(`E2E cleanup ${clean.verdict}: leftover=${JSON.stringify(clean.leftover)}`);
    process.exitCode = 1;
  }
}

if (skipped) process.exit(0);
let fail = 0;
for (const c of checks) {
  if (!c.ok) { fail++; console.log(`FAIL: ${c.name} | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`); }
}
console.log(`canonical-identity live E2E: ${checks.length - fail}/${checks.length} PASS (clones tại ${redactHome(mgr.homeDir)} đã dọn)`);
process.exit(fail ? 1 : 0);

