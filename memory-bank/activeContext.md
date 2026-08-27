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
Vòng fix GPT-REV-086 (bỏ clamp backoff) đã hoàn tất. PR #17 = `agent:gpt`+`status:review-requested`, HEAD mới đã push; chờ GPT re-review. Không merge/deploy/approve; soak-test thật trên máy Bố trước khi xóa legacy.

## Bằng chứng thực thi
- **GPT-REV-078 (đã ĐÓNG)**: OS-owned TCP lease thay file-lock; probe chỉ confirm owner khi đọc identity handshake; connect socket đang đóng/không data → not-alive; supervisor dùng probeFn + await startGatewayFn; child-process test contention/crash-reacquire/old-owner. GPT xác nhận đóng tại 052f89c.
- **GPT-REV-086 (Important, đã fix)**: trước production `await sleep(Math.min(backoff,2000))` clamp mọi backoff 60–300s xuống 2s → restart churn. Giờ `supervisorLoop({runSupervisorOnceFn, sleepFn})` exportable; `main()` → `supervisorLoop()` ngủ ĐÚNG `backoff`; test inject `sleepFn` (không đụng thời gian production). Test 18b assert sleep=60000>2000.
- pnpm test:gateway **24/24 PASS** (tăng test 18b); pnpm test:gateway:mp **19/19 PASS**; pnpm test:drift 0 FAIL; node scripts/full-verify.mjs **116/116 PASS**.
- Commit + push sang `fix/issue-15-telegram-gateway` (HEAD mới) → đồng bộ PR #17 → chờ GPT re-review (không merge/deploy/approve).
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
- [ ] **DECISION GATE (Mức 3)**: diff PR #17 = 2399 dòng > giới hạn policy `maxLines:1500` (additions+deletions, `blocking-decision-gate`). Orchestrator pre-review luôn `block-decision-gate` nếu PR ở `agent:cline`. GPT review PR này TRỰC TIẾP (`agent:gpt`+`status:review-requested`, orchestrator skip). Bố chọn: (A) giữ review trực tiếp / (B) nâng `maxLines` / (C) chia PR nhỏ. Hiện giữ (A).

## Bước tiếp theo
CHỜ GPT re-review tại HEAD `7ce22d1` (PR #17 = `agent:gpt`+`status:review-requested`, orchestrator skip). KHÔNG chạy orchestrator pre-review (sẽ `block-decision-gate` do diff > 1500). KHÔNG merge/deploy/approve. Soak test máy thật vẫn là bước thủ công trước xóa `notify-telegram.mjs` legacy.
