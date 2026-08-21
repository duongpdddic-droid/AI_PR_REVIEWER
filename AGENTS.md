# AGENTS.md — Quy tắc dự án (tóm tắt từ Cline `.clinerules`)

> File này do Kilo tự động tải mỗi phiên. Nội dung là bản **tóm tắt** 7 rule file của Cline
> trong `.clinerules/`. Khi cần chi tiết/chính xác, **đọc file gốc tương ứng** — không đoán.
> Khi sửa rule: sửa CẢ `.clinerules/<file>.md` VÀ phần tóm tắt này để không lệch nhau.
> Nguyên tắc nền: luôn giao tiếp tiếng Việt; Repository là truth cho code; Memory Bank là
> truth cho trạng thái thực thi/plan/decision/evidence.

---

## Cốt lõi áp dụng mọi lúc (inline)

- **Giao tiếp**: luôn tiếng Việt với Bố.
- **Trước task**: đọc `memory-bank/activeContext.md` → `progress.md`; reconcile với repo (repo thắng nếu mâu thuẫn). Không hỏi lại thông tin đã có trong repo/Memory Bank.
- **Chống ảo giác**: KHÔNG báo hoàn thành nếu chưa **verify + evidence**. `COMPLETE` chỉ hợp lệ khi: implementation tồn tại + verification PASS + Memory Bank ghi. Thiếu mắt xích → báo `IN PROGRESS` + next step.
- **Phân loại & tự chủ**: Task nhỏ → làm ngay. Task phức tạp → plan rồi làm. Mức 1 (nhỏ/an toàn) sửa luôn; Mức 2 (ngoài) nhỏ → ghi Deferred; Mức 3 (lớn/security/destructive/scope) → **dừng hỏi user (Decision Gate)**.
- **Giữ scope**: không tự mở rộng refactor/đổi naming/tối ưu ngoài phạm vi.
- **Plan mode (Duyệt trước)**: CHỈ đọc/phân tích/ghi plan vào `activeContext.md`. **CẤM sửa mọi file** cho đến khi user chuyển sang Act/Tự hành.
- **Git**: Conventional Commits (tiếng Anh); không tự commit nếu chưa yêu cầu; không tự ý destructive (`push -f`, `reset --hard`, `clean -fd`); không commit khi lint/test/build fail.
- **Secret**: TUYỆT ĐỐI không in/log giá trị thật token/key/password/file cấu hình ra chat — chỉ tham chiếu tên file.
- **Coding**: dùng `pnpm` (cấm npm/yarn); file text UTF-8 **không BOM**; JS `let/const` (không `var`), `camelCase`; **XSS**: ưu tiên `.textContent` > `createElement` > `innerHTML` (cấm innerHTML với dữ liệu user/API).
- **Terminal**: Windows PowerShell; cấm `grep/sed/awk/head/tail/cat`; cấm `node -e`; cấm tự chạy lệnh destructive/power-state.
- **GAS/clasp**: trước push chạy `node scripts/full-verify.mjs` (chỉ push khi exit 0); dùng `pnpm exec clasp` (cấm `npx clasp`).

---

## Tóm tắt 7 rule file (chi tiết đọc file gốc)

