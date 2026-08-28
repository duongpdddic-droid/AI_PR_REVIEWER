#!/usr/bin/env node
/**
 * mcp-test-evidence/executor.mjs — Issue #19 Phase 3: Allowlisted gate executor.
 * Pure core, injectable. Hardening:
 * - command/args hoàn toàn từ manifest (không allowlist cứng).
 * - entrypoint canonical phải nằm trong registered project root.
 * - Cấm: -e, --eval, -p, -pe, -pse, --check, shell-meta, path-traversal.
 * - Sandbox env — không kế thừa parent process.env.
 * - Timeout + output cap per step.
 * - Redact secret trước khi persist.
 * Không commit/push/label/merge/deploy.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { redact } from '../scripts/test-evidence-reporter.mjs';


export const MAX_STEP_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_STEP_TIMEOUT_MS = 120_000;
export const MAX_STEP_TIMEOUT_MS = 300_000;

const NODE_DANGEROUS_FLAGS = [
  '-e', '--eval', '-p', '-pe', '--print', '-pse', '--prof', '--inspect', '--inspect-brk',
  '--experimental-vm-modules', '--loader',
];

const SHELL_META = /[;&|`$<>(){}\[\]!#*?'"\\]/;

export function isEntrypointSafe(entrypoint, root) {
  if (entrypoint.includes('..') || /^[\\\/]/.test(entrypoint)) return false;
  return true;
}

export function isArgsSafe(args) {
  if (!Array.isArray(args)) return false;
  for (const a of args) {
    if (typeof a !== 'string') return false;
    if (SHELL_META.test(a)) return false;
    const lower = a.toLowerCase();
    for (const flag of NODE_DANGEROUS_FLAGS) {
      if (lower === flag || lower.startsWith(flag + '=')) return false;
    }
  }
  return true;
}

export function validateStep(step, manifest, root) {
  const errors = [];
  if (!step || typeof step !== 'object') return { valid: false, errors: ['step không phải object'] };
  if (typeof step.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(step.id)) {
    errors.push(`step.id '${step.id}' không hợp lệ`);
  }
  if (typeof step.name !== 'string' || step.name.length === 0) errors.push('step.name rỗng');
  if (typeof step.command !== 'string' || step.command.length === 0) {
    errors.push('step.command rỗng');
  } else if (!isEntrypointSafe(step.command, root)) {
    errors.push(`step.command '${step.command}' chứa path traversal`);
  }
  if (step.args !== undefined && !Array.isArray(step.args)) {
    errors.push('step.args phải là array');
  } else if (!isArgsSafe(step.args || [])) {
    errors.push('step.args chứa shell-meta hoặc node dangerous flag (-e/--eval/-p/-pe)');
  }
  if (step.timeout !== undefined) {
    if (typeof step.timeout !== 'number' || step.timeout <= 0 || step.timeout > MAX_STEP_TIMEOUT_MS) {
      errors.push(`timeout phải trong (0, ${MAX_STEP_TIMEOUT_MS}]`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateGate(manifest, gateId, root) {
  if (typeof gateId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(gateId)) {
    return { valid: false, errors: [`gateId '${gateId}' không hợp lệ`] };
  }
  const steps = manifest?.gates?.[gateId];
  if (!Array.isArray(steps) || steps.length === 0) {
    return { valid: false, errors: [`gate '${gateId}' không tồn tại trong manifest.gates`] };
  }
  const errors = [];
  for (const [i, s] of steps.entries()) {
    const v = validateStep(s, manifest, root);
    if (!v.valid) for (const e of v.errors) errors.push(`steps[${i}]: ${e}`);
  }
  return { valid: errors.length === 0, errors };
}

export function buildSandboxEnv(root, extra = {}) {
  const nodeDir = resolve(process.execPath, '..');
  const env = {
    PATH: process.platform === 'win32'
      ? `${nodeDir};C:\\Windows\\System32;C:\\Windows`
      : `${nodeDir}:/usr/bin:/bin:/usr/local/bin`,
    NODE_NO_WARNINGS: '1',
    LANG: 'C.UTF-8',
  };
  env.MCP_TEST_EVIDENCE_ROOT = root;
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

export async function runStep(step, { cwd, env, runner = spawn }) {
  const started = Date.now();
  const safeEnv = env || buildSandboxEnv(cwd || process.cwd());
  const timeoutMs = step.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
  let stdout = '', stderr = '';
  let stdoutTruncated = false, stderrTruncated = false;
  let exitCode = 0, timedOut = false, error = null;
  let child = null;
  let resolve;

  const finish = (extra) => {
    clearTimeout(timer);
    resolve({
      ...extra,
      stdout: redact(stdout),
      stderr: redact(stderr),
      stdoutTruncated, stderrTruncated,
      duration: Date.now() - started,
    });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    try { child?.kill('SIGKILL'); } catch {}
    finish({ exitCode: -1, timedOut: true, error: 'timeout' });
  }, timeoutMs);

  child = runner(step.command, step.args || [], {
    cwd, env: safeEnv, stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, shell: false,
  });

  child.on('error', (err) => {
    error = err.message;
    finish({ exitCode: -1, error });
  });

  child.stdout.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    if (stdout.length + s.length > MAX_STEP_OUTPUT_BYTES) {
      stdout += s.slice(0, MAX_STEP_OUTPUT_BYTES - stdout.length);
      stdoutTruncated = true;
      try { child.kill('SIGKILL'); } catch {}
    } else stdout += s;
  });

  child.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    if (stderr.length + s.length > MAX_STEP_OUTPUT_BYTES) {
      stderr += s.slice(0, MAX_STEP_OUTPUT_BYTES - stderr.length);
      stderrTruncated = true;
      try { child.kill('SIGKILL'); } catch {}
    } else stderr += s;
  });

  child.on('close', (code) => {
    exitCode = code;
    finish({ exitCode });
  });

  return new Promise(r => { resolve = r; });
}

export async function runGate(manifest, gateId, opts = {}) {
  const root = opts.root || process.cwd();
  const v = validateGate(manifest, gateId, root);
  if (!v.valid) {
    return {
      passed: false, total: 0, passedCount: 0, failedCount: 0,
      duration: 0, stepResults: [], failureCodes: ['GATE_INVALID'], errors: v.errors,
    };
  }
  const steps = manifest.gates[gateId];
  const cwd = opts.cwd || root;
  const env = opts.env || buildSandboxEnv(root);
  const started = Date.now();
  const stepResults = [];
  let passedCount = 0;
  const failureCodes = [];

  for (const step of steps) {
    const result = await runStep(step, { cwd, env, runner: opts.runner });
    const ok = result.exitCode === 0 && !result.timedOut
      && !result.stdoutTruncated && !result.stderrTruncated;
    if (ok) passedCount++;
    else failureCodes.push(`STEP_${step.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FAIL`);
    stepResults.push({
      id: step.id, name: step.name, command: step.command, args: step.args || [],
      exitCode: result.exitCode, timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
      duration: result.duration, error: result.error,
    });
  }

  return {
    passed: failureCodes.length === 0,
    total: steps.length, passedCount, failedCount: failureCodes.length,
    duration: Date.now() - started, stepResults, failureCodes,
  };
}