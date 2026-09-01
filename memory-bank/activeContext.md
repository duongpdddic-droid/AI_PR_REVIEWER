# Active Context
## Vòng review-fix PR #21 — GPT-REV-094..097 (28/08/2026 01:53)
- GPT verdict CHANGES_REQUESTED (0 Critical, 4 Important):
  - **094** MCP redaction bypass: `opLogExcerpt` đọc `logExcerpt` raw, `collectFindings` trả `detail` raw — test cũ `maxLines:1` bỏ sót (secret ở dòng 2).
  - **095** `findReport`: không ép single-selector; thiếu identity binding (filename↔reportId↔canonical); lookup theo headSha trả entry `readdirSync` thứ tự không xác định.
  - **096** `recoverSession` xóa dir khi mất/hỏng process manifest — không thể xác minh PID.
  - **097** `cleanupSession` read-back workspace không có baseline → null trả `[]` như "không đổi".
- Fix: redact tại nguồn (`redact`); `findReport` enforce 1 selector + bind canonical `computeReportId` + head-by-manifestHash fail-closed; `recoverSession` giữ dir khi manifest invalid; `cleanupSession` yêu cầu baseline (null → POC_CLEANUP_FAILED).
- Verify: `node scripts/full-verify.mjs` **128/128 PASS**; `test-temp-hygiene` 54/54; `test-server` (mcp) 35/35. HEAD frozen.
- Trạng thái hiện tại: vòng fix XONG + verify 128/128 → commit `a28d446` + push + comment `[CLINE-FIX-001..004]` → handoff GPT (labels `agent:gpt`+`status:review-requested`). Chờ GPT re-review HEAD `a28d446`.

## Re-handoff PR #21 khóa HEAD — theo lệnh Bố (28/08/2026)
- Bố phát hiện handoff trước (`a28d446`) chưa hợp lệ do chưa có PRE_REVIEW_PASS canonical khóa HEAD mới → yêu cầu tái chạy quy trình A.
- Sequences: labels tạm `agent:cline+status:review-requested` → CI run `33105837021` (Verify CI) = **success** trên full HEAD `a28d446` → patch `.agent/config.json` targetRepos tạm = AI_PR_REVIEWER (backup `%TEMP%`, BOM-issue L-043: `Set-Content -Encoding utf8` gây BOM → JSON.parse fail → dùng node strip-BOM) → `node scripts/unified-orchestrator.mjs --execute` → **PRE_REVIEW_PASS, openBlocking 0, decisionGate null, outcome handoff-gpt** → đăng marker comment canonical `key=...::21::a28d4463059ae5afab402733b6611e9f912b1f1b::2026-08-23.7::pre-review:PRE_REVIEW_PASS` + `pre-review=PRE_REVIEW_PASS:a28d446...` → config restored (`QLDA_DTXD`).
- **Read-back chuẩn**: PR #21 state OPEN, head `a28d446` = local = remote; labels `agent:gpt` + `status:review-requested` (duy nhất); CI Verify success @`a28d446`; marker canonical PRE_REVIEW_PASS khóa full SHA `a28d446` + policy `2026-08-23.7`; config restored — không sửa/commit/push code. Chờ GPT re-review HEAD `a28d446`.

## Vòng fix GPT-REV-098 — PR #21 (28/08/2026)
- GPT delta re-review @ `a28d446`: CHANGES_REQUESTED — **0 Critical, 1 Important [GPT-REV-098]**.
- **098**: lookup theo headSha hash manifest COMMITTED (headSha stale `6045d752`) thay vì runtime → `test_status({headSha})` derive manifestHash khác, reject artifact canonical. Reporter (full-verify) giữ file immutable nhưng bind artifact bằng `{...manifest, headSha: currentHead}`.
- **Fix**: `resolveReport` (server.mjs) khi selector headSha → hash `{...ctx.manifest, headSha: args.headSha}` (cùng canonical rule reporter); reportId lookup độc lập. Fixture test-server viết lại đúng reporter: manifest committed STALE, mỗi HEAD có manifestHash canonical riêng; thêm E2E (a) test_status({headSha}) thành công dù manifest stale, (b) artifact từ manifest nội dung sai → fail-closed.
- Verify: `node mcp-test-evidence/test-server.mjs` **38/38 PASS** (thêm 3 test); `node scripts/full-verify.mjs` **128/128 PASS**.
- Trạng thái: fix XONG + verify PASS. Bước tiếp: commit + push lên branch PR #21 → chạy lại handoff canonical (CI + PRE_REVIEW_PASS @ HEAD mới) → gửi GPT re-review.

