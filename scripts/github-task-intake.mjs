#!/usr/bin/env node
// github-task-intake.mjs — Tìm & claim Issue GitHub cho Cline (Issue #8).
//
// Chế độ:
//   node scripts/github-task-intake.mjs            # read-only: liệt kê Issue mở có đủ
//                                                  #   agent:cline + status:ready-for-cline
//   node scripts/github-task-intake.mjs --claim    # claim task DUY NHẤT (0 -> NO_TASK, >1 -> BLOCKED_MULTIPLE_TASKS)
//   node scripts/github-task-intake.mjs --claim 8  # claim Issue #8 (phải đang ready)
//
// An toàn:
//   - Read-only theo mặc định; mutation CHỈ xảy ra khi --claim.
//   - Mọi lệnh ngoài dùng execFile (không qua shell); nội dung Issue chỉ được in dạng JSON,
//     không bao giờ thực thi như shell.
//   - Claim fail-closed + idempotent: đổi status:ready-for-cline -> status:in-progress,
//     đăng marker duy nhất (không trùng), read-after-write trước khi báo CLAIMED. Marker tồn tại
//     phải đi kèm read-back verify labels (agent:cline + in-progress, không còn ready-for-cline);
//     marker có nhưng labels sai -> BLOCKED_READBACK_MISMATCH, không claim lại (GPT-REV-006).
//   - Claim có luồng phục hồi (recovery): mutation từng phần (labels đã đổi nhưng chưa đăng
//     marker / read-back lỗi) được nhận diện qua classifyIssueState và HOÀN TẤT ở lần chạy sau.
//   - Trước claim: kiểm tra working tree sạch (ngoài prefix cho phép, mặc định memory-bank/) và
//     branch an toàn — không detached, đang ở main/master (Auto-Boot); KHÔNG yêu cầu task
//     branch/upstream tồn tại trước claim, task branch được tạo SAU claim khi đã biết Issue
//     number; đang ở branch task cũ -> chặn (GPT-REV-007).
//   - Preflight workspace (Issue #20) TRƯỚC mọi mutation khi --claim: repo root xác minh bằng Git
//     (git rev-parse --show-toplevel, không suy đoán tên thư mục); remote origin phải canonical
//     (duongpdddic-droid/AI_PR_REVIEWER — KHÔNG còn override bằng env, GPT-REV-028); chạy
//     `git fetch origin` TRƯỚC khi xác định base (fetch lỗi -> ERROR_FETCH, fail-closed); base =
//     SHA origin/main tại thời điểm claim; HEAD phải bằng base sau fetch (lệch -> BLOCKED_STALE_BASE);
//     working tree sạch ngoài allowlist (mặc định memory-bank/ -> BLOCKED_DIRTY_WORKTREE); đang ở
//     branch task cũ/nhánh Issue-PR cũ (kể cả đã merge) -> BLOCKED_ACTIVE_ISSUE_BRANCH; phát hiện
//     >=1 workspace anh em cùng remote canonical trong thư mục cha -> BLOCKED_MULTIPLE_WORKSPACES
//     (escape hatch GITHUB_TASK_INTAKE_ALLOW_MULTI=1 CHỈ khi Bố chỉ định). KHÔNG BAO GIỜ tự
//     git reset/clean/stash/drop hoặc xóa/di chuyển workspace người dùng (Issue #20 rule 7-8).
//   - Env test-only CHỈ có hiệu lực khi GITHUB_TASK_INTAKE_TEST=1 (fixture, GPT-REV-028):
//     GITHUB_TASK_INTAKE_SKIP_REMOTE=1, GITHUB_TASK_INTAKE_SKIP_FETCH=1,
//     GITHUB_TASK_INTAKE_PARENT=<thư mục cha giới hạn cho fixture test>. Production KHÔNG bao giờ
//     đọc 3 biến này -> đường CLI luôn kiểm tra remote canonical + fetch thật + HEAD == origin/main.
//   - Repo cho MỌI GitHub read/mutation (GPT-REV-027) = repo parse từ origin đã qua preflight;
//     GITHUB_REPOSITORY KHÔNG được tin độc lập: nếu có mà khác origin canonical ->
//     BLOCKED_REPO_MISMATCH, dừng trước mọi comment/label/mutation.
//   - Sau preflight READY: claim rồi tạo task branch từ origin/main (base SHA ghi trong marker).
//     Khóa cục bộ ĐẶT NGOÀI worktree
//     (~/.ai-pr-reviewer hoặc GITHUB_TASK_INTAKE_LOCK_DIR) để không tự làm repo dirty (GPT-REV-009).
//     FAIL-CLOSED (GPT-REV-010/011): KHÔNG auto-takeover — lock tồn tại (kể cả owner đã chết) luôn
//     trả BLOCKED_LOCKED kèm bằng chứng PID + hướng dẫn xử lý thủ công; releaseLock CHỈ xóa đúng
//     lock của mình sau khi verify token — caller sai/owner cũ tuyệt đối không làm lock biến mất.
//     cross-host chống trùng dựa vào marker + read-after-write.
//
// Output: JSON một dòng { status, ... } ra stdout. Exit 0 = NO_TASK/TASKS_FOUND/CLAIMED/ALREADY_CLAIMED;
// exit 1 = BLOCKED_*/ERROR. Không coi output lệnh mutation là bằng chứng — bắt buộc read-back từ GitHub.
//
// Giới hạn (ghi theo Issue #8): script KHÔNG thể đánh thức Cline/VS Code đang tắt; nó chỉ tự nhận
// task khi Cline đang chạy (Auto-Boot / checkpoint an toàn).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();

