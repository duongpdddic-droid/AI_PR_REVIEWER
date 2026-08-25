# Progress (AI_PR_REVIEWER)

## 25/08/2026 09:35 — Issue #9 REV-2: fix 3 finding GPT review PR #10 — COMPLETED (chờ review vòng 2)

- [x] [GPT-REV-060]: `overBudget` fail-closed cho mọi trường hợp vượt (`compactTranscript`, `selectiveLoad`); test âm §9–§11 → 11 PASS.
- [x] [GPT-REV-061]: `redactDeep()` đệ quy + guards (depth/cycle/node); `recordExecutionEvent` redact mọi giá trị; regex Bearer trần; test §11–§13 → 13 PASS.
- [x] [GPT-REV-059]: default IO fs thật (`fsJsonlIo`) + cấm stored giả; `runtime-hooks.mjs` facade; wire vào `autonomous-run.mjs` (coder bounded recovery, verify telemetry, observation, consolidate); integration `test-runtime-hooks.mjs` 7 PASS.
- [x] Audit matrix module-version 2 — sửa claim sai, thêm Runtime wiring section.
- [x] Verify: **full-verify 89/89 PASS exit 0**; smoke dry-run autonomous-run OK.
- [x] Commit `35b04cc` (code) + `4de5149` (memory bank); push `05e12cf..4de5149`; CI verify PASS tại HEAD `4de5149bf24a3b19d1fa6d135052e55747e7d0b5`.
- [x] Comment `[CLINE-FIX-059]/[CLINE-FIX-060]/[CLINE-FIX-061]` trên PR #10 (issuecomment-5404377568).
- [x] Labels PR read-back: `agent:cline` + `status:review-requested` tại HEAD mới (orchestrator sẽ pre-review lại). Không gửi Telegram riêng: idempotency key `…::done::review-requested` đã SENT vòng trước, orchestrator notify sau mutation của nó.
- [ ] CHỜ: pre-review + GPT review vòng 2 → approval qua `gpt-approval.mjs` (user-relay) → user merge.

## 25/08/2026 08:36 — Issue #9: agent harness selective upgrade → PR #10 bàn giao GPT review — COMPLETED (chờ review)

- [x] Triển khai primitive chọn lọc: `scripts/error-recovery.mjs` (taxonomy + `planRecovery` + telemetry redact/record/summarize), cùng các primitive context/memory theo audit matrix `docs/issue9-audit-matrix.md` (12 dòng mapping AC → impl/test/evidence).
- [x] 3 suite assert-based mới (28 case): `test-context-manager.mjs`, `test-memory-core.mjs`, `test-error-recovery.mjs`; đăng ký `optionalSuites` trong `full-verify.mjs`.
- [x] Fix 2 bug code thật: thứ tự guard `validateObservation()` (L-024); preserve-sau-redact trong `recordExecutionEvent()` (L-025).
- [x] Verify: unit 28/28 PASS; **full-verify 84/84 PASS exit 0**.
- [x] Commit `feat(harness): selective upgrade primitives B1/B2, C1-C5, D/G (Issue #9)` HEAD `05e12cf…`; push branch `feat/issue-9-agent-harness-selective-upgrade`.
- [x] PR #10 mở `Closes #9`, labels `agent:gpt` + `status:review-requested` (read-back remote OK); Issue #9 → `status:review-requested`; CI verify PASS tại HEAD.
- [ ] CHỜ: GPT review PR #10 → approval qua `gpt-approval.mjs` (user-relay) → user merge.


## 24/08/2026 23:59 — Merge PR #8 vào main (Issue #6 control-plane) — COMPLETED

- [x] Preflight trước merge: HEAD PR = `c1bfdbf…` khớp remote branch (0 commit mới); marker approval hợp lệ tại HEAD; CI SUCCESS; labels OK; `MERGEABLE`.
- [x] Mark ready for review (`gh pr ready 8`), HEAD không đổi.
- [x] Squash merge: commit `7a6dc7882da0c0d4ea6c815b1cc02601dc5c2b62`, mergedAt `2026-08-24T16:58:06Z`, state MERGED.
- [x] Xóa nhánh remote `feat/issue-6-context-modules-verify` sau khi xác nhận tree nhánh ≡ main (`git diff --stat` rỗng).
- [x] CI hậu merge: run "Verify CI" trên main tại `7a6dc78` — success/completed.
- [x] Local: checkout main + pull đồng bộ `7a6dc78`.
- [x] Issue #6 đóng COMPLETED: 25/08/2026 02:18 — `gh issue close 6 --reason completed` exit 0; read-back `state=CLOSED`, `stateReason=COMPLETED`, `closedAt=2026-08-24T23:58:16Z`, labels trống. Comment tổng kết #5403085760 đăng (mapping 19 AC → file/test + deliverables PR #8 + PR #47). closedByPRs rỗng (đúng — comment đã trỏ).

