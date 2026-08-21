# Active Context (AI_PR_REVIEWER)

## Mục tiêu
Khởi tạo bộ khung dự án AI_PR_REVIEWER độc lập (kế thừa toàn bộ kiến trúc điều phối
Agent, loại bỏ 100% mã nguồn và dữ liệu nghiệp vụ của dự án cũ).

## Chế độ
Tự hành (act).

## Kế hoạch thực thi
1. [x] Tạo thư mục `C:\Users\Admin\.cline\AI_PR_REVIEWER` + `git init` (nhánh `main`).
2. [x] Sao chép rules Cline (01, 02, 03, 04, 05, 07 — bỏ 06-gas-deployment).
3. [x] Khởi tạo Memory Bank gồm 6 file mẫu trống nền tảng.
4. [x] Sao chép `AGENT_HANDOFF_PROTOCOL.md` + templates `.github` (canonical remote => `duongpdddic-droid/AI_PR_REVIEWER`).
5. [x] Khởi tạo `.agent/` (`config.json`, `conventions-coder.md`, `conventions-reviewer.md`).
6. [x] Sao chép/điều chỉnh scripts: `full-verify.mjs` (tổng quát), `extract-behavior-map.mjs` (tổng quát), `find-in-map.mjs`, `notify-telegram.mjs`, `tg-notify-core.mjs`, `github-task-intake.mjs` (cập nhật canonical remote), `test-pure-logic.mjs`.
7. [x] Tạo file gốc: `package.json`, `.gitignore`, `README.md`.
8. [x] Cài dependency: `pnpm install` (acorn 8.18.0, acorn-walk 8.3.5, jsdom 24.1.3).
9. [x] Chạy kiểm thử: `pnpm verify` => FULL-VERIFY 18/18 PASS; `pnpm test` => 7/7 PASS.

## Bằng chứng thực thi
- Thư mục: `C:\Users\Admin\.cline\AI_PR_REVIEWER`.
- Không chứa mã nguồn/n dữ liệu nghiệp vụ cũ: không có `Backend/*.js`, `*.csv`, `QLDA_DDIC.html`, `appsscript.json`.
- `pnpm install`: thành công (65 package).
- `node scripts/full-verify.mjs`: 18/18 PASS, mã thoát 0.
- `node scripts/test-pure-logic.mjs`: 7/7 PASS, mã thoát 0.

## Trạng thái
COMPLETED — bộ khung đã sẵn sàng 100%.

## Bước tiếp theo
- Người dùng thực hiện lần commit đầu tiên (`git add . && git commit -m "chore: initial project skeleton"`).
- Khi có repository GitHub mới, cập nhật lại tên remote canonical trong `scripts/github-task-intake.mjs` nếu khác `duongpdddic-droid/AI_PR_REVIEWER`, rồi chạy `pnpm intake --claim <n>`.

## Nhiệm vụ mới (21/08/2026 23:05) — Tự động hoá AI_PR_REVIEWER ↔ Cline dự án (routing đa repo)

### Mục tiêu
Khép kín vòng review giữa reviewer đa repo và các Cline coder dự án: CI fail → tự sinh việc cho Cline dự án qua GitHub; CI pass → bàn giao GPT; vượt budget vòng → blocked.

### Quyết định routing (đã chốt)
Hybrid label + issue việc sửa (không tạo PR mới, không tự approve):
- CI PASS → PR giữ `status:review-requested` + thêm `agent:gpt`; skip PR đã có `agent:gpt` (chống xử lý lại mỗi chu kỳ).
- CI FAIL → PR `-review-requested +changes-requested +agent:cline` + tạo issue `[review-fix] PR #N — vòng rK` (labels `agent:cline` + `status:ready-for-cline` + `review-fix`) trong target repo → Cline dự án nhận qua `github-task-intake` sẵn có, fix trên branch PR rồi gắn lại `review-requested`.
- Idempotent: còn issue `[review-fix]` mở → không tạo trùng; vòng đếm từ tiêu đề issue cũ.
- Vượt `maxReviewRounds` (mặc định 3) → PR `status:blocked`, gỡ `agent:cline` (Decision Gate).
- Lý do chọn có issue: intake của Cline dự án chỉ quét Issue, không quét nhãn PR — label-only không đánh thức được coder.

