#!/usr/bin/env node
// unified-orchestrator.mjs — Orchestrator chuẩn ĐA REPO cho AI_PR_REVIEWER.
//
// Quét PR `status:review-requested` trên targetRepos trong `.agent/config.json`
// (loại repo của chính reviewer) và route kết quả CI cho Cline dự án:
//   - CI PASS    → giữ status:review-requested, thêm agent:gpt (KHÔNG tự approve).
//   - CI FAIL    → status:changes-requested + agent:cline trên PR, đồng thời tạo issue
//                  `[review-fix]` (agent:cline + status:ready-for-cline) trong target repo
//                  để Cline dự án nhận việc qua github-task-intake. Còn issue [review-fix]
//                  mở → không tạo trùng. Vượt maxReviewRounds vòng → status:blocked.
//   - CI pending → không mutation, chờ chu kỳ sau.
//
// An toàn: mặc định DRY-RUN; gh dùng execFileSync mảng args; không checkout/reset/clean.
// Cách dùng:
//   node scripts/unified-orchestrator.mjs                 # dry-run 1 chu kỳ
//   node scripts/unified-orchestrator.mjs --execute       # thực thi 1 chu kỳ
//   node scripts/unified-orchestrator.mjs --execute --loop --interval 300000

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeTargetRepos,
  externalTargetRepos,
  LABELS,
  AGENTS,
  planRouting,
  nextFixRound,
} from './autonomous-core.mjs';

const ROOT = process.cwd();

// ---------------------------------------------------------------- pure helpers

export function resolveTargets(config) {
  const cfg = config || {};
  return externalTargetRepos(normalizeTargetRepos(cfg), cfg.repo);
}

// `gh pr checks`: 0 = PASS, 8 = còn pending, khác = FAIL/lỗi.
export function classifyChecks({ ok, status }) {
  if (ok) return 'pass';
  if (Number(status) === 8) return 'pending';
  return 'fail';
}

// ---------------------------------------------------------------- IO helpers

