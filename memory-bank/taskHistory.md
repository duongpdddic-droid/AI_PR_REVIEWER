# Task History (AI_PR_REVIEWER)

> Archive từ `activeContext.md` ngày 22/08/2026 09:31 (vượt ngưỡng >5 entry COMPLETED).
> Entry khởi tạo bộ khung 20/08/2026 xem `progress.md`.

## 21/08/2026 23:05 — Tự động hoá routing đa repo — COMPLETED

### Mục tiêu
Khép kín vòng review giữa reviewer đa repo và các Cline coder dự án: CI fail → tự sinh việc cho Cline dự án qua GitHub; CI pass → bàn giao GPT; vượt budget vòng → blocked.

### Quyết định routing (đã chốt)
Hybrid label + issue việc sửa (không tạo PR mới):
- CI FAIL → PR `-review-requested +changes-requested +agent:cline` + tạo issue `[review-fix] PR #N — vòng rK` (labels `agent:cline` + `status:ready-for-cline` + `review-fix`) trong target repo → Cline dự án nhận qua `github-task-intake`, fix trên branch PR rồi gắn lại `review-requested`.
- Idempotent: còn issue `[review-fix]` mở → không tạo trùng; vòng đếm từ tiêu đề issue cũ.
- Vượt `maxReviewRounds` (mặc định 3) → PR `status:blocked`, gỡ `agent:cline` (Decision Gate).
- Lý do chọn có issue: intake của Cline dự án chỉ quét Issue, không quét nhãn PR.

### Đã làm
- [x] `autonomous-core.mjs`: helper thuần routing — `FIX_ISSUE_LABEL`, `fixIssueTitle`, `nextFixRound`, `fixIssueBody`, `planRouting`.
- [x] `unified-orchestrator.mjs`: wire routing — `listReviewPRs` lấy thêm labels + skip `agent:gpt`; `listFixIssues`/`ensureLabels`/`createFixIssue`/`notifyLocal`; Telegram notify fire-and-forget.
- [x] Deprecation wrapper: `pipeline-run.mjs`, `g2-runner.mjs` → `autonomous-run.mjs`; `agent-runner.mjs` → `unified-orchestrator.mjs`.
- [x] `.github/workflows/orchestrator.yml` (mới): cron 15 phút + workflow_dispatch; dry-run mặc định, `--execute` khi `vars.ORCHESTRATOR_EXECUTE == 'true'`; secret `ORCHESTRATOR_PAT` (cross-repo); concurrency group.
- [x] `.github/workflows/verify.yml`: thêm bước smoke `node scripts/unified-orchestrator.mjs`.
- [x] `.agent/config.json`: `orchestrator` → `unified-orchestrator.mjs`; +`notifyTelegram: true`. Dọn 2 file rác tên U+2011 trong `.agent/`.
- [x] Test +20 routing (53/53 PASS); `pnpm verify` 32/32 PASS.
- [x] Vận hành (21/08 16:42 UTC): secret `ORCHESTRATOR_PAT` + variable `ORCHESTRATOR_EXECUTE` đã set qua gh CLI (không in giá trị); dispatch run 32504320114 xanh; cron `*/15` LIVE; commit `7d5bae1` pushed.

### Quyết định bổ sung (Decision Gate — Bố chốt 21/08/2026 23:05)
- **BỎ toàn bộ nửa Aider Reviewer**: không khôi phục dispatch aider/model local review cho target repos.
- Reviewer duy nhất: GPT (qua `agent:gpt`) + local reviewer = chính AI_PR_REVIEWER (phiên Cline, vai `agent:local-reviewer` đồng đẳng GPT).
- `reviewer-agent/` + `conventions-reviewer.md`: giữ nguyên dạng inert, không dọn.

## 21/08/2026 20:10 — Orchestrator đóng vòng (single trigger → hoàn tất) — COMPLETED

### Đã làm
- [x] `scripts/autonomous-core.mjs` (mới): lõi thuần — `parseClaimResult`, `isClaimSuccess`, `planReview` (≤3 vòng fix), `canRetryFix`, `issueStatusFromLabels`, `branchNameFor`, `summarizeVerify`.
- [x] `scripts/autonomous-run.mjs` (mới): claim → task branch → coder (aider) → full-verify → review/fix loop → commit → push → draft PR → label → notify. DRY-RUN mặc định.
- [x] Test 33/33; `pnpm verify` 30/30.
- [x] Dry-run end-to-end Issue #1 (20:31): `DRY_RUN_PLAN` đúng, exit 0.
- [x] `--execute --no-aider` fail-closed: `BLOCKED_DIRTY_WORKTREE`, exit 1, không mutation.

### Bug đã sửa trong phiên
1. `runQuiet`: ưu tiên `e.stdout` khi subprocess exit != 0 (tránh mất JSON intake khi blocked).
2. `processOneCycle`: intake LUÔN in JSON ra stdout kể cả khi exit != 0 → parse trước, chỉ lỗi khi `parseClaimResult` trả `ERROR`.
3. Vi phạm giao thức (20:42): bước cũ tự approve code của chính mình → sửa thành bàn giao GPT review (`status:review-requested` + `agent:gpt`), không tự approve/merge. *(Bị bãi bỏ 22/08/2026 — xem activeContext.)*

### Thiết lập ngoài đã tạo
- Labels workflow GitHub (9/9): `agent:cline/gpt/local-reviewer`, `status:ready-for-cline/in-progress/review-requested/changes-requested/approved/blocked`.
- Issue #1 `[TEST] Dry-run orchestrator đóng vòng`.

### Lưu ý thiết kế
- DRY-RUN dùng intake read-only (không `--claim`).
- `process.exitCode` thay vì `process.exit` để stdout flush qua pipe.
- Claim fail-closed + preflight + lock (tái dùng `github-task-intake.mjs`).

## Giai đoạn 2 (21/08/2026) — agent-runner + reviewer schema — COMPLETED (1-3), DEFERRED (4-6)
- [x] Schema `.agent/config.json`: `project_name`, `coderWorkspace`, `reviewerWorkspace`, `labels` block, `orchestrator`.
- [x] `scripts/agent-runner.mjs` (sau bị deprecate → `unified-orchestrator.mjs`).
- [x] `reviewer-agent/prompts/system-reviewer.md` + `finding-schema.md`.
- Deferred: (4) verify.yml — đã làm xong sau này; (5) static gates nâng cao (secret scan / out-of-scope); (6) `review-state.json` lease lock.
