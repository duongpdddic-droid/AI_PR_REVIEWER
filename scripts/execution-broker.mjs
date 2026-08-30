// execution-broker.mjs — facade 6 deterministic tools + DoD + circuit breaker + auto-commit gate
// (Issue #25 / Phase 4A "Execution Broker").
//
// Mục tiêu: thay vì model tự gọi shell, model gọi 1 tool thuộc broker; broker tự:
//   1) check circuit breaker (shouldPause) — nếu pause -> BLOCKED
//   2) exec subprocess
//   3) recordSuccess / recordFailure (persisted qua file ~/.ai-pr-reviewer/ breaker + DoD state)
//   4) emit DoD state nếu phù hợp (chỉ khi evidence canonical được tool xác minh)
//   5) trả machine-readable {ok, data, dod_event, breaker}
//   6) tất cả git/gh command khóa cwd/repo/branch/HEAD (Finding 4)
//
// 6 tools theo Issue #25 body:
//   - repo_status       : git status --short + branch + HEAD
//   - repo_diff         : git diff <base>..HEAD --stat
//   - test_run          : mandatory test gate (pnpm test: 4 suites)
//   - verify_status     : node scripts/full-verify.mjs (full verify + node --check + BOM)
//   - pre_review_status : pre-review deterministic (PASS/FINDINGS) qua scan diff
//   - handoff_status    : git log + remote URL + canonical marker check (Finding 3)
//
// Auto-commit gate (Issue #25 AC: "Gate tu dong commit/push chi khi ..."):
//   checkAutoCommitGate({branch, headSha, worktreeClean, testsPass, verifyPass,
//     preReviewPass, dodState, handoffMarker, ciRequiredChecksPass}) -> {ok, missing[]}
//   CLI thực hiện IO thật:
//     - CI: gh pr checks + evaluateChecks(policy), KHÔNG suy diễn từ rs.ok (Finding 2)
//     - handoffMarker: canonical marker comment với mutationKey (Finding 2)
//     - dodState: đọc từ persisted file dod-<namespace>.json
//     - worktreeClean: tách dirty-in-scope vs dirty-out-of-scope (Finding 2)
//
// Circuit breaker persist (Finding 1):
//   State lưu trong ~/.ai-pr-reviewer/breaker-<namespace>.json, atomic rename + file lock.
//   HALF_OPEN probe claim atomically giữa các process CLI.
//   Probe fail → reset openedAt; probe success → CLOSED.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path, { basename } from 'node:path';
import process from 'node:process';
import os from 'node:os';

import {
  DOD_STATES, DOD_EVENTS, apply as dodApply, createDod, summarize as dodSummarize, oneLine as dodOneLine,
} from './dod.mjs';
import {
  createBreakerRegistry, recordFailure, recordSuccess, shouldPause, summarize as breakerSummarize,
  claimHalfOpenProbe as claimHalfOpenProbePure, peek as breakerPeek,
} from './circuit-breaker.mjs';
import {
  loadBreaker, saveBreaker, withFileLock, atomicWriteJson, readJsonSafe,
  buildBreakerNamespace, claimHalfOpenProbe as claimHalfOpenProbePersist,
  createPersistFunctions, resolveRuntimeRoot,
} from './breaker-persist.mjs';
import { evaluateChecks, validatePolicy, parseHandoffMarkers, findCanonicalHandoffMarker } from './review-contract.mjs';

// ---------- Constants ----------

// Mandatory test gate (Finding 3): phải chạy toàn bộ suites bắt buộc, không chỉ pure-logic.
export const MANDATORY_TEST_SUITES = [
  'scripts/test-pure-logic.mjs',
  'scripts/test-dod.mjs',
  'scripts/test-circuit-breaker.mjs',
  'scripts/test-execution-broker.mjs',
  'scripts/test-breaker-persist.mjs',
];

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

