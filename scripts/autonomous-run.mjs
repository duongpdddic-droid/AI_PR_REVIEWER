#!/usr/bin/env node
// autonomous-run.mjs — Orchestrator đóng vòng (single trigger → hoàn tất).
// Thay thế luồng rời rạc pipeline-run/g2-runner/reviewer-orchestrator bằng 1 vòng khép kín:
//   claim issue → tạo task branch → coder (aider headless) → verify → review/fix (≤3 vòng)
//   → commit → push → draft PR → BÀN GIAO GPT REVIEW (KHÔNG tự approve — quyền reviewer) → label → notify Telegram.
//
// An toàn:
//   - Mặc định DRY-RUN (chỉ in kế hoạch + đọc, KHÔNG mutation). Cần `--execute` để mutation thật.
//   - `--loop` quét liên tục (poll) với khoảng nghỉ; mặc định chạy 1 chu kỳ.
//   - Claim đi qua subprocess `node scripts/github-task-intake.mjs --claim` (fail-closed + preflight + lock).
//   - Mọi lệnh git/gh/aider dùng execFileSync (không qua shell).
//
// Cách dùng:
//   node scripts/autonomous-run.mjs                 # dry-run 1 chu kỳ
//   node scripts/autonomous-run.mjs --execute       # thực thi 1 chu kỳ
//   node scripts/autonomous-run.mjs --execute --loop # vòng lặp dài hạn (daemon)
//   node scripts/autonomous-run.mjs --execute --loop --interval 120000
//   node scripts/autonomous-run.mjs --no-aider      # bỏ qua bước coder LLM (chỉ verify hiện trạng)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseClaimResult,
  isClaimSuccess,
  planReview,
  branchNameFor,
  summarizeVerify,
  LABELS,
  AGENTS,
} from './autonomous-core.mjs';

const ROOT = process.cwd();
const NODE = process.execPath;
const CONFIG_PATH = path.join(ROOT, '.agent', 'config.json');
const CONFIG = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const REPO = CONFIG.repo || null;
const AIDER = CONFIG.aiderPath || 'aider';
const NO_AIDER = process.argv.includes('--no-aider');

