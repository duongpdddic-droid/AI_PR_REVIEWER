#!/usr/bin/env node
// adapter-ai-pr-reviewer.mjs — Legacy adapter (Issue #15).
// Giữ API cũ của unified-orchestrator / autonomous-run nhưng ENQUEUE vào gateway outbound queue
// (thay vì gọi fetch trực tiếp) -> single source of truth, chỉ gateway mới thực sự gửi.
// Giữ tới khi soak test xong; sau đó xóa notify-telegram.mjs và gọi gateway trực tiếp.
import { enqueue, APP_NS } from './contract.mjs';
import { EVENT_LABELS } from '../tg-notify-core.mjs';

function currentRepo() { return process.env.GITHUB_REPOSITORY || 'AI_PR_REVIEWER'; }

// Tương đương notifyTelegram(eventType, ref, state, summary, nextAction) của autonomous-run.mjs.
export function notifyTelegram(eventType, ref, state, summary, nextAction, { appNs = APP_NS } = {}) {
  const ev = EVENT_LABELS[eventType] ? eventType : 'done';
  const payload = {
    eventType: ev, repo: currentRepo(), ref: ref || '', state, summary, nextAction,
  };
  return enqueue(appNs, 'outbound', payload);
}

// Tương đương io.notify(title, summary) của unified-orchestrator (raw text, không event mode).
export function notifyRaw(title, summary, { appNs = APP_NS } = {}) {
  const payload = {
    eventType: 'done',
    repo: currentRepo(),
    ref: '',
    state: 'notify',
    summary: (title ? '✅ ' + title + '\n' : '') + (summary || ''),
    nextAction: '',
  };
  return enqueue(appNs, 'outbound', payload);
}