### Đã làm
- [x] `autonomous-core.mjs`: thêm helper thuần routing — `FIX_ISSUE_LABEL`, `fixIssueTitle`, `nextFixRound`, `fixIssueBody`, `planRouting`.
- [x] `unified-orchestrator.mjs`: wire routing — `listReviewPRs` lấy thêm labels + skip `agent:gpt`; `listFixIssues`/`ensureLabels`/`createFixIssue`/`notifyLocal`; vòng xử lý dùng `planRouting`; Telegram notify fire-and-forget (config `notifyTelegram`).
- [x] Deprecation wrapper: `pipeline-run.mjs`, `g2-runner.mjs` → `autonomous-run.mjs`; `agent-runner.mjs` → `unified-orchestrator.mjs` (cùng pattern `reviewer-orchestrator.mjs`).
- [x] `.github/workflows/orchestrator.yml` (mới): cron 15 phút + workflow_dispatch; dry-run mặc định, `--execute` khi `vars.ORCHESTRATOR_EXECUTE == 'true'`; cần secret `ORCHESTRATOR_PAT` (cross-repo); concurrency group chống chồng chu kỳ.
- [x] `.github/workflows/verify.yml`: thêm bước smoke `node scripts/unified-orchestrator.mjs` (dry-run, `GH_TOKEN: github.token`).
- [x] `.agent/config.json`: `orchestrator` → `unified-orchestrator.mjs`; thêm `notifyTelegram: true`.
- [x] `test-pure-logic.mjs`: +20 test routing (53/53 PASS).
- [x] Dọn 2 file rác tên hỏng (U+2011) trong `.agent/`: `conventions‑eviewer.md`, `conventions‑­​eviewer.md`.

### Bằng chứng thực thi (21/08/2026 23:05)
- `pnpm test` → **53/53 PASS**, exit 0.
- `pnpm verify` → **32/32 PASS**, exit 0 (node --check + BOM 31 file + dup fn + test + behavior map).
- `.agent/config.json` parse JSON OK (ConvertFrom-Json).
- Dry-run thật: `node scripts/unified-orchestrator.mjs` → quét `duongpdddic-droid/QLDA_DTXD`, "không có PR chờ review", `DONE`, exit 0.
- 4 wrapper chạy thật exit 0, chuyển tiếp đúng, không mutation (reviewer-orchestrator/agent-runner → unified DONE; g2-runner/pipeline-run → autonomous DRY_RUN_PLAN).
- `package.json`: +script `orchestrate` → unified-orchestrator; `pnpm orchestrate` dry-run thật: phát hiện PR QLDA_DTXD#32 đã có `agent:gpt` → skip đúng "chống xử lý lại", DONE exit 0.

### Còn lại (cần người dùng)
- [ ] Tạo secret `ORCHESTRATOR_PAT` (PAT có quyền repo trên target repos) + variable `ORCHESTRATOR_EXECUTE=true` để bật chạy lịch `--execute` trên GitHub Actions.
- [ ] Commit + push toàn bộ thay đổi (worktree đang dirty → preflight `--execute` local sẽ fail-closed `BLOCKED_DIRTY_WORKTREE` cho tới khi commit).

### Quyết định bổ sung (Decision Gate — Bố chốt 21/08/2026 23:05)
- **BỎ toàn bộ nửa Aider Reviewer**: không khôi phục dispatch aider/model local review cho target repos. Việc deprecate `agent-runner.mjs` (từng chứa dispatch Aider Reviewer) là đúng chủ đích, không phải capability gap.
- Reviewer duy nhất: GPT (qua `agent:gpt`) + local reviewer = chính AI_PR_REVIEWER (phiên Cline, vai `agent:local-reviewer` đồng đẳng GPT). Không tạo thêm runner review nào.
- `reviewer-agent/` + `conventions-reviewer.md`: giữ nguyên dạng inert, không dọn.

### Trạng thái
COMPLETED (phần code + test + verify). Phần vận hành (PAT, execute thật) chờ người dùng.

## Nhiệm vụ mới (21/08/2026 20:10) — Orchestrator đóng vòng (single trigger → hoàn tất)