// Issue #20: repository canonical duy nhất được phép claim. Override CHỈ cho test fixture
// (GITHUB_TASK_INTAKE_REMOTE_REPO) — production bắt buộc đúng giá trị này.
const CANONICAL_REPO = 'duongpdddic-droid/AI_PR_REVIEWER';

// ---------------------------------------------------------------- pure helpers

export function hasLabels(issue, required) {
  const names = new Set((issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)));
  return required.every((n) => names.has(n));
}

export function isPullRequest(issue) {
  return Boolean(issue.pull_request);
}

export function filterReadyTasks(issues) {
  return (issues || []).filter(
    (i) => i.state === 'open' && !isPullRequest(i) && hasLabels(i, ['agent:cline', 'status:ready-for-cline']),
  );
}

export function classifyReadyTasks(tasks) {
  if (tasks.length === 0) return { status: 'NO_TASK' };
  if (tasks.length > 1) return { status: 'BLOCKED_MULTIPLE_TASKS', numbers: tasks.map((t) => t.number) };
  return { status: 'READY', task: tasks[0] };
}

export function isAllowedWorktreeChange(file, allowedPrefixes) {
  return allowedPrefixes.some((p) => file === p || file.startsWith(p));
}

export function worktreeBlockers(statusLines, allowedPrefixes) {
  return statusLines.filter((f) => !isAllowedWorktreeChange(f, allowedPrefixes));
}

export function buildClaimBody(issueNumber, baseSha, at) {
  const marker = `<!-- cline-claim:${issueNumber}:${baseSha}:${at} -->`;
  return `${marker}\nCline claim Issue #${issueNumber} qua scripts/github-task-intake.mjs (base ${baseSha}, ${at}).`;
}

export function parseClaimedNumberFromBody(body) {
  const m = String(body || '').match(/<!-- cline-claim:(\d+):/);
  return m ? Number(m[1]) : null;
}

export function hasClaimMarker(comments, issueNumber) {
  return (comments || []).some((c) => parseClaimedNumberFromBody(c.body) === issueNumber);
}

export function labelsOkAfterClaim(labels, required, absent) {
  const names = new Set((labels || []).map((l) => (typeof l === 'string' ? l : l.name)));
  return required.every((n) => names.has(n)) && absent.every((n) => !names.has(n));
}

export function labelsToNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

export function classifyIssueState(issue) {
  const names = new Set(labelsToNames(issue.labels));
  const isAgentCline = names.has('agent:cline');
  if (isAgentCline && names.has('status:ready-for-cline')) return 'READY';
  if (isAgentCline && names.has('status:in-progress')) return 'IN_PROGRESS';
  return 'OTHER';
}

// GPT-REV-007: Auto-Boot thường đứng ở main -> claim được phép ngay trên main/master
// (repo sạch + HEAD hợp lệ). KHÔNG yêu cầu task branch/upstream tồn tại trước claim:
// sau khi biết Issue number, agent mới tạo/chuyển sang task branch.
// Vẫn chặn: detached HEAD, không xác định được branch, hoặc đang ở branch task cũ
// (claim task mới khi đang giữa task khác sẽ tạo nhánh con từ nhánh sai).
// Issue #20: đổi BLOCKED_NOT_ON_MAIN -> BLOCKED_ACTIVE_ISSUE_BRANCH (nhánh Issue/PR cũ kể cả đã merge).
export function branchSafetyCheck({ branchName, isDetached }) {
  if (isDetached) return { ok: false, reason: 'DETACHED_HEAD', detail: 'HEAD đang detached — không có nhánh hợp lệ để claim.' };
  if (!branchName) return { ok: false, reason: 'NO_BRANCH', detail: 'Không xác định được nhánh hiện tại.' };
  if (branchName !== 'main' && branchName !== 'master') {
    return {
      ok: false,
      reason: 'BLOCKED_ACTIVE_ISSUE_BRANCH',
      detail: `Đang ở branch ${branchName} — nhánh của Issue/PR (có thể đã merge) hoặc task cũ. Không bắt đầu task mới từ nhánh này. Về main/master đã fetch rồi claim (Issue #20).`,
    };
  }
  return { ok: true };
}

