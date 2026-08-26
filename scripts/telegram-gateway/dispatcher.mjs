#!/usr/bin/env node
// dispatcher.mjs — Inbound command dispatch. Issue #15: CHỈ dispatch command, KHÔNG verdict self-review.
// Bot THỪA nhận lệnh từ Bố (vd: /ping, /status, /help) và phản hồi ngắn. Không tự gửi verdict review.
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './contract.mjs';

// Map command -> handler(routed) -> response string (hoặc null để bỏ qua).
const HANDLERS = {
  ping: () => 'pong',
  status: () => 'ok',
  help: () => 'commands: /ping /status /help',
};

export function dispatch(routed) {
  if (!routed || !routed.command) return null;
  const fn = HANDLERS[routed.command];
  if (!fn) return null; // unknown command -> không phát tự review verdict
  return { command: routed.command, response: fn(routed), fromId: routed.fromId };
}

// Xử lý 1 update inbound: dispatch + ghi ack file (để test/debug). Trả out hoặc null.
export function dispatchInbound(routed, { ackDir } = {}) {
  const out = dispatch(routed);
  if (!out) return null;
  const dir = ackDir || path.join(RUNTIME_DIR, 'acks');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ack-' + (routed.updateId || Date.now()) + '.json'), JSON.stringify(out));
  } catch {}
  return out;
}
