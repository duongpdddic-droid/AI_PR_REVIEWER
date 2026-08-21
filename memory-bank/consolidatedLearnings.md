# Consolidated Learnings (AI_PR_REVIEWER)

Bài học tái sử dụng — mỗi entry: triệu chứng → nguyên nhân gốc → cách tránh lặp lại.

## L-001 (21/08/2026) — `git commit` treo ở prompt y/n do commit-graph bị khoá
- **Triệu chứng**: `git commit` chạy non-interactive bị treo >300s tại `Unlink of file '.git/objects/info/commit-graphs/graph-*.graph' failed. Should I try again? (y/n)`; HEAD không đổi.
- **Nguyên nhân gốc**: process git cũ treo/vs Code nền giữ handle file commit-graph; `git commit` mặc định chạy auto-maintenance chạm vào file này.
- **Tránh lặp lại**:
  - Trước commit: `Get-Process git` + `Test-Path .git/index.lock`; kill process git treo trước khi thao tác mutation.
  - Commit trong môi trường có git nền: thêm `-c gc.auto=0 -c core.commitGraph=false`.
  - Command shell phải non-interactive — mọi prompt y/n = treo vô hạn.

## L-002 (21/08/2026) — PowerShell nuốt stderr của git → exit code sai lệch
- **Triệu chứng**: `git push ... 2>&1` in ra `50caf6c..7d5bae1 main -> main` (thành công) nhưng command báo exit 1 (`NativeCommandError`) vì PowerShell coi stderr progress của native command là lỗi.
- **Nguyên nhân gốc**: git ghi progress vào stderr; `$ErrorActionPreference`/pipe `2>&1` của PowerShell biến stderr thành error record.
- **Tránh lặp lại**: KHÔNG kết luận fail/thành công chỉ từ exit code của native command qua PowerShell; verify bằng trạng thái thật — `git rev-parse HEAD origin/main`, `git status -sb`, hoặc output dòng kết quả (`main -> main`).

## L-003 (21/08/2026) — `gh --json` thiếu field consumer cần
- **Triệu chứng**: `listReviewPRs` query `'--json', 'number,title,url'` nhưng vòng xử lý đọc `pr.labels` → `undefined`, logic skip `agent:gpt` vô hiệu.
- **Nguyên nhân gốc**: thêm field mới vào consumer mà không cập nhật contract producer (`--json` là whitelist tường minh — không có field = không trả về).
- **Tránh lặp lại**: khi đọc thêm thuộc tính từ JSON của `gh`, sửa CÙNG LÚC cả chuỗi `--json`; rà producer/consumer như một cặp contract, không sửa một phía.

## L-004 (21/08/2026) — Deprecation wrapper làm mất capability cũ một cách âm thầm
- **Triệu chứng**: thay `agent-runner.mjs` bằng wrapper forward sang `unified-orchestrator.mjs`, làm nửa "dispatch Aider Reviewer" của bản cũ thành mồ côi; phát hiện muộn khi Bố hỏi "luồng review của AI_PR_REVIEWER đâu?".
- **Nguyên nhân gốc**: deprecate theo tên file (runner cũ → runner mới) mà không đối chiếu capability từng bên; capability chết không có test hay doc cảnh báo.
- **Tránh lặp lại**:
  - Trước khi thay/deprecate 1 runner: liệt kê capability bản cũ (grep hành vi chính) và đánh dấu từng cái: chuyển giao / bỏ chủ đích / mất.
  - Phần "bỏ chủ đích" bắt buộc ghi decision rõ ràng vào Memory Bank (kể cả lý do) ngay lúc deprecate, không để sau.
  - Capability không còn ai gọi nhưng vẫn tồn tại vật liệu (prompts/config) → ghi chú inert để người sau khỏi tưởng nó đang chạy.

## L-005 (21/08/2026) — Decision Gate trước kiến trúc tránh over-build (positive)
- **Bối cảnh**: phát hiện gap nửa Aider Reviewer, định khôi phục; dừng hỏi Bố theo Mức 3.
- **Kết quả**: Bố chốt bỏ hẳn aider reviewer, reviewer chỉ còn GPT + local AI_PR_REVIEWER → không viết dòng code nào thừa.
- **Bài học**: gap so với thiết kế cũ ≠ việc phải xây lại; xác nhận chủ đích sản phẩm hiện tại TRƯỚC khi implement. Ràng buộc vận hành (cron Actions không chạy được model local) cần đưa vào quyết định kiến trúc ngay từ đầu.

## L-006 (21/08/2026) — Mojibake giả từ stdout của `gh` trong PowerShell
- **Triệu chứng**: Comment GitHub đăng tiếng Việt qua `gh pr comment`; khi đọc lại bằng `gh api ... --jq .body` hiển thị dạng vỡ (`─É├│ng PR...`), tưởng double-encoding → đã xoá comment tốt và đăng lại, thêm bước PATCH thừa.
- **Nguyên nhân gốc**: PowerShell 5.1 decode stdout của native command theo codepage single-byte ([Console]::OutputEncoding ≠ UTF-8) → byte UTF-8 của `gh` bị diễn giải thành CP1250. **Dữ liệu trên GitHub vẫn đúng UTF-8** — chỉ hiển thị/verify qua stdout mới vỡ.
- **Tránh lặp lại**: KHÔNG dùng stdout `gh`/git làm bằng chứng verify encoding với text Unicode. Verify bằng script Node tạm (fetch API + `codePointAt(0)` so mã ký tự, ví dụ Đ = 272) hoặc `[IO.File]::ReadAllBytes`. Text Unicode đưa vào CLI luôn qua file (`--body-file` UTF-8), không truyền inline qua arg.

