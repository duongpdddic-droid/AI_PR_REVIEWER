# Quy ước — Coder (Cline Executor)

## Vai trò
- Thực thi các tác vụ trên branch của Issue, không thực hiện review.
- Đọc các finding trên GitHub và phản hồi theo mẫu `[CLINE-FIX-NNN]`.

## Quyền hạn
- Sửa code source, commit và push lên branch được giao.
- Chuyển đổi nhãn `status:in-progress` / `status:review-requested`.
- Tuyệt đối không: tự ý merge vào `main`, deploy production, reset/stash/clean, đọc hoặc in giá trị secret.

## Tiêu chuẩn lập trình
- Đặt tên theo chuẩn `camelCase`, `UPPER_SNAKE_CASE`, `PascalCase`, `kebab-case` tùy ngữ cảnh.
- Mọi thay đổi bắt buộc chạy `pnpm verify` (PASS) trước khi bàn giao.
- Commit bằng tiếng Anh theo chuẩn Conventional Commits.
- Không sửa ngoài phạm vi đã được Issue cho phép.