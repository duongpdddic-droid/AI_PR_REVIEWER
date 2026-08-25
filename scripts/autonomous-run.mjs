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
import { retrieveMemories } from './memory-core.mjs';

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
 * GPT-REV-067/C4: dedupe DÒNG trùng lặp xuyên các entry — cùng câu xuất hiện ở nhiều
 * entry (issue summary, findings, memory) chỉ được serialize 1 lần vào prompt.
 * So khớp theo dòng đã trim; dòng rỗng giữ nguyên để định dạng.
 */
function dedupeLinesAcross(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const keptLines = [];
    for (const ln of String(e.text).split('\n')) {
      const key = ln.trim();
      if (!key) { keptLines.push(ln); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      keptLines.push(ln);
    }
    const text = keptLines.join('\n').trim();
    if (text) out.push({ ...e, text });
  }
  return out;
}

/**
 * Xây prompt coder theo working-context budget (GPT-REV-064/067):
 *   bootstrap/invariants (+HEAD SHA, verify failure) + findings + selectiveLoad(issue
 *   sections) + selective memory/event records → compactTranscript → dedupe dòng xuyên entry.
 * overBudget=true khi protected/invariants vượt budget → caller PHẢI escalate, không gửi
 * nguyên context (GPT-REV-060 áp cho context budget).
 * GPT-REV-067/B5: loadedMemoryCount / loadedEventCount đếm record THỰC SỰ được serialize
 * vào prompt sau compact — không phải tổng số record trên đĩa.
 */
