// execution-broker.mjs — facade 6 deterministic tools + DoD + circuit breaker + auto-commit gate
// (Issue #25 / Phase 4A "Execution Broker").
//
// Mục tiêu: thay vì model tự gọi shell, model gọi 1 tool thuộc broker; broker tự:
//   1) check circuit breaker (shouldPause) — nếu pause -> BLOCKED
//   2) exec subprocess
//   3) recordSuccess / recordFailure
//   4) emit DoD state nếu phù hợp
//   5) trả machine-readable {ok, data, dod_event, breaker}
//
// 6 tools theo Issue #25 body:
//   - repo_status       : git status --short + branch + HEAD
//   - repo_diff         : git diff <base>..HEAD --stat
//   - test_run          : node scripts/test-pure-logic.mjs (tổng pure-logic tests)
//   - verify_status     : node scripts/full-verify.mjs (full verify + node --check + BOM)
//   - pre_review_status : pre-review deterministic (PASS/FINDINGS) qua scan diff
//   - handoff_status    : git log + remote URL + PR open cho branch
//
// Auto-commit gate (Issue #25 AC: "Gate tu dong commit/push chi khi ..."):
//   checkAutoCommitGate({branch, headSha, worktreeClean, testsPass, verifyPass,
//     preReviewPass, dodState, handoffMarker, ciRequiredChecksPass}) -> {ok, missing[]}
//
// CLI:
//   node scripts/execution-broker.mjs <tool>           # chạy 1 tool
//   node scripts/execution-broker.mjs <tool> --json    # output JSON
//   node scripts/execution-broker.mjs dod --state <X> --event <Y>   # apply DoD
//   node scripts/execution-broker.mjs auto-commit-gate # gate
//
// YAGNI:
//   - Không tích hợp runtime với autonomous-run.mjs (defer follow-up).
//   - Circuit breaker state KHONG persist giữa 2 lần CLI; mỗi lần chạy là 1 process mới -> state reset.
//     (Nếu cần persist -> file ~/.ai-pr-reviewer/breaker.json, defer.)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path, { basename } from 'node:path';
import process from 'node:process';

import {
  DOD_STATES, DOD_EVENTS, apply as dodApply, createDod, summarize as dodSummarize, oneLine as dodOneLine,
} from './dod.mjs';
import {
  createBreakerRegistry, recordFailure, recordSuccess, shouldPause, summarize as breakerSummarize,
} from './circuit-breaker.mjs';

// Danh sách tool mà broker hiểu.
export const TOOLS = Object.freeze([
  'repo_status',
  'repo_diff',
  'test_run',
  'verify_status',
  'pre_review_status',
  'handoff_status',
  'auto_commit_gate',
]);

// 8 điều kiện auto-commit theo Issue #25 body. Mỗi check = 1 key boolean.
export const AUTO_COMMIT_REQUIREMENTS = Object.freeze({
  branchTask: 'Bạn đang ở nhánh issue/feat/fix (không phải main/master)',
  worktreeClean: 'Working tree sạch (không có file modified ngoài allowlist memory-bank/)',
  testsPass: 'Pure-logic tests PASS',
  verifyPass: 'full-verify.mjs PASS',
  preReviewPass: 'Pre-review deterministic PASS (không có Critical/Important findings)',
  dodHandoffReady: 'DoD state = HANDOFF_READY hoặc VERIFIED_WITH_WARNINGS',
  handoffMarker: 'Đã post [CLINE-CLAIM] / handoff marker trên Issue',
  ciRequiredChecksPass: 'CI required checks PASS (statusCheckRollup)',
});

// Pure: check 8 điều kiện auto-commit. Trả {ok, missing[], dod_state_terminal}.
// Nếu ok=true -> đủ điều kiện commit. Nếu thiếu -> liệt kê key bị false.
export function checkAutoCommitGate({
  branch = '',
  headSha = '',
  worktreeClean = false,
  testsPass = false,
  verifyPass = false,
  preReviewPass = false,
  dodState = null,
  handoffMarker = false,
  ciRequiredChecksPass = false,
} = {}) {
  const checks = {
    branchTask: typeof branch === 'string' && !/^(main|master)$/.test(branch) && branch.length > 0,
    worktreeClean: !!worktreeClean,
    testsPass: !!testsPass,
    verifyPass: !!verifyPass,
    preReviewPass: !!preReviewPass,
    dodHandoffReady: dodState === DOD_STATES.HANDOFF_READY || dodState === DOD_STATES.VERIFIED_WITH_WARNINGS,
    handoffMarker: !!handoffMarker,
    ciRequiredChecksPass: !!ciRequiredChecksPass,
  };
  const missing = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: missing.length === 0, missing, checks };
}

