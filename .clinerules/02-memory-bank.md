# CLINE MEMORY BANK

## 0. Nguyên tắc cốt lõi
- **Repository** = truth cho code & trạng thái deploy thực tế.
- **Memory Bank** = truth cho trạng thái thực thi, plan, decision, evidence, bối cảnh.
- Khi mâu thuẫn: code → repository thắng; reasoning/decision → Memory Bank tham chiếu. Phải reconcile trước khi tiếp tục.
- Không đánh dấu `[x]` nếu chưa có evidence thực thi.
- Quy trình: **Inspect → Plan → Execute → Verify → Record**. Mọi thay đổi code bắt buộc verification.

## 1. Cấu trúc thư mục & vai trò
| File | Vai trò |
|---|---|
| `activeContext.md` | Trạng thái thực thi hiện tại, plan, evidence, next step |
| `progress.md` | Tổng kết tiến độ task/dự án |
| `taskHistory.md` | Process, decision, deviation, root cause quan trọng |
| `projectbrief.md` | Mục tiêu & phạm vi |
| `productContext.md` | Bối cảnh sản phẩm, UX, yêu cầu user |
| `systemPatterns.md` | Kiến trúc & system pattern |
| `techContext.md` | Stack, tooling, ràng buộc kỹ thuật |
| `consolidatedLearnings.md` | Bài học tái sử dụng |
| `PROJECT_ANALYSIS.md` | Bản đồ codebase (nằm tại root dự án, không trong memory-bank/) |

> **Task-specific plan file (VD: cũ `telegramNotifPlan.md`):** nằm NGOÀI cấu trúc canonical — chỉ dùng tạm trong 1 task. Khi resolve xong → ghi 1 entry tổng kết vào `taskHistory.md` (mục tiêu / bước / trạng thái + evidence) rồi **xóa** file gốc, tránh tồn đọng "mồ côi".

> **`taskHistory.md` chia theo tháng**: khi file vượt ~400 dòng → tạo `taskHistory-<YYYY-MM>.md` chứa entries tháng đó; `taskHistory.md` (không hậu tố) làm index trỏ tới file tháng gần nhất (vd: `## Chỉ mục theo tháng` + link). Khi restructure, dọn entry cũ sang file tháng tương ứng.

Thứ tự đọc khi bắt đầu: `activeContext.md` → `progress.md`. Chỉ đọc thêm khi task cần. Không đọc toàn bộ nếu không cần.

## 2. activeContext.md — Checkpoint sống
Phải trả lời: task gì? plan? bước nào done? evidence? đang ở bước nào? next step? Không phải nhật ký.
Trạng thái: `[ ]` chưa; `[>]` đang làm; `[x]` done & có evidence (không đánh dấu `[x]` chỉ vì đã phân tích/viết code chưa verify).
Mẫu:
```markdown
# Active Context
## Mục tiêu
## Chế độ (Duyệt trước | Tự hành)
## Kế hoạch thực thi
1. [x] ...
2. [>] ...
3. [ ] ...
## Bước hiện tại
## Bằng chứng thực thi
### Bước 1
- File đã kiểm tra/thay đổi:
- Thay đổi chính:
- Verification:
## Quyết định
## Vấn đề trì hoãn
- [ ] ...
## Bước tiếp theo
```
- Mỗi bước `[x]` cần evidence tối thiểu: file changed, change chính, verification.
- Cập nhật sau mỗi milestone/thay đổi lớn/verification/trước context pressure/trước kết thúc task. Không cập nhật sau từng tool call.
- `activeContext.md` luôn phản ánh trạng thái hiện tại; thông tin lỗi thời → thay thế; lịch sử đáng nhớ → `taskHistory.md`.
- **Archive định kỳ (bắt buộc)**: Khi `activeContext.md` có >5 entry COMPLETED hoặc `progress.md` >15 entry → bắt buộc archive entry cũ nhất sang `taskHistory.md` trước khi thêm entry mới. Trước mỗi restructure lớn: backup 5 file cũ vào `memory-bank/_archive/<timestamp>/` rồi chuyển toàn bộ entry lịch sử (nguyên văn) sang `taskHistory.md`, giữ `activeContext.md`/`progress.md` chỉ chứa trạng thái hiện tại + N entry gần nhất (`progress.md` ≤ 10).

## 3. Phân loại task & luồng
- Task nhỏ: inspect → thực thi → verify → cập nhật Memory Bank nếu đổi trạng thái project.
- Task phức tạp: inspect → plan trong `activeContext.md` → xác định tiêu chí verify → thực thi → cập nhật plan sau mỗi milestone → verify trước hoàn thành.
- Duyệt trước (VSCode UI): plan → trình bày → **không sửa code** → chờ user chuyển sang Tự hành (chi tiết tại `01-execution-workflow.md` §3).

## 4. Kiểm tra trước thực thi (Inspect & Reconcile)
Inspect: file liên quan, implementation hiện tại, dependencies, architecture constraints, pattern, mechanism test/verify, decision cũ trong Memory Bank.
Reconcile Memory Bank vs repository:
- Memory Bank báo done nhưng repo chưa có → repo thắng, sửa Memory Bank, tiếp tục.
- Memory Bank báo chưa xong nhưng repo đã có → inspect + verify + cập nhật Memory Bank.
Không mặc định trạng thái đúng nếu chưa có evidence.