### Mục tiêu
Loại bỏ các điểm dừng thủ công trong luồng xử lý Issue GitHub, cho phép 1 lệnh duy nhất chạy tới khi hoàn tất (claim → code → verify → review/fix → PR → approve).

### Đã làm
- [x] `scripts/autonomous-core.mjs` (mới): lõi thuần — `parseClaimResult`, `isClaimSuccess`, `planReview` (state machine ≤3 vòng fix), `canRetryFix`, `issueStatusFromLabels`, `branchNameFor`, `summarizeVerify`.
- [x] `scripts/autonomous-run.mjs` (mới): orchestrator đóng vòng. Mặc định DRY-RUN; `--execute` mutation; `--loop` daemon; `--no-aider` bỏ qua coder LLM.
- [x] Thêm 16 test autonomous-core vào `scripts/test-pure-logic.mjs` (33/33 PASS).
- [x] `package.json`: thêm scripts `autonomous`, `autonomous:execute`.

### Pipeline khép kín (autonomous-run.mjs)
claim (qua subprocess `github-task-intake.mjs --claim`) → tạo task branch từ origin/main → coder (`aider`) → `full-verify` → review/fix loop ≤3 vòng → commit → push → draft PR → approve → cập nhật label → notify Telegram.

### Bằng chứng thực thi
- `node --check scripts/autonomous-run.mjs` + `autonomous-core.mjs` → exit 0.
- `pnpm verify` → **30/30 PASS** (2 file mới được bao phủ node --check + dup fn).
- `pnpm test` → **33/33 PASS**.
- Dry-run end-to-end trên Issue #1 (21/08/2026 20:31): `node scripts/autonomous-run.mjs` → `DRY_RUN_PLAN` phát hiện đúng Issue #1, exit 0.
- `--execute --no-aider` → preflight fail-closed chặn `BLOCKED_DIRTY_WORKTREE`, exit 1 (không mutation).

### Bug đã sửa trong phiên (21/08/2026 20:31)
1. `runQuiet`: khi subprocess exit != 0, `execFileSync` ném exception có `e.stdout` chứa output — sửa ưu tiên đọc `e.stdout` trước `e.stderr` (tránh mất JSON intake khi bị blocked).
2. `processOneCycle`: intake LUÔN in JSON ra stdout cả khi exit != 0 → parse JSON trước, chỉ coi là lỗi khi `parseClaimResult` trả `ERROR`.
3. **Vi phạm giao thức bàn giao (21/08/2026 20:42)**: bước 6 cũ tự `reviewPR approve` + gắn `status:approved` — Cline tự approve code của chính mình. Đã sửa: bàn giao GPT review đúng chuẩn — chuyển label `status:review-requested` + `agent:gpt`, gỡ `status:in-progress` + `agent:cline`, KHÔNG tự approve/merge. Xóa hàm `reviewPR`/`addPrLabel` (chỉ reviewer mới được approve).

### Thiết lập bên ngoài đã tạo
- Labels workflow GitHub (9/9): `agent:cline/gpt/local-reviewer`, `status:ready-for-cline/in-progress/review-requested/changes-requested/approved/blocked`.
- Issue #1 `[TEST] Dry-run orchestrator đóng vòng` (agent:cline + status:ready-for-cline).

## Bước tiếp theo
- Chạy execute thật tới PR: cần worktree sạch (commit/đẩy công việc hiện tại trước, hoặc dùng workspace sạch). `node scripts/autonomous-run.mjs --execute` (có thể thêm `--no-aider` để test pipeline không cần aider).
- Chạy daemon dài hạn: `node scripts/autonomous-run.mjs --execute --loop`.
- Xác nhận hành vi Telegram notify + watchdog (cần `~/.ai-pr-reviewer/tg.json`).

### Lưu ý thiết kế
- DRY-RUN dùng intake **read-only** (không `--claim`) — không mutation.
- `process.exitCode` thay vì `process.exit` để stdout flush được khi chạy qua pipe.
- Claim vẫn fail-closed + preflight + lock (tái dùng nguyên `github-task-intake.mjs`).
- Aider chạy `--yes-always --no-auto-commits`; orchestrator tự commit/push (không để Aider tự commit).

