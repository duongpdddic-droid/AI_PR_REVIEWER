#!/usr/bin/env node
// transport.mjs — Telegram transport (sendMessage + getUpdates) với retry/429, KHÔNG shell exec.
// Token/chatId chỉ đọc từ runtime config (NGOÀI repo), không hardcode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withRetry } from '../tg-notify-core.mjs';
import { CONFIG_FILE, POLL_TIMEOUT_S } from './contract.mjs';

// Ưu tiên: env -> gateway config.json -> legacy ~/.ai-pr-reviewer/tg.json.
// `GATEWAY_NO_LEGACY_CFG=1` (test) bỏ fallback legacy homedir để deterministic (máy có tg.json thật sẽ không
// bị dùng bot thật làm poll vô hạn / gây 409).
export function loadConfig() {
  const env = { botToken: process.env.TG_BOT_TOKEN, chatId: process.env.TG_CHAT_ID, allowedUserIds: parseAllowedUsers(process.env.GATEWAY_ALLOWED_USERS) };
  if (env.botToken && env.chatId) return env;
  const candidates = [CONFIG_FILE];
  if (!(process.env.GATEWAY_NO_LEGACY_CFG === '1')) {
    candidates.push(path.join(os.homedir(), '.ai-pr-reviewer', 'tg.json'));
  }
  for (const p of candidates) {
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (c.botToken && c.chatId) return { botToken: c.botToken, chatId: c.chatId, allowedUserIds: parseAllowedUsers(c.allowedUserIds), _src: p };
    } catch {}
  }
  return null;
}

function parseAllowedUsers(v) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s) return new Set();
  return new Set(s.split(/[,\s]+/).map((x) => String(x).trim()).filter(Boolean));
}

// Gửi 1 tin nhắn. Retry trên lỗi mạng + 5xx + 429 (tôn trọng Retry-After). KHÔNG dùng shell.
// Trả { ok, status, retryAfter, attempts, error? }.
export async function sendTelegram(
  { token, chatId, text, parseMode = 'HTML', disableWebPagePreview = true },
  { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fetchImpl = fetch, attempts = 4 } = {},
) {
  let lastStatus = null;
  let lastRetryAfter = null;
  try {
    await withRetry(async () => {
      const res = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: disableWebPagePreview,
        }),
      });
      lastStatus = res.status;
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') || '5');
        lastRetryAfter = ra;
        await sleep(ra * 1000);
        throw new Error('HTTP 429 retry-after=' + ra);
      }
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 300);
        throw new Error('HTTP ' + res.status + ' ' + errText);
      }
    }, { attempts, delayMs: 2000, sleep });
    return { ok: true, status: lastStatus, retryAfter: lastRetryAfter, attempts };
  } catch (e) {
    return {
      ok: false, status: lastStatus, retryAfter: lastRetryAfter, attempts,
      error: String((e && e.message) || e),
    };
  }
}

// Lấy updates (inbound). offset = update_id+1. timeout long-poll. Trả { ok, status, updates, offset }.
export async function getUpdates(
  { token, offset = 0, timeout = POLL_TIMEOUT_S, limit = 100, fetchImpl = fetch } = {},
) {
  const url = 'https://api.telegram.org/bot' + token
    + '/getUpdates?offset=' + offset + '&timeout=' + timeout + '&limit=' + limit;
  const res = await fetchImpl(url);
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after') || '5');
    return { ok: false, status: 429, retryAfter: ra, updates: [] };
  }
  if (!res.ok) return { ok: false, status: res.status, updates: [] };
  const data = await res.json();
  const updates = Array.isArray(data && data.result) ? data.result : [];
  let nextOffset = offset;
  for (const u of updates) if (typeof u.update_id === 'number') nextOffset = Math.max(nextOffset, u.update_id + 1);
  return { ok: true, status: res.status, updates, offset: nextOffset };
}
