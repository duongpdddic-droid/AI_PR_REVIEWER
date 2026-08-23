## 23/08/2026 21:10 (ACT) — Fix [GPT-REV-046] activation authority ✅ BÀN GIAO LẠI GPT
- **Finding**: [GPT-REV-046] Critical — activation marker chưa xác thực authority: `getPhaseActivationText` chỉ nối body comment (mất author/id), `parseActivationComment` không kiểm tra author được ủy quyền, wiringPr đúng phạm vi policy, PR merged thật, merge SHA khớp GitHub, GPT approval hợp lệ khóa head đã merge; `recordedBy` tự khai báo; test không đối chiếu dữ liệu GitHub thật.
- **PR AI_PR_REVIEWER#4 — policy bump `2026-08-23.7`**, trên `chore/policy-sync-reviewer-phases`:
  - Policy `activationEvidence` thêm `allowedRecorders: ["duongpdddic-droid"]` + `expectedWiringPr: {repo, number: 4}`; note mô tả xác minh authority đầy đủ.
  - `defaultIo`: bỏ `getPhaseActivationText`; thêm `getIssueComments(repo,num)` (metadata id/author/created_at, body base64 qua jq) + `getPullState(repo,num)` (REST pulls: state/merged/merge_commit_sha/head.sha).
  - `review-contract.mjs`: thêm pure `collectActivationRecords(comments)` (marker + metadata) và `planPhaseActivation({records, allowedRecorders, expectedWiringPr, wiringState, wiringApprovalRecords, policyVersion})` — fail-closed toàn bộ: author∉allowed → inactive; wiringPr sai phạm vi → inactive; wiringState null/error/chưa merged → inactive; wiringMergedSha≠merge_commit_sha → inactive; gptApprovedHeadSha≠head đã merge → inactive; không có GPT approval hợp lệ (isApprovalValid: agent:gpt + head đã merge + policyVersion hiện tại + 0 blocking) → inactive; nhiều marker mâu thuẫn → inactive (duplicate giống hệt nhau vẫn OK).
  - `unified-orchestrator.mjs`: `resolvePhaseActivation(io, policy)` tổng hợp bằng chứng; `processPr` gọi trong try/catch — mọi sai lệch/lỗi IO → giữ transition + log reason, tuyệt đối không local approve.
  - Tests: pure C.22 (+21 asserts: authority matrix); runtime R.1–R.14 (mock io authority-based: fake marker, sai author, sai wiringPr, chưa merge, sai merge SHA, sai head, thiếu/stale approval, marker mâu thuẫn, API lỗi — đều KHÔNG kích hoạt; chỉ GitHub state + GPT approval hợp lệ → steady-state).
- **Gates**: verify **53/53**; test **169/169** (pure C.22 +21); integration approval-gate 50/50 + orchestrator + runtime 20 asserts R.1–R.14; policy 40/40; mcp 51.
- **Bàn giao**: `[CLINE-FIX-046]` comment PR #4 (issuecomment-5386457959); nhãn `agent:gpt` + `status:review-requested` (read-back PASS); PR body HEAD `41c130e7f0757b8e103d624682accf30bf4e852a`; CI run `32644741965` SUCCESS.
- **Hệ lụy #42**: canonical `.7` làm pin `.6` của QLDA_DTXD#42 thành `BLOCKED_VERSION_MISMATCH` — #42 phải bump pin lên `.7` + SHA mới sau khi #4 merge (đã đúng luồng: #42 chờ canonical trên main).
- Trạng thái: chờ GPT re-review #4. Không merge/deploy tự động.

