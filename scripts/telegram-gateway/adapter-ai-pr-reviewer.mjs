#!/usr/bin/env node
// adapter-ai-pr-reviewer.mjs — Legacy adapter (Issue #15).
// ENQUEUE vào gateway outbound queue (single source of truth). Giữ tới khi soak test xong.
import { execSync } from 'node:child_process';
import { enqueue, APP_NS } from './contract.mjs';
import { EVENT_LABELS } from '../tg-notify-core.mjs';

function currentRepo() { return process.env.GITHUB_REPOSITORY || 'AI_PR_REVIEWER'; }

// HEAD SHA đầy đủ để idempotency key đổi khi commit thay đổi (GPT-REV-080).
function currentHead() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return ''; }
}

// Tương đương notifyTelegram(eventType, ref, state, summary, nextAction) của autonomous-run.mjs.
export function notifyTelegram(eventType, ref, state, summary, nextAction, { appNs = APP_NS } = {}) {
  const ev = EVENT_LABELS[eventType] ? eventType : 'done';
  const payload = {
    eventType: ev, appNs, repo: currentRepo(), ref: ref || '', state,
    summary, nextAction, head: currentHead(),
  };
  return enqueue(appNs, 'outbound', payload);
}

// Tương đương io.notify(title, summary) của unified-orchestrator (raw text, không event mode).
export function notifyRaw(title, summary, { appNs = APP_NS } = {}) {
  const payload = {
    eventType: 'done',
    appNs,
    repo: currentRepo(),
    ref: '',
    state: 'notify',
    summary: (title ? '✅ ' + title + '\n' : '') + (summary || ''),
    nextAction: '',
    head: currentHead(),
  };
  return enqueue(appNs, 'outbound', payload);
}
