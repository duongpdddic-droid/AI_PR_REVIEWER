#!/usr/bin/env node
// agent-runner.mjs — Universal Orchestrator Runner (Headless Stage-2).
// Quét trạng thái GitHub của một TARGET_REPO rồi dispatch Aider CLI (Coder / Reviewer)
// trên worktree riêng. Dựa trên MO_TA_AI_PR_VIEWER.MD §5.
//
// Dùng: node scripts/agent-runner.mjs <đường-dẫn-repo>
//   - repo mặc định = cwd (thường là repo reviewer; coder/reviewer worktree là siblings).
//   - Đọc .agent/config.json của TARGET_REPO.
//   - Coder worktree = <target>/../<coderWorkspace>; Reviewer worktree = <target>/../<reviewerWorkspace>.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET_REPO = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const CONFIG_PATH = path.join(TARGET_REPO, '.agent', 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`❌ Không tìm thấy cấu hình tại: ${CONFIG_PATH}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const coderDir = path.resolve(TARGET_REPO, '..', config.coderWorkspace || 'coder-workspace');
const reviewerDir = path.resolve(TARGET_REPO, '..', config.reviewerWorkspace || 'reviewer-workspace');

function run(cmd, cwd = TARGET_REPO) {
  console.log(`\n⚡ [EXEC trong ${path.basename(cwd)}]: ${cmd}`);
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'inherit' });
}

function query(cmd, cwd = TARGET_REPO) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function orchestrate() {
  console.log(`\n🔍 [${config.project_name || config.project}] QUÉT TRẠNG THÁI TASK GITHUB...`);

  // 1. PR cần Review → Aider Reviewer
  const reviewPr = query(
    `gh pr list --state open --label "${config.labels.review_requested}" ` +
    `--limit 1 --json number --jq ".[0].number"`,
    reviewerDir
  );
  if (reviewPr) {
    const systemPrompt = path.join(TARGET_REPO, config.promptsDir || 'reviewer-agent/prompts', 'system-reviewer.md');
    console.log(`🧐 PR #${reviewPr} chờ review. Khởi chạy Aider Reviewer...`);
    const extraRead = fs.existsSync(systemPrompt) ? `--read "${systemPrompt}"` : '';
    run(
      `aider --read .agent/conventions-reviewer.md ${extraRead} --message "Audit PR #${reviewPr} theo đúng tiêu chuẩn trong .agent/conventions-reviewer.md. Đăng finding theo schema reviewer-agent/prompts/finding-schema.md." --yes-always --no-auto-commits`,
      reviewerDir
    );
    return;
  }

  // 2. PR bị Changes Requested → Aider Coder
  const fixPr = query(
    `gh pr list --state open --label "${config.labels.changes_requested}" ` +
    `--limit 1 --json number --jq ".[0].number"`,
    coderDir
  );
  if (fixPr) {
    console.log(`🔧 PR #${fixPr} cần sửa lỗi. Khởi chạy Aider Coder...`);
    run(
      `aider --read .agent/conventions-coder.md --message "Đọc review comments trên PR #${fixPr}, sửa các finding [*-REV-xxx] và trả lời [AIDER-FIX-*]." --yes-always --no-auto-commits`,
      coderDir
    );
    return;
  }

  // 3. Issue mới → Aider Coder
  const newIssue = query(
    `gh issue list --state open --label "${config.labels.ready_to_code}" ` +
    `--limit 1 --json number --jq ".[0].number"`,
    coderDir
  );
  if (newIssue) {
    console.log(`🚀 Issue #${newIssue} mới. Khởi chạy Aider Coder...`);
    run(
      `aider --read .agent/conventions-coder.md --message "Nhận Issue #${newIssue}, triển khai code và tạo Draft PR theo .agent/conventions-coder.md." --yes-always --no-auto-commits`,
      coderDir
    );
    return;
  }

  console.log('💤 Không có task nào ở trạng thái chờ.');
}

orchestrate().catch((e) => { console.error(e); process.exit(1); });