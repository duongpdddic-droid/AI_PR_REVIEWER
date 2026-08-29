#!/usr/bin/env node
// onboard.mjs - thin CLI shim. Delegates to ./project-onboard.mjs (pure logic).
// Sole job: parse argv, pass it to runOnboard, print JSON result, set exit code.
//
// Discovery: no hard-coded path. Resolves the project-registry module via
//   --module <path>  |  env.AI_PR_REGISTRY_MODULE  |  env.AI_PR_REVIEWER_HOME/scripts/project-registry.mjs
//   |  ~/.cline/AI_PR_REVIEWER/scripts/project-registry.mjs
//
// usage:
//   node onboard.mjs --help
//   node onboard.mjs status   --manifest .agent/project.json [--registry <path>] [--worktree <path>] [--bridge-home <dir>]
//   node onboard.mjs register --manifest .agent/project.json [--registry <path>] [--worktree <path>|--remote <url>]
//   node onboard.mjs onboard  --manifest .agent/project.json [--registry <path>] [--worktree <path>|--remote <url>] [--bridge-home <dir>]
//   node onboard.mjs repair   --manifest .agent/project.json [--registry <path>] [--worktree <path>|--remote <url>] [--bridge-home <dir>]
//   node onboard.mjs offboard --manifest .agent/project.json [--registry <path>] [--worktree <path>] [--bridge-home <dir>]
//   node onboard.mjs hook install|repair|update --worktree <path> [--bridge-home <dir>]
// Readiness is DERIVED (never persisted): registry+hooks READY / PARTIAL / NOT_ONBOARDED.
import { runOnboard, HELP } from './project-onboard.mjs';

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function err(obj) { process.stderr.write(JSON.stringify(obj) + '\n'); }

const argv = process.argv.slice(2); // strip node + script
runOnboard(argv, process.env).then((r) => {
  if (r.help) {
    process.stdout.write(HELP + '\n');
    out({ ok: true, code: 0, help: true });
    process.exit(0);
    return;
  }
  if (!r.ok) err(r);
  out(r);
  process.exit(r.code === undefined ? 0 : r.code);
}).catch((e) => {
  const r = { ok: false, code: 3, message: 'UNCAUGHT:' + ((e && e.message) || String(e)) };
  err(r); out(r);
  process.exit(3);
});