## 23/08/2026 15:27 (ACT) — Fix [GPT-REV-045] steady-state runtime wiring ✅ BÀN GIAO LẠI GPT
- **Finding**: [GPT-REV-045] Important — hard-code `runtimeWiringMerged:false`; helper pha/gates chưa điều khiển processPr; `resolveRebuttalOutcome` thiếu `expectedOutcome`; duplicate JSON keys `canonicalRepo/canonicalPath`.
- **PR AI_PR_REVIEWER#4 — commit `8a20180`** (8 files, +472/−21) trên `chore/policy-sync-reviewer-phases`, policy bump `2026-08-23.6`:
  - Activation máy đọc được: policy thêm `steadyState.activationEvidence` (issue-comment marker trên Issue #2); `parseActivationComment()` pure fail-closed (thiếu prefix/JSON hỏng/sai shape/SHA ngắn → inactive); `defaultIo.getPhaseActivationText(policy)` đọc theo khai báo policy, lỗi io → null.
  - `processPr`: bỏ hard-code; route `planEscalationForPhase` — block→blocked; escalate-gpt giữ handoff/request-fix/decision-gate; local-accept-candidate chỉ approve khi `evaluateSteadyApprovalGates().ok` (pre-check trước ghi + gate `readAfterWriteSucceeded` verify bằng read-back THẬT sau postComment); marker khóa HEAD+policyVersion reviewer `reviewer:local`; read-back FAIL → escalate-gpt.
  - `planApprovalDrift` nhận local approval hợp lệ qua `steadyLocalApproval()` mới (không drift sai); GPT vẫn duyệt duy nhất ở transition.
  - `resolveRebuttalOutcome`: REQUIRED đủ 5 trường (+`expectedOutcome`) → thiếu = malformed.
  - Duplicate keys: xóa cặp khai lặp; `scanDuplicateObjectKeys()` pure tokenizer; wired 3 đường load canonical → `BLOCKED_POLICY_DUPLICATE_KEYS`.
  - Tests mới: pure C.17–C.21 (+23), effective-policy 18→21 (dup-key BLOCKED), runtime 6→11 (R.1–R.5 qua processPr mock io); I.17 cập nhật "add approved duy nhất sau guard gates".
- **Gates**: verify **53/53**; test **149/149**; integration orchestrator 73/73; CI dispatch run **32628272515 SUCCESS** tại `8a20180`.
- **Bàn giao**: `[CLINE-FIX-045]` comment PR #4 (issuecomment-5385126577); nhãn `agent:gpt` + `status:review-requested`; PR body HEAD SHA `8a20180`.
- **PR QLDA_DTXD#42**: commit `2854dec` pin canonical → `8a20180`/`2026-08-23.6` (`.github/project-review-policy.json` ref+pinnedVersion + `verify.yml` checkout SHA); verify 14/14 PASS; CI run **32629851965 SUCCESS**; comment bàn giao (issuecomment-5385212521) ĐÃ ĐĂNG.
- **BLOCKER (Mức 3) — nhãn #42 bị orchestrator reset**: mọi edit nhãn thủ công (`agent:gpt`+`status:review-requested`) bị override tức thì về `agent:cline`+`status:changes-requested`. Nguyên nhân: #42 pin canonical `8a20180` nằm trên PR #4 (AI_PR_REVIEWER) **CHƯA MERGE** → orchestrator pre-review #42 không resolve được policy canonical → fail-closed duy trì `changes-requested`. **Cần Bố merge PR #4 (AI_PR_REVIEWER) trước**, sau đó #42 mới pre-review được và tự bàn giao GPT.


## 23/08/2026 14:35 (ACT) — GitHub task intake: Issue #1 echo marker ✅ BÀN GIAO PR #7
- **Nguồn**: `github-task-intake.mjs` tìm đúng 1 Issue `agent:cline + status:ready-for-cline` (#1 "[TEST] Dry-run orchestrator đóng vòng"); claim PASS qua preflight (`CLAIMED`, main @ `42906da`, clean tree).
- **Chướng ngại đã xử lý**: checkout main bị chặn bởi memory-bank dirty lệch branch → backup 2 file ra `%TEMP%\mb-backup-20260823-142950`, restore, checkout main, khôi phục nội dung (không stash/reset tự ý).
- **Thực thi**: nhánh `chore/issue-1-echo-marker-test`; tạo `scripts/test-echo-marker.mjs` (3 dòng, in `AUTONOMOUS_TEST_OK`, exit 0); commit `762df51` push.
- **Gates**: node script trực tiếp PASS exit 0; pnpm verify 46/46; pnpm test 126/126; CI check `verify` PASS tại HEAD.
- **Bàn giao**: Draft PR #7 → ready for review, body tick Ready; Issue #1 label → `status:review-requested`. Orchestrator tự pre-review → GPT.
- **Telegram**: lệnh `[NEW]#558` "Không ngủ đông" → đã reply xác nhận + `watchdog-hibernate.mjs --cancel` + `--heartbeat` (watchdog hủy theo chỉ thị Bố).

## 23/08/2026 11:52 (ACT) — Fix [GPT-REV-044] canonical identity enforcement ✅ BÀN GIAO LẠI GPT
- **Finding**: [GPT-REV-044] project config có thể đổi `policySource.repo/path` sang repo/path khác, bypass SSOT.
- **PR AI_PR_REVIEWER#4 — commit `14533bb`** (3 files, +107/−3) trên `chore/policy-sync-reviewer-phases`:
  - `.github/ai-review-policy.json`: thêm `canonicalRepo: "duongpdddic-droid/AI_PR_REVIEWER"`, `canonicalPath: ".github/ai-review-policy.json"` trong `projectPolicyContract`.
  - `scripts/effective-policy.mjs`:
    - `resolveEffectivePolicy`: validate identity từ contract; project config `repo`/`path` (nếu có) **bắt buộc trùng khớp** identity; khác → `BLOCKED_CANONICAL_INVALID`; contract thiếu identity → `BLOCKED_CANONICAL_INVALID`.
    - `resolvePolicyForRepo`: self-review enforce identity; project repo dùng hằng số `CANONICAL_REPO`/`CANONICAL_PATH` (không lấy từ project config).
  - Tests: +7 asserts identity enforcement → **18/18 PASS**.
  - Verify: verify 53/53; test 126/126; integration 73/73 + 50/50 + 6; CI verify PASS (run tại HEAD 14533bb).
  - Bàn giao: `[CLINE-FIX-044]` (issuecomment-5384294303).
- **PR QLDA_DTXD#42** (commit `ea841f1`): đã đóng [GPT-REV-043]; đợi #4 đóng [GPT-REV-044] → cập nhật pin nếu cần → CI → bàn giao cùng.
- **Trạng thái**: chờ orchestrator pre-review → GPT review cuối cả hai PR. Sau approval: Bố quyết merge.

## 23/08/2026 11:39 (ACT) — Fix [GPT-REV-042]+[GPT-REV-043] canonical-SSOT blocker ✅ BÀN GIAO LẠI GPT
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
