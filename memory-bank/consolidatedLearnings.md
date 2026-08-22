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
- **Bổ sung 22/08/2026**: push báo giả "Everything up-to-date" dù remote chưa nhận commit. Nguyên nhân thật: lệnh push nằm ở entry song song với entry commit trong cùng một lời gọi công cụ (các entry chạy ĐỒNG THỜI, không tuần tự). Quy tắc: chuỗi phụ thuộc (`add → commit → push → verify`) bắt buộc nằm trong MỘT chuỗi `;` của một entry duy nhất; verify push bằng `git ls-remote origin main` đối chiếu `rev-parse HEAD`, không tin thông báo "up-to-date".


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

## L-009 (22/08/2026) — PowerShell 5.1 `Set-Content -Encoding utf8` ghi BOM
- **Triệu chứng**: trim `memory-bank/activeContext.md` bằng `Set-Content -Encoding utf8` → file có U+FEFF đầu file, vi phạm quy ước UTF-8 không BOM (full-verify sẽ fail ở BOM scan).
- **Nguyên nhân gốc**: PowerShell 5.1 `-Encoding utf8` của `Set-Content`/`Out-File` mặc định ghi UTF-8 CÓ BOM.
- **Tránh lặp lại**: ghi file text qua shell luôn dùng `[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`; ưu tiên tool `editor` (không sinh BOM). Sau mỗi lần shell ghi file text, chạy BOM scan trước khi commit.

## L-010 (22/08/2026) — Idempotency key phải phủ cả nhánh con của action
- **Triệu chứng**: chạy lại orchestrator cùng HEAD phát hành trùng comment `PRE_REVIEW_PASS`, lặp mutation `status:reviewing` dù action đã có marker.
- **Nguyên nhân gốc**: chỉ kiểm khóa action cấp 1 (`start-semantic-review`), quên verdict con `pre-review:PRE_REVIEW_*` có khóa riêng.
- **Tránh lặp lại**: khi thêm action có nhánh con, khai báo toàn bộ khóa con trong cùng điểm kiểm idempotency (`processPr`); integration test bắt buộc case "chạy lại cùng HEAD → 0 mutation" cho từng nhánh (I.2).

## L-011 (22/08/2026) — Dry-run phải chặn cả notify và nhánh mutation thứ hai
- **Triệu chứng**: `processOneCycle({dryRun:true})` vẫn gọi Telegram và đổi nhãn ở nhánh pre-review.
- **Nguyên nhân gốc**: guard `if (!dryRun)` chỉ bọc bước đầu; `applyHandoff(outcome)` + `io.notify(...)` cuối hàm nằm ngoài guard.
- **Tránh lặp lại**: với hàm nhiều điểm mutation, gom mutation/notify sau một cờ `live = !dryRun`; integration test assert "0 comment + 0 notify + nhãn giữ nguyên" cho MỌI đường đi (I.14), không chỉ happy path.

## L-012 (23/08/2026) — `Get-Content -Raw` không `-Encoding utf8` phá UTF-8 không BOM
- **Triệu chứng**: trim `memory-bank/activeContext.md` bằng `Get-Content -Raw` + `Set-Content` → toàn bộ tiếng Việt trong file thành mojibake trên đĩa (double-encoding), phải viết lại file.
- **Nguyên nhân gốc**: PowerShell 5.1 `Get-Content` mặc định decode file không BOM theo ANSI/codepage máy; nội dung UTF-8 bị diễn giải sai rồi được ghi lại UTF-8 → hỏng vĩnh viễn (khác L-006: chỉ hiển thị vỡ, dữ liệu còn nguyên).
- **Tránh lặp lại**: CẤM dùng `Get-Content`/`Set-Content` cho file UTF-8 không BOM; mọi thao tác byte-chính xác qua `[IO.File]::ReadAllText/WriteAllText` với `UTF8Encoding($false)` hoặc tool `editor`. Nếu lỡ ghi hỏng: dừng, viết lại file từ nguồn đã biết (không cố "sửa" mojibake).

## L-007 (22/08/2026) — `gh pr list --label` đi qua search index có độ trễ
- **Triệu chứng**: gắn nhãn `status:review-requested` cho PR bằng `gh pr edit` rồi chạy orchestrator ngay lập tức → "không có PR chờ review"; vài chục giây sau `gh pr list --label` lại thấy PR.
- **Nguyên nhân gốc**: `gh pr list --label` dùng search API của GitHub, index có độ trễ cập nhật (giây–chục giây); `gh pr view` đọc trực tiếp nên luôn thấy giá trị mới.
- **Tránh lặp lại**: khi test thủ công luồng "gắn nhãn → quét", chờ ~30–60s hoặc chạy lại lần 2 trước khi kết luận miss. Cron 15 phút của orchestrator không bị ảnh hưởng thực tế. KHÔNG kết luận "orchestrator lỗi" chỉ từ 1 lần chạy ngay sau mutation nhãn.

## L-008 (22/08/2026) — PR đã approved mất nhánh quét khi CI fail sau đó (hành vi thiết kế cần biết)
- **Triệu chứng**: PR được approve (`status:approved`, mất `status:review-requested`); sau đó push commit mới làm CI đỏ → orchestrator không bao giờ phát hiện vì chỉ quét PR mang `status:review-requested` → PR "approved" đứng yên với CI fail.
- **Nguyên nhân gốc**: điều kiện quét 1 nhãn duy nhất; approve gỡ nhãn quét.
- **Tránh lặp lại / hướng xử lý**: trong flow chuẩn, chỉ coder gắn lại `status:review-requested` sau khi sửa — hợp lệ. Rủi ro thật chỉ xảy ra khi có người/agent push thêm vào PR đã approved. Đã ghi Deferred Issue: cân nhắc quét thêm `status:approved` và hạ cấp xuống `changes-requested` khi phát hiện check fail mới (chưa làm — cần quyết định scope riêng).


