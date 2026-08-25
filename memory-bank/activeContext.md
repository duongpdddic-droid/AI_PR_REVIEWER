## 25/08/2026 12:20 (ACT) — Issue #9 REV-4: fix GPT-REV-065 startup context trên PR #10

- **Mục tiêu**: [GPT-REV-065] Important — startup ~50k token/task; budget 6000 chỉ đo message; thiếu unresolved findings vào capsule, telemetry tổng, dedupe, benchmark before/after.
- **Kế hoạch & trạng thái**:
  1. [x] `buildStartupCapsule()`: đo TỔNG payload harness-controlled (message + `--read` inline); conventions ≤2000t mới inline, lớn → pointer KHÔNG `--read`.
  2. [x] Budget tổng fail-closed `CODER_STARTUP_BUDGET_TOKENS` (env, mặc định 12000); vượt → escalate `BLOCKED_CONTEXT_BUDGET` + label blocked + Telegram.
  3. [x] `fetchUnresolvedFindings()`: comments GitHub authoritative, verdict MỚI NHẤT mỗi mã `[GPT-REV-NNN]` thắng; RESOLVED loại; gh lỗi degrade rỗng. Wire thật trong executeIssue.
  4. [x] `dedupeByHash()` sha1 — cùng content không nạp lặp trong 1 task.
  5. [x] Telemetry `outcome=startup-context`: `startupContextTokens`, `loadedModules`/`loadedSections`, `loadedMemoryCount`, `beforeCompactTokens`/`afterCompactTokens`, `loadReasons`, `findingsSource`; aider tự nạp → `externalContextUnknown=true`.
  6. [x] Benchmark INT: issue raw ~337k ký tự (~84k tokens) → startup **101 tokens** (≤12k, giảm ~99.9%); critical spans nguyên vẹn; history không nạp toàn bộ; retry nhỏ hơn. Thêm 2 test retrieval/dedupe-pointer.
  7. [x] Verify: test-runtime-hooks **13/13 PASS**; full-verify **89/89 PASS exit 0**; CI Verify CI success HEAD `260ab3d15af63314694afff142c0a0d9d8dbf2df`.
  8. [x] Bàn giao: commit `260ab3d` push; comment `[CLINE-FIX-065]` (issuecomment-5405750436); labels read-back `agent:cline`+`status:review-requested`. Audit matrix đồng bộ section Startup capsule.
- **Bước tiếp theo**: chờ orchestrator pre-review + GPT review vòng 4 tại HEAD `260ab3d`; approval qua `gpt-approval.mjs` (user-relay) → user merge. Không merge/deploy.

---

## 25/08/2026 09:35 (ACT) — Issue #9 REV-2: fix 3 finding GPT review PR #10 (GPT-REV-059/060/061)

- **Mục tiêu**: xử lý 3 finding Important từ GPT review PR #10 tại HEAD `05e12cf…`; sửa trên cùng PR, KHÔNG mở PR mới.
- **Kế hoạch & trạng thái**:
  1. [x] [GPT-REV-060] `context-manager.mjs`: `overBudget = totalTokens > budgetTokens` cho MỌI trường hợp vượt (bỏ điều kiện protected); `selectiveLoad()` trả thêm `overBudget` khi invariants vượt. Test âm mới §9–§11.
  2. [x] [GPT-REV-061] `error-recovery.mjs`: thêm `redactDeep()` đệ quy (depth ≤6, node ≤500, circular → `[Circular]`, oversized → `[TRUNCATED]`); `recordExecutionEvent()` redact đệ quy mọi giá trị; regex Bearer trần. Test §11–§13.
  3. [x] [GPT-REV-059] `memory-core.mjs`: default IO = `fsJsonlIo()` (node:fs thật), io thiếu hàm ghi → `stored:false 'no-storage-io'`; tạo `runtime-hooks.mjs` (`createRuntimeHooks()`: recordObservation/recordEvent/recover/consolidateMemory/loadEvents) persistence tại `.agent/runtime/*.jsonl`.
  4. [x] Wire runtime: `autonomous-run.mjs` — coder bounded recovery qua `hooks.recover()` (≤3 attempt, AUTH escalate ngay), verify-fail telemetry, workflow-failure observation khi BLOCKED, session-summary + consolidate khi DONE; storage lỗi không block workflow.
  5. [x] Integration test mới `test-runtime-hooks.mjs` (7 case): restart/load lại được, event lưu đĩa không còn secret, recovery sinh telemetry giữ identity, AUTH fail-closed, failure degrade, consolidation bounded, no-silent-store. Đăng ký `optionalSuites` full-verify.
  6. [x] Audit matrix module-version 2: sửa claim sai (`appendObservation()` không tồn tại → facade thật), bổ sung section Runtime wiring.
  7. [x] Verify: test-context-manager 11 PASS; test-error-recovery 13 PASS; test-runtime-hooks 7 PASS; test-memory-core 10 PASS; **full-verify 89/89 PASS exit 0**; smoke dry-run autonomous-run OK.