function log(msg) {
  console.log(`[autonomous] ${msg}`);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function runQuiet(cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (e) {
    // Khi subprocess exit != 0, execFileSync ném exception: stdout/stderr vẫn được buffer.
    // Intake in JSON ra stdout (kể cả khi exit 1) → ưu tiên đọc e.stdout trước stderr/message.
    const out = e && e.stdout ? String(e.stdout) : String((e && e.stderr) || (e && e.message) || e);
    return { ok: false, out };
  }
}

function runInteractive(cmd, args, cwd = ROOT) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function git(args) {
  return run('git', args);
}

function currentBranch() {
  try {
    return git(['branch', '--show-current']);
  } catch {
    return '';
  }
}

function ensureOnMain() {
  const b = currentBranch();
  if (b !== 'main' && b !== 'master') {
    throw new Error(`Đang ở nhánh ${b || '(detached)'} — phải ở main/master trước khi claim.`);
  }
}

function branchExists(branch) {
  return runQuiet('git', ['rev-parse', '--verify', `refs/heads/${branch}`]).ok;
}

function createTaskBranch(issueNumber, title, baseSha) {
  const name = branchNameFor(issueNumber, title);
  if (branchExists(name)) {
    log(`Nhánh ${name} đã tồn tại → chuyển sang.`);
    git(['checkout', name]);
    return name;
  }
  const base = baseSha || 'main';
  log(`Tạo nhánh ${name} từ ${base}...`);
  git(['checkout', '-b', name, base]);
  return name;
}

function runVerify(cwd = ROOT) {
  const r = runQuiet(NODE, [path.join(ROOT, 'scripts', 'full-verify.mjs')], { cwd });
  return { ok: r.ok, out: r.out };
}

function runCoder(issueNumber, issueBody) {
  if (NO_AIDER) {
    log('--no-aider: bỏ qua bước coder LLM (chỉ verify hiện trạng branch).');
    return true;
  }
  const conventions = path.join(ROOT, '.agent', 'conventions-coder.md');
  const readArgs = fs.existsSync(conventions) ? ['--read', conventions] : [];
  const msg = `Nhận Issue #${issueNumber}, triển khai code theo phạm vi và tiêu chí nghiệm thu trong issue, chỉ sửa đúng phạm vi được phép. Sau khi xong chạy \`node scripts/full-verify.mjs\` và đảm bảo PASS. Không tự merge, không tự commit (orchestrator sẽ commit), không deploy.\n\n--- ISSUE ---\n${issueBody || ''}`;
  try {
    runInteractive(AIDER, [...readArgs, '--message', msg, '--yes-always', '--no-auto-commits'], ROOT);
    return true;
  } catch (e) {
    log(`Aider coder lỗi: ${String((e && e.message) || e)}`);
    return false;
  }
}

function runFixCoder(issueNumber, findingSummary) {
  if (NO_AIDER) return true;
  const conventions = path.join(ROOT, '.agent', 'conventions-coder.md');
  const readArgs = fs.existsSync(conventions) ? ['--read', conventions] : [];
  const msg = `Sửa các lỗi verify trên issue #${issueNumber} (tóm tắt: ${findingSummary}) rồi chạy \`node scripts/full-verify.mjs\` cho PASS. Không tự merge, không tự commit.`;
  try {
    runInteractive(AIDER, [...readArgs, '--message', msg, '--yes-always', '--no-auto-commits'], ROOT);
    return true;
  } catch (e) {
    log(`Aider fix lỗi: ${String((e && e.message) || e)}`);
    return false;
  }
}

function hasUncommitted() {
  const status = runQuiet('git', ['status', '--porcelain']);
  return status.ok && status.out !== '';
}

function commitAndPush(branch, issueNumber) {
  if (!hasUncommitted()) {
    log('Không có thay đổi để commit — bỏ qua commit/push.');
    return true;
  }
  git(['add', '-A']);
  git(['commit', '-m', `feat: implement issue #${issueNumber}`]);
  git(['push', '-u', 'origin', branch]);
  return true;
}

function createDraftPR(branch, issueNumber) {
  const title = `Draft PR for issue #${issueNumber}`;
  const body = `Closes #${issueNumber}\n\nTự động tạo bởi scripts/autonomous-run.mjs (closed-loop orchestrator).`;
  return run('gh', ['pr', 'create', '--repo', REPO, '--head', branch, '--base', 'main', '--title', title, '--body', body, '--draft']).trim();
}

function prForBranch(branch) {
  const r = runQuiet('gh', ['pr', 'list', '--repo', REPO, '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number']);
  return r.ok && r.out ? Number(r.out) : null;
}

function addIssueLabel(issueNumber, label) {
  if (!REPO) return;
  runQuiet('gh', ['issue', 'edit', String(issueNumber), '--repo', REPO, '--add-label', label]);
}

function removeIssueLabel(issueNumber, label) {
  if (!REPO) return;
  runQuiet('gh', ['issue', 'edit', String(issueNumber), '--repo', REPO, '--remove-label', label]);
}

function postComment(issueNumber, body) {
  if (!REPO) return;
  runQuiet('gh', ['issue', 'comment', String(issueNumber), '--repo', REPO, '--body', body]);
}

function notifyTelegram(eventType, ref, state, summary, nextAction) {
  const script = path.join(ROOT, 'scripts', 'notify-telegram.mjs');
  if (!fs.existsSync(script)) return;
  const payload = JSON.stringify({
    eventType,
    repo: REPO || 'AI_PR_REVIEWER',
    ref: ref || '',
    state,
    summary,
    nextAction,
  });
  const tmp = path.join(ROOT, '.autonomous-notify.json');
  fs.writeFileSync(tmp, payload);
  try {
    const r = runQuiet(NODE, [script, '--event-file', tmp]);
    log(`Telegram notify (${eventType}): ${r.ok ? 'SENT' : 'FAILED ' + r.out}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function processOneCycle({ dryRun }) {
  log(`=== Chu kỳ (${dryRun ? 'DRY-RUN' : 'EXECUTE'}) ===`);

  // 1. Phát hiện issue (read-only khi dry-run; claim thật khi execute).
  // Lưu ý: github-task-intake.mjs LUÔN in JSON ra stdout, kể cả khi exit != 0 (trạng thái
  // blocked như BLOCKED_DIRTY_WORKTREE / BLOCKED_LOCKED / BLOCKED_STALE_BASE). Vì vậy phải
  // parse JSON trước; chỉ coi là lỗi "không chạy được" khi output KHÔNG parse được JSON.
  const intakeArgs = dryRun ? [] : ['--claim'];
  const claimRaw = runQuiet(NODE, [path.join(ROOT, 'scripts', 'github-task-intake.mjs'), ...intakeArgs]);
  const parsed = parseClaimResult(claimRaw.out);
  if (parsed.status === 'ERROR') {
    log(`Intake không chạy được hoặc output không phải JSON: ${claimRaw.out}`);
    return { status: 'ERROR', detail: claimRaw.out };
  }

  if (dryRun) {
    if (parsed.status === 'NO_TASK') {
      log('Không có issue sẵn sàng claim (dry-run).');
      return { status: 'NO_TASK' };
    }
    if (parsed.status !== 'TASKS_FOUND' || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      log(`Dry-run intake trả trạng thái bất ngờ: ${parsed.status}`);
      return { status: parsed.status, detail: parsed.error };
    }
    const task = parsed.tasks[0];
    log(`[DRY-RUN] Phát hiện Issue #${task.number} (${task.title}). Sẽ claim → tạo nhánh ${branchNameFor(task.number, task.title)} → coder → verify → review/fix → commit → draft PR → bàn giao GPT review.`);
    return { status: 'DRY_RUN_PLAN', issueNumber: task.number };
  }

  if (!isClaimSuccess(parsed.status)) {
    log(`Không có issue sẵn sàng claim: ${parsed.status} ${parsed.error || ''}`);
    return { status: parsed.status, detail: parsed.error };
  }
  const issueNumber = parsed.number;
  log(`Đã claim Issue #${issueNumber} (base ${parsed.baseSha || '?'}).`);

  // 2. Tạo task branch.
  let branch;
  try {
    ensureOnMain();
    branch = createTaskBranch(issueNumber, parsed.task?.title || '', parsed.baseSha);
  } catch (e) {
    log(`Lỗi tạo branch: ${e.message}`);
    addIssueLabel(issueNumber, LABELS.blocked);
    notifyTelegram('blocked', `#${issueNumber}`, 'blocked', String(e.message), 'Xem lại workspace/branch rồi chạy lại.');
    return { status: 'BLOCKED', issueNumber, detail: String(e.message) };
  }

  // 3. Coder.
  const coderOk = runCoder(issueNumber, parsed.task?.body || '');
  if (!coderOk) {
    log('Coder thất bại.');
    addIssueLabel(issueNumber, LABELS.blocked);
    notifyTelegram('test-fail', `#${issueNumber}`, 'blocked', 'Aider coder thất bại', 'Kiểm tra cấu hình aider rồi chạy lại.');
    return { status: 'CODER_FAILED', issueNumber };
  }

  // 4. Verify + review/fix loop (≤3 vòng).
  let round = 0;
  let finalVerify = { ok: false, out: '' };
  for (;;) {
    finalVerify = runVerify();
    log(`Verify vòng ${round}: ${finalVerify.ok ? 'PASS' : 'FAIL'} (${summarizeVerify(finalVerify.out)})`);
    if (finalVerify.ok) break;
    const decision = planReview({ verifyOk: false, round });
    if (decision.action === 'block') {
      log('Đã đạt giới hạn vòng fix mà vẫn FAIL → chuyển blocked.');
      addIssueLabel(issueNumber, LABELS.blocked);
      postComment(issueNumber, `❌ Sau ${round} vòng fix, verify vẫn FAIL:\n\`\`\`\n${finalVerify.out}\n\`\`\``);
      notifyTelegram('test-fail', `#${issueNumber}`, 'blocked', `Verify vẫn FAIL sau ${round} vòng`, 'Xem lại scope/issue hoặc can thiệp thủ công.');
      return { status: 'BLOCKED_VERIFY', issueNumber, round };
    }
    const findingSummary = summarizeVerify(finalVerify.out);
    runFixCoder(issueNumber, findingSummary);
    round += 1;
  }

  // 5. Commit + push + draft PR.
  commitAndPush(branch, issueNumber);
  const existingPr = prForBranch(branch);
  let prNumber = existingPr;
  let prUrl = '';
  if (!prNumber) {
    try {
      prUrl = createDraftPR(branch, issueNumber);
      prNumber = prForBranch(branch);
      log(`Đã mở draft PR #${prNumber}: ${prUrl}`);
    } catch (e) {
      log(`Mở PR lỗi: ${String(e.message)}`);
      addIssueLabel(issueNumber, LABELS.blocked);
      return { status: 'PR_CREATE_FAILED', issueNumber, detail: String(e.message) };
    }
  } else {
    log(`PR #${prNumber} đã tồn tại cho nhánh ${branch}.`);
  }

  // 6. Bàn giao cho GPT review (theo AGENT_HANDOFF_PROTOCOL §4: Cline KHÔNG tự approve/merge).
  //    Chuyển label: status:in-progress + agent:cline → status:review-requested + agent:gpt.
  addIssueLabel(issueNumber, LABELS.reviewRequested);
  addIssueLabel(issueNumber, AGENTS.gpt);
  removeIssueLabel(issueNumber, LABELS.inProgress);
  removeIssueLabel(issueNumber, AGENTS.cline);
  postComment(issueNumber, `✅ Đã triển khai, verify PASS, draft PR #${prNumber} bàn giao GPT review.\nCloses #${issueNumber}`);

  notifyTelegram('done', `#${issueNumber}`, 'status:ready-for-gpt-review', `Verify PASS, draft PR #${prNumber}`, 'GPT review, sau đó người dùng merge PR.');

  log(`Hoàn tất Issue #${issueNumber} → PR #${prNumber} (review-requested, chờ GPT).`);
  return { status: 'DONE', issueNumber, prNumber, prUrl, round };
}

function parseArgs(argv) {
  return {
    execute: argv.includes('--execute'),
    loop: argv.includes('--loop'),
    interval: (() => {
      const i = argv.indexOf('--interval');
      return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 120000;
    })(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  log(`Bắt đầu (execute=${args.execute}, loop=${args.loop}, interval=${args.interval}ms).`);
  if (!args.loop) {
    const res = processOneCycle({ dryRun: !args.execute });
    log(`Kết quả chu kỳ: ${res.status}`);
    const ok = res.status === 'DONE' || res.status === 'NO_TASK' || res.status === 'DRY_RUN_PLAN';
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const tick = () => {
    try {
      processOneCycle({ dryRun: !args.execute });
    } catch (e) {
      log(`Chu kỳ lỗi: ${String((e && e.message) || e)}`);
    }
  };
  tick();
  setInterval(tick, args.interval);
  log(`Loop mode: chạy lại sau ${args.interval}ms. Ctrl+C để dừng.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
