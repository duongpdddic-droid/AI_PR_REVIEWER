# GIAO THỨC PHỐI HỢP GPT ↔ CLINE QUA GITHUB

## 1. Mục tiêu

GitHub là kênh trao đổi chính thức giữa GPT và Cline:

- GPT phân tích, tạo đặc tả, review và nghiệm thu.
- Cline sửa code, chạy kiểm tra, commit và bàn giao.
- GitHub Issue lưu yêu cầu và quyết định.
- Pull Request lưu diff, bằng chứng và review thread.
- GitHub Actions kiểm tra độc lập.
- Người dùng giữ quyền quyết định merge và deploy.

## 2. Nguồn sự thật

Thứ tự ưu tiên khi có mâu thuẫn:

1. Code và lịch sử commit trong repository.
2. GitHub Issue đang thực hiện.
3. Pull Request và review thread.
4. `memory-bank/activeContext.md`.
5. Các tài liệu Memory Bank còn lại.
6. Nội dung chat tạm thời.

Không dùng Telegram, file inbox cục bộ hoặc lịch sử chat làm nguồn sự thật chính cho code.

## 3. Vai trò

### GPT và AI_PR_VIEWER

- Phân tích yêu cầu và hiện trạng repository.
- Tạo Issue bằng mẫu `GPT giao việc cho Cline`.
- Xác định rõ phạm vi được sửa và vùng cấm.
- Đưa ra tiêu chí nghiệm thu có thể kiểm chứng.
- Review diff, CI, test và bằng chứng trong Pull Request.
- Tạo finding có mã định danh.
- Chấp thuận kỹ thuật nhưng không tự merge hoặc deploy.

### Cline

- Chỉ nhận task có label `status:ready-for-cline`.
- Đọc toàn bộ Issue trước khi sửa.
- Tạo nhánh riêng từ `main` mới nhất.
- Chỉ sửa trong phạm vi Issue cho phép.
- Chạy kiểm tra và ghi bằng chứng thật.
- Tạo Draft Pull Request liên kết Issue.
- Xử lý review thread theo từng mã finding.
- Không tự merge, deploy hoặc thực hiện thao tác khó hoàn tác.

### Người dùng

- Quyết định khi task bị chặn.
- Phê duyệt thay đổi ngoài phạm vi.
- Quyết định merge vào `main`.
- Quyết định deploy production.
- Quyết định thao tác ảnh hưởng dữ liệu thật.

## 4. Hệ thống label

| Label | Ý nghĩa | Bên xử lý tiếp |
|---|---|---|
| `agent:gpt` | Đang chờ GPT phân tích hoặc review | GPT |
| `agent:cline` | Đang chờ Cline thực hiện | Cline |
| `agent:local-reviewer` | Đang chờ AI_PR_VIEWER phân tích hoặc review | AI_PR_VIEWER |

| `status:ready-for-cline` | Đặc tả đã sẵn sàng | Cline |
| `status:in-progress` | Cline đang thực hiện | Cline |
| `status:review-requested` | Cline đã bàn giao | GPT |
| `status:changes-requested` | GPT yêu cầu sửa lại | Cline |
| `status:approved` | Đạt yêu cầu kỹ thuật | Người dùng |
| `status:blocked` | Cần người dùng quyết định | Người dùng |
| `risk:deploy` | Có thao tác push/deploy production | Người dùng |
| `risk:destructive` | Có thao tác khó hoàn tác | Người dùng |

Một Issue hoặc Pull Request chỉ được có một label `status:*` chính tại một thời điểm.

## 5. Luồng thực hiện chuẩn

1. GPT tạo Issue và gắn:
   - `agent:cline`
   - `status:ready-for-cline`
   - Người dùng xác nhận giao việc với GPT (đặc tả/label do GPT cập nhật) — không cần thao tác GitHub trên điện thoại.
