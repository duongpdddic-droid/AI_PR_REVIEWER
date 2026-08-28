#!/usr/bin/env node
// setup-pre-push-hook.mjs — cài git hook pre-push CỤC BỘ (nằm trong .git/, không commit)
// trỏ vào scripts/pre-push-guard.mjs (Issue #22). Chạy lại khi cần (idempotent).

import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const res = spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' });
if (res.error || res.status !== 0) {
  console.error('không xác định được git dir — chạy trong repo?');
  process.exit(1);
}
const gitDir = path.resolve(String(res.stdout).trim());
const hookPath = path.join(gitDir, 'hooks', 'pre-push');
const guardPath = fileURLToPath(new URL('./pre-push-guard.mjs', import.meta.url)).replace(/\\/g, '/');
const content = `#!/bin/sh
# PRE-PUSH HEAD-LOCK guard (Issue #22) — cài tự động bởi scripts/setup-pre-push-hook.mjs.
# Chặn push khi branch của PR open đang FROZEN mà HEAD lệch lock. Xóa file này để tắt.
node "${guardPath}" || exit 1
`;
writeFileSync(hookPath, content, 'utf8');
try { chmodSync(hookPath, 0o755); } catch { /* Windows: không cần exec bit */ }
console.log(`hook đã cài: ${hookPath}`);