export function safeTaskPayload(task) {
  return {
    number: task.number,
    title: task.title,
    html_url: task.html_url,
    body: task.body,
    labels: (task.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
  };
}


// ---------------------------------------------------------------- claim workflow (injectable deps)
// Luồng khôi phục (GPT-REV-001): nếu mutateLabels thành công mà comment/read-back lỗi,
// Issue rơi vào IN_PROGRESS không có marker → lần chạy sau sẽ HOÀN TẤT claim (recovery)
// thay vì để kẹt hoặc claim lại.

export function completeClaim({ issue, baseSha, now, deps, recovery = false }) {
  const { postComment, getIssue } = deps;
  const number = issue.number;
  const body = buildClaimBody(number, baseSha, now);

  try {
    postComment(number, body);
  } catch (e) {
    return { status: recovery ? 'BLOCKED_RECOVERY_COMMENT_FAILED' : 'BLOCKED_COMMENT_FAILED', number, error: String((e && e.message) || e) };
  }

  let after;
  try {
    after = getIssue(number);
  } catch (e) {
    return {
      status: 'BLOCKED_READBACK_ERROR',
      number,
      error: String((e && e.message) || e),
      detail: 'Labels đã đổi và marker đã đăng; lần chạy sau sẽ trả ALREADY_CLAIMED.',
    };
  }

  const ok = labelsOkAfterClaim(after.labels, ['agent:cline', 'status:in-progress'], ['status:ready-for-cline']);
  if (!ok) {
    return { status: 'BLOCKED_READBACK_MISMATCH', number, labels: labelsToNames(after.labels) };
  }
  return { status: 'CLAIMED', number, baseSha, recovery, task: safeTaskPayload(issue) };
}

export function executeClaim({ issue, baseSha, now, deps }) {
  const { getComments, mutateLabels } = deps;
  const number = issue.number;
  const state = classifyIssueState(issue);
  const comments = getComments(number);
  const markerPresent = hasClaimMarker(comments, number);

  // GPT-REV-006: marker tồn tại KHÔNG tự động = đã claim. Phải read-back + verify labels
  // (agent:cline + status:in-progress, không còn status:ready-for-cline). Labels sai ->
  // BLOCKED_READBACK_MISMATCH fail-closed, không mutation (issue có thể bị thay đổi ngoài ý muốn).
  if (markerPresent) {
    const labelsOk = labelsOkAfterClaim(issue.labels, ['agent:cline', 'status:in-progress'], ['status:ready-for-cline']);
    if (labelsOk) {
      return { status: 'ALREADY_CLAIMED', number, detail: 'Marker claim tồn tại và labels xác minh đúng (agent:cline + status:in-progress).' };
    }
    return {
      status: 'BLOCKED_READBACK_MISMATCH',
      number,
      labels: labelsToNames(issue.labels),
      detail: 'Marker claim tồn tại nhưng labels KHÔNG khớp in-progress — cần can thiệp thủ công, không claim lại.',
    };
  }
  if (state === 'IN_PROGRESS') {
    return completeClaim({ issue, baseSha, now, deps, recovery: true });
  }
  if (state !== 'READY') {
    return { status: 'BLOCKED_NOT_READY', number, detail: `Trạng thái Issue không sẵn sàng claim: ${state}` };
  }

  try {
    mutateLabels(number);
  } catch (e) {
    return { status: 'BLOCKED_MUTATION_FAILED', number, error: String((e && e.message) || e) };
  }
  return completeClaim({ issue, baseSha, now, deps });
}

export function claimWorkflow({ tasks, requestedNumber, baseSha, now, deps }) {
  const fetchIssue = (n) => {
    try {
      return deps.getIssue(n);
    } catch (e) {
      return { status: 'BLOCKED_NOT_READY', number: n, detail: `Không đọc được Issue: ${String((e && e.message) || e)}` };
    }
  };

  if (requestedNumber != null) {
    // Idempotency theo số (GPT-REV-002): fetch Issue trực tiếp, KHÔNG phụ thuộc danh sách ready
    // → Issue đã claim (IN_PROGRESS) hoặc ở trạng thái khác vẫn được phân loại chính xác.
    const issue = fetchIssue(Number(requestedNumber));
    if (issue.status === 'BLOCKED_NOT_READY') return issue;
    return executeClaim({ issue, baseSha, now, deps });
  }

  const c = classifyReadyTasks(tasks);
  if (c.status === 'NO_TASK' || c.status === 'BLOCKED_MULTIPLE_TASKS') return c;
  const issue = fetchIssue(c.task.number);
  if (issue.status === 'BLOCKED_NOT_READY') return issue;
  return executeClaim({ issue, baseSha, now, deps });
}


// ---------------------------------------------------------------- side effects (real)

export function execArgs(gh, args) {
  // Cho phép mock gh bằng 1 script Node (GITHUB_TASK_INTAKE_GH trỏ tới .mjs/.js) chạy qua node
  // thay vì binary 'gh'; mặc định 'gh' giữ nguyên. Dùng trong integration test entry path.
  return gh.endsWith('.mjs') || gh.endsWith('.js') ? [process.execPath, gh, ...args] : [gh, ...args];
}

function run(cmd, args, opts = {}) {
  const [bin, ...binArgs] = execArgs(cmd, args);
  return execFileSync(bin, binArgs, { encoding: 'utf8', ...opts }).trim();
}

export function makeRealDeps({ repo, gh }) {
  return {
    getComments: (n) => JSON.parse(run(gh, ['api', '--paginate', `repos/${repo}/issues/${n}/comments`]) || '[]'),
    mutateLabels: (n) =>
      run(gh, ['issue', 'edit', String(n), '-R', repo, '--remove-label', 'status:ready-for-cline', '--add-label', 'status:in-progress']),
    postComment: (n, body) =>
      run(gh, ['api', `repos/${repo}/issues/${n}/comments`, '--input', '-'], {
        input: JSON.stringify({ body }),
      }),
    getIssue: (n) => JSON.parse(run(gh, ['api', `repos/${repo}/issues/${n}`])),
  };
}

export function remoteOriginUrl() {
  try {
    return run('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT });
  } catch {
    return '';
  }
}

export function repoFromOrigin() {
  return parseRepoFromRemoteUrl(remoteOriginUrl());
}

// GPT-REV-027: repo dùng cho MỌI GitHub read/mutation phải là repo từ origin đã qua preflight.
// GITHUB_REPOSITORY không bao giờ được tin độc lập — nếu tồn tại mà khác origin -> BLOCKED_REPO_MISMATCH.
export function repoMismatchStatus() {
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (!envRepo) return null;
  const originRepo = repoFromOrigin();
  if (!originRepo) return null; // không phải origin github (fixture local) — không so sánh được
  if (envRepo.trim().toLowerCase() !== originRepo.toLowerCase()) {
    return {
      status: 'BLOCKED_REPO_MISMATCH',
      repo: envRepo,
      originRepo,
      detail: 'GITHUB_REPOSITORY khác repository từ remote origin — không tin biến env độc lập (GPT-REV-027).',
      hint: 'Bỏ GITHUB_REPOSITORY hoặc sửa cho khớp origin của workspace đã preflight, rồi chạy lại.',
    };
  }
  return null;
}

export function resolveRepo() {
  // Test mode được xác thực rõ ràng bằng GITHUB_TASK_INTAKE_TEST=1 (fixture mock): dùng GITHUB_REPOSITORY
  // làm repo route cho mock gh (origin fixture là đường dẫn cục bộ, không phải github).
  const testMode = process.env.GITHUB_TASK_INTAKE_TEST === '1';
  if (testMode) {
    const envRepo = process.env.GITHUB_REPOSITORY;
    if (envRepo) return envRepo;
    const originRepo = repoFromOrigin();
    if (originRepo) return originRepo;
    throw new Error('Không xác định được repository (test mode): cần GITHUB_REPOSITORY hoặc origin github.');
  }
  // Production: repo = repo parse từ remote origin (đã qua preflight canonical cho --claim).
  // GITHUB_REPOSITORY là nguồn phụ bị RÀNG BUỘC (khác -> BLOCKED_REPO_MISMATCH), không tin độc lập.
  const repo = repoFromOrigin();
  if (repo) return repo;
  throw new Error('Không parse được repository từ remote origin — GITHUB_REPOSITORY không được tin độc lập (GPT-REV-027).');
}

export function worktreeStatusLines() {
  // KHÔNG dùng run() (nó .trim() toàn chuỗi -> mất space đầu của dòng porcelain " M a.txt"
  // -> slice(3) sai tên file). Xử lý từng dòng + bỏ CR khi git in CRLF (Windows).
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  return String(out)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map((l) => l.slice(3));
}

export function parseArgs(argv) {
  const args = { claim: false, claimNumber: null, gh: process.env.GITHUB_TASK_INTAKE_GH || 'gh' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claim') {
      args.claim = true;
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        args.claimNumber = Number(next);
        i++;
      }
    } else if (a === '--gh') {
      args.gh = argv[++i];
    }
  }
  return args;
}

