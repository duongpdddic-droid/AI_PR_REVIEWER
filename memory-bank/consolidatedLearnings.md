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

## L-013 (23/08/2026) — Replace chuỗi chứa backtick trong PowerShell + edit PR body phải read-back
- **Triệu chứng**: thay dòng `- Full SHA: ``cda…`` `` trong body PR bằng `.Replace()` với chuỗi pattern viết `` `` `` (double backtick) → không khớp gì, body cũ giữ nguyên trong khi tưởng đã đổi; đồng thời append section mới làm body có heading thiếu dòng trống phía trước.
- **Nguyên nhân gốc**: trong PowerShell single-quoted string, backtick là ký tự thường — viết 2 backtick để "escape" là sai (chỉ cần 1); và `gh pr edit --body-file` thành công không có nghĩa là nội dung replace đã đúng. `gh pr view --jq .body` hiển thị qua console còn gộp newline thành space, dễ tưởng body vỡ.
- **Tránh lặp lại**: dựng chuỗi pattern bằng phép nối `'… `' + 'sha`'` thay vì gõ backtick kép; SAU MỌI edit PR body/issue chạy lại `gh pr view --json body` và Select-String kiểm tra chuỗi đích tồn tại trước khi coi là xong; heading markdown phải có dòng trống phía trước.

## L-014 (23/08/2026) — Mock io dùng `??` fallback nuốt sentinel `null`

## L-015 (23/08/2026) — PowerShell here-string biến backtick+chữ số thành NUL/BEL, hỏng comment GitHub
- **Triệu chứng**: Comment PR đăng từ `--body-file` chứa ký tự rác: `` `02290ba `` → `\0` + mất chữ số; `` `agent `` → BEL (`^G`) thay chuỗi. Read-back thấy `^@2290ba`, `^G82558c`.
- **Nguyên nhân gốc**: Trong PowerShell here-string/string, backtick là escape char: `` `0 `` = NUL, `` `a `` = BEL, `` `r `` = CR. Mọi backtick markdown đứng TRƯỚC chữ số hoặc a/f/n/r/t/v đều bị biến thành control char.
- **Tránh lặp lại**:
  1. Nội dung markdown có inline-code chứa SHA/số: KHÔNG viết qua PS string literal — ghi bằng editor tool ra file tạm rồi `--body-file`.
  2. Nếu phải dùng PS: thay backtick bằng `` `" `` không được (vẫn escape) — dùng `[char]0x60` nối chuỗi hoặc node script.
  3. Sau mọi PATCH/POST comment: read-back body qua `gh api ... --jq .body` và kiểm NUL/BEL trước khi coi là xong.

## L-016 (23/08/2026) — `[IO.File]::ReadAllText/WriteAllText` path tương đối dùng cwd của .NET, KHÔNG phải `Set-Location`
- **Triệu chứng**: Đọc `.clinerules/01-execution-workflow.md` để replace nhưng `IndexOf` trả -1 dù `Select-String` thấy nội dung; một lệnh WriteAllText suýt ghi đè file cùng tên ở repo khác.
- **Nguyên nhân gốc**: .NET Framework API dùng process working directory (thư mục khởi động terminal), trong khi `Set-Location` chỉ đổi location của PowerShell provider.
- **Tránh lặp lại**:
  1. Mọi thao tác file .NET ([IO.File]::*, [IO.Directory]::*) BẮT BUỘC dùng đường dẫn TUYỆT ĐỐI.
  2. Trước khi WriteAllText có điều kiện, assert `$t.Contains($old)` và chỉ ghi khi match; log kết quả replace.
  3. Sau đợt sửa hàng loạt, chạy `git status --porcelain` cả hai workspace để phát hiện file lạ.

## L-018 (23/08/2026) — Đường dẫn policy `reviewerPhases.phases.steadyState`, không phải `reviewerPhases.steadyState`
- **Triệu chứng**: test runtime fail `Cannot read properties of undefined (reading 'activationEvidence')` khi đọc `canonical.reviewerPhases.steadyState.activationEvidence` sau khi viết code mới.
- **Nguyên nhân gốc**: schema policy lồng 2 cấp — `reviewerPhases.phases.{transition|steadyState}`; `reviewerPhases.steadyState` không tồn tại. Code mới (orchestrator + test) suy diễn đường dẫn ngắn.
- **Tránh lặp lại**:
  1. Trước khi truy cập key policy mới, mở `.github/ai-review-policy.json` xem đúng cấp lồng (đọc đoạn JSON thật, không nhớ theo tên finding).
  2. Test integration đọc policy THẬT từ file sẽ lộ sai path ngay ở lần chạy đầu — chạy `pnpm test:integration` trước khi kết luận xong.

## L-017 (23/08/2026) — Pin cross-repo policy theo branch/ref di động gây CI fail khi hai PR lệch merge
- **Triệu chứng**: CI QLDA fail `BLOCKED_VERSION_MISMATCH`/không tìm thấy resolver sau migration Issue #5: workflow checkout canonical `ref: main`, nhưng policy `.5` + `effective-policy.mjs` còn nằm trên PR AI_PR_REVIEWER#4 chưa merge.
- **Nguyên nhân gốc**: "Pin" trỏ `main` là tham chiếu DI ĐỘNG — không đảm bảo version khớp `pinnedVersion`; fail-closed hoạt động đúng nhưng chặn CI hợp lệ.
- **Tránh lặp lại**:
  1. Cross-repo pin BẮT BUỘC dùng full 40-hex commit SHA (bất biến) trong `policySource.ref` + checkout action cùng ref; bump version = PR cập nhật pin ở cả hai repo cùng lúc.
  2. Resolver import từ nguồn canonical chỉ khi tồn tại (`existsSync`) — cần fallback embedded tối thiểu cho giai đoạn chuyển tiếp, đánh dấu `ponytail:` + điều kiện bỏ.
  3. Test resolution phải chạy được độc lập trạng thái merge repo kia; drift/version check vẫn fail-closed.

- **Triệu chứng**: test I.16 truyền `diff: null` vào mock `getPrDiff() { return opts.diff ?? '+const a = 1;' }` → null bị fallback thành diff mặc định, pre-review PASS, test fail ngược kỳ vọng.
- **Nguyên nhân gốc**: toán tử `??` fallback cho CẢ null lẫn undefined; không phân biệt "không truyền" với "truyền giá trị null có chủ đích" (diff không đọc được).
- **Tránh lặp lại**: mock có giá trị mặc định cần phân biệt sentinel — dùng `(opts.diff === undefined ? DEFAULT : opts.diff)`; khi cần mô phỏng "dữ liệu không đọc được", truyền `null` tường minh và assert đường fail-closed tương ứng.

## L-019 (24/08/2026) — Không báo xanh / hand-off khi working tree chưa qua hết gate; JSON dư dấu phẩy cuối làm parse fail
- **Triệu chứng**: commit `8f81c36` ([CLINE-FIX-049]) + đăng comment `agent:gpt`/`status:review-requested` rồi mới chạy test → ĐỎ: `JSON.parse` policy fail tại position 4066; nhiều test approval fail do test truyền param `approvers` (đã đổi tên `gptApprovers`) và `JSON.stringify(mkGpt())` bọc thêm marker; C.23 build marker thiếu `prNumber` → `isApprovalValid` báo "sai PR number".
- **Nguyên nhân gốc**: (1) xoá block `approvers` khỏi policy JSON nhưng để lại dấu phẩy cuối (`"deploy": "user",` rồi `}`) → JSON không hợp lệ (policy CRLF, không có formatter tự động). (2) Tên param trong test lệch với hàm (`approvers` vs `gptApprovers`). (3) `buildApprovalMarker` TRẢ CHUỖI marker; `JSON.stringify()` thêm lần nữa sinh quote thừa làm `parseApprovalMarkers` bỏ qua. (4) Hand-off (comment + label) thực hiện TRƯỚC khi verify xanh trên working tree.
- **Tránh lặp lại**:
  1. Sau mọi sửa JSON config (policy): chạy `node -e "JSON.parse(require('fs').readFileSync('.github/ai-review-policy.json','utf8'))"` (hoặc chạy `pnpm test:effective-policy` vốn parse policy) TRƯỚC commit — full-verify chỉ `node --check`, KHÔNG parse JSON.
  2. Sửa tên param hàm → cập nhật MỌI caller/test cùng lúc; chạy toàn bộ gate (pure-logic + effective-policy + approval-gate + orchestrator) chứ không chỉ 1 file.
  3. Marker từ `buildApprovalMarker` dùng NGUYÊN CHUỖI (không `JSON.stringify`); build marker luôn đủ mọi trường bắt buộc (`prNumber`, `decisionId`, `ciEvidence`, `reviewedAt`, ...).
  4. Quy trình: verify XANH trên working tree → commit → (tùy）push → MỚI hand-off comment/label. Không đánh dấu COMPLETED hay báo GPT re-review khi còn test ĐỎ.