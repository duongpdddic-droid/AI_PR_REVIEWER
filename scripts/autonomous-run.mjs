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
import { createHash } from 'node:crypto';
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
import { classifyError } from './error-recovery.mjs';
import { createRuntimeHooks } from './runtime-hooks.mjs';
import { compactTranscript, selectiveLoad, estimateTokens } from './context-manager.mjs';

// Budget attempt recovery cho coder (bounded — planRecovery quyết retry/escalate).
const RECOVERY_MAX_ATTEMPTS = 3;
// Working-context budget cho coder prompt (GPT-REV-064): bootstrap/invariants + selective
// task context, enforce bằng compactTranscript; vượt (protected state quá lớn) → escalate.
const CODER_CONTEXT_BUDGET_TOKENS = 6000;
// GPT-REV-065: budget TỔNG startup harness-controlled (message + file --read inline),
// cấu hình được; vượt phải escalate BLOCKED_CONTEXT_BUDGET, không im lặng gửi payload lớn.
const CODER_STARTUP_BUDGET_TOKENS = Number(process.env.CODER_STARTUP_BUDGET_TOKENS) || 12000;
// File --read (conventions) chỉ inline khi ≤ limit; lớn hơn → pointer, không --read.
const CODER_READ_INLINE_LIMIT_TOKENS = Number(process.env.CODER_READ_INLINE_LIMIT_TOKENS) || 2000;

/** GPT-REV-065: dedupe theo content hash — cùng nội dung trong 1 task không nạp lặp. */
function dedupeByHash(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const h = createHash('sha1').update(e.text).digest('hex');
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

/**
 * Chia issue body thành các section (theo heading `#`) để progressive disclosure.
 * Tag suy từ keyword heading: ac/scope/test/background — section 'scope' là invariant
 * (phạm vi bắt buộc, selectiveLoad luôn tải). Không có heading → 1 section background duy nhất.
 */
export function indexIssueSections(issueBody) {
  const text = String(issueBody || '');
  const tagFor = (heading) => {
    const s = String(heading || '').toLowerCase();
    const tags = [];
    if (/accept|nghiệm thu|tiêu chí|criteria/.test(s)) tags.push('ac');
    if (/scope|phạm vi|allowed|được phép|không được thay đổi/.test(s)) tags.push('scope');
    if (/test|verify|kiểm thử|bằng chứng|evidence/.test(s)) tags.push('test');
    if (!tags.length) tags.push('background');
    return tags;
  };
  const sections = [];
  let cur = { name: '(intro)', tags: ['background'], lines: [] };
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m) { sections.push(cur); cur = { name: m[1].trim(), tags: tagFor(m[1]), lines: [] }; }
    else cur.lines.push(line);
  }
  sections.push(cur);
  return sections
    .map((s) => ({ name: s.name, tags: s.tags, content: s.lines.join('\n').trim() }))
    .filter((s) => s.content)
    .map((s) => ({ ...s, invariant: s.tags.includes('scope') }));
}

const CODER_BOOTSTRAP = [
  'INVARIANT: Không tự merge PR; không clasp push/deploy; không tự commit (orchestrator commit); policy gate fail-closed.',
];

/**
 * Xây prompt coder theo working-context budget (GPT-REV-064):
 *   bootstrap/invariants + findings + selectiveLoad(issue sections) rồi compactTranscript.
 * overBudget=true khi protected/invariants vượt budget → caller PHẢI escalate,
 * không gửi nguyên context (GPT-REV-060 semantics áp cho context budget).
 */
