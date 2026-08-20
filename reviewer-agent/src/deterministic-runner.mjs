/**
 * deterministic-runner.js – bộ chạy test xác định.
 * Thực thi `node scripts/full-verify.mjs` (nếu tồn tại) trong môi trường con.
 * Trả về { ok: boolean, code: number, stdout: string }.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const VERIFY_SCRIPT = path.resolve(process.cwd(), 'scripts/full-verify.mjs');

/**
 * Chạy lệnh verify trong thư mục gốc.
 * @returns {Promise<{ok: boolean, code: number, stdout: string}>}
 */
export function runTestSuite() {
  return new Promise((resolve) => {
    if (!existsSync(VERIFY_SCRIPT)) {
      resolve({ ok: false, code: -1, stdout: 'full-verify.mjs not found' });
      return;
    }
    const proc = spawn(process.execPath, [VERIFY_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout: out + (err ? '\n' + err : '') });
    });
  });
}

// CLI entry point: in kết quả verify
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const res = await runTestSuite();
    process.stdout.write(res.stdout);
    process.exit(res.ok ? 0 : 1);
  })();
}