#!/usr/bin/env node
// agent-runner.mjs — DEPRECATED.
// Đã tách thành 2 orchestrator chuyên biệt:
//   - unified-orchestrator.mjs : quét PR review đa repo, route CI → GPT/Cline (reviewer side).
//   - autonomous-run.mjs       : pipeline đóng vòng claim → coder → verify → PR (coder side).
// File này chỉ còn là wrapper chuyển tiếp argument để không vỡ lệnh cũ.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'unified-orchestrator.mjs');

console.error('[deprecated] agent-runner.mjs đã được thay bằng unified-orchestrator.mjs (reviewer) + autonomous-run.mjs (coder) — đang chuyển tiếp.');
const res = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = res.status ?? 1;