// ---------- Git context lock (Finding 4) ----------
// createGitContext({cwd, expectedRepo, expectedBranch, expectedHeadSha}) -> {ok, cwd, repo, branch, headSha, error}
// Khóa mọi git/gh command về đúng cwd + repo + branch + full HEAD. Fail-closed.
export function createGitContext({ cwd = process.cwd(), expectedRepo = null, expectedBranch = null, expectedHeadSha = null } = {}) {
  const top = exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, cwd, repo: null, branch: null, headSha: null, error: 'not a git repo at cwd' };
  const origin = exec('git', ['-C', cwd, 'config', '--get', 'remote.origin.url']);
  if (!origin.ok || !origin.stdout.trim()) {
    return { ok: false, cwd, repo: null, branch: null, headSha: null, error: 'no origin remote configured' };
  }
  const repo = originToRepo(origin.stdout.trim());
  if (!repo) return { ok: false, cwd, repo: null, branch: null, headSha: null, error: 'cannot parse origin repo' };
  const branch = exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const headSha = exec('git', ['-C', cwd, 'rev-parse', 'HEAD']).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    return { ok: false, cwd, repo, branch, headSha, error: `invalid HEAD sha: ${headSha}` };
  }
  if (expectedRepo && repo.toLowerCase() !== String(expectedRepo).toLowerCase()) {
    return { ok: false, cwd, repo, branch, headSha, error: `repo mismatch: expected ${expectedRepo}, got ${repo}` };
  }
  if (expectedBranch && branch !== expectedBranch) {
    return { ok: false, cwd, repo, branch, headSha, error: `branch mismatch: expected ${expectedBranch}, got ${branch}` };
  }
  if (expectedHeadSha && headSha.toLowerCase() !== String(expectedHeadSha).toLowerCase()) {
    return { ok: false, cwd, repo, branch, headSha, error: `HEAD mismatch: expected ${expectedHeadSha.slice(0, 8)}, got ${headSha.slice(0, 8)}` };
  }
  return { ok: true, cwd, repo, branch, headSha, repoRoot: top.stdout.trim() };
}

// origin URL -> owner/repo (https/git@ssh/gh forms).
export function originToRepo(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!m) return null;
  const owner = m[1].replace(/\.git$/, '');
  const name = m[2].replace(/\.git$/, '');
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

// verifyGitLock(expected, {cwd}) -> {ok, ctx, error} — rút gọn cho mọi tool wrapper.
export function verifyGitLock(expected = {}, cwd = process.cwd()) {
  return createGitContext({ cwd, ...expected });
}

// ---------- gh helper (khóa repo từ git context) ----------
// ghExec(ctx, args) -> {ok, stdout, stderr} — luôn nhận --repo <ctx.repo>.
function ghExec(ctx, args) {
  return exec('gh', [...args, '--repo', ctx.repo]);
}

// verifyRemotePrHead(ctx) -> {ok, match, prNumber, prHead, localHead, error}
// Finding 4: xác nhận remote PR HEAD == local full HEAD trước khi tin CI /
// handoff. CI chỉ chạy trên remote HEAD; nếu local lệch remote → CI check
// stale, fail-closed. Trả về match=true khi không có PR open (no remote anchor)
// hoặc khi remote HEAD khớp local; ngược lại match=false.
export function verifyRemotePrHead(ctx) {
  if (!ctx || !ctx.ok || !ctx.repo || !ctx.headSha) {
    return { ok: false, match: false, prNumber: null, prHead: null, localHead: ctx?.headSha || null, error: 'invalid git context' };
  }
  const prNum = getOpenPrNumber(ctx);
  if (!prNum) {
    // Không có PR mở → không có anchor remote, bỏ qua check (match=true).
    return { ok: true, match: true, prNumber: null, prHead: null, localHead: ctx.headSha, error: null };
  }
  // `gh pr view <n> --json headRefOid` trả object có headRefOid (full SHA).
  const r = ghExec(ctx, ['pr', 'view', String(prNum), '--json', 'headRefOid', '--jq', '.headRefOid']);
  if (!r.ok) {
    return { ok: false, match: false, prNumber: prNum, prHead: null, localHead: ctx.headSha, error: `gh pr view failed: ${(r.stderr || '').trim().slice(0, 200)}` };
  }
  const prHead = (r.stdout || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(prHead)) {
    return { ok: false, match: false, prNumber: prNum, prHead, localHead: ctx.headSha, error: `invalid remote PR HEAD: '${prHead}'` };
  }
  const match = prHead.toLowerCase() === ctx.headSha.toLowerCase();
  return { ok: true, match, prNumber: prNum, prHead, localHead: ctx.headSha, error: match ? null : 'remote PR HEAD != local HEAD' };
}

