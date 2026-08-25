#!/usr/bin/env node
// runtime-hooks.mjs — Nối memory/observation/recovery/telemetry primitives vào runtime THẬT
// (Issue #9 / GPT-REV-059). Facade duy nhất mà execution path (autonomous-run.mjs) gọi:
//   - recordObservation(): observation → validate → JSONL store thật (fs), lỗi → degrade, KHÔNG ném.
//   - consolidateMemory(): load → dedupe/supersede/cap (bounded persistence, atomic rewrite).
//   - recover(): classify + planRecovery + TỰ ghi telemetry event (recovery sinh telemetry,
//     identity echo nguyên vẹn); policy fail-closed giữ nguyên trong planRecovery.
//   - recordEvent(): redact đệ quy rồi append events.jsonl; lỗi → degraded:true.
// Persistence (GPT-REV-063): MẶC ĐỊNH NGOÀI Git worktree —
//   <homedir>/.agent-runtime/<basename>-<sha1-12(cwd)>/{observations,events}.jsonl
//   → git add -A không bao giờ nhặt được runtime state; override bằng {runtimeDir} khi test.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planRecovery, recordExecutionEvent } from './error-recovery.mjs';
import { consolidateMemories, createMemoryStore } from './memory-core.mjs';

/** Thư mục runtime mặc định NGOÀI worktree (GPT-REV-063): ổn định theo rootDir, sống qua restart. */
export function defaultRuntimeDir(rootDir) {
  const base = path.basename(String(rootDir || 'workspace')) || 'workspace';
  const key = `${base}-${crypto.createHash('sha1').update(String(rootDir)).digest('hex').slice(0, 12)}`;
  return path.join(os.homedir(), '.agent-runtime', key);
}

export function createRuntimeHooks({ rootDir = process.cwd(), runtimeDir, io } = {}) {
  const dir = runtimeDir || defaultRuntimeDir(rootDir);
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
   * Recovery path thật: classify + planRecovery (pure) rồi ghi telemetry QUA recordEvent()
   * (GPT-REV-062: duy nhất một sanitizer/schema writer — KHÔNG appendJsonl event thô).
   * outcome=recovery:<action>, identity echo nguyên vẹn (đã redact); policy fail-closed
   * nằm trong planRecovery — facade không tự mở nhánh fallback.
   */
  function recover(input) {
    const errorClass = input && input.errorClass;
    const plan = planRecovery(input);
    // Telemetry lỗi không block recovery decision (recordEvent tự degrade, không ném).
    recordEvent({
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
      note: plan.reason,
      identity: (input && input.identity) || {},
    });
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