## 5. Execution & Verification
Thực thi theo milestone (Inspect/Prepare → Implement → Integrate → Verify → Finalize). Sau mỗi milestone ý nghĩa: cập nhật `activeContext.md` (Current State / Evidence / Completed / Remaining / Next Step).
Verification bắt buộc trước khi báo hoàn thành. Evidence phù hợp: inspect file/diff, syntax check, build, unit/integration test, lint, runtime test, API test, UI verification, command output, repo state.
Chỉ đánh dấu `[x]` khi đủ: Implementation tồn tại + Verification PASS + Evidence ghi nhận. Nếu không verify được → ghi rõ giới hạn. Không báo PASS chỉ từ code inspection nếu task yêu cầu execution test.

**Phân biệt Intent vs Evidence**: Plan là ý định; Evidence là bằng chứng thực thi. Đã có plan ≠ đã làm. Mỗi milestone ghi tối thiểu: Files / Change / Verification.
- Khi context gần đầy (≈70% model context 256k ≈ 180k tokens / bar ≥ ~70%): thực hiện **Context Budget Checkpoint** — flush Memory Bank rồi compact/restart, quy trình chi tiết tại `01-execution-workflow.md` §12. Không đợi auto-condense (không đáng tin — xem §12).

## 6. Cập nhật Memory Bank sau hoàn thành
- `activeContext.md`: trạng thái cuối, bước hoàn thành, evidence, còn lại, next step. Nếu fully done: `### Status COMPLETED`.
- `progress.md`: summary ngắn (đã đổi gì, trạng thái, kết quả verify). **Quy ước giờ bắt buộc**: mọi entry ghi rõ ngày VÀ giờ (`dd/MM/yyyy HH:mm`) lấy từ `Get-Date` tại thời điểm ghi; cấm bịa giờ.
- `taskHistory.md`: chỉ khi có nội dung đáng truy nguyên (architectural decision, thay đổi process, deviation, root cause, workaround, failure). Template: Objective/Plan/Decision/Deviation/Root Cause/Verification/Delay-Blocker.
- `PROJECT_ANALYSIS.md`: chỉ khi thêm/xóa module, đổi architecture/dependency/cấu trúc.
- `consolidatedLearnings.md`: **bắt buộc theo §6b khi phiên có sửa lỗi**; ngoài ra chỉ khi lesson tái sử dụng, không hiển nhiên.

## 6b. Tự ghi bài học khi mắc lỗi (bắt buộc)
- **Trigger**: mọi lỗi phải sửa trong phiên, kể cả lỗi nhỏ:
  - Bug code/logic do mình viết;
  - Command/tool fail vì môi trường, shell quirk, process treo, exit code sai lệch;
  - Capability bị mất/khuyết khi deprecate/thay thế runner hoặc refactor lớn;
  - Sai giả định dẫn đến phải đổi thiết kế (đặc biệt sau Decision Gate);
  - Verify/test fail mà nguyên nhân không hiển nhiên.
- **Hành động**: NGAY SAU khi fix xong + verification PASS (không gom cuối task), thêm 1 entry vào `memory-bank/consolidatedLearnings.md`:
  - Đánh số tiếp `L-NNN` (lấy số lớn nhất hiện có + 1), kèm ngày (`dd/MM/yyyy` từ `Get-Date`).
  - Format cố định: **Triệu chứng → Nguyên nhân gốc → Tránh lặp lại**; phần tránh lặp lại phải cụ thể, hành động được (lệnh, flag config, bước check).
- **Không ghi** (tránh noise): typo thuần; lỗi one-off không thể tái lập và không rút ra được quy tắc; entry trùng nội dung đã có → **cập nhật entry cũ** thay vì thêm mới.
- **Hook hoàn thành**: task nào phát sinh sửa lỗi thì trước khi báo COMPLETE phải rà `consolidatedLearnings.md` đã ghi đủ entry cho các lỗi đó chưa — thiếu entry = chưa đủ điều kiện báo hoàn thành.

## 7. Deferred Issues
Ghi ngắn: `- [ ] <issue> — lý do defer`. Chỉ đưa vào task nếu nó block hoàn thành hoặc tạo rủi ro nghiêm trọng kỹ thuật/security/data. Không tự mở rộng scope.

## 8. Recovery sau Compact / Restart
1. Đọc `activeContext.md`, `progress.md`.
2. Nếu phức tạp/evidence chưa đủ → đọc `taskHistory.md`.
3. Đối chiếu Memory Bank với repository; kiểm tra mọi `[x]` bằng evidence thực tế.
4. Nếu cần → inspect source, git diff, test, build, artifacts.
5. Xác định: Current State → Verified Completed → Remaining → Next Step.
6. Tiếp tục từ Next Step. Không hỏi lại decision/context recoverable.

Nếu `PROJECT_ANALYSIS.md` có ngày cập nhật cũ hơn lần thay đổi architecture gần nhất theo `taskHistory.md` → coi là lỗi thời, ưu tiên inspect trực tiếp repository.

## 9. Cấm tự báo hoàn thành sau Compact (Anti-Hallucination)
- Context bị compact KHÔNG phải "xong việc". Sau compact: BẮT BUỘC recovery (§8) rồi tiếp tục. Không đóng task, không báo "hoàn thành", không đánh dấu `[x]` thiếu evidence.
- COMPLETE chỉ hợp lệ khi có evidence thực thi thật (implementation + verification PASS + Memory Bank ghi). Thiếu mắt xích → IN PROGRESS.
- Mọi tín hiệu "command complete" từ hệ thống/harness tại ranh giới session = chưa xác minh; chỉ báo COMPLETE khi chính Cline đã chạy VERIFY + evidence.
- Chưa xong = chưa verify/evidence → báo IN PROGRESS + next step.

## 10. Quy tắc bảo mật dữ liệu nhạy cảm
Quy tắc bảo mật dữ liệu nhạy cảm: áp dụng nguyên văn `04-security-and-secrets.md` §2 (kể cả khi thao tác trong Memory Bank).
