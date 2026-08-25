#!/usr/bin/env node
// runtime-hooks.mjs — Nối memory/observation/recovery/telemetry primitives vào runtime THẬT
// (Issue #9 / GPT-REV-059). Facade duy nhất mà execution path (autonomous-run.mjs) gọi:
//   - recordObservation(): observation → validate → JSONL store thật (fs), lỗi → degrade, KHÔNG ném.
//   - consolidateMemory(): load → dedupe/supersede/cap (bounded persistence, atomic rewrite).
//   - recover(): classify + planRecovery + TỰ ghi telemetry event (recovery sinh telemetry,
//     identity echo nguyên vẹn); policy fail-closed giữ nguyên trong planRecovery.
//   - recordEvent(): redact đệ quy rồi append events.jsonl; lỗi → degraded:true.
// Persistence: <root>/.agent/runtime/{observations.jsonl,events.jsonl} — sống qua restart
// (integration test chứng minh load lại được sau khi tạo instance mới).
import fs from 'node:fs';
import path from 'node:path';
import { planRecovery, recordExecutionEvent } from './error-recovery.mjs';
import { consolidateMemories, createMemoryStore } from './memory-core.mjs';

export function createRuntimeHooks({ rootDir = process.cwd(), io } = {}) {
  const dir = path.join(rootDir, '.agent', 'runtime');
  const memPath = path.join(dir, 'observations.jsonl');
  const evPath = path.join(dir, 'events.jsonl');
  const store = createMemoryStore({ file: memPath, io });

  function appendJsonl(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
  }

  /** Đọc toàn bộ JSONL file (khoan dung dòng hỏng — bỏ qua). */
  function readJsonl(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const line of String(raw || '').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* bỏ qua dòng hỏng */ }
    }
    return out;
  }

  /**
   * Ghi 1 observation vào memory store. Trả {ok:true,value} | {ok:false,degraded|reason}.
   * Không bao giờ ném — observation lỗi không block workflow (AC C2).
   * Sync cố ý: execution path (autonomous-run) gọi trực tiếp, không fire-and-forget.
   */
  function recordObservation(obs) {
    try {
      const r = store.append(obs);
      if (!r.stored) return { ...r, ok: false };
      return { ok: true, value: r.record };
    } catch (e) {
      return { ok: false, degraded: true, error: String((e && e.message) || e) };
    }
  }

  /** Consolidate bounded + atomic rewrite file memory. Không ném (degrade khi IO lỗi). */
  function consolidateMemory({ maxEntries = 200 } = {}) {
    try {
      const entries = store.load();
      const kept = consolidateMemories(entries, { maxEntries });
      if (kept.length === entries.length && entries.length <= maxEntries) {
        return { ok: true, value: kept, rewritten: false };
      }
      const tmp = `${memPath}.tmp`;
      fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, memPath);
      return { ok: true, value: kept, rewritten: true };
    } catch (e) {
      return { ok: false, degraded: true, error: String((e && e.message) || e) };
    }
  }

  /** Ghi 1 telemetry event đã redact đệ quy vào events.jsonl. Không ném. */
  function recordEvent(evt) {
    try {
      const [record] = recordExecutionEvent([], { ts: new Date().toISOString(), ...(evt || {}) });
      appendJsonl(evPath, record);
      return { ok: true, value: record };
    } catch (e) {
      return { ok: false, degraded: true, error: String((e && e.message) || e) };
    }
  }

  /**
   * Recovery path thật: classify + planRecovery (pure) rồi TỰ ghi telemetry event
   * (outcome=recovery:<action>, identity echo nguyên vẹn). Plan trả về cho caller hành động;
   * policy fail-closed nằm trong planRecovery — facade không tự mở nhánh fallback.
   */
  function recover(input) {
    const errorClass = input && input.errorClass;
    const plan = planRecovery(input);
    try {
      appendJsonl(evPath, {
        taskId: (input && input.taskId) ?? null,
        issue: (input && input.issue) ?? null,
        provider: (input && input.identity && input.identity.provider) ?? null,
        model: (input && input.identity && input.identity.model) ?? null,
        attempt: Number(input && input.attempts) || 0,
        errorClass: errorClass ?? null,
        toolFailure: null,
        compactionEvent: null,
        fallbackEvent: plan.action === 'fallback-model' ? { to: plan.nextTarget } : null,
        manualIntervention: false,
        outcome: `recovery:${plan.action}`,
        durationMs: null,
        ts: new Date().toISOString(),
        note: plan.reason,
        identity: (input && input.identity) || {},
      });
    } catch { /* telemetry lỗi không block recovery decision */ }
    return plan;
  }

  return {
    store,
    recordObservation,
    recordEvent,
    recover,
    consolidateMemory,
    loadEvents: () => readJsonl(evPath),
    paths: { memory: memPath, events: evPath },
  };
}