2. Cline nhận task:
   - Tự phát hiện Issue hợp lệ ở Auto-Boot/checkpoint an toàn bằng `node scripts/github-task-intake.mjs` (read-only: trả `NO_TASK`/`TASKS_FOUND`/`BLOCKED_MULTIPLE_TASKS`).
   - Claim bằng `node scripts/github-task-intake.mjs --claim <số>` — chỉ sau **preflight workspace/Git PASS** (Issue #20; trước mọi mutation `runPreflight()` chạy theo thứ tự chặn cố định, fail-closed: (1) repo root xác định bằng `git rev-parse --show-toplevel` — không suy đoán tên thư mục; (2) `origin` phải canonical `duongpdddic-droid/AI_PR_REVIEWER` → nếu không `BLOCKED_WRONG_REMOTE`; (3) branch `main`/`master`, branch task cũ → `BLOCKED_ACTIVE_ISSUE_BRANCH`, detached → `DETACHED_HEAD`; (4) working tree sạch ngoài allowlist mặc định `memory-bank/` → `BLOCKED_DIRTY_WORKTREE` liệt kê file chặn, KHÔNG tự reset/stash/clean; (5) fetch fail-closed + HEAD khớp `origin/main` → `ERROR_FETCH`/`BLOCKED_STALE_BASE`, KHÔNG tự reset/rebase; (6) tối đa 1 workspace cùng remote trong thư mục cha → `BLOCKED_MULTIPLE_WORKSPACES` kèm danh sách clone trùng, cần người dùng cho phép dọn/di chuyển hoặc xác nhận `GITHUB_TASK_INTAKE_ALLOW_MULTI=1` — không tự xóa); **repo dùng cho MỌI GitHub read/mutation = repo parse từ origin đã qua preflight** — `GITHUB_REPOSITORY` không được tin độc lập, nếu có mà lệch origin canonical → `BLOCKED_REPO_MISMATCH` chặn trước mọi comment/label/mutation (GPT-REV-027); env test-only `GITHUB_TASK_INTAKE_SKIP_REMOTE`/`SKIP_FETCH`/`PARENT` CHỈ có hiệu lực khi `GITHUB_TASK_INTAKE_TEST=1` (fixture, cấm production) — CLI production luôn đọc origin thật → kiểm tra canonical → fetch thật → đối chiếu HEAD với `origin/main`, `GITHUB_TASK_INTAKE_REMOTE_REPO` đã xóa (GPT-REV-028); bỏ `status:ready-for-cline`, thêm `status:in-progress`, giữ `agent:cline`; idempotent (chạy lại không claim lần hai), fail-closed, read-after-write trước khi báo `CLAIMED`; đăng marker `<!-- cline-claim:<số>:<baseSA>:<thời điểm> -->` chống trùng. Marker tồn tại phải đi kèm read-back verify labels (`agent:cline` + `status:in-progress`, không còn `ready-for-cline`); marker có nhưng labels sai → `BLOCKED_READBACK_MISMATCH`, không claim lại. Có thể claim thủ công bằng `gh issue edit`. **KHÔNG yêu cầu task branch/upstream tồn tại trước claim** — task branch được tạo sau khi biết Issue number.
   - Không poll dày, không chạy song song gây race; Telegram Decision Gate vẫn ưu tiên. Lock cục bộ ĐẶT NGOÀI worktree (`~/.qldadtxd` hoặc `GITHUB_TASK_INTAKE_LOCK_DIR`) — không bao giờ tự làm repo dirty / tự chặn `--claim` (GPT-REV-009). Cơ chế lock **fail-closed, không auto-takeover** (GPT-REV-010/011): lock chỉ được tạo bằng `openSync('wx')` (atomic) → tối đa 1 holder tại mọi thời điểm; khi lock tồn tại (kể cả PID owner đã chết) mọi lần claim trả `BLOCKED_LOCKED` kèm bằng chứng PID + hướng dẫn xóa file thủ công; `releaseLock` chỉ xóa đúng lock của mình sau khi verify token — caller sai/owner cũ tuyệt đối không làm lock biến mất. Cross-host chống trùng dựa vào marker + read-after-write.
   - **Giới hạn**: cơ chế không thể đánh thức một Cline/VS Code đang tắt; nó chỉ tự nhận khi Cline đang chạy hoặc phiên mới Auto-Boot.
   - Nếu đang ở branch task cũ (không phải `main`/`master`) hoặc detached HEAD → claim chặn (`BLOCKED_ACTIVE_ISSUE_BRANCH` / `DETACHED_HEAD`); phải về `main` sạch rồi claim, sau đó tạo task branch mới.
3. Cline tạo nhánh theo mẫu:
   - `fix/issue-<số>-<mô-tả>`;
   - `feat/issue-<số>-<mô-tả>`;
   - `chore/issue-<số>-<mô-tả>`.
4. Cline sửa code và chạy kiểm tra.
5. Cline mở Draft Pull Request với `Closes #<issue-number>`.
6. Khi sẵn sàng:
   - bỏ `status:in-progress`;
   - thêm `status:review-requested`;
   - chuyển `agent:cline` thành `agent:gpt`;
   - **BẮT BUỘC** gửi thông báo bàn giao qua Telegram (xem §11): `node scripts/notify-telegram.mjs "<tiêu đề>" "<tóm tắt>"` → kiểm tra exit code → ghi bằng chứng `SENT`/`FAILED` vào Memory Bank.
7. GPT review:
   - nếu có lỗi: thêm `status:changes-requested` và `agent:cline`;
   - nếu đạt: thêm `status:approved` và chờ người dùng.
8. Người dùng quyết định merge.
9. Deploy là task riêng, không mặc nhiên xảy ra sau merge.

## 6. Quy tắc review

Mỗi finding của GPT phải có:

- Mã: `[GPT-REV-001]`, `[GPT-REV-002]`...
- Mức độ: Critical, Important hoặc Suggestion.
- File và khu vực liên quan.
- Vấn đề đã xác nhận.
- Rủi ro hoặc hành vi sai.
- Yêu cầu sửa có thể kiểm chứng.
- Điều kiện đóng finding.

Cline phản hồi theo mẫu:

- Mã: `[CLINE-FIX-001]`.
- Commit đã sửa.
- Nội dung sửa.
- Lệnh kiểm tra.
- Kết quả kiểm tra.
- Trạng thái `READY_FOR_REREVIEW`.

Không resolve review thread nếu chưa có commit và bằng chứng tương ứng.

## 7. Quality Gate

PR chỉ đủ điều kiện GPT chấp thuận khi:

- GitHub Actions PASS.
- `pnpm verify` PASS.
- `pnpm test` PASS.
- Quality gate propre aux dự an PASS si applicable.
- Không có review thread Critical/Important chưa xử lý.
- Không có file ngoài phạm vi.
- Không chứa secret, backup, file tạm hoặc log.
- Memory Bank được cập nhật nếu task làm thay đổi trạng thái dự án.

## 8. Decision Gate

Cline và GPT phải dừng, gắn `status:blocked` và hỏi người dùng khi:

- Cần sửa ngoài phạm vi Issue.
- Cần đổi schema hoặc dữ liệu thật.
- Cần deploy hoặc thay đổi deployment production.
- Cần xóa dữ liệu, force-push, reset hoặc thao tác khó hoàn tác.
- Có xung đột giữa yêu cầu và trạng thái repository.
- Vượt quá ba vòng review–fix.
- Một finding thất bại hai lần liên tiếp.

Khi chuyển `status:blocked` hoặc mở Decision Gate: **BẮT BUỘC** gửi Telegram cho người dùng qua `node scripts/notify-telegram.mjs` (tiêu đề ghi `BLOCKED` + Issue/PR, tóm tắt ghi câu hỏi/chặn cần quyết định), kiểm tra exit code và ghi bằng chứng `SENT`/`FAILED` (xem §11).

## 9. Giới hạn vòng lặp

- Tối đa ba vòng GPT Review → Cline Fix cho một PR.
- Không tạo finding mới chỉ để thay đổi phong cách nếu không ảnh hưởng tiêu chí.
- Thay đổi ngoài Issue phải tạo Issue mới hoặc được người dùng duyệt.
- Nếu diff vượt 1.500 dòng hoặc xuất hiện file ngoài phạm vi, dừng review tự động.
- GPT không tự merge.
- Cline không tự deploy.

## 10. Quy tắc hoàn thành

`COMPLETE` chỉ hợp lệ khi có đủ:

1. Implementation tồn tại trong commit.
2. GitHub Actions PASS.
3. Các test áp dụng PASS.
4. Review thread chặn đã được giải quyết.
5. Memory Bank đã ghi nhận.
6. Người dùng đã quyết định merge hoặc xác nhận không cần merge.

Thiếu một điều kiện phải báo `IN PROGRESS`, `CHANGES REQUESTED` hoặc `BLOCKED`.

## 11. Thông báo Telegram khi bàn giao (bắt buộc — GPT-REV-006)

Mục đích: người dùng không mở GitHub mỗi ngày; mọi lần task chuyển trạng thái cần quyết định của con người hoặc bàn giao cho GPT phải có tin Telegram tới DM Bố (`816272951`).

- **Bắt buộc** chạy `node scripts/notify-telegram.mjs "<tiêu đề>" "<tóm tắt>"` khi:
  1. Chuyển Issue sang `agent:gpt` + `status:review-requested` (bàn giao PR) — tiêu đề ghi Issue/PR, tóm tắt ghi trạng thái + bằng chứng kiểm tra.
  2. Chuyển `status:blocked` hoặc mở Decision Gate — tiêu đề ghi `BLOCKED` + Issue/PR, tóm tắt ghi câu hỏi/chặn cần người dùng quyết định.
- Kiểm tra exit code của script: `0` = gửi thành công; `1` = Telegram API lỗi; `2` = thiếu token/config. Ghi bằng chứng `SENT` (exit 0) hoặc `FAILED` (exit 1/2 kèm lý do) vào `memory-bank/activeContext.md` ngay sau khi chạy.
- `node scripts/telegram-bridge.mjs --process` chỉ đọc hàng đợi lệnh cục bộ, **KHÔNG được coi là bằng chứng đã thông báo** cho người dùng.
- Không sửa logic/secret của `notify-telegram.mjs`/`telegram-bridge.mjs`/`watchdog-hibernate.mjs` trừ khi có yêu cầu riêng.
- Báo cáo tiến độ milestone vẫn dùng `scripts/progress-report.mjs`; mục này chỉ quy định thông báo bàn giao/chặn bắt buộc.