export function buildCoderContext({ issueNumber, issueBody, findings = [], budgetTokens = CODER_CONTEXT_BUDGET_TOKENS, headSha = null, verifyFailure = '', memoryCandidates = [], eventCandidates = [] }) {
  const bootText = [
    `Nhận Issue #${issueNumber}${headSha ? ` (base ${headSha})` : ''}. Chỉ sửa đúng phạm vi được phép. Sau khi xong chạy \`node scripts/full-verify.mjs\` và đảm bảo PASS. Không tự merge, không tự commit, không deploy.`,
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

  // Selective memory (GPT-REV-067/B5): chỉ nạp candidate LIÊN QUAN đã qua retrieval,
  // trong budget còn lại sau bootstrap+sections; KHÔNG nạp toàn bộ memory theo mặc định.
  let memSel = { loaded: [], skipped: [] };
  try {
    if (Array.isArray(memoryCandidates) && memoryCandidates.length) {
      const remainingForMem = Math.max(1, budgetTokens - estimateTokens(bootText) - estimateTokens(sel.loaded.map((s) => s.content).join('\n')));
      memSel = selectiveLoad({
        index: memoryCandidates.map((r, i) => ({
          name: String((r && r.subjectKey) || `mem-${i}`),
          tags: ['memory'],
          content: String((r && r.content) || ''),
        })),
        neededTags: ['memory'],
        budgetTokens: remainingForMem,
      });
    }
  } catch { /* degrade: bỏ memory, không block */ }

  const memEntries = memSel.loaded.map((m) => ({ kind: 'memory', text: `[MEMORY] ${m.name}\n${m.content}` }));
  const eventEntries = (Array.isArray(eventCandidates) ? eventCandidates : [])
    .slice(0, 20)
    .map((ev, i) => ({ kind: 'event', text: `[EVENT ${i + 1}] ${JSON.stringify(ev).slice(0, 400)}` }));

  const entries = dedupeLinesAcross(dedupeByHash([
    { kind: 'task', text: bootText },
    ...(verifyFailure ? [{ kind: 'finding', text: `[VERIFY FAILURE cần sửa ngay]\n${String(verifyFailure).slice(-800)}` }] : []),
    ...findings.map((f, i) => ({ kind: 'finding', text: `[FINDING ${i + 1}] ${String(f)}` })),
    ...(sel.skipped.length ? [{ kind: 'history', text: `[skipped sections do vượt budget]: ${sel.skipped.join(', ')}` }] : []),
    ...(sel.loaded.length ? [{ kind: 'history', text: sel.loaded.map((s) => `## ${s.name}\n${s.content}`).join('\n\n') }] : []),
    ...memEntries,
    ...eventEntries,
  ]));
  // B1 — compact transcript về budget; protected (task/finding/Decision Gate/SHA/AC mở) giữ nguyên.
  const c = compactTranscript({ entries, budgetTokens });
  // Đếm record thực sự nằm trong prompt SAU compact (GPT-REV-067/B5).
  const loadedMemoryCount = c.kept.filter((e) => e.kind === 'memory').length;
  const loadedEventCount = c.kept.filter((e) => e.kind === 'event').length;
  return {
    prompt: c.kept.map((e) => e.text).join('\n\n') + (c.summary ? `\n\n${c.summary.text}` : ''),
    dropped: c.dropped,
    overBudget: c.overBudget || selOverBudget,
    totalTokens: c.totalTokens,
    beforeCompactTokens: entries.reduce((sum, e) => sum + estimateTokens(e.text), 0),
    skippedSections: sel.skipped,
    loadedSections: sel.loaded.map((s) => s.name),
    preservedSpans: c.summary ? c.summary.preservedSpans : [],
    compactionEvent: c.compactionEvent,
    memorySkipped: memSel.skipped,
    loadedMemoryCount,
    loadedEventCount,
  };
}

/**
 * GPT-REV-066: chuẩn hóa dữ liệu thô từ `gh api --paginate --slurp`.
 * Output THẬT là mảng các trang, mỗi trang là mảng comment: [[c1,c2],[c3]] — không phải
 * luôn là mảng phẳng. Chấp nhận cả flat array (tương thích fixture/test cũ). Phần tử không
 * phải object hợp lệ bị loại; page array KHÔNG bao giờ được coi là comment; body thiếu hoặc
 * không phải string không làm crash.
 */
export function normalizePaginatedComments(parsed) {
  const out = [];
  const walk = (node) => {
    if (!Array.isArray(node)) {
      if (node && typeof node === 'object') out.push(node);
      return;
    }
    for (const el of node) walk(el);
  };
  walk(Array.isArray(parsed) ? parsed : []);
  return out;
}

/**
 * GPT-REV-066: so sánh 2 occurrence cùng mã finding một cách deterministic:
 * created_at hợp lệ quyết định; bằng nhau HOẶC thiếu (một trong hai) → numeric comment id
 * lớn hơn thắng. KHÔNG dựa vào thứ tự tình cờ của mảng response.
 */
function occurrenceIsNewer(a, b) {
  const ta = Date.parse(String(a.createdAt || ''));
  const tb = Date.parse(String(b.createdAt || ''));
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb;
  const ia = Number(a.id);
  const ib = Number(b.id);
  if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ia > ib;
  return false;
}

/**
 * GPT-REV-066: thu thập unresolved findings/open AC từ authoritative GitHub comments.
 * Verdict MỚI NHẤT mỗi mã [GPT-REV-NNN] thắng theo (created_at, id) — không theo thứ tự
 * mảng; RESOLVED → loại, còn lại → protected entry 1 dòng. Provenance tối thiểu giữ
 * comment id / created_at / dòng verdict / trạng thái. GitHub evidence THẮNG memory.
 * Degrade an toàn: gh lỗi/JSON hỏng/API unavailable → findings rỗng + source
 * 'github-unavailable' — không crash, không block workflow. Source phân biệt đủ 3 trường hợp:
 * 'github-comments' | 'github-comments-empty' | 'github-unavailable'.
 */
export function fetchUnresolvedFindings(issueNumber, io = {}) {
  const repo = io.repo || REPO;
  if (!repo) return { findings: [], source: 'github-unavailable' };
  let raw;
  try {
    raw = io.ghFn
      ? io.ghFn(['api', `repos/${repo}/issues/${String(issueNumber)}/comments`, '--paginate', '--slurp'])
      : runQuiet('gh', ['api', `repos/${repo}/issues/${String(issueNumber)}/comments`, '--paginate', '--slurp']).out;
  } catch {
    return { findings: [], source: 'github-unavailable' };
  }
  let parsed;
  try { parsed = JSON.parse(raw || '[]'); } catch { return { findings: [], source: 'github-unavailable' }; }
  // Top-level JSON phải là mảng (flat legacy hoặc nested pages). Object/number bất thường =
  // API contract thay đổi → KHÔNG tin "không có finding" → github-unavailable (fail-closed).
  if (!Array.isArray(parsed)) return { findings: [], source: 'github-unavailable' };
  const comments = normalizePaginatedComments(parsed);
  const latest = new Map(); // mã finding -> occurrence mới nhất (kèm provenance)
  for (const cm of comments) {
    const body = typeof cm.body === 'string' ? cm.body : '';
    const createdAt = typeof cm.created_at === 'string' ? cm.created_at : '';
    for (const m of body.matchAll(/\[GPT-REV-(\d+)\][^\n]*/g)) {
      const occ = {
        id: cm.id,
        createdAt,
        resolved: /RESOLVED/i.test(m[0]),
        line: m[0].replace(/[*`]/g, '').trim().slice(0, 200),
      };
      const prev = latest.get(m[1]);
      if (!prev || occurrenceIsNewer(occ, prev)) latest.set(m[1], occ);
    }
  }
  const findings = [...latest.entries()]
    .filter(([, v]) => !v.resolved)
    .map(([id, v]) => `[UNRESOLVED GPT-REV-${id}] ${v.line}`);
  return { findings, source: findings.length ? 'github-comments' : 'github-comments-empty' };
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

/**
 * GPT-REV-067: ENTRY POINT DUY NHẤT chuẩn bị mọi lần gọi coder/model — initial,
 * verify-fix và compact-retry đều đi qua đây. Mọi payload (message inline, --read inline
 * conventions, pointer, findings, memory, verify failure) đo chung một thước budget;
 * vượt → blocked=true và caller KHÔNG được gọi model (fail-closed).
 */
export function prepareCoderInvocation({
  issueNumber, issueBody = '', findings = [], findingsSource = 'github-unavailable',
  conventions = null, verifyFailure = '', retryBudget = null, headSha = null,
  memoryRecords = [], eventRecords = [],
  budgetTokens = CODER_CONTEXT_BUDGET_TOKENS,
  startupBudgetTokens = CODER_STARTUP_BUDGET_TOKENS,
  externalContextUnknown = true,
}) {
  const workingBudget = retryBudget != null ? Math.max(1, Math.floor(Number(retryBudget))) : budgetTokens;
  const invocationKind = verifyFailure ? 'verify-fix' : (retryBudget != null ? 'compact-retry' : 'initial');

  // Selective retrieval (B5): chấm điểm liên quan tới issue hiện tại, lấy top-k —
  // KHÔNG nạp toàn bộ memory trên đĩa vào prompt theo mặc định.
  let memoryCandidates = [];
  let memRetrievalNote = 'memory: không có record khả dụng';
  try {
    if (Array.isArray(memoryRecords) && memoryRecords.length) {
      const query = `${issueNumber} ${String(issueBody).slice(0, 400)}`;
      const scored = retrieveMemories(memoryRecords, { query, limit: 8 });
      memoryCandidates = scored.map((s) => s.entry);
      memRetrievalNote = `memory: ${memoryCandidates.length}/${memoryRecords.length} record qua selective retrieval (top-k liên quan)`;
    }
  } catch { /* degrade */ }

  const ctx = buildCoderContext({
    issueNumber,
    issueBody,
    findings,
    budgetTokens: workingBudget,
    headSha,
    verifyFailure,
    memoryCandidates,
    eventCandidates: eventRecords,
  });

  const capsule = buildStartupCapsule({ ctx, conventions });
  const overBudget = ctx.overBudget === true || capsule.totalTokens > startupBudgetTokens;
  const loadReasons = [...capsule.loadReasons, memRetrievalNote];
  if (Array.isArray(ctx.memorySkipped) && ctx.memorySkipped.length) {
    loadReasons.push(`memory bỏ qua vì budget: ${ctx.memorySkipped.join(', ')}`);
  }

  return {
    invocationKind,
    message: capsule.prompt,
    readArgs: capsule.readArgs,
    startupContextTokens: capsule.totalTokens,
    beforeCompactTokens: ctx.beforeCompactTokens,
    afterCompactTokens: ctx.totalTokens,
    budgetTokens: workingBudget,
    startupBudgetTokens,
    overBudget,
    blocked: overBudget,
    loadedModules: capsule.readArgs.length ? 1 : 0,
    loadedSections: ctx.loadedSections,
    loadedMemoryCount: ctx.loadedMemoryCount,
    loadedEventCount: ctx.loadedEventCount,
    loadReasons,
    findingsSource,
    externalContextUnknown: externalContextUnknown === true,
    conventionsMode: capsule.readArgs.length ? 'inline' : (conventions ? 'pointer' : 'absent'),
    preservedSpans: ctx.preservedSpans,
    compactionEvent: ctx.compactionEvent || null,
  };
}

/**
 * GPT-REV-067: EXECUTOR DUY NHẤT — chỉ gọi model khi invocation không bị budget chặn.
 * io.runFn inject cho test/integration (production dùng runInteractive stdio inherit).
 * Blocked → trả ngay TRƯỚC khi chạm runner: không fallback gửi nguyên context.
 */
export function executeCoderInvocation(inv, io = {}) {
  if (NO_AIDER) {
    log('--no-aider: bỏ qua bước model (chỉ verify hiện trạng branch).');
    return { ok: true, called: false };
  }
  if (!inv || inv.blocked) {
    log(`Invocation ${inv?.invocationKind || '?'} bị chặn bởi budget (${inv?.startupContextTokens ?? '?'}/${inv?.startupBudgetTokens ?? '?'}t) — KHÔNG gọi model.`);
    return { ok: false, called: false, blocked: true, error: 'BLOCKED_CONTEXT_BUDGET' };
  }
  const runFn = io.runFn || ((cmd, args) => runInteractive(cmd, args, ROOT));
  try {
    // GPT-REV-065/067: readArgs do startup capsule quyết định — call site không tự ghép.
    runFn(AIDER, [...inv.readArgs, '--message', inv.message, '--yes-always', '--no-auto-commits']);
    return { ok: true, called: true };
  } catch (e) {
    const error = String((e && e.message) || e);
    log(`Model coder lỗi: ${error}`);
    return { ok: false, called: true, error };
  }
}

/** GPT-REV-067/B6: telemetry riêng cho TỪNG lần gọi model (đi qua redact của recordEvent). */
export function recordInvocationTelemetry(hooks, inv, { issueNumber, attempt, modelCalled }) {
  hooks.recordEvent({
    taskId: `issue-${issueNumber}`,
    issue: issueNumber,
    attempt,
    outcome: inv.blocked ? 'startup-context-blocked' : 'startup-context',
    invocationKind: inv.invocationKind,
    startupContextTokens: inv.startupContextTokens,
    beforeCompactTokens: inv.beforeCompactTokens,
    afterCompactTokens: inv.afterCompactTokens,
    budgetTokens: inv.budgetTokens,
    startupBudgetTokens: inv.startupBudgetTokens,
    overBudget: inv.overBudget,
    modelCalled,
    loadedModules: inv.loadedModules,
    loadedSections: inv.loadedSections,
    loadedMemoryCount: inv.loadedMemoryCount,
    loadedEventCount: inv.loadedEventCount,
    loadReasons: inv.loadReasons,
    findingsSource: inv.findingsSource,
    externalContextUnknown: inv.externalContextUnknown,
    conventionsMode: inv.conventionsMode,
    compactionEvent: inv.compactionEvent,
  });
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

  // 3. Coder — MỌI lần gọi model đi qua prepareCoderInvocation + executeCoderInvocation
  //    (GPT-REV-067): một cơ chế capsule/budget cho initial, verify-fix và compact-retry;
  //    không call site nào tự ghép --read/prompt; over-budget → KHÔNG gọi model.
  const issueBodyText = parsed.task?.body || '';
  let unresolved = { findings: [], source: 'github-unavailable' };
  try { unresolved = fetchUnresolvedFindings(issueNumber); } catch { /* degrade: không block */ }
  const conventions = readConventions();
  let memoryRecords = [];
  try { memoryRecords = hooks.store.load(); } catch { /* degrade */ }
  const makeInv = (extra = {}) => prepareCoderInvocation({
    issueNumber,
    issueBody: issueBodyText,
    findings: unresolved.findings,
    findingsSource: unresolved.source,
    conventions,
    headSha: parsed.baseSha || null,
    memoryRecords,
    startupBudgetTokens: CODER_STARTUP_BUDGET_TOKENS,
    externalContextUnknown: !NO_AIDER,
    ...extra,
  });
  let activeInv = makeInv();
  let coderOk = false;
  for (let attempt = 1; attempt <= RECOVERY_MAX_ATTEMPTS && !coderOk; attempt += 1) {
    const inv = activeInv;
    const res = executeCoderInvocation(inv);
    // GPT-REV-067/B6: telemetry từng invocation — ghi cả khi bị chặn (modelCalled=false).
    recordInvocationTelemetry(hooks, inv, { issueNumber, attempt, modelCalled: res.called });
    if (res.blocked) {
      // GPT-REV-064/065/067: protected/invariant hoặc tổng startup vượt budget kể cả sau
      // compact → escalate fail-closed, KHÔNG im lặng gửi payload lớn cho coder.
      hooks.recordEvent({
        taskId: `issue-${issueNumber}`, issue: issueNumber, attempt, errorClass: 'CONTEXT_OVERFLOW',
        compactionEvent: inv.compactionEvent, outcome: 'context-overbudget',
        startupContextTokens: inv.startupContextTokens,
      });
      hooks.recordObservation({
        kind: 'workflow-failure',
        content: `Issue #${issueNumber}: coder context vượt budget ${inv.budgetTokens}/startup ${inv.startupBudgetTokens} tokens kể cả khi compact.`,
        subjectKey: `issue-${issueNumber}-context-overbudget`,
        provenance: { task: `autonomous-run issue-${issueNumber}`, ts: new Date().toISOString() },
      });
      addIssueLabel(issueNumber, LABELS.blocked);
      notifyTelegram('blocked', `#${issueNumber}`, 'blocked', 'Coder context vượt budget kể cả khi compact (BLOCKED_CONTEXT_BUDGET)', 'Thu gọn issue/protected state hoặc tăng CODER_STARTUP_BUDGET_TOKENS.');
      return { status: 'BLOCKED_CONTEXT_BUDGET', issueNumber };
    }
    if (res.ok) { coderOk = true; break; }
    const recPlan = hooks.recover({
      errorClass: classifyError(res.error),
      attempts: attempt,
      maxAttempts: RECOVERY_MAX_ATTEMPTS,
      identity: { role: 'coder' },
      taskId: `issue-${issueNumber}`,
      issue: issueNumber,
    });
    log(`Recovery vòng ${attempt}/${RECOVERY_MAX_ATTEMPTS} (${recPlan.action}): ${recPlan.reason}`);
    if (recPlan.action === 'compact-then-retry') {
      // Retry với context ĐÃ compact thêm (budget giảm nửa) — vẫn qua cùng entry point
      // chuẩn bị + telemetry before/after (GPT-REV-065/067).
      const shrunkInv = makeInv({ retryBudget: Math.max(1, Math.floor(CODER_CONTEXT_BUDGET_TOKENS / 2)) });
      hooks.recordEvent({
        taskId: `issue-${issueNumber}`, issue: issueNumber, attempt,
        compactionEvent: shrunkInv.compactionEvent, outcome: 'context-compaction',
        beforeCompactTokens: inv.startupContextTokens, afterCompactTokens: shrunkInv.startupContextTokens,
        startupContextTokens: shrunkInv.startupContextTokens,
        invocationKind: shrunkInv.invocationKind,
      });
      log(`Compact context cho retry: startupTokens=${shrunkInv.startupContextTokens} (trước: ${inv.startupContextTokens}), overBudget=${shrunkInv.overBudget}.`);
      activeInv = shrunkInv;
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
    // Fix-coder đi qua CÙNG cơ chế capsule/budget (GPT-REV-067) — không tự ghép --read/prompt.
    const fixInv = makeInv({ verifyFailure: findingSummary });
    const fixRes = executeCoderInvocation(fixInv);
    recordInvocationTelemetry(hooks, fixInv, { issueNumber, attempt: round, modelCalled: fixRes.called });
    if (fixRes.blocked) {
      hooks.recordEvent({ taskId: `issue-${issueNumber}`, issue: issueNumber, attempt: round, errorClass: 'CONTEXT_OVERFLOW', outcome: 'fix-invocation-blocked', startupContextTokens: fixInv.startupContextTokens });
    } else if (!fixRes.ok) {
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
