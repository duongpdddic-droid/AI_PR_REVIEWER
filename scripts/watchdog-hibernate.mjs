#!/usr/bin/env node
// Watchdog theo chi thi Bo (13/08/2026, msg #108/#110):
//   - Khong tu dong ngu dong. Chi hoi Bo qua Telegram.
//   - May idle >= 15p (khong input) VA khong co task Cline dang chay -> gui tin nhan hoi Bo:
//       "May idle 15p, Bo co muon ngu dong khong? Reply CO de ngu dong ngay."
//   - Neu Bo KHONG reply trong 10p -> GUI NHAC NHO hoi lai (KHONG tu dong ngu dong). Chi hoi, cho Bo quyet dinh.
//   - Chi ngu dong (shutdown /h) khi Bo reply "CO"/"NGU"/"SHUTDOWN"/"HIBERNATE"
//     VA khong co task Cline dang chay + may van idle.
//   - Bo chi thi 13/08 (#162/#164): BO HEN AUTO-HIBERNATE; chi nhac nho hoi Bo.
//   - Bridge telegram KHONG bi tat (watchdog khong kill bridge; may shutdown thi bridge chet,
//     nhung bridge-monitor.mjs se tu bat lai sau khi may wake/boot).
// Cach dung:
//   node scripts/watchdog-hibernate.mjs --arm [--title <task>]   // arm daemon (idle mac dinh 15p)
//   node scripts/watchdog-hibernate.mjs --cancel                 // Bo ra lenh -> huy
//   node scripts/watchdog-hibernate.mjs --status
//   node scripts/watchdog-hibernate.mjs --dry-run ...            // in quyet dinh, KHONG ngu that
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { silenceTimeoutLevels, resetOnActivity, watchdogSilenceTick, commitSilenceLevel, SILENCE_DEFAULTS } from './tg-notify-core.mjs'; // Issue #16

const DIR = path.join(os.homedir(), '.qldadtxd');
const GUARD = path.join(DIR, 'guard.json');
const INBOX = path.join(DIR, 'inbox.md');
const LOG = path.join(DIR, 'guard.log');
const TG = path.join(DIR, 'tg.json');

const DRY = process.argv.includes('--dry-run');
const IDLE_MIN = 15;       // may bo trong neu idle >= 15 phut
const ASK_TIMEOUT_MS = 10 * 60_000; // cho Bo reply toi da 10p
const WAIT_MS = 30_000;    // chu ky daemon

