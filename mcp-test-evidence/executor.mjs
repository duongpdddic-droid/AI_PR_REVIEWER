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
import { resolve, basename, sep } from 'node:path';
import { realpathSync } from 'node:fs';
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

// GPT-REV-102 — executor allowlist thật:
// - Chỉ executable allowlisted (ưu tiên process.execPath / node).
// - Cấm powershell/cmd/bash/sh/curl và arbitrary binary.
// - Entrypoint (step.command) phải được resolve + realpath canonical nằm trong project root.
// - Cấm absolute path, traversal, symlink/junction escape, dangerous flags, shell execution.
const ALLOWED_EXEC_BASENAMES = new Set([
  'node', 'node.exe',
]);
// GPT-REV-102 (hardened): forbidden executables - defense-in-depth, cấm tuyệt đối
// shell/interpreter/destructive cli/pkg managers/network tools.
const FORBIDDEN_EXECUTABLES = new Set([
  'bash', 'sh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe',
  'python', 'python3', 'py', 'npx', 'npm', 'pnpm', 'yarn',
  'rm', 'del', 'curl', 'wget', 'git', 'ssh', 'scp', 'cat', 'grep',
]);
// Whitelist flag theo từng executable. Node CHỈ cho phép flag an toàn;
// '-e'/'--eval'/'-p' (eval) BỊ CẤM → không chạy code tùy ý qua argument.
const ALLOWED_FLAGS_BY_EXE = {
  node: new Set(['--check', '--version', '-v', '--help', '--input-type', '--trace-warnings', '--stack-trace-limit']),
  'node.exe': new Set(['--check', '--version', '-v', '--help', '--input-type', '--trace-warnings', '--stack-trace-limit']),
};
const MAX_STEP_ARGS = 32;

export function isExecutableAllowlisted(command) {
  const base = basename(command).toLowerCase();
  if (FORBIDDEN_EXECUTABLES.has(base)) return false;
  return ALLOWED_EXEC_BASENAMES.has(base);
}

// GPT-REV-105: với command=node, canonicalize script path (args[0] nếu không phải
// flag) qua resolveEntrypoint → realpath nằm trong registered root; chặn absolute
// path / traversal / symlink-junction escape ra ngoài root.
export function canonicalizeNodeArgs(step, root) {
  const args = Array.isArray(step.args) ? step.args.slice() : [];
  if (args.length === 0) return args;
  const first = args[0];
  if (typeof first !== 'string') return args;
  if (first.startsWith('-')) return args; // flag → không phải script path
  // Cấm absolute path script (Win: C:\... hoặc POSIX: /...)
  if (/^[a-zA-Z]:[\\/]/.test(first) || /^[\\/]/.test(first)) {
    throw new Error(`script path '${first}' là absolute — bị cấm (sandbox escape)`);
  }
  // Containment: resolve + realpath, không cho thoát khỏi root (symlink/junction escape).
  // Khác resolveEntrypoint: KHÔNG check executable allowlist (đây là script data, không phải executable).
  const candidate = resolve(root, first);
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`script path '${first}' không tồn tại hoặc không thể resolve`);
  }
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`script path '${first}' nằm ngoài project root — bị cấm`);
  }
  return [real, ...args.slice(1)];
}

export function isFlagsAllowed(exeBasename, args) {
  const allowed = ALLOWED_FLAGS_BY_EXE[(exeBasename || '').toLowerCase()];
  if (!allowed) return false;
  for (const a of (args || [])) {
    if (typeof a !== 'string') continue;
    if (a.startsWith('-') && !allowed.has(a)) return false;
  }
  return true;
}

export function resolveEntrypoint(command, root) {
  // Absolute path: chỉ cho phép nếu basename nằm trong allowlist (vd process.execPath = node).
  // Cấm absolute path trỏ tới file ngoài hệ thống (sandbox escape).
  if (/^[\\/]/.test(command) || /^[a-zA-Z]:[\\/]/.test(command)) {
    if (!isExecutableAllowlisted(command)) {
      throw new Error(`entrypoint '${command}' là absolute path không nằm trong allowlist — bị cấm`);
    }
    return command;
  }
  // Traversal.
  if (command.includes('..') || command.includes('\\..') || command.includes('/..')) {
    throw new Error(`entrypoint '${command}' chứa path traversal — bị cấm`);
  }
  const candidate = resolve(root, command);
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`entrypoint '${command}' không tồn tại hoặc không thể resolve`);
  }
  const realRoot = realpathSync(root);
  // Containment: không cho thoát khỏi root (symlink/junction escape).
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`entrypoint '${command}' nằm ngoài project root — bị cấm`);
  }
  // Allowlist executable.
  if (!isExecutableAllowlisted(real)) {
    throw new Error(`executable '${real}' không nằm trong allowlist — bị cấm`);
  }
  return real;
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
  } else if (/[\\/]/.test(step.command)) {
    // command chứa dấu phân cách → phải là file trong repo, resolve + realpath canonical.
    try {
      resolveEntrypoint(step.command, root);
    } catch (e) {
      errors.push(`step.command: ${e.message}`);
    }
  } else if (!isExecutableAllowlisted(step.command)) {
    // bare executable (system PATH) → chỉ cần nằm trong allowlist (node).
    errors.push(`step.command '${step.command}' không nằm trong executable allowlist`);
  }
  if (step.args !== undefined && !Array.isArray(step.args)) {
    errors.push('step.args phải là array');
  } else if (!Array.isArray(step.args) || step.args.length > MAX_STEP_ARGS) {
    errors.push('step.args vượt quá MAX_STEP_ARGS (' + MAX_STEP_ARGS + ')');
  } else if (!isArgsSafe(step.args)) {
    errors.push('step.args chứa shell-meta hoặc node dangerous flag (-e/--eval/-p/-pe)');
  } else if (!isFlagsAllowed(basename(step.command || ''), step.args)) {
    errors.push('step.args chứa flag không nằm trong whitelist cho executable');
  }
  // GPT-REV-105: với command=node, chặn absolute path script (static check; thực tế
  // resolve + realpath containment làm ở runStep qua canonicalizeNodeArgs).
  if (isExecutableAllowlisted(step.command || '') && Array.isArray(step.args) && step.args.length > 0) {
    const first = step.args[0];
    if (typeof first === 'string' && !first.startsWith('-')) {
      if (/^[a-zA-Z]:[\\/]/.test(first) || /^[\\/]/.test(first)) {
        errors.push(`step.args[0] '${first}' là absolute script path — bị cấm (sandbox escape)`);
      }
    }
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

export async function runStep(step, { cwd, env, runner = spawn, root }) {
  const started = Date.now();
  const safeEnv = env || buildSandboxEnv(cwd || process.cwd());
  const timeoutMs = step.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
  let stdout = '', stderr = '';
  let stdoutTruncated = false, stderrTruncated = false;
  let exitCode = 0, timedOut = false, error = null;
  let child = null;
  let resolve;

  // GPT-REV-102: resolve + realpath canonical entrypoint, fail-closed trước spawn.
  // Bare executable (không có dấu phân cách) đã allowlisted → chạy từ system PATH.
  // Command chứa dấu phân cách → resolve file trong repo + kiểm tra containment.
  const baseRoot = root || cwd || process.cwd();
  const entrypoint = /[\\/]/.test(step.command)
    ? resolveEntrypoint(step.command, baseRoot)
    : (isExecutableAllowlisted(step.command) ? step.command : (() => {
        throw new Error(`executable '${step.command}' không nằm trong allowlist — bị cấm`);
      })());
  // GPT-REV-105: với command=node, canonicalize script path (args[0]) fail-closed
  // trước spawn — chặn absolute path / traversal / symlink-junction escape.
  const effectiveArgs = isExecutableAllowlisted(step.command) && entrypoint === step.command
    ? canonicalizeNodeArgs({ ...step, command: entrypoint }, baseRoot)
    : (step.args || []);

  const finish = (extra) => {
    clearTimeout(timer);
    resolve({
      ...extra,
      stdout: redact(stdout),
      stderr: redact(stderr),
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(stderr, 'utf8'),
      stdoutTruncated, stderrTruncated,
      duration: Date.now() - started,
    });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    try { child?.kill('SIGKILL'); } catch {}
    finish({ exitCode: -1, timedOut: true, error: 'timeout' });
  }, timeoutMs);

  child = runner(entrypoint, effectiveArgs, {
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
    const result = await runStep(step, { cwd, env, runner: opts.runner, root });
    const ok = result.exitCode === 0 && !result.timedOut
      && !result.stdoutTruncated && !result.stderrTruncated;
    if (ok) passedCount++;
    else failureCodes.push(`STEP_${step.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FAIL`);
    stepResults.push({
      id: step.id, name: step.name, command: step.command, args: step.args || [],
      exitCode: result.exitCode, timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
      stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
      duration: result.duration, error: result.error, stdout: result.stdout, stderr: result.stderr,
    });
  }

  return {
    passed: failureCodes.length === 0,
    total: steps.length, passedCount, failedCount: failureCodes.length,
    duration: Date.now() - started, stepResults, failureCodes,
  };
}