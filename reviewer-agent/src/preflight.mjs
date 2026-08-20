import { runPreflight } from '../../scripts/github-task-intake.mjs';

/**
 * preflight.js – kiểm tra môi trường trước khi thực thi các tác vụ reviewer.
 * Sử dụng runPreflight() đã được chuẩn hoá trong dự án.
 * Trả về đối tượng kết quả giống runPreflight (status, root, remote, baseSha, ...).
 */
export async function checkEnvironment() {
  // Không có override; luôn dùng canonical repo.
  const result = runPreflight();
  if (result.status !== 'PREFLIGHT_OK') {
    throw new Error(`Preflight failed: ${result.status} – ${result.detail || ''}`);
  }
  return result;
}

// Khi chạy trực tiếp để debug
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const out = await checkEnvironment();
      console.log('✅ Preflight OK', out);
    } catch (e) {
      console.error('❌ Preflight error', e.message);
      process.exit(1);
    }
  })();
}
