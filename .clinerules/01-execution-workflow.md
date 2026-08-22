# QUY TRÌNH PHẢN HỒI, LẬP KẾ HOẠCH VÀ THỰC THI

## 1. Nguyên tắc chung
- Luôn giao tiếp tiếng Việt.
- Đọc Memory Bank trước khi bắt đầu task (theo `02-memory-bank.md`).
- Không hỏi lại thông tin đã có trong repository hoặc Memory Bank.
- Không dừng giữa task chỉ để xin phép bước tiếp theo, trừ Decision Gate Mức 3 (xem §5).
- Hoàn thành task với mức tự chủ cao nhưng không tự ý thay đổi yêu cầu.

## 2. Phân loại task
- **Task nhỏ**: phạm vi rõ, ít bước, implementation path hiển nhiên, không ảnh hưởng architecture/data/security → thực hiện ngay.
- **Task phức tạp**: nhiều bước/file/module, dependency, workflow, test hoặc rủi ro đáng kể → phân tích + lập kế hoạch ngắn trước khi sửa.

## 3. Chế độ Duyệt trước / Tự hành (phân tách kênh — triệt tiêu xung đột)

### 3.1. VSCode UI — Duyệt trước (chờ duyệt)
Khi người dùng chủ động chọn chế độ Duyệt trước (VSCode Plan Mode):
1. Phân tích yêu cầu + repository.
2. Xác định điểm mơ hồ quan trọng; nếu cần, hỏi người dùng.
3. Lập plan, ghi vào `memory-bank/activeContext.md`.
4. Trình bày plan.
5. **Dừng chờ** người dùng chuyển sang Tự hành. Không tự chuyển Duyệt trước→Tự hành.
6. **CẤM TUYỆT ĐỐI thay đổi file khi đang ở Duyệt trước** (rule chống tái phạm — Bố chốt 17/08/2026 sau vụ sửa trái phép):
   - Plan mode chỉ được: đọc/khảo sát repository, phân tích, hỏi làm rõ, viết nội dung plan vào `activeContext.md`.
   - **CẤM**: chỉnh sửa/ghi đè MỌI file code/config/HTML/markdown (kể cả `progress.md`, `taskHistory-*.md`, script), chạy lệnh mutation (clasp push/deploy, tạo/xóa file), tự chuyển chế độ.
   - Mọi sửa đổi chỉ được thực hiện sau khi người dùng chủ động chuyển sang Act mode (Tự hành).
   - Nếu phát hiện đã vô tình sửa file khi ở Plan mode: dừng ngay tại ranh giới an toàn, báo người dùng, đề xuất phương án (giữ nguyên / revert) — không tự quyết định tiếp tục sửa.

### 3.2. Telegram `[NEW]` — Tự hành (không chờ)
Khi task khởi tạo từ lệnh Telegram `[NEW]` (có `msg_id`):
1. Tự lập plan nội bộ.
2. Gửi báo cáo kế hoạch về DM Bố (`node scripts/notify-telegram.mjs`).
3. **Chuyển thẳng sang thực thi** — không chờ phê duyệt.
4. Sau hoàn thành: `node scripts/telegram-bridge.mjs --reply <msg_id> "✅ <kết quả đã verify>"`.

Nếu trong lúc tự hành phát sinh vấn đề Mức 3 (Decision Gate — xem §5): tạm dừng riêng bước đó, gửi câu hỏi qua scripts/progress-report.mjs tới DM Bố, và chờ trả lời trước khi tiếp tục bước đó. Các bước khác không phụ thuộc vào quyết định này vẫn có thể tiếp tục song song. Không tự ý quyết Mức 3 chỉ vì đang ở kênh tự hành.

### 3.3. Tự hành (mọi kênh khác)
- Task nhỏ → thực hiện ngay.
- Task phức tạp → lập plan nội bộ, thực thi ngay (không dừng chờ, không bước xin phê duyệt).

## 4. Câu hỏi trước khi thực thi
Chỉ hỏi khi thiếu thông tin làm thay đổi đáng kể kết quả: yêu cầu nghiệp vụ chưa xác định, nhiều hướng sản phẩm, architecture decision quan trọng, thay đổi data/schema, security boundary, destructive action, scope chưa xác định. Gom nhiều câu hỏi thành 1 lần.
Không hỏi: tên biến/hàm nội bộ, thứ tự bước đã xác định, implementation tương đương, lỗi kỹ thuật tự chẩn đoán được, quyết định styling/implementation thường.