**01-execution-workflow.md** — Quy trình phản hồi/lập kế hoạch/thực thi.
- Task nhỏ/phức tạp; chế độ Duyệt trước (cấm sửa file) vs Tự hành.
- Decision Gate Mức 3 → hỏi user, không tự quyết. Batch sửa rồi verify 1 lần.
- Hoàn thành: verify → evidence → Memory Bank → báo cáo. Không lấy compact/context-pressure làm cớ báo xong.
- GitHub task intake: Auto-Boot/checkpoint an toàn chạy `node scripts/github-task-intake.mjs` (read-only); claim khi đúng 1 Issue `agent:cline + status:ready-for-cline` (`--claim`, idempotent + fail-closed + read-after-write). **Preflight workspace/Git bắt buộc trước mọi mutation khi `--claim` (Issue #20)**: repo root xác định bằng git (không đoán), remote phải canonical, branch `main`/`master`, worktree sạch ngoài allowlist `memory-bank/`, base không lệch `origin/main` (fetch fail-closed), tối đa 1 workspace cùng remote trong thư mục cha (`BLOCKED_MULTIPLE_WORKSPACES` — cần Bố cho phép dọn hoặc `GITHUB_TASK_INTAKE_ALLOW_MULTI=1`); không tự reset/stash/clean. Repo cho mọi GitHub read/mutation = repo từ origin (không tin `GITHUB_REPOSITORY` độc lập → `BLOCKED_REPO_MISMATCH` khi env lệch origin); env test-only `SKIP_REMOTE`/`SKIP_FETCH`/`PARENT`/`REMOTE_REPO` không bypass được production (chỉ hiệu lực với `GITHUB_TASK_INTAKE_TEST=1`, `REMOTE_REPO` đã xóa). Không poll dày; không đánh thức Cline/VS Code đang tắt.
- Context Routing (Issue #14): tra `PROJECT_MAP.md` TRƯỚC global search/đọc toàn bộ source khi sửa chức năng; chỉ đọc node chính + dependency trực tiếp; ghi khối `[CONTEXT-SCOPE]` trong plan; chỉ targeted tests trong lúc sửa, full test 1 lần trước bàn giao; `pnpm test:map` phát hiện `map-stale`.
- Chính sách tài liệu (Issue #17/REV-026): KHÔNG quét toàn bộ `docs/**`; `docs/reference/**` + `docs/archive/**` không nằm trong `.clineignore` — đọc tường minh theo chỉ định (Issue/`PROJECT_MAP.md`/dependency/path) được phép; `docs/archive/**` không phải nguồn xác định trạng thái hiện tại.
- Context Budget Checkpoint: ~70% context → dừng tại ranh giới milestone an toàn, flush Memory Bank rồi compact/restart.
- *(Đã cắt: §10 Auto-Boot Telegram `--listen`, §11a hook Telegram giữa task, §7–8 watchdog `shutdown/hibernate` — Cline-specific, không áp dụng Kilo.)*

**02-memory-bank.md** — Cấu trúc & duy trì Memory Bank (`memory-bank/`).
- File: `activeContext` (trạng thái/plan/evidence/next step), `progress`, `taskHistory`(+`-YYYY-MM`), `projectbrief`, `productContext`, `systemPatterns`, `techContext`, `consolidatedLearnings`; `PROJECT_ANALYSIS.md` ở root.
- `activeContext.md`: mỗi bước `[x]` cần evidence (file/change/verification). Archive định kỳ khi quá 5 entry.
- Quy trình: Inspect → Plan → Execute → Verify → Record. Sau xong: cập nhật activeContext/progress/taskHistory. Recovery sau restart: đọc Memory Bank → reconcile repo → tiếp từ Next Step.

**03-coding-standards.md** — Tiêu chuẩn lập trình & frontend.
- `camelCase`/`UPPER_SNAKE_CASE`/`PascalCase`/`kebab-case`; `get/fetch/calculate/is/has/validate` naming.
- API error envelope `{success, error:{code,message,details?,traceId}}`; không trả 200 cho lỗi.
- Frontend vanilla: XSS hierarchy, event delegation, A11y (alt/label), CSS custom props, state-first.
- Quality gate: `pnpm lint` / `pnpm test` / `pnpm build` nếu có.

**04-security-and-secrets.md** — Bảo mật.
- OWASP: parameterized query, authz tại service layer, không hardcode secret, không log PII.
- Cấm in secret ra chat (§2). Audit: Recon → OWASP A01–A07 → secrets scan regex → STRIDE → severity CRITICAL/HIGH/MEDIUM/LOW.

**05-terminal-safety.md** — An toàn shell.
- PowerShell, ưu tiên tool tích hợp; cấm `grep/sed/awk/head/tail/cat`, `node -e`; cấm tự destructive/power-state (trừ chỉ thị rõ ràng + task xong + báo trước).

**06-gas-deployment.md** — Google Apps Script.
- `pnpm exec clasp`; `.clasp.json` rootDir trỏ thư mục có `appsscript.json`.
- Trước push: `node scripts/full-verify.mjs` (node --check + BOM + dup fn/id); push `--force`; deploy giữ ID.
- GAS blocking → không `async/await`; batch `getValues/setValues`; `LockService` khi ghi đồng thời; secret → `PropertiesService`; web app trailing `?` + `text/plain`; `try/catch` log lỗi.

**07-testing-strategy.md** — Kiểm thử & code review.
- Test là deliverable; thực chứng trước khi tuyên bố xong.
- Phân tầng: Unit/syntax (`full-verify.mjs`) → Integration (CSV→Sheet, mã tham chiếu) → E2E (manual Web App).
- Bắt buộc test: happy/edge/error/state-transition. Review: Critical/Important/Suggestion; mỗi finding có file+dòng+vấn đề+rủi ro+fix.

---

## Memory Bank (single source of truth)
Kilo dùng `memory-bank/*.md` theo rule 02 ở trên — đọc/ghi trực tiếp bằng file tools.
Kilo native store (`project.md`/`environment.md`) chỉ là **index nhẹ** (xem `memory_bank_files`, `memory_bank_path`), không trùng lặp dữ liệu.

---

## Định tuyến Cline vs Kilo (agent tự phân loại)
Vì Bố không phân biệt task nặng/nhẹ, **agent tự đánh giá và CẢNH BÁO nếu đang sai tool**.
- **Chuyển Cline khi**: sửa `QLDA_DDIC.html` / `Backend/*.js`; `clasp push`/`deploy`; chạy `node scripts/full-verify.mjs`; task đa bước/dài hạn cần memory bank đầy đủ + checkpoint; cần tuân thủ NGHIÊM guardrail (secret/plan-mode/decision-gate); automation Telegram/watchdog.
- **Giữ Kilo khi**: task nhanh/hẹp (đọc hiểu code, tra cứu, sửa lỗi nhỏ, snippet, giải thích); CLI nhẹ; fan-out nhiều task (Agent Manager); review nhanh.
- **Quy tắc an toàn**: nếu đang ở Kilo mà task chạm deploy clasp / Telegram bridge / thay đổi lớn → **dừng, báo Bố chuyển Cline**. Ngược lại nếu ở Cline mà chỉ hỏi tra cứu → vẫn làm được, nhưng có thể gọn hơn ở Kilo.
- Cả hai dùng chung `memory-bank/` (single source of truth); không ghi đè lệch nhau.

---

## GitHub Handoff — GPT ↔ Cline

Giao thức đầy đủ nằm tại `docs/AGENT_HANDOFF_PROTOCOL.md`.

- GPT chịu trách nhiệm phân tích, tạo Issue, xác định phạm vi, review và nghiệm thu kỹ thuật.
- Cline chịu trách nhiệm sửa code, chạy kiểm tra, commit, push và bàn giao qua Draft Pull Request.
- GitHub Issue là nguồn sự thật của phạm vi và tiêu chí nghiệm thu cho task GitHub.
- Pull Request là nguồn sự thật của diff, bằng chứng kiểm tra và review thread.
- GitHub Actions là bằng chứng kiểm tra độc lập.
- Người dùng giữ quyền quyết định merge, `clasp push`, deploy và thao tác ảnh hưởng dữ liệu.
- Cline chỉ nhận task có `agent:cline` và `status:ready-for-cline`.
- Cline tự phát hiện/claim Issue hợp lệ tại Auto-Boot và checkpoint an toàn qua `scripts/github-task-intake.mjs` (read-only mặc định; claim chỉ sau preflight workspace/Git PASS: repo root xác định bằng git, remote canonical `duongpdddic-droid/QLDA_DTXD`, branch `main`/`master`, worktree sạch ngoài allowlist `memory-bank/`, base không lệch `origin/main`, tối đa 1 workspace cùng remote trong thư mục cha — nếu không: `BLOCKED_WRONG_REMOTE` / `BLOCKED_ACTIVE_ISSUE_BRANCH` / `DETACHED_HEAD` / `BLOCKED_DIRTY_WORKTREE` / `ERROR_FETCH` / `BLOCKED_STALE_BASE` / `BLOCKED_MULTIPLE_WORKSPACES` / `BLOCKED_REPO_MISMATCH` (khi `GITHUB_REPOSITORY` lệch origin canonical — repo read/mutation luôn từ origin), fail-closed không mutation; env test-only `SKIP_REMOTE`/`SKIP_FETCH`/`PARENT` chỉ hiệu lực với `GITHUB_TASK_INTAKE_TEST=1` — CLI production không bypass remote/fetch bằng env; idempotent, read-after-write trước khi báo `CLAIMED`, marker đi kèm verify labels; task branch được tạo sau claim khi biết Issue number).
- `agent:local-reviewer` | Reviewer AI_PR_VIEWER, quyền đồng đẳng với GPT | AI_PR_VIEWER

- Khi bàn giao, Cline chuyển sang `status:review-requested` và `agent:gpt`, **BẮT BUỘC** gửi thông báo Telegram (`node scripts/notify-telegram.mjs`, kiểm tra exit code, ghi `SENT`/`FAILED`); khi `status:blocked`/Decision Gate cũng gửi Telegram. `telegram-bridge.mjs --process` không phải bằng chứng đã thông báo.
- GPT dùng finding `[GPT-REV-NNN]`; Cline phản hồi `[CLINE-FIX-NNN]`.
- Không tự merge, không tự deploy, không sửa ngoài phạm vi Issue.
- Tối đa ba vòng review–fix; vượt giới hạn hoặc có mâu thuẫn phải chuyển `status:blocked`.
