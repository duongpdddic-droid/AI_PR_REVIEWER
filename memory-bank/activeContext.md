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
Hoàn tất vòng fix GPT-REV-078/079/083/084/085 (commit `7ce22d1`). PR #17 = `agent:gpt`+`status:review-requested`, HEAD `7ce22d1` đã push; comment Issue #15 xác nhận re-review 078/079/085. Orchestrator skip (có `agent:gpt`). Issue #15 đồng bộ nhãn.

## Bằng chứng thực thi
- **GPT-REV-079 (gốc)**: `supervisor.runSupervisorOnce` thêm nhánh live-degraded — lock sống (pid+heartbeat) nhưng chưa ready → `monitor-degraded`, KHÔNG spawn; `main()` loop coi là không-fail. Test mới dòng 354: `startGatewayFn` không gọi.
- **GPT-REV-078**: giữ `takeoverLock` không clobber lock tươi (test `takeover never clobbers a live lock`) + owner-only `touchHeartbeat`/`releaseLock`.
- **GPT-REV-085**: `.clinerules/01`+`05` bỏ các ref `telegram-bridge.mjs`/`watchdog-hibernate.mjs`/`shutdown /h`; drift test #3/#4 exit 0.
- pnpm test:gateway **23/23 PASS** (incl. monitor-degraded mới).
- pnpm test:gateway:mp **9/9 PASS** (single-instance lock, ready sau startup, inbound/outbound, SIGTERM release).
- pnpm test:drift exit 0 (0 FAIL; counter "0 PASS" cố định vì assert #1–4 là block ngoài test(), exit 0 = PASS).
- node --check supervisor.mjs + test-telegram-gateway.mjs: OK.
- Commit `7ce22d1` push; HEAD = origin/fix/issue-15-telegram-gateway = 7ce22d1.

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
