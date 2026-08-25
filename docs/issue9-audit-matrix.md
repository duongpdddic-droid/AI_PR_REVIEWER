# Audit Matrix — Issue #9 (Nâng cấp Agent Harness có chọn lọc)

module-version: 3 (REV-3 sau GPT review PR #10 — GPT-REV-066/067)

Ngày audit: 25/08/2026. Cơ sở: source `AI_PR_REVIEWER` tại HEAD sau Issue #6 (`7a6dc78`→`fbe5b05`),
Issue #9, `.github/ai-review-policy.json`, `docs/AGENT_HANDOFF_PROTOCOL.md`.
Tham khảo pattern (chỉ lấy ý tưởng, không fork): `shareAI-lab/learn-claude-code`,
`thedotmack/claude-mem`.

## Ma trận primitive

| # | Primitive | Trạng thái | Bằng chứng hiện tại | Quyết định |
|---|-----------|------------|---------------------|------------|
| 1 | Skill/selective loading | EXISTING | `scripts/context-router.mjs` + `scripts/context-manifest.json` (Issue #6): bootstrap + invariants luôn tải, routing theo taskType, budget fail-closed `BLOCKED_BUDGET_EXCEEDED`; test `test-context-routing.mjs` | Không đụng — đã chuẩn |
| 2 | Context compact (working-context) | MISSING | Không có module nào giới hạn/compact lịch sử làm việc; chỉ có rule thủ công `.clinerules` §12 cho harness Cline | **Triển khai** `context-manager.mjs`: budget + compact bảo toàn SHA/finding-ID/Decision-Gate/AC mở + evidence compaction |
| 3 | Progressive disclosure | PARTIAL | Router #6 chọn module theo taskType tĩnh; chưa có retrieval theo nhu cầu (tag/query) trong tập đã nạp | **Triển khai** `selectiveLoad()` trong `context-manager.mjs` (tag/query-driven, vẫn enforce budget) |
| 4 | Persistent memory | PARTIAL | `memory-bank/*.md` là curated human-readable (giữ nguyên theo C5); `tg-notify-core.mjs#NotificationStore` có pattern JSON-store idempotent nhưng scope notification; không có store có provenance/consolidation/bounded-growth dùng chung | **Triển khai** `memory-core.mjs`: JSONL append-only, consolidation dedupe/supersede/cap, provenance bắt buộc, cấm lưu verdict CI/approval/authorization, graceful degradation |

| 5 | Lifecycle observation | MISSING | Không có event → observation → store pipeline; observation ad-hoc trong Memory Bank do người viết | **Triển khai tối thiểu**: `appendObservation()` trong `memory-core.mjs` (queue in-process, ghi qua wrapper degrade, không block caller) — KHÔNG dựng background worker framework (mục H) |
| 6 | Error classification/recovery | PARTIAL | Có bounded review-fix rounds (`autonomous-core.mjs`: `planReview`, `MAX_FIX_ROUNDS=3`) và claim fail-closed; KHÔNG có taxonomy lỗi runtime (RATE_LIMIT/TIMEOUT/…) hay recovery policy phân biệt retry/backoff/compact/fallback/escalate | **Triển khai** `error-recovery.mjs`: `classifyError()` + `planRecovery()` bounded, không round-robin mù, identity giữ nguyên, kèm telemetry |
| 7 | Coder ↔ Reviewer protocol | EXISTING | `review-contract.mjs`: `resolveRebuttalOutcome` (FIX cần evidence; REBUT cần reviewer verdict ACCEPTED/REJECTED; dispute escalate `agent:gpt`+`status:blocked`), finding 5 trường bắt buộc, severity canonical; labels state machine; approval khóa HEAD SHA (`gpt-approval.mjs`) | Không đụng — đủ theo mục E (APPROVE/REQUEST_CHANGES/BLOCKED ánh xạ nhãn status hiện hữu) |
| 8 | Task state/persistence | EXISTING | GitHub authoritative: Issue/PR/labels/CI/read-after-write/idempotency key (`unified-orchestrator.mjs`, `tg-notify-core.mjs#eventKey`) | Không đụng — đúng nguyên tắc 1 |
| 9 | Worktree isolation | EXISTING | Preflight `github-task-intake.mjs`: repo root từ git, branch safety, dirty-worktree allowlist, stale base sau fetch, multi-workspace detect, không tự reset/stash/clean (fail-closed) | Không đụng — lifecycle allocate→cleanup đã phủ bởi preflight + branch-per-issue; nâng cấp thêm = YAGNI |
| 10 | Permission/policy gates | EXISTING | `effective-policy.mjs` resolve canonical fail-closed; `gpt-approval.mjs` duy nhất được ghi approval, khóa full HEAD SHA + policyVersion; policy `.github/ai-review-policy.json` | Không đụng — fallback/recovery mới KHÔNG chạm gate này |
| 11 | Structured telemetry | PARTIAL | Chỉ notification events (idempotency + watchdog silence); không có record execution/recovery theo model/provider/error-class | **Triển khai** `recordExecutionEvent()` + `summarizeByProvider()` trong `error-recovery.mjs`, redact secret |

## Baseline metrics (trước implementation)

- Hỏi người dùng trong workflow thường: do thiết kế Decision Gate (Mức 3) — không đo tự động được, giữ nguyên hành vi.
- Recovery transient failure: orchestrator chỉ có retry vòng fix (≤3); lỗi gh/network transient → fail ngay.
- Telemetry structured: 0 record execution/recovery (baseline rỗng).
- Context budget: chỉ budget tĩnh per-task (#6), không đo trước/sau compact.

Sau implementation đo được bằng test fixture: memory retrieval precision, số record telemetry,
token trước/sau compact. Không đặt con số cải thiện giả định (mục K).

## NOT_NEEDED (cố ý bỏ, kèm lý do)

- Background worker/queue daemon cho observation (mục H cấm framework cron tổng quát; in-process queue đủ).
- Vector DB / Chroma / embedding (C3: chưa benchmark chứng minh metadata+FTS thiếu).
- SQLite native binding (cần dependency build; JSONL stdlib đủ quy mô hiện tại — upgrade khi vượt vài nghìn records).
- Claude Code clone / multi-agent swarm / TodoWrite riêng / MCP mới / Docker (mục H).
- Nâng cấp worktree lifecycle (dòng 9): preflight đã chặn đủ trạng thái nguy hiểm; metadata store riêng không tăng an toàn thực tế.
- Thay Memory Bank bằng memory layer mới (C5 cấm xóa/migrate trong Issue này).

## Kiến trúc minimal chốt

3 module pure-core (Node stdlib, injectable IO, cùng phong cách `context-router.mjs`/`review-contract.mjs`)
+ 1 facade runtime + 4 test file assert-based (không framework):

```text
scripts/context-manager.mjs   — compactTranscript() + selectiveLoad() (B1/B2)
scripts/memory-core.mjs       — createMemoryStore/fsJsonlIo/consolidateMemories/
                                retrieveMemories/resolveState/withGracefulDegradation (C1–C5)
scripts/error-recovery.mjs    — classifyError/planRecovery/recordExecutionEvent/
                                summarizeByProvider/redactSecrets/redactDeep (D/G)
scripts/runtime-hooks.mjs     — createRuntimeHooks(): facade nối 3 module vào execution path
scripts/autonomous-run.mjs    — WIRED: coder bounded recovery (hooks.recover) +
                                verify-fail telemetry + session-summary observation + consolidate
```

## Runtime wiring (REV-2 — GPT-REV-059)

Các primitive KHÔNG còn là thư viện rời: `createRuntimeHooks({ rootDir })` tạo persistence
thật NGOÀI worktree tại `<homedir>/.agent-runtime/<basename>-<sha1-12(rootDir)>/{observations.jsonl,events.jsonl}`
qua `fsJsonlIo()` (node:fs) — **GPT-REV-063**: runtime state không bao giờ bị `git add -A`
nhặt vào commit hay làm dirty worktree; override bằng `{runtimeDir}` (test). Mọi telemetry
write path, gồm `recover()`, đi qua duy nhất `recordEvent()`/`redactDeep()` — **GPT-REV-062**.
Điểm nối trong `autonomous-run.mjs` (`processOneCycle`, chỉ nhánh execute):
- **Coder prompt** → `buildCoderContext()` (bootstrap/invariants + `selectiveLoad()` theo tag
  trên section issue body + `compactTranscript()` enforce budget 6000 tokens) — **GPT-REV-064**;
  overBudget → escalate `BLOCKED_CONTEXT_OVERBUDGET` (không gửi nguyên context); action
  `compact-then-retry` → rebuild budget nửa + telemetry `outcome=context-compaction`.
- **Startup capsule đo được** — **GPT-REV-065**: tổng payload harness-controlled (message +
  file `--read` inline) đo bằng `buildStartupCapsule()`; conventions ≤2000t mới inline,
  lớn hơn → pointer trong prompt (KHÔNG `--read` toàn file); vượt
  `CODER_STARTUP_BUDGET_TOKENS` (env override, mặc định 12000) kể cả sau compact → escalate
  `BLOCKED_CONTEXT_BUDGET`, không im lặng gửi payload lớn. Unresolved findings/open AC lấy từ
  authoritative GitHub comments (`fetchUnresolvedFindings()`: verdict MỚI NHẤT của mỗi mã
  `[GPT-REV-NNN]` thắng, RESOLVED bị loại, gh lỗi → degrade rỗng) truyền vào protected entries.
  Dedupe content-hash (`sha1`) chặn nạp lặp cùng nội dung trong 1 task. Telemetry bắt buộc
  mỗi lần gửi: `startupContextTokens`, `loadedModules`/`loadedSections`, `loadedMemoryCount`,
  `beforeCompactTokens`/`afterCompactTokens` (cả nhánh compaction), `loadReasons`,
  `findingsSource`; Aider tự nạp context ngoài khả năng đo → `externalContextUnknown=true`
  (không tuyên bố đạt budget tổng khi chưa đo được). Benchmark INT: issue raw ~84k token →
  startup 101 token, critical spans (SHA/Decision Gate/AC/scope) nguyên vẹn.
- **Coder fail** → `classifyError()` → `hooks.recover()` (planRecovery bounded ≤3 attempt,
  AUTH_OR_CONFIG_ERROR escalate ngay không bypass) → retry/backoff theo plan; hết budget →
  blocked như cũ. Mỗi lần recover tự ghi event `outcome=recovery:<action>` + identity echo.
- **Verify FAIL mỗi vòng** → `hooks.recordEvent({errorClass, outcome:'verify-fail'})`.
- **BLOCKED_VERIFY / CODER_FAILED** → observation `workflow-failure` vào store.
- **DONE** → observation `session-summary` + `consolidateMemory()` (bounded, atomic rewrite).
- Storage lỗi → mọi hook degrade ({ok:false}), KHÔNG bao giờ block workflow.
Integration test: `test-runtime-hooks.mjs` (temp dir; chứng minh restart/load lại được, event
được lưu, failure không block workflow, recovery sinh telemetry giữ identity).

## Invocation matrix (REV-3 — GPT-REV-066/067)

Mọi lần gọi model coder (initial / verify-fix / compact-retry) đi qua **CÙNG** một entry point
`prepareCoderInvocation()` + `executeCoderInvocation()` — **GPT-REV-067** (xóa `runCoder()`/`runFixCoder()`
tự ghép prompt/`--read` riêng). `fetchUnresolvedFindings()` parse đúng nested `gh api --paginate --slurp`
**GPT-REV-066** và truyền `findingsSource` (`github-comments | github-comments-empty | github-unavailable`).

| Invocation path (production) | Shared capsule (`buildStartupCapsule`) | Budget enforced (`CODER_STARTUP_BUDGET_TOKENS`=12000) | Large file pointer (`conventions` >2000t → pointer, KHÔNG `--read`) | Telemetry (`recordInvocationTelemetry`) | Integration test |
|---|---|---|---|---|---|
| **Initial coder** — vòng 1 `processOneCycle` (findings từ GitHub, conventions, memory selective top-8, headSha) | `invocationKind='initial'`; message = protected findings + issue sections + memory; `readArgs` do capsule quyết định | `overBudget`/`blocked` fail-closed: KHÔNG gọi model, escalate `BLOCKED_CONTEXT_BUDGET` | Có — `conventionsMode='inline'\|'pointer'\|'absent'` | `outcome='startup-context'`, `startupContextTokens`, `loadedMemoryCount`/`loadedEventCount`, `findingsSource`, `externalContextUnknown` | `INT.startup-budget-benchmark`, `REV67.compact-retry-shrunk` (initial leg), `REV67.memory-count-accurate` |
| **Verify-fix loop** — mỗi vòng verify FAIL (`--message` + tail 800t `verifyFailure`) | `invocationKind='verify-fix'`; cùng capsule, KHÔNG call site tự ghép | Cùng budget; blocked → `BLOCKED_CONTEXT_BUDGET` (không fallback model) | Có — xác nhận `readArgs=[]` với conventions lớn (sửa regress REV-067) | `outcome='startup-context'`, `invocationKind='verify-fix'`, `modelCalled` | `REV67.fix-loop-big-conventions` |
| **Compact-then-retry** — sau `compact-then-retry` recovery | `invocationKind='compact-retry'`; `retryBudget` = nửa budget, reuse context compact NHỎ HƠN, spans còn | Cùng budget (budget đã giảm nửa) | Có | `outcome='startup-context'`, `beforeCompactTokens`/`afterCompactTokens`, `invocationKind` | `REV67.compact-retry-shrunk` |
| **Blocked (over-budget)** — mọi path vượt budget kể cả sau compact | `blocked=true` → executor trả `{called:false, blocked:true, error:'BLOCKED_CONTEXT_BUDGET'}` TRƯỚC khi chạm runner | Fail-closed tuyệt đối: model KHÔNG được gọi | n/a (không gửi payload) | `outcome='startup-context-blocked'`, `overBudget=true`, `modelCalled=false` | `REV67.over-budget-blocked-no-model` |
| **Cross-entry dedupe** | `message` sau `dedupeLinesAcross()` — cùng dòng ở issue/findings/memory chỉ 1 lần | Không đổi (dedupe giảm token) | n/a | `loadReasons` ghi selective retrieval | `REV67.cross-entry-dedupe` |
| **Findings parse (authoritative)** | `findingsSource` truyền vào capsule protected entry | n/a | n/a | `findingsSource` trong event | `REV66.*` (8 case) + `INT.unresolved-findings-retrieval` |

Ranh giới an toàn:
- Policy/CI/approval gates KHÔNG đổi; memory bị chặn lưu verdict loại authoritative
  (`ci-verdict`, `approval`, `merge-authorization`) — chỉ lưu pointer (URL/SHA) kèm thời điểm đọc.
- `resolveState()`: mâu thuẫn memory vs evidence GitHub → GitHub thắng (stale-memory test).
- `planRecovery()` mặc định KHÔNG fallback chain → escalate BLOCKED; fallback chỉ chạy khi
  chain khai báo tường minh + policy gate còn hiệu lực; identity (taskId/baseSha) truyền thẳng.

## Mapping AC → implementation/test/evidence (REV sau implementation, 25/08/2026)

| AC (Issue #9) | Implementation | Test | Evidence |
|---|---|---|---|
| B1 compact không mất state quan trọng | `compactTranscript()` (`context-manager.mjs`): PROTECTED_KINDS + protected spans (full SHA 40 hex, `[LOCAL-REV-n]`/`[CLINE-FIX-n]`/`GPT-REV-n`, Decision Gate) trích nguyên văn vào tombstone summary; AC mở `- [ ]` protect cả entry; **overBudget=true cho MỌI trường hợp vượt budget (GPT-REV-060)** | `test-context-manager.mjs` §1–§5 + §9–§11 âm: summary đẩy vượt budget vẫn overBudget; mọi case vượt đều có cờ | `node scripts/test-context-manager.mjs` → 11 PASS; `node scripts/full-verify.mjs` → 89/89 PASS, exit 0 |
| B2 progressive disclosure | `selectiveLoad()` tag-driven; invariant luôn tải (không bị budget chặn); candidate hết budget → skipped; **trả `overBudget` khi invariants vượt để caller escalate (GPT-REV-060)** | test §6–§7 + §10: invariant luôn tải kể cả budget=5 và báo overBudget; fail-closed `BLOCKED_BUDGET_INVALID` | như trên |
| B3 long-task không mất unresolved findings | Thuật toán duyệt mới→cũ, protected không drop; summary ghi evidence compaction `[compacted N entries …]` | test §1 fixture 81 entries có `[LOCAL-REV-003]` giữa transcript dài | như trên |
| C1 memory không fake CI verdict/approval | `validateObservation()`: cấm kind `ci-verdict`/`approval`/`merge-authorization` (check TRƯỚC ALLOWED_KINDS — lỗi tường minh riêng); cho phép kind `pointer` tham chiếu URL/SHA | `test-memory-core.mjs` §2: 3 kind cấm đều bị từ chối kèm thông điệp "cấm lưu"; pointer hợp lệ | `node scripts/test-memory-core.mjs` → 10 PASS |
| C2 append không hỏng workflow | `createMemoryStore().append()` không ném; **default IO = `fsJsonlIo()` ghi byte thật (GPT-REV-059); io thiếu hàm ghi → `stored:false, reason:'no-storage-io'` — KHÔNG còn no-op báo stored giả**; storage failure → `{stored:false, reason:'storage-failure: …'}` | test §3–§4: thiếu provenance/ts → stored:false; IO fail (EACCES/EDISK) → graceful; integration INT.observation-persists + INT.no-silent-store chứng minh ghi thật + sống qua restart | như trên |
| C4 consolidation bounded | `consolidateMemories()`: supersede theo subjectKey (mới thắng), dedupe contentKey (chuẩn hoá hoa/thường + khoảng trắng), cap maxEntries bỏ cũ nhất | test §6: supersede/dedupe/cap 50→10; §7 retrieval precision fixture (top hit đúng chủ đề, query lệch → rỗng) | như trên |
| Stale memory: GitHub thắng | `resolveState()`: authoritativeEvidence != null → source 'github', `memoryWasStale` phát hiện lệch | test §8: memory claim "approved" vs evidence "OPEN" → GitHub thắng | như trên |
| Memory lỗi không chết harness | `withGracefulDegradation()`: async throw → `{ok:false, degraded:true, fallbackValue}` | test §9 (IIFE async): wrapper trả degraded:true, happy path value 42 | như trên |
| D taxonomy đầy đủ | `classifyError()`: 9 lớp canonical (RATE_LIMIT/TIMEOUT/PROVIDER_ERROR/EMPTY_RESPONSE/INVALID_TOOL_CALL/CONTEXT_OVERFLOW/REPEATED_REASONING/AUTH_OR_CONFIG_ERROR/UNKNOWN) | `test-error-recovery.mjs` §1–§2: injection 429/ETIMEDOUT/502/rỗng/unknown-tool/context-length/401/lạ | `node scripts/test-error-recovery.mjs` → 13 PASS |
| Recovery bounded + không round-robin mù | `planRecovery()`: maxAttempts mặc định 3; AUTH_OR_CONFIG escalate ngay; CONTEXT_OVERFLOW/REPEATED_REASONING → compact-then-retry rồi escalate; RATE_LIMIT backoff exponential cap 60s; fallback chỉ khi chain tường minh + chưa thử + `policyGate.passing===true`; identity echo nguyên vẹn mọi nhánh; **CHẠY THẬT trong `autonomous-run.mjs` qua `hooks.recover()` (GPT-REV-059)** | test §3–§9 + integration `test-runtime-hooks.mjs` INT.recovery-*: recovery sinh telemetry, identity giữ nguyên, AUTH fail-closed không fallback | như trên |
| G telemetry structured, redact secret | `recordExecutionEvent()` (schema cố định + trường lạ giữ sau redact), **`redactDeep()` đệ quy object/array có depth/cycle/node guard (GPT-REV-061)**, `redactSecrets()` (GitHub token/sk-key/Bearer trần/key=value shapes), `summarizeByProvider()` thống kê theo provider/model | test §10–§13: secret lồng trong `toolFailure.stderr`/array/unknown field bị redact hết; circular → `[Circular]` không treo; oversized → `[TRUNCATED]`; integration INT.event-redacted-on-disk chứng minh trên đĩa không còn secret gốc | như trên |
| Verify gate tổng | **4 suite** đăng ký vào `optionalSuites` trong `full-verify.mjs` | — | `node scripts/full-verify.mjs` → **89/89 PASS, exit 0** |

Đo đạc fixture (không con số giả định): compact giữ trong budget với state được bảo toàn;
telemetry baseline 0 record → schema record có sẵn để runtime dùng.