export function allowedPrefixes() {
  const env = process.env.GITHUB_TASK_INTAKE_ALLOWED;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return ['memory-bank/'];
}

// ---------------------------------------------------------------- workspace preflight (Issue #20)
// Chạy TRƯỚC mọi mutation khi --claim. Trả PREFLIGHT_OK hoặc trạng thái chặn đầu tiên theo thứ tự
// ưu tiên: WRONG_REMOTE > branch safety (ACTIVE_ISSUE_BRANCH/DETACHED_HEAD/NO_BRANCH) > DIRTY_WORKTREE
// > ERROR_FETCH > STALE_BASE > MULTIPLE_WORKSPACES. Mọi chặn đều kèm hướng dẫn khắc phục; tuyệt đối
// KHÔNG mutation git/GitHub nào trước READY.

export function parseRepoFromRemoteUrl(url) {
  const m = String(url || '').trim().match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function normalizeRemoteUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = u.replace(/^(?:git@|ssh:\/\/git@)github\.com[:/]/i, 'https://github.com/');
  u = u.replace(/^git:\/\/github\.com\//i, 'https://github.com/');
  u = u.replace(/^https:\/\/github\.com\//i, '');
  u = u.replace(/\/+$/, '');
  if (u.toLowerCase().endsWith('.git')) u = u.slice(0, -4);
  return u.toLowerCase();
}

export function remoteIsCanonical(url, expectedRepo = CANONICAL_REPO) {
  // GPT-REV-028: KHÔNG đọc GITHUB_TASK_INTAKE_REMOTE_REPO — canonical chỉ từ hằng production
  // hoặc tham số DI tường minh (test). Env override đã bị loại khỏi production.
  return parseRepoFromRemoteUrl(url)?.toLowerCase() === String(expectedRepo).trim().toLowerCase();
}

export function baseSyncCheck({ localSha, remoteSha }) {
  if (!remoteSha) {
    return { status: 'BLOCKED_STALE_BASE', localSha, baseSha: null, detail: 'Không đọc được ref remote (origin/main hoặc origin/master) sau fetch — repo chưa có nhánh chính qua origin.' };
  }
  if (localSha !== remoteSha) {
    return {
      status: 'BLOCKED_STALE_BASE',
      localSha,
      baseSha: remoteSha,
      detail: `HEAD (${String(localSha).slice(0, 7)}) lệch base ${String(remoteSha).slice(0, 7)} sau fetch.`,
      hint: 'KHÔNG tự reset/stash/clean. Đồng bộ thủ công: `git fetch origin` rồi `git pull --ff-only origin <main|master>` — hoặc soát lại workspace — trước khi claim.',
    };
  }
  return { ok: true };
}

export function gitFetchResult() {
  try {
    run('git', ['fetch', 'origin'], { cwd: ROOT });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      status: 'ERROR_FETCH',
      error: String((e && e.message) || e),
      hint: 'Fail-closed: KHÔNG claim. Kiểm tra mạng/quyền fetch rồi chạy lại.',
    };
  }
}

export function originRefSha(branchName) {
  try {
    return run('git', ['rev-parse', `origin/${branchName}`], { cwd: ROOT });
  } catch {
    return null;
  }
}

export function siblingWorkspaceRoots({ parent, root, remoteUrl }) {
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const norm = normalizeRemoteUrl(remoteUrl);
  const rootResolved = path.resolve(root);
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(parent, e.name);
    // Windows: root từ git rev-parse dùng '/', path.join dùng '\' — phải resolve trước khi so sánh.
    if (path.resolve(dir) === rootResolved) continue;
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    let url;
    try {
      url = run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { cwd: ROOT });
    } catch {
      continue;
    }
    if (norm && normalizeRemoteUrl(url) === norm) found.push({ root: dir, remote: url });
  }
  return found;
}

