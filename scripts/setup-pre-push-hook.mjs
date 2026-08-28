#!/usr/bin/env node
// setup-pre-push-hook.mjs — cài git hook pre-push CỤC BỘ (nằm trong .git/, không commit)
// trỏ vào scripts/pre-push-guard.mjs (Issue #22). Chạy lại khi cần (idempotent).
//
// [GPT-REV-CHANGES-04] KHÔNG overwrite hook có sẵn của người dùng: nếu .git/hooks/pre-push đã
// tồn tại mà KHÔNG phải hook do script này cài (thiếu marker quản lý) → fail-closed (exit 1, giữ
// nguyên hook cũ) thay vì ghi đè. Chỉ hook do chính script cài (có marker) mới được ghi lại.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MARKER = '# PRE-PUSH HEAD-LOCK guard (Issue #22)';

const res = spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' });
if (res.error || res.status !== 0) {
  console.error('không xác định được git dir — chạy trong repo?');
  process.exit(1);
}
const gitDir = path.resolve(String(res.stdout).trim());
const hookPath = path.join(gitDir, 'hooks', 'pre-push');
const guardPath = fileURLToPath(new URL('./pre-push-guard.mjs', import.meta.url)).replace(/\\/g, '/');
const content = `#!/bin/sh
${MARKER} — cài tự động bởi scripts/setup-pre-push-hook.mjs.
# Chặn push khi branch của PR open đang FROZEN mà HEAD lệch lock. Xóa file này để tắt.
node "${guardPath}" || exit 1
`;

if (existsSync(hookPath)) {
  const existing = readFileSync(hookPath, 'utf8');
  if (!existing.includes(MARKER)) {
    // Hook do người dùng/khác cài — KHÔNG được phép overwrite. Trình hướng dẫn người dùng chain
    // thủ công hoặc gỡ bỏ hook cũ. Fail-closed: exit 1, giữ nguyên hook hiện có.
    console.error(`hook pre-push ĐÃ TỒN TẠI nhưng không phải do script này cài (thiếu marker "${MARKER}"): ${hookPath}`);
    console.error('KHÔNG overwrite. Muốn cài guard: gỡ hook cũ hoặc tự chain — dòng sau vào hook hiện có:');
    console.error(`node "${guardPath}" || exit 1`);
    process.exit(1);
  }
  // Hook do chính script cài (managed) → ghi lại idempotent.
}
writeFileSync(hookPath, content, 'utf8');
try { chmodSync(hookPath, 0o755); } catch { /* Windows: không cần exec bit */ }
console.log(`hook đã cài: ${hookPath}`);