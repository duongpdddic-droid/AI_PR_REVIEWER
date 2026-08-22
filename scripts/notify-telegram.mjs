#!/usr/bin/env node
// Gửi tin Telegram báo trạng thái cho Bố (chat_id 816272951).
// Config: ~/.ai-pr-reviewer/tg.json  {"botToken":"...","chatId":"..."}
// Override: env TG_BOT_TOKEN / TG_CHAT_ID / AI_PR_REVIEWER_TG_CONFIG
// Cách dùng (legacy): node scripts/notify-telegram.mjs "<tiêu đề>" "<nội dung>"
// Cách dùng (event, Issue #16): node scripts/notify-telegram.mjs --event '<json>'
//   json: {eventType, repo, ref, state, summary, nextAction, link}
//   -> dựng message chuẩn (tg-notify-core.buildMessage) + chống gửi trùng theo eventKey
//   (repo::ref::event::state). Nếu đã gửi thành công cùng khóa -> skip, không tạo tin thứ 2.
//   --event-file <path>: đọc JSON từ file khi shell (PowerShell 5.1) nuốt dấu nháy kép của --event.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMessage, eventKey, NotificationStore, EVENT_LABELS, shouldArm, withRetry } from './tg-notify-core.mjs';

const configPath = process.env.AI_PR_REVIEWER_TG_CONFIG || path.join(os.homedir(), '.ai-pr-reviewer', 'tg.json');
const GUARD_PATH = path.join(os.homedir(), '.ai-pr-reviewer', 'guard.json');
const KEYS_PATH = path.join(os.homedir(), '.ai-pr-reviewer', 'notify-keys.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
const botToken = process.env.TG_BOT_TOKEN || cfg.botToken || '';
const chatId = process.env.TG_CHAT_ID || cfg.chatId || '';
if (!botToken || !chatId) {
  console.error('notify-telegram: thieu botToken/chatId (config: ' + configPath + ')');
  process.exit(2);
}

const argv = process.argv.slice(2);
const noGuard = argv.includes('--no-guard');
const evIdx = argv.indexOf('--event');
const evFileIdx = argv.indexOf('--event-file');
const stamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

let body;
let store = null;
let key = null;
let armTitle = 'task';
if (evIdx >= 0 || evFileIdx >= 0) {
  let raw;
  if (evFileIdx >= 0) {
    try { raw = fs.readFileSync(argv[evFileIdx + 1], 'utf8'); }
    catch (e) { console.error('notify-telegram: --event-file đọc lỗi: ' + (e && e.message)); process.exit(2); }
  } else {
    raw = argv[evIdx + 1] || 'null';
  }
  let ev;
  try { ev = JSON.parse(raw); } catch { console.error('notify-telegram: --event JSON lỗi'); process.exit(2); }
  if (!ev || typeof ev !== 'object') { console.error('notify-telegram: --event cần object JSON'); process.exit(2); }
  key = eventKey(ev);
  store = new NotificationStore({
    load: () => { try { return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); } catch { return {}; } },
    save: (o) => fs.writeFileSync(KEYS_PATH, JSON.stringify(o, null, 2)),
  });
  if (!store.shouldSend(key)) {
    console.log('notify-telegram: duplicate skip (eventKey=' + key + ')');
    process.exit(0);
  }
  body = buildMessage(ev) + '\n🕐 ' + stamp;
  armTitle = EVENT_LABELS[ev.eventType] || ev.eventType || 'task';
} else {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const title = argv[0] || 'Task hoan thanh';
  const text = argv.slice(1).join(' ') || '';
  body = '<b>\u2705 ' + esc(title) + '</b>\n\uD83D\uDD50 ' + stamp + (text ? '\n' + esc(text) : '');
  armTitle = argv[0] || 'Task hoan thanh';
}

// Gửi với retry có giới hạn (Issue #2 A7): tối đa 3 lần, nghỉ 2s*lượt-fail giữa các lần.
let res = null;
try {
  await withRetry(async (attempt) => {
    const r = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) {
      const errText = (await r.text()).slice(0, 300);
      throw new Error('HTTP ' + r.status + ' ' + errText);
    }
    res = r;
  }, { attempts: 3, delayMs: 2000 });
} catch (e) {
  console.error('notify-telegram: FAIL sau retry co gioi han — ' + (e && e.message));
  process.exit(1);
}
if (store && key) store.markSent(key); // chỉ đánh dấu SENT sau khi gửi thành công (retry sau lỗi vẫn cho phép)
console.log('notify-telegram: sent to ' + chatId + (key ? ' (eventKey=' + key + ')' : ''));

// Chi thi Bo 12/08/2026: xong task -> arm watchdog 45 phut tu ngu dong neu khong ra lenh moi.
// Vo hieu voi --no-guard (khi test, khong muon arm).
if (!noGuard) {
  try {
    const wd = fileURLToPath(new URL('watchdog-hibernate.mjs', import.meta.url));
    // REV-021: chỉ bỏ qua arm khi có daemon hợp lệ đang chạy (guard sống + pid + chưa cancel);
    // guard mồ côi (pid chết/thiếu hoặc cancel) vẫn được arm lại theo đúng 1 đường code duy nhất.
    let guard = null;
    try { guard = JSON.parse(fs.readFileSync(GUARD_PATH, 'utf8')); } catch {}
    if (shouldArm(guard)) {
      const r = spawnSync(process.execPath, [wd, '--arm', '--title', armTitle], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      console.log(r.status === 0 ? 'watchdog: armed nhac nho (idle 15p se hoi Bo).' : 'watchdog arm FAIL: ' + (r.stderr || r.stdout || '').trim());
    } else {
      console.log('watchdog: da armed (guard daemon hop le) -> bo qua spawn trung lap');
    }
  } catch (e) { console.warn('watchdog arm error: ' + e.message); }
}