## 5. Tự chủ trong execution
- Tuân thủ plan; tự quyết implementation details; tự chẩn đoán/sửa lỗi trong scope; không hỏi xác nhận từng bước; không dừng chỉ vì thấy technical debt.
- Mức độ vấn đề:
  - **Mức 1** (nhỏ, an toàn): sửa luôn.
  - **Mức 2** (ngoài scope, không nghiêm trọng): ghi `Deferred Issue`, tiếp tục.
  - **Mức 3** (lớn: requirement/business/architecture/data/security/destructive/scope): dừng và hỏi người dùng (Decision Gate).

- **Decision Gate** (cơ chế cho Mức 3):
  - Hỏi qua `scripts/progress-report.mjs` gửi tới DM Bố (`816272951`).
  - **Không có timeout tự động** — chờ vô thời hạn tới khi Bố phản hồi.
  - Trong lúc chờ: **KHÔNG** được tự suy diễn câu trả lời để tiếp tục task.
  - Áp dụng cả khi đang ở kênh tự hành Telegram (xem §3.2).
  - **Hook trước khi hỏi**: bất kỳ câu hỏi nào dành cho Bố (Decision Gate hay thường) → BẮT BUỘC chạy `node scripts/telegram-bridge.mjs --process` trước. Nếu có lệnh `[NEW]` mới hơn (msg_id > câu hỏi đang chuẩn bị): ưu tiên xử lý lệnh đó trước, rồi gộp câu hỏi vào 1 tin — tránh 2 luồng chờ lẫn nhau.
  - **Quy trình batch thay đổi** (khi sửa nhiều lỗi/thay đổi nhỏ đã rõ nguyên nhân trong cùng 1 phạm vi file/module): gom lại sửa 1 lượt rồi chạy `full-verify.mjs` 1 lần, thay vì verify sau mỗi thay đổi đơn lẻ — vẫn giữ ranh giới 1 giai đoạn = 1 commit. Chỉ tách verify riêng khi 1 thay đổi có rủi ro cao/không chắc chắn, cần cô lập để dễ xác định nguyên nhân nếu fail.

## 6. Giữ phạm vi
Không tự mở rộng task để refactor/đổi naming/tối ưu ngoài phạm vi. Chỉ sửa vấn đề ngoài scope nếu nó trực tiếp ngăn task hoàn thành hoặc là lỗi nhỏ an toàn sửa nhanh.

## 7. Hoàn thành & Báo cáo
Chỉ kết thúc khi: task/plan hoàn thành; kiểm tra phù hợp đã chạy; evidence đã ghi; Memory Bank đã cập nhật; deferred issues quan trọng đã ghi nhận.
- **Cấm báo hoàn thành chỉ vì context compact/tràn** (xem `02-memory-bank.md` §9).
- **Báo cáo từng bước**: sau mỗi milestone, `node scripts/progress-report.mjs --force "<tiêu đề>" "<chi tiết>"` (DM Bố `816272951`).
- **Gộp báo cáo milestone**: các milestone cách nhau <3 phút → gộp thành 1 lần gửi (1 lệnh `--force` cho cả nhóm) để tránh spam Telegram.
- **Báo cáo tổng kết**: khi task xong, `node scripts/notify-telegram.mjs "<tiêu đề>" "<tóm tắt>"` (script tự arm watchdog 90p). Nếu thiếu token trong `~/.qldadtxd/tg.json` → ghi nợ nhắc Bố.

### Ma trận script Telegram & Watchdog
| Script | Mục đích | Kênh / Chat ID | Kích hoạt |
|---|---|---|---|
| `scripts/telegram-bridge.mjs` | Hàng đợi lệnh 2 chiều (`--listen`, `--process`, `--reply`) | Trả lời đúng `chat_id` nguồn chứa `msg_id` | Khởi động phiên / xử lý task Telegram `[NEW]` |
| `scripts/progress-report.mjs` | Báo cáo tiến độ từng bước/milestone | Chỉ DM Bố `816272951` | Ngay sau mỗi bước (cờ `--force`) |
| `scripts/notify-telegram.mjs` | Báo cáo kế hoạch + tổng kết hoàn thành; `--event <json>` dùng chuẩn message + chống gửi trùng | Chỉ DM Bố `816272951` | Sau lập kế hoạch / khi task xong (tự arm watchdog) |
| `scripts/tg-notify-core.mjs` | Lõi thuần: `buildMessage`, `eventKey`(idempotency `repo::ref::event::state`), `NotificationStore`, watchdog silence levels | — | Test: `pnpm test:tg` |
| `scripts/watchdog-hibernate.mjs` | Daemon tự ngủ đông + theo dõi im lặng (daemon gửi `timeout-level1/2` đúng 1 lần/cấp, `--heartbeat` reset khi Cline hoạt động, heartbeat không guard = no-op) | Ngầm hệ thống | `shutdown /h` khi hết hạn, không lệnh mới, máy idle |

