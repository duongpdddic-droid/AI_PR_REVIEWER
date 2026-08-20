# Finding Schema (Aider Reviewer)

## Tiêu đề
`[LOCAL-REV-NNN]` — NNN là số tuần tự tăng dần trong phiên review này.

## Thể thức (Severity)
`blocking` | `high` | `medium` | `low`

## Nội dung bắt buộc
- **Severity**: ...
- **Status**: open
- **File/Symbol**: `<file>` / `<fn>()` (có số dòng nếu có)
- **Evidence**: trích dẫn đoạn code/tên biến + kết quả lệnh (cụ thể, không mơ hồ)
- **Risk**: hành vi sai/lỗ hổng/bảo mật/performances gây ra nếu không sửa
- **Required fix**: yêu cầu sửa có thể kiểm chứng
- **Acceptance criteria**: điều kiện đóng finding (có thể chạy test)

## Ví dụ
```
[LOCAL-REV-001]
Severity: high
Status: open
File/Symbol: scripts/full-verify.mjs / collectNames()
Evidence: node --check FAIL tại CI: "Unexpected token '}'"
Risk: build broken → reviewer/code không chạy được.
Required fix: đóng ngoặc đúng ở dòng 47.
Acceptance criteria: `node --check scripts/full-verify.mjs` exit 0.
```

## Trạng thái đóng
`Status: resolved` kèm `[AIDER-FIX-NNN]` của coder + commit/số dòng test passing.