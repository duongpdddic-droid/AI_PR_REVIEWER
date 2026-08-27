# Telegram Gateway (Issue #15)

Single source of truth cho mọi notify (outbound) và command (inbound) Telegram của
`AI_PR_REVIEWER` (và multi-repo qua namespace). Thay thế `notify-telegram.mjs` + `watchdog-hibernate.mjs`
(idle-reminder / `shutdown /h` đã xóa).

## Ranh giới kiến trúc (quyết định Bố)
- **Source** gateway nằm trong `scripts/telegram-gateway/` (Git-managed, review, test, rollback).
- **Runtime** thực tế chạy ngoài worktree tại `~/.ai-pr-reviewer/gateway/`
  (queue/lock/heartbeat/config — KHÔNG commit).
- Đã xóa watchdog ngủ đông và mọi đường `shutdown /h`.
- Giữ legacy adapter (`adapter-ai-pr-reviewer.mjs`) đến khi migration + soak test hoàn tất.

## Thành phần
- `contract.mjs` — paths, events, queue enqueue/read/dequeue (namespacing), lock/heartbeat.
- `transport.mjs` — `sendTelegram` (retry + 429 Retry-After, KHÔNG shell) và `getUpdates`.
- `bridge.mjs` — single getUpdates poller (inbound) + routeUpdate + lock chống 409.
- `notifier.mjs` — single outbound sender (queue consumer, idempotency, retry) — xử lý TẤT CẢ appNs.
- `dispatcher.mjs` — inbound command dispatch (chỉ dispatch command, KHÔNG verdict self-review — Issue #15).
- `supervisor.mjs` — đảm bảo 1 instance, tự heal khi chết/stale.
- `gateway.mjs` — entry single instance (bridge + notifier + inbound dispatch trong 1 process).
- `adapter-ai-pr-reviewer.mjs` — legacy API (`notifyTelegram`/`notifyRaw`) → enqueue outbound.
- `install.mjs` — setup runtime dir + copy token.

## Bảo mật & Robustness (GPT-REV-077..082)
- **077 — Giới hạn user/chat (fail-closed)**: `routeUpdate` chỉ nhận chat được phép (`chatId`) và
  user thuộc allowlist (`GATEWAY_ALLOWED_USERS` / `allowedUserIds`). Reject fail-closed khi thiếu
  identity (channel_post / forwarded không có `from`). appNs sai định dạng/traversal/unknown → reject.
- **078 — Single-instance bằng OS-owned TCP lease**: `tryAcquireLock` bind 1 TCP port localhost
  (`LEASE_HOST:LEASE_PORT`, mặc định `127.0.0.1:47321`) — OS đảm bảo CHỈ 1 process giữ được; process
  khác nhận `EADDRINUSE` → đứng xuống (exit 3, chống 409). KHÔNG còn file-lock / heartbeat-overwrite /
  stale-takeover race: owner do kernel quản lý, tự thả port khi owner chết/crash. `probeLease()` chỉ
  xác nhận owner khi ĐỌC được identity handshake (owner gửi `{instanceId,pid}`); connect tới socket
  đang đóng/không data → not-alive. `releaseLock` chỉ đóng server (owner-only), không unlink file.
  Heartbeat không còn cần thiết để chứng minh sự sống.
- **079 — Verified startup + readiness**: gateway publish `READY_FILE` (JSON `{instanceId}`) CHỈ SAU
  khi đã acquire lease + poll thành công đầu tiên. `isReady()` (async) yêu cầu lease đang được MỘT
  instance giữ (probe) có `instanceId` khớp health + `READY_FILE` instanceId khớp + health có
  `lastSuccessfulPoll` gần đây. Owner release lease + gỡ `READY_FILE` khi thoát (SIGTERM/SIGINT) để
  supervisor healing đúng.
- **080 — Envelope validation fail-closed**: outbound envelope phải có `appNs, repo, eventType,
  state, head` (HEAD_SHA 40-hex, `HEAD_RE = /^[0-9a-f]{40}$/i`). `enqueue` validate TRƯỚC khi ghi
  file → sai → ném, KHÔNG ghi, KHÔNG phát đi. `gatewayEventKey` = `appNs::repo::ref::eventType::state::head`
  → HEAD thay đổi hoặc app/project khác → khóa khác (không suppress nhầm).
- **082 — 1 notifier cho mọi appNs**: `processOutbound` đọc `readOutboundAll()` (shared OUTBOUND_DIR)
  xử lý TẤT CẢ registered appNs trong 1 pass; item appNs unknown → `validateEnvelope` fail → deadletter.
- **083 — Outbound duplicate không làm queue tăng mãi**: `sendItem` skip (SENT store đã có key) thì
  vẫn `dequeue` item pending → queue không tồn tại mãi mãi các bản duplicate.
- **084 — Inbound consume mọi namespace**: `gateway.mjs` duyệt `[APP_NS, ...listApps()]` (vd `qldadtxd`)
  thay vì chỉ `ai-pr-reviewer`; mỗi namespace lỗi không sập vòng lặp namespace khác.

## Chạy
```bash
node scripts/telegram-gateway/install.mjs
node scripts/telegram-gateway/gateway.mjs --start          # 1 instance (bridge+notifier+inbound)
# hoặc tự heal:
node scripts/telegram-gateway/supervisor.mjs --run
```

## Test
```bash
pnpm test:gateway          # unit (queue/lock/routeUpdate/transport/notifier/supervisor)
pnpm test:gateway:mp       # multi-process lock + integration (real child gateway + mock transport)
```