### Mở rộng §7 — Protocol thông báo (Issue #16)
Tại mọi điểm dừng/chờ/bàn giao, trước khi kết thúc phiên hoặc gửi Telegram:
1. Cập nhật GitHub (issue/PR state) trước, rồi mới gửi Telegram.
2. Gửi đúng 1 lần bằng `node scripts/notify-telegram.mjs --event '<json>'` với
   `{eventType, repo, ref, state, summary, nextAction, link}`. Nếu shell nuốt dấu nháy kép
   (PowerShell 5.1 native arg) → ghi JSON ra file tạm và dùng `--event-file <path>`. Magic semantics:
   - Khóa idempotency `repo::ref::eventType::state` (ghi `~/.qldadtxd/notify-keys.json`) → event trùng trạng thái không gửi lại; state thay đổi → gửi lại hợp lệ.
   - Retry sau lỗi gửi được phép; retry sau đã SENT không tạo tin thứ 2 (mark SENT chỉ khi gửi thành công).
   - `nextAction` luôn nêu rõ người dùng cần làm tiếp (nhất là `needs-input`/`blocked`).
3. Không kết thúc phiên nếu notifier FAIL (fail-closed): ghi bằng chứng, không báo hoàn thành.
4. Cline hoạt động lại giữa chừng → `node scripts/watchdog-hibernate.mjs --heartbeat` để reset watchdog im lặng, tránh gửi cảnh báo timeout cũ.

**Ma trận sự kiện → Telegram → GitHub state** (fixture test trong `scripts/test-tg-notify.mjs`):

| Sự kiện `eventType` | Telegram nội dung tối thiểu | GitHub state tương ứng |
|---|---|---|
| `start` | Bắt đầu Issue + ref | `status:in-progress` |
| `needs-input` | Câu hỏi rõ ràng + `nextAction` | `status:needs-user-input` |
| `blocked` | Nguyên nhân + bước cần làm | `status:blocked` |
| `done` | Issue, PR, kết quả test | `status:ready-for-gpt-review` |
| `test-fail` | Tóm tắt lỗi + link/evidence | không báo hoàn thành |
| `resume` | Xác nhận đã tiếp tục | `status:in-progress` |
| `timeout-level1` / `timeout-level2` | Cảnh báo im lặng (lần 1 / nghiêm trọng); không tự kết luận | không tự đổi state |

*Lưu ý bảo mật*: KHÔNG gửi báo cáo task con/tiến độ vào group `QLDA_DDIC` (`-5403998356`). Group chỉ nhận báo cáo nghiệp vụ từ Web App.

## 8. Tự ngủ đông (watchdog)
- `notify-telegram.mjs` tự arm watchdog 90 phút (`~/.qldadtxd/guard.json`, daemon `watchdog-hibernate.mjs`).
- Trong 90p: lệnh mới `[NEW]` hoặc `--cancel` → hủy ngủ đông.
- Hết hạn + máy idle ≥30p → `shutdown /h`; máy đang dùng → hoãn 30p.
- Không tự ý vô hiệu watchdog; muốn tắt phải hỏi Bố.

## 9. Quy tắc Git
- Commit message viết tiếng Anh theo chuẩn Conventional Commits; giao tiếp với Bố trong chat vẫn luôn tiếng Việt (§1 không áp dụng cho nội dung commit).
- Không tự commit nếu người dùng không yêu cầu.
- Dùng Conventional Commits khi được yêu cầu commit.
- Không commit khi lint/test/build đang fail.
- Không tự ý dùng lệnh Git destructive (`git push -f`, `git reset --hard`, `git clean -fd`).
- Không reset/xóa thay đổi của người dùng nếu chưa có chỉ thị rõ ràng.

