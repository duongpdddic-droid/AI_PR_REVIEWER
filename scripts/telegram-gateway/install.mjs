#!/usr/bin/env node
// install.mjs — Cài gateway runtime NGOÀI repo tại ~/.ai-pr-reviewer/gateway/ (KHÔNG commit).
// Copy token từ legacy tg.json nếu chưa có. Tạo dirs queue.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNTIME_DIR, CONFIG_FILE, OUTBOUND_DIR, INBOUND_DIR } from './contract.mjs';

const legacy = path.join(os.homedir(), '.ai-pr-reviewer', 'tg.json');
fs.mkdirSync(OUTBOUND_DIR, { recursive: true });
fs.mkdirSync(INBOUND_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(legacy)) {
  fs.copyFileSync(legacy, CONFIG_FILE); // token runtime, không commit
  console.log('install: copied tg.json -> gateway/config.json (token runtime, KHÔNG commit)');
} else if (fs.existsSync(CONFIG_FILE)) {
  console.log('install: gateway/config.json đã tồn tại, giữ nguyên');
} else {
  console.log('install: CHƯA có config — tạo ' + CONFIG_FILE + ' thủ công {botToken,chatId}');
}
console.log('install: runtime dir ' + RUNTIME_DIR + ' sẵn sàng.');
console.log('Chạy gateway:  node scripts/telegram-gateway/gateway.mjs --start');
console.log('Hoặc supervisor: node scripts/telegram-gateway/supervisor.mjs --run');
