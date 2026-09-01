# AI_PR_REVIEWER

Bộ khung orchestration độc lập cho agent AI PR Reviewer. Kế thừa kiến trúc
điều phối (rules Cline, Memory Bank, scripts verify, giao thức handoff GitHub,
configs CLI agent) nhưng không chứa mã nguồn và dữ liệu nghiệp vụ của dự án cũ.

## Nội dung

| Thư mục | Vai trò |
|---|---|
| `.clinerules/` | Rules Cline (workflow, memory bank, coding, bảo mật, terminal, testing). |
| `memory-bank/` | Trạng thái thực thi + quyết định (single source of truth). |
| `.github/` | Template PR + Issue (handoff GPT ↔ Cline). |
| `.agent/` | Config + conventions cho CLI/Aider (coder / reviewer). |
| `scripts/` | Hạ tầng verify: `full-verify.mjs`, behavior map, intake GitHub, notif Telegram. |
| `docs/` | Giao thức handoff GitHub. |

## Kích hoạt agent

- **Cline (executor)** đọc `memory-bank/activeContext.md`, claim một issue qua
  `pnpm intake --claim <n>` (préflight workspace/Git). Quy tắc: `[CLINE-FIX-NNN]`.
- **Reviewer local / GPT** : xem xét PR chỉ đọc, đăng findings `[LOCAL-REV-NNN]` / `[GPT-REV-NNN]`. Dùng worktree riêng và trạng thái trong `.agent/config.json`.

## Kiểm tra hạ tầng

```bash
pnpm install        # dependencies dev
pnpm verify         # node --check + BOM + dup fn + test-runner + behavior map
pnpm test           # tests pure-logic
pnpm test:gpt-approval  # manual GPT approval path (Issue #36) — gate manualException.enabled
```

Repo GitHub canonical (`duongpdddic-droid/AI_PR_REVIEWER`) cần điều chỉnh về
đích thực trước khi bật intake tác vụ.