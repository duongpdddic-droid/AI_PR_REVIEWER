## 23/08/2026 10:40 (ACT) — [GPT-REV-039]+[GPT-REV-040] + Issue #5 canonical SSOT ✅ BÀN GIAO LẠI GPT
- **Findings**: [GPT-REV-039] (runtime wiring) còn hiệu lực; [GPT-REV-040] mới — mirror policy hai repo trái kiến trúc; **Issue #5** thay thế phần copy policy/protocol của Issue #2: AI_PR_REVIEWER = SSOT, QLDA chỉ project config + pin.
- **Commit `565f33a`** (11 files) trên `chore/policy-sync-reviewer-phases`:
  - Policy `.5`: bỏ mirror note; thêm **projectPolicyContract** (allowedProjectOverrides whitelist, invariantLockedKeys, 5 mã fail-closed).
  - **`scripts/effective-policy.mjs`**: resolver global+project fail-closed (BLOCKED_CANONICAL_UNAVAILABLE/INVALID, VERSION_MISMATCH, INVALID_OVERRIDE, INVARIANT_OVERRIDE); orchestrator + gpt-approval đọc qua resolver (mirror legacy = fallback backward-safe); `processPr` block fail-closed khi resolution lỗi.
  - Runtime [039]: `resolveReviewPhase`/`planEscalationForPhase`/`evaluateSteadyApprovalGates`/`resolveRebuttalOutcome`/`planDiscoveryBehavior`; phase blocked → status:blocked.
  - Tests: test-effective-policy.mjs (7), test-integration-review-runtime.mjs (6), P7 → 40/40.
- **Commit `02290ba`**: verify.yml + workflow_dispatch (push không tự trigger pull_request run — đã chạy tay, check-run verify=success tại HEAD).
- **Verify**: verify 53/53; test 126/126; integration orchestrator 73/73 + approval-gate 50/50 + runtime 6; CI SUCCESS dispatch run 32614761014 tại `02290ba`.
- **Bàn giao**: `[CLINE-FIX-040]`+`[CLINE-FIX-039] cập nhật` (issuecomment-5383840754, cập nhật HEAD issuecomment-5383966816); PR body HEAD `02290ba`; labels read-back agent:gpt + review-requested. Phối hợp QLDA#42 `a82558c` CI PASS (run 32614439094). Issue #5: claim → in-progress → review-requested + comment (issuecomment-5383885252, đã patch SHA cuối).
- **Trạng thái**: chờ GPT re-review #4 (`02290ba`) + #42 (`a82558c`). Sau approval: Bố quyết merge cả hai PR.

## 23/08/2026 09:05 (ACT) — [GPT-REV-039]: steady-state không tự kích hoạt ✅ BÀN GIAO LẠI GPT (đã supersede bởi vòng 10:40)
- **Finding**: GPT re-review AI_PR_REVIEWER#4 tại `c1fe477` — policy khai báo steady-state tự kích hoạt khi hai PR merge, trong khi runtime wiring chưa tồn tại; tests chỉ check khóa JSON.
- **Chọn phương án (2) của GPT**: giữ PR #4 là contract trung gian; runtime wiring = acceptance criterion bắt buộc của Issue #2 (PR thứ ba riêng).
- **Commit `f2abe47`** (3 files +29/−7): policy `.4` — `transition.runtimeWiringPrRequired: true`, `appliesWhile` viết lại theo điều kiện wiring; `steadyState.appliesAfter` = "PR wiring thứ ba được GPT duyệt đúng HEAD SHA và người dùng merge"; `activationRequires` = [runtimeWiringPrGptApproved, runtimeWiringPrMerged]. Protocol §1a + tiêu đề steadyState + bullet mới. Test P6 (+4 asserts) → 33/33.
- **Verify**: verify 47/47; test 126/126; CI SUCCESS `f2abe47`. Đồng bộ QLDA#42 commit `64fa3db` (33/33, 14/14, 59, data PASS).
- **Bàn giao**: `[CLINE-FIX-039]` (issuecomment-5383611705); labels read-back agent:gpt + review-requested; PR body HEAD cập nhật.
- **Trạng thái**: IN PROGRESS — chờ GPT re-review #4 (`f2abe47`) + QLDA#42 (`64fa3db`). Sau approval: Bố merge → PR wiring runtime thứ ba.


