#!/usr/bin/env node
// reviewer-orchestrator.mjs — DEPRECATED.
// Đã hợp nhất vào unified-orchestrator.mjs (đa repo, không tự approve, không đụng worktree).
// File này chỉ còn là wrapper chuyển tiếp argument để không vỡ lệnh cũ.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'unified-orchestrator.mjs');

console.error('[deprecated] reviewer-orchestrator.mjs đã được thay bằng unified-orchestrator.mjs — đang chuyển tiếp.');
const res = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = res.status ?? 1;