## 24/08/2026 23:40 — Review + APPROVE PR #8 (Issue #6 control-plane) — COMPLETED (chờ user merge)

- [x] Review độc lập toàn diff PR #8: 0 Critical/Important; 2 Suggestion không chặn.
- [x] `[CLINE-FIX-050]` commit `a8fb31b00cb6df98bbc615d6f140d68613cedd84`: `evaluateChecks` chấp nhận mảng phẳng `gh pr checks --json` (+3 assert). Root cause: shape mock-vs-real → mọi PR thật `CI=missing`.
- [x] `[CLINE-FIX-051]` commit `c1bfdbf9f028aa264a348d7fd973589cccb7346b`: `gpt-approval.mjs#listPrComments` trả rich objects cho provenance read-back. Trước đó approval không bao giờ hoàn tất.
- [x] Mỗi fix: `pnpm verify` 67/67 PASS + CI SUCCESS tại HEAD mới + pre-review marker `PRE_REVIEW_PASS` mới.
- [x] APPROVED qua `scripts/gpt-approval.mjs --payload-file` exit 0: HEAD `c1bfdbf`, policy `2026-08-23.7`, decision `gpt-relay-20260824-pr8-headc1bfdbf`; labels `agent:gpt` + `status:approved`; CI verify SUCCESS; secret scan 0 findings.
- [x] L-021 ghi consolidatedLearnings.md (mock-vs-real IO shape drift).
- [ ] CHỜ USER: merge PR #8 (vẫn draft); QLDA_DTXD E5/E6 chưa triển khai theo chỉ thị.

## 24/08/2026 10:36 — Merge PR #42 (Phần B Issue #2, QLDA_DTXD) — COMPLETED