## 10. Auto-Boot (khởi động mỗi phiên — 1 chu kỳ Telegram duy nhất)
1. Chạy một chu kỳ kiểm tra Telegram: `node scripts/telegram-bridge.mjs --listen` rồi `node scripts/telegram-bridge.mjs --process`.
2. Nếu `--process` exit code `3` → có lệnh `[NEW]`: đọc `~/.qldadtxd/inbox.md`, lấy `msg_id`, coi nội dung message là **Primary Task Instruction**, thực thi theo §3.2, reply `--reply <msg_id>` khi xong.
2b. **GitHub task intake (read-only)**: chạy `node scripts/github-task-intake.mjs`. Nếu ra `TASKS_FOUND` với đúng 1 Issue `agent:cline + status:ready-for-cline` → chạy `node scripts/github-task-intake.mjs --claim <số>` để claim, xác nhận `CLAIMED` bằng read-after-write (labels từ xa đúng `agent:cline` + `status:in-progress`), rồi thực thi task theo §13. Nếu `NO_TASK`/`BLOCKED_MULTIPLE_TASKS`/`BLOCKED_DIRTY_WORKTREE` → xử lý theo trạng thái và tiếp tục.
2c. **Preflight workspace/Git trước mọi mutation khi `--claim` (Issue #20)**: trước khi `--claim` đụng bất kỳ mutation git/GitHub nào, chạy `runPreflight()` (thứ tự chặn cố định — xem §13 "Khi bắt đầu"). Mọi trạng thái chặn đều fail-closed: KHÔNG đổi label, không tạo branch, không fetch-tự-động-sửa, không reset/stash/clean. Nếu bị `BLOCKED_MULTIPLE_WORKSPACES` (phát hiện workspace anh em cùng remote canonical trong thư mục cha) → dừng, báo Bố xin phép dọn/di chuyển các clone cũ hoặc xác nhận `GITHUB_TASK_INTAKE_ALLOW_MULTI=1` — không tự xóa.
3. Đọc Memory Bank (`memory-bank/activeContext.md`, `memory-bank/progress.md`).
4. Xác định trạng thái hiện tại (task, project, bước done/todo, evidence, next step) — không hỏi lại context recoverable.
5. **Context Routing — tra `PROJECT_MAP.md`** (Issue #14): xác định feature/module từ Issue; tra `PROJECT_MAP.md` TRƯỚC khi global search hoặc đọc toàn bộ source. Chỉ đọc node chính + dependency trực tiếp. Ghi khối `[CONTEXT-SCOPE]` trong plan gồm: selected nodes; source blocks/files; targeted tests; lý do mở rộng phạm vi (nếu có). Chỉ global search khi: không tìm được node, marker `map-stale` (`pnpm test:map`), hoặc bằng chứng cho thấy dependency ngoài map. Trong khi sửa chỉ chạy targeted tests của node; full test chạy 1 lần trước bàn giao.
6. **Chính sách tài liệu (Issue #17, REV-026)**: Auto-Boot KHÔNG quét toàn bộ `docs/**`. `docs/reference/**` và `docs/archive/**` KHÔNG nằm trong `.clineignore` — việc đọc **tường minh từng tài liệu theo chỉ định** (Issue hiện tại, `PROJECT_MAP.md`, dependency, hoặc đường dẫn cụ thể) luôn được phép; policy chỉ giới hạn **quét tự động**. `docs/archive/**` KHÔNG được dùng làm nguồn xác định trạng thái hiện tại. Ưu tiên đọc: Issue hiện tại → `PROJECT_MAP.md` → Memory Bank active → source/test → tài liệu được chỉ định. Nếu tài liệu mâu thuẫn với source/acceptance criteria → báo mâu thuẫn, không lấy tài liệu thắng.
## 11. Operating Loop
```
AUTO-BOOT → Telegram --process
  → [NEW]? ─YES─> Process Telegram → Reply → tiếp tục công việc khác
            ─NO──> GitHub task intake (read-only) → [TASKS_FOUND đúng 1]? ─Y─> claim --claim <số> → task mới theo §13
  → Load Memory Bank
  → Inspect State → Reconcile Repository
  → Xác định kênh: Duyệt trước (VSCode Plan) / Tự hành (mọi kênh khác)
       Duyệt trước (VSCode UI) → Create Plan → WAIT (chờ user chuyển sang Tự hành)
       Tự hành → Execute → Milestones
              → [NEW]? ─Y─> Process Telegram trước (hook §11a) → quay lại task
              → Verify → Evidence PASS?
                  NO  → Fix / Continue
                  YES → Update Memory
                       → [NEW]? ─Y─> Process Telegram mới → task mới
                       → Progress Report (DM Bố, mỗi milestone)
                       → Telegram Reply nếu có msg_id
                       → COMPLETE
```
**Final Rule**: KHÔNG chuyển trực tiếp EXECUTION→COMPLETE. Bắt buộc VERIFY → EVIDENCE → MEMORY UPDATE → (Progress Report) → COMPLETE. Compact/context-pressure KHÔNG được dùng làm cớ báo hoàn thành.

**GitHub task intake (checkpoint an toàn)**: chạy lại `node scripts/github-task-intake.mjs` (read-only) tại các điểm an toàn trong vòng lặp (sau milestone lớn, trước kết thúc phiên) — KHÔNG poll dày, KHÔNG chạy song song khi daemon/task khác đang mutation. Telegram Decision Gate vẫn ưu tiên. Giới hạn: cơ chế KHÔNG thể đánh thức Cline/VS Code đang tắt; chỉ tự nhận khi Cline đang chạy hoặc phiên mới Auto-Boot.

## 11a. Hook quét Telegram giữa task (Cách a — Bố chốt 16/08/2026)
Mục đích: nhận lệnh Telegram cả khi Cline đang giữa task, không chỉ lúc Auto-Boot. Chi phí 0 — `--process` đọc file local, không token/time đáng kể.
- **Chạy `node scripts/telegram-bridge.mjs --process` tại các điểm sau** (kể cả khi không có task Telegram đang xử lý):
  1. Sau mỗi milestone lớn (trước Verify tiếp theo nếu thuận tiện).
  2. Trước khi báo cáo tổng kết/hoàn thành task.
  3. Trước khi kết thúc phiên làm việc.
  4. Trước mọi câu hỏi gửi Bố (xem hook §5 Decision Gate).
- **Khi `--process` exit code `3`** → có `[NEW]` mới hơn msg đang xử lý: tạm dừng task hiện tại ở ranh giới milestone an toàn, xử lý lệnh Telegram trước (theo §3.2), reply xong rồi quay lại task cũ. Không nhảy giữa chừng mutation/verify.
- **Lưu ý bảo mật/độ tin cậy**:
  - CẤM chạy `--listen`/probe getUpdates song song khi daemon đang chạy → Telegram 409 conflict, daemon miss lệnh.
  - `--process` chỉ đọc; `--listen` mới gọi API. Luồng chuẩn giữa task: chỉ `--process` (không cần `--listen` vì daemon đã poll sẵn).

## 12. Context Budget Checkpoint (flush memory + compact chủ động)
- **Lý do**: agent không đo được chính xác token context → dùng heuristic; auto-condense của Cline chưa đáng tin (session hay bị `stale_session_reconciler` giết, reason `failed_external_process_exit`) → phải chủ động checkpoint TRƯỚC khi chạm trần, không lệ thuộc auto-condense.
- **Ngưỡng** (ước lượng theo context window bar + số milestone trong session; mặc định model act 256k → token ước tính theo ~70%):
  - *Soft (~70% context ≈ 180k/256k tokens / sau 3 milestone lớn)*: chuẩn bị checkpoint — rà còn bao nhiêu việc, dựng ranh giới dừng.
  - *Hard (~180k tokens với model context 256k, bar gần đầy)*: **BẮT BUỘC DỪNG** tại ranh giới milestone an toàn (kết thúc milestone, KHÔNG dừng giữa chừng mutation/verify dở dang). Nếu model context khác 256k → lấy ~70% context của model hiện hành.
- **Quy trình checkpoint**:
  1. Dừng task con tại điểm an toàn; nếu đang giữa mutation → hoàn tất/rollback trước khi dừng.
  2. Flush Memory Bank: cập nhật `activeContext.md` (trạng thái hiện tại + evidence + next step), `progress.md`, `taskHistory.md` (nếu có decision/root cause đáng ghi).
  3. Ghi rõ dòng `Checkpoint: context sắp đầy, flush <giờ>` vào `activeContext.md`.
  4. Chủ động compact: nếu bản Cline đang chạy có lệnh compact thủ công → thực hiện; không có → báo Bố + restart session, rồi recovery theo `02-memory-bank.md` §8.
- **Nhỏ task (bắt buộc)**: mỗi đơn vị công việc phải **khép kín trong 1 vòng đời context** — hoàn thành + ghi memory + boundary rõ ràng. Task lớn bắt buộc chia chunk nhỏ; cấm để 1 task kéo dài vượt context mà không có checkpoint giữa chừng.
- **Sau checkpoint/restart**: Auto-Boot (§10) đọc Memory Bank → tiếp tục từ "Bước tiếp theo" ghi trong `activeContext.md`. Không hỏi lại context recoverable.

## 13. GitHub Handoff — phối hợp GPT ↔ Cline

- Giao thức đầy đủ: đọc `docs/AGENT_HANDOFF_PROTOCOL.md` khi task có GitHub Issue, Pull Request hoặc label `agent:*` / `status:*`.
- GitHub Issue là nguồn sự thật của phạm vi và tiêu chí nghiệm thu cho task được giao qua GitHub.
- Chỉ nhận task khi Issue có đủ:
  - `agent:cline`;
  - `status:ready-for-cline`;
  - phạm vi được phép;
  - vùng không được thay đổi;
  - tiêu chí nghiệm thu.
- Khi bắt đầu:
  1. Đọc toàn bộ Issue và comment mới nhất.
  2. Reconcile Issue với repository và Memory Bank.
  3. Nếu mâu thuẫn không thể tự giải quyết, gắn `status:blocked` và hỏi người dùng — **BẮT BUỘC** gửi Telegram qua `node scripts/notify-telegram.mjs` (GPT-REV-006): kiểm tra exit code, ghi `SENT`/`FAILED` vào Memory Bank; `telegram-bridge.mjs --process` không phải bằng chứng đã thông báo.
  4. Claim khi repository **sạch** + HEAD hợp lệ (không detached) + đang ở `main`/`master` — tự động qua `node scripts/github-task-intake.mjs --claim` (Idempotent, fail-closed, read-after-write, marker `cline-claim` đi kèm verify labels `agent:cline` + `status:in-progress`; marker có nhưng labels sai → `BLOCKED_READBACK_MISMATCH`) hoặc thủ công bằng `gh issue edit`; chỉ báo `CLAIMED` khi labels từ xa xác nhận. **KHÔNG yêu cầu task branch/upstream tồn tại trước claim**; đang ở branch task cũ hoặc detached HEAD → chặn (`BLOCKED_ACTIVE_ISSUE_BRANCH` / `DETACHED_HEAD`).
  4b. **Preflight bắt buộc (Issue #20 — workspace/Git sạch trước mọi mutation)**: `--claim` chỉ mutation sau khi `runPreflight()` trả `PREFLIGHT_OK`. Thứ tự chặn cố định (dừng tại điều kiện đầu tiên vi phạm, fail-closed):
     - `ERROR_GIT` — không xác định được repo root (KHÔNG suy đoán từ tên thư mục).
     - `BLOCKED_WRONG_REMOTE` — `origin` không phải canonical `duongpdddic-droid/QLDA_DTXD`.
     - Branch safety — `main`/`master` OK (Auto-Boot claim được); branch task cũ → `BLOCKED_ACTIVE_ISSUE_BRANCH`; detached → `DETACHED_HEAD`.
     - `BLOCKED_DIRTY_WORKTREE` — working tree bẩn ngoài allowlist (mặc định `memory-bank/`); liệt kê file chặn; KHÔNG tự reset/stash/clean.
     - `ERROR_FETCH` (fetch thất bại → chặn, không đoán) và `BLOCKED_STALE_BASE` — HEAD lệch `origin/main` sau fetch; KHÔNG tự reset/rebase.
     - `BLOCKED_MULTIPLE_WORKSPACES` — phát hiện workspace anh em cùng remote canonical trong thư mục cha (Issue #14: `PROJECT_MAP.md` route). Chỉ 1 workspace vận hành duy nhất được claim; cần Bố cho phép dọn/di chuyển các clone cũ HOẶC xác nhận đặt `GITHUB_TASK_INTAKE_ALLOW_MULTI=1` (ghi rõ lý do) — Cline KHÔNG tự xóa.
     - `BLOCKED_REPO_MISMATCH` (GPT-REV-027) — repo cho MỌI GitHub read/mutation phải là repo parse từ origin đã qua preflight; `GITHUB_REPOSITORY` không được tin độc lập: có mà khác origin canonical → chặn trước mọi comment/label/mutation. Không còn khái niệm đổi canonical bằng env.
     - Env test-only (CHỈ hiệu lực khi `GITHUB_TASK_INTAKE_TEST=1` — fixture/mock gh, cấm đặt ở production): `GITHUB_TASK_INTAKE_SKIP_REMOTE`, `GITHUB_TASK_INTAKE_SKIP_FETCH`, `GITHUB_TASK_INTAKE_PARENT`. `GITHUB_TASK_INTAKE_REMOTE_REPO` đã bị XÓA (canonical chỉ từ hằng + tham số DI). `GITHUB_TASK_INTAKE_ALLOW_MULTI` là escape hatch production CHỈ khi Bố chỉ định. CLI production luôn: đọc origin thật → kiểm tra canonical → fetch thật → đối chiếu HEAD với `origin/main` (GPT-REV-028).
  5. Sau khi biết Issue number: tạo nhánh riêng từ `main` mới nhất (`fix|feat|chore/issue-<số>-<mô-tả>`) rồi bắt đầu sửa.
- Khi bàn giao:
  1. Chạy các quality gate áp dụng.
  2. Mở Draft Pull Request bằng `.github/PULL_REQUEST_TEMPLATE.md`.
  3. Liên kết Issue bằng `Ref #<issue-number>` (chỉ `Closes #` khi PR hoàn tất trọn vẹn Issue).
  4. Ghi commit và bằng chứng kiểm tra thật.
  5. Chuyển sang `status:review-requested` (REV-ISSUE-2: reviewer:local là PRE-reviewer —
     CI verification fail-closed + pre-review deterministic, chỉ phát `PRE_REVIEW_PASS` |
     `PRE_REVIEW_FINDINGS`, KHÔNG BAO GIỜ gắn `status:approved`; GPT (`agent:gpt`) là reviewer
     phê duyệt cuối DUY NHẤT, approval ghi qua `scripts/gpt-approval.mjs` khóa full HEAD SHA +
     policyVersion; quy tắc canonical: `.github/ai-review-policy.json`).
  6. KHÔNG gửi báo cáo Telegram khi tạo Issue hay trong lúc thực hiện Issue — orchestrator chỉ
     notify sau mutation thành công (script retry tối đa 3 lần, kiểm tra exit code). Riêng
     `status:blocked`/Decision Gate vẫn hỏi người dùng theo §5.
- Reviewer tự hành: orchestrator `scripts/unified-orchestrator.mjs` tự xử lý PR
  `status:review-requested` (CI → `status:reviewing` → pre-review → bàn giao GPT hoặc trả Cline
  `[LOCAL-REV-NNN]` qua nhãn PR — KHÔNG tạo issue [review-fix]); KHÔNG chờ hỏi người dùng đồng ý,
  KHÔNG tự merge/deploy/approve.
- Decision Gate/blocked (mọi kênh): dừng và hỏi người dùng theo §5.
- Khi nhận review:
  - Xử lý từng finding theo mã `[LOCAL-REV-NNN]`.
  - Phản hồi bằng `[CLINE-FIX-NNN]`, commit, nội dung sửa và kết quả kiểm tra; push thẳng lên
    branch của PR.
  - Không tự resolve thread nếu chưa có bằng chứng.
- Giới hạn:
  - Không tự merge vào `main`.
  - Không tự `clasp push` hoặc deploy.
  - Không sửa ngoài phạm vi Issue.
  - Tối đa `maxReviewRounds` (policy) vòng review–fix; vượt giới hạn phải chuyển `status:blocked`.
- **Phân vai approval (REV-ISSUE-2)**:
  - CI PASS không sinh approval; chỉ cho phép `status:reviewing`.
  - Chỉ GPT approval cuối; approval khóa HEAD SHA — HEAD đổi là vô hiệu, GPT phải review lại.
  - Approval-drift: PR `status:approved` thiếu marker hợp lệ → orchestrator gỡ hiệu lực tự động.
  - Merge/deploy luôn thuộc người dùng.


