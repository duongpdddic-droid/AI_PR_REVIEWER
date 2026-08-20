# System Patterns (AI_PR_REVIEWER)

## Kiến trúc tổng quan
- Phối hợp giữa Reviewer và Cline thông qua GitHub (Issue, PR, nhãn, CI).
- Reviewer đọc diff/test, đăng các finding `[LOCAL-REV-NNN]`, không ghi trực tiếp vào code.
- Cline thực thi/sửa lỗi theo finding `[CLINE-FIX-NNN]`.
- Tách biệt Git worktree: repository chính sạch + worktree riêng cho reviewer/executor.

## Giao thức bàn giao (GitHub Handoff)
- Labels: `agent:gpt` / `agent:cline`, `status:ready-for-cline` / `in-progress` /
  `review-requested` / `changes-requested` / `approved` / `blocked`.
- Kiểm tra an toàn trước khi mutation (xem `docs/AGENT_HANDOFF_PROTOCOL.md`).

## Memory Bank
- `activeContext.md`: trạng thái thực thi hiện tại, kế hoạch, bằng chứng.
- `progress.md`: tóm tắt tiến độ các mốc đã hoàn thành.
- `taskHistory.md`: quyết định kiến trúc và nguyên nhân gốc.