- [x] PR #42 (`docs(issue-2): sync ai-review-policy 2026-08-23.7 + REV-ISSUE-2 handoff contract (phan B)`) merged vào `main` QLDA_DTXD via `gh pr merge --squash` (exit 0); `mergedAt:2026-08-24T03:34:28Z`.
- [x] GPT approved (decision `GPT-DEC-PR42-A9DDC24-20260824`; CI #125 `Verify code and data` SUCCESS) tại HEAD `a9ddc243fe3e0f60f8081bd4af74bc8a0097c029`. `[GPT-REV-047/050]` CLOSED.
- [x] main HEAD mới: `d7baff87bdfbba80beca8b5dd8cb06e18517811f`.
- [x] BOM fix (L-020): body ghi UTF-8 không BOM qua `.NET UTF8Encoding($false)`; read-back `isBOMbytes=False`.
- [x] Phần B Issue #2 hoàn tất tại QLDA_DTXD; Issue #2 tổng thể phụ thuộc Phần A (AI_PR_REVIEWER #4 đã merge tại `7262a86`, policy `2026-08-23.7`).


## 24/08/2026 — Vá lỗ hổng allowlist actor giả marker `agent:gpt` (GPT-REV-049) — COMPLETED (verify xanh sau corrective)

- [x] [GPT-REV-049] PR AI_PR_REVIEWER#4, commit `8f81c36` + corrective commit: `isApprovalValid` bắt buộc `authorLogin ∈ ctx.gptApprovers` fail-closed `UNAUTHORIZED_ACTOR`; policy `authority.gptApprovers: ["duongpdddic-droid"]`; thread `gptApprovers`/`localApprovers` qua `effectiveApproval`→`planPhaseActivation`/`planApprovalDrift`/`performApproval`; `validatePolicy` bắt buộc `gptApprovers`+`localApprovers` non-empty. Sửa JSON dư dấu phẩy + test param `approvers`→`gptApprovers` + marker thiếu `prNumber`.
- [x] Gates (thực tế): full-verify **53/53**; pure-logic **189/189**; approval-gate **53/53**; orchestrator **76/76**; runtime **20/20**; effective-policy **22/22**; review-phases **40/40** — TẤT CẢ PASS.
- [x] Bàn giao `[CLINE-FIX-049]` comment PR #4; nhãn `agent:gpt` + `status:review-requested`; PR body HEAD cập nhật tại HEAD mới. KHÔNG merge/deploy.
- Trạng thái: chờ GPT re-review #4.

## 23/08/2026 22:46 — Align approval pipeline to rich comment objects (GPT-REV-048) — COMPLETED (verify xanh)

- [x] Toàn bộ pipeline approval nhận RICH comment object `{id, user:{login}, created_at, body}`; fail-closed: marker body thuần không provenance bị từ chối.
- [x] Sửa `gpt-approval.mjs` duplicate-detection (spread `r.marker`); `unified-orchestrator.mjs` `hasMarkerFor` + `countReviewRounds` trích `.body`; `planPhaseActivation` xác thực GPT approval qua rich `wiringApprovalRecords`.
- [x] Tests cập nhật sang rich comments (C.4/C.5/C.19/C.20/C.22, approval-gate A.1–A.9, orchestrator I.7).
- [x] Gates: full-verify **53/53**; pure-logic **169/169**; approval-gate **50/50**; orchestrator **73/73**; runtime **20 asserts**; review-phases **40/40**; effective-policy **21 asserts** — TẤT CẢ PASS.
- [x] **Bàn giao [CLINE-FIX-048]**: commit `737774ab3d13943fb085189837d516c4152a81c4` (8 files, +147/−38) → push `chore/policy-sync-reviewer-phases`; remote PR #4 headRefOid khớp. PR body UTF-8 sửa lỗi `??` (read-back sạch); comment `issuecomment-5386953010`; nhãn `agent:gpt` + `status:review-requested`. CHƯA sửa PR #42; KHÔNG merge/deploy. Chờ GPT re-review.

## 23/08/2026 21:10 — Vòng fix [GPT-REV-046] activation authority — COMPLETED (chờ GPT re-review)

- [x] [GPT-REV-046] PR AI_PR_REVIEWER#4, policy bump `2026-08-23.7`: activation steady-state chỉ kích hoạt từ dữ liệu CÓ AUTHORITY — `getIssueComments` (author/id metadata) + `getPullState` (merged/merge_commit_sha/head.sha từ GitHub REST); pure `collectActivationRecords` + `planPhaseActivation` fail-closed (author∈allowedRecorders, wiringPr=expectedWiringPr, PR merged thật, 2 SHA khớp GitHub, GPT approval hợp lệ khóa head đã merge + policyVersion hiện tại, không mâu thuẫn marker); `resolvePhaseActivation` trong `processPr` — mọi sai lệch/lỗi IO → giữ transition.
- [x] Gates: verify **53/53**; test **169/169** (C.22 +21); integration approval-gate 50/50 + orchestrator + runtime 20 asserts (R.1–R.14); policy 40/40; mcp 51.
- [x] Bàn giao `[CLINE-FIX-046]` comment PR #4; nhãn `agent:gpt` + `status:review-requested`; PR body HEAD cập nhật.
- [!] Hệ lụy: canonical `.7` → pin `.6` của QLDA#42 thành VERSION_MISMATCH; #42 chờ #4 merge rồi bump pin (đúng luồng chờ canonical).
- Trạng thái: chờ GPT re-review #4. Không merge/deploy tự động.

## 23/08/2026 15:27 — Vòng fix [GPT-REV-045] steady-state runtime wiring — COMPLETED (chờ GPT re-review)

- [x] [GPT-REV-045] PR AI_PR_REVIEWER#4 commit `8a20180` (8 files +472/−21), policy bump `2026-08-23.6`: activation source máy đọc được (`steadyState.activationEvidence` issue-comment marker + `parseActivationComment` fail-closed); `processPr` route `planEscalationForPhase`, local approval chỉ khi đủ `evaluateSteadyApprovalGates` + read-after-write THẬT; `planApprovalDrift` nhận local approval hợp lệ (`steadyLocalApproval`); `resolveRebuttalOutcome` đủ 5 trường (+`expectedOutcome`); xóa duplicate keys + scanner `scanDuplicateObjectKeys` → `BLOCKED_POLICY_DUPLICATE_KEYS`.
- [x] Gates #4: verify **53/53**; test **149/149** (pure C.17–C.21 +23; effective-policy 21; runtime 11 asserts R.1–R.5); integration orchestrator 73/73 (I.17 cập nhật); CI dispatch run **32628272515 SUCCESS** tại `8a20180`.
- [x] Bàn giao `[CLINE-FIX-045]` comment PR #4 (issuecomment-5385126577); nhãn `agent:gpt` + `status:review-requested`; PR body HEAD SHA `8a20180`.
- [x] **QLDA_DTXD#42 pin sync hoàn tất**: commit `2854dec` cập nhật `.github/project-review-policy.json` (ref+pinnedVersion `8a20180`/`2026-08-23.6`) + `verify.yml` checkout SHA; verify 14/14 PASS; CI run **32629851965 SUCCESS**; comment (issuecomment-5385212521) ĐÃ ĐĂNG.
- [!] **BLOCKER (Mức 3)**: nhãn #42 bị orchestrator override về `agent:cline`+`status:changes-requested` (pin `8a20180` trên PR #4 chưa merge → orchestrator fail-closed). Cần Bố **merge PR #4 (AI_PR_REVIEWER) trước** rồi #42 mới pre-review + bàn giao GPT.
- Trạng thái: code+CI CẢ HAI PR xong; chờ Bố merge #4 để #42 thoát blocker.

## 23/08/2026 14:35 — GitHub task intake Issue #1 (echo marker) — COMPLETED (chờ pre-review + GPT)

- [x] Claim #1 qua `--claim` sau preflight PASS (`CLAIMED`, main @ `42906da`); chướng ngại checkout main do memory-bank lệch branch đã xử lý bằng backup/restore/khôi phục (backup: `%TEMP%\mb-backup-20260823-142950`).
- [x] `scripts/test-echo-marker.mjs` mới (in `AUTONOMOUS_TEST_OK`, exit 0) trên nhánh `chore/issue-1-echo-marker-test`, commit `762df51`.
- [x] Gates: script trực tiếp exit 0; pnpm verify 46/46; pnpm test 126/126; CI `verify` PASS tại HEAD.
- [x] PR #7 ready for review (`Closes #1`); Issue #1 → `status:review-requested`; orchestrator tự pre-review → GPT approval cuối.
- [x] Telegram `[NEW]#558` "Không ngủ đông": reply xác nhận + watchdog cancel/heartbeat theo chỉ thị Bố.

## 23/08/2026 11:52 — Vòng fix [GPT-REV-044] canonical identity enforcement — COMPLETED (chờ GPT re-review)

- [x] [GPT-REV-044] PR AI_PR_REVIEWER#4 commit `14533bb` (3 files +107/−3): `.github/ai-review-policy.json` thêm `canonicalRepo`/`canonicalPath` trong `projectPolicyContract`; `resolveEffectivePolicy` + `resolvePolicyForRepo` enforce identity — project config repo/path (nếu cung cấp) bắt buộc trùng khớp canonical identity; khác → `BLOCKED_CANONICAL_INVALID`; contract thiếu identity → `BLOCKED_CANONICAL_INVALID`; self-review cũng enforce.
- [x] Gates #4: test-effective-policy **18/18 PASS** (+7 asserts identity enforcement); verify 53/53; test 126/126; integration 73/73 + 50/50 + 6; CI verify PASS tại HEAD 14533bb.
- [x] Bàn giao `[CLINE-FIX-044]` issuecomment-5384294303.
- [x] [GPT-REV-042] commit `cc426b6` + [GPT-REV-043] commit `ea841f1` đã đóng; PR #42 đợi #4 đóng #44 → cập nhật pin nếu cần.
- Trạng thái: chờ orchestrator pre-review → GPT review cuối cả hai PR. Sau approval: Bố quyết merge.

## 23/08/2026 11:39 — Vòng fix [GPT-REV-042]+[GPT-REV-043] canonical-SSOT blocker — COMPLETED (chờ GPT re-review)

- [x] Xử lý [GPT-REV-040] (mirror policy trái kiến trúc) theo **Issue #5**: AI_PR_REVIEWER là SSOT duy nhất; QLDA chỉ giữ project config + pin; bỏ hợp đồng "mỗi repo giữ bản sao".
- [x] Commit `565f33a737edd4a066c7ad86e28629147c3837ba` (11 files): policy `.5` thêm `projectPolicyContract`; resolver `scripts/effective-policy.mjs` fail-closed (5 mã BLOCKED_*); orchestrator/gpt-approval đọc effective policy qua resolver; runtime helpers phase/escalation/6-gate/rebuttal/discovery (`resolveReviewPhase`, `planEscalationForPhase`, `evaluateSteadyApprovalGates`, `resolveRebuttalOutcome`, `planDiscoveryBehavior`) cắm vào `processPr` (policy/phase hỏng → status:blocked).
- [x] Tests mới: test-effective-policy.mjs (7), test-integration-review-runtime.mjs (6, gồm processPr fail-closed với mock io), P7 test-review-phases → 40/40.
- [x] Gates: verify 53/53; test 126/126; integration orchestrator 73/73 + approval-gate 50/50 + runtime 6. CI: workflow_dispatch run 32614761014 SUCCESS (check-run verify=success) tại HEAD `02290badac298903f394c6368159738c705cc199` (push không tự trigger pull_request run → đã thêm workflow_dispatch, commit `02290ba`).
- [x] QLDA_DTXD#42 đồng bộ tới `a82558c38f8d14072f688a6846fe5d8220ac95d0`: xóa mirror policy/protocol/test, project config pin full SHA `565f33a…`, stub protocol, CI checkout `_canonical`, test-project-policy 7 asserts; CI run 32614439094 PASS.
- [x] Bàn giao: comment `[CLINE-FIX-040]`+`[CLINE-FIX-039] cập nhật` (issuecomment-5383840754) + cập nhật HEAD (issuecomment-5383966816); PR body HEAD `02290ba`/`a82558c`; labels read-back agent:gpt + review-requested cả hai PR; Issue #5 claim → review-requested (comment issuecomment-5383885252).
- Trạng thái: chờ GPT re-review #4 + #42. Sau approval: Bố quyết merge.

## 23/08/2026 09:05 — Vòng fix [GPT-REV-039] trên PR #4 — COMPLETED (chờ GPT re-review)

- [x] GPT re-review #4 tại `c1fe477` phát 039 Important: policy khai báo steady-state tự kích hoạt khi hai PR merge, runtime wiring chưa tồn tại, tests chỉ check khóa JSON.
- [x] Chọn phương án (2): PR #4 giữ là contract trung gian; steady-state chỉ kích hoạt sau PR wiring thứ ba được GPT duyệt + merge (acceptance criterion bắt buộc Issue #2).
- [x] Commit `f2abe470609f67612fb93295e7f55772de13440f`: policy `.4` (`runtimeWiringPrRequired`, `appliesAfter`, `activationRequires`), protocol §1a, test P6 → 33/33; verify 47/47; test 126/126; CI PASS.
- [x] Đồng bộ QLDA_DTXD#42 `64fa3db`; comment `[CLINE-FIX-039]` + labels agent:gpt/review-requested cả hai PR; notify SENT exit 0.
- Trạng thái: chờ GPT re-review #4 (`f2abe47`) + QLDA#42 (`64fa3db`). Sau approval + merge: PR wiring runtime (thứ ba) — điều kiện đóng Issue #2.

## 23/08/2026 07:59 — Vòng fix [GPT-REV-036..038]: contract + discovery + reconcile — COMPLETED (chờ GPT re-review 2 PR)

- [x] GPT re-review PR #42 tại `7e9f251`: 035 CLOSED; 036 (reviewer-coder contract), 037 (minimal prompt + task discovery fail-closed), 038 (policy drift 2 repo + thiếu đường reconcile) — Important blocking.
- [x] QLDA_DTXD commit `da4aa82`: policy `2026-08-23.3` + `reviewerCoderContract` + `minimalCommandDiscovery`; protocol §6/§6a; AGENTS/clinerules; test P4/P5 → 29/29 PASS; verify 14/14; test 59; test:data PASS. Comment `[CLINE-FIX-036..038]`; labels agent:gpt + review-requested.
- [x] Reconcile: **AI_PR_REVIEWER#4** (`chore/policy-sync-reviewer-phases`, `c1fe477`) — policy `.3` đồng bộ (requiredChecks `"verify"`), protocol §1a/§6/§6a, test mirror 29/29, full-verify 47/47, pnpm test 126/126; ready + agent:gpt + status:review-requested.
- [x] Cross-repo evidence: cùng policyVersion `.3` + cùng 3 khối contract; khác duy nhất requiredChecks theo CI từng repo (scope note cho phép).
- Trạng thái: chờ GPT re-review #42 (`da4aa82`) + #4 (`c1fe477`). Sau merge: wiring orchestrator steady-state approval (PR thứ ba Issue #2) rồi mới đóng Issue.


## 23/08/2026 06:27 — Issue #2 phần B: fix [GPT-REV-035] trên PR QLDA_DTXD#42 — COMPLETED (chờ GPT re-review)

- [x] GPT review PR #42 phát [GPT-REV-035] (blocking): contract khóa GPT final reviewer vĩnh viễn, trái [USER-DECISION] hai giai đoạn sau Issue #2.
- [x] Commit `7e9f251f403dd6912c58d6540cfec75bd3bda202` (9 files, +247/−42) trên branch `chore/issue-2-review-policy`; push read-back khớp.
- [x] Policy `.github/ai-review-policy.json` bump `2026-08-23.2` + `reviewerPhases`: transition (GPT duyệt cuối hai PR triển khai, `localReviewerCanApprove:false`) + steadyState (`reviewer:local` mặc định, approve khi đủ 6 `approvalRequiresAllGates`, GPT chỉ escalation theo 5 `escalateToGptWhen`, fail-closed) + `invariantsAllPhases` 9 gate bất biến; giữ nguyên key validator `review-contract.mjs`.
- [x] Đồng bộ docs: protocol §1a mới (+§1/§3/§4/§5/§5a/§9/§10), `AGENTS.md`, `.clinerules/01` §13, PR template, gpt-task.yml — bỏ mọi câu "GPT final duy nhất vĩnh viễn".
- [x] Test mới `scripts/test-review-phases.mjs` (17 asserts: P0 policy hợp lệ / P1 local không thể approve giai đoạn transition / P2 steady-state đủ gate / P3 escalation fail-closed); cắm `full-verify.mjs` bước 4a3 → chạy trong required check "Verify code and data".
- [x] Gates: `pnpm verify` 14/14 PASS; `pnpm test` PASS (59 assertions); `pnpm test:data` PASS; `git diff --check` sạch; CI PASS tại `7e9f251f`.
- [x] Bàn giao lại: comment `[CLINE-FIX-035]` (kèm commit/files/test + ghi minh bạch wiring runtime thuộc PR orchestrator thứ hai), labels `agent:gpt` + `status:review-requested`, PR body cập nhật HEAD SHA mới.
- Known-drift: policy repo này còn `2026-08-23.1` — phải đồng bộ `2026-08-23.2` khi làm PR orchestrator tiếp theo của Issue #2. KHÔNG merge/deploy.

## 23/08/2026 06:00 — Issue #2 phần B: PR2 tại QLDA_DTXD đã bàn giao — COMPLETED

- [x] Đồng bộ main AI_PR_REVIEWER (`de9d6cc`, tree sạch); khảo sát đặc tả B1–B6 + CI QLDA_DTXD.
- [x] Branch `chore/issue-2-review-policy` từ `origin/main` QLDA_DTXD (`6db6dee`); commit `42eb69c` (7 files, +271/−132).
- [x] Thêm `.github/ai-review-policy.json` `2026-08-23.1` (requiredChecks = "Verify code and data" — tên check-run thật).
- [x] Rewrite `docs/AGENT_HANDOFF_PROTOCOL.md` REV-ISSUE-2; sync `AGENTS.md` + `.clinerules/01` §13 + PR/Issue templates + memory-bank progress (QLDA_DTXD).
- [x] Quality gates QLDA_DTXD: `pnpm verify` 13/13, `pnpm test` PASS (59 assertions), `pnpm test:data` PASS, `git diff --check` sạch (fix blank EOF trước commit).
- [x] PR duongpdddic-droid/QLDA_DTXD#42: OPEN non-draft, labels `agent:gpt` + `status:review-requested` read-back OK, body read-back OK, CI PASS 25s.
- [x] Local QLDA_DTXD trả về `main` (up to date origin/main) — không chiếm branch task.
- Dừng chờ GPT review theo lệnh; KHÔNG merge/deploy.

## 23/08/2026 05:22 — PR #3 MERGED + copy watchdog sang repo này — COMPLETED

- [x] Copy `scripts/watchdog-hibernate.mjs` từ QLDA_DTXD (chỉ phụ thuộc `./tg-notify-core.mjs` có sẵn + `~/.qldadtxd` dùng chung); `pnpm verify` 44/44 PASS; commit `955864e` push; CI PASS.
- [x] `node scripts/watchdog-hibernate.mjs --heartbeat` — exit 0 trong repo này.
- [x] PR #3: `gh pr ready` (trước đó còn draft) → `--merge` **theo chỉ thị trực tiếp của Bố** (không chờ GPT duyệt vòng fix 2) → state MERGED, mergeCommit `de9d6cc4cad578e1e8a96bf0e2d34563750e9a6c`.
- [x] Local `main` fast-forward `91e5871..de9d6cc` (+2352/−683, 24 files).
- Ghi chú: merge trước GPT approval là quyết định của Bố — quyền merge thuộc người dùng theo protocol.

## 23/08/2026 05:13 — Khôi phục kênh Telegram notify repo này — COMPLETED

- [x] Nguyên nhân FAIL exit 2: `notify-telegram.mjs` đọc config `~/.ai-pr-reviewer/tg.json` (không tồn tại), token thật nằm ở `~/.qldadtxd/tg.json`.
- [x] Fix: byte-copy nguyên file sang `~/.ai-pr-reviewer/tg.json` (không đọc/in nội dung — rule secret 04 §2).
- [x] Gửi lại event `done` (fix round 2 PR #3): **SENT** tới chat 816272951, exit 0, eventKey `...::done::status:review-requested` đã mark.
- [ ] Phát hiện mới (deferred): arm watchdog fail MODULE_NOT_FOUND — repo này thiếu `scripts/watchdog-hibernate.mjs`; notify vẫn SENT exit 0. Cần Bố quyết hướng xử lý.

## 23/08/2026 02:53 — Issue #2 PR1 vòng fix 2 (GPT-REV-031..034) — COMPLETED

- [x] 031: `evaluateDiffLimits` metric churn = additions+deletions; `runSemanticPreReview` trả `decisionGate='diff-limit'`; `planPreReviewOutcome({decisionGate})` → `block-decision-gate` + `status:blocked` (không handoff GPT, không trả Cline, không tăng round). Policy `diffLimits.metric` + `overLimitBehavior`. Test pure C.15/C.12, integration I.15.
- [x] 032: `gpt-approval.mjs` viết lại DI `performApproval`/`performRevoke` — bắt buộc `--payload` (hoặc --payload-file) ràng buộc repo/pr/full headSha/policyVersion/decisionId qua `validateApprovalPayload()`; marker thêm `decisionId`; không code path tự động gọi gate (test I.17 static+behavior). AGENT_HANDOFF_PROTOCOL.md ghi giới hạn xác thực.
- [x] 033: giao dịch an toàn — marker TRƯỚC → read-back verify (`effectiveApproval` khớp decisionId) → gỡ nhãn → approved SAU; mọi lệnh gh error-checked; `ensureNotApproved()` phục hồi; test `test-integration-approval-gate.mjs` A.1–A.9 inject lỗi từng bước.
- [x] 034: taxonomy canonical `critical|important|suggestion`; `SEVERITIES`/`DEFAULT_BLOCKING_SEVERITIES` export; `blockingSeverities=[critical,important]`; policy bump `2026-08-23.1`; docs AGENT_HANDOFF_PROTOCOL.md §6/§7 đồng nhất.
- [x] Quality gates: `pnpm verify` 42/42, `pnpm test` 126/126, `pnpm test:integration` 73/73+50/50, `git diff --check` sạch; CI `verify` SUCCESS trên GitHub tại HEAD `cd635d8`.
- [x] Bàn giao lại PR #3: 4 comment [CLINE-FIX-031..034], PR body cập nhật HEAD + bằng chứng, labels `agent:gpt` + `status:review-requested`. Dừng chờ GPT re-review.
- Bài học vòng 2: L-013 (PowerShell string replace backtick / jq collapsing; always read back after PR body edit), L-014 (mock `??` fallback nuốt null sentinel — dùng `=== undefined` để hỗ trợ null).

## 23/08/2026 01:05 — Issue #2 PR1: hợp đồng review mới (GPT final approval, local pre-review) — COMPLETED (code+test)

- [x] `scripts/review-contract.mjs` (mới): lõi thuần — evaluateChecks fail-closed (missing/unknown), planCiRouting (pass→`status:reviewing`, KHÔNG approve), planPreReviewOutcome (handoff-gpt/request-fix/block), approval marker khóa full HEAD SHA + policyVersion, planApprovalDrift, isStaleEvent/canMutatePr/mutationKey, normalizeStatusLabels (đúng 1 status:*), countReviewRounds, gateOpenFindings, scanDiffForSecrets, evaluateDiffLimits.
- [x] `scripts/unified-orchestrator.mjs` viết lại: DI io adapter; bỏ auto-approve từ CI PASS; bỏ tạo issue [review-fix]; read-before-mutation + read-after-write verify + tự chữa multi-status; chặn event muộn (headSha đổi giữa chừng, PR closed/merged); idempotency key `repo::pr::headSha::policy::action`; quét cả PR approved để bắt approval-drift.
- [x] `scripts/gpt-approval.mjs` (mới): cổng DUY NHẤT ghi approval GPT (`--note` / `--revoke`), kiểm chứng CI PASS + PRE_REVIEW_PASS tại đúng HEAD trước mutation.
- [x] `.github/ai-review-policy.json` (mới): policy canonical v1 `2026-08-22.1`.
- [x] `notify-telegram.mjs`: retry có giới hạn qua `withRetry` (tg-notify-core, 3 lần); giữ exit code 0/1/2.
- [x] Xóa helper reviewer-side chết trong `autonomous-core.mjs` (planRouting/fixIssue*/parseChecks*/findingsFromFailedChecks) theo A6/A8.
- [x] Tests: `test-pure-logic.mjs` viết lại 101/101 PASS; `test-integration-orchestrator.mjs` (mới, mock gh) 52/52 PASS — 14 kịch bản gồm happy-path, idempotency, fail-closed thiếu policy/checks, secret trong diff, drift, event muộn, read-after-write FAIL, dry-run 0 mutation.
- [x] Docs/config đồng bộ REV-ISSUE-2: AGENT_HANDOFF_PROTOCOL.md viết lại; AGENTS.md; .clinerules/01 §13; PULL_REQUEST_TEMPLATE.md (+HEAD SHA); .agent/config.json + reviewer-agent/reviewer.config.json (label reviewing + policy + finalReviewer/preReviewer); conventions-coder/reviewer.
- [x] Verify: pnpm test 101/101, pnpm test:integration 52/52, pnpm verify 39/39 — PASS. Bài học mới L-009…L-012 (PowerShell BOM/mojibake, idempotency nhánh con, dry-run guard).

## 22/08/2026 10:02 — Tạo Issue test handoff QLDA_DTXD#35 — COMPLETED

- [x] Tạo issue `test(e2e): kiem tra luong tu nhan viec va ban giao review giua 2 agent` — https://github.com/duongpdddic-droid/QLDA_DTXD/issues/35, labels `agent:cline` + `status:ready-for-cline`, body hướng dẫn: nhánh từ main → thêm dòng `<!-- e2e-agent-handoff-test -->` vào README.md → verify pass → Draft PR `status:review-requested`.
- [x] Verify read-back: OPEN, đúng title + 2 labels. Body ghi qua temp file UTF-8 no BOM (L-006).
- [x] Giữ nguyên issue (không đóng/cleanup) — chờ Cline QLDA_DTXD claim qua task intake.

## 22/08/2026 09:50 — E2E smoke orchestrator trên GitHub thật (PASS + FAIL) — COMPLETED

- [x] Tạo PR draft test `QLDA_DTXD#33` từ branch `test/smoke-e2e-orchestrator` (thay đổi doc thuần), nhãn `status:review-requested`; label được ensure tồn tại trước.
- [x] PASS path: dry-run nhận diện đúng → CI pass → `--execute` → `status:approved`, comment tổng kết đúng, rerun idempotent.
- [x] FAIL path: commit phá `Backend/Code.js` → CI fail → gắn lại `status:review-requested` → `--execute` → nhãn `agent:cline` + `status:changes-requested`, comment `[LOCAL-REV-001]` đủ schema, issue `[review-fix] PR #33 — vòng r1` (#34) labels agent:cline/status:ready-for-cline/review-fix, loop-breaker mới hoạt động.
- [x] Cleanup: đóng #34 + #33, xóa branch remote, xóa temp clone; worktree AI_PR_REVIEWER không đổi.
- [x] Phát hiện ghi nhận: search index delay của `gh pr list --label` (L-007) và PR approved-mất-nhãn-không-quét-lại (L-008, Deferred).

## 22/08/2026 09:31 — Hub review đa repo: dọn worktree + vòng lặp coder theo nhãn PR — COMPLETED

- [x] Gỡ gitlink mồ côi `QLDA_DTXD` (mode 160000) khỏi index → worktree sạch; commit `efb20ec`.
- [x] `planRouting` pass → `status:approved` (gỡ `status:review-requested`); quyền merge thuộc người dùng (bãi bỏ quyết định 21/08 20:42).
- [x] CI FAIL → comment PR kèm finding chuẩn `[LOCAL-REV-NNN]` (1 finding/check fail); helper mới `parseChecksJson`/`parseChecksOutput`/`classifyParsedChecks`/`findingsFromFailedChecks`; `checksDetail` ưu tiên `gh pr checks --json`, fallback text.
- [x] Sửa loop-breaker: issue `[review-fix]` không còn bảo coder thêm `agent:gpt` (orchestrator skip PR vĩnh viễn) → gỡ `status:changes-requested` + `agent:cline`, gắn lại `status:review-requested`.
- [x] `conventions-coder.md`: mục "Vòng review PR (label loop)" 7 bước; `reviewer.config.json` đồng bộ `labels` + `notifyTelegram`.
- [x] Verify: `pnpm test` 73/73; `pnpm verify` 32/32; smoke dry-run QLDA_DTXD exit 0. Commit `ed6eb79` (chưa push).
- Archive: `activeContext.md` cũ → `taskHistory.md`.

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
## 24/08/2026 22:54 — Issue #6 giai đoạn AI_PR_REVIEWER: PR #8 bàn giao CI PASS (context router fail-closed + 9 module + verify gates C2). pnpm verify 67/67; CI run 32747426537 SUCCESS @ 1056971a. Chờ GPT review; còn phần QLDA_DTXD (branch/PR riêng). Đồng thời: đóng #5 COMPLETED, #2 NOT_PLANNED (SPEC-SUPERSEDED), #6 claimed.