# Active Context (AI_PR_REVIEWER)

## Mục tiêu
Thực hiện Issue #2 (duongpdddic-droid/AI_PR_REVIEWER#2): chuẩn hóa toàn bộ AI PR Review —
tách CI verification ≠ semantic review ≠ approval ≠ merge authorization; approval khóa HEAD SHA;
mô hình reviewer HAI GIAI ĐOẠN theo [USER-DECISION] sau Issue #2 (transition: GPT duyệt cuối hai
PR triển khai; steadyState: reviewer:local mặc định, GPT chỉ escalation). Hai PR riêng:
PR1 repo này (đã merge), PR2 QLDA_DTXD #42.

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
**Vòng fix [GPT-REV-036..038] HOÀN TẤT (23/08/2026 07:5x)**:
- PR QLDA_DTXD#42: commit `da4aa8260731551ff81606c10bb682ebe68d8726` — policy bump `2026-08-23.3`
  thêm `reviewerCoderContract` (036) + `minimalCommandDiscovery` (037); protocol §6 viết lại + §6a mới;
  AGENTS/clinerules tham chiếu ngắn; test P4/P5 → 29/29 PASS; verify 14/14; test 59; test:data PASS.
  Comment `[CLINE-FIX-036..038]` (issuecomment-5383475255); labels `agent:gpt` +
  `status:review-requested`; PR body HEAD `da4aa82`.
- PR reconcile AI_PR_REVIEWER#4 (038): branch `chore/policy-sync-reviewer-phases`, commit
  `c1fe477` — policy `.3` đồng bộ (requiredChecks `"verify"`), protocol §1a/§6/§6a, test mirror
  29/29 PASS, full-verify 47/47, pnpm test 126/126. Draft→ready; labels `agent:gpt` +
  `status:review-requested`. Link: https://github.com/duongpdddic-droid/AI_PR_REVIEWER/pull/4
Dừng chờ GPT re-review cả hai PR. Local QLDA_DTXD đang ở branch PR; local repo này ở branch PR #4.

## Quyết định
- Policy dùng JSON thay YAML (vòng 1); vòng 2 bump policyVersion `2026-08-23.1` (taxonomy + decisionId).
- Metric quy mô diff canonical: churn = additions + deletions; vượt limit = Decision Gate (blocked).
- Ngoại lệ quy mô cho PR #3: người dùng chỉ thị sửa trực tiếp trên branch (đã ghi body + comment CLINE-FIX-031).
- gpt-approval là user-relay gate (không tự xác minh danh tính GPT) — docs ghi rõ.
- Merge PR #3 không qua GPT approval: theo lệnh trực tiếp của Bố (quyền merge thuộc người dùng).
- **[GPT-REV-035] 23/08/2026**: policy QLDA_DTXD bump `2026-08-23.2` thêm `reviewerPhases`;
  giữ nguyên các key validator bắt buộc của `review-contract.mjs` để orchestrator không vỡ contract.
  Wiring runtime steady-state approval thuộc PR orchestrator thứ hai của Issue #2 (repo này) —
  ghi minh bạch trong [CLINE-FIX-035], không giấu.
- Policy hai repo tạm lệch phiên bản (.2 vs .1) — known-drift, phải reconcile trước khi đóng Issue #2.
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
Chờ GPT re-review PR QLDA_DTXD#42 tại HEAD `7e9f251` (dừng theo lệnh). Sau approval + Bố cho
merge → merge PR2, đồng bộ policy `2026-08-23.2` (reviewerPhases) về repo này, wiring orchestrator
cho steady-state approval, xử lý labels cũ, rồi đóng điều kiện còn lại của Issue #2.
