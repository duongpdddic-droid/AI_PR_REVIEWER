# Progress (AI_PR_REVIEWER)

## 23/08/2026 09:05 — Vòng fix [GPT-REV-039] trên PR #4 — COMPLETED (chờ GPT re-review)

- [x] GPT re-review #4 tại `c1fe477` phát 039 Important: policy khai báo steady-state tự kích hoạt khi hai PR merge, runtime wiring chưa tồn tại, tests chỉ check khóa JSON.
- [x] Chọn phương án (2): PR #4 giữ là contract trung gian; steady-state chỉ kích hoạt sau PR wiring thứ ba được GPT duyệt + merge (acceptance criterion bắt buộc Issue #2).
- [x] Commit `f2abe470609f67612fb93295e7f55772de13440f`: policy `.4` (`runtimeWiringPrRequired`, `appliesAfter`, `activationRequires`), protocol §1a, test P6 → 33/33; verify 47/47; test 126/126; CI PASS.
- [x] Đồng bộ QLDA_DTXD#42 `64fa3db`; comment `[CLINE-FIX-039]` + labels agent:gpt/review-requested cả hai PR; notify SENT exit 0.
- Trạng thái: chờ GPT re-review #4 (`f2abe47`) + QLDA#42 (`64fa3db`). Sau approval + merge: PR wiring runtime (thứ ba) — điều kiện đóng Issue #2.


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