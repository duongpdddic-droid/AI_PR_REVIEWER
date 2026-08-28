# 08-TEMP-HYGIENE - QUẢN LÝ TÀI NGUYÊN TẠM (PoC / Runtime) BẮT BUỘC

Áp dụng cho MỌI phiên chạy tạo tài nguyên tạm ngoài repo: file/dir PoC, script runtime, process con.
Mục đích: không để sót file/marker/process sau khi phiên kết thúc (PASS/FAIL/timeout/Ctrl+C).

## 1. Nguyên tắc chung
- Mọi file PoC/runtime tạm phải nằm trong **một thư mục temp root riêng** tạo bằng cơ chế temp an toàn (`scripts/temp-hygiene.mjs`), **không ghi rải rác** vào repo/workspace thật.
- Temp root KHÔNG được nằm trong repo (`createSessionManager({ projectRoot })` chặn).
- Mỗi phiên = 1 dir con theo `sessionId` (hex an toàn) và 1 **session manifest** liệt kê chính xác file/dir/process phiên tạo.

## 2. Ownership marker
- Mỗi dir do phiên tạo gắn **ownership marker** `.session-owner-<sessionId>` ghi `{sessionId}`.
- Chỉ xóa target khi thỏa ĐỦ:
  1. nằm trong temp root cho phép (`isInside`);
  2. có `sessionId` đúng;
  3. có ownership marker do chính phiên tạo.
- **CẤM** recursive-delete dựa trên: path rỗng, biến môi trường chưa resolve, workspace root, repo root, HOME, hoặc wildcard.

## 3. Cleanup (chạy trong `finally`)
- Cleanup chạy trong `finally`, kể cả PASS, FAIL, timeout hoặc Ctrl+C.
- **Idempotent** — gọi lại không lỗi, không xóa nhầm.
- Trước cleanup phải **dừng đúng child process do phiên tạo theo PID** (SIGTERM → chờ → SIGKILL); **không kill theo tên process chung**.
- Không xóa log/evidence trước khi đã tạo báo cáo redacted tối thiểu; sau báo cáo chỉ giữ compact summary, không giữ raw prompt/stdin nếu không cần.

## 4. Read-back bắt buộc sau cleanup
Xác nhận:
- workspace/PoC không còn;
- hook PoC (marker/session manifest) không còn;
- process con không còn;
- không còn file marker/session manifest;
- repo/workspace thật không thay đổi (`snapshotWorkspace`/`workspaceChange`).
Nếu không hoàn tất → verdict `POC_CLEANUP_FAILED`, liệt kê absolute target còn sót (đã redact user path); **KHÔNG báo PASS**.

## 5. Recovery
- Có lệnh recovery riêng theo `sessionId` (`recoverSession`) — **idempotent**, chỉ xử lý resource có ownership marker; dir không có marker → `POC_CLEANUP_FAILED`, không tự xóa.

## 6. Module dùng lại
- `scripts/temp-hygiene.mjs`: `createSessionManager`, `cleanupSession`, `recoverSession`,
  `isInside`, `isSafeSessionId`, `ensureOwnershipMarker`, `hasOwnershipMarker`, `redactHome`,
  `stopTrackedProcesses`, `snapshotWorkspace`, `workspaceChange`, `DEFAULT_TEMP_ROOT`.
- Test: `pnpm test:temp-hygiene` (đã đăng ký trong `full-verify.mjs`). Cover PASS / FAILURE / TIMEOUT / RECOVERY / pid-scoped kill.
- Mọi PoC sắp chạy PHẢI dùng module này; chưa dùng cho module khác trong phase hiện tại.
