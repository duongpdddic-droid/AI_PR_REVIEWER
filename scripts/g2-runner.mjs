#!/usr/bin/env node
// g2-runner.mjs — Giai đoạn 2 (claim issue, worktree, verify, label, comment).

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Load config (để lấy telegram nếu muốn)
const CONFIG_PATH = path.resolve('reviewer-agent', 'reviewer.config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const REPO = CONFIG.repo;
const TELEGRAM_CHAT = CONFIG.telegramChat || null;

function notifyTelegram(event, msg) {
  if (!TELEGRAM_CHAT) return;
  try { execSync(`node scripts/notify-telegram.mjs ${event} "${msg}"`, { stdio: 'ignore' }); } catch {}
}

async function main() {
  // 1. Claim first ready‑for‑cline issue
  const claimRaw = execSync('node scripts/github-task-intake.mjs --claim', { encoding: 'utf8' });
  const claim = JSON.parse(claimRaw.trim());
  if (claim.status !== 'CLAIMED' && claim.status !== 'ALREADY_CLAIMED') {
    console.error('No claimable issue', claim);
    process.exit(1);
  }
  const issueNumber = claim.number;

  // 2. Gán nhãn reviewer:local (đánh dấu đang xử lý)
  execSync(`gh issue edit ${issueNumber} --repo ${REPO} --add-label reviewer:local`, { stdio: 'ignore' });

  // 3. Thiết lập worktree cho reviewer (đọc đã có trong config.worktree)
  const worktreePath = path.resolve(CONFIG.worktree);
  // Xóa nếu tồn tại
  try { execSync(`git worktree prune && git worktree remove -f ${worktreePath}`, { stdio: 'ignore' }); } catch {}
  execSync(`git worktree add ${worktreePath} main`, { stdio: 'ignore' });

  // 4. Chạy deterministic runner (full‑verify) trong worktree
  const verifyResult = execSync('node scripts/full-verify.mjs', { cwd: worktreePath, encoding: 'utf8' });
  // Kiểm tra mã thoát 0 (full‑verify trả về 0 nếu mọi test PASS)
  // Khi có lỗi, sẽ ném ngoại lệ → catch ở cuối.

  // 5. Đăng comment trên issue – PASS
  const comment = `✅ Kiểm thử full‑verify PASS cho issue #${issueNumber}.`; 
  execSync(`gh issue comment ${issueNumber} --repo ${REPO} --body "${comment}"`, { stdio: 'ignore' });

  // 6. Thông báo Telegram
  notifyTelegram('done', `Issue #${issueNumber} đã được claim, worktree chuẩn bị, full‑verify PASS.`);

  console.log('G2 completed for issue', issueNumber);
}

main().catch(err => { console.error('G2 error:', err.message); process.exit(1); });