const log = (m) => { const l = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) + ' ' + m; try { fs.appendFileSync(LOG, l + '\n'); } catch {} console.log(l); };
const readGuard = () => { try { return JSON.parse(fs.readFileSync(GUARD, 'utf8')); } catch { return null; } };
const saveGuard = (g) => fs.writeFileSync(GUARD, JSON.stringify(g, null, 2));
const readTg = () => { try { return JSON.parse(fs.readFileSync(TG, 'utf8')); } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gui tin nhan Telegram cho Bo (chi sendMessage; khong getUpdates de tranh conflict voi bridge daemon).
async function sendTelegram(text) {
  const cfg = readTg();
  const token = process.env.TG_BOT_TOKEN || cfg.botToken || '';
  const chatId = process.env.TG_CHAT_ID || cfg.chatId || '';
  if (!token || !chatId) { log('watchdog: thieu botToken/chatId'); return false; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (e) { log('watchdog: gui telegram loi ' + e.message); return false; }
}

// Nội dung cảnh báo im lặng 2 mức (REV-020). Daemon chỉ gửi đúng 1 lần mỗi cấp; không tự đổi GitHub state.
function silenceText(eventType, taskTitle) {
  const t = taskTitle || 'task';
  if (eventType === 'timeout-level1') {
    return '⚠️ Cảnh báo im lặng (lần 1): chưa thấy hoạt động Cline hơn 30 phút (task: ' + t + '). Cline có thể vẫn đang chạy; nếu tiếp tục im lặng Bố sẽ nhận cảnh báo nghiêm trọng. KHÔNG tự động tắt máy.';
  }
  return '🚨 Cảnh báo im lặng (nghiêm trọng): hơn 60 phút không thấy hoạt động Cline (task: ' + t + '). KHÔNG tự kết luận hoàn thành/blocked — Bố mở VS Code kiểm tra Cline. KHÔNG tự động tắt máy.';
}

// Bo co reply "CO" tu khi askedAt khong? Doc inbox.md (bridge daemon da ghi moi tin Bố).
function boSaidYesSince(askedAt) {
  if (!fs.existsSync(INBOX)) return false;
  const parts = fs.readFileSync(INBOX, 'utf8').split(/^## /m).slice(1);
  for (const part of parts) {
    const head = part.split('\n')[0];
    const chat = (/ \| msg \d+ \| chat (\d+) /.exec(head) || [])[1];
    const ts = (/^(\d{2}:\d{2}:\d{2} \d{1,2}\/\d{1,2}\/\d{4})/.exec(head) || [])[1];
    const t = ts ? Date.parse(ts.replace(/^(\d{2}):(\d{2}):(\d{2}) (\d{1,2})\/(\d{1,2})\/(\d{4})$/, '$6-$5-$4T$1:$2:$3+07:00')) : NaN;
    if (chat !== '816272951') continue;
    if (!Number.isFinite(t) || t < askedAt) continue;
    const body = part.split('\n').slice(1).join('\n').toLowerCase();
    if (/\b(có|co|ngu|ngủ|shutdown|hibernate|tắt|tắt máy|tắt máy)\b/.test(body)) return true;
  }
  return false;
}

const clineActive = (g) => !!(g && g.clineActive === true);

function idleSeconds() {
  const code = 'using System.Runtime.InteropServices; public class IdleProbe { [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p); public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } }';
  const ps = "Add-Type -TypeDefinition '" + code + "'; $p = New-Object IdleProbe+LASTINPUTINFO; $p.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($p); [IdleProbe]::GetLastInputInfo([ref]$p) | Out-Null; ([Environment]::TickCount - $p.dwTime) / 1000";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  const n = parseFloat(r.stdout ? r.stdout.trim() : '');
  return Number.isFinite(n) ? n : Infinity;
}

function executeHibernate() {
  if (DRY) { log('DRY-RUN: se thuc hien HIBERNATE (shutdown /h)'); return 0; }
  log('Chay lenh HIBERNATE (shutdown /h)');
  return (spawnSync('shutdown', ['/h'], { windowsHide: true, timeout: 20_000 }).status) ?? 0;
}

async function daemonLoop() {
  for (;;) {
    const g = readGuard();
    if (!g) { log('daemon: khong co guard.json -> thoat'); process.exit(0); }
    if (g.cancel) { fs.rmSync(GUARD, { force: true }); log('daemon: Bo da ra lenh -> huy, thoat'); process.exit(0); }
    const now = Date.now();
    const idleMin = idleSeconds() / 60;

    if (idleMin >= IDLE_MIN && !clineActive(g) && !g.askedAt) {
      await sendTelegram('Máy idle ' + Math.round(idleMin) + 'p, Bố có muốn ngủ đông không? Reply CO/NGU/SHUTDOWN để ngủ đông ngay. Quá 10p không reply sẽ GỬI NHẮC NHỞ (không tự động).');
      g.askedAt = now; saveGuard(g);
      log('daemon: idle=' + Math.round(idleMin) + 'p, da hoi Bo co ngu dong');
    }

    if (g.askedAt) {
      if (boSaidYesSince(g.askedAt)) {
        if (!clineActive(g)) {
          log('daemon: Bo dong y + khong task -> ngu dong');
          executeHibernate();
          fs.rmSync(GUARD, { force: true });
          process.exit(0);
        }
        g.askedAt = null; saveGuard(g);
        log('daemon: Bo dong y nhung dang co task -> cho task xong');
      } else if (now - g.askedAt > ASK_TIMEOUT_MS && !g.reminded) {
        // Luat moi (13/08, #162/#164): QUA 10p Bo khong reply -> GUI NHAC NHO hoi lai, KHONG tu dong ngu dong.
        await sendTelegram('Nhắc nhở: máy idle ' + Math.round(idleMin) + 'p. Bố có cho máy tính SLEEP hoặc NGỦ ĐÔNG không? Reply CO/NGU/SHUTDOWN để thực hiện, hoặc KHÔNG/GIỮ để giữ máy. (Không tự động tắt máy.)');
        g.reminded = true; saveGuard(g);
        log('daemon: qua 10p khong reply -> gui nhac nho (KHONG tu dong ngu dong)');
      }
    }

    // REV-020: đánh giá im lặng mỗi chu kỳ; gửi timeout-level1/level2 đúng 1 lần mỗi cấp (chống lặp qua
    // guard.silenceWarnLevel). KHÔNG tự đổi GitHub state, KHÔNG kết luận task. Heartbeat mới sẽ reset.
    // REV-023: chỉ ghi cấp đã gửi SAU khi sendTelegram thành công; fail → KHÔNG ghi gì (giữ guard cũ
    // trên đĩa, không clobber heartbeat cập nhật song song) → tick kế tiếp vẫn retry.
    const tick = watchdogSilenceTick(g, now, SILENCE_DEFAULTS);
    if (tick.events.length) {
      const sentOk = await sendTelegram(silenceText(tick.events[0], g.taskTitle));
      if (!sentOk) {
        log('daemon: gui canh bao ' + tick.events[0] + ' FAIL -> giu guard cu, cho tick sau retry');
      } else {
        // REV-025: đọc LẠI guard từ đĩa sau khi network xong. Nếu giữa lúc send có heartbeat/cancel/arm
        // mới (observation đổi) → commitSilenceLevel giữ nguyên trạng thái mới, KHÔNG ghi snapshot cũ;
        // guard bị xóa (null) → không ghi lại. Khi khớp observation → merge duy nhất silenceWarnLevel.
        const current = readGuard();
        const toWrite = commitSilenceLevel(g, tick, current);
        if (toWrite) saveGuard(toWrite);
        const merged = !!(toWrite && toWrite.silenceWarnLevel === tick.guard.silenceWarnLevel);
        log(merged
          ? 'daemon: silence=' + tick.guard.silenceWarnLevel + ' -> gui canh bao ' + tick.events[0] + ' OK'
          : 'daemon: canh bao ' + tick.events[0] + ' gui OK nhung guard da doi (heartbeat/cancel/arm) -> khong ghi cap cu');
      }
    }

    await sleep(WAIT_MS);
  }
}

const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
const cmd = args[0];
if (cmd === '--arm') {
  const ti = args.indexOf('--title');
  const title = ti >= 0 ? args[ti + 1] : 'task';
  const now = Date.now();
  const g0 = { cancel: false, taskTitle: title, armedAt: now, askedAt: null, clineActive: false, reminded: false, lastHeartbeat: now, silenceWarnLevel: 'active' };
  saveGuard(g0);
  log('arm: ' + title + ' -> idle ' + IDLE_MIN + 'p se hoi Bo (DRY=' + DRY + ')');
  if (!DRY) {
    const child = spawn(process.execPath, [process.argv[1], '--daemon'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    g0.pid = child.pid; saveGuard(g0); // luu pid de monitor kiem tra song chet
  }
  console.log('watchdog: armed (idle ' + IDLE_MIN + 'p -> hoi Bo)');
} else if (cmd === '--cancel') {
  const g = readGuard();
  if (g) { g.cancel = true; saveGuard(g); console.log('watchdog: da huy (Bo ra lenh)'); }
  else console.log('watchdog: khong co guard');
} else if (cmd === '--heartbeat') {
  // REV-021: heartbeat KHÔNG được tạo guard mồ côi. Không có guard (chưa arm) -> no-op có kiểm soát,
  // để lần notify/arm sau vẫn arm đúng 1 đường code duy nhất (có daemon + pid).
  const g = readGuard();
  if (!g) {
    console.log('watchdog: khong co guard (chua arm) -> heartbeat no-op, khong tao guard');
  } else {
    const g2 = resetOnActivity(g, Date.now()); // lastHeartbeat=now, silenceWarnLevel='active'
    g2.askedAt = null; g2.reminded = false; // resume: khong gui canh bao cu, hoan ngu dong
    saveGuard(g2);
    console.log('watchdog: heartbeat received -> reset silence, resume');
  }
} else if (cmd === '--status') {
  const g = readGuard();
  if (!g) console.log('watchdog: khong co bo dem ngu dong');
  else {
    const silence = silenceTimeoutLevels({ armedAt: g.armedAt, lastHeartbeat: g.lastHeartbeat, now: Date.now(), level1Ms: SILENCE_DEFAULTS.level1Ms, level2Ms: SILENCE_DEFAULTS.level2Ms });
    console.log(g.cancel
      ? 'watchdog: DA HUY (cancel)'
      : 'watchdog: task=' + g.taskTitle + ' | askedAt=' + (g.askedAt ? new Date(g.askedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : 'chua hoi') + ' | clineActive=' + !!g.clineActive + ' | silence=' + silence + (g.silenceWarnLevel ? ' | warnLevel=' + g.silenceWarnLevel : ''));
  }
} else if (cmd === '--daemon') {
  daemonLoop();
} else {
  console.log('usage: node scripts/watchdog-hibernate.mjs --arm [--title text] | --cancel | --heartbeat | --status | --dry-run');
}