- **Ranh giới giữ nguyên**: fallback không round-robin mù; AUTH_OR_CONFIG_ERROR không bypass; policy gate fail-closed; memory không lưu verdict authoritative.
- **Bước tiếp theo**: commit + push lên branch PR #10 → comment `[CLINE-FIX-059]/[CLINE-FIX-060]/[CLINE-FIX-061]` kèm evidence → labels về `status:review-requested` cho orchestrator pre-review lại.

---

---

## 25/08/2026 11:25 (ACT) — Issue #9 REV-3: fix GPT-REV-062/063/064 trên PR #10

- **Mục tiêu**: xử lý 3 blocker Important vòng GPT re-review REV-2 tại HEAD `d0f7f4e…` (062 recovery telemetry bypass redact; 063 runtime JSONL trong worktree + git add -A; 064 compact/selective chưa nối execution path).
- **Kế hoạch & trạng thái**:
  1. [x] [GPT-REV-062] `runtime-hooks.mjs`: `recover()` KHÔNG còn `appendJsonl` event thô — ghi qua duy nhất `recordEvent()` → `recordExecutionEvent()` → `redactDeep()`. Test `INT.recover-redacts-identity`: secret lồng identity/fallbackChain không lên đĩa.
  2. [x] [GPT-REV-063] persistence mặc định NGOÀI worktree: `<homedir>/.agent-runtime/<basename>-<sha1-12(rootDir)>/{observations,events}.jsonl`; override `{runtimeDir}`; `commitAndPush()` unstage `.agent/runtime` phòng hờ legacy. Test `INT.runtime-outside-worktree`: git status sạch sau khi ghi state + persist qua restart.
  3. [x] [GPT-REV-064] `autonomous-run.mjs`: `buildCoderContext()` = bootstrap/invariants + findings protected + `selectiveLoad()` tag ac/scope/test (scope=invariant) trên section issue body → `compactTranscript()` budget 6000 tokens. Coder loop dùng context budget-enforce; overBudget → escalate `BLOCKED_CONTEXT_OVERBUDGET`; action `compact-then-retry` → rebuild budget nửa + telemetry `context-compaction` persist. Test `INT.coder-context-budget`.
  4. [x] Verify: test-runtime-hooks **10/10 PASS**; **full-verify 89/89 PASS exit 0**; smoke dry-run autonomous-run OK; CI Verify CI **success** tại HEAD `025e66b7a0db8d2b351778d380014f7e69112031`.
  5. [x] Bàn giao: commit `025e66b` push `d0f7f4e..025e66b`; comment `[CLINE-FIX-062]/[CLINE-FIX-063]/[CLINE-FIX-064]` (issuecomment-5405139219); labels read-back `agent:cline`+`status:review-requested`.
- **Đồng bộ docs**: `issue9-audit-matrix.md` cập nhật persistence ngoài worktree + redact path duy nhất + wiring context budget.
- **Bước tiếp theo**: chờ orchestrator pre-review + GPT review vòng 3 tại HEAD `025e66b`; approval qua `gpt-approval.mjs` (user-relay) → user merge. Không merge/deploy.

---
