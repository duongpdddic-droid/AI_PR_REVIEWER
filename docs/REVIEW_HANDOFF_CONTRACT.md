# REVIEW HANDOFF CONTRACT (canonical)

> Canonical duy nhất: `duongpdddic-droid/AI_PR_REVIEWER` — `scripts/review-handoff-contract.mjs`
> (bản máy đọc được, versioned). File này là bản diễn giải cho người; KHÔNG copy contract
> vào từng repo dự án. Repo dự án chỉ tham chiếu pin version (xem `buildTaskPacket`).
>
> Version hiện hành: **1.0.0** — Issue #32.

## Mục đích

Implementation agent phải cung cấp đủ bằng chứng để reviewer độc lập đánh giá một handoff
**mà không cần re-fetch toàn bộ GitHub diff**. Intent-only summary không được tính là bằng chứng.

## Cấu trúc báo cáo bàn giao — 10 section bắt buộc

### 1. Identity
- Repository, issue và pull request.
- Branch.
- Exact HEAD SHA (full 40-hex) và base SHA.
- PR state (Draft/Open).
- Xác nhận KHÔNG amend, force-push, merge hoặc deploy.

### 2. Scope
- Objective và acceptance criteria đã xử lý.
- Changed files.
- Explicit exclusions.
- Deviations / scope expansion.

### 3. Code evidence
Với mỗi thay đổi material:
- File + line range, function hoặc export.
- Behavior trước / sau khi thay đổi.
- Fail-closed gates và mutation ordering.
- Code excerpt chính xác tối thiểu hoặc pseudocode đủ để static tracing.
- Caller-controlled input và mọi mutation khả dĩ.

### 4. Finding resolution
Với mỗi finding:
- Finding ID và severity.
- Root cause.
- Implemented fix.
- Vì sao fix đóng được đường báo cáo.
- Bypasses/races/interleavings còn lại đã cân nhắc.
- Status: `fixed` | `disputed` | `unresolved`.
- Finding disputed bắt buộc kèm code/test evidence cụ thể.

### 5. Tests
Với mỗi test mới/thay đổi:
- Test name và location.
- Setup/input.
- Simulated interleaving cho race/concurrency.
- Primary assertions.
- Negative assertion chứng minh hành vi bị cấm không xảy ra.
- real-FS/integration hay mock-only.
- PASS/FAIL và exit code.
- Số lượng test pass đơn thuần KHÔNG phải bằng chứng đúng đắn.

### 6. Verification
- Exact commands đã chạy.
- PASS/FAIL totals và exit codes.
- CI run tại exact HEAD (khi có).
- `git diff --check`.
- Worktree status.
- Mọi failure còn lại; không báo "all green" nếu có check fail.

### 7. Safety and mutation analysis
- Input có bị mutate không.
- File/state pre-existing có thể bị overwrite/move/delete không.
- Pathname/state dùng chung có bị chạm không.
- TOCTOU/race window.
- Truy cập ngoài worktree.
- Remote/protected-branch/credential/merge/deploy mutation.
- Rollback chỉ gỡ state do chính lần invocation tạo ra không.

### 8. Unverified risks
- Untested behavior.
- Static inference chưa runtime-verified.
- Platform behavior chưa verify.
- Caller/runtime integration chưa verify.
- Assumptions.
- Behavior chưa verify KHÔNG được trình bày như đã chứng minh.

### 9. Delivery
- Commit SHA và push result.
- PR body/comment/labels/handoff actions.
- Đã read-back exact HEAD chưa.
- Agent KHÔNG được tự nhận reviewer approval hoặc merge readiness.

### 10. Terminal status
Report phải kết thúc bằng ĐÚNG 1 trong:
- `READY_FOR_REVIEW` — đủ bằng chứng.
- `BLOCKED` — không hoàn thành được; liệt kê blockers.
- `PARTIAL_EVIDENCE` — có thể có implementation nhưng bằng chứng thiếu; KHÔNG được request approval.

## Gate (fail-closed)

- Thiếu required section bất kỳ → `PARTIAL_EVIDENCE`.
- Thiếu exact HEAD (không phải 40-hex) → `PARTIAL_EVIDENCE`.
- Test totals không kèm commands/exit code → `PARTIAL_EVIDENCE`.
- Báo "all green" nhưng có failure được ghi nhận → `PARTIAL_EVIDENCE`.
- Thiếu safety/mutation analysis → `PARTIAL_EVIDENCE`.
- Thiếu unverified-risks → `PARTIAL_EVIDENCE`.
- Thiếu/invalid terminal status → `PARTIAL_EVIDENCE`.
- `PARTIAL_EVIDENCE` KHÔNG được chuyển sang `status:review-requested`.
- Chỉ `validateHandoff()` trả `READY_FOR_REVIEW` mới qua được gate (`canRequestReview`).

## Tích hợp

- **Validator**: `validateHandoff(report)` → `{ ok, status, errors: [{ code, section, field, message }] }`.
- **Gate handoff**: `mcp-task-server` `task_handoff` BẮT BUỘC kèm `handoffReport`; thiếu report
  → `HANDOFF_REPORT_REQUIRED`, report không phải `READY_FOR_REVIEW` (kể cả `BLOCKED` /
  `PARTIAL_EVIDENCE` / invalid / exception) → `HANDOFF_PARTIAL_EVIDENCE`. Chặn fail-closed
  trước mọi mutation. Registered repositories lấy từ nguồn canonical (`.agent/config.json`
  `repo` + `targetRepos`), KHÔNG dùng repo caller tự khai báo trong request — report khai báo
  repository chưa đăng ký → `UNKNOWN_REPOSITORY` fail-closed.
- **Task packet**: `buildTaskPacket({ resolveRef, maxBytes })` — reference pin version khi resolve
  được; ngược lại inline toàn bộ content; vượt `maxBytes` → `PACKET_TRUNCATED` fail-closed.
  Payload bounded: static contract không nhân bản vào từng packet nếu runtime resolve được reference.

## Lệnh vận hành ngắn

Người vận hành có thể ra lệnh:

> **"Thực hiện tiếp và bàn giao theo canonical REVIEW HANDOFF CONTRACT."**

nghĩa là: agent tự khám phá trạng thái (Issue/PR/branch/HEAD), thực hiện phần còn lại, lập báo cáo
bàn giao đủ 10 section theo contract canonical (version hiện hành), chạy validation
(`validateHandoff` → `READY_FOR_REVIEW`), rồi mới bàn giao qua `task_handoff` với `handoffReport`
hợp lệ — KHÔNG tự merge/deploy/approve.

## Kiểm tra

`pnpm test:handoff-contract` — 29 case: happy path `READY_FOR_REVIEW`, mỗi section thiếu độc lập,
thiếu HEAD, thiếu commands/exit code, "all green" mâu thuẫn, thiếu safety, thiếu unverified-risks,
thiếu/invalid terminal status, gate chặn `PARTIAL_EVIDENCE`, reference/inline/truncation packet.