// ---------- CI check (Finding 2) ----------
// readCiStatus(ctx, policy) -> {ok, state, detail}
// Đọc CI THẬT cho đúng repo + full HEAD qua gh pr checks, đánh giá bằng evaluateChecks(policy).
// KHÔNG bao giờ suy diễn CI từ rs.ok (git command thành công ≠ CI pass).
export function readCiStatus(ctx, policy) {
  if (!ctx || !ctx.ok || !ctx.repo) return { ok: false, state: 'unknown', detail: 'invalid git context' };
  const prNum = getOpenPrNumber(ctx);
  if (!prNum) return { ok: false, state: 'unknown', detail: 'no open PR for branch' };
  const checks = ghExec(ctx, ['pr', 'checks', String(prNum), '--json', 'name,state']);
  if (!checks.ok) return { ok: false, state: 'unknown', detail: 'gh pr checks failed' };
  let checksDetail;
  try { checksDetail = JSON.parse(checks.stdout); } catch { return { ok: false, state: 'unknown', detail: 'gh pr checks: invalid JSON' }; }
  const policyOk = validatePolicy(policy);
  if (!policyOk.ok) return { ok: false, state: 'unknown', detail: `policy invalid: ${policyOk.error}` };
  const state = evaluateChecks(policy, checksDetail);
  return { ok: true, state, detail: `gh pr checks #${prNum} → ${state}` };
}

