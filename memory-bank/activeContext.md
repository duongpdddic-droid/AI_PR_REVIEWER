# Active Context (AI_PR_REVIEWER)

## Mục tiêu
Hub review đa repo (target đầu tiên `duongpdddic-droid/QLDA_DTXD`): worktree sạch,
orchestrator không destructive, vòng lặp coder khép kín theo nhãn PR
(`status:review-requested` → review → `status:changes-requested` | `status:approved`).

## Chế độ
Tự hành (act).

## Kế hoạch thực thi
1. [x] Dọn worktree: gỡ gitlink mồ côi `QLDA_DTXD` khỏi git index — commit `efb20ec`.
2. [x] Đồng bộ config: `reviewer-agent/reviewer.config.json` thêm `labels` + `notifyTelegram` (khớp `.agent/config.json`).
3. [x] Routing orchestrator: pass → `status:approved`; fail → comment finding `[LOCAL-REV-NNN]`; sửa loop-breaker `agent:gpt` trong issue `[review-fix]`.
4. [x] Coder loop: `.agent/conventions-coder.md` thêm mục "Vòng review PR (label loop)".
5. [x] Kiểm thử & bàn giao: test/verify/smoke PASS; commit `ed6eb79` (local).
6. [x] E2E smoke test trên GitHub thật (`QLDA_DTXD#33`, cả nhánh PASS lẫn FAIL) + cleanup trọn vẹn.

## Bước hiện tại
Hoàn tất E2E — chờ người dùng push 3 commit local (`efb20ec`, `ed6eb79`, `8e0f954`).

## 22/08/2026 12:20 (ACT) — Tiếp nhận `mcp-task-server` vào AI_PR_REVIEWER (chuyển từ QLDA_DTXD)
- **Lý do**: `mcp-task-server` là công cụ điều phối Coder ↔ Reviewer đa repo (không phụ thuộc repo nào — repo truyền qua tham số `repo` / env `MCP_TASK_REPOS`), nên thuộc nhóm hạ tầng orchestration của AI_PR_REVIEWER chứ không neo vào repo nghiệp vụ QLDA_DTXD.
- **Thay đổi**: copy `mcp-task-server/` + `.mcp.json` từ `C:\Users\Admin\.cline\QLDA_DTXD` → AI_PR_REVIEWER; thêm script `test:mcp` vào `package.json`.
- **Settings toàn cục**: `cline_mcp_settings.json` `args[0]` trỏ `C:\Users\Admin\.cline\AI_PR_REVIEWER\mcp-task-server\server.mjs` (đã sửa, trước là `QLDA_DTXD\mcp-task-server\server.mjs`).
- **Verify**: `node mcp-task-server/test-server.mjs` 34/34 PASS tại vị trí mới.

## Bằng chứng thực thi (22/08/2026 09:50)
- E2E PASS path: PR draft #33 (nhãn `status:review-requested`) → CI pass 24s → `--execute` log `✅ approve` → nhãn PR còn đúng 1 `status:approved`; comment "✅ Verification PASS 100% — đạt yêu cầu kỹ thuật… Quyền merge thuộc người dùng."; rerun idempotent ("không có PR chờ review").
- E2E FAIL path: push commit phá cú pháp `Backend/Code.js` → CI fail → gắn lại `status:review-requested` (giả lập coder bàn giao) → `--execute` log `request-fix` + issue `[review-fix] PR #33 — vòng r1` (#34); nhãn PR thành `agent:cline` + `status:changes-requested`; comment chứa finding `[LOCAL-REV-001]` đủ schema (Severity/Evidence/Risk/Required fix/Acceptance criteria); body issue hướng dẫn loop-breaker mới (gỡ changes-requested+agent:cline, gắn lại review-requested).
- Cleanup: issue #34 đóng kèm comment; PR #33 đóng + branch `test/smoke-e2e-orchestrator` xóa khỏi remote; temp clone `%TEMP%\qlda-dtxd-smoke` xóa (Test-Path=False); worktree local AI_PR_REVIEWER không đổi.
- Commit Memory Bank trước đó: `8e0f954`.

## Quyết định
- **Bãi bỏ quyết định 21/08 20:42** ("KHÔNG bao giờ tự approve") theo chỉ thị mới của người dùng: CI PASS 100% → reviewer gắn `status:approved` (duyệt kỹ thuật); quyền MERGE vẫn thuộc người dùng.
- Sửa loop-breaker: issue `[review-fix]` cũ bảo coder gắn lại `agent:gpt` lên PR → orchestrator skip PR vĩnh viễn. Giờ: gỡ `status:changes-requested` + `agent:cline`, gắn lại `status:review-requested`.
- `checksDetail`: ưu tiên `gh pr checks --json name,state` (gh ≥ v2.31), fallback parser text emoji; output rỗng → phân loại theo exit code (0=pass, 8=pending, còn lại=fail).

## Vấn đề trì hoãn
- [ ] Push 3 commit local lên `origin/main` — chờ chỉ thị (cron orchestrator trên remote đang chạy bản cũ).
- [ ] PR approved rồi CI fail sau đó (push mới) không được quét lại — hành vi thiết kế, xem L-008; cân nhắc hạ cấp `status:approved` → `changes-requested` khi check fail mới xuất hiện.
- [ ] `reviewer-agent/` giữ inert theo Decision Gate 21/08 23:05 — không dọn.
- [ ] Static gates nâng cao (secret scan / out-of-scope) + `review-state.json` lease lock — xem taskHistory mục Giai đoạn 2.

## Bước tiếp theo
- Người dùng: `git push origin main` để cron 15 phút dùng routing mới (đã kiểm chứng E2E cả hai nhánh).
- Theo dõi chu kỳ cron đầu tiên sau push trên GitHub Actions.
- Issue test handoff **QLDA_DTXD#35** đang OPEN (`agent:cline` + `status:ready-for-cline`) — chờ Cline workspace QLDA_DTXD claim; KHÔNG đóng từ phía này.

## Lịch sử
Xem `taskHistory.md` (archive 22/08/2026 09:31).