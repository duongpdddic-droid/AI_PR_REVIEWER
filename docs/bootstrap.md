<!-- module-version: 1 -->

# Bootstrap Guide (AI_PR_REVIEWER)

File này LUÔN được nạp đầu tiên. Chỉ chứa định hướng — quy tắc canonical nằm ở
`.github/ai-review-policy.json` và `docs/AGENT_HANDOFF_PROTOCOL.md`.

## Nhận diện repository & vai trò
- `origin` = `duongpdddic-droid/AI_PR_REVIEWER` → repo control-plane (canonical policy/protocol).
- `origin` = `duongpdddic-droid/QLDA_DTXD` → repo dự án (chỉ project config, tự tải module `project-qlda`).

## Tìm task hiện tại
- Issue có label `agent:cline` + `status:ready-for-cline`.
- Chạy `pnpm intake` (read-only) trước khi claim; claim qua `--claim <số>` sau preflight.

## Canonical policy reference
- Global machine policy: `.github/ai-review-policy.json` (repo này).
- Effective policy = global canonical + project config, resolve qua `scripts/effective-policy.mjs` (fail-closed).

## Invariants luôn bắt buộc
Xem `docs/modules/_invariants.md` — luôn được tải cho mọi task.

## Module nào phải tải cho từng loại task
| taskType | Modules |
|---|---|
| `coder-task` | coder, github-workflow, memory-bank, escalation |
| `reviewer-task` | reviewer, policy-resolver, github-workflow, escalation |
| `orchestration-task` | github-workflow, policy-resolver, escalation |
| `notification-task` | telegram, escalation |

Routing runtime: `scripts/context-router.mjs` + manifest `scripts/context-manifest.json`.
Module thiếu/version sai/vượt budget → `BLOCKED_*` fail-closed.
