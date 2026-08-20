/**
 * github-adapter.js – bộ điều phối giao tiếp GitHub (qua gh CLI).
 * Cung cấp các hàm tiện ích để đăng findings, thêm/xoá label và chú thích.
 * Không thực hiện mutation ngoài phạm vi read-only theo reviewer config.
 */
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(_execFile);

/**
 * Chạy gh CLI an toàn (execFile, không qua shell).
 * @param {string[]} args - Tham số dòng lệnh cho gh.
 * @param {string} repo - Repo đích dạng owner/name.
 * @returns {Promise<string>} - stdout trả về (trim).
 */
export async function gh(args, repo = process.env.GITHUB_REPOSITORY || '') {
  if (repo && !args.includes('-R')) args = ['-R', repo, ...args];
  const { stdout } = await execFile('gh', args, { encoding: 'utf8' });
  return stdout.trim();
}

/**
 * Tìm PR đang chờ review theo nhãn cấu hình.
 * Trả về mảng các PR (object rỗng nếu lỗi).
 */
export async function listReviewablePRs(repo) {
  try {
    const out = await gh(['pr', 'list', '--label', 'reviewer:local', '--json', 'number,title,labels'], repo);
    return JSON.parse(out || '[]');
  } catch {
    return [];
  }
}

/**
 * Đăng một bình luận đánh dấu reviewer đã xem xét.
 * @param {number} prNumber
 * @param {string} body - Markdown body của comment.
 * @returns {Promise<boolean>} - true nếu gửi thành công.
 */
export async function postReviewComment(prNumber, body, repo) {
  try {
    await gh(['pr', 'comment', String(prNumber), '--body', body], repo);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gắn nhãn `reviewer:local` vào PR.
 */
export async function labelPR(prNumber, label, repo) {
  try {
    await gh(['pr', 'edit', String(prNumber), '--add-label', label], repo);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tạo một finding mới với định danh [LOCAL-REV-NNN].
 * @param {number} index - chỉ số của finding.
 * @param {object} opts - { severity, file, message, suggestion }
 * @returns {string} - chuỗi markdown finding.
 */
export function formatFinding(index, opts = {}) {
  const { severity = 'low', file = '', message = '', suggestion = '' } = opts;
  const id = String(index).padStart(3, '0');
  return [
    `[LOCAL-REV-${id}]`,
    `Severity: ${severity}`,
    `File: ${file}`,
    `Message: ${message}`,
    `Suggested fix: ${suggestion}`,
  ].join('\n');
}