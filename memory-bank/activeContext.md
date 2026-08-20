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

## Nhiệm vụ mới (từ MO_TA_AI_PR_VIEWER.MD — hỗ trợ review dự án khác)

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