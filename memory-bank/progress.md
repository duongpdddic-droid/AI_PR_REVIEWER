## 28/08/2026 00:19 — Re-handoff PR #21 khóa HEAD + Issue #22
- A: chạy orchestrator THẬT tạo PRE_REVIEW_PASS mới khóa đúng HEAD `039c721` (policy 2026-08-23.7, openBlocking 0), labels `agent:gpt`+`status:review-requested`, CI success, HEAD frozen.
- B: Issue follow-up #22 "HEAD-Lock Lifecycle & Handoff Gate" (labels rỗng, không auto-claim).
- Chi tiết: activeContext.md "Re-handoff PR #21 khóa HEAD".
## 27/08/2026 23:38 — PR #21 handoff hoàn tất
- Pre-review PASS, CI fail cứu zombie POSIX, push HEAD `039c721`, PR ready, handoff GPT.
- Chi tiết: activeContext.md mục "PR #21 — Handoff hoàn tất"; L-046/L-047.
- Trạng thái: `agent:gpt` + `status:review-requested`, chờ GPT phê duyệt.


# Progress

## 27/08/2026 22:22 — Phase 2 CONTRACT CHỐT + conformance verified (read-only, no code change needed)

- [x] PoC-A `additionalContext` (UserPromptSubmit): **VERIFIED** — hook fire, model nhận marker nguyên trạng.
- [x] PoC-B `cancel:true`: **CANCEL_NOT_VERIFIED** — hook không fire, thiếu bằng chứng cả hai chiều.
- [x] Claude-Mem store (verification persistence, `type=learning`): **UNKNOWN** — investigation chỉ là Test Evidence MCP, không phải Claude-Mem; không suy diễn.
- [x] Contract Phase 2 CHỐT (Bố): 1 server = 1 canonical root (startup config/CWD, không route args); projectId/repo chỉ assert fail-closed; immutable artifact JSON là evidence source; chưa thêm gate/step/type filter.
- [x] Conformance verified: `pnpm test:evidence:mcp` **28/28 PASS exit 0** — 5 read-only tools, fail-closed (Project Registry/reportId/path-traversal), redaction hoạt động. Server hiện tại khớp contract → **không thay đổi code** (YAGNI).
- [x] Cleanup PoC ownership-safe: temp root `ai-pr-reviewer-temp-v1` (driver/template/baseline) GONE; hooks GONE; không leftover process/session MCP. Read-back: HEAD `4c9fe22` không đổi, `git status` chỉ memory-bank dirty (baseline).
- Không implement experience retrieval; không sửa upstream claude-mem; không đưa Memory Bank vào commit code.

---
# Progress

- [x] Policy `.clinerules/08-temp-hygiene.md` + tóm tắt AGENTS.md.
- [x] Module `scripts/temp-hygiene.mjs` (zero-dep): `createSessionManager` / `cleanupSession` / `recoverSession` + helpers path/owner/snapshot.
- [x] **Hardening (đợt 2)**: (1) chống PID reuse — `verifyProcessIdentity` đọc cmdline (Win=CIM/PowerShell, POSIX=`ps`), không verify/identity lệch → KHÔNG kill + fail-closed (`unverified`, `POC_CLEANUP_FAILED`); (2) chống symlink/junction escape — `realPathOrNull`/`isCanonicalInside` canonical realpath, từ chối symlink/junction/target thoát root ở `cleanupSession` + `recoverSession`.
- [x] Test `scripts/test-temp-hygiene.mjs` **43/43 PASS** (PASS, FAILURE, TIMEOUT, RECOVERY, pid-scoped kill + NEW: pid-reuse identity lệch không kill + junction không xóa target ngoài). Đăng ký `test:temp-hygiene` + `optionalSuites` `full-verify.mjs`.
- [x] Verify: `node --check` pass; `pnpm verify` **128/128 PASS exit 0**; `git diff --check` pass.
- [x] **Commit độc lập `4c9fe22`** trên `feat/issue-19-phase2-readonly-mcp` — 6 files (.clinerules, AGENTS.md, package.json, full-verify.mjs, temp-hygiene.mjs, test-temp-hygiene.mjs), KHÔNG kèm Memory Bank. Chưa push, chưa handoff.

---
# Progress

## 27/08/2026 20:19 — TEMP HYGIENE (policy + module dùng lại) — implemented + verified (chưa commit)

- [x] Policy `.clinerules/08-temp-hygiene.md` + tóm tắt AGENTS.md.
- [x] Module `scripts/temp-hygiene.mjs` (zero-dep): `createSessionManager` / `cleanupSession` (finally, idempotent, read-back, verdict CLEAN|POC_CLEANUP_FAILED) / `recoverSession` (theo sessionId, chỉ resource có marker) + helpers path/owner/pid.
- [x] Test `scripts/test-temp-hygiene.mjs` **33/33 PASS** (PASS cleanup, FAILURE verdict, TIMEOUT process, RECOVERY tích cực + từ chối unowned, pid-scoped kill). Đăng ký `test:temp-hygiene` trong `package.json` + `optionalSuites` `full-verify.mjs`.
- [x] Verify: `node --check` mới pass; `pnpm verify` **128/128 PASS exit 0**; `git diff --check` pass.
- [ ] Chưa commit — giữ nguyên trên `feat/issue-19-phase2-readonly-mcp`, chờ Bố quyết. Chưa áp cho module khác (giữ scope Phase 2).

---

## 27/08/2026 — Issue #19 Phase 2: Read-only Test Evidence MCP — implemented + verified (chưa commit/PR)