function runGH(args) {
  return execFileSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runQuiet(args) {
  try {
    return { ok: true, status: 0, out: runGH(args) };
  } catch (e) {
    return {
      ok: false,
      status: e && typeof e.status === 'number' ? e.status : null,
      out: String((e && e.stdout) || (e && e.stderr) || (e && e.message) || e),
    };
  }
}

function loadConfig() {
  const p = path.join(ROOT, '.agent', 'config.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listReviewPRs(repo, label) {
  const r = runQuiet(['pr', 'list', '--repo', repo, '--state', 'open', '--label', label, '--json', 'number,title,url,labels']);
  if (!r.ok) throw new Error(`gh pr list lỗi cho ${repo}: ${r.out}`);
  try {
    const arr = JSON.parse(r.out || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function checksStatus(repo, prNumber) {
  const r = runQuiet(['pr', 'checks', String(prNumber), '--repo', repo]);
  return classifyChecks({ ok: r.ok, status: r.status });
}

// Các issue [review-fix] đã tồn tại cho 1 PR (mọi trạng thái) — dùng để đếm vòng + idempotent.
function listFixIssues(repo, prNumber) {
  const r = runQuiet([
    'issue', 'list', '--repo', repo, '--state', 'all',
    '--search', `review-fix PR #${prNumber} in:title`,
    '--limit', '50', '--json', 'number,title,state',
  ]);
  if (!r.ok) return [];
  try {
    const arr = JSON.parse(r.out || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Đảm bảo nhãn tồn tại trong repo trước khi gắn (gh không tự tạo label khi tạo issue).
function ensureLabels(repo, labels) {
  for (const l of labels || []) {
    try {
      runGH(['label', 'create', l, '--repo', repo, '--force']);
    } catch {} // đã tồn tại hoặc lỗi riêng của 1 label → bỏ qua, không chặn vòng xử lý
  }
}

function createFixIssue(repo, issue) {
  const args = ['issue', 'create', '--repo', repo, '--title', issue.title, '--body', issue.body];
  for (const l of issue.labels) args.push('--label', l);
  return runGH(args).trim();
}

// Thông báo Telegram fire-and-forget (protocol §11) — lỗi không chặn vòng xử lý.
function notifyLocal(title, summary) {
  try {
    spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'notify-telegram.mjs'), String(title), String(summary)], { stdio: 'ignore' });
  } catch {}
}

function labelFlags(flag, labels) {
  return (labels || []).flatMap((l) => [flag, l]);
}

function applyHandoff(repo, prNumber, plan) {
  if (plan.removeLabels.length) {
    runGH(['pr', 'edit', String(prNumber), '--repo', repo, ...labelFlags('--remove-label', plan.removeLabels)]);
  }
  if (plan.addLabels.length) {
    runGH(['pr', 'edit', String(prNumber), '--repo', repo, ...labelFlags('--add-label', plan.addLabels)]);
  }
  runGH(['pr', 'comment', String(prNumber), '--repo', repo, '--body', plan.comment]);
}

// ---------------------------------------------------------------- vòng xử lý

function processOneCycle({ dryRun = true } = {}) {
  const cfg = loadConfig();
  if (!cfg) return { status: 'NO_CONFIG' };

  const targets = resolveTargets(cfg);
  const reviewLabel = (cfg.labels && cfg.labels.review_requested) || LABELS.reviewRequested;

  if (!targets.length) {
    console.log('[unified] Không có repo mục tiêu nào ngoài repo chính (kiểm tra targetRepos).');
    return { status: 'NO_TARGETS' };
  }

  let scanned = 0;
  let mutated = 0;

  for (const repo of targets) {
    let prs;
    try {
      prs = listReviewPRs(repo, reviewLabel);
    } catch (e) {
      console.log(`[unified] ⚠️ ${repo}: ${String((e && e.message) || e)}`);
      continue;
    }

    if (!prs.length) {
      console.log(`[unified] 💤 ${repo}: không có PR chờ review.`);
      continue;
    }

    for (const pr of prs) {
      scanned += 1;
      const prLabels = Array.isArray(pr.labels) ? pr.labels.map((l) => l.name || l) : [];
      console.log(`[unified] 🔍 ${repo}#${pr.number} ${pr.title || '(không tiêu đề)'}`);

      if (prLabels.includes(AGENTS.gpt)) {
        console.log('[unified] ⏭️ Đã bàn giao GPT trước đó — bỏ qua (chống xử lý lại).');
        continue;
      }

      if (dryRun) {
        console.log('[unified] dry-run: chỉ quét, không mutation.');
        continue;
      }

      const state = checksStatus(repo, pr.number);
      if (state === 'pending') {
        console.log(`[unified] ⏳ ${repo}#${pr.number}: CI đang chạy — chờ chu kỳ sau.`);
        continue;
      }

      // FAIL: đếm vòng fix qua các issue [review-fix] hiện có (idempotent theo vòng).
      let fixIssues = [];
      if (state === 'fail') fixIssues = listFixIssues(repo, pr.number);
      const openFix = fixIssues.some((i) => i.state === 'open');
      const round = nextFixRound(fixIssues.map((i) => i.title), pr.number);

      const plan = planRouting({
        checks: state,
        repo,
        prNumber: pr.number,
        nextRound: round,
        maxRounds: cfg.maxReviewRounds || undefined,
        hasOpenFixIssue: openFix,
      });

      applyHandoff(repo, pr.number, plan);
      mutated += 1;
      console.log(`[unified] ✅ ${repo}#${pr.number}: ${plan.action}.`);

      if (plan.createIssue) {
        try {
          ensureLabels(repo, plan.createIssue.labels);
          const url = createFixIssue(repo, plan.createIssue);
          console.log(`[unified] 📌 Issue [review-fix]: ${url}`);
        } catch (e) {
          console.log(`[unified] ⚠️ Tạo issue [review-fix] lỗi: ${String((e && e.message) || e)}`);
        }
      }

      if (cfg.notifyTelegram !== false) {
        notifyLocal(`[AI-REV] ${repo}#${pr.number} — ${plan.action}`, plan.comment);
      }
    }
  }

  return { status: 'DONE', targets, scanned, mutated, dryRun };
}

function parseArgs(argv) {
  return {
    execute: argv.includes('--execute'),
    loop: argv.includes('--loop'),
    interval: (() => {
      const i = argv.indexOf('--interval');
      return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 300000;
    })(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[unified] Bắt đầu (execute=${args.execute}, loop=${args.loop}, interval=${args.interval}ms).`);

  if (!args.loop) {
    const res = processOneCycle({ dryRun: !args.execute });
    console.log(`[unified] Kết quả chu kỳ: ${res.status}`);
    process.exitCode = ['DONE', 'NO_TARGETS', 'NO_CONFIG'].includes(res.status) ? 0 : 1;
    return;
  }

  const tick = () => {
    try {
      processOneCycle({ dryRun: !args.execute });
    } catch (e) {
      console.log(`[unified] Chu kỳ lỗi: ${String((e && e.message) || e)}`);
    }
  };
  tick();
  setInterval(tick, args.interval);
  console.log('[unified] Loop mode: Ctrl+C để dừng.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
