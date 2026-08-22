# Active Context (AI_PR_REVIEWER)

## Mục tiêu
Hub review đa repo (target đầu tiên `duongpdddic-droid/QLDA_DTXD`): worktree sạch,
orchestrator không destructive, vòng lặp coder khép kín theo nhãn PR
(`status:review-requested` → review → `status:changes-requested` | `status:approved`).

## Chế độ
Tự hành (act).

## Kế hoạch thực thi
1. [x] Dọn worktree: gỡ gitlink mồ côi `QLDA_DTXD` khỏi git index — commit `efb20ec`.
2. [x] Đồng bộ config: `reviewer-agent/reviewer.config.json` thêm `labels` + `notifyTelegram` (khớp `.agent/config.json`).
3. [x] Routing orchestrator: pass → `status:approved`; fail → comment finding `[LOCAL-REV-NNN]`; sửa loop-breaker `agent:gpt` trong issue `[review-fix]`.
4. [x] Coder loop: `.agent/conventions-coder.md` thêm mục "Vòng review PR (label loop)".
5. [x] Kiểm thử & bàn giao: test/verify/smoke PASS; commit `ed6eb79` (local).

## Bước hiện tại
Hoàn tất — chờ người dùng push 2 commit local.

## Bằng chứng thực thi (22/08/2026 09:31)
- `git status --porcelain` sạch sau commit `efb20ec` (delete mode 160000 QLDA_DTXD).
- `pnpm test` → **73/73 PASS**, exit 0 (+20 test mới).
- `pnpm verify` → **32/32 PASS**, exit 0.
- Smoke dry-run `node scripts/unified-orchestrator.mjs` → quét đúng QLDA_DTXD, DONE exit 0.
- Commit `ed6eb79`: 5 file, +180/−22 (`autonomous-core.mjs`, `unified-orchestrator.mjs`, `test-pure-logic.mjs`, `conventions-coder.md`, `reviewer.config.json`).

## Quyết định
- **Bãi bỏ quyết định 21/08 20:42** ("KHÔNG bao giờ tự approve") theo chỉ thị mới của người dùng: CI PASS 100% → reviewer gắn `status:approved` (duyệt kỹ thuật); quyền MERGE vẫn thuộc người dùng.
- Sửa loop-breaker: issue `[review-fix]` cũ bảo coder gắn lại `agent:gpt` lên PR → orchestrator skip PR vĩnh viễn. Giờ: gỡ `status:changes-requested` + `agent:cline`, gắn lại `status:review-requested`.
- `checksDetail`: ưu tiên `gh pr checks --json name,state` (gh ≥ v2.31), fallback parser text emoji; output rỗng → phân loại theo exit code (0=pass, 8=pending, còn lại=fail).

## Vấn đề trì hoãn
- [ ] Push 2 commit local (`efb20ec`, `ed6eb79`) lên `origin/main` — chờ chỉ thị (cron orchestrator trên remote đang chạy bản cũ).
- [ ] `reviewer-agent/` giữ inert theo Decision Gate 21/08 23:05 — không dọn.
- [ ] Static gates nâng cao (secret scan / out-of-scope) + `review-state.json` lease lock — xem taskHistory mục Giai đoạn 2.

## Bước tiếp theo
- Người dùng: `git push origin main` để cron 15 phút dùng routing mới.
- Kiểm chứng vòng lặp thật khi QLDA_DTXD có PR `status:review-requested` tiếp theo.

## Lịch sử
Xem `taskHistory.md` (archive 22/08/2026 09:31).