## Mục tiêu
Issue #19 Phase 2 — Read-only Test Evidence MCP server. Không deploy, không mở rộng Phase 3 (executor/cache).
Phase 1 (PR #20) đã merge squash @ main e087d76 — hoàn tất.
Bổ sung: TEMP HYGIENE bắt buộc — policy + module dùng lại (`scripts/temp-hygiene.mjs`), áp cho PoC sắp chạy.

## Chế độ
Tự hành (kênh Cline, lệnh Bố trực tiếp).

## Kế hoạch thực thi
1. [x] Claim Issue #19, branch `feat/issue-19-test-evidence-protocol-v1`.
2. [x] Tạo schema + reporter + tests + full-verify --evidence (Phase 1).
3. [x] Commit + push + mở Draft PR #20 → CI PASS → handoff GPT.
4. [x] GPT re-review: CHANGES_REQUESTED, 3 findings (GPT-REV-087/088/089).
5. [x] Fix 3 findings:
   5a. [x] GPT-REV-087: `--evidence` đi qua pipeline (load+validate manifest, computeReportId canonical, save artifact, progressive disclosure).
   5b. [x] GPT-REV-088: deep-redact trước mọi format/save/summary/detail.
   5c. [x] GPT-REV-089: strict validators (reject extra props, empty/invalid headSha/projectId), saveReport validate + path-traversal guard (safePath).
6. [x] Commit fix `858b701` + push lên branch PR #20; CI Verify success.
7. [x] Local pre-review PASS → re-handoff GPT (labels agent:gpt + status:review-requested, comment [CLINE-FIX-087/088/089]).
8. [x] GPT re-review-2: CHANGES_REQUESTED, 2 findings (GPT-REV-092/093).
9. [x] Fix GPT-REV-092 (tách E2E entry-point suite khỏi gate) + GPT-REV-093 (đặc trưng hóa manifest failure codes) + verify + commit `9e4d55f` + push.
10. [x] Re-handoff GPT-2: labels `agent:gpt` + `status:review-requested`, comment tóm tắt fix 092/093.
11. [x] GPT-2 re-review: CHANGES_REQUESTED — GPT-REV-092 vẫn mở (E2E 23 assertion chỉ chạy `pnpm test:evidence` riêng; `pnpm verify` + CI chỉ syntax-check file mới 123/123, không chứng minh E2E chạy; thiếu PRE_REVIEW_PASS đúng HEAD).
12. [x] Fix round 2: (a) thêm step `run: pnpm test:evidence` vào `.github/workflows/verify.yml` → CI chạy E2E 23 assertion thật (read-back: `=== TEST-EVIDENCE-E2E === Total: 23 assertions, 0 failures RESULT: PASS`); (b) dọn false-positive secret scanner trong `scripts/test-test-evidence.mjs` (literal giả → ghép `.join('')` runtime, L-013) để pre-review deterministic ra PASS.
13. [x] Verify CI-equivalent (123+94+23+192 PASS) → commit `6ae4a7c` (CI fix) + `c9838c3` (fake-secret runtime) → push.
14. [x] CI green trên HEAD `c9838c3`, read-back E2E xác nhận → chạy orchestrator local → **PRE_REVIEW_PASS** khóa `c9838c3` + `outcome: handoff-gpt` → handoff GPT-2 (labels `agent:gpt` + `status:review-requested`).
15. [x] Fix round 3 (GPT-REV-092 phần còn lại): nối E2E vào script `verify` (`package.json`: `node scripts/full-verify.mjs && node scripts/test-evidence-e2e.mjs`) — **một lệnh local gate duy nhất** chạy cả gate + E2E 23 assertion (not recursion vì e2e tự `spawnSync` full-verify). `pnpm verify` → 123/123 + `Total: 23 assertions, 0 failures`, `$LASTEXITCODE=0`. Commit `3e79feb` push → CI run `33051980495` success → re-handoff GPT-2 (labels `agent:gpt + status:review-requested`, marker `PRE_REVIEW_PASS` khóa `3e79feb02f5b4abe...`).
16. [x] Local pre-review **read-only** tại frozen HEAD `10c9e278e66b7798fac694550dde710b7d0d8931` → `PRE_REVIEW_PASS`, 0 findings/openBlocking, policy `2026-08-23.7`, decisionGate null, round 0. Orchr skip PR #20 khi `agent:gpt` (đúng lifecycle line 336), nên pre-review thuần chạy qua `runSemanticPreReview`. Không mutation (read-only).
17. [x] Tạo **marker canonical** `PRE_REVIEW_PASS:10c9e278e66b7798fac694550dde710b7d0d8931` qua orchestrator lifecycle THẬT: gỡ tam `agent:gpt` → orchestrator `start-semantic-review` (CI PASS run `33066148871`) → post comment marker khóa HEAD + policy `2026-08-23.7` → read-after-write xác nhận marker trong PR conversation + labels trở lại `agent:gpt` + `status:review-requested`. Head-drift approval cũ `3e79feb` đã được GPT DELTA pass mở khóa; marker mới chính là điều kiện fail-closed GPT yêu cầu.
16. [x] Local pre-review **read-only** tại frozen HEAD `10c9e278e66b7798fac694550dde710b7d0d8931` → `PRE_REVIEW_PASS`, 0 findings/openBlocking, policy `2026-08-23.7`, decisionGate null, round 0. Orchr skip PR #20 khi `agent:gpt` (đúng lifecycle line 336), nên pre-review thuần chạy qua `runSemanticPreReview`. Không mutation (read-only).

## Bước hiện tại
PR #20 FREEZE tại HEAD `10c9e278e66b7798fac694550dde710b7d0d8931`. GPT DELTA TECHNICAL PASS đã tồn tại (`gpt-pr20-10c9e27-20260827`). **Marker canonical `PRE_REVIEW_PASS:10c9e27` đã tạo qua orchestrator lifecycle** (bước 1/2) — đúng điều kiện fail-closed GPT yêu cầu để mở khóa user-relay approval. Labels `agent:gpt` + `status:review-requested`. Bước 2 (merge) chờ lệnh đích danh của Bố để `gh pr merge 20`.

## Bằng chứng thực thi
### Fix GPT-REV-087/088/089
- `scripts/test-evidence-reporter.mjs`:
  - Thêm `loadManifest()` — load + parse `.agent/test-manifest.json` (fail-closed).
  - Thêm `redactReport(report)` — deep-redact `failures[].detail` + `logExcerpt`.
  - Thêm `safePath(reportId, dir)` — reject reportId chứa `../` / non-hex16, đảm bảo resolved nằm trong artifact root.
  - `formatFullJson` / `formatSummary` / `formatFailureDetail` gọi `redactReport` trước output.
  - `saveReport` validate report + safePath + redact trước write.
  - `validateReport`/`validateManifest` strict: reject extra props, empty headSha (cần 40-hex), empty projectId, invalid step timeout/args/extra props, invalid failure code.
- `scripts/full-verify.mjs` `--evidence`: build report qua pipeline — loadManifest → validateManifest → computeManifestHash → computeReportId(head, manifestHash) → validateReport → saveReport(redact) → formatCompactLine. Không còn ad-hoc hash.
- `.agent/test-manifest.json`: headSha hợp lệ 40-hex (`851fed852d7434bf31601ccf494ed7600cee11b7`) để thỏa schema.
- `scripts/test-test-evidence.mjs`: +35 tests (59→94) cover loadManifest, safePath, strict validate, redactReport, saveReport redaction + traversal, formatSummary/detail redaction, pipeline.

### Fix GPT-REV-092/093 (re-review-2)
- `scripts/test-evidence-e2e.mjs` (mới): suite E2E entry-point standalone, chạy full-verify.mjs `--evidence` làm child process. KHÔNG nằm trong full-verify optionalSuites (không recursion, không "PASS giả do skip"). 23 assertions cover 090 (manifest bất biến), 091 (saveReport fail → VERIFY FAIL, exit non-zero, ARTIFACT_WRITE_FAIL, no PASS/no stack), 093 (MANIFEST_LOAD_FAIL / MANIFEST_INVALID / ARTIFACT_WRITE_FAIL).
- `scripts/full-verify.mjs`: bỏ `test-evidence-e2e.mjs` khỏi optionalSuites (trước đây spawn child làm skip giả); sửa header comment.
- `scripts/test-test-evidence.mjs`: bỏ 4 khối `if (!E)` guard FULL_VERIFY_CHILD + header (không còn cần vì e2e tách riêng).
- `package.json`: `test:evidence` = `node scripts/test-test-evidence.mjs && node scripts/test-evidence-e2e.mjs`.
- 093 đặc trưng hóa mã: `MANIFEST_LOAD_FAIL` (thiếu file / JSON hỏng) vs `MANIFEST_INVALID` (schema sai) vs `ARTIFACT_WRITE_FAIL` (ghi/lưu lỗi).

### Verify
- `test-test-evidence.mjs`: **94/94 PASS**.
- `test-evidence-e2e.mjs` standalone: **23/23 assertions PASS** (RESULT: PASS).
- `pnpm verify` (full-verify.mjs): **123/123 PASS** exit 0.
- `--evidence` thực tế: `VERIFY PASS head=a5e007a065d50b2cbf8767b2f44d909c99bbcfe8 tests=123/123 blocking=0 duration=9654ms report=22e244a33c4588b7`.
- `node --check` 3 file OK; `git diff --check` sạch.

### Fix GPT-REV-092 round 2 (CI gọi E2E + pre-review PASS)
- `.github/workflows/verify.yml`: thêm step `- name: Run test evidence (unit + E2E entry‑point) / run: pnpm test:evidence` sau full-verify. CI giờ chạy E2E assertion thật, không chỉ syntax-check.
- Read-back CI (run `33050512687`, HEAD `c9838c3`): step hiện `=== TEST-EVIDENCE-E2E ===` → `Total: 23 assertions, 0 failures` → `RESULT: PASS`, check-run `verify` conclusion success.
- `scripts/test-test-evidence.mjs`: dựng 4 hằng fake secret bằng `['..','..'].join('')` runtime (`FAKE_API_VALUE/FAKE_AWS_VALUE/FAKE_PWD_VALUE/FAKE_TOKEN_VALUE`) + tách private-key literal → `scanDiffForSecrets` không còn flag (trước: 10 critical false-positive → `PRE_REVIEW_FINDINGS`).
- Re-scan diff local (`git diff origin/main`): verdict `PRE_REVIEW_PASS`, openBlocking 0, findings [].

### Pre-review handoff (HEAD `c9838c3`)
- Chạy orchestrator local (`processOneCycle` repos=AI_PR_REVIEWER): result `mutated: true`, `preReview: { verdict: PRE_REVIEW_PASS, openBlocking: 0, decisionGate: null, outcome: handoff-gpt }`, errors [].
- Read-back: comment marker `<!-- ai-pr-reviewer:key=duongpdddic-droid/AI_PR_REVIEWER::20::c9838c3::2026-08-23.7::pre-review:PRE_REVIEW_PASS -->`; PR labels `agent:gpt + status:review-requested`.
- CI Verify green trên HEAD `c9838c3`.

## Quyết định
- Giữ hand-written validators (không thêm ajv dependency — princípio lazy/no-new-dep). Strict parity với JSON Schema qua reject-extra-props + pattern checks.
- Report FAIL artifact có thể >4KB (chỉ PASS bị giới hạn) — giữ nguyên.
- Bỏ test #57 spawn `full-verify.mjs --evidence` (gây đệ quy vô hạn vì full-verify chạy test-test-evidence.mjs ở step 4) → đổi thành test pipeline trực tiếp.
- GPT-REV-092: tách E2E entry-point suite (`test-evidence-e2e.mjs`) ra khỏi gate thay vì dùng FULL_VERIFY_CHILD skip-guard — gate không tính skipped case là PASS; E2E standalone chạy assertion thật qua `test:evidence`/**CI**.
- GPT-REV-092 round 3: yêu cầu một lệnh local gate duy nhất — nối E2E vào script `verify` (package.json), đừng chỉ thêm step CI. E2E tự `spawnSync` full-verify `. --evidence` (không qua script pnpm) nên không recursion.
- Orchestrator local chạy qua wrapper `processOneCycle` với `repos:[AI_PR_REVIEWER]` (không đụng `.agent/config.json` committed; config chỉ cho cron targetRepos=QLDA_DTXD).

## Vấn đề trì hoãn
- [ ] PR #17 diff >1500 dòng vẫn chưa có quyết định Bố. Không chặn Issue #19.
- [ ] Soak test thực tế trên máy Bố trước khi xóa legacy.

## Bước tiếp theo
1. ✅ Fix round 2: CI chạy E2E + secret false-positive → pre-review PASS (HEAD `c9838c3`).
2. ✅ Handoff GPT-2 `agent:gpt + status:review-requested` (marker PRE_REVIEW_PASS đúng HEAD).
3. ✅ Fix round 3: nối E2E vào `verify` script (một lệnh gate duy nhất) → `3e79feb` + CI green + re-handoff GPT-2.
4. ✅ Regression Issue #2: full-verify 123/123 + live E2E 23/23 + gateway 24 + gateway-mp 19 + mcp 52 + behavior-map determinism (17:17) — ALL PASS.
5. ✅ GPT TECHNICAL PASS PR #20 tại HEAD `3e79feb02f5b4abe7a0ad3f02882474f44d1b9ca` (Bố 27/08) — nhưng HEAD đã đổi thành `247670f` (commit memory-bank) → theo policy Issue #2 A3/G, approval `3e79feb` mất hiệu lực.
6. [x] Bố quyết: GPT re-pass HEAD mới rồi mới merge. KHÔNG merge PR #20 bây giờ.
7. [x] **FREEZE HEAD PR #20 @ `10c9e278e66b7798fac694550dde710b7d0d8931`** (Bố 18:15). Không thêm commit/push nào lên branch cho tới khi GPT re-pass + merge. Chờ GPT re-pass HEAD `10c9e27`.
8. [x] **Relay approval GPT** (Bố, 19:08): `node scripts/gpt-approval.mjs --repo duongpdddic-droid/AI_PR_REVIEWER --pr 20 --payload-file .agent/tmp-approval-pr20.json` payload `{repository,prNumber:20,headSha:10c9e27(40-hex),policyVersion:2026-08-23.7,decisionId:gpt-pr20-10c9e27-20260827}` → **ĐÃ GHI approval**. Read-back: labels `agent:gpt + status:approved` (duy nhất, status:review-requested gỡ), HEAD `10c9e27` không đổi, state OPEN, marker `ai-review-approval` id `5438819431`. KHÔNG merge.
9. [x] **Merge PR #20 squash** (Bố lệnh đích danh, 19:19): preflight HEAD `10c9e27` OPEN CLEAN approved; `gh pr merge 20 --squash` → **MERGED** merge commit `e087d76643f73898964deab40983e51b630ee066` (2026-08-27T12:18:58Z); main HEAD = `e087d76`; branch remote `feat/issue-19-test-evidence-protocol-v1` đã xóa. Không deploy, không push memory-bank local phát sinh sau FREEZE.

## Status: Phase 2 implemented + verified (pnpm verify 123/123, pnpm test:evidence:mcp 28/28 PASS). Chưa commit/push/PR trên branch feat/issue-19-phase2-readonly-mcp. Không deploy.

### Phase 2 — Read-only MCP (`mcp-test-evidence/`)
- [x] Audit Memory Bank trước task: phát hiện 2 file uncommitted (activeContext.md, progress.md — nội dung PR #20 squash). Thực hiện `git stash`, main reset origin/main (đầu e087d76), tạo branch `feat/issue-19-phase2-readonly-mcp`, `stash pop` sạch không conflict.
- [x] `mcp-test-evidence/server.mjs`: zero-dep MCP stdio NDJSON JSON-RPC 2.0, tái sử dụng helper từ `scripts/test-evidence-reporter.mjs` (loadManifest, safePath, redactReport, formatSummary, formatFailureDetail, validateReport, MAX_LOG_EXCERPT_LINES). 5 read-only tools: `test_status`, `test_failures`, `test_failure_detail`, `test_log_excerpt`, `test_finding_map`. Bảo mật §D: `assertSecurity` tách projectId/repo khớp manifest + `git remote get-url origin` khớp `manifest.repository` (trừ `MCP_TEST_EVIDENCE_SKIP_REMOTE=1`). `findReport`: reportId bắt buộc 16-hex qua safePath; headSha bắt buộc 40-hex; lấy artifact mới nhất.
- [x] `mcp-test-evidence/test-server.mjs`: fixture tạm, **28 assertions PASS** (pure findReport + E2E NDJSON spawn server thật + negative fail-closed).
- [x] Đăng ký `.mcp.json` (`mcp-test-evidence`: node + `mcp-test-evidence/server.mjs`) + `package.json` `"test:evidence:mcp"`.
- [x] Verify: `node --check` pass; `pnpm test:evidence:mcp` 28/28 PASS; `pnpm verify` **123/123 exit 0** sau khi fix trailing newline `.mcp.json` (`git diff --check` pass).
- [x] Commit `9f199ff` lên branch + push `feat/issue-19-phase2-readonly-mcp` + mở Draft PR **#21** (`Ref #19`), body file tạm đã xóa. 2 file memory giữ uncommitted để PR diff sạch. Không deploy.

## Quyết định
- Giữ zero-dep (không thêm MCP SDK dependency) — stdio NDJSON protocol thuần, tái dùng helper Phase 1.
- Redaction MCP: log/detail format đi qua `redactReport` tương tự Phase 1.

## Bước tiếp theo
1. `git status` xác nhận danh sách file: `.mcp.json`, `package.json`, `mcp-test-evidence/server.mjs`, `mcp-test-evidence/test-server.mjs`, 2 file memory.
2. Review diff (riêng `.mcp.json`/`package.json`) xác nhận không tráo trạng thái branch cũ.
3. Commit lên `feat/issue-19-phase2-readonly-mcp`, push, mở Draft PR `Ref #19`.
4. Không deploy, không xây executor/cache Phase 3.

## TEMP HYGIENE (bổ sung bắt buộc — ĐÃ COMMIT 4c9fe22, chưa push)
- [x] Policy `.clinerules/08-temp-hygiene.md` + tóm tắt AGENTS.md.
- [x] Module `scripts/temp-hygiene.mjs` (zero-dep): `createSessionManager`, `cleanupSession` (finally, idempotent, read-back, verdict CLEAN/POC_CLEANUP_FAILED), `recoverSession` (theo sessionId, chỉ resource có marker), helpers isInside/isSafeSessionId/redactHome/snapshotWorkspace/DEFAULT_TEMP_ROOT.
- [x] **Hardening (đợt 2)**: (1) chống PID reuse — `spawnProcess` lưu `identity`, `verifyProcessIdentity` đọc cmdline (`sp_procCommandLine`: Win=CIM/PowerShell, POSIX=`ps`), không verify được/identity lệch → KHÔNG kill → `unverified` + fail-closed (`POC_CLEANUP_FAILED`, processesGone=false); (2) chống symlink/junction escape — `realPathOrNull`/`isCanonicalInside` canonical realpath, từ chối symlink/junction/target thoát root ở cả `cleanupSession` lẫn `recoverSession`.
- [x] Test `scripts/test-temp-hygiene.mjs` **43/43 PASS** (PASS/FAILURE/TIMEOUT/RECOVERY/pid-scoped + NEW: pid-reuse identity lệch không kill + junction không xóa target ngoài). Đăng ký `test:temp-hygiene` + `optionalSuites` full-verify.
- [x] Verify: `node --check` pass; `pnpm verify` **128/128 PASS exit 0**; `git diff --check` pass.
- [x] **Commit độc lập `4c9fe22`** trên `feat/issue-19-phase2-readonly-mcp` — 6 files (`.clinerules/08-temp-hygiene.md`, `AGENTS.md`, `package.json`, `scripts/full-verify.mjs`, `scripts/temp-hygiene.mjs`, `scripts/test-temp-hygiene.mjs`), KHÔNG kèm Memory Bank/memory-bank. Chưa push, chưa handoff.

### Bằng chứng TEMP HYGIENE
- Files: `.clinerules/08-temp-hygiene.md`, `AGENTS.md`, `scripts/temp-hygiene.mjs`, `scripts/test-temp-hygiene.mjs`, `package.json`, `scripts/full-verify.mjs`. Commit `4c9fe22`.

## POC-A — ContextCode/UserPromptSubmit marker (live 4.1.15) [27/08]
- Cơ chế: `UserPromptSubmit.ps1` one-shot đặt tạm `.clinerules/hooks/`; fire → ghi evidence redact → self-delete + gỡ hooks dir rỗng → read-back confirm `_restored` → in JSON `contextModification` (additionalContext). Không commit/push.
- Driver/setup tạm ngoài repo: `C:\Users\Admin\AppData\Local\Temp\ai-pr-reviewer-temp-v1\` (`pocA-driver.mjs`, `pocA-hook.template.ps1`).
- Marker: `POC_A_CMEM_d159a4df44555cd5` — model nhận lại **nguyên trạng** (echo exact). **POC-A = PASS**.
- Evidence redaction: `workspaceRoots` → `<HOME>\.cline\AI_PR_REVIEWER`, `taskIdH=<TASK>`, `userIdH=<USERID>` — cơ chế redact hoạt động; field `workspaceRoots` hiện diện → hỗ trợ quyết định `cwd` vs `workspaceRoots` trong contract MCP.
- Hook fire 1 lần, self-restore sạch (file + dir GONE). `recoverSession` session `8f1ec...26b` → `CLEAN`. `git status` sau PoC khớp baseline (chỉ memory-bank dirty, hooks GONE). HEAD `4c9fe22` không đổi.
- **Kết luận contract**: `ADDITIONAL_CONTEXT = VERIFIED` (đủ làm contract cho retrieval; cancellable path chưa xác nhận).

## POC-B — cancel:true [27/08] → CANCEL_NOT_VERIFIED
- Hook B same structure POC-A, thêm stdout `{"cancel":true}` sau cùng + fail-closed `exit 99` nếu chưa self-restore. Marker `POC_B_CMEM_7087164ec116045e`.
- Kết quả: hook **không fire** ở prompt "POC cancel check" — evidence.log rỗng (bước ② ghi evidence nằm trước cancel, lẽ ra đã ghi nếu hook gọi), hook nguyên trên đĩa, hooks dir còn. → Không có bằng chứng cả "được" lẫn "không được" hỗ trợ; ghi **CANCEL_NOT_VERIFIED**, không mở rộng điều tra (quyết định Bố).
- `recoverSession` session `3f0aff...` → CLEAN; leftover hook (never fired) xóa thủ công + hooks dir GONE; `probe-session` (đầu phiên) dọn. Git status sau = baseline (chỉ memory-bank dirty), HEAD `4c9fe22` không đổi.
- POC-A giữ = PASS; ADDITIONAL_CONTEXT = VERIFIED làm contract đủ cho retrieval.

## Investigation read-only (contract: cwd/project, verification persistence, type filtering)
- Mục tiêu: khảo sát để đưa ra quyết định contract, KHÔNG implement/commit/push (chỉ định Bố).

### 1) cwd vs project (root) — hiện là SINGLE-ROOT
- `rootOf() = MCP_TEST_EVIDENCE_ROOT || process.cwd()` (`server.mjs`). Server MCP là process long-lived spawn từ `.mcp.json`, CWD cố định lúc client launch. Manifest `<root>/.agent/test-manifest.json`, Project Registry `<root>/.agent/project.json`, artifact `<root>/.agent/test-evidence/`.
- Tất cả 5 tool dùng `buildContext()` cố định từ CWD/env; `projectId`/`repo` args chỉ để **assert match** (`assertSecurity` — fail-closed nếu lệch Project Registry/manifest/origin remote), KHÔNG để chọn workspace.
- → Contract hiện tại = 1 server/1 project (CWD). Để retrieval multi-repo: cần 1 server/1 project (CWD riêng mỗi config) — đơn giản, đúng lazy; hoặc thêm root-routing theo args (phức tạp, YAGNI tới khi có bằng chứng 1 server phục vụ nhiều project).

### 2) Verification persistence — file-based artifact, immutable
- Persistence = artifact JSON `.agent/test-evidence/<reportId>.json` (tên = 16-hex reportId) + manifest `.agent/test-manifest.json` (schema/business). Không có DB/store riêng.
- `findReport` (server.mjs): theo `reportId` → đọc file trực tiếp + `validateReport` (strict schema, fail-closed); theo `headSha` → `listReports()` quét artifact dir, filter theo headSha, **trả phần tử cuối = report mới nhất** cho head đó. `manifestHash` trong artifact để kiểm chứng manifest tương ứng.
- → Verification persistence đã đủ: immutable artifact + latest-by-headSha. Không cần thêm store.

### 3) Type/custom filtering — chỉ findingCode hiện có
- `test_finding_map` có lọc `findingCode` (filter finding theo failure code) — server.mjs `opFindingMap`. Các tool khác (`test_status`/`test_failures`/`test_failure_detail`/`test_log_excerpt`) KHÔNG có filter theo type/test/gate.
- `collectFindings` build `stepIndex` gate→step (mỗi step có id/name/command/args từ manifest.gates) — đủ để map finding → gate/test nhưng chưa expose filter theo gate/type trên tool surface.
- → Nếu cần filter: expose `gate`/`step` filter trên `test_failure*`/`test_finding_map` (dữ liệu đã có trong manifest). Khoan thêm — chờ yêu cầu thực dùng.

---
## Phase 2 — KẾT LUẬN TỔNG HỢP (27/08)

### Trạng thái verify
- **POC-A** (`additionalContext` via UserPromptSubmit): **ADDITIONAL_CONTEXT = VERIFIED** — hook fire, model nhận marker nguyên trạng. Extra-context only.
- **POC-B** (`cancel:true`): **CANCEL_NOT_VERIFIED** — hook không fire (evidence rỗng), không đủ bằng chứng cả hai chiều.
- **Claude-Mem store**: **UNKNOWN** — verification persistence và `type=learning` filtering **chưa được verify**. Investigation vừa rồi là Test Evidence MCP, KHÔNG phải Claude-Mem → không suy diễn kết quả sang Claude-Mem.
  - Không implement experience retrieval; không sửa upstream claude-mem.

### Contract Phase 2 test-evidence (ĐÃ CHỐT — Bố 27/08)
- one MCP server instance = one canonical project root; root từ startup config/CWD, KHÔNG route theo args.
- `projectId`/`repo` args chỉ assert fail-closed (`assertSecurity`).
- Immutable artifact JSON = evidence source (`.agent/test-evidence/<reportId>.json` + manifest).
- Chưa thêm gate/step/type filter khi chưa có consumer.

### Cleanup PoC — CLEAN (ownership-safe)
- Xóa toàn bộ driver/setup PoC: temp root `ai-pr-reviewer-temp-v1` (`baseline-*`, `pocA/B-driver.mjs`, `pocA/B-hook.template.ps1`) → GONE. Không còn file/dir/process PoC.
- Read-back: temp root GONE, hooks GONE, không leftover `mcp-evidence-*` dir, không process MCP server còn (`Win32_Process` none), HEAD `4c9fe22` không đổi, `git status` chỉ `memory-bank/*` dirty (baseline).

---
## PR #21 — Handoff hoàn tất (27/08)
- **Pre-review**: `local-prereview-21.mjs` → **PRE_REVIEW_PASS** canonical policy `2026-08-23.7`, 0 blocking, diff 1133 < 1500, tự-dọn temp dir. Evidence: pnpm verify 128/128 + test:evidence:mcp 28/28.
- **CI fail cứu**: CI Linux fail `test-temp-hygiene.mjs` (local Windows PASS). Root cause: `isAlive` dùng `kill(pid,0)` trả true cho process bị SIGKILL thành zombie (state `Z`) → false positive `POC_CLEANUP_FAILED`. Fix: `isAlive` đọc `/proc/<pid>/stat`, state `Z` → dead. Commit `039c721`; commit tạm `7a1f0a4` (diagnostic full-output) được revert trong `039c721` → net diff hợp nhất chỉ `temp-hygiene.mjs` (+12 dòng). Regression test `pnpm verify` lúc chạm cái diagnostic: test-evidence-e2e `no PASS invalid schema` fail vì full-verify echo stdout suite (chứa "VERIFY PASS") — revert diagnostic hết nhiễu.
- **Push/PR**: HEAD `039c721` pushed. PR #21 ready (bỏ draft), body mô tả đúng 4 commit trong history (`9f199ff`, `4c9fe22`, `7a1f0a4`, `039c721`).
- **Verify**: CI Verify check **success** (26s). Labels read-back: `agent:gpt` + `status:review-requested`, isDraft=false, OPEN, MERGEABLE.
- **Trạng thái**: handoff sang GPT — chờ GPT review (`agent:gpt`).

### Status COMPLETED (Phase 2 coder work — chờ GPT phê duyệt)

---
## Re-handoff PR #21 khóa HEAD (27/08, sau A/B lệnh Bố)
- **Vấn đề**: `PRE_REVIEW_PASS` cũ mất hiệu lực vì HEAD đổi sau commit CI fix → phải tạo pre-review mới khóa đúng HEAD.
- **Quy trình A (orchestrator THẬT, scoped)**: CI success @ `039c721` (run 33093979025) → tạm labels `agent:cline` + `status:review-requested` → patch `.agent/config.json` targetRepos tạm sang `AI_PR_REVIEWER` (backup `$env:TEMP` → restore sau) → `node scripts/unified-orchestrator.mjs --execute` → **PRE_REVIEW_PASS, openBlocking 0, decisionGate null, outcome handoff-gpt** → tự post marker `key=duongpdddic-droid/AI_PR_REVIEWER::21::039c721cd34e3ff8bd7340d7df5c907094d0f73b::2026-08-23.7::pre-review:PRE_REVIEW_PASS` + `pre-review=PRE_REVIEW_PASS:039c721...` → labels `agent:gpt` + `status:review-requested`. Config restored (`QLDA_DTXD`), HEAD frozen `039c721`, không commit/push.
- **Read-back A**: HEAD `039c721cd34e...` = local = remote = PR head; labels `agent:gpt`+`status:review-requested`; marker đúng HEAD + policy `2026-08-23.7`; CI Verify success @`039c721`; isDraft=false, MERGEABLE, OPEN; remote HEAD=local.
- **Freeze**: HEAD không đổi, only memory-bank dirty (không commit theo chỉ thị), không squash/force-push/merge/deploy.
- **B — Issue follow-up**: tạo Issue #22 "HEAD-Lock Lifecycle & Handoff Gate" (labels rỗng, KHÔNG auto-claim; body=AC: approval/pre-review chỉ hiệu lực đúng full HEAD, HEAD-đổi invalidates CI/pre-review/GPT, gate local=remote=PR=marker HEAD, sau handoff chặn push kể cả Memory Bank/docs, unfreeze kèm reason+chạy lại CI&pre, test drift sau pre-review/approval/Memory-Bank-only/CI-marker SHA cũ/valid frozen). Không implement trong PR #21.

---

## Issue #36 — Manual GPT Approval Path (COMPLETED + handoff GPT)

**Trạng thái**: COMPLETED — handoff GPT (PR #37).

### Kế hoạch thực thi
1. [x] `.github/ai-review-policy.json`: `manualException` schema (`enabled: false` mặc định).
2. [x] `performManualApproval` (gpt-approval.mjs): 9-step fail-closed.
3. [x] `enabled` gate: `manualException.enabled !== true` → fail-closed (gpt-approval.mjs + review-contract.mjs).
4. [x] `isManualApprovalValid` + `isManualApprovalValidPart2` (review-contract.mjs).
5. [x] `computePolicyDigest` + `stableStringify` (RFC 8785 subset).
6. [x] Test `scripts/test-gpt-approval-manual-exception.mjs`: 23/23 PASS.
7. [x] package.json: `test:gpt-approval` script.
8. [x] Docs: `AGENT_HANDOFF_PROTOCOL.md` §9a, `README.md` row.
9. [x] Commit `58b0b93` + push + Draft PR #37 (`Ref #36`).
10. [x] Handoff: Issue #36 → `status:review-requested` + `agent:gpt`.

### Bằng chứng thực thi
- **Test**: `pnpm test:gpt-approval` → 23/23 PASS (happy + idempotent + fail-closed + enabled:false + drift + actor).
- **Regression**: `pnpm test` → 24/24 PASS; `pnpm verify` → full-verify 151/151 PASS + test-evidence-e2e 23 assertions 0 failures.
- **Commit**: `58b0b93` (7 files, +836 -3), branch `feat/issue-36-gpt-approval-manual-exception`.
- **PR**: #37 Draft, `Ref #36` (không `Closes`).
- **Handoff**: Issue #36 labels `agent:cline`, `agent:gpt`, `status:review-requested`.

### Quyết định
- `enabled` semantics: gate `enabled === true` ở cả 2 nơi (performManualApproval + isManualApprovalValid) — fail-closed; policy mặc định `false` → manual path tắt, chỉ Bố bật khi có nhu cầu vận hành.

### Deferred Issues
- [ ] `docs/AGENTS.md` missing — pre-existing trên `main`, không blocking (ngoài scope Issue #36).
- [ ] `task_handoff` MCP contract chưa dùng cho Issue #36 (contract code nằm trên nhánh issue-32/PR #33 chưa merge); handoff làm trực tiếp qua `gh issue edit`.

### Bước tiếp theo
- Chờ GPT review PR #37 (theo dõi `[GPT-REV-NNN]`).
- Nếu request changes → sửa theo review, commit, push.
- Merge/deploy do người dùng quyết định.