export function runPreflight({ canonicalRepo = CANONICAL_REPO } = {}) {
  // GPT-REV-028: mọi override test-only (SKIP_REMOTE/SKIP_FETCH/PARENT) CHỈ có hiệu lực khi chế độ
  // test được xác thực rõ ràng (GITHUB_TASK_INTAKE_TEST=1). Production gọi runPreflight() trần ->
  // luôn đọc origin thật + kiểm tra canonical + fetch thật + đối chiếu HEAD với origin/main.
  const testMode = process.env.GITHUB_TASK_INTAKE_TEST === '1';
  const skipRemote = testMode && process.env.GITHUB_TASK_INTAKE_SKIP_REMOTE === '1';
  const skipFetch = testMode && process.env.GITHUB_TASK_INTAKE_SKIP_FETCH === '1';
  const parentOverride = testMode ? process.env.GITHUB_TASK_INTAKE_PARENT : null;

  let root;
  try {
    root = run('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT });
  } catch (e) {
    return { status: 'ERROR_GIT', error: String((e && e.message) || e), detail: 'Không xác định được repository root bằng Git — không suy đoán từ tên thư mục (Issue #20 rule 1).' };
  }

  let remoteUrl = '';
  if (skipRemote) {
    // test fixture: không chặn canonical, nhưng bản đồ remote vẫn cần cho MULTIPLE scan
    try {
      remoteUrl = run('git', ['remote', 'get-url', 'origin'], { cwd: ROOT });
    } catch {
      remoteUrl = '';
    }
  } else {
    try {
      remoteUrl = run('git', ['remote', 'get-url', 'origin'], { cwd: ROOT });
    } catch (e) {
      return {
        status: 'BLOCKED_WRONG_REMOTE',
        remote: '(không đọc được)',
        expected: canonicalRepo,
        detail: 'Thiếu remote origin — không xác minh được repository canonical.',
      };
    }
    if (!remoteIsCanonical(remoteUrl, canonicalRepo)) {
      return {
        status: 'BLOCKED_WRONG_REMOTE',
        remote: remoteUrl,
        expected: canonicalRepo,
        detail: 'Remote origin KHÔNG phải repository canonical duongpdddic-droid/AI_PR_REVIEWER.',
        hint: 'Sửa remote về canonical (`git remote set-url origin <url đúng>`) hoặc chuyển sang workspace đúng rồi chạy lại.',
      };
    }
  }

  const branch = gitBranchInfo();
  const safe = branchSafetyCheck(branch);
  if (!safe.ok) return { status: safe.reason, reason: safe.reason, detail: safe.detail };

  const statusLines = worktreeStatusLines();
  const blockers = worktreeBlockers(statusLines, allowedPrefixes());
  if (blockers.length) {
    return {
      status: 'BLOCKED_DIRTY_WORKTREE',
      files: blockers,
      hint: 'Working tree bẩn ngoài allowlist (mặc định memory-bank/). KHÔNG tự reset/stash/clean — dọn thủ công hoặc chuyển workspace sạch rồi chạy lại.',
    };
  }

  const headSha = run('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
  if (!skipFetch) {
    const f = gitFetchResult();
    if (!f.ok) return { status: f.status, error: f.error, hint: f.hint };
  }
  const remoteSha = originRefSha(branch.branchName);
  const baseSha = remoteSha || headSha;
  if (!skipFetch) {
    const sync = baseSyncCheck({ localSha: headSha, remoteSha });
    if (!sync.ok) {
      const { ok, ...rest } = sync;
      return rest;
    }
  }

  if (process.env.GITHUB_TASK_INTAKE_ALLOW_MULTI !== '1') {
    const parent = parentOverride || path.dirname(root);
    const dup = siblingWorkspaceRoots({ parent, root, remoteUrl });
    if (dup.length) {
      return {
        status: 'BLOCKED_MULTIPLE_WORKSPACES',
        root,
        duplicateWorkspaces: dup,
        detail: `Phát hiện ${dup.length} workspace khác cùng remote canonical trong thư mục cha (${parent}).`,
        hint: 'Chỉ 1 workspace vận hành duy nhất được phép claim. Xác minh PR của từng workspace cũ đã merge + tree sạch, rồi dọn/di chuyển các clone khác (CẦN người dùng cho phép — không tự xóa). Nếu Bố xác nhận workspace hiện tại là vận hành duy nhất: đặt GITHUB_TASK_INTAKE_ALLOW_MULTI=1 và ghi rõ lý do.',
      };
    }
  }

  return {
    status: 'PREFLIGHT_OK',
    root,
    remote: remoteUrl || null,
    remoteRepo: parseRepoFromRemoteUrl(remoteUrl) || null,
    baseSha,
    branch: branch.branchName || (branch.isDetached ? 'detached' : ''),
    cleanTree: true,
  };
}

// ---------------------------------------------------------------- branch safety (GPT-REV-003)

export function gitBranchInfo() {
  let branchName = '';
  let isDetached = false;
  try {
    const ref = run('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: ROOT });
    branchName = ref.replace(/^refs\/heads\//, '');
  } catch {
    isDetached = true;
  }
  return { branchName, isDetached };
}

// ---------------------------------------------------------------- local lock (GPT-REV-004 + 008 + 009 + 010 + 011)
// Mutex TỐI THIỂU cho cùng workspace — FAIL-CLOSED, dễ chứng minh invariant:
//   - Invariant 1 (tối đa 1 holder): lock CHỈ được tạo bằng openSync('wx') (atomic) — tại mọi thời
//     điểm nhiều nhất 1 tiến trình nhận ok:true trên cùng lockPath. Không ai có quyền thay lock:
//     không auto-takeover, không ghi đè, không rename shared lockPath.
//   - Invariant 2 (release chỉ của chủ): releaseLock đọc nội dung để VERIFY token trước; chỉ unlink
//     đúng token của mình. Caller sai token/owner cũ đọc thấy token lạ -> KHÔNG unlink (LOCK_OWNER_CHANGED)
//     — lock đang hoạt động không bao giờ bị di chuyển/biến mất (GPT-REV-011).
//   - Lock mồ côi (owner chết giữa chừng): mọi acquire sau đó nhận LOCKED + bằng chứng PID + hướng dẫn
//     xóa file thủ công khi chắc chắn không còn claim song song. KHÔNG tự động thu hồi (GPT-REV-010).
// cross-host KHÔNG được đảm bảo: chống trùng thực tế vẫn là marker `cline-claim` + read-after-write.

export function lockPathFor({ repo = 'default' } = {}) {
  const dir = process.env.GITHUB_TASK_INTAKE_LOCK_DIR || path.join(os.homedir(), '.ai-pr-reviewer');
  const safe = String(repo).replace(/[^A-Za-z0-9._-]/g, '-');
  return path.join(dir, `.github-task-intake-${safe}.lock`);
}

export function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    // ESRCH = tiến trình không tồn tại -> chết. Mọi lỗi khác (EPERM, đồng bộ...) -> fail-closed: coi là sống.
    return !(e && e.code === 'ESRCH');
  }
}

export function acquireLock({ lockPath, ownerPid = process.pid, now = Date.now() }) {
  const token = crypto.randomUUID();
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `token=${token}\npid=${ownerPid} at=${new Date(now).toISOString()}\n`);
    fs.closeSync(fd);
    return { ok: true, token };
  } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: 'LOCK_ERROR', error: String((e && e.message) || e) };
    // FAIL-CLOSED (GPT-REV-010): KHÔNG unlink/rename/ghi đè lock đang tồn tại — kể cả khi PID đã chết.
    // Chỉ đọc bằng chứng để tạo hướng dẫn; KHÔNG ra quyết định mutation từ dữ liệu đã đọc (hết read→takeover).
    try {
      const content = fs.readFileSync(lockPath, 'utf8');
      const pidMatch = content.match(/^pid=(\d+)/m);
      const pid = pidMatch ? Number(pidMatch[1]) : null;
      const ownerAlive = pid !== null && isProcessAlive(pid);
      const hint =
        `Lock đang tồn tại tại: ${lockPath} (owner pid ${pid ?? 'unknown'}${pid === null ? '' : ownerAlive ? ', CÒN SỐNG — đợi nó release' : ', đã chết (PID không còn sống)'}). ` +
        'Cơ chế fail-closed: không tự thu hồi lock. Nếu chắc chắn không còn tiến trình claim song song, ' +
        'xóa file ' + lockPath + ' thủ công rồi chạy lại.';
      return { ok: false, reason: 'LOCKED', ownerPid: pid, ownerAlive, hint };
    } catch (e2) {
      return {
        ok: false,
        reason: 'LOCKED',
        hint: `Lock tồn tại tại ${lockPath} nhưng không đọc được nội dung (${String((e2 && e2.message) || e2)}). Nếu chắc chắn không còn claim song song, xóa file đó thủ công rồi chạy lại.`,
      };
    }
  }
}