// getOpenPrNumber(ctx) -> number|null (dùng gh pr list theo head branch)
export function getOpenPrNumber(ctx) {
  if (!ctx || !ctx.ok) return null;
  const res = ghExec(ctx, ['pr', 'list', '--head', ctx.branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number']);
  if (!res.ok || !res.stdout.trim()) return null;
  const n = Number(res.stdout.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------- canonical handoff marker (Finding 2 & 3) ----------
// action canonical cho handoff theo mutationKey convention (review-contract).
export const HANDOFF_ACTION = 'handoff:ready';

export function mutationKey({ repository, prNumber, headSha, policyVersion, action }) {
  return [repository, prNumber, headSha, policyVersion, action].join('::');
}

// hasCanonicalHandoffMarker(ctx, policyVersion) -> {ok, present, marker, error}
// Finding 6: dùng parser canonical (parseHandoffMarkers) + filter provenance
// (authorLogin + commentId). Comment legacy body thuần KHÔNG đủ tiêu chuẩn tin
// cậy — caller phải từ chối. So khớp full mutationKey (repo, pr, headSha,
// policyVersion, action) — không match chuỗi con.
export function hasCanonicalHandoffMarker(ctx, policyVersion) {
  if (!ctx || !ctx.ok || !ctx.repo) return { ok: false, present: false, marker: null, error: 'invalid git context' };
  const prNum = getOpenPrNumber(ctx);
  if (!prNum) return { ok: false, present: false, marker: null, error: 'no open PR for branch' };
  const expectedKey = mutationKey({
    repository: ctx.repo, prNumber: prNum, headSha: ctx.headSha, policyVersion,
    action: HANDOFF_ACTION,
  });
  // Lấy rich comments (id, user.login, created_at, body) — KHÔNG chỉ body.
  const raw = ghExec(ctx, ['api', `repos/${ctx.repo}/issues/${prNum}/comments`, '--paginate']);
  if (!raw.ok) return { ok: false, present: false, marker: null, error: `gh api comments failed: ${(raw.stderr || '').trim().slice(0, 200)}` };
  let comments;
  try { comments = JSON.parse(raw.stdout || '[]'); }
  catch { return { ok: false, present: false, marker: null, error: 'gh api comments: invalid JSON' }; }
  const parsed = parseHandoffMarkers(comments);
  const found = findCanonicalHandoffMarker(parsed, expectedKey);
  return { ok: true, present: !!found, marker: found, error: null };
}

// ---------- DoD persist (Finding 2: DoD state persisted) ----------
export function dodFilePath(namespace) {
  return path.join(resolveRuntimeRoot(), `dod-${namespace}.json`);
}

export function loadPersistedDod(namespace) {
  const data = readJsonSafe(dodFilePath(namespace));
  return data && data.ok ? data : null;
}

export function savePersistedDod(namespace, session) {
  atomicWriteJson(dodFilePath(namespace), session);
}

// ---------- breaker persist (Finding 1) ----------
export function resolveBreakerNamespace(ctx) {
  return buildBreakerNamespace((ctx && ctx.repo) || 'default', (ctx && ctx.branch) || 'default');
}

// createPersistedBreaker(ctx) -> {ns, load, save, recordFailure, recordSuccess, claimProbe}
export function createPersistedBreaker(ctx) {
  const ns = resolveBreakerNamespace(ctx);
  const persist = createPersistFunctions(recordFailure, recordSuccess);
  return {
    ns,
    load: () => loadBreaker(ns),
    save: (reg) => saveBreaker(ns, reg),
    recordFailure: (tool, reason, now) => persist.recordFailurePersist(ns, tool, reason, now),
    recordSuccess: (tool) => persist.recordSuccessPersist(ns, tool),
    claimProbe: (tool, now) => claimHalfOpenProbePersist(ns, tool, 60_000, now),
  };
}

// loadPolicyAt(cwd) -> {policy, error} — đọc .github/ai-review-policy.json local
export function loadPolicyAt(cwd = process.cwd()) {
  const p = path.join(cwd, '.github', 'ai-review-policy.json');
  if (!existsSync(p)) return { policy: null, error: 'policy file not found' };
  try {
    const policy = JSON.parse(readFileSync(p, 'utf8'));
    const v = validatePolicy(policy);
    if (!v.ok) return { policy: null, error: `policy invalid: ${v.error}` };
    return { policy, error: null };
  } catch (e) {
    return { policy: null, error: `policy parse error: ${e.message}` };
  }
}


// ---------- 6 tool wrappers (mỗi tool trả machine-readable JSON) ----------

// Tool 1: repo_status — git status + branch + HEAD (khóa git context)
export function toolRepoStatus({ cwd = process.cwd(), gitLock = null } = {}) {
  const lock = gitLock || createGitContext({ cwd });
  if (!lock.ok) {
    return { ok: false, tool: 'repo_status', data: null, error: `git lock failed: ${lock.error}` };
  }
  const branch = exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = exec('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  const status = exec('git', ['-C', cwd, 'status', '--short']);
  const ok = branch.ok && sha.ok && status.ok;
  return {
    ok,
    tool: 'repo_status',
    data: {
      branch: branch.stdout.trim(),
      headSha: sha.stdout.trim(),
      worktreeDirty: status.stdout.trim().length > 0,
      worktreeLines: status.stdout.split('\n').filter(Boolean),
      origin: lock.repo,
    },
    error: ok ? null : 'git command failed',
  };
}

// Tool 2: repo_diff — git diff <base>..HEAD --stat + numstat (khóa git context)
export function toolRepoDiff({ base = 'main', cwd = process.cwd(), gitLock = null } = {}) {
  const lock = gitLock || createGitContext({ cwd });
  if (!lock.ok) {
    return { ok: false, tool: 'repo_diff', data: null, error: `git lock failed: ${lock.error}` };
  }
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

// Tool 3: test_run — mandatory test gate (Finding 3): toàn bộ MANDATORY_TEST_SUITES.
export function toolTestRun({ cwd = process.cwd(), gitLock = null } = {}) {
  const lock = gitLock || createGitContext({ cwd });
  if (!lock.ok) {
    return { ok: false, tool: 'test_run', data: null, error: `git lock failed: ${lock.error}` };
  }
  const results = [];
  let allPass = true;
  let passed = 0, total = 0;
  for (const suite of MANDATORY_TEST_SUITES) {
    const r = exec(process.execPath, [suite], { cwd });
    const m = r.stdout.match(/(?:Tổng|Total):\s*(\d+)\/(\d+)\s*PASS/);
    if (m) { passed += Number(m[1]); total += Number(m[2]); }
    results.push({ suite, ok: r.ok });
    if (!r.ok) allPass = false;
  }
  return {
    ok: allPass,
    tool: 'test_run',
    data: {
      passed, total, allPass,
      suites: results,
      stdoutTail: results.map((s) => `${s.suite}: ${s.ok ? 'PASS' : 'FAIL'}`).join('\n'),
    },
    error: allPass ? null : `mandatory test gate FAIL (${passed}/${total})`,
  };
}

// Tool 4: verify_status — node scripts/full-verify.mjs (khóa git context)
export function toolVerifyStatus({ cwd = process.cwd(), gitLock = null } = {}) {
  const lock = gitLock || createGitContext({ cwd });
  if (!lock.ok) {
    return { ok: false, tool: 'verify_status', data: null, error: `git lock failed: ${lock.error}` };
  }
  const r = exec(process.execPath, ['scripts/full-verify.mjs'], { cwd });
  return {
    ok: r.ok,
    tool: 'verify_status',
    data: { allOk: r.ok, allPass: r.ok, stdoutTail: r.stdout.split('\n').slice(-15).join('\n'), stderrTail: r.stderr.split('\n').slice(-5).join('\n') },
    error: r.ok ? null : 'verify status FAIL (see stdout/stderr)',
  };
}

// Tool 5: pre_review_status — deterministic partial pre-review (size + secret scan). Khóa git context.
// YAGNI: không gọi full local reviewer (chưa tích hợp); chỉ 2 heuristic cơ bản.
export function toolPreReviewStatus({ base = 'main', maxLines = 1500, cwd = process.cwd(), gitLock = null } = {}) {
  const lock = gitLock || createGitContext({ cwd });
  if (!lock.ok) {
    return { ok: false, tool: 'pre_review_status', data: null, error: `git lock failed: ${lock.error}` };
  }
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

// Tool 6: handoff_status — git log + remote + branch + canonical marker check (Finding 3).
// KHÔNG dùng PR OPEN làm marker; chỉ emit HANDOFF_MARKER khi canonical marker + HEAD hợp lệ.
export function toolHandoffStatus({ cwd = process.cwd(), gitLock = null, policyVersion = '' } = {}) {
  const lock = gitLock || createGitContext({ cwd });
  if (!lock.ok) {
    return { ok: false, tool: 'handoff_status', data: null, error: `git lock failed: ${lock.error}` };
  }
  const log = exec('git', ['-C', cwd, 'log', '--oneline', '-5']);
  const ok = log.ok;
  // Check canonical marker nếu có gh + policyVersion (Finding 6: parser canonical).
  let handoffMarkerValid = false;
  let markerDetail = null;
  if (ok && policyVersion && lock.ok) {
    const marker = hasCanonicalHandoffMarker(lock, policyVersion);
    handoffMarkerValid = marker.present;
    markerDetail = marker.present ? 'canonical marker found' : `no canonical marker (${marker.error || 'parse fail'})`;
  }
  // Finding 4: xác nhận remote PR HEAD == local HEAD.
  const remote = verifyRemotePrHead(lock);
  return {
    ok,
    tool: 'handoff_status',
    data: {
      recentCommits: log.stdout.split('\n').filter(Boolean),
      branch: lock.branch,
      headSha: lock.headSha,
      remote: lock.repo,
      handoffMarkerValid,
      markerDetail: markerDetail || 'no gh/policyVersion — marker check skipped',
      remotePrHeadMatch: remote.ok && remote.match,
      remotePrHead: remote.prHead,
      remotePrNumber: remote.prNumber,
    },
    error: ok ? null : 'git command failed',
  };
}

// ---------- Broker: gắn breaker + DoD emission ----------
// runTool(tool, args, {registry, dod, persistBreaker, gitLock}) -> {ok, result, breaker, dod, dod_event}
//   1) shouldPause -> nếu pause thì trả ngay, không exec.
//   2) OPEN + cooldown elapsed -> claim HALF_OPEN probe ATOMIC (Finding 1) trước khi exec.
//   3) exec tool (khóa git context Finding 4).
//   4) recordSuccess / recordFailure (persisted nếu có persistBreaker).
//   5) Emit DoD event CHỈ khi evidence canonical được tool xác minh (Finding 3):
//        repo_diff       : có diff thật (totalFiles > 0)
//        test_run        : mandatory gate pass (allPass) — mặc định result.ok
//        handoff_status  : canonical marker + HEAD hợp lệ (handoffMarkerValid)
const TOOL_DOD_EVENT = Object.freeze({
  repo_status: null,
  repo_diff: null, // Finding 5: diff KHONG phai evidence implementation (test_run/verify_status PASS moi la)
  test_run: DOD_EVENTS.EVIDENCE_VERIFICATION,
  verify_status: DOD_EVENTS.EVIDENCE_VERIFICATION,
  pre_review_status: DOD_EVENTS.EVIDENCE_VERIFICATION,
  handoff_status: DOD_EVENTS.HANDOFF_MARKER,
  auto_commit_gate: null,
});

// shouldEmitDodEvent(tool, result) -> boolean (Finding 3 + Finding 5: evidence canonical mới emit)
export function shouldEmitDodEvent(tool, result) {
  if (!result || !result.ok) return false;
  if (tool === 'repo_diff') {
    // Finding 5: diff tồn tại KHONG phải evidence implementation.
    // Implementation = test_run/verify_status PASS. Diff không bao giờ trigger DoD.
    return false;
  }
  if (tool === 'test_run' || tool === 'verify_status') {
    // Gate bắt buộc phải pass (allPass === true, fail-closed for undefined/null)
    return result.data && result.data.allPass === true;
  }
  if (tool === 'handoff_status') {
    // Chỉ emit khi canonical marker (provenance) + remotePrHeadMatch (Finding 4) đều OK.
    const d = result.data || {};
    return d.handoffMarkerValid === true && d.remotePrHeadMatch === true;
  }
  return true;
}

export function runTool(tool, args = {}, { registry, dod, persistBreaker, gitLock } = {}) {
  // Breaker: dùng persisted nếu có, ngược lại in-memory
  let reg = registry || createBreakerRegistry();
  if (persistBreaker) {
    reg = persistBreaker.load();
  }
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
  // OPEN + cooldown elapsed -> claim HALF_OPEN probe atomically (Finding 1)
  if (pauseCheck.state === 'OPEN') {
    let claimOut;
    if (persistBreaker) {
      claimOut = persistBreaker.claimProbe(tool);
      if (!claimOut.claimed) {
        return {
          ok: false,
          result: null,
          breaker: { state: 'OPEN', reason: `probe claim failed: ${claimOut.reason}`, paused: true },
          dod: session,
          dod_event: null,
        };
      }
      reg = claimOut.registry;
    } else {
      claimOut = claimHalfOpenProbePure(reg, tool);
      if (!claimOut.claimed) {
        return {
          ok: false,
          result: null,
          breaker: { state: 'OPEN', reason: `probe claim failed: ${claimOut.reason}`, paused: true },
          dod: session,
          dod_event: null,
        };
      }
      reg = claimOut.registry;
    }
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
  // Truyền gitLock (Finding 4) vào args nếu có
  const toolArgs = gitLock ? { ...(args || {}), gitLock } : (args || {});
  const result = handler(toolArgs);
  // recordSuccess/recordFailure (persisted hoặc in-memory)
  let newReg = reg;
  let recovered = false;
  if (persistBreaker) {
    const rec = result.ok ? persistBreaker.recordSuccess(tool) : persistBreaker.recordFailure(tool, result.error || 'tool error');
    if (rec && rec.registry) { newReg = rec.registry; recovered = rec.recovered || false; }
  } else {
    const rec = result.ok ? recordSuccess(reg, tool) : recordFailure(reg, tool, result.error || 'tool error');
    if (rec && rec.registry) { newReg = rec.registry; recovered = rec.recovered || false; }
  }
  // DoD emission conditional (Finding 3)
  let dodAfter = session;
  let dodEvent = null;
  const ev = TOOL_DOD_EVENT[tool];
  if (ev && shouldEmitDodEvent(tool, result)) {
    const trial = dodApply(session, ev);
    if (trial.ok) {
      dodAfter = trial;
      dodEvent = ev;
    }
  }
  return {
    ok: result.ok,
    result,
    breaker: { state: peekBreakerState(newReg, tool), recovered },
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
  return `Usage: node scripts/execution-broker.mjs <tool> [--json] [--base main] [--cwd <dir>]
       node scripts/execution-broker.mjs dod --state <X> --event <Y>
       node scripts/execution-broker.mjs auto-commit-gate [--json]
Tools: ${TOOLS.join(', ')}`;
}

// helper: parse argv → {jsonOut, base, cwd, toolArgs}
function parseArgs(argv) {
  const jsonOut = argv.includes('--json');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'main';
  const cwdIdx = argv.indexOf('--cwd');
  const cwd = cwdIdx >= 0 ? argv[cwdIdx + 1] : process.cwd();
  const toolArgs = { base, cwd };
  return { jsonOut, base, cwd, toolArgs };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(usage());
    process.exit(2);
  }
  const { jsonOut, base, cwd, toolArgs } = parseArgs(argv);
  const cmd = argv[0];

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

  // Git context lock (Finding 4): khóa cwd/repo/branch/HEAD cho mọi nhánh IO.
  const gitLock = createGitContext({ cwd });
  if (!gitLock.ok) {
    const payload = { ok: false, error: `git lock failed: ${gitLock.error}` };
    console.log(jsonOut ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
    process.exit(1);
  }

  if (cmd === 'auto-commit-gate') {
    const out = runAutoCommitGate({ cwd, base, gitLock, jsonOut });
    process.exit(out.gate.ok ? 0 : 1);
  }

  if (!TOOLS.includes(cmd)) { console.log(usage()); process.exit(2); }
  if (cmd === 'auto_commit_gate') {
    const out = checkAutoCommitGate({});
    console.log(jsonOut ? JSON.stringify(out, null, 2) : JSON.stringify(out));
    process.exit(0);
  }

  // Single tool: dùng persisted breaker + DoD (Finding 1) + gitLock (Finding 4)
  const persistBreaker = createPersistedBreaker(gitLock);
  const ns = resolveBreakerNamespace(gitLock);
  const dodSession = loadPersistedDod(ns) || createDod();
  const r = runTool(cmd, toolArgs, { persistBreaker, gitLock, dod: dodSession });
  // Persist DoD state (Finding 2)
  if (r.dod && r.dod.ok) savePersistedDod(ns, r.dod);
  const payload = {
    broker_result: r,
    dod_summary: dodSummarize(r.dod),
    dod_one_line: dodOneLine(r.dod),
    breaker_namespace: ns,
  };
  console.log(jsonOut ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
  process.exit(r.ok ? 0 : 1);
}
// runAutoCommitGate — auto-commit gate CLI với IO THẬT (Finding 2 + 3 + 4).
// - CI: gh pr checks + evaluateChecks(policy) — KHÔNG suy diễn từ rs.ok
// - handoffMarker: canonical marker comment — KHÔNG dùng PR OPEN
// - dodState: đọc từ persisted dod-<namespace>.json
// - worktreeClean: tách dirty-in-scope (dự kiến commit) vs dirty-out-of-scope
//   dựa trên porcelain hiện tại (git status --porcelain) + diff base..HEAD
// - remotePrHeadMatch (Finding 4): xác nhận remote PR HEAD == local HEAD
export function runAutoCommitGate({ cwd = process.cwd(), base = 'main', gitLock = null, jsonOut = false } = {}) {
  const lock = gitLock || createGitContext({ cwd });
  if (!lock.ok) {
    const fail = { gate: { ok: false, missing: ['gitLock'], checks: {} }, inputs: null, error: lock.error };
    console.log(jsonOut ? JSON.stringify(fail, null, 2) : `auto-commit-gate: MISSING gitLock (${lock.error})`);
    return fail;
  }
  const rs = toolRepoStatus({ cwd, gitLock: lock });
  const td = toolTestRun({ cwd, gitLock: lock });
  const vs = toolVerifyStatus({ cwd, gitLock: lock });
  const prs = toolPreReviewStatus({ base, cwd, gitLock: lock });
  const policyRes = loadPolicyAt(cwd);
  // CI thật (Finding 2): không dùng rs.ok
  let ciState = 'unknown';
  let ciDetail = 'no policy / gh';
  if (policyRes.policy) {
    const ci = readCiStatus(lock, policyRes.policy);
    ciState = ci.state;
    ciDetail = ci.detail;
  }
  // Canonical handoff marker (Finding 2 + 6): không dùng PR OPEN, dùng parser canonical.
  let handoffMarkerPresent = false;
  let markerDetail = 'no policy version';
  if (policyRes.policy) {
    const m = hasCanonicalHandoffMarker(lock, policyRes.policy.policyVersion);
    handoffMarkerPresent = m.present;
    markerDetail = m.present ? 'canonical marker found' : `no canonical marker (${m.error || 'parse fail'})`;
  }
  // DoD persisted (Finding 2): đọc từ file dod-<namespace>.json
  const ns = resolveBreakerNamespace(lock);
  const dodState = loadPersistedDod(ns);
  // Phân loại dirty từ porcelain hiện tại (Finding 3):
  //   git status --porcelain  → list file dirty CHƯA commit
  //   git diff base...HEAD --name-only  → file đã commit trong nhánh (in-scope)
  //   dirty-in-scope  = file trong cả porcelain & diff (đã có trong commit chờ push)
  //   dirty-out-scope = file porcelain KHÔNG có trong diff → file lạ chưa commit → BLOCK
  // File trong diff (committed) nhưng KHÔNG có trong porcelain = sạch (đã commit).
  const porcelain = (rs.ok && rs.data && rs.data.worktreeLines) || [];
  const diffFiles = new Set();
  if (rs.ok) {
    const numstat = exec('git', ['-C', cwd, 'diff', `${base}...HEAD`, '--name-only']);
    if (numstat.ok) {
      for (const f of numstat.stdout.split('\n').filter(Boolean)) diffFiles.add(f.trim());
    }
  }
  // Extract path từ porcelain line "XY path" (X=index status, Y=worktree status, space, path).
  // Bỏ XY (2 char) + space; rename có dạng "R  old -> new" → lấy new (sau ' -> ').
  const porcelainPaths = porcelain.map((l) => {
    const s = l.trim();
    if (s.length < 4) return '';
    const tail = s.slice(3);
    const arrow = tail.indexOf(' -> ');
    return arrow >= 0 ? tail.slice(arrow + 4) : tail;
  }).filter(Boolean);
  // 1) dirty-out-scope: porcelain path không có trong diff (file lạ chưa commit) → BLOCK
  const dirtyOutOfScope = porcelainPaths.filter((f) => !diffFiles.has(f));
  // 2) dirty-in-scope (count only): porcelain path có trong diff (file đã commit, working tree sạch) → OK
  const dirtyInScopeCount = porcelainPaths.length - dirtyOutOfScope.length;
  const worktreeClean = rs.ok && dirtyOutOfScope.length === 0;
  // Remote PR HEAD == local HEAD (Finding 4)
  const remote = verifyRemotePrHead(lock);
  const remotePrHeadMatch = remote.ok && remote.match;
  const gate = checkAutoCommitGate({
    branch: rs.ok && rs.data ? rs.data.branch : '',
    headSha: rs.ok && rs.data ? rs.data.headSha : '',
    worktreeClean,
    testsPass: td.ok,
    verifyPass: vs.ok,
    preReviewPass: prs.ok,
    dodState: dodState ? dodState.state : null,
    handoffMarker: handoffMarkerPresent,
    ciRequiredChecksPass: ciState === 'pass' && remotePrHeadMatch,
  });
  const payload = {
    gate,
    inputs: {
      branch: rs.ok && rs.data ? rs.data.branch : null,
      headSha: rs.ok && rs.data ? rs.data.headSha : null,
      worktreeClean,
      dirtyOutOfScope,
      dirtyInScopeCount,
      testsPass: td.ok,
      verifyPass: vs.ok,
      preReviewPass: prs.ok,
      dodState: dodState ? dodState.state : null,
      handoffMarker: handoffMarkerPresent,
      ciState,
      ciDetail,
      markerDetail,
      remotePrHeadMatch,
      remotePrHead: remote.prHead,
      remotePrNumber: remote.prNumber,
      policyVersion: policyRes.policy ? policyRes.policy.policyVersion : null,
      breakerNamespace: ns,
    },
  };
  console.log(jsonOut ? JSON.stringify(payload, null, 2) : `auto-commit-gate: ${gate.ok ? 'OK' : 'MISSING ' + gate.missing.join(',')}`);
  return payload;
}

// Chạy CLI chỉ khi gọi trực tiếp.
// Lưu ý: dùng path.basename + equality để tránh match "test-execution-broker.mjs".
const isMain = process.argv[1] && basename(process.argv[1]) === 'execution-broker.mjs';
if (isMain) main();

export default { TOOLS, AUTO_COMMIT_REQUIREMENTS, checkAutoCommitGate,
  toolRepoStatus, toolRepoDiff, toolTestRun, toolVerifyStatus, toolPreReviewStatus, toolHandoffStatus,
  runTool, verifyRemotePrHead, runAutoCommitGate };


