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
- `notifier.mjs` — single outbound sender (queue consumer, idempotency, retry).
- `supervisor.mjs` — đảm bảo 1 instance, tự heal khi chết/stale.
- `gateway.mjs` — entry single instance (bridge + notifier trong 1 process).
- `adapter-ai-pr-reviewer.mjs` — legacy API (`notifyTelegram`/`notifyRaw`) → enqueue outbound.
- `install.mjs` — setup runtime dir + copy token.

## Chạy
```bash
node scripts/telegram-gateway/install.mjs
node scripts/telegram-gateway/gateway.mjs --start          # 1 instance (bridge+notifier)
# hoặc tự heal:
node scripts/telegram-gateway/supervisor.mjs --run
```

## Test
```bash
pnpm test:gateway
```
