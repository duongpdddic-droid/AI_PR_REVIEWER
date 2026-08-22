# Quy ước — Coder (Cline Executor)

## Vai trò
- Thực thi các tác vụ trên branch của Issue, không thực hiện review.
- Đọc các finding trên GitHub và phản hồi theo mẫu `[CLINE-FIX-NNN]`.

## Quyền hạn
- Sửa code source, commit và push lên branch được giao.
- Chuyển đổi nhãn `status:in-progress` / `status:review-requested` / `status:changes-requested`.
- Tuyệt đối không: tự ý merge vào `main`, deploy production, reset/stash/clean, đọc hoặc in giá trị secret.

## Vòng review PR (label loop)
Khi PR ở target repo bị gắn `status:changes-requested` + `agent:cline` kèm Issue `[review-fix]`:
1. Checkout đúng branch của PR (worktree riêng, ví dụ `gh pr checkout <số>`).
2. Đọc từng finding `[LOCAL-REV-NNN]` trong review comments của PR.
3. Sửa đúng finding; phản hồi bằng `[CLINE-FIX-NNN]` kèm commit + lệnh kiểm tra.
4. Chạy quality gate (`pnpm verify`) PASS trước khi push.
5. Push lên **branch của PR** — không tạo PR mới.
6. Đổi nhãn PR: bỏ `status:changes-requested` + `agent:cline`, gắn lại `status:review-requested`.
7. Không tự gắn `status:approved`, không tự merge — orchestrator sẽ review lại vòng sau.

## Tiêu chuẩn lập trình
- Đặt tên theo chuẩn `camelCase`, `UPPER_SNAKE_CASE`, `PascalCase`, `kebab-case` tùy ngữ cảnh.
- Mọi thay đổi bắt buộc chạy `pnpm verify` (PASS) trước khi bàn giao.
- Commit bằng tiếng Anh theo chuẩn Conventional Commits.
- Không sửa ngoài phạm vi đã được Issue cho phép.