## Bước tiếp theo
- Dry-run end-to-end trên 1 Issue test thật khi có Issue `agent:cline + status:ready-for-cline`.
- Chạy thật: `node scripts/autonomous-run.mjs --execute` (hoặc `pnpm autonomous:execute`).
- Chạy daemon dài hạn: `node scripts/autonomous-run.mjs --execute --loop`.
- Xác nhận hành vi Telegram notify + watchdog (cần `~/.ai-pr-reviewer/tg.json`).

## Trạng thái
IN PROGRESS — code + test xong, chờ dry-run end-to-end trên issue thật để khép kín nghiệm thu.

### Chưa bổ sung (khoảng trống so với spec giai đoạn 2)
| Thành phần | Trạng thái | Ghi chú |
|---|---|---|
| `.agent/config.json` schema | THIẾU `project_name` + `labels.*` | runner dùng `config.project_name`, `config.labels.review_requested/changes_requested/ready_to_code` — chưa có. |
| `scripts/agent-runner.mjs` | CHƯA TỒN TẠI | Orchestrateur headless (scan `gh pr/issue` + dispatch `aider` trên worktree coder/reviewer). Spec đưa sẵn đoạn code mẫu. |
| Reviewer prompts | CHƯA TỒN TẠI | `reviewer-agent/prompts/system-reviewer.md` + `finding-schema.md` (spec §6). |
| GitHub Actions verify workflow | CHƯA TỒN TẠI | `.github/workflows/verify.yml` để reviewer thấy green checks. |
| Static quality gates nâng cao | CÓ PHẦN NÀO | full-verify có `node --check`/`BOM`/dup/test; chưa có secret scan + out-of-scope file. |
| `review-state.json` schema | CHƯA TẠO | Lock lease review (`schemaVersion`, `activeReviewer`, `pr`, `headSha`, ...). |

### Đã có / tools available
- `aider` : `C:\Users\Admin\.local\bin\aider.exe`.
- `gh` : `C:\Program Files\GitHub CLI\gh.exe`.
- `full-verify.mjs`, `extract-behavior-map.mjs`, `find-in-map.mjs`, `notify-telegram.mjs`, `tg-notify-core.mjs`, `github-task-intake.mjs`, `test-pure-logic.mjs` đã OK.

### Để review một dự án khác (Giai đoạn 2)
`node scripts/agent-runner.mjs <repo-path>` → runner đọc `.agent/config.json` của repo-target, tạo worktree reviewer (`../reviewer-workspace`) và worktree coder (`../coder-workspace`), rồi dispatch `aider` theo label.

- Người dùng khẳng định "có, triển khai 1-3".
- [x] (1) Cập nhật schema `.agent/config.json`: thêm `project_name`, `coderWorkspace`, `reviewerWorkspace`, `labels` block (`review_requested/review_in_progress/changes_requested/approved/ready_to_code`), `orchestrator`.
- [x] (2) Tạo `scripts/agent-runner.mjs`: orchestrateur headless (scan `gh pr/issue` theo label → dispatch Aider Coder/Reviewer trên worktree siblings).
- [x] (3) Tạo `reviewer-agent/prompts/system-reviewer.md` + `finding-schema.md`.

## Evidence
- `node --check scripts/agent-runner.mjs` → exit 0.
- `pnpm verify` → **20/20 PASS** (agent-runner được bao phủ node --check + dup fn).
- `pnpm test` → **7/7 PASS**.

## Trạng thái
1-3 COMPLETED. Runbook review dự án khác:
`node scripts/agent-runner.mjs <đường-dẫn-repo>` → runner đọc `.agent/config.json` repo-target, tạo worktree `coder-workspace`/`reviewer-workspace` (siblings), dispatch Aider theo nhãn.

## Deferred (hạn chế scope — chưa triển khai 4-6)
- [ ] 4. GitHub Actions `verify.yml`.
- [ ] 5. Static quality gates nâng cao (secret scan / out-of-scope file scan).
- [ ] 6. `review-state.json` lease lock.

## Bước tiếp theo
- User commit (`git add -A && git commit -m "feat: agent-runner + reviewer schema/prompts"`).
- Khi tạo repo GitHub mới, cập nhật `CANONICAL_REPO` trong `scripts/github-task-intake.mjs`.