export function buildCoderContext({ issueNumber, issueBody, findings = [], budgetTokens = CODER_CONTEXT_BUDGET_TOKENS }) {
  const bootText = [
    `Nhận Issue #${issueNumber}. Chỉ sửa đúng phạm vi được phép. Sau khi xong chạy \`node scripts/full-verify.mjs\` và đảm bảo PASS. Không tự merge, không tự commit, không deploy.`,
    ...CODER_BOOTSTRAP,
  ].join('\n');
  // B2 — progressive disclosure trên index section của issue body.
  let sel = { loaded: [], skipped: [] };
  let selOverBudget = false;
  try {
    const remaining = Math.max(1, budgetTokens - estimateTokens(bootText));
    sel = selectiveLoad({
      index: indexIssueSections(issueBody),
      neededTags: ['ac', 'scope', 'test'],
      budgetTokens: remaining,
    });
    selOverBudget = sel.overBudget === true;
  } catch { /* issue rỗng/không parse được → chỉ bootstrap + findings */ }

  const entries = dedupeByHash([
    { kind: 'task', text: bootText },
    ...findings.map((f, i) => ({ kind: 'finding', text: `[FINDING ${i + 1}] ${String(f)}` })),
    ...(sel.skipped.length ? [{ kind: 'history', text: `[skipped sections do vượt budget]: ${sel.skipped.join(', ')}` }] : []),
    ...(sel.loaded.length ? [{ kind: 'history', text: sel.loaded.map((s) => `## ${s.name}\n${s.content}`).join('\n\n') }] : []),
  ]);
  // B1 — compact transcript về budget; protected (task/finding/Decision Gate/SHA/AC mở) giữ nguyên.
  const c = compactTranscript({ entries, budgetTokens });
  return {
    prompt: c.kept.map((e) => e.text).join('\n\n') + (c.summary ? `\n\n${c.summary.text}` : ''),
    dropped: c.dropped,
    overBudget: c.overBudget || selOverBudget,
    totalTokens: c.totalTokens,
    skippedSections: sel.skipped,
    loadedSections: sel.loaded.map((s) => s.name),
    preservedSpans: c.summary ? c.summary.preservedSpans : [],
    compactionEvent: c.compactionEvent,
  };
}

/**
 * GPT-REV-065: thu thập unresolved findings/open AC từ authoritative GitHub comments.
 * Trạng thái cuối của mỗi mã [GPT-REV-NNN] theo comment MỚI NHẤT: RESOLVED → bỏ,
 * còn lại → protected entry dạng 1 dòng. GitHub evidence THẮNG memory. Degrade an toàn
 * (lỗi gh/network → findings rỗng, source 'unavailable') — không block workflow.
 */
export function fetchUnresolvedFindings(issueNumber, io = {}) {
  const repo = io.repo || REPO;
  if (!repo) return { findings: [], source: 'unavailable' };
  let raw;
  try {
    raw = io.ghFn
      ? io.ghFn(['api', `repos/${repo}/issues/${String(issueNumber)}/comments`, '--paginate', '--slurp'])
      : runQuiet('gh', ['api', `repos/${repo}/issues/${String(issueNumber)}/comments`, '--paginate', '--slurp']).out;
  } catch {
    return { findings: [], source: 'unavailable' };
  }
  let comments;
  try { comments = JSON.parse(raw || '[]'); } catch { return { findings: [], source: 'unavailable' }; }
  if (!Array.isArray(comments)) comments = [];
  const latest = new Map();
  for (const cm of comments) {
    const body = String((cm && cm.body) || '');
    for (const m of body.matchAll(/\[GPT-REV-(\d+)\][^\n]*/g)) {
      latest.set(m[1], {
        resolved: /RESOLVED/i.test(m[0]),
        line: m[0].replace(/[*`]/g, '').trim().slice(0, 200),
      });
    }
  }
  const findings = [...latest.entries()]
    .filter(([, v]) => !v.resolved)
    .map(([id, v]) => `[UNRESOLVED GPT-REV-${id}] ${v.line}`);
  return { findings, source: 'github' };
}

/**
 * GPT-REV-065: đọc conventions coder để đo trước. Trả null nếu file không tồn tại/rỗng.
 * io.readFile inject cho test.
 */
export function readConventions(io = {}) {
  const p = io.conventionsPath || path.join(ROOT, '.agent', 'conventions-coder.md');
  const readFile = io.readFile || ((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''));
  const text = String(readFile(p) || '');
  return text ? { path: p, text, tokens: estimateTokens(text) } : null;
}

/**
 * GPT-REV-065: startup capsule đo được — message (đã budget-enforce) + quyết định
 * inline/pointer cho file --read. Conventions vượt inline limit → KHÔNG --read, chèn
 * pointer ngắn vào prompt (coder tự đọc đúng phần cần khi thực thi).
 */
export function buildStartupCapsule({ ctx, conventions }) {
  const loadReasons = [];
  let readArgs = [];
  let prompt = ctx.prompt;
  if (!conventions) {
    loadReasons.push('conventions: không tồn tại → bỏ qua');
  } else if (conventions.tokens <= CODER_READ_INLINE_LIMIT_TOKENS) {
    readArgs = ['--read', conventions.path];
    loadReasons.push(`conventions inline (${conventions.tokens}t ≤ limit ${CODER_READ_INLINE_LIMIT_TOKENS}t)`);
  } else {
    prompt += `\n\n[CONVENTIONS POINTER] ${conventions.path} (~${conventions.tokens}t > inline limit ${CODER_READ_INLINE_LIMIT_TOKENS}t — đọc đúng phần cần khi thực thi, không nạp toàn bộ.)`;
    loadReasons.push('conventions → pointer (vượt inline limit)');
  }
  const totalTokens = estimateTokens(prompt) + (readArgs.length ? conventions.tokens : 0);
  return { prompt, readArgs, loadReasons, totalTokens };
}

function runCoder(issueNumber, issueBody, ctxPrompt, readArgs = []) {
  if (NO_AIDER) {
    log('--no-aider: bỏ qua bước coder LLM (chỉ verify hiện trạng branch).');
    return { ok: true, error: '' };
  }
  const msg = ctxPrompt || `Nhận Issue #${issueNumber}, triển khai code theo phạm vi và tiêu chí nghiệm thu trong issue, chỉ sửa đúng phạm vi được phép. Sau khi xong chạy \`node scripts/full-verify.mjs\` và đảm bảo PASS. Không tự merge, không tự commit (orchestrator sẽ commit), không deploy.\n\n--- ISSUE ---\n${issueBody || ''}`;
  try {
    // GPT-REV-065: readArgs do startup capsule quyết định (inline ≤ limit, lớn → pointer).
    runInteractive(AIDER, [...readArgs, '--message', msg, '--yes-always', '--no-auto-commits'], ROOT);
    return { ok: true, error: '' };
  } catch (e) {
    const error = String((e && e.message) || e);
    log(`Aider coder lỗi: ${error}`);
    return { ok: false, error };
  }
}

function runFixCoder(issueNumber, findingSummary) {
  if (NO_AIDER) return { ok: true, error: '' };
  const conventions = path.join(ROOT, '.agent', 'conventions-coder.md');
  const readArgs = fs.existsSync(conventions) ? ['--read', conventions] : [];
  const msg = `Sửa các lỗi verify trên issue #${issueNumber} (tóm tắt: ${findingSummary}) rồi chạy \`node scripts/full-verify.mjs\` cho PASS. Không tự merge, không tự commit.`;
  try {
    runInteractive(AIDER, [...readArgs, '--message', msg, '--yes-always', '--no-auto-commits'], ROOT);
    return { ok: true, error: '' };
  } catch (e) {
    const error = String((e && e.message) || e);
    log(`Aider fix lỗi: ${error}`);
    return { ok: false, error };
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
  // GPT-REV-063: runtime state KHÔNG được vào commit — runtime mặc định nằm ngoài worktree
  // (~/.agent-runtime); unstage phòng hờ vùng legacy <repo>/.agent/runtime nếu còn sót.
  runQuiet('git', ['reset', '-q', '--', '.agent/runtime', '.agent/runtime/']);
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

  // Hooks runtime (GPT-REV-059): memory/observation/recovery/telemetry chạy THẬT trong chu kỳ.
  // Mọi hook tự degrade — lỗi persistence KHÔNG bao giờ block workflow.
  const hooks = createRuntimeHooks({ rootDir: ROOT });

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

  // 3. Coder — bounded recovery thật + working-context budget (GPT-REV-064/065):
  //    - unresolved findings từ GitHub comments → protected entries (GitHub thắng memory);
  //    - startup capsule đo được TỔNG harness-controlled payload (message + --read inline);
  //    - vượt CODER_STARTUP_BUDGET_TOKENS kể cả sau compact → BLOCKED_CONTEXT_BUDGET;
  //    - 'compact-then-retry' → capsule nhỏ hơn thật + telemetry before/after.
  const issueBodyText = parsed.task?.body || '';
  let unresolved = { findings: [], source: 'unavailable' };
  try { unresolved = fetchUnresolvedFindings(issueNumber); } catch { /* degrade: không block */ }
  const conventions = readConventions();
  let loadedMemoryCount = 0;
  try { loadedMemoryCount = hooks.loadEvents().length; } catch { /* degrade */ }
  const buildCtx = (budgetTokens) => buildCoderContext({
    issueNumber, issueBody: issueBodyText, findings: unresolved.findings, budgetTokens,
  });
  const makeCapsule = (ctx) => {
    const capsule = buildStartupCapsule({ ctx, conventions });
    return { ctx, capsule };
  };
  let active = makeCapsule(buildCtx(CODER_CONTEXT_BUDGET_TOKENS));
  let coderOk = false;
  for (let attempt = 1; attempt <= RECOVERY_MAX_ATTEMPTS && !coderOk; attempt += 1) {
    const { ctx, capsule } = active;
    const overStartupBudget = capsule.totalTokens > CODER_STARTUP_BUDGET_TOKENS;
    if (ctx.overBudget || overStartupBudget) {
      // GPT-REV-064/065: protected/invariant state hoặc tổng startup vượt budget kể cả sau
      // compact → escalate, KHÔNG im lặng gửi payload lớn cho coder.
      log(`Context vượt budget (ctx=${ctx.totalTokens}t, startup=${capsule.totalTokens}t/${CODER_STARTUP_BUDGET_TOKENS}t) → escalate.`);
      hooks.recordEvent({
        taskId: `issue-${issueNumber}`, issue: issueNumber, attempt, errorClass: 'CONTEXT_OVERFLOW',
        compactionEvent: ctx.compactionEvent, outcome: 'context-overbudget',
        startupContextTokens: capsule.totalTokens,
        beforeCompactTokens: null, afterCompactTokens: ctx.totalTokens,
      });
      hooks.recordObservation({
        kind: 'workflow-failure',
        content: `Issue #${issueNumber}: coder context vượt budget ${CODER_CONTEXT_BUDGET_TOKENS}/startup ${CODER_STARTUP_BUDGET_TOKENS} tokens kể cả khi compact.`,
        subjectKey: `issue-${issueNumber}-context-overbudget`,
        provenance: { task: `autonomous-run issue-${issueNumber}`, ts: new Date().toISOString() },
      });
      addIssueLabel(issueNumber, LABELS.blocked);
      notifyTelegram('blocked', `#${issueNumber}`, 'blocked', 'Coder context vượt budget kể cả khi compact (BLOCKED_CONTEXT_BUDGET)', 'Thu gọn issue/protected state hoặc tăng CODER_STARTUP_BUDGET_TOKENS.');
      return { status: 'BLOCKED_CONTEXT_BUDGET', issueNumber };
    }
    // GPT-REV-065: telemetry bắt buộc mỗi lần gửi startup payload cho coder.
    hooks.recordEvent({
      taskId: `issue-${issueNumber}`, issue: issueNumber, attempt, outcome: 'startup-context',
      startupContextTokens: capsule.totalTokens,
      loadedModules: ctx.loadedSections.length,
      loadedSections: ctx.loadedSections,
      loadedMemoryCount,
      beforeCompactTokens: null, afterCompactTokens: ctx.totalTokens,
      loadReasons: capsule.loadReasons,
      findingsSource: unresolved.source, unresolvedFindingCount: unresolved.findings.length,
      externalContextUnknown: !NO_AIDER, startupBudgetTokens: CODER_STARTUP_BUDGET_TOKENS,
    });
    const c = runCoder(issueNumber, issueBodyText, capsule.prompt, capsule.readArgs);
    if (c.ok) { coderOk = true; break; }
    const recPlan = hooks.recover({
      errorClass: classifyError(c.error),
      attempts: attempt,
      maxAttempts: RECOVERY_MAX_ATTEMPTS,
      identity: { role: 'coder' },
      taskId: `issue-${issueNumber}`,
      issue: issueNumber,
    });
    log(`Recovery vòng ${attempt}/${RECOVERY_MAX_ATTEMPTS} (${recPlan.action}): ${recPlan.reason}`);
    if (recPlan.action === 'compact-then-retry') {
      // Retry với context ĐÃ compact thêm (budget giảm nửa) — capsule nhỏ hơn thật +
      // telemetry before/after tokens persist (GPT-REV-065).
      const shrunkCtx = buildCtx(Math.max(1, Math.floor(CODER_CONTEXT_BUDGET_TOKENS / 2)));
      const shrunk = makeCapsule(shrunkCtx);
      hooks.recordEvent({
        taskId: `issue-${issueNumber}`, issue: issueNumber, attempt,
        compactionEvent: shrunk.ctx.compactionEvent, outcome: 'context-compaction',
        beforeCompactTokens: capsule.totalTokens, afterCompactTokens: shrunk.capsule.totalTokens,
        startupContextTokens: shrunk.capsule.totalTokens,
      });
      log(`Compact context cho retry: dropped=${shrunk.ctx.dropped}, startupTokens=${shrunk.capsule.totalTokens} (trước: ${capsule.totalTokens}), overBudget=${shrunk.ctx.overBudget}.`);
      active = shrunk;
      sleepSync(recPlan.delayMs || 0);
      continue;
    }
    if (recPlan.action === 'escalate-blocked') break;
    sleepSync(recPlan.delayMs || 0);
  }
  if (!coderOk) {
    log('Coder thất bại sau bounded recovery.');
    hooks.recordObservation({
      kind: 'workflow-failure',
      content: `Coder thất bại cho issue #${issueNumber} sau bounded recovery (${RECOVERY_MAX_ATTEMPTS} attempt).`,
      subjectKey: `issue-${issueNumber}-coder-failure`,
      provenance: { task: `autonomous-run issue-${issueNumber}`, ts: new Date().toISOString() },
    });
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
    // Telemetry thật (GPT-REV-059): mỗi verify FAIL được classify + ghi event.
    hooks.recordEvent({
      taskId: `issue-${issueNumber}`,
      issue: issueNumber,
      attempt: round,
      errorClass: classifyError(String(finalVerify.out || '').slice(-2000)),
      outcome: 'verify-fail',
    });
    const decision = planReview({ verifyOk: false, round });
    if (decision.action === 'block') {
      log('Đã đạt giới hạn vòng fix mà vẫn FAIL → chuyển blocked.');
      hooks.recordObservation({
        kind: 'workflow-failure',
        content: `Verify vẫn FAIL sau ${round} vòng fix cho issue #${issueNumber}.`,
        subjectKey: `issue-${issueNumber}-verify-blocked`,
        provenance: { task: `autonomous-run issue-${issueNumber}`, ts: new Date().toISOString() },
      });
      addIssueLabel(issueNumber, LABELS.blocked);
      postComment(issueNumber, `❌ Sau ${round} vòng fix, verify vẫn FAIL:\n\`\`\`\n${finalVerify.out}\n\`\`\``);
      notifyTelegram('test-fail', `#${issueNumber}`, 'blocked', `Verify vẫn FAIL sau ${round} vòng`, 'Xem lại scope/issue hoặc can thiệp thủ công.');
      return { status: 'BLOCKED_VERIFY', issueNumber, round };
    }
    const findingSummary = summarizeVerify(finalVerify.out);
    const fixRes = runFixCoder(issueNumber, findingSummary);
    if (!fixRes.ok) {
      hooks.recordEvent({ taskId: `issue-${issueNumber}`, issue: issueNumber, attempt: round, errorClass: classifyError(fixRes.error), outcome: 'fix-coder-fail' });
    }
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

  // Session-summary observation + consolidate bounded (GPT-REV-059): persistence chạy thật.
  hooks.recordObservation({
    kind: 'session-summary',
    content: `Issue #${issueNumber} → PR #${prNumber} bàn giao GPT review sau ${round} vòng fix. Verify PASS.`,
    subjectKey: `issue-${issueNumber}-session`,
    tags: ['issue', 'pr-handoff'],
    provenance: { task: `autonomous-run issue-${issueNumber}`, ts: new Date().toISOString() },
  });
  hooks.consolidateMemory();

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
