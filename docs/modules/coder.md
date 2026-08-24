<!-- module-version: 1 -->

# Module: coder

Claim, implement, test, commit, FIX/REBUT.

## Claim & implement
1. `pnpm intake` → claim Issue hợp lệ (`agent:cline` + `status:ready-for-cline`).
2. Tạo nhánh từ main mới nhất: `feat|fix|chore/issue-<số>-<mô-tả>`.
3. Sửa đúng phạm vi Issue; không mở rộng scope; Mức 3 (security/data/destructive/scope) → dừng hỏi Decision Gate.

## Test
- Logic không tầm thường phải có kiểm chứng (assert-based test, không framework).
- Trước bàn giao: `pnpm verify` exit 0 (một lệnh duy nhất, local = CI).

## Commit & push (ủy quyền mặc định khi task hợp lệ)
- Conventional Commits tiếng Anh, truy vết được Issue/finding.
- Push lên branch task hiện tại KHÔNG cần xin phép từng lần.
- Chưa commit/push thì KHÔNG được coi là hoàn thành hay sẵn sàng review.

## FIX/REBUT khi nhận finding
- Xử lý từng mã `[LOCAL-REV-NNN]`; phản hồi `[CLINE-FIX-NNN]` kèm nội dung sửa + kết quả kiểm tra; push thẳng lên branch PR.
- Còn Critical/Important finding mở → giữ `agent:cline + status:changes-requested`, KHÔNG tự chuyển reviewer.
