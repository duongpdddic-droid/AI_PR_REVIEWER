#!/usr/bin/env node
// memory-core.mjs — Persistent memory layer tối thiểu (Issue #9 C1–C5).
// Pure core + injectable IO. JSONL append-only (stdlib), không DB/dependency.
//
// C1: memory CHỈ lưu tri thức hỗ trợ (decision/fix-pattern/failure/convention/session-summary/
//     unresolved-pointer). CẤM lưu verdict authoritative (ci-verdict/approval/merge-authorization)
//     — chỉ chấp nhận bản ghi dạng pointer (URL/full-SHA tham chiếu), không phải kết luận.
// C2: append qua store — lỗi storage KHÔNG bao giờ ném vào caller (withGracefulDegradation).
// C4: consolidateMemories() — dedupe theo contentKey, supersede theo subjectKey (mới thắng),
//     cap maxEntries (giữ mới nhất), provenance/timestamp bắt buộc giữ nguyên.
// Stale-memory: resolveState() — mâu thuẫn memory vs evidence GitHub → GitHub thắng.

import crypto from 'node:crypto';

// Loại bản ghi bị cấm lưu như verdict (chỉ được lưu dạng pointer).
export const FORBIDDEN_VERDICT_KINDS = new Set(['ci-verdict', 'approval', 'merge-authorization']);
export const ALLOWED_KINDS = new Set([
  'decision', 'fix-pattern', 'workflow-failure', 'provider-failure',
  'convention', 'session-summary', 'unresolved-context', 'pointer',
]);

function contentKey(text) {
  const norm = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** Kiểm tra bản ghi observation hợp lệ. Trả {ok, error}. */
export function validateObservation(obs) {
  if (!obs || typeof obs !== 'object') return { ok: false, error: 'obs không phải object' };
  // Guard C1 kiểm tra TRƯỚC ALLOWED_KINDS để verdict authoritative có thông báo riêng tường minh.
  if (FORBIDDEN_VERDICT_KINDS.has(obs.kind)) {
    return { ok: false, error: `kind "${obs.kind}" là authoritative verdict — cấm lưu vào memory; dùng kind "pointer" với URL/SHA tham chiếu` };
  }
  if (!ALLOWED_KINDS.has(obs.kind)) return { ok: false, error: `kind "${obs.kind}" không nằm trong ALLOWED_KINDS` };
  if (!String(obs.content || '').trim()) return { ok: false, error: 'content rỗng' };
  const p = obs.provenance;
  if (!p || typeof p !== 'object' || !p.task) return { ok: false, error: 'thiếu provenance.task (bắt buộc)' };
  if (!obs.ts && !(p && p.ts)) return { ok: false, error: 'thiếu timestamp (ts hoặc provenance.ts)' };
  return { ok: true };
}

/**
 * Tạo memory store JSONL trên một file. IO inject được để test.
 * load() khoan dung: dòng hỏng → bỏ qua + warning (graceful degradation, không chết cả store).
 */
export function createMemoryStore({ file, io = {} }) {
  const readFile = io.readFile || (() => null);
  const appendFile = io.appendFile || (() => {});
  const warnings = [];

  function load() {
    const raw = readFile(file);
    if (raw == null || raw === '') return [];
    const out = [];
    for (const line of String(raw).split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        const v = validateObservation(obj);
        if (v.ok) out.push(obj);
        else warnings.push(`skip invalid record: ${v.error}`);
      } catch {
        warnings.push(`skip corrupt line (${s.slice(0, 24)}…)`);
      }
    }
    return out;
  }

  /** Append 1 observation. Trả {stored:true, record} | {stored:false, reason}. Không ném. */
  function append(obs) {
    try {
      const v = validateObservation(obs);
      if (!v.ok) return { stored: false, reason: v.error };
      const record = { ...obs, ts: obs.ts || (obs.provenance && obs.provenance.ts) };
      appendFile(file, `${JSON.stringify(record)}\n`);
      return { stored: true, record };
    } catch (e) {
      return { stored: false, reason: `storage-failure: ${(e && e.message) || e}` };
    }
  }

  return { load, append, warnings, path: file };
}

/**
 * C4 Consolidation (pure): dedupe + supersede + bounded growth.
 * - supersede: cùng subjectKey (nếu khai báo) → bản ts mới nhất thắng (fact cũ bị thay).
 * - dedupe: content trùng nhau (contentKey) → giữ một bản.
 * - cap: vượt maxEntries → bỏ cũ nhất (bounded growth, không append vô hạn).
 * Mọi entry trả về giữ nguyên provenance + ts.
 */
export function consolidateMemories(entries, { maxEntries = 200 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const bySubject = new Map(); // subjectKey -> newest entry
  for (const e of list) {
    const sk = e.subjectKey || `#${contentKey(e.content)}`;
    const prev = bySubject.get(sk);
    if (!prev) { bySubject.set(sk, e); continue; }
    const newer = String(e.ts || '') >= String(prev.ts || '');
    bySubject.set(sk, newer ? e : prev);
  }
  const byContent = new Map(); // dedupe exact-content
  for (const e of bySubject.values()) {
    const k = contentKey(e.content);
    if (!byContent.has(k)) byContent.set(k, e);
  }
  let out = [...byContent.values()].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  if (Number.isInteger(maxEntries) && maxEntries > 0 && out.length > maxEntries) {
    out = out.slice(out.length - maxEntries);
  }
  return out;
}

/**
 * Selective retrieval (pure): chấm điểm keyword overlap giữa query và content+tags.
 * Trả top-k {entry, score} — precision đo được bằng fixture test.
 */
export function retrieveMemories(entries, { query, limit = 5 } = {}) {
  const tokens = String(query || '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!tokens.length) return [];
  const scored = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const hay = `${e.content || ''} ${(e.tags || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    if (score > 0) scored.push({ entry: e, score });
  }
  scored.sort((a, b) => b.score - a.score || String(b.entry.ts || '').localeCompare(String(a.entry.ts || '')));
  return scored.slice(0, Math.max(1, limit));
}

/**
 * Stale-memory resolution (pure): memory claim KHÔNG BAO GIỜ thắng evidence authoritative.
 * authoritativeEvidence != null → luôn trả source 'github'; memory chỉ là hint có thể stale.
 */
export function resolveState({ memoryClaim = null, authoritativeEvidence = null } = {}) {
  if (authoritativeEvidence != null) {
    return {
      state: authoritativeEvidence,
      source: 'github',
      memoryWasStale: memoryClaim != null && memoryClaim !== authoritativeEvidence,
    };
  }
  return { state: memoryClaim, source: memoryClaim != null ? 'memory-only-unverified' : 'none', memoryWasStale: false };
}

/**
 * Graceful degradation wrapper (C2/AC): fn lỗi → trả {ok:false, degraded:true}
 * thay vì ném — memory/observation lỗi không làm hỏng coding/review workflow.
 */
export async function withGracefulDegradation(fn, fallbackValue = null) {
  try {
    const r = await fn();
    return { ok: true, value: r };
  } catch (e) {
    return { ok: false, degraded: true, error: String((e && e.message) || e), fallbackValue };
  }
}

