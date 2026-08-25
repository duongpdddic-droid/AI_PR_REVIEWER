#!/usr/bin/env node
// context-manager.mjs — Working-context budget + compact + progressive disclosure (Issue #9 B1/B2).
// Pure core, injectable IO (cùng phong cách context-router.mjs). Không dependency ngoài.
//
// B1: compactTranscript() — giới hạn budget; giữ current task, unresolved findings,
//     policy invariants, recent evidence; KHÔNG mất full SHA, finding ID ([LOCAL-REV-n]/
//     [CLINE-FIX-n]/GPT-REV-n), Decision Gate, authorization state, acceptance criteria mở
//     (dòng "- [ ]"); mọi span bảo toàn được trích nguyên văn vào summary stub.
// B2: selectiveLoad() — progressive disclosure theo tag/query trên index; chỉ tải entry liên quan;
//     invariants luôn tải; enforce budget. Bổ sung cho router #6 (taskType tĩnh), không thay thế.

export const TOKEN_DIVISOR = 4; // nhất quán với context-router.mjs

// Kind được bảo toàn khi compact (không bao giờ bị drop/summarize mất nội dung).
const PROTECTED_KINDS = new Set(['task', 'finding', 'decision-gate', 'policy-invariant']);

// Regex span bắt buộc sống sót kể cả trong phần bị compact:
const PROTECTED_SPAN_RES = [
  /\b[0-9a-f]{40}\b/g, // full git SHA
  /\[(?:LOCAL-REV|CLINE-FIX|GPT-REV)-\d+\]/g, // finding/fix/review ID canonical
  /Decision Gate[^\n]*/g,
];

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / TOKEN_DIVISOR);
}

/** Trích các span bảo toàn (SHA/finding-ID/Decision Gate) từ text, dedupe giữ thứ tự. */
export function extractProtectedSpans(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  for (const re of PROTECTED_SPAN_RES) {
    for (const m of s.matchAll(re)) {
      const v = m[0].trim();
      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    }
  }
  return out;
}

function isProtectedEntry(entry) {
  if (PROTECTED_KINDS.has(entry.kind)) return true;
  if (/^- \[ \]/m.test(String(entry.text || ''))) return true; // AC đang mở
  return false;
}

/**
 * Compact transcript về <= budgetTokens.
 * @param {{entries: Array<{kind:string,text:string,ts?:string}>, budgetTokens:number}} input
 * @returns {{kept: Array, dropped: number, summary: {kind:string,text:string,preservedSpans:string[]}|null,
 *            totalTokens:number, compactionEvent:{droppedCount:number, preservedSpans:string[]}|null}}
 * Thuật toán: duyệt mới→cũ, giữ entry protected hoặc còn vừa budget; entry unprotected vượt budget
 * bị gom vào tombstone summary kèm preservedSpans nguyên văn (SHA/finding-ID/Decision Gate).
 */
export function compactTranscript({ entries, budgetTokens }) {
  if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) {
    throw new Error('[BLOCKED_BUDGET_INVALID] budgetTokens phải là số nguyên > 0');
  }
  const list = Array.isArray(entries) ? entries : [];
  const kept = [];
  const dropped = [];
  let used = 0;

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    const t = estimateTokens(e.text);
    if (!isProtectedEntry(e) && used + t > budgetTokens) { dropped.push(e); continue; }
    // Entry protected luôn giữ ngay cả khi một mình đã vượt budget (an toàn hơn mất state).
    used += t;
    kept.push(e);
  }
  kept.reverse();

  let summary = null;
  if (dropped.length) {
    const spans = [...new Set(dropped.flatMap((e) => extractProtectedSpans(e.text)))];
    const openAc = dropped
      .flatMap((e) => String(e.text).split('\n'))
      .filter((l) => /^- \[ \]/.test(l.trim()));
    const parts = [`[compacted ${dropped.length} entries — evidence compaction ${new Date().toISOString()}]`];
    if (spans.length) parts.push(`Preserved: ${spans.join('; ')}`);
    if (openAc.length) parts.push(`Open criteria:\n${openAc.join('\n')}`);
    summary = { kind: 'compacted-summary', text: parts.join('\n'), preservedSpans: spans };
  }

  // Budget check cuối: nếu cả protected còn vượt → vẫn trả về đủ protected (không drop),
  // nhưng báo overBudget để caller escalate thay vì im lặng mất state.
  const totalTokens = estimateTokens(kept.map((e) => e.text).join('\n'))
    + (summary ? estimateTokens(summary.text) : 0);

  return {
    kept,
    dropped: dropped.length,
    summary,
    totalTokens,
    overBudget: totalTokens > budgetTokens && kept.some(isProtectedEntry),
    compactionEvent: summary ? { droppedCount: dropped.length, preservedSpans: summary.preservedSpans } : null,
  };
}

/**
 * Progressive disclosure (B2): chọn entry từ index theo tags cần thiết.
 * Index entry: {name, path?, tokens?, tags:string[], content?}. Invariants luôn tải.
 * @param {{index: Array, neededTags: string[], budgetTokens: number, loader?: (entry)=>string}} input
 * @returns {{loaded: Array<{name,tokens,content}>, skipped: string[], totalTokens: number}}
 */
export function selectiveLoad({ index, neededTags, budgetTokens, loader }) {
  if (!Array.isArray(index)) throw new Error('[BLOCKED_INDEX_INVALID] index phải là mảng');
  if (!Array.isArray(neededTags) || !neededTags.length) {
    throw new Error('[BLOCKED_TAGS_INVALID] neededTags phải là mảng không rỗng');
  }
  if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) {
    throw new Error('[BLOCKED_BUDGET_INVALID] budgetTokens phải là số nguyên > 0');
  }
  const need = new Set(neededTags);
  const invariants = index.filter((e) => e.invariant);
  const candidates = index.filter((e) => !e.invariant && (e.tags || []).some((t) => need.has(t)));

  const loaded = [];
  const skipped = [];
  let used = 0;

  const loadOne = (e, mandatory) => {
    const content = loader ? loader(e) : (e.content != null ? String(e.content) : '');
    const tokens = e.tokens != null ? Number(e.tokens) : estimateTokens(content);
    if (!mandatory && used + tokens > budgetTokens) { skipped.push(e.name); return; }
    used += tokens;
    loaded.push({ name: e.name, tokens, content });
  };

  for (const inv of invariants) loadOne(inv, true); // invariant luôn tải, không bị budget chặn
  for (const c of candidates) loadOne(c, false);

  return { loaded, skipped, totalTokens: used };
}
