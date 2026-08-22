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
5. [x] **Vòng fix 2 theo GPT review (GPT-REV-031..034)** — commit `cd635d8`, push:
   - [x] 031: metric diff = additions+deletions; vượt ngưỡng → critical blocking → `status:blocked` Decision Gate, không PRE_REVIEW_PASS, không trả Cline, không tăng vòng fix (`planPreReviewOutcome({decisionGate})`).
   - [x] 032: `gpt-approval.mjs` thành user-relay gate DI — bắt buộc `--payload` ràng buộc repository/prNumber/full headSha/policyVersion/decisionId; `validateApprovalPayload()` fail-closed trước mọi mutation; không code path tự động gọi gate (test I.17).
   - [x] 033: giao dịch an toàn — marker TRƯỚC → read-back verify → gỡ nhãn → approved SAU; mọi lệnh gh error-checked; `ensureNotApproved()` phục hồi; không kịch bản approved-thiếu-marker (test A.1–A.9 inject lỗi từng bước).
   - [x] 034: taxonomy canonical `critical|important|suggestion`; `blockingSeverities=[critical,important]`; policy bump `2026-08-23.1`; docs/tests đồng nhất.
6. [x] Tests bổ sung: pure C.15–C.16; integration I.15–I.17; file mới `scripts/test-integration-approval-gate.mjs` A.1–A.9; full-verify thêm gate test; package.json test:integration chạy cả hai.
7. [x] Quality gates: pnpm verify 42/42, pnpm test 126/126, pnpm test:integration 73/73+50/50, git diff --check sạch; CI `verify` SUCCESS trên GitHub tại HEAD mới.
8. [x] Bàn giao lại: 4 comment [CLINE-FIX-031..034], PR body cập nhật HEAD mới + bằng chứng, labels `agent:gpt` + `status:review-requested`.

## Bước hiện tại
ĐÃ DỪNG chờ GPT re-review PR #3. Không tự approve/merge/deploy.

## Quyết định
- Policy dùng JSON thay YAML (vòng 1); vòng 2 bump policyVersion `2026-08-22.1` → `2026-08-23.1`
  (taxonomy severity + decisionId trong marker) — approval cũ theo version trước tự vô hiệu.
- Metric quy mô diff canonical: churn = additions + deletions (`diffLimits.metric` trong policy).
- Vượt diff limit là Decision Gate (blocked), không phải request-fix cho Cline.
- Ngoại lệ quy mô cho chính PR #3: người dùng chỉ thị sửa trực tiếp trên branch này (không tạo
  branch/PR mới) — đã ghi trong body PR + comment CLINE-FIX-031 để GPT xác nhận.
- gpt-approval giờ là user-relay gate: script ghi nhận quyết định relay, KHÔNG tự xác minh danh
  tính GPT — docs ghi rõ giới hạn xác thực này.
- Uncommitted changes cũ bị Issue #2 thay thế; xóa helper chết autonomous-core (vòng 1).

## Vấn đề trì hoãn
- [ ] `MO_TA_AI_PR_VIEWER.MD` còn tên cũ AI_PR_VIEWER — tài liệu lịch sử, cần quyết định xóa/archive.
- [ ] Sau khi PR2 (QLDA_DTXD) thêm policy, target repo hết CI_UNKNOWN fail-closed.
- [ ] reviewer-agent/ inert giữ nguyên theo Decision Gate 21/08.
- [ ] Telegram notify FAIL exit 2 (thiếu token/config tại `~/.ai-pr-reviewer/tg.json`) — NHẮC BỐ:
      cung cấp token/config hoặc xác nhận bỏ kênh Telegram cho repo này. KHÔNG coi là "đã thông báo".

## Bước tiếp theo
ĐÃ DỪNG: PR #3 HEAD `cd635d8a12d4836b8d9600d746771aee6eb36c3f`, CI PASS,
labels agent:gpt + status:review-requested, 4 phản hồi CLINE-FIX đã đăng.
Chờ GPT review lại. PR2 (QLDA_DTXD thêm policy) chỉ làm sau PR #3 được GPT duyệt VÀ người dùng
cho phép merge.
