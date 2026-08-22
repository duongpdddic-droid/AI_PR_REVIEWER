# Active Context (AI_PR_REVIEWER)

## Mục tiêu
Thực hiện Issue #2 (duongpdddic-droid/AI_PR_REVIEWER#2): chuẩn hóa toàn bộ AI PR Review —
tách CI verification ≠ semantic review ≠ approval ≠ merge authorization; approval khóa HEAD SHA;
GPT là reviewer phê duyệt cuối DUY NHẤT; local reviewer chỉ pre-review
(PRE_REVIEW_PASS | PRE_REVIEW_FINDINGS). Hai PR riêng: PR1 repo này trước, PR2 QLDA_DTXD sau.

## Chế độ
Tự hành (act) — task đặc biệt, người dùng giao GPT toàn quyền quyết định kỹ thuật;
Cline executor; KHÔNG tự gắn status:approved, KHÔNG merge/deploy.

## Kế hoạch thực thi (PR 1)
1. [x] Đọc Issue #2 + khảo sát source.
2. [x] Branch `chore/issue-2-review-contract` từ main.
3. [x] Module thuần `scripts/review-contract.mjs` + rewrite `unified-orchestrator.mjs` + `gpt-approval.mjs` + policy v1 (chi tiết vòng 1 xem taskHistory).
4. [x] Vòng 1 bàn giao: commit `cda2372` (+docs `40d2a97`), Draft PR #3, nhãn agent:gpt + status:review-requested.
5. [x] **Vòng fix 2 theo GPT review (GPT-REV-031..034)** — commit `cd635d8` (chi tiết 4 fix xem progress.md).
6. [x] Tests bổ sung: pure C.15–C.16; integration I.15–I.17; file mới `scripts/test-integration-approval-gate.mjs` A.1–A.9; full-verify thêm gate test.
7. [x] Bàn giao lại: 4 comment [CLINE-FIX-031..034], PR body cập nhật, labels agent:gpt + status:review-requested.
8. [x] **PR #3 MERGED theo chỉ thị Bố 23/08/2026 05:22** (trước khi GPT duyệt vòng fix 2 — Bố tự quyết): `gh pr ready` + `--merge`, mergeCommit `de9d6cc4cad578e1e8a96bf0e2d34563750e9a6c`, CI PASS tại HEAD `955864e`; local main fast-forward `91e5871..de9d6cc`.
9. [x] Copy `scripts/watchdog-hibernate.mjs` từ QLDA_DTXD sang repo này (`955864e`) — resolve deferred; `--heartbeat` exit 0; chỉ phụ thuộc `./tg-notify-core.mjs` + `~/.qldadtxd` dùng chung.
10. [x] Kênh Telegram notify repo này đã hoạt động (copy `~/.qldadtxd/tg.json` → `~/.ai-pr-reviewer/tg.json`).

## Bước hiện tại
PR 2 (QLDA_DTXD) đã tạo + bàn giao: PR duongpdddic-droid/QLDA_DTXD#42, branch
`chore/issue-2-review-policy`, commit `42eb69c27366225daf61813d6884382479e8d10f`,
labels `agent:gpt` + `status:review-requested`, CI "Verify code and data" PASS.
Dừng chờ GPT review. Local QLDA_DTXD đã trả về `main`.

## Quyết định
- Policy dùng JSON thay YAML (vòng 1); vòng 2 bump policyVersion `2026-08-23.1` (taxonomy + decisionId).
- Metric quy mô diff canonical: churn = additions + deletions; vượt limit = Decision Gate (blocked).
- Ngoại lệ quy mô cho PR #3: người dùng chỉ thị sửa trực tiếp trên branch (đã ghi body + comment CLINE-FIX-031).
- gpt-approval là user-relay gate (không tự xác minh danh tính GPT) — docs ghi rõ.
- Merge PR #3 không qua GPT approval: theo lệnh trực tiếp của Bố (quyền merge thuộc người dùng).
- Policy bản QLDA_DTXD giữ nguyên policyVersion `2026-08-23.1`, chỉ khác `requiredChecks`
  = `Verify code and data` (tên check-run thật, xác minh qua API tại `6db6dee`) — tránh CI_UNKNOWN.
- Approval GPT vòng fix 2 đến SAU merge (`1ae6d16` stale vs `de9d6cc` gồm thêm `5fba130`/`955864e`
  ops/docs): ghi nhận truy nguyên, không revert.

## Vấn đề trì hoãn
- [ ] `MO_TA_AI_PR_VIEWER.MD` còn tên cũ AI_PR_VIEWER — tài liệu lịch sử, cần quyết định xóa/archive.
- [x] ~~PR2 (QLDA_DTXD) thêm policy~~ — DONE: PR QLDA_DTXD#42 chờ GPT review.
- [ ] Labels cũ trong QLDA_DTXD (`reviewer:gemini`, `reviewer:dual`, `review-fix`) chưa xóa — ngoài scope tài liệu, cần Bố quyết.
- [ ] Issue #2 chưa đóng — còn điều kiện mục F (GPT-APPROVED đúng SHA từng PR, user merge).
- [ ] reviewer-agent/ inert giữ nguyên theo Decision Gate 21/08.
- [x] ~~watchdog-hibernate.mjs thiếu~~ — ĐÃ COPY 23/08/2026 05:22 (`955864e`), heartbeat PASS.
- [x] ~~Telegram notify FAIL thiếu token~~ — ĐÃ XỬÝ 23/08/2026 05:13 (byte-copy config, SENT).

## Bước tiếp theo
Chờ GPT review PR QLDA_DTXD#42 (dừng theo lệnh). Sau approval + Bố cho merge → merge PR2,
đóng điều kiện còn lại của Issue #2 (nếu đủ) hoặc báo Bố quyết đóng.
