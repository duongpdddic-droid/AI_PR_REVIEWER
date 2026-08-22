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