- [x] Audit Memory Bank: 2 file uncommitted (activeContext.md, progress.md — nội dung PR #20 squash@e087d76), 0 untracked. Stash → checkout main → `reset --hard origin/main` (e087d76) → tạo branch `feat/issue-19-phase2-readonly-mcp` → `stash pop` sạch không conflict. main giữ đúng e087d76; branch mang 2 file memory.
- [x] `mcp-test-evidence/server.mjs` (zero-dep MCP stdio NDJSON JSON-RPC 2.0): tái dùng helper từ `scripts/test-evidence-reporter.mjs` (loadManifest, safePath, redactReport, formatSummary, formatFailureDetail, validateReport, MAX_LOG_EXCERPT_LINES). 5 read-only tools: `test_status`, `test_failures`, `test_failure_detail`, `test_log_excerpt`, `test_finding_map`. Bảo mật: `assertSecurity` (projectId/repo khớp manifest + `git remote get-url origin` khớp `manifest.repository`, trừ `MCP_TEST_EVIDENCE_SKIP_REMOTE=1`); `findReport` (reportId 16-hex qua safePath, headSha 40-hex, artifact mới nhất).
- [x] `mcp-test-evidence/test-server.mjs`: fixture tạm, **28 assertions PASS** (pure findReport + E2E spawn server thật + negative fail-closed).
- [x] Đăng ký `.mcp.json` (`mcp-test-evidence`: node + `mcp-test-evidence/server.mjs`) + `package.json` `test:evidence:mcp`.
- [x] Verify: `node --check` pass; `pnpm test:evidence:mcp` 28/28; `pnpm verify` **123/123 exit 0** (fix trailing newline `.mcp.json`).
- [x] Commit `9f199ff` (code Phase 2) + push `feat/issue-19-phase2-readonly-mcp` + mở Draft PR **#21** `Ref #19` (body qua file tạm đã xóa). 2 file memory giữ uncommitted để PR diff sạch. Không deploy, không executor/cache Phase 3.

---
## 27/08/2026 19:19 — PR #20: MERGE squash tại frozen HEAD 10c9e27 — hoàn tất (Bố lệnh đích danh)

- [x] Bố lệnh merge: `gh pr merge 20 --repo duongpdddic-droid/AI_PR_REVIEWER --squash` tại frozen HEAD `10c9e278e66b7798fac694550dde710b7d0d8931`.
- [x] Preflight: HEAD `10c9e27` OPEN, `mergeStateStatus: CLEAN`, `status:approved` (agent:gpt), main = origin/main `fa9fec3`.
- [x] **Squashed and merged**: PR #20 state **MERGED** (mergedAt 2026-08-27T12:18:58Z), merge commit `e087d76643f73898964deab40983e51b630ee066`.
- [x] Read-back main HEAD = `e087d76` (= merge commit, khớp origin/main sau fetch `fa9fec3..e087d76`).
- [x] Branch remote `feat/issue-19-test-evidence-protocol-v1` đã xóa (`git/refs/heads/...` DELETE 204 → GET 404 "Branch not found").
- [x] KHÔNG deploy. KHÔNG push thay đổi Memory Bank local phát sinh sau FREEZE (giữ uncommitted).

## 27/08/2026 19:08 — PR #20: relay approval GPT → status:approved (sẵn sàng merge, chờ Bố lệnh)

- [x] Bố lệnh "Thực hiện bước 2, chưa merge": chạy `node scripts/gpt-approval.mjs --repo duongpdddic-droid/AI_PR_REVIEWER --pr 20 --payload-file 10c9e... .agent/tmp-approval-pr20.json` với payload `{repository,prNumber:20,headSha:10c9e278e66b7798fac694550dde710b7d0d8931,policyVersion:2026-08-23.7,decisionId:gpt-pr20-10c9e27-20260827}` → gate trả **ĐÃ GHI approval agent:gpt ... status:approved**.
- [x] Read-back (read-after-write): labels `agent:gpt + status:approved` — chỉ một status:* duy nhất (status:review-requested đã gỡ); PR state OPEN (KHÔNG merge); HEAD `10c9e278e66b7798fac694550dde710b7d0d8931` không đổi; CI verify SUCCESS; marker approval `<!-- ai-review-approval:{...} -->` comment id `543891943` (user duongpdddic-dro, created 2026-08-27T12:06:11Z) khóa full HEAD+policyVersion+decisionId.
- [x] Temp payload đã xóa (`.agent/tmp-approval-pr20.json`).
- [x] KHÔNG merge/deploy/approve — quyền người dùng. Chờ Bố lệnh merge đích danh (`gh pr merge 20 --squash|--merge|--rebase` + xác nhận HEAD không drift).

## 27/08/2026 18:15 — PR #20: FREEZE HEAD @ 10c9e27 (Bố lệnh) — chờ GPT re-pass, không merge

- [x] **FREEZE HEAD PR #20 tại `10c9e278e66b7798fac694550dde710b7d0d8931`** (Bố 18:15). Cấm thêm commit/push lên branch `feat/issue-19-test-evidence-protocol-v1` cho tới khi GPT re-pass + Bố lệnh merge.
- [x] HEAD xác nhận GitHub = `10c9e278e66b7798fac694550dde710b7d0d8931` (OPEN). Worktree sạch.
- [ ] Chờ GPT re-pass HEAD `10c9e27`; sau đó Bố ra lệnh merge đích danh (Cline không tự merge/approve/deploy).

- [x] GPT TECHNICAL PASS PR #20 @ `3e79feb` (17:52) nhưng **HEAD đã đổi** thành `247670f4224728e1db2f25502e3df4699a1645b6` (commit memory-bank). Policy Issue #2 A3/G: HEAD đổi sau approval → approval `3e79feb` **mất hiệu lực**.
- [x] Bố quyết (18:09): **KHÔNG merge** bây giờ; GPT re-pass HEAD mới `247670f` rồi mới merge. PR #20 OPEN, mergeable CLEAN, labels `agent:gpt + status:review-requested`, HEAD `247670f`.
- [ ] Cline không merge/approve/deploy; chờ GPT re-pass HEAD `247670f` + lệnh merge đích danh của Bố.

- [x] GPT đã **TECHNICAL PASS** PR #20 tại HEAD `3e79feb02f5b4abe7a0ad3f02882474f44d1b9ca` (repo `duongpdddic-droid/AI_PR_REVIEWER`). Không re-review nữa. Labels hiện `agent:gpt + status:review-requested`; PR OPEN.
- [x] Regression Issue #2 xong (17:17): 123/123 + live E2E 23/23 + gateway 24/24 + gateway-mp 19/19 + mcp 52 + determinism.
- [ ] Chờ Bố đích danh lệnh merge PR #20 (merge/deploy là quyền người dùng — AI_PR_REVIEWER local không merge).

- [x] **Deterministic parser tests**: `node scripts/extract-behavior-map.mjs` chạy 2 lần → SHA256 behavior-map-current.json giống hệt (`MAP_DETERMINISTIC=True`, 2A0D99DD...); `test-review-phases` (deterministic decision tree) PASS trong full-verify.
- [x] **Full regression** `pnpm verify` (full-verify + E2E chained) → **123/123 PASS** (node --check, BOM, dup-fn, 15 suites regression, git diff --check, refresh behavior map).
- [x] **Live E2E** `test-evidence-e2e.mjs` → **23/23 PASS** (`Total: 23 assertions, 0 failures`, `RESULT: PASS`); `$LASTEXITCODE=0`.
- [x] **Suites ngoài gate**: `test-telegram-gateway.mjs` → 24 PASS 0 FAIL; `telegram-gateway/test-gateway-mp.mjs` → 19 PASS 0 FAIL; `mcp-task-server/test-server.mjs` → 52 assertions PASS.
- [x] Worktree sạch ngoài memory-bank (behavior-map-current không dirty). Điểm lưu ý: behavior-map **chưa có baseline** → `pnpm verify` báo skip baseline compare; determinism đã chứng minh bằng hash 2 lần chạy.

- [x] GPT-2 re-review HEAD `c9838c3`: CHANGES_REQUESTED — 087..091,093 đóng; **092 còn một phần**: CI chạy E2E nhưng `pnpm verify` chỉ chạy full-verify; dev phải nhớ chạy riêng `pnpm test:evidence`. GPT yêu cầu **một lệnh local gate duy nhất**: `"verify": "node scripts/full-verify.mjs && node scripts/test-evidence-e2e.mjs"`. Labels trả `agent:cline + status:changes-requested`.
- [x] **Fix**: `package.json` — `verify` = `full-verify.mjs && test-evidence-e2e.mjs`. Không recursion vì e2e tự `spawnSync` full-verify `--evidence` (không qua script pnpm).
- [x] Verify local: `pnpm verify` → full-verify **123/123** + `=== TEST-EVIDENCE-E2E ===` → **Total: 23 assertions, 0 failures** → `RESULT: PASS`; `pnpm verify` `$LASTEXITCODE=0`.
- [x] Commit `3e79feb` (1 file, package.json) + push; CI Verify run `33051980495` success trên HEAD `3e79feb02f5b4abe...`.
- [x] Re-handoff: set `status:review-requested` → orchestrate local (wrapper) → `PRE_REVIEW_PASS`, `openBlocking 0`, `outcome: handoff-gpt`; read-back labels `agent:gpt + status:review-requested`; marker cuối `key=...::20::3e79feb02f5b4abe...::2026-08-23.7::pre-review:PRE_REVIEW_PASS`. Chờ GPT-2 re-review HEAD `3e79feb`.
## 27/08/2026 14:44 — Issue #19 PR #20: fix GPT-REV-092 round 2 (CI gọi E2E + pre-review PASS HEAD c9838c3) — COMPLETED (chờ GPT-2 re-review)

- [x] GPT-2 re-review PR #20 @ `9e4d55f`: CHANGES_REQUESTED — GPT-REV-087..091,093 đóng; **092 còn mở**: E2E 23 assertion chỉ chạy `pnpm test:evidence` riêng, `pnpm verify` + CI chỉ syntax-check file mới (123/123) không chứng minh E2E chạy; thiếu `PRE_REVIEW_PASS` đúng HEAD.
- [x] **CI gọi E2E**: thêm step `- run: pnpm test:evidence` vào `.github/workflows/verify.yml`. CI Verify giờ chạy E2E assertion thật; read-back run `33050512687` (HEAD `c9838c3`): `=== TEST-EVIDENCE-E2E ===` → `Total: 23 assertions, 0 failures` → `RESULT: PASS`, check-run success.
- [x] **Dọn false-positive secret scanner**: `scripts/test-test-evidence.mjs` — 4 hằng fake secret ghép `.join('')` runtime (`FAKE_API_VALUE/FAKE_AWS_VALUE/FAKE_PWD_VALUE/FAKE_TOKEN_VALUE`) + tách literal private-key. Re-scan diff: 10 critical → `PRE_REVIEW_PASS`, openBlocking 0 (SCAN trước đó `scanDiffForSecrets` flag literal giả).
- [x] Verify: `test-test-evidence.mjs` **94/94**; `test-evidence-e2e.mjs` **23/23**; `pnpm verify` **123/123**; `pnpm test` **192/192**.
- [x] Commit `6ae4a7c` (CI verify.yml) + `c9838c3` (fake-secret runtime); push branch; CI green HEAD `c9838c3`.
- [x] Orchestrator local (wrapper `processOneCycle` repos=AI_PR_REVIEWER): `PRE_REVIEW_PASS` khóa `c9838c3` (policyVersion 2026-08-23.7) marker `ai-pr-reviewer:key=...20::c9838c3::...::pre-review:PRE_REVIEW_PASS`; handoff GPT-2 `agent:gpt + status:review-requested` (read-back labels OK). Chờ GPT-2 re-review HEAD mới.
## 27/08/2026 13:42 — Issue #19 PR #20: fix GPT re-review-2 findings GPT-REV-092/093 — COMPLETED (chờ GPT-2 re-review)

- [x] GPT re-review-2 PR #20 @ `a5e007a`: CHANGES_REQUESTED, 0 Critical / 2 Important (GPT-REV-092/093).
- [x] **GPT-REV-092 (E2E skipped ở gate)**: tách `scripts/test-evidence-e2e.mjs` (mới) thành suite E2E entry-point STANDALONE — KHÔNG nằm trong full-verify optionalSuites, không recursion, không "PASS giả do skip". `test:evidence` = `test-test-evidence.mjs && test-evidence-e2e.mjs`. Gate `pnpm verify` không còn liệt kê e2e; E2E chạy assertion thật (23/23).
- [x] **GPT-REV-093 (manifest failure codes)**: đặc trưng hóa — `MANIFEST_LOAD_FAIL` (thiếu file/JSON hỏng) vs `MANIFEST_INVALID` (schema sai) vs `ARTIFACT_WRITE_FAIL` (ghi/lưu lỗi). Entry tests 61-63 assert đúng mã, exit non-zero, no PASS, no stack.
- [x] `scripts/full-verify.mjs`: gỡ `test-evidence-e2e.mjs` khỏi optionalSuites; sửa header comment.
- [x] `scripts/test-test-evidence.mjs`: bỏ 4 khối `if (!E)` guard FULL_VERIFY_CHILD + header (không còn cần).
- [x] Verify: `test-test-evidence.mjs` **94/94 PASS**; `test-evidence-e2e.mjs` standalone **23/23 PASS**; `pnpm verify` **123/123 PASS**; `--evidence` thực tế `VERIFY PASS head=a5e007a... tests=123/123 report=22e244a33c4588b7`.
- [x] `git diff --check` sạch; node --check 3 file OK.
- [x] Commit `9e4d55f` (test-evidence-e2e.mjs mới + 2 file M + package.json); push branch.
- [x] Re-handoff GPT-2: comment tóm tắt fix 092/093 trên PR #20; labels `agent:gpt` + `status:review-requested`. Chờ GPT-2 re-review.

## 27/08/2026 10:03 — Issue #19 PR #20: fix GPT re-review findings GPT-REV-087/088/089 — COMPLETED (chờ GPT re-review)

- [x] GPT re-review PR #20 @ `851fed8`: CHANGES_REQUESTED, 0 Critical / 3 Important (GPT-REV-087/088/089).
- [x] **GPT-REV-087 (execution path)**: `--evidence` giờ đi qua pipeline duy nhất — loadManifest → validateManifest → computeManifestHash → computeReportId(head, manifestHash) → validateReport → saveReport(redact) → formatCompactLine. Không còn ad-hoc hash.
- [x] **GPT-REV-088 (redaction)**: thêm `redactReport()` deep-redact `failures[].detail`+`logExcerpt`; `formatFullJson`/`formatSummary`/`formatFailureDetail`/`saveReport` đều gọi trước output/write.
- [x] **GPT-REV-089 (fail-closed)**: validators strict — reject extra props, empty/invalid headSha (40-hex), empty projectId, invalid step timeout/args/extra props, invalid failure code; `saveReport` validate + `safePath` chặn traversal `../`/non-hex16 reportId.
- [x] `.agent/test-manifest.json`: headSha = `851fed852d7434bf31601ccf494ed7600cee11b7` (40-hex hợp lệ).
- [x] `scripts/test-test-evidence.mjs`: **59 → 94 tests** (35 mới cover 3 findings).
- [x] Verify: `pnpm test:evidence` **94/94 PASS**; `pnpm verify` **121/121 PASS** (~7.3s, hết treo do bỏ test #57 đệ quy full-verify); `--evidence` thực tế ra `VERIFY PASS head=851fed8... tests=121/121 report=8022a4c63075dc29`, artifact đúng schema, reportId khớp `sha256(head:manifestHash)[:16]`.
- [x] `git diff --check` sạch; node --check 3 file OK; không BOM.
- [x] Commit `858b701` (7 files, +404/−53); push branch; CI Verify **success** @ `858b701`.
- [x] Re-handoff GPT: comment `[CLINE-FIX-087/088/089]` trên PR #20; labels `agent:gpt` + `status:review-requested`. Chờ GPT re-review.

## 27/08/2026 — Issue #19 Phase 1: Test Evidence Protocol v1 + compact reporter — COMPLETED (PR #20, chờ GPT review)

- [x] Branch `feat/issue-19-test-evidence-protocol-v1` từ main (`fa9fec3`).
- [x] Tạo `scripts/test-evidence-schema.json` (JSON Schema v1.0: TestManifest + CompactReport + FailureRecord).
- [x] Tạo `.agent/test-manifest.json` (5 gates: syntax, unit, integration, policy, drift).
- [x] Tạo `scripts/test-evidence-reporter.mjs` (~140 dòng): hash, format, validate, redact, save, progressive disclosure.
- [x] Tạo `scripts/test-test-evidence.mjs` (~240 dòng): 59 asserts.
- [x] Sửa `scripts/full-verify.mjs`: +`--evidence` flag + startTime tracking.
- [x] Verify: `pnpm test:evidence` **59/59 PASS**; `pnpm verify` **121/121 PASS**; `test:drift` 0 FAIL.
- [x] Commit `c53e8c4` (6 files, +591/−9); push.
- [x] Draft PR #20 opened → CI PASS → marked ready → `agent:gpt` + `status:review-requested`.
- [x] Memory Bank updated (activeContext.md rewritten for Issue #19).
- Known: PR #17 diff >1500 dòng chưa quyết định Bố; không chặn Issue #19.

## 27/08/2026 — PR #17: GPT re-review @ `052f89c` → đóng GPT-REV-078/079/085, mở GPT-REV-086 (Important) → đã fix, chờ re-review
- [x] GPT re-review tại 052f89c (commit 5430008338): **GPT-REV-078 đã ĐÓNG** (TCP lease giải quyết đúng ownership race); 079/085 tiếp tục đóng. CI 33003956362 SUCCESS.
- [x] **GPT-REV-086 (Important)** — backoff bị clamp: production `main()` gọi `await sleep(Math.min(backoff, 2000))` → mọi backoff 60–300s bị hạ xuống 2s → vẫn restart churn.
- [x] **Fix 086**: refactor vòng giám sát thành `supervisorLoop({ runSupervisorOnceFn, sleepFn })` (exportable); production `main()` gọi `supervisorLoop()` → **đúng `await sleepFn(backoff)`**, không clamp. Test chạy nhanh bằng **inject `sleepFn`** (không đụng thời gian production).
- [x] Unit mới test 18b `supervisor loop backs off with real backoff, not clamped`: `sleepFn` ghi ms được gọi → assert `sleeps[0]===computeBackoff(1)=60000` và `>2000` (không phải 2000 clamp cũ).
- [x] Verify: `pnpm test:gateway` **24/24 PASS** (tăng 1 test 18b); `pnpm test:gateway:mp` **19/19 PASS**; `pnpm test:drift` 0 FAIL; `node scripts/full-verify.mjs` **116/116 PASS**.
- [x] HEAD mới commit+push → đồng bộ PR #17 `agent:gpt`+`review-requested` → chờ GPT re-review (không merge/deploy/approve; soak-test trên máy Bố trước khi xóa legacy).
- [x] **GPT-REV-078 (bắt buộc lại)**: GPT re-review tại `d2a6d9a` vẫn BLOCK (078 Critical): file-lock (`LOCK_FILE` + `TAKEOVER_GUARD` + `statSync→unlinkSync→openSync('wx')` + heartbeat overwrite + release unlink) vẫn check-then-mutate race; test mp chỉ chạy acquire từ lock rỗng, thiếu race.
- [x] **Thiết kế mới (theo prompt GPT: OS-owned)**: bỏ hoàn toàn file-lock `LOCK_FILE`/`TAKEOVER_GUARD`/`takeoverLock`/`grabTakeoverGuard`. `tryAcquireLock` giờ bind **TCP port localhost** (`LEASE_HOST:LEASE_PORT` mặc định `127.0.0.1:47321`, env `GATEWAY_LEASE_PORT`). OS đảm bảo CHỈ 1 process giữ (host,port) — `EADDRINUSE`→duplicate→exit 3. Owner do kernel quản lý: tự thả port khi chết/crash → KHÔNG stale-scan, KHÔNG heartbeat-overwrite, KHÔNG unlink. `releaseLock` chỉ `server.close()` (owner-only, không có file).
- [x] `probeLease()` đọc identity handshake owner gửi `{instanceId,pid}`; chỉ coi `alive` khi đọc được data — connect tới socket đang đóng / không data → not-alive (chống giả owner). `isReady()` async: probe lease phải **cùng instanceId** + health + READY_FILE + poll gần đây.
- [x] supervisor `runSupervisorOnce` dùng `probeFn` (mặc định probeLease) thay vì `readLock/isLockAlive`; `await startGatewayFn()`; `--status` probe port.
- [x] **Test child-process thật mới (test-gateway-mp.mjs)**: contention 3 child (chỉ 1 giữ, 2 exit 3); owner crash (SIGKILL) → OS thả → reacquire single; old-owner/contender KHÔNG đổi lease owner mới (releaseLock(non-owner)=false, identity giữ nguyên). Đổi lease test sang port riêng (`GATEWAY_LEASE_PORT`), probe/await isReady.
- [x] Unit `test-telegram-gateway.mjs`: test 6/10/16/17/18 + live-degraded chuyển sang lease + async; `cleanRuntime` bỏ LOCK_FILE/TAKEOVER_GUARD.
- [x] Verify: `pnpm test:gateway` **23/23 PASS**; `pnpm test:gateway:mp` **19/19 PASS**; `pnpm test:drift` 0 FAIL; `node scripts/full-verify.mjs` **116/116 PASS**. Lưu ý determinism: `transport.loadConfig` thêm env `GATEWAY_NO_LEGACY_CFG=1` (test) bỏ fallback `~/.ai-pr-reviewer/tg.json` — máy có tg.json thật không bị gateway subprocess dùng bot thật poll vô hạn/gây 409.
- [x] HEAD mới → commit + push `fix/issue-15-telegram-gateway` → chờ GPT re-review (không merge/deploy/approve).
- [x] GPT-REV-079 (gốc): `supervisor.runSupervisorOnce` nhánh live-degraded — lock SỐNG (pid+heartbeat) nhưng chưa ready → `monitor-degraded`, KHÔNG spawn (trước chỉ xét `!isReady` → spawn thừa gây churn); `main()` loop coi là không-fail (reset backoff). Test mới assert `startGatewayFn` không gọi (L-041).
- [x] GPT-REV-078 (giữ): `takeoverLock` không clobber lock tươi (atomic wx + re-check isLockAlive); owner-only touchHeartbeat/releaseLock.
- [x] GPT-REV-085 (giữ): `.clinerules/01`+`05` bỏ ref `telegram-bridge.mjs`/`watchdog-hibernate.mjs`/`shutdown /h`; drift test #3/#4 PASS.
- [x] Verify: `pnpm test:gateway` **23/23 PASS** (incl. monitor-degraded mới); `pnpm test:gateway:mp` **9/9 PASS**; `pnpm test:drift` exit 0 (0 FAIL).
- [x] Commit `7ce22d1` push `fix/issue-15-telegram-gateway` (HEAD=origin); comment Issue #15 re-review 078/079/085 trên PR #17. GPT re-review PR trực tiếp (agent:gpt+review-requested, orchestrator skip). KHÔNG merge/deploy/approve.

## 26/08/2026 18:23 — PR #17: handoff GPT re-review (diff-limit Decision Gate) — COMPLETED (handoff restored, chờ GPT)
## 26/08/2026 18:23 — PR #17: handoff GPT re-review (diff-limit Decision Gate) — COMPLETED (handoff restored, chờ GPT)
- [x] Phát hiện: cron CI orchestrator KHÔNG quét AI_PR_REVIEWER (committed `targetRepos=['QLDA_DTXD']`); PR #17 chỉ pre-review thủ công (config tạm đổi sang AI_PR_REVIEWER).
- [x] Sai sót vòng trước: PR #17 giữ nhãn cũ `agent:cline`+`status:changes-requested` (từ đợt GPT changes-requested); Issue #15 đã `agent:gpt`+`status:review-requested`. Orchestrator SKIP PR có `agent:gpt` → đồng bộ nhãn PR.
- [x] Chạy orchestrator pre-review tại HEAD `9978677` (config tạm AI_PR_REVIEWER): `block-decision-gate` (`decisionGate: diff-limit`) vì diff 2399 dòng > `maxLines:1500` (additions+deletions); orchestrator mutate PR #17 sang `status:blocked`.
- [x] Khôi phục đúng: PR #17 = `agent:gpt`+`status:review-requested` (GPT review trực tiếp, orchestrator skip) — trạng thái từng cho GPT review 078..084; gỡ `status:blocked`.
- [x] Restore config `targetRepos`=`QLDA_DTXD`; xóa temp script. git status chỉ còn memory-bank (uncommitted).
- [ ] **DECISION GATE (Mức 3)**: diff 2399 > 1500 giới hạn policy. Bố chọn (A) giữ review trực tiếp / (B) nâng maxLines / (C) chia PR. Hiện giữ (A).
- [x] CHỜ GPT re-review tại HEAD `9978677`. KHÔNG chạy orchestrator pre-review (sẽ block diff-limit). KHÔNG merge/deploy/approve.


## 26/08/2026 (tiếp) — PR #17 GPT-REV-077..082 hardening (bản FINAL trước handoff GPT) — COMPLETED
- [x] Tiếp nối phiên trước: sửa tiếp transport (allowlist user) + bridge (routeUpdate user allowlist + reject forwarded/channel) + notifier (processOutbound đọc readOutboundAll cho mọi appNs) + gateway (fetchImpl test hook, touchHeartbeat mới, READY_FILE JSON, inbound dispatch loop, dọn stale ready) + tạo dispatcher.mjs (chỉ dispatch command, KHÔNG self-review).
- [x] Sửa 3 bug thực tế bắt bằng test: (1) `takeoverLock` stale check sai (L-036) → giờ check `isLockAlive`; (2) `HEARTBEAT_MS` hardcoded 15000 bỏ qua env (L-037) → đọc env `GATEWAY_HEARTBEAT_MS`/`GATEWAY_STALE_MS`; (3) test idempotency trùng key (L-038) → key unique.
- [x] Thêm integration test multi-process + real child gateway: scripts/telegram-gateway/test-gateway-mp.mjs (8/8 PASS: lock đơn instance, ready sau startup, inbound ack, outbound send, release khi thoát). package.json + `test:gateway:mp`.
- [x] Mở rộng unit test (16/16 PASS): routeUpdate user allowlist, HEAD_RE 40-hex + gatewayEventKey, enqueue validate fail-closed, processOutbound multi-appNs, supervisor decision.
- [x] Docs: scripts/telegram-gateway/README.md bổ sung phần Bảo mật & Robustness (077..082) + test mp.
- [x] Verify: `pnpm test:gateway` 16/16; `pnpm test:gateway:mp` 8/8; `pnpm verify` **116/116 PASS**.
- [x] Kế hoạch: commit/pushfix/issue-15-telegram-gateway, comment CLINE-FIX PR #17, handoff GPT tại HEAD mới, notify Telegram.

## 26/08/2026 11:39 — PR #17 GPT-REV-077..081 re-fix — COMPLETED (verify + pushed, chờ GPT re-review)

- [x] Sửa 5 finding review (REV-077 allowlist+path-traversal; REV-078 atomic lock+owner-only; REV-079 verified-startup health gate; REV-080 gatewayEventKey+head SHA+validateEnvelope fail-closed; REV-081 sync test harness 12 case).
- [x] Verify: `node scripts/test-telegram-gateway.mjs` **12/12 PASS**; `node scripts/full-verify.mjs` **110/110 PASS**.
- [x] Commit `3b1cea9` (gc.auto=0 core.commitGraph=false), push `fix/issue-15-telegram-gateway`; `39db081..3b1cea9`.
- [x] `gh pr comment 17` re-review (issuecomment-5420675625); notify-telegram.mjs legacy sent to 816272951 (không arm watchdog).
- [x] KHÔNG merge/deploy. Chờ GPT re-review.

## 26/08/2026 09:59 — Issue #15: Shared Telegram Gateway (A) — COMPLETED (code+test)

- [x] Bố chọn A (Full per AC). Xóa watchdog-hibernate.mjs (idle/sleep/hibernate + shutdown /h).
- [x] tg-notify-core.mjs: +events approved/merged; xóa toàn bộ hàm watchdog (production path sạch).
- [x] notify-telegram.mjs: xóa arm block + imports thừa.
- [x] Tạo scripts/telegram-gateway/ (contract/transport/bridge/notifier/supervisor/gateway/adapter/install/README) — single getUpdates poller (lock chống 429), notifier idempotent, supervisor self-heal, runtime ngoài repo ~/.ai-pr-reviewer/gateway/ (KHÔNG commit token/queue/lock/heartbeat).
- [x] Wire orchestrator.io.notify + autonomous.notifyTelegram -> adapter (single source of truth).
- [x] Verify: node --check PASS; pnpm test:gateway 9/9; pnpm test:tg PASS; pnpm verify 110/110; gateway smoke (lock+heartbeat+ready) PASS.
- [x] Commit + push fix/issue-15-telegram-gateway; Draft PR Ref #15; handoff GPT (agent:gpt + status:review-requested).

## 26/08/2026 09:15 — Issue #14 / PR #16: MERGE vào main (không có deploy riêng)

- [x] Bố đồng ý merge + deploy. PR #16 là Draft → `gh pr ready 16` + `gh pr merge 16 --squash` → **MERGED**; main HEAD `0bedf1046863222bcc5d9bf58bbcb5b630611f37` (mergedAt 2026-08-26T02:15:37Z).
- [x] Deploy KHÔNG áp dụng: repo `AI_PR_REVIEWER` chỉ có Node scripts (package.json scripts: test/verify/orchestrate/notify…), không `appsscript.json`/`.clasp.json`, không script `deploy`. Merge vào main = hoàn tất.
- [x] Đóng Issue #14 (resolved bởi PR #16). Memory Bank giữ uncommitted (theo chỉ thị "không đưa vào commit").

## 26/08/2026 09:09 — Issue #14 / PR #16: GPT user-relay APPROVAL (status:approved)

- [x] Relay GPT decision (issuecomment-5419527516, user `duongpdddic-droid`): APPROVE tại HEAD `8d2c7d8b2f13e731234b7a4e50aeeb345f066a1a`, policy `2026-08-23.7`, decisionId `gpt-pr16-8d2c7d8-20260826`.
- [x] Chạy `node scripts/gpt-approval.mjs --repo duongpdddic-droid/AI_PR_REVIEWER --pr 16 --payload-file <tmp> --note "Relay GPT decision issuecomment-5419527516..."` → gate trả **ĐÃ GHI approval**.
- [x] Read-back: labels `agent:gpt`+`status:approved` (xóa `status:review-requested`); HEAD `8d2c7d8b2f13e731234b7a4e50aeeb345f066a1a` giữ nguyên (KHÔNG merge); comment marker `5419617390` khóa full HEAD+policy+decisionId (`<!-- ai-review-approval:{...} -->`). Temp payload đã xóa.
- [x] KHÔNG merge/deploy — chờ người dùng thực hiện merge theo thẩm quyền. Memory Bank giữ uncommitted (không đưa vào commit).

## 26/08/2026 08:43 — Issue #14: resolve 3 false-positive secret findings (LOCAL-REV-001..003) — PRE_REVIEW_PASS + handoff GPT

- [x] Bố chọn (B): sửa 3 false positive trong `scripts/test-project-registry.mjs` (AC4 aws key, AC10 apiKey + botToken) bằng cách tách literal giả rồi `.join('')` tại runtime; computed key `[fakeApiKeyName]`/`[fakeBotTokenName]`. KHÔNG đổi regex/logic production, KHÔNG allowlist, KHÔNG credential thật.
- [x] Evidence: `node scripts/test-project-registry.mjs` **136/136 PASS** (thêm 3 assertion runtime-join + giữ CONTAINS_SECRET); temp `scanDiffForSecrets(git diff)` = 0 finding; `pnpm verify` 94/94 PASS; `git diff --check` sạch.
- [x] Commit `8d2c7d8` (test-only `--only`), push `feat/issue-14-project-registry`.
- [x] Re-handoff PR #16 (`changes-requested`→`review-requested`, giữ `agent:cline`, không `agent:gpt`); chạy `node scripts/unified-orchestrator.mjs --execute` tại HEAD `8d2c7d8` → **PRE_REVIEW_PASS** (openBlocking:0) → orchestrator tự post marker + handoff `agent:gpt`+`status:review-requested`. KHÔNG tự tạo marker, KHÔNG merge/deploy. Chờ GPT phê duyệt cuối.

## 26/08/2026 07:33 — Reconcile: verdict [GPT-REV-076] Bố relay là STALE (không re-fix)

- [x] Bố relay verdict CHANGES_REQUESTED [GPT-REV-076] (CI 32870732938) — nhưng reconcile cho thấy ĐÃ STALE:
  - CI run `32870732938` headSha = `3406b2ee...` (commit round-6, TRƯỚC fix). Current HEAD PR #16 = `27196ed` (đã fix round 7+7b).
  - PR #16 labels thực tế: `agent:cline`+`agent:gpt`+`status:review-requested` (KHÔNG phải changes-requested). `reviews`: `[]`.
- [x] [GPT-REV-076] đã đóng tại HEAD `27196ed`: up() reject `toVersion!=='1.0'||from!=='0.9'` (UNSUPPORTED, phủ 0.9→2.0, L248-250); assert `planCore.toVersion===m.schemaVersion` (ROLLBACK_PLAN_VERSION_MISMATCH, L263-264); down() reject `toVersion!=='0.9'||from!=='1.0'` (L278-280); plan down `plan.toVersion===current && plan.fromVersion==='0.9'` (DIRECTION_MISMATCH, L291-292); chỉ 1.0→1.0 none (L306-309).
- [x] Evidence: `node scripts/test-project-registry.mjs` 133/133 PASS (test `076 up 0.9->2.0 (đích lạ) -> fail-closed` + rollbackPlan mismatch); CI Verify PASS tại HEAD `27196ed`.
- [x] HÀNH ĐỘNG: KHÔNG re-fix, KHÔNG commit dư thừa, KHÔNG đổi label (đã đúng review-requested). Đợi Bố xác nhận nếu确有 review mới trên 27196ed (cần số CI run khác). Issue #14 / PR #16 vẫn chờ GPT re-review.

## 26/08/2026 07:25 — GitHub task-intake (safe checkpoint) — NO_TASK

- [x] Chạy `node scripts/github-task-intake.mjs` (read-only) tại safe checkpoint: kết quả `{"status":"NO_TASK","repo":"duongpdddic-droid/AI_PR_REVIEWER"}`. Không có Issue `agent:cline`+`status:ready-for-cline` để claim.
- [x] Trạng thái workspace: đang trên nhánh `feat/issue-14-project-registry` (Issue #14 / PR #16) chờ GPT re-review vòng 8; worktree chỉ 3 file memory-bank sửa, chưa commit (theo lệnh Bố giữ nguyên).
- [x] Không thực hiện claim (NO_TASK + đang trên task branch → preflight sẽ BLOCKED_ACTIVE_ISSUE_BRANCH fail-closed). Tiếp tục chờ GPT re-review vòng 8; không merge/deploy.

## 26/08/2026 07:03 — Issue #14: fix GPT-REV-076 (re-review vòng 7→8, round 7b) — COMPLETED (chờ GPT re-review vòng 8)

- [x] Feedback vòng 7: path tăng/giảm lạ đã chặn đúng, nhưng branch `none` (from===toVersion) vẫn nhận version lạ bằng nhau `0.8→0.8`/`0.9→0.9`/`2.0→2.0` → `ok:true, direction:'none'`. Chỉ `1.0→1.0` idempotent.
- [x] Sửa source: branch cuối chỉ trả `none` khi `from === MIGRATION_TO_VERSION && toVersion === MIGRATION_TO_VERSION` (tức `1.0→1.0`); mọi version lạ bằng nhau khác → `UNSUPPORTED_MIGRATION_PATH`.
- [x] Test 133/133 PASS: thêm 0.8→0.8 / 0.9→0.9 / 2.0→2.0 → UNSUPPORTED + input bất biến; 1.0→1.0 vẫn none giữ nguyên; NEG-T1..T5 + AC10/AC12/AC13 không regress.
- [x] `node scripts/test-project-registry.mjs` **133/133 PASS**; `pnpm verify` **94/94 PASS exit 0**; `git diff --check` sạch.
- [x] Commit `27196edc018448acd16643cbdf25ede0a98ec843`, push `e898380..27196ed`; comment `[CLINE-FIX-076]`: PR issuecomment-5418689910 + Issue issuecomment-5418690309; labels read-back `agent:cline`+`agent:gpt`+`status:review-requested` (đã xóa dư `status:changes-requested`); CI Verify PASS HEAD mới.
- [ ] CHỜ: GPT re-review vòng 8; approval qua `gpt-approval.mjs` (user-relay) -> user merge. Không merge/deploy.

## 26/08/2026 06:53 — Issue #14: fix GPT-REV-076 (re-review vòng 6→7) — COMPLETED (chờ GPT re-review vòng 7)

- [x] Thêm hằng `MIGRATION_FROM_VERSION='0.9'`, `MIGRATION_TO_VERSION='1.0'`.
- [x] up(): giới hạn path chính xác 0.9→1.0; `toVersion!=='1.0' || from!=='0.9'` → `UNSUPPORTED_MIGRATION_PATH`; assert `planCore.toVersion === m.schemaVersion` → `ROLLBACK_PLAN_VERSION_MISMATCH` (rollbackPlan.toVersion khớp manifest.schemaVersion sau up).
- [x] down(): giới hạn path chính xác 1.0→0.9; `toVersion!=='0.9' || from!=='1.0'` → `UNSUPPORTED_MIGRATION_PATH`; ràng buộc hướng plan `plan.toVersion !== current manifest` HOẶC `plan.fromVersion!=='0.9'` → `ROLLBACK_PLAN_DIRECTION_MISMATCH`.
- [x] Test 124/124 PASS: 076 up 0.9→1.0 ok / 0.9→2.0 (đích lạ) fail / nguồn 0.8 & 2.0 fail / 1.0→1.0 none; down nguồn 2.0 fail / plan 1.0→2.0 & 0.9→2.0 DIRECTION_MISMATCH / path 1.0→0.9 ok lossless. NEG-T1..T5 + AC10/AC12/AC13 không regress.
- [x] Lỗi giữa phiên: ràng buộc down ban đầu so `plan.fromVersion` với `MIGRATION_TO_VERSION` (sai — plan.fromVersion='0.9' nguồn gốc) làm AC6 crash; sửa thành `plan.toVersion === current manifest` (khớp schemaVersion) + `plan.fromVersion==='0.9'` (đích). Test 1.0→1.0 kỳ vọng fail → thực tế none idempotent → đổi test dùng nguồn 0.8.
- [x] `node scripts/test-project-registry.mjs` **124/124 PASS**; `pnpm verify` **94/94 PASS exit 0**; `git diff --check` sạch.
- [x] Commit `e898380645309ea2720031b0abef614936fa5cf7`, push `3406b2e..e898380`; comment `[CLINE-FIX-076]`: PR issuecomment-5418611957 + Issue issuecomment-5418612391; labels read-back `agent:cline`+`agent:gpt`+`status:review-requested` (đã xóa dư `status:changes-requested`); CI Verify PASS HEAD mới.
- [ ] CHỜ: GPT re-review vòng 7; approval qua `gpt-approval.mjs` (user-relay) -> user merge. Không merge/deploy.

## 25/08/2026 23:18 — Issue #14: fix GPT-REV-075 (re-review vòng 5→6) — COMPLETED (chờ GPT re-review vòng 6)

- [x] Bỏ hẳn tham số `added` (mảng key tùy ý) khỏi `migrateManifest` down; thay bằng `rollbackPlan` bắt buộc.
- [x] up() trả rollbackPlan versioned fingerprint-bound: `{planVersion:1, fromVersion, toVersion, addedKeys, fingerprint}`; fingerprint = sha256(JSON({manifest sau up, fromVersion, toVersion, addedKeys})) — bám cả manifest lẫn plan core, sửa thành phần nào cũng mismatch.
- [x] down() gate tuần tự fail-closed: ROLLBACK_PLAN_REQUIRED → VERSION_INVALID → DIRECTION_MISMATCH (plan.fromVersion phải == toVersion yêu cầu) → KEYS_INVALID (rỗng/non-string) → ILLEGAL_KEY (ngoài allowlist UPGRADE_ALLOWED_ADDED_KEYS, chặn repository/projectId/schemaVersion/extension) → FINGERPRINT_INVALID/MISMATCH. Mutation chỉ trên clone sau mọi gate PASS; không đụng `__migrationAdded`.
- [x] Test 107/107 PASS: NEG-T1 plan thiếu/rỗng/null; NEG-T2 4 key cấm; NEG-T3 sửa addedKeys/fingerprint/version/hướng; NEG-T4 plan A áp B; NEG-T5 + AC10/AC12 lossless round-trip; AC13 register/load giữ extension.
- [x] Fix giữa phiên: check hướng ban đầu so plan.toVersion với toVersion yêu cầu (luôn lệch) → đổi thành plan.fromVersion === toVersion; fingerprint chỉ bám manifest không bắt được sửa addedKeys → mở rộng bám plan core; test dedupe-duplicate-key bỏ (duplicate = plan đã sửa → mismatch là đúng spec).
- [x] Lỗi test-authoring: expression rác trong assertion no-mutate (`createHash(...) && ...`) — cùng chủ đề L-033 mục 3, tự phát hiện khi chạy.
- [x] `node scripts/test-project-registry.mjs` **107/107 PASS**; `pnpm verify` **94/94 PASS exit 0**; `git diff --check` sạch (fix blank line EOF consolidatedLearnings).
- [x] Commit `3406b2ee45172d221c5e1d455a717ef355d1e9c0`, push `9fadfd4..3406b2e`; comment `[CLINE-FIX-075]`: PR issuecomment-5413334455 + Issue issuecomment-5413334416; labels read-back PR+Issue `agent:gpt`+`status:review-requested`; CI Verify PASS HEAD mới.
- [ ] CHỜ: GPT re-review vòng 6; approval qua `gpt-approval.mjs` (user-relay) -> user merge. Không merge/deploy.

## 25/08/2026 22:45 — Issue #14: fix GPT-REV-073 (re-review vòng 4→5) — COMPLETED (chờ GPT re-review vòng 5)

- [x] `registerProject`: XÓA `delete clean.__migrationAdded`; sau remote gate chỉ deep-clone và lưu nguyên clone — không strip extension field nào, input không mutate ở mọi nhánh.
- [x] `migrateManifest` down: bỏ fallback đọc `m.__migrationAdded` + bỏ `delete m.__migrationAdded`; rollback CHỈ dùng tham số `added` tường minh (mảng string do up trả về, validate kiểu + dedupe); thiếu/không hợp lệ → fail-closed `{ok:false,direction:'down',reason:'ROLLBACK_METADATA_REQUIRED'}`; không đoán metadata từ tên field (`additionalProperties: true`).
- [x] AC12 round-trip: nguồn chứa `__migrationAdded {note}` + `customExtension {enabled,items[]}` → `down(up(src))` deep-equal tuyệt đối original, cả 2 extension field giữ nguyên, không key ẩn trên manifest output.
- [x] AC13 persistence: register manifest 1.0 chứa cả 2 extension field → input deep-equal snapshot; `loadRegistry({registryPath})` persisted giữ nguyên cả 2. No-mutate cho validation failure / conflict / remote mismatch / success.
- [x] Negative rollback: thiếu `added` → ROLLBACK_METADATA_REQUIRED, payload nguyên vẹn; added non-string → fail-closed; dedupe trùng key → lossless.
- [x] Lỗi test-authoring trong phiên (3 lần: expression rác, direction:'none' không có added, loadRegistry sai signature) → học L-033 vào consolidatedLearnings.md.
- [x] `node scripts/test-project-registry.mjs` **80/80 PASS**; `pnpm verify` **94/94 PASS exit 0**; `git diff --check` sạch.
- [x] Commit `9fadfd4ee6d5e99ede96e39d98e426d3e3c8d542` (chỉ 2 file scripts; memory-bank giữ uncommitted), push `ec68dae..9fadfd4`.
- [x] Comment `[CLINE-FIX-073]`: PR #16 issuecomment-5412913870 + Issue #14 issuecomment-5412915307; labels PR + Issue read-back `agent:gpt`+`status:review-requested`; CI Verify PASS HEAD 9fadfd4.
- [ ] CHỜ: GPT re-review vòng 5; approval qua `gpt-approval.mjs` (user-relay) -> user merge. Không merge/deploy.

## 25/08/2026 22:12 — Issue #14: fix GPT-REV-073/074 (re-review vòng 3→4) — COMPLETED (chờ GPT re-review vòng 4)

- [x] [GPT-REV-073]: `migrateManifest` KHÔNG ghi `__migrationAdded` lên manifest payload (trước đây có thể đè/mất extension field cùng tên); added-keys trả về result, `down()` nhận `added` để rollback xác định, lossless.
- [x] [GPT-REV-074]: `registerProject` KHÔNG mutate input trước remote (AC3: remote khớp trước mọi mutation); validate/conflict/remote read-only, clone+strip chỉ sau `assertWorkspaceRemote` pass.
- [x] Test: thread `added` trong AC6/AC10; thêm AC12 (extension field giữ nguyên sau up) + AC13 (input không bị mutate trước/sau remote).
- [x] `node scripts/test-project-registry.mjs` **58/58 PASS**; `pnpm verify` **94/94 PASS exit 0**.
- [x] Commit `ec68dae`, push `972972c..ec68dae` origin `feat/issue-14-project-registry`; comment `[CLINE-FIX-073][CLINE-FIX-074]`; PR #16 labels read-back `agent:gpt`+`status:review-requested`.
- [ ] CHỜ: GPT re-review vòng 4; approval qua `gpt-approval.mjs` (user-relay) -> user merge. Không merge/deploy.

## 25/08/2026 21:28 — Issue #14: fix GPT-REV-069/070/073 (re-review vòng 3) — COMPLETED (chờ GPT re-review)

- [x] [GPT-REV-069]: gate policy canonical — `CANONICAL_POLICY_VERSION=''2026-08-23.7''`; `validateManifest` reject `POLICY_VERSION_MISMATCH` khi `policy.version` lệch canonical.
- [x] [GPT-REV-070]: `loadSchema()` fail-closed (throw khi file thiếu/corrupt → `MANIFEST_SCHEMA_UNAVAILABLE`); `validateAgainstSchema` viết lại đệ quy validate type/pattern/enum/minLength nested đầy đủ.
- [x] [GPT-REV-073]: `migrateManifest` reversible lossless — `up` ghi nhận field added, `down` gỡ → `down(up(original)) === original`.
- [x] Fixtures generic.json/duplicate-id.json pin canonical `2026-08-23.7`; migration default `policy.version = CANONICAL_POLICY_VERSION`.
- [x] `scripts/test-project-registry.mjs` 50/50 PASS (thêm AC11 gate + nested fail-closed; strengthen AC10 round-trip).
- [x] `pnpm verify` **94/94 PASS exit 0**; `full-verify` 94/94.
- [x] Commit `e79e975`, push origin `feat/issue-14-project-registry`; comment `[CLINE-FIX-069..073]`; PR #16 labels `agent:gpt`+`status:review-requested`; HEAD `e79e9750b84868ab61e7efe004a9573c4472f5ee`.
- [ ] CHỜ: GPT re-review vòng 3; approval qua `gpt-approval.mjs` (user-relay) -> user merge. Không merge/deploy.
# Progress (AI_PR_REVIEWER)

## 25/08/2026 23:40 — Issue #14: fix GPT-REV-069..073 (re-review vòng 2) — COMPLETED (chờ GPT re-review)

- [x] [GPT-REV-069]: pin policy version canonical `2026-08-23.7` trong ai-pr-reviewer.json, qlda-dtxd.json, .agent/project.json.
- [x] [GPT-REV-070]: `validateManifest` thực thi JSON Schema (required/pattern/enum/minLength/nested) làm single source of truth; reject schema tương lai (UNSUPPORTED_SCHEMA_VERSION).
- [x] [GPT-REV-071]: `scanForSecrets` quét cả key camelCase (apiKey/botToken/accessToken) -> reject.
- [x] [GPT-REV-072]: `registerProject` idempotent (re-register cùng projectId+repo = no-op); QLDA fixture route `dm-boss-qlda` (distinct).
- [x] [GPT-REV-073]: down migration giữ nguyên mọi trường (true rollback, không mất data).
- [x] `scripts/test-project-registry.mjs` 43/43 PASS (thêm AC10: idempotency, secret-in-key, future schema, route uniqueness, rollback preserves data).
- [x] `pnpm verify` **94/94 PASS exit 0**; `full-verify` 94/94.
- [x] Commit `0cc5827`, push origin `feat/issue-14-project-registry`; comment `[CLINE-FIX-069..073]` (issuecomment-5411484124); PR #16 labels `agent:gpt`+`status:review-requested`; Issue #14 `status:review-requested`.
- [ ] CHỜ: GPT re-review vòng 2; approval qua `gpt-approval.mjs` (user-relay) -> user merge. Không merge/deploy.

## 25/08/2026 12:20 — Issue #9 REV-4: fix GPT-REV-065 startup context PR #10 — COMPLETED (chờ review vòng 4)

- [x] Startup capsule đo được (`buildStartupCapsule()`): message + `--read` inline; conventions >2000t → pointer, không `--read`; budget tổng fail-closed `CODER_STARTUP_BUDGET_TOKENS=12000` → vượt escalate `BLOCKED_CONTEXT_BUDGET`.
- [x] `fetchUnresolvedFindings()` — unresolved `[GPT-REV-*]` từ comments GitHub (verdict mới nhất thắng) vào protected entries; RESOLVED loại; degrade an toàn.
- [x] Dedupe sha1 + telemetry `startup-context` đầy đủ (`startupContextTokens`, `loadedModules`, `loadedMemoryCount`, before/after compact, `loadReasons`, `externalContextUnknown`).
- [x] Benchmark: raw ~84k tokens → startup **101 tokens**; critical spans nguyên vẹn; retry nhỏ hơn.
- [x] Verify: test-runtime-hooks 13/13; full-verify 89/89 exit 0; CI success HEAD `260ab3d15af63314694afff142c0a0d9d8dbf2df`.
- [x] Bàn giao: commit `260ab3d`, comment `[CLINE-FIX-065]` (issuecomment-5405750436), labels read-back `agent:cline`+`status:review-requested`.

## 25/08/2026 11:25 — Issue #9 REV-3: fix GPT-REV-062/063/064 PR #10 — COMPLETED (chờ review vòng 3)

- [x] [GPT-REV-062]: `recover()` đi qua duy nhất `recordEvent()`/`redactDeep()`; secret lồng `identity`/`fallbackChain` không lên đĩa (`INT.recover-redacts-identity` PASS).
- [x] [GPT-REV-063]: runtime persistence mặc định ngoài worktree `~/.agent-runtime/<basename>-<sha1-12(rootDir)>/`; `commitAndPush()` unstage `.agent/runtime`; test chứng minh `git status --porcelain` sạch + persist qua restart.
- [x] [GPT-REV-064]: `buildCoderContext()` wire bootstrap/invariants + `selectiveLoad()` + `compactTranscript()` (budget 6000) vào coder execution; overBudget → escalate `BLOCKED_CONTEXT_OVERBUDGET`; `compact-then-retry` rebuild budget nửa + telemetry compaction persist.
- [x] Verify: test-runtime-hooks 10/10; **full-verify 89/89 PASS exit 0**; smoke dry-run OK; CI Verify CI success HEAD `025e66b7a0db8d2b351778d380014f7e69112031`.
- [x] Bàn giao: commit `025e66b`, comment `[CLINE-FIX-062..064]` (issuecomment-5405139219), labels read-back `agent:cline`+`status:review-requested`. Archive activeContext >5 entry → taskHistory.md.

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
## 25/08/2026 20:06 — Issue #14: Project Registry + versioned project manifest — IN PROGRESS (bàn giao GPT review)

- [x] Claim #14 (`agent:cline` + `status:in-progress`); branch `feat/issue-14-project-registry` từ `origin/main` (fbfd2ff).
- [x] Deliver: `scripts/project-manifest-schema.json` (schema versioned, fail-closed thiếu repo identity); `scripts/project-registry.mjs` (validate/registry/conflict/remote/register/migrate/owner); 6 fixtures; `.agent/project.json` mẫu.
- [x] `scripts/test-project-registry.mjs` 32/32 PASS (AC1–AC9); đăng ký vào full-verify `optionalSuites`.
- [x] `pnpm verify` **94/94 PASS exit 0**.
- [ ] Commit + push; mở Draft PR `Ref #14`; handoff GPT (`agent:gpt` + `status:review-requested`).
- [ ] CHỜ: GPT review; approval qua `gpt-approval.mjs` (user-relay) → user merge. Không merge/deploy.


## 26/08/2026 08:14 — Chạy orchestrator pre-review PR #16 HEAD 27196ed → PRE_REVIEW_FINDINGS (fail-closed) — DECISION GATE

- [x] GPT re-review vòng 8 (comment PR #16 issuecomment-5418794712): TECHNICAL_PASS / APPROVAL_BLOCKED_BY_PROTOCOL — [076] resolved, 0 Critical/Important; chỉ thiếu marker `PRE_REVIEW_PASS:27196edc018448acd16643cbdf25ede0a98ec843`.
- [x] Chạy `node scripts/unified-orchestrator.mjs --execute` tại HEAD `27196edc018448acd16643cbdf25ede0a98ec843` (config targetRepos tạm đổi sang AI_PR_REVIEWER, gỡ `agent:gpt` để orchestrator xử lý; sau đó restore cả hai).
- [x] Kết quả: **PRE_REVIEW_FINDINGS (3 critical, openBlocking=3, outcome=request-fix)**. 3 findings đều FALSE POSITIVE: secret-scanner flag test fixtures giả trong `scripts/test-project-registry.mjs` dòng 66/134/137 (`'AKIAIOSFODNN7EXAMPLE'`, `'sk-1234567890abcdef'` — key giả để test AC4/AC10 của chính bộ quét). KHÔNG phải rò rỉ thật.
- [x] Orchestrator deterministic fail-closed: set `status:changes-requested` + post comment issuecomment-5419225160. KHÔNG handoff GPT, KHÔNG merge/deploy, KHÔNG sửa code. Config + Temp đã restore/dọn.
- [ ] DECISION GATE (Mức 3): Bố chọn (A) chấp nhận false positive + thủ công post marker/restore labels, (B) sửa test fixtures placeholder rồi re-run orchestrator, hoặc (C) để nguyên fail-closed chờ GPT. PR state: `agent:cline` + `status:changes-requested`.

## 26/08/2026 (tiếp) — PR #17 GPT-REV-078/079/083/084 hardening (sau CHANGES_REQUESTED) — COMPLETED (handoff GPT)
- [x] Sóc re-review PR #17: CHANGES_REQUESTED (đóng 077/080/081/082; mở 078 Critical, 079/083/084 Important + doc watchdog).
- [x] 078: `contract.mjs` takeoverLock dùng guard file `gateway.takeover.lock` (`openSync('wx')` atomic) serialize contenders; re-check `isLockAlive` dưới guard; stale → unlink rồi `wx`-create, yield nếu EEXIST (KHÔNG ghi đè lock đang sống). Thêm `TAKEOVER_GUARD` const.
- [x] 079: `supervisor.mjs` `runSupervisorOnce` ghi nhận pid child, chỉ claim `recovered` khi lock ready ĐÚNG pid child (khác → `already-ready-other`, không kill); thêm `computeBackoff` (cấp số nhân, clamp 5p) + `isCircuitOpen` (≥5 fail/10p) chống restart storm.
- [x] 083: `notifier.mjs` `sendItem` skip duplicate vẫn `dequeue` pending → queue không tăng mãi.
- [x] 084: `gateway.mjs` inboundLoop duyệt `[APP_NS, ...listApps()]` (ai-pr-reviewer + qldadtxd + ...), mỗi ns lỗi không sập loop ns khác; export `listInboundNamespaces`.
- [x] Docs: `AGENT_HANDOFF_PROTOCOL.md` bỏ ref `watchdog-hibernate.mjs` (đã xóa); README thêm 083/084.
- [x] Tests: `test-telegram-gateway.mjs` 22/22 (+6: 078-clobber, 079-proof×2, 079-backoff, 083, 084); `test-gateway-mp.mjs` 9/9 (+1 qldadtxd inbound); `full-verify` 116/116; `pnpm test` 192/192 PASS.
- [x] Commit `9978677` push `eb05ab4..9978677` (fix/issue-15-telegram-gateway). Comment CLINE-FIX trên PR #17. Labels Issue #15 = `agent:gpt`+`status:review-requested` (đúng). Notify Telegram 816272951 EXIT=0.
- [ ] Chờ GPT re-review tại HEAD `9978677`. KHÔNG merge/deploy/approve. Soak test máy thật vẫn là bước thủ công trước xóa `notify-telegram.mjs` legacy.
## 28/08/2026 01:53 — PR #21 vòng review-fix GPT-REV-094..097 (Issue #19 Phase 2 MCP + temp-hygiene)
- GPT CHANGES_REQUESTED (0 Critical, 4 Important): redact-bypass (opLogExcerpt/collectFindings), findReport thiếu binding + nondeterministic headSha, recoverSession xóa dir khi mất manifest, cleanup read-back thiếu workspace baseline.
- Fix + verify: 4 file code — `mcp-test-evidence/server.mjs`, `scripts/temp-hygiene.mjs` + 2 test; `full-verify` 128/128, temp-hygiene 54/54, mcp-test 35/35. Đang commit/push/handoff GPT.

## 01/09/2026, 11:02 — Issue #36 manual GPT approval path hoàn tất (handoff GPT)
- `performManualApproval` 9-step fail-closed + `enabled` gate (`manualException.enabled === true`), `isManualApprovalValid`/Part2, `computePolicyDigest`/`stableStringify`.
- Policy `manualException` schema (enabled:false mặc định). Test `test-gpt-approval-manual-exception.mjs` 23/23 PASS; `pnpm test` 24/24; `pnpm verify` 151/151 + e2e 23 assertions 0 failures.
- Commit `58b0b93` push; Draft PR #37 `Ref #36`; Issue #36 -> `agent:gpt` + `status:review-requested`.

## 01/09/2026, 23:55 — Issue #38 reviewer-principal cho manual GPT approval hoàn tất (full-verify 161/161)
- Tách reviewer-principal khỏi operator/transport: evidence artifact JSON structured + exact-bind (repo/pr/head/policyVersion/policyDigest/decisionId); `isReviewerAuthorized` thực thi `reviewerAuthorityAllowlist` + self-author reject + issuer match; fail-closed khi allowlist rỗng.
- Bounded TTL: `manualException.activationTtlSeconds: 3600` → audit entry `expiresAt`; anti-replay (scan all entries theo decisionId); expired → `EXCEPTION_EXPIRED`; same-target PASS → idempotent; different-target PASS → `REPLAY_CONFLICT`.
- Policy: `approvalAuthorities.reviewerAuthorityAllowlist: []` (fail-closed); `enabled` giữ false; không đổi policyVersion.
- Tests: `test-gpt-approval-evidence.mjs` mới 41 case (contract + verifyGptEvidence real); manual-exception 40/40; regress 25/25; full-verify 161/161 PASS.
- Chi tiết: activeContext.md mục `Issue #38`.

- Chi tiết: activeContext.md mục `Issue #36`.
