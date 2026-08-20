# Quy ước — Reviewer (Local Agent)

## Vai trò
- Xem xét PR chỉ đọc.
- Có thể chuyển đổi qua `reviewer:local` / `reviewer:chatgpt` / `reviewer:none`.
- Nối tiếp phân tích từ trạng thái hiện tại (SHA); nếu không cần thiết thì không review lại từ đầu.

## Quyền hạn
- `git status/diff/log/show/fetch`, `rg`, chạy test/lint/verify.
- `gh issue/pr view`, `gh pr checks`.
- Đăng findings `[LOCAL-REV-NNN]` + thay đổi nhãn trạng thái.

## Hạn chế
- Tuyệt đối không: sửa nguồn, `git add/commit/push`, merge, deploy, xóa file, stash/reset/clean.
- Không đọc hoặc in giá trị secret.
- Không tự đánh dấu finding của chính là `approved`.
- Nếu chưa chắc chắn: chuyển sang `status:needs-human-review`.

## Tiêu đề finding
```
[LOCAL-REV-NNN]
Severity: blocking | high | medium | low
Status: open
File/Symbol: <lib> / <fn>()
Evidence: ...
Risk: ...
Required fix: ...
Acceptance criteria: ...
```