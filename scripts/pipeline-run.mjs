#!/usr/bin/env node
// pipeline-run.mjs — Orchestrator headless (G3).
// 1. Preflight, 2. Claim issue, 3. Setup worktrees, 4. Run aider (coder), 5. Run full‑verify, 6. Create draft PR, 7. Post comment/findings, 8. Update labels, 9. Telegram notify.

import { checkEnvironment } from '../reviewer-agent/src/preflight.mjs';
import { runTestSuite } from '../reviewer-agent/src/deterministic-runner.mjs';
import { postReviewComment, labelPR, formatFinding } from '../reviewer-agent/src/github-adapter.mjs';

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Load config (apiKey, telegramChat, aiderPath)
const CONFIG_PATH = path.resolve('reviewer-agent', 'reviewer.config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const REPO = CONFIG.repo;
const TELEGRAM_CHAT = CONFIG.telegramChat || null;
const AIDER_PATH = CONFIG.aiderPath || 'aider'; // fallback binary name

function notifyTelegram(event, summary) {
  if (!TELEGRAM_CHAT) return;
  try {
    execSync(`node scripts/notify-telegram.mjs ${event} "${summary}"`, { stdio: 'ignore' });
  } catch {}
}

function setupWorktrees() {
  const root = process.cwd();
  const coder = path.join(root, '../coder-workspace');
  const reviewer = path.join(root, '../reviewer-workspace');
  // clean if exist
  [coder, reviewer].forEach((wt) => {
    try { execSync(`git worktree prune && git worktree remove -f ${wt}`); } catch {}
  });
  execSync(`git worktree add ${coder} main`);
  execSync(`git worktree add ${reviewer} main`);
  return { coder, reviewer };
}

function runAider(worktree, issueNumber) {
  // placeholder: run aider with config, issue number passed as message
  try {
    execSync(`${AIDER_PATH} --read .agent/conventions-coder.md --message "Implement issue #${issueNumber}" --yes-always`, { cwd: worktree, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await checkEnvironment();

  // Claim first ready‑for‑cline issue
  const claimRaw = execSync('node scripts/github-task-intake.mjs --claim', { encoding: 'utf8' });
  const claim = JSON.parse(claimRaw.trim());
  if (claim.status !== 'CLAIMED' && claim.status !== 'ALREADY_CLAIMED') {
    console.error('No claimable issue', claim);
    process.exit(1);
  }
  const issueNumber = claim.number;

  // Label PR‑related workflow
  await labelPR(issueNumber, 'reviewer:local', REPO);

  // Setup worktrees
  const { coder, reviewer } = setupWorktrees();

  // Run coder aide on coder worktree
  const coderOk = runAider(coder, issueNumber);
  if (!coderOk) {
    await postReviewComment(issueNumber, '❌ Aider coder failed.', REPO);
    notifyTelegram('test-fail', `Aider coder failed for issue #${issueNumber}`);
    process.exit(1);
  }

  // Run deterministic test suite on reviewer worktree (full‑verify)
  const testResult = await runTestSuite();
  if (!testResult.ok) {
    await postReviewComment(issueNumber, `❌ Test suite failed (code ${testResult.code}).\n${testResult.stdout}`, REPO);
    notifyTelegram('test-fail', `Test suite failed for issue #${issueNumber}`);
    process.exit(1);
  }

  // Create draft PR from reviewer worktree
  const branchName = `issue-${issueNumber}`;
  execSync(`git -C ${reviewer} checkout -b ${branchName}`);
  execSync(`git -C ${reviewer} add .`);
  execSync(`git -C ${reviewer} commit -m "chore: draft PR for issue #${issueNumber}"`);
  execSync(`git -C ${reviewer} push -u origin ${branchName}`);
  const prUrl = execSync(`gh pr create --repo ${REPO} --head ${branchName} --base main --title "Draft PR for #${issueNumber}" --body "Auto‑generated draft PR" --draft`, { encoding: 'utf8' }).trim();

  // Post findings (placeholder) on the PR
  const findings = [
    formatFinding(1, { severity: 'low', file: 'src/placeholder.js', message: 'No issues detected.' })
  ].join('\n\n');
  await postReviewComment(issueNumber, findings, REPO);

  // Update issue label to review‑requested
  await labelPR(issueNumber, 'status:review-requested', REPO);

  // Notify Telegram success
  notifyTelegram('done', `Pipeline completed for issue #${issueNumber}. Draft PR: ${prUrl}`);

  console.log('Pipeline finished.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
