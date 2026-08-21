# Progress (AI_PR_REVIEWER)

## 21/08/2026 23:05 — Tự động hoá routing AI_PR_REVIEWER ↔ Cline dự án — COMPLETED (code+test)

- [x] Routing chốt: CI PASS → `agent:gpt` (không tự approve); CI FAIL → `status:changes-requested` + `agent:cline` + issue `[review-fix]` (agent:cline + ready-for-cline) trong target repo cho Cline dự án nhận qua intake; idempotent theo vòng; vượt `maxReviewRounds` → `status:blocked`.
- [x] `autonomous-core.mjs`: +5 helper thuần routing (`fixIssueTitle`, `nextFixRound`, `fixIssueBody`, `planRouting`, `FIX_ISSUE_LABEL`).
- [x] `unified-orchestrator.mjs`: wire routing + skip PR đã có `agent:gpt` + `ensureLabels`/`createFixIssue`/`listFixIssues` + Telegram notify (`notifyTelegram` config).
- [x] Wrapper deprecation: `pipeline-run.mjs`, `g2-runner.mjs` → `autonomous-run.mjs`; `agent-runner.mjs` → `unified-orchestrator.mjs`.
- [x] `.github/workflows/orchestrator.yml` (mới, cron 15p, dry-run mặc định, `--execute` qua `vars.ORCHESTRATOR_EXECUTE` + secret `ORCHESTRATOR_PAT`); `verify.yml` thêm smoke dry-run orchestrator.
- [x] `.agent/config.json`: `orchestrator` → unified; +`notifyTelegram`. Dọn 2 file rác tên U+2011 trong `.agent/`.
- [x] `pnpm test` 53/53 PASS (+20 test routing); `pnpm verify` 32/32 PASS.
- [x] Dry-run thật trên QLDA_DTXD: DONE exit 0; 4 wrapper smoke exit 0 không mutation; `pnpm orchestrate` (script mới) skip đúng PR#32 đã có `agent:gpt`.
- [x] Cần người dùng: secret `ORCHESTRATOR_PAT` + `ORCHESTRATOR_EXECUTE=true` để bật lịch execute; commit/push thay đổi. → **XONG 21/08/2026 23:42**: commit `7d5bae1` pushed; secret+variable set qua gh CLI; dispatch run 32504320114 xanh (`execute=true`, DONE, không mutation — PR#32 skip đúng). Cron `*/15` LIVE.

## 20/08/2026 20:35 — Khởi tạo bộ khung AI_PR_REVIEWER — COMPLETED

- [x] Thư mục `C:\Users\Admin\.cline\AI_PR_REVIEWER` đã tạo + `git init` (nhánh `main`).
- [x] Rules Cline : 01 workflow, 02 memory-bank, 03 coding-standards, 04 security, 05 terminal-safety, 07 testing-strategy (loại bỏ 06-gas-deployment).
- [x] Memory Bank 6 file mẫu trống: projectbrief.md, productContext.md, activeContext.md, systemPatterns.md, techContext.md, progress.md.
- [x] `docs/AGENT_HANDOFF_PROTOCOL.md` + `.github/PULL_REQUEST_TEMPLATE.md` + `.github/ISSUE_TEMPLATE/gpt-task.yml` — canonical remote `duongpdddic-droid/AI_PR_REVIEWER`, đã loại bỏ tham chiếu GAS/clasp/test:data.
- [x] `.agent/` : config.json, conventions-coder.md, conventions-reviewer.md.
- [x] Scripts : full-verify.mjs (tổng quát), extract-behavior-map.mjs (tổng quát), find-in-map.mjs, notify-telegram.mjs, tg-notify-core.mjs, github-task-intake.mjs, test-pure-logic.mjs.
- [x] File gốc: package.json, .gitignore, README.md.
- [x] `pnpm install` PASS (acorn 8.18.0, acorn-walk 8.3.5, jsdom 24.1.3).
- [x] `pnpm verify` → FULL-VERIFY 18/18 PASS (mã thoát 0).
- [x] `pnpm test` → 7/7 PASS (mã thoát 0).

## 21/08/2026 20:10 — Orchestrator đóng vòng (single trigger → hoàn tất) — IN PROGRESS

- [x] `scripts/autonomous-core.mjs` (mới): lõi thuần testable cho orchestrator đóng vòng.
- [x] `scripts/autonomous-run.mjs` (mới): orchestrator khép kín claim → code → verify → review/fix (≤3 vòng) → PR → approve; mặc định DRY-RUN, `--execute`/`--loop`/`--no-aider`.
- [x] Test autonomous-core: `pnpm test` 33/33 PASS.
- [x] `pnpm verify` 30/30 PASS (bao phủ 2 file mới).
- [x] Dry-run: `node scripts/autonomous-run.mjs` → `NO_TASK` exit 0 (chưa có issue ready).
- [x] Dry-run end-to-end trên Issue test thật (21/08/2026 20:31): tạo labels workflow (9/9), Issue #1 `[TEST] Dry-run orchestrator đóng vòng` (agent:cline + ready-for-cline). `node scripts/autonomous-run.mjs` → `DRY_RUN_PLAN` phát hiện đúng Issue #1 + tên nhánh, exit 0.
- [x] `--execute --no-aider` fail-closed đúng: preflight chặn `BLOCKED_DIRTY_WORKTREE` (worktree có file chưa commit), exit 1 — KHÔNG mutation.
- [x] Sửa 2 bug orchestrator: (1) `runQuiet` ưu tiên đọc `e.stdout` khi subprocess exit != 0; (2) parse JSON intake bất kể exit code (intake in JSON ra stdout cả khi blocked).
- [x] Sửa vi phạm giao thức bàn giao (21/08/2026 20:42): bỏ tự approve — Cline chỉ bàn giao GPT review (`status:review-requested` + `agent:gpt`), không tự gắn `status:approved`/merge.

## Trạng thái
IN PROGRESS. Dry-run end-to-end đã PASS. Chưa chạy execute thật tới PR vì worktree còn file chưa commit (preflight fail-closed đúng). Để chạy execute thật: commit/đẩy công việc hiện tại hoặc dùng workspace sạch.