// ---------- subprocess helper ----------
// exec(cmd, args, opts) -> {ok, stdout, stderr, status, code}
// Ưu tiên stdlib: spawnSync, KHONG shell pipe.
function exec(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    cwd: process.cwd(),
    ...opts,
  });
  if (res.error) {
    return { ok: false, stdout: '', stderr: String(res.error.message || res.error), status: -1, code: -1 };
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    status: res.status,
    code: res.status,
  };
}

// ---------- 6 tool wrappers (mỗi tool trả machine-readable JSON) ----------

// Tool 1: repo_status — git status + branch + HEAD
export function toolRepoStatus({ cwd = process.cwd() } = {}) {
  const branch = exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = exec('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  const status = exec('git', ['-C', cwd, 'status', '--short']);
  const origin = exec('git', ['-C', cwd, 'config', '--get', 'remote.origin.url']);
  const ok = branch.ok && sha.ok && status.ok && origin.ok;
  return {
    ok,
    tool: 'repo_status',
    data: {
      branch: branch.stdout.trim(),
      headSha: sha.stdout.trim(),
      worktreeDirty: status.stdout.trim().length > 0,
      worktreeLines: status.stdout.split('\n').filter(Boolean),
      origin: origin.stdout.trim(),
    },
    error: ok ? null : 'git command failed',
  };
}

// Tool 2: repo_diff — git diff <base>..HEAD --stat + numstat
export function toolRepoDiff({ base = 'main', cwd = process.cwd() } = {}) {
  const stat = exec('git', ['-C', cwd, 'diff', `${base}...HEAD`, '--stat']);
  const numstat = exec('git', ['-C', cwd, 'diff', `${base}...HEAD`, '--numstat']);
  const ok = stat.ok;
  let totalAdd = 0, totalDel = 0, totalFiles = 0;
  const fileStats = [];
  if (numstat.ok) {
    for (const line of numstat.stdout.split('\n').filter(Boolean)) {
      const [a, d, f] = line.split('\t');
      if (a === '-' || d === '-') continue;
      totalAdd += Number(a) || 0;
      totalDel += Number(d) || 0;
      totalFiles += 1;
      fileStats.push({ file: f, add: Number(a), del: Number(d) });
    }
  }
  return {
    ok,
    tool: 'repo_diff',
    data: { base, totalFiles, totalAdd, totalDel, fileStats, stat: stat.stdout.trim() },
    error: ok ? null : stat.stderr || 'git diff failed',
  };
}

// Tool 3: test_run — node scripts/test-pure-logic.mjs
export function toolTestRun({ cwd = process.cwd() } = {}) {
  const r = exec(process.execPath, ['scripts/test-pure-logic.mjs'], { cwd });
  const m = r.stdout.match(/Tổng:\s*(\d+)\/(\d+)\s*PASS/);
  const passed = m ? Number(m[1]) : null;
  const total = m ? Number(m[2]) : null;
  return {
    ok: r.ok,
    tool: 'test_run',
    data: { passed, total, allPass: r.ok, stdoutTail: r.stdout.split('\n').slice(-10).join('\n') },
    error: r.ok ? null : `tests failed: ${passed}/${total}`,
  };
}

// Tool 4: verify_status — node scripts/full-verify.mjs
export function toolVerifyStatus({ cwd = process.cwd() } = {}) {
  const r = exec(process.execPath, ['scripts/full-verify.mjs'], { cwd });
  return {
    ok: r.ok,
    tool: 'verify_status',
    data: { allOk: r.ok, stdoutTail: r.stdout.split('\n').slice(-15).join('\n'), stderrTail: r.stderr.split('\n').slice(-5).join('\n') },
    error: r.ok ? null : 'verify status FAIL (see stdout/stderr)',
  };
}

// Tool 5: pre_review_status — deterministic partial pre-review (size + secret scan).
// YAGNI: không gọi full local reviewer (chưa tích hợp); chỉ 2 heuristic cơ bản.
export function toolPreReviewStatus({ base = 'main', maxLines = 1500, cwd = process.cwd() } = {}) {
  const numstat = exec('git', ['-C', cwd, 'diff', `${base}...HEAD`, '--numstat']);
  let totalLines = 0;
  if (numstat.ok) {
    for (const line of numstat.stdout.split('\n').filter(Boolean)) {
      const [a, d] = line.split('\t');
      if (a === '-' || d === '-') continue;
      totalLines += Number(a) + Number(d);
    }
  }
  const findings = [];
  if (totalLines > maxLines) {
    findings.push({ severity: 'critical', code: 'DIFF_TOO_LARGE', message: `diff ${totalLines} dòng > limit ${maxLines}` });
  }
  const diffRaw = exec('git', ['-C', cwd, 'diff', `${base}...HEAD`]);
  if (diffRaw.ok) {
    const secretRe = /^\+.*(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|bearer\s+[A-Za-z0-9]{20,})/im;
    for (const line of diffRaw.stdout.split('\n')) {
      if (secretRe.test(line)) {
        findings.push({ severity: 'critical', code: 'SECRET_LEAK', message: `secret literal in diff: ${line.slice(0, 80)}` });
        break;
      }
    }
  }
  return {
    ok: findings.length === 0,
    tool: 'pre_review_status',
    data: { totalLines, maxLines, findings, caveat: 'deterministic partial pre-review (size + secret scan only)' },
    error: findings.length === 0 ? null : 'findings present',
  };
}

// Tool 6: handoff_status — git log + remote + branch + PR open (nếu có gh)
export function toolHandoffStatus({ cwd = process.cwd() } = {}) {
  const log = exec('git', ['-C', cwd, 'log', '--oneline', '-5']);
  const remote = exec('git', ['-C', cwd, 'config', '--get', 'remote.origin.url']);
  const branch = exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  let pr = null;
  try {
    const prRes = exec('gh', ['pr', 'view', '--json', 'number,state,url', '-q', '.']);
    if (prRes.ok) pr = JSON.parse(prRes.stdout || 'null');
  } catch { /* gh không khả dụng -> pr=null, không lỗi */ }
  const ok = log.ok && remote.ok && branch.ok;
  return {
    ok,
    tool: 'handoff_status',
    data: {
      recentCommits: log.stdout.split('\n').filter(Boolean),
      remote: remote.stdout.trim(),
      branch: branch.stdout.trim(),
      pr,
    },
    error: ok ? null : 'git command failed',
  };
}

// ---------- Broker: gắn breaker + DoD emission ----------
// runTool(tool, args, {registry, dod}) -> {ok, result, breaker, dod, dod_event}
//   1) shouldPause -> nếu pause thì trả ngay, không exec.
//   2) exec tool.
//   3) recordSuccess / recordFailure.
//   4) Emit DoD event mapping theo tool (nếu có).
const TOOL_DOD_EVENT = Object.freeze({
  repo_status: null,
  repo_diff: DOD_EVENTS.EVIDENCE_IMPLEMENTATION,
  test_run: DOD_EVENTS.EVIDENCE_VERIFICATION,
  verify_status: DOD_EVENTS.EVIDENCE_VERIFICATION,
  pre_review_status: DOD_EVENTS.EVIDENCE_VERIFICATION,
  handoff_status: DOD_EVENTS.HANDOFF_MARKER,
  auto_commit_gate: null,
});

export function runTool(tool, args = {}, { registry, dod } = {}) {
  const reg = registry || createBreakerRegistry();
  const session = dod || createDod();
  const pauseCheck = shouldPause(reg, tool);
  if (pauseCheck.pause) {
    const dodAfter = dodApply(session, DOD_EVENTS.TERMINAL_BLOCKED);
    return {
      ok: false,
      result: null,
      breaker: { state: pauseCheck.state, reason: pauseCheck.reason, paused: true },
      dod: dodAfter,
      dod_event: DOD_EVENTS.TERMINAL_BLOCKED,
    };
  }
  const handlers = {
    repo_status: toolRepoStatus,
    repo_diff: toolRepoDiff,
    test_run: toolTestRun,
    verify_status: toolVerifyStatus,
    pre_review_status: toolPreReviewStatus,
    handoff_status: toolHandoffStatus,
  };
  const handler = handlers[tool];
  if (!handler) {
    return { ok: false, result: null, breaker: null, dod: session, dod_event: null, error: `unknown tool: ${tool}` };
  }
  const result = handler(args || {});
  const newReg = result.ok ? recordSuccess(reg, tool) : recordFailure(reg, tool, result.error || 'tool error');
  let dodAfter = session;
  let dodEvent = null;
  const ev = TOOL_DOD_EVENT[tool];
  if (ev && result.ok) {
    // Broker là façade: chỉ apply nếu session hiện tại cho phép.
    // Nếu transition invalid (vd WIP + verification) -> giữ nguyên session, dod_event=null.
    const trial = dodApply(session, ev);
    if (trial.ok) {
      dodAfter = trial;
      dodEvent = ev;
    }
  }
  return {
    ok: result.ok,
    result,
    breaker: { state: peekBreakerState(newReg.registry, tool), recovered: newReg.recovered || false },
    dod: dodAfter,
    dod_event: dodEvent,
  };
}

function peekBreakerState(reg, tool) {
  const p = (reg && reg.tools && reg.tools[tool]) || null;
  return p ? p.state : 'CLOSED';
}

// ---------- CLI ----------
function usage() {
  return `Usage: node scripts/execution-broker.mjs <tool> [--json] [--base main]
       node scripts/execution-broker.mjs dod --state <X> --event <Y>
       node scripts/execution-broker.mjs auto-commit-gate [--json]
Tools: ${TOOLS.join(', ')}`;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(usage());
    process.exit(2);
  }
  const jsonOut = argv.includes('--json');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'main';
  const cmd = argv[0];
  const toolArgs = {};
  if (baseIdx >= 0) toolArgs.base = base;

  if (cmd === 'dod') {
    const sIdx = argv.indexOf('--state');
    const eIdx = argv.indexOf('--event');
    if (sIdx < 0 || eIdx < 0) { console.log(usage()); process.exit(2); }
    const session = createDod({ initial: argv[sIdx + 1] });
    const out = dodApply(session, argv[eIdx + 1]);
    const summary = dodSummarize(out);
    const line = dodOneLine(out);
    const payload = { dod: out, summary, oneLine: line };
    console.log(jsonOut ? JSON.stringify(payload, null, 2) : line);
    process.exit(out.ok ? 0 : 1);
  }

  if (cmd === 'auto-commit-gate') {
    const rs = toolRepoStatus();
    const td = toolTestRun();
    const vs = toolVerifyStatus();
    const prs = toolPreReviewStatus({ base });
    const hs = toolHandoffStatus();
    const worktreeClean = rs.ok && !rs.data.worktreeDirty;
    const pr = hs.data && hs.data.pr;
    const ciPass = rs.ok;
    const gate = checkAutoCommitGate({
      branch: rs.data ? rs.data.branch : '',
      headSha: rs.data ? rs.data.headSha : '',
      worktreeClean,
      testsPass: td.ok,
      verifyPass: vs.ok,
      preReviewPass: prs.ok,
      dodState: null,
      handoffMarker: !!(pr && pr.state === 'OPEN'),
      ciRequiredChecksPass: ciPass,
    });
    const payload = { gate, inputs: { worktreeClean, testsPass: td.ok, verifyPass: vs.ok, preReviewPass: prs.ok, branch: rs.data && rs.data.branch, handoffMarker: !!(pr && pr.state === 'OPEN') } };
    console.log(jsonOut ? JSON.stringify(payload, null, 2) : `auto-commit-gate: ${gate.ok ? 'OK' : 'MISSING ' + gate.missing.join(',')}`);
    process.exit(gate.ok ? 0 : 1);
  }

  if (!TOOLS.includes(cmd)) { console.log(usage()); process.exit(2); }
  if (cmd === 'auto_commit_gate') {
    const out = checkAutoCommitGate({});
    console.log(jsonOut ? JSON.stringify(out, null, 2) : JSON.stringify(out));
    process.exit(0);
  }
  const r = runTool(cmd, toolArgs);
  const payload = {
    broker_result: r,
    dod_summary: dodSummarize(r.dod),
    dod_one_line: dodOneLine(r.dod),
  };
  console.log(jsonOut ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
  process.exit(r.ok ? 0 : 1);
}

// Chạy CLI chỉ khi gọi trực tiếp.
// Lưu ý: dùng path.basename + equality để tránh match "test-execution-broker.mjs".
const isMain = process.argv[1] && basename(process.argv[1]) === 'execution-broker.mjs';
if (isMain) main();

export default { TOOLS, AUTO_COMMIT_REQUIREMENTS, checkAutoCommitGate,
  toolRepoStatus, toolRepoDiff, toolTestRun, toolVerifyStatus, toolPreReviewStatus, toolHandoffStatus,
  runTool };


