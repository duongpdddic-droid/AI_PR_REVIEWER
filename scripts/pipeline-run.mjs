#!/usr/bin/env node
// pipeline-run.mjs — DEPRECATED.
// Đã hợp nhất vào autonomous-run.mjs (pipeline đóng vòng claim → coder → verify → PR).
// File này chỉ còn là wrapper chuyển tiếp argument để không vỡ lệnh cũ.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'autonomous-run.mjs');

console.error('[deprecated] pipeline-run.mjs đã được thay bằng autonomous-run.mjs — đang chuyển tiếp.');
const res = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = res.status ?? 1;
