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

## Bước hiện tại
Commit + push branch; tạo Draft PR Ref #15; handoff GPT (status:review-requested + agent:gpt).

## Bằng chứng thực thi
- node --check toàn bộ scripts gateway + core/notify/orchestrator/autonomous: PASS.
- pnpm test:gateway 9/9; pnpm test:tg PASS; pnpm verify 110/110.
- gateway smoke: gateway.lock (pid+heartbeat) + ready; --status đọc được.

## Quyết định
- Chỉ 1 getUpdates poller (lock + heartbeat) -> tránh 409 conflict.
- Outbound queue dir chung (không namespaced appNs); inbound namespaced theo appNs.
- Token/config runtime ~/.ai-pr-reviewer/gateway/config.json (copy từ legacy tg.json qua install.mjs), KHÔNG commit.

## Vấn đề trì hoãn
- [ ] Soak test thực tế (chạy gateway trên máy Bố) trước khi xóa hẳn notify-telegram.mjs legacy.
- [ ] Có thể mở rộng adapter QLDA_DTXD nếu Bố cần.

## Bước tiếp theo
Push -> Draft PR Ref #15 -> handoff GPT. Sau GPT duyệt: merge (quyền Bố).