export function releaseLock({ lockPath, token }) {
  // FAIL-CLOSED (GPT-REV-011): KHÔNG rename/unlink trước khi xác minh ownership. Đọc → verify token →
  // chỉ unlink khi token khớp. Caller sai/owner cũ không bao giờ làm di chuyển/làm biến mất lock đang
  // hoạt động của người khác; không mở cửa sổ cho tiến trình thứ ba.
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const m = content.match(/^token=([^\s]+)/m);
    if (m && m[1] === token) {
      fs.unlinkSync(lockPath);
      return { released: true };
    }
    return { released: false, reason: 'LOCK_OWNER_CHANGED', hint: 'Token không khớp — lock thuộc owner khác, không xóa/không di chuyển nó.' };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { released: false, reason: 'LOCK_MISSING' };
    return { released: false, reason: 'LOCK_UNLINK_FAILED', error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------- main

const exit = (code) => { throw { __exit: code }; };

export function main() {
  const args = parseArgs(process.argv.slice(2));
  const gh = args.gh;
  // repo ban đầu best-effort (cho lock path + output). Production resolve KHẲNG ĐỊNH sau preflight
  // (origin canonical chắc chắn parse được); read-only bắt buộc có origin github (GPT-REV-027).
  let repo = null;
  try {
    repo = resolveRepo();
  } catch {
    repo = null;
  }
  let out = { status: 'ERROR', repo };
  const allowed = allowedPrefixes();

  let exitCode = 0;
  let lock = null;
  let preflight = null;
  const lockPath = lockPathFor({ repo: repo || 'preflight' });
  try {
    // GPT-REV-027: repo cho MỌI GitHub read/mutation phải khớp origin đã preflight. Chặn trước
    // lock và trước bất kỳ call GitHub nào (kể cả read-only list) — không tin GITHUB_REPOSITORY.
    const mismatch = repoMismatchStatus();
    if (mismatch) {
      print({ ...out, ...mismatch });
      exit(1);
    }

    if (args.claim) {
      lock = acquireLock({ lockPath });
      if (!lock.ok) {
        print({ ...out, status: 'BLOCKED_LOCKED', detail: lock.reason + (lock.hint ? ': ' + lock.hint : '') + (lock.error ? ' (' + lock.error + ')' : '') });
        exit(1);
      }

      // Issue #20: preflight workspace/Git TRƯỚC mọi mutation — thất bại = dừng theo hướng dẫn.
      // Chạy TRƯỚC resolveRepo để origin sai/không parse được vẫn bị chặn bởi preflight
      // (production không bao giờ rơi về GITHUB_REPOSITORY — GPT-REV-027).
      preflight = runPreflight();
      if (!preflight || preflight.status !== 'PREFLIGHT_OK') {
        print({ ...out, ...(preflight || { status: 'ERROR_PREFLIGHT' }) });
        exit(1);
      }
      if (!repo) {
        repo = resolveRepo(); // production sau preflight OK: origin canonical -> parse được
        out = { status: 'ERROR', repo };
      }
    } else if (!repo) {
      print({ status: 'ERROR', error: 'Không parse được repository từ remote origin — GITHUB_REPOSITORY không được tin độc lập (GPT-REV-027).' });
      exit(1);
    }

    const tasks = filterReadyTasks(JSON.parse(run(gh, ['api', '--paginate', `repos/${repo}/issues?state=open&per_page=100`]) || '[]'));

    if (!args.claim) {
      if (tasks.length === 0) {
        print({ ...out, status: 'NO_TASK' });
        exit(0);
      }
      print({ ...out, status: 'TASKS_FOUND', tasks: tasks.map(safeTaskPayload) });
      exit(0);
    }

    // base = SHA origin/main sau fetch (Issue #20 rule 3-4) — không bao giờ HEAD cũ.
    const baseSha = preflight.baseSha;
    const now = new Date().toISOString();
    const deps = makeRealDeps({ repo, gh });
    const result = claimWorkflow({ tasks, requestedNumber: args.claimNumber, baseSha, now, deps });
    print({
      ...out,
      ...result,
      preflight: {
        root: preflight.root,
        remote: preflight.remote,
        remoteRepo: preflight.remoteRepo,
        baseSha: preflight.baseSha,
        branch: preflight.branch,
        cleanTree: preflight.cleanTree,
      },
    });
    exitCode = result.status === 'CLAIMED' || result.status === 'ALREADY_CLAIMED' ? 0 : 1;
  } catch (e) {
    if (e && e.__exit !== undefined) {
      exitCode = e.__exit;
    } else {
      print({ ...out, error: String((e && e.message) || e) });
      exitCode = 1;
    }
  } finally {
    if (lock && lock.ok) releaseLock({ lockPath, token: lock.token });
  }
  process.exit(exitCode);
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
