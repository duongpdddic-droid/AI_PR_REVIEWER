#!/usr/bin/env node
// autonomous-core.mjs — Lõi thuần (pure, KHÔNG IO/network) cho orchestrator đóng vòng.
// Chỉ chứa logic quyết định trạng thái để test được trong scripts/test-pure-logic.mjs.
// Không dependency ngoài (chỉ Node stdlib). Orchestrator (autonomous-run.mjs) import module này.

// Số vòng review/fix tối đa trước khi chuyển sang blocked (giới hạn review–fix theo giao thức).
export const MAX_FIX_ROUNDS = 3;

// Nhãn trạng thái workflow (khớp .agent/config.json labels).
export const LABELS = {
  readyForCline: 'status:ready-for-cline',
  inProgress: 'status:in-progress',
  reviewRequested: 'status:review-requested',
  changesRequested: 'status:changes-requested',
  approved: 'status:approved',
  blocked: 'status:blocked',
};

// Nhãn agent (bên xử lý tiếp theo theo AGENT_HANDOFF_PROTOCOL §4).
export const AGENTS = {
  cline: 'agent:cline',
  gpt: 'agent:gpt',
  localReviewer: 'agent:local-reviewer',
};

// Chuẩn hoá output của `github-task-intake.mjs` (string JSON hoặc object) về 1 shape duy nhất.
export function parseClaimResult(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw.trim());
    } catch {
      return { status: 'ERROR', error: 'claim output không phải JSON hợp lệ' };
    }
  }
  if (!obj || typeof obj !== 'object') return { status: 'ERROR', error: 'claim output không phải object' };
  return {
    status: obj.status || 'ERROR',
    number: obj.number ?? null,
    baseSha: (obj.preflight && obj.preflight.baseSha) || obj.baseSha || null,
    task: obj.task || null,
    tasks: obj.tasks || null,
    error: obj.error || obj.detail || null,
  };
}

// Claim có thành công không (dùng chung cho --claim trả về CLAIMED hoặc ALREADY_CLAIMED).
export function isClaimSuccess(status) {
  return status === 'CLAIMED' || status === 'ALREADY_CLAIMED';
}

// Quyết định bước tiếp theo của vòng review dựa trên kết quả verify và số vòng đã chạy.
// round là số vòng review–fix ĐÃ hoàn thành (0-based). Trả về hành động + nhãn + có phải terminal.
export function planReview({ verifyOk, round, maxRounds = MAX_FIX_ROUNDS }) {
  if (verifyOk) return { action: 'approve', label: LABELS.approved, terminal: true };
  if (round < maxRounds) return { action: 'request-changes', label: LABELS.changesRequested, terminal: false };
  return { action: 'block', label: LABELS.blocked, terminal: true };
}

// Coder có được phép thử fix thêm sau một lần verify thất bại không.
export function canRetryFix({ verifyOk, round, maxRounds = MAX_FIX_ROUNDS }) {
  return !verifyOk && round < maxRounds;
}

// Ánh xạ mảng tên nhãn GitHub về trạng thái workflow chuẩn (thứ tự ưu tiên terminal trước).
export function issueStatusFromLabels(labels) {
  const s = new Set(Array.isArray(labels) ? labels : []);
  if (s.has(LABELS.approved)) return 'approved';
  if (s.has(LABELS.changesRequested)) return 'changes-requested';
  if (s.has(LABELS.reviewRequested)) return 'review-requested';
  if (s.has(LABELS.inProgress)) return 'in-progress';
  if (s.has(LABELS.readyForCline)) return 'ready';
  if (s.has(LABELS.blocked)) return 'blocked';
  return 'unknown';
}

// Sinh tên nhánh an toàn (kebab-case) từ số Issue + tiêu đề.
export function branchNameFor(issueNumber, title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `feat/issue-${issueNumber}${slug ? '-' + slug : ''}`;
}

// Trích dòng tổng kết "Tổng: X/Y PASS" từ stdout verify để đưa vào finding/comment.
export function summarizeVerify(stdout) {
  const text = String(stdout || '');
  const m = text.match(/Tổng:\s*\d+\/\d+\s*PASS/);
  return m ? m[0] : (text.trim().split('\n').filter(Boolean).slice(-1)[0] || 'verify không có output');
}

// ---------------------------------------------------------------- multi-repo (reviewer đa repo)

// Chuẩn hoá danh sách repo mục tiêu mà reviewer phải quét PR cần review.
// Ưu tiên config.targetRepos (mảng "owner/name"); fallback config.repo nếu thiếu.
// Lọc chuỗi rỗng + khử trùng lặp (case-insensitive), giữ thứ tự.
export function normalizeTargetRepos(config) {
  const cfg = config || {};
  const src = Array.isArray(cfg.targetRepos) && cfg.targetRepos.length
    ? cfg.targetRepos
    : (cfg.repo ? [cfg.repo] : []);
  const seen = new Set();
  const out = [];
  for (const r of src) {
    const s = String(r || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Repo target có trùng với repo orchestrator hiện tại không (reviewer KHÔNG tự review PR của chính repo nó).
export function isSelfRepo(targetRepo, selfRepo) {
  return Boolean(selfRepo) && String(targetRepo).toLowerCase() === String(selfRepo).toLowerCase();
}

// Lọc bỏ repo orchestrator khỏi danh sách target (reviewer chỉ review repo dự án bên ngoài).
export function externalTargetRepos(targetRepos, selfRepo) {
  return (targetRepos || []).filter((r) => !isSelfRepo(r, selfRepo));
}

// Số vòng review tối đa lấy từ config (fallback MAX_FIX_ROUNDS) — dùng chung cho cả reviewer.
export function reviewRoundLimit(config) {
  const n = Number(config && config.maxReviewRounds);
  return Number.isInteger(n) && n > 0 ? n : MAX_FIX_ROUNDS;
}

// ---------------------------------------------------------------- phân tích CI checks (đa repo)

// Parse JSON output của `gh pr checks --json name,state` (gh ≥ v2.31)
// → { pass[], fail[], pending[] } hoặc null nếu không phải JSON hợp lệ (fallback parser text).
export function parseChecksJson(stdout) {
  let arr;
  try { arr = JSON.parse(String(stdout || '')); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const FAIL_STATES = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT']);
  const PASS_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPING']);
  const res = { pass: [], fail: [], pending: [] };
  for (const c of arr) {
    const name = String((c && c.name) || '').trim();
    if (!name) continue;
    const st = String((c && c.state) || '').toUpperCase();
    if (PASS_STATES.has(st)) res.pass.push(name);
    else if (FAIL_STATES.has(st)) res.fail.push(name);
    else res.pending.push(name);
  }
  return res;
}

// Phân loại tổng từ kết quả parse: fail > pending > pass.
// Danh sách trống (PR không có check nào cấu hình) → 'pass' (không gì fail).
export function classifyParsedChecks(parsed) {
  if (!parsed) return 'unknown';
  if (parsed.fail.length) return 'fail';
  if (parsed.pending.length) return 'pending';
  return 'pass';
}

// Parse stdout text của `gh pr checks` (các trường cách nhau bằng tab, trạng thái
// thể hiện bằng emoji đầu dòng ✅/❌/⏳) → { pass[], fail[], pending[] }.
// Dòng không nhận diện được → coi pending (an toàn: không báo fail giả, chỉ hoãn).
export function parseChecksOutput(stdout) {
  const res = { pass: [], fail: [], pending: [] };
  for (const line of String(stdout || '').split('\n')) {
    const s = line.replace(/\r/g, '').trim();
    if (!s || s.startsWith('-')) continue;
    const name = (s.split('\t')[0] || '').replace(/^[^A-Za-z0-9_-]+/, '').trim();
    if (!name) continue;
    if (/^✅|^✔|^✓|\bpass\b/i.test(s)) res.pass.push(name);
    else if (/^❌|^✗|^✘|\bfail/i.test(s)) res.fail.push(name);
    else res.pending.push(name);
  }
  return res;
}

// Sinh finding chuẩn [LOCAL-REV-NNN] từ danh sách tên check FAIL (1 finding/check)
// theo finding-schema (Severity/Status/File-Symbol/Evidence/Risk/Required fix/Acceptance criteria).
export function findingsFromFailedChecks(failedNames, prNumber) {
  return (Array.isArray(failedNames) ? failedNames : []).map((name, i) => {
    const id = String(i + 1).padStart(3, '0');
    return [
      `[LOCAL-REV-${id}]`,
      'Severity: high',
      'Status: open',
      `File/Symbol: CI check "${name}" — PR #${prNumber}`,
      `Evidence: check "${name}" FAIL trên GitHub Actions.`,
      'Risk: quality gate không đạt — diff chưa đủ điều kiện merge.',
      `Required fix: mở log CI của check "${name}", sửa lỗi đến khi check PASS.`,
      `Acceptance criteria: check "${name}" PASS trên commit mới của PR.`,
    ].join('\n');
  });
}

// ---------------------------------------------------------------- routing reviewer ↔ coder (đa repo)

// Nhãn đánh dấu issue công việc "[review-fix]" do orchestrator sinh ra cho Cline dự án.
export const FIX_ISSUE_LABEL = 'review-fix';

// Tiêu đề issue công việc fix review cho 1 PR (chứa cả số vòng để đếm idempotent).
export function fixIssueTitle(prNumber, round) {
  return `[review-fix] PR #${prNumber} — vòng r${round}`;
}

// Số vòng fix tiếp theo = max vòng rK thấy trong tiêu đề issue [review-fix] của PR này, +1.
// Chỉ tính tiêu đề nhắc đúng `PR #<prNumber>` (bỏ qua issue của PR khác).
export function nextFixRound(titles, prNumber) {
  let max = 0;
  for (const t of Array.isArray(titles) ? titles : []) {
    const s = String(t || '');
    if (!s.includes(`PR #${prNumber}`)) continue;
    const m = s.match(/r(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// Nội dung issue công việc: chỉ dẫn Cline dự án fix trên branch của PR rồi bàn giao lại.
export function fixIssueBody({ repo, prNumber, round, maxRounds = MAX_FIX_ROUNDS } = {}) {
  return [
    `## Việc cần làm`,
    `Sửa các finding review cho \`${repo}#${prNumber}\` (vòng r${round}/${maxRounds}).`,
    ``,
    `- Đọc review comments trên PR: https://github.com/${repo}/pull/${prNumber}`,
    `- Push commit sửa lên **branch của PR** (KHÔNG tạo PR mới).`,
    `- Khi xong: chạy quality gate, đổi nhãn PR — bỏ \`status:changes-requested\` + \`agent:cline\`, gắn lại \`status:review-requested\` để quay lại vòng review.`,
    ``,
    `> Issue tự sinh bởi unified-orchestrator (AI_PR_REVIEWER). Bỏ qua nếu đã xử lý.`,
  ].join('\n');
}

// Quyết định routing sau khi phân loại CI cho 1 PR theo AGENT_HANDOFF_PROTOCOL:
//   pending → chờ; pass → approve kỹ thuật (status:approved — quyền MERGE vẫn thuộc người dùng);
//   fail còn budget → trả Cline (+issue [review-fix]);
//   fail hết budget (nextRound > maxRounds) → block, cần người dùng quyết định.
export function planRouting({
  checks,
  repo = '',
  prNumber = null,
  nextRound = 1,
  maxRounds = MAX_FIX_ROUNDS,
  hasOpenFixIssue = false,
} = {}) {
  if (checks === 'pending') {
    return { action: 'wait', addLabels: [], removeLabels: [] };
  }
  if (checks === 'pass') {
    return {
      action: 'approve',
      addLabels: [LABELS.approved],
      removeLabels: [LABELS.reviewRequested],
      comment: `✅ Verification PASS 100% — đạt yêu cầu kỹ thuật (${repo}#${prNumber}). Quyền merge thuộc người dùng.`,
    };
  }
  if (nextRound <= maxRounds) {
    return {
      action: 'request-fix',
      addLabels: [LABELS.changesRequested, AGENTS.cline],
      removeLabels: [LABELS.reviewRequested],
      createIssue: hasOpenFixIssue ? null : {
        title: fixIssueTitle(prNumber, nextRound),
        body: fixIssueBody({ repo, prNumber, round: nextRound, maxRounds }),
        labels: [AGENTS.cline, LABELS.readyForCline, FIX_ISSUE_LABEL],
      },
      comment: `❌ CI chưa PASS — trả Cline sửa lại (vòng r${nextRound}/${maxRounds}) qua issue [review-fix] PR #${prNumber}.`,
    };
  }
  return {
    action: 'block',
    addLabels: [LABELS.blocked],
    removeLabels: [LABELS.reviewRequested, AGENTS.cline],
    comment: `⛔ ${repo}#${prNumber} vượt ${maxRounds} vòng review–fix — chuyển status:blocked, cần người dùng quyết định.`,
  };
}
