# Active Context
## Mục tiêu
Issue #15 — Shared Telegram Gateway (Telegram control mode): single source of truth, queue name spacing,
reliable notify, self-heal; xóa idle/sleep/hibernate + shutdown /h.

## Chế độ
Tự hành (kênh Cline, lệnh Bố trực tiếp). Bố chọn A (Full theo Acceptance Criteria) tại Issue #15.

## Ranh giới kiến trúc (quyết định Bố)
- Source gateway: scripts/telegram-gateway/ (Git-managed, review, test, rollback).
- Runtime thực tế: ~/.ai-pr-reviewer/gateway/ (queue/lock/heartbeat/config — KHÔNG commit).
- Xóa watchdog ngủ đông + mọi đường shutdown /h.
- Giữ legacy adapter đến khi migration + soak test hoàn tất.

## Kế hoạch thực thi
1. [x] Claim #15, branch fix/issue-15-telegram-gateway từ origin/main (baseSha 0bedf104).
2. [x] Xóa watchdog-hibernate.mjs (idle reminder + shutdown /h).
3. [x] tg-notify-core.mjs: +events approved/merged; xóa hàm watchdog (silenceTimeoutLevels, nextSilenceState, resetOnActivity, SILENCE_DEFAULTS, watchdogSilenceTick, commitSilenceLevel, isPidAlive, isGuardAlive, shouldArm).
4. [x] notify-telegram.mjs: xóa arm block + imports thừa.
5. [x] Tạo scripts/telegram-gateway/: contract, transport, bridge (single getUpdates poller + lock chống 429), notifier (single outbound sender + idempotency), supervisor (self-heal), gateway (single instance), adapter-ai-pr-reviewer (legacy redirect), install, README.
6. [x] Wire unified-orchestrator.io.notify + autonomous-run.notifyTelegram -> adapter (single source of truth).
7. [x] Tests: test-telegram-gateway.mjs 9 PASS; test-tg-notify.mjs PASS; full-verify 110/110 PASS.
8. [x] Smoke gateway: lock + heartbeat + ready tạo đúng (dummy token, 2s).
 9. [x] GPT-REV-077..082 (PR #17): sửa allowlist+path-traversal (077), atomic lock+owner-only (078), verified-startup health gate (079), gatewayEventKey+head SHA+validateEnvelope fail-closed (080), sync test harness 12 case (081). Commit 3b1cea9, push; comment re-review PR #17; notify Telegram legacy (không arm watchdog/merge/deploy).

## Bước hiện tại
Hoàn tất sửa toàn bộ GPT-REV-077..082 + docs + tests (unit 16/16, integration 8/8, verify 116/116). Đang commit/push, comment CLINE-FIX PR #17, handoff GPT, notify Telegram.

## Bằng chứng thực thi
- node --check toàn bộ scripts gateway + core/notify/orchestrator/autonomous: PASS.
- pnpm test:gateway **16/16 PASS** (routeUpdate allowlist, HEAD_RE 40-hex, enqueue validate fail-closed, processOutbound multi-appNs, supervisor decision...).
- pnpm test:gateway:mp **8/8 PASS** (multi-process single-instance lock, gateway ready sau startup, inbound ack, outbound send qua mock, release khi thoát).
- pnpm verify **116/116 PASS** (node --check + BOM + dup fn + git diff --check + behavior-map).
- Sửa 3 bug thực tế bằng test: takeoverLock stale (L-036), HEARTBEAT_MS env-config (L-037), test idempotency key (L-038).
- Docs: scripts/telegram-gateway/README.md phần Bảo mật & Robustness (077..082).

## Quyết định
- Chỉ 1 getUpdates poller (lock + heartbeat) -> tránh 409 conflict.
- 1 notifier duy nhất đọc shared OUTBOUND_DIR (readOutboundAll) xử lý TẤT CẢ registered appNs.
- Outbound envelope validate TRƯỚC enqueue (fail-closed: sai -> ném, không ghi, không phát đi).
- READY_FILE là JSON {instanceId}; isReady yêu cầu lock alive + instanceId khớp + lastSuccessfulPoll gần đây.
- dispatcher.mjs CHỈ dispatch command (ping/status/help), KHÔNG verdict self-review (Issue #15).
- Token/config runtime ~/.ai-pr-reviewer/gateway/config.json (copy từ legacy tg.json qua install.mjs), KHÔNG commit.

## Vấn đề trì hoãn
- [ ] Soak test thực tế (chạy gateway trên máy Bố) trước khi xóa hẳn notify-telegram.mjs legacy.
- [ ] Có thể mở rộng adapter QLDA_DTXD nếu Bố cần.

## Bước tiếp theo
Commit + push fix/issue-15-telegram-gateway; gh pr comment 17 CLINE-FIX; handoff GPT (status:review-requested, agent:gpt) tại HEAD mới; notify Telegram báo hoàn thành. KHÔNG merge/deploy/approve.
