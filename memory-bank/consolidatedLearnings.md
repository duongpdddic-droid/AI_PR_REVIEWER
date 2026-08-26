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

## L-013 (26/08/2026) — Test fixture secret phải ghép tại runtime để tránh diff-secret-scanner false positive
- **Triệu chứng**: orchestrator pre-review flag 3 `critical` (PRE_REVIEW_FINDINGS) vì test fixtures chứa literal giả `AKIAIOSFODNN7EXAMPLE` / `sk-1234567890abcdef` trên source line; fail-closed trả PR về `status:changes-requested` dù KHÔNG rò rỉ thật.
- **Nguyên nhân gốc**: `scanDiffForSecrets` quét mọi dòng `+` của diff khớp `SECRET_PATTERNS` (api-key/aws-access-key); test viết literal hoàn chỉnh để assert detector → chính literal đó bị diff-scanner bắt.
- **Tránh lặp lại**: khi viết test cho secret-detection, dựng fake secret bằng cách tách đoạn rồi `['AKIAIOSFOD','NN7EXAMPLE'].join('')` / `['sk-12345678','90abcdef'].join('')`, dùng computed key `[fakeApiKeyName]`; assertions so sánh runtime-join (`=== ['AKIAIOSFOD','NN7EXAMPLE'].join('')`) — KHÔNG để literal hoàn chỉnh trên bất kỳ source line nào. Giữ nguyên regex production.
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

## L-021 (24/08/2026) — Mock IO trả shape khác production adapter: CI `missing` + approval read-back luôn FAIL
- **Triệu chứng**: (1) `gpt-approval.mjs` từ chối mọi PR với `CI=missing` dù check SUCCESS trên GitHub; (2) sau khi đăng comment approval, read-back FAIL `marker thiếu provenance` → không bao giờ gắn `status:approved`. Test pure/integration vẫn PASS.
- **Nguyên nhân gốc**: pattern mock-vs-real drift, 2 chỗ — `evaluateChecks` chỉ đọc wrapper `{checks:[...]}` trong khi `gh pr checks --json name,state` trả MẢNG PHẲNG; `listPrComments` của `gpt-approval.mjs` trả legacy strings (`[.[].body]`) trong khi `parseApprovalMarkers` yêu cầu rich objects `{id, user.login}` (orchestrator dùng bản rich đúng). Mock test tự dựng shape "đúng lý thuyết" nên không bắt được lệch.
- **Tránh lặp lại**:
  1. Hàm contract nhận dữ liệu từ subprocess (`gh`) phải chấp nhận cả 2 shape hoặc IO adapter phải normalize ngay tại biên — chuẩn hóa 1 chỗ, cả 2 caller cùng lợi ích (fix tại contract: `[CLINE-FIX-050]`; fix tại adapter: `[CLINE-FIX-051]`).
  2. Khi viết test integration, copy NGUYÊN defaultIo thật làm fixture base thay vì dựng mock mới; thêm ít nhất 1 test chạy lệnh gh thật ở chế độ smoke nếu môi trường có credentials.
  3. Trước khi kết luận script lỗi do dữ liệu, in shape thực tế: `gh pr checks <n> --json name,state` và so trực tiếp với code đọc nó.
  3. Test resolution phải chạy được độc lập trạng thái merge repo kia; drift/version check vẫn fail-closed.

## L-022 (24/08/2026) — Editor replace dòng header entry Memory Bank làm entry cũ mồ côi header

## L-023 (25/08/2026) — `gh issue edit` KHÔNG có flag `--state` / `--state-reason`; đóng Issue phải dùng `gh issue close --reason`
- **Triệu chứng**: chạy `gh issue edit 6 --repo ... --state closed --state-reason COMPLETED --remove-label status:in-progress --remove-label agent:cline` → `unknown flag: --state`. Phải chạy lại 2 lệnh riêng: `gh issue edit ... --remove-label ...` + `gh issue close N --reason completed`.
- **Nguyên nhân gốc**: `gh issue edit` chỉ chấp nhận `--add-label`/`--remove-label`/`--add-assignee`/`--remove-assignee`/`--title`/`--body`/`--milestone`; state/stateReason CHỈ đổi được qua `gh issue close [--reason]` (open lại qua `gh issue reopen`). Đoán nhầm từ `gh pr edit` (có `--state` enum) — Issue và PR khác contract.
- **Tránh lặp lại**: đóng Issue + đổi label = 2 lệnh tách biệt trong cùng `;`-chain — `gh issue edit N --remove-label X --remove-label Y` rồi `gh issue close N --reason completed`. Verify bằng `gh issue view N --json state,stateReason,labels,closedAt --jq '...'` xác nhận cả `state` lẫn label. Khi đóng, luôn kèm `--reason` hợp lệ (`completed`/`not_planned`) để GitHub set `stateReason` qua API field đúng.
- **Triệu chứng**: chèn entry mới vào đầu `activeContext.md`/`progress.md` bằng editor replace old_text = dòng header entry hiện có → header bị xóa, thân entry cũ dính vào entry mới, mất ranh giới entry. Lặp lại 2 lần trong cùng phiên (23:40 và 23:59).
- **Nguyên nhân gốc**: dùng replace thay vì insert khi old_text trùng đúng dòng cần giữ; new_text không chứa lại header cũ.
- **Tránh lặp lại**:
  1. Chèn entry mới ở ĐẦU file memory-bank: luôn dùng `insert_line: 1` (hoặc include nguyên header cũ trong `new_text` nếu buộc phải replace).
  2. Sau mỗi lần sửa file memory-bank có replace: đọc lại vùng biên giới trí (5–10 dòng quanh điểm sửa) để xác nhận không mất header/dòng lân cận trước khi sang bước khác.

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


## L-020 (24/08/2026) — PowerShell 5.1 `-Encoding utf8` tự thêm BOM (U+FEFF) khi ghi file; capture gh multi-line thành ARRAY
- **Triệu chứng**: PR body ghi qua file tạm bằng `Set-Content -Encoding utf8` rồi `gh pr edit --body-file` → GitHub lưu body bắt đầu bằng U+FEFF; GPT read-back bắt lỗi BOM dù khẳng định "UTF-8 không BOM". Lần 2 ghi array thẳng vào `WriteAllText` làm body mất hết newline (gom 1 dòng).
- **Nguyên nhân gốc**: (1) PowerShell 5.1 coi `-Encoding utf8` = UTF-8 **CÓ BOM** (Windows default); PS 6+ mới có `utf8NoBOM` và `-Encoding utf8` không BOM. (2) Capture output external command multi-line (`gh ... --jq '.y'`) vào biến → PS5.1 trả về ARRAY các dòng, không phải string; truyền array thẳng vào `WriteAllText` mất newline.
- **Tránh lặp lại**:
  1. Ghi file UTF-8 KHÔNG BOM trong PS5.1: `[System.IO.File]::WriteAllText($path, $s, [System.Text.UTF8Encoding]::new($false))` (hoặc `New-Object System.Text.UTF8Encoding $false`).
  2. `Out-File -Encoding utf8` / `Set-Content -Encoding utf8` / redirect `>` trong PS5.1 ĐỀU có BOM → CẤM dùng khi file đẩy lên GitHub / clasp / JSON config nhạy BOM.
  3. Capture body đa dòng: `$lines = gh ...; $s = $lines -join [Environment]::NewLine; $s = $s.TrimStart([char]0xFEFF)` rồi `WriteAllText(..., UTF8Encoding($false))` — KHÔNG truyền array thẳng.
  4. Verify không BOM: ưu tiên byte-level `[System.IO.File]::ReadAllBytes($path)[0..2]` phải KHÔNG phải `239,187,191` (BOM); PowerShell `.StartsWith([char]0xFEFF)` trên array hoặc stale read có thể báo sai, chỉ tin byte-level.
## L-024 (25/08/2026) — Guard cụ thể đặt sau allowlist generic thành dead code
- **Triệu chứng**: test `validateObservation()` với verdict kind bị cấm nhận lỗi generic "kind không hợp lệ" thay vì thông báo tường minh về kind cấm; nhánh check `FORBIDDEN_VERDICT_KINDS` không bao giờ chạy.
- **Nguyên nhân gốc**: thứ tự validation sai — check `ALLOWED_KINDS` (generic) đứng TRƯỚC check `FORBIDDEN_VERDICT_KINDS` (cụ thể), nên giá trị cấm bị chặn sớm bằng lỗi generic; guard cụ thể thành dead code.
- **Tránh lặp lại**:
  1. Khi viết chuỗi validate: đặt check cụ thể/nhận định rõ (forbidden, boundary, sentinel) TRƯỚC allowlist generic.
  2. Test phải assert ĐÚNG message lỗi của từng nhánh, không chỉ "throw" — assert generic làm che dead branch.

## L-025 (25/08/2026) — Telemetry whitelist drop trường lạ TRƯỚC redaction làm mất evidence
- **Triệu chứng**: test gửi event có trường lạ (`note`, `msg`) chứa nội dung giống secret; output không còn trường nào để chứng minh đã redact — whitelist chỉ giữ các trường biết sẵn nên drop luôn trường lạ, redaction không có cơ hội chạy.
- **Nguyên nhân gốc**: thứ tự xử lý ngược — schema-filter (drop unknown fields) chạy trước redaction; dữ liệu lạ bị loại khỏi pipeline trước khi được sanitize.
- **Tránh lặp lại**:
  1. Quy tắc bắt buộc với mọi pipeline xử lý dữ liệu không tin cậy: **redact/sanitize TRƯỚC, filter shape SAU**; giữ lại trường lạ sau khi đã redact (preserve-after-redact).
  2. Test telemetry phải bao gồm trường lạ chứa pattern secret và assert giá trị sau redaction — không chỉ assert các trường chuẩn.

## L-032 (25/08/2026) — Manifest test dùng `projectType` tự do (`generic`) bị schema enum reject
- **Triệu chứng**: test `registerProject`/`migrateManifest` với `projectType: 'generic'` fail validate `SCHEMA_ENUM_PROJECTTYPE` dù mọi trường khác hợp lệ.
- **Nguyên nhân gốc**: `scripts/project-manifest-schema.json` định nghĩa `projectType.enum = ["control-plane","product","adapter"]`; `'generic'` không nằm trong danh sách → `validateAgainstSchema` reject.
- **Tránh lặp lại**: khi viết manifest fixture/test cho Project Registry, `projectType` chỉ nhận `control-plane` | `product` | `adapter` (tra `project-manifest-schema.json` trước khi đặt giá trị tuỳ ý). Verify gate (`node scripts/test-project-registry.mjs`) sẽ bắt lỗi này ngay — đừng đoán enum.

## L-026 (25/08/2026) — Regex secret chỉ khớp token CÓ prefix, bỏ sót `Bearer <token>` trần trong stderr
- **Triệu chứng**: test negative GPT-REV-061 gửi chuỗi `Bearer abcDEF123…` không có `Authorization:` đứng trước → assertion "đã redact" FAIL dù regex Authorization/Bearer đã tồn tại.
- **Nguyên nhân gốc**: regex `/((?:authorization|auth)\s*[:=]\s*"?bearer\s+)…/` bắt buộc prefix; log stderr thực tế thường in `Bearer <token>` trần.
- **Tránh lặp lại**:
  1. Với mỗi token shape, thêm pattern riêng cho dạng trần: `/\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi` đặt cạnh pattern có prefix.
  2. Test secret phải phủ cả 2 biến thể (có/không prefix) cho từng shape — không chỉ shape "đẹp" trong docs.

## L-027 (25/08/2026) — Test viết theo giả định scope injection khác thiết kế facade thật
- **Triệu chứng**: integration test assert `recordEvent()` degrade khi inject io lỗi, nhưng kết quả `ok:true` — recordEvent ghi qua fs thật vì io injection của `createRuntimeHooks` chỉ scope memory store.
- **Nguyên nhân gốc**: viết test theo giả định về API chưa đối chiếu signature/thiết kế của facade (io chỉ truyền vào `createMemoryStore`); recordEvent dùng fs trực tiếp có try/catch riêng.
- **Tránh lặp lại**:
  1. Trước khi viết assertion cho failure path, đọc lại signature + luồng IO thật của facade (tham số nào nhận injection, đường nào dùng stdlib).
  2. Comment rõ scope injection ngay ở JSDoc tham số (`io` áp dụng cho cái gì) để test và caller không suy diễn.
## L-029 (25/08/2026) — Test phát hiện xung đột phải seed registry bằng entity CÙNG identity gây xung đột trước khi assert

- **Triệu chứng**: test AC9 gọi `registerProject(duplicate-id)` (projectId `ai-pr-reviewer`) trên registry vừa chứa `qlda-dtxd` → mong đợi conflict nhưng `res.ok === true` (đăng ký thành công, không phát hiện trùng). `pnpm verify` báo 1 FAIL.
- **Nguyên nhân gốc**: `detectConflicts` so projectId của manifest với TỪNG project đã có trong registry; registry seed bằng project KHÁC id nên không trùng. Fixture `duplicate-id` chỉ "trùng" khi registry đã chứa chính `ai-pr-reviewer`.
- **Tránh lặp lại**: khi viết test phát hiện xung đột (duplicate id/route/workspace), seed registry trước bằng entity CÙNG identity gây xung đột (register `ai-pr-reviewer.json` trước, rồi `duplicate-id.json` mới conflict). Đừng dùng fixture duplicate với registry seed id khác.


## L-030 (25/08/2026) — Validator phải reject schema tương lai + secret trong key camelCase + register idempotent + rollback giữ data
- **Triệu chứng**: GPT review GPT-REV-069..073 bắt lỗi: (1) fixture pin policy `.1` thay vì canonical `.7`; (2) `validateManifest` nhận schema tương lai chưa hỗ trợ, không thực thi đầy đủ JSON Schema; (3) secret nằm dưới key `apiKey`/`botToken` lọt qua; (4) hai project khác route vẫn trùng + re-register cùng project không idempotent; (5) down migration mất trường.
- **Nguyên nhân gốc**: validator tự viết song song schema (DRY violation) chỉ reject schema < min, không reject > supported; secret scan chỉ quét value có prefix key (`apiKey = ...`), bỏ qua key tên secret; `detectConflicts` coi mọi trùng projectId là conflict kể cả re-register; down migration chỉ giữ vài trường.
- **Tránh lặp lại**:
  1. Khi có JSON Schema: thực thi schema làm single source of truth (required/pattern/enum/minLength/nested), không duy trì danh sách check tay song song; reject cả schema < MIN_SCHEMA_VERSION (STALE) và > SUPPORTED_SCHEMA_VERSION (UNSUPPORTED).
  2. Secret scan phải duyệt CẢ key (camelCase: apiKey/botToken/accessToken/privateKey) lẫn value — fail-closed.
  3. `registerProject` idempotent: cùng projectId+repository = update no-op (skip self trong detectConflicts); chỉ conflict khi identity (repository) khác hoặc resource (route/workspace) trùng giữa project KHÁC.
  4. Migration down phải preserve mọi trường (chỉ đổi marker version), không drop data.
  5. Fixture/manifest pin version phải theo canonical (`2026-08-23.7`), không hardcode `.1`.

## L-031 (25/08/2026) — Schema/file loader phải fail-closed (throw), không trả null bị skip
- **Triệu chứng**: GPT re-review vòng 2 (GPT-REV-070) bắt: `loadSchema()` trả `null` khi schema file thiếu/corrupt, rồi `if (schema)` bỏ qua hoàn toàn schema validation → "schema lỗi/mất bị bỏ qua"; nested validation cũng chưa đệ quy đầy đủ.
- **Nguyên nhân gốc**: loader trả null thay vì ném; caller coi null = "không có schema để check" thay vì "không thể validate".
- **Tránh lặp lại**: mọi loader phụ thuộc file ngoài (schema/policy/config) phải NÉM lỗi khi đọc/parse fail; caller bắt và chuyển thành error reject (VD `MANIFEST_SCHEMA_UNAVAILABLE`) — fail-closed tuyệt đối, không silent-skip. Validation schema viết đệ quy duyệt mọi cấp nested (type/pattern/enum/minLength).

## L-033 (25/08/2026) — 3 lỗi test-authoring liên tiếp khi viết AC12/negative-rollback (bị verify gate bắt hết)
- **Triệu chứng**: (1) chạy test crash `upD.added is not iterable`; (2) `saved.__migrationAdded` undefined khi đọc lại registry; (3) sót expression rác `'1.0'.valueOf() && '0.9'` trong toVersion.
- **Nguyên nhân gốc**: (1) quên contract `migrateManifest`: toVersion === from → trả `{ok:true,direction:'none'}` KHÔNG có field `added` — nguồn đã ở 1.0 nên up là no-op; (2) `loadRegistry`/`saveRegistry` nhận object param `{ registryPath }`, truyền string thì destructuring rơi về default path (registry máy thật) thay vì path test; (3) draft dở sót lại khi edit.
- **Tránh lặp lại**:
  1. Muốn test round-trip up→down phải dùng nguồn version thấp hơn (0.9→1.0); nhớ direction 'none' không kèm `added`.
  2. Luôn gọi `loadRegistry({ registryPath })` / `saveRegistry({ registry, registryPath })` dạng object param.
  3. Trước khi chạy test, rà lại mọi expression vừa thêm — không để placeholder/giá trị thử nghiệm.


## L-034 (26/08/2026) — Gateway outbound queue chung -> test cần dọn trước khi enqueue
- **Triệu chứng**: test-telegram-gateway test 8 fail 2 !== 1 vì readQueue('ai-pr-reviewer','outbound') trả 2 item dù chỉ enqueue 1; item sót từ test 1 nằm cùng dir outbound (không namespaced theo appNs).
- **Nguyên nhân gốc**: contract.enqueue outbound luôn ghi vào OUTBOUND_DIR chung, không phân theo appNs như inbound; test chạy chung 1 runtime dir (TMP) nên leftover từ test trước gây nhiễu.
- **Tránh lặp lại**: test gateway dùng chung runtime dir phải dọn (unlink) file sót trong OUTBOUND_DIR trước khi assert số lượng; hoặc mỗi test dùng sub-dir riêng. Inbound namespaced, outbound thì không - ghi chú rõ trong contract.

## L-035 (26/08/2026) — `isValidAppNs` regex chỉ nhận lowercase làm reject appNs hợp lệ (camelCase)
- **Triệu chứng**: routeUpdate / enqueue reject `appA`/`appB` dù đây là namespace app hợp lệ; allowlist match sai.
- **Nguyên nhân gốc**: regex cho appNs ép `[a-z]` (lowercase-only), trong khi tên app thực tế dùng `appA`/`appB`/`ai-pr-reviewer` (có chữ hoa + dash).
- **Tránh lặp lại**: regex appNs dùng conservative, cho phép chữ (cả hoa/thường), số, `-`, `.`, `_`, giới hạn độ dài (VD `^[A-Za-z0-9._-]{1,40}$`); test bằng cả lowercase, camelCase, dash-case. Đừng ép lowercase nếu tên app được phép có hoa.

## L-036 (26/08/2026) — takeoverLock stale phải check `isLockAlive`, không chỉ `readLock()`
- **Triệu chứng**: GPT-REV-078 owner-only lock test fail `false !== true` (acq3.acquired mong đợi true). `takeoverLock` trả `lost-takeover` dù lock cũ đã STALE.
- **Nguyên nhân gốc**: hàm kiểm tra `if (readLock()) return {acquired:false}` — chỉ xét lock tồn tại, bỏ qua stale. Lock cũ (pid chết/heartbeat quá hạn) vẫn "tồn tại" nên takeover bị từ chối vĩnh viễn.
- **Tránh lặp lại**: hàm takeover chỉ từ chối khi lock `isLockAlive` (pid alive + heartbeat trong STALE_MS); stale thì unlink rồi chiếm mới bằng primitive atomic `openSync('wx')` (serialize contenders, chỉ 1 winner). Luôn test stale-takeover tường minh.

## L-037 (26/08/2026) — HEARTBEAT_MS/STALE_MS phải env-configurable để test chạy nhanh
- **Triệu chứng**: integration test (spawn real gateway child) kẹt — `notifierLoop` chỉ chạy 1 lần rồi "ngủ" 15s; item outbound không bao giờ gửi trong timeout test.
- **Nguyên nhân gốc**: `HEARTBEAT_MS` hardcode `15_000` (const), bỏ qua env `GATEWAY_HEARTBEAT_MS`. Test set env 150ms nhưng không có tác dụng → gateway poll 15s/lần.
- **Tránh lặp lại**: mọi interval/timeout của long-running loop (HEARTBEAT_MS, STALE_MS, POLL_TIMEOUT_S) đọc từ env với default fallback: `Number(process.env.X || DEFAULT)`. Test spawn child với env override là cách duy nhất kiểm soát tốc độ thực tế.

## L-038 (26/08/2026) — NotificationStore idempotency (module-level) persists xuyên test trong cùng process
- **Triệu chứng**: test `processOutbound` multi-appNs fail `1 !== 2` (sent mong 2, được 1). Item `ai-pr-reviewer` trùng key với test trước (cùng repo/ref/head) nên bị `store.shouldSend` trả false → skip.
- **Nguyên nhân gốc**: store là singleton module-level, load từ file 1 lần, giữ markSent xuyên các test chạy chung 1 process; key idempotency = `appNs::repo::ref::eventType::state::head` nên trùng với test trước.
- **Tránh lặp lại**: trong test cùng process, mỗi test dùng envelope key KHÁC BIỆT (repo/ref/head unique) để không dính idempotency của test trước; hoặc reset store. Đừng tái dùng repo/ref/head giữa các test sendItem.

## L-036 (26/08/2026) — `readQueue` trả oldest-first → test lấy `items[0]` nhầm item cũ (stale)
- **Triệu chứng**: test 8 (gateway) fail `true !== false`, test 9 fail `false !== true`; nguyên nhân item lấy từ `items[0]` thực tế là item sót từ enqueue/skip trước (queue sort theo createdAt tăng dần).
- **Nguyên nhân gốc**: `readQueue` trả mảng đã sort oldest-first; sau khi 1 item failed/skipped (vẫn nằm trong queue) rồi enqueue item mới, `items[0]` vẫn là item cũ → sendItem gửi/retry/skip nhầm.
- **Tránh lặp lại**: trong test muốn gửi item vừa enqueue, lấy `items[items.length - 1]` (mới nhất) hoặc filter theo `payload.ref`/`head` cụ thể; đừng giả định `items[0]` là item mới. Khi test nhiều bước trên chung 1 queue, `cleanRuntime()` giữa các nhóm để cách ly.

## L-037 (26/08/2026) — dòng trắng thừa ở cuối file → `git diff --check` FAIL (full-verify gate)
- **Triệu chứng**: full-verify báo FAIL tại `git diff --check scripts/...mjs: <n>: new blank line at EOF`; file vẫn valid, chỉ thừa 1 dòng trắng cuối.
- **Nguyên nhân gốc**: editor để lại newline kép cuối file; `git diff --check` coi blank line at EOF là lỗi whitespace.
- **Tránh lặp lại**: trước commit chạy `git diff --check` trên mọi file đã sửa; cắt dòng trắng thừa ở cuối (file kết thúc bằng ký tự cuối của code, không có blank line). Lỗi này full-verify bắt được nhưng chỉ hiện khi chạy thực tế (pipe/Select-String có thể không in).

## L-039 (26/08/2026) — Stale-lock takeover race: không bao giờ ghi đè lock của instance đang sống
- **Triệu chứng**: 2 contender cùng thấy lock cũ STALE, cả 2 `unlinkSync` rồi `writeFileSync` (overwrite) → 1 process ghi đè lock mới của process thắng; hoặc unlink luôn lock TƯƠI của process khác đang alive → 2 instance chạy song song (409 conflict / gửi Telegram trùng). GPT-REV-078 Critical.
- **Nguyên nhân gốc**: takeover dùng `unlinkSync`+`writeFileSync` (không atomic), không serialize contenders, không re-check staleness sau khi giành quyền; `writeFileSync` overwrite vô điều kiện nên xóa được lock của process khác.
- **Tránh lặp lại**: serialize takeover bằng guard file `openSync('wx')` (atomic); dưới guard, re-check `isLockAlive` — nếu vẫn alive → `duplicate`, KHÔNG đụng; nếu stale → `unlinkSync` rồi `openSync('wx')` chiếm mới; nếu `wx` fail (`EEXIST`, có process khác vừa chiếm) → yield, tuyệt đối không overwrite lock của instance đang sống. Giữa unlink và wx, process tươi có thể wx-create thành công → wx của ta fail → ta thua đúng (lock tươi được giữ).

## L-040 (26/08/2026) — PR lớn (>policy maxLines) phải handoff GPT trực tiếp; KHÔNG set agent:cline để chạy orchestrator pre-review
- **Triệu chứng**: muốn xin GPT re-review PR #17, đổi nhãn PR sang `agent:cline`+`status:review-requested` để orchestrator chạy pre-review → orchestrator ra `block-decision-gate` (`decisionGate: diff-limit`), mutate PR sang `status:blocked`. Diff PR #17 = 2399 dòng.
- **Nguyên nhân gốc**: `evaluateDiffLimits` với `overLimitBehavior:blocking-decision-gate`, `maxLines:1500` (metric additions+deletions) trong `.github/ai-review-policy.json`; PR feature nguyên khối (shared gateway) vượt giới hạn. Orchestrator SKIP pre-review khi PR đã có `agent:gpt` (coi là "đang chờ GPT"), chỉ chạy khi `agent:cline`.
- **Tránh lặp lại**: (1) GPT review PR này TRỰC TIẾP qua `agent:gpt`+`status:review-requested` (orchestrator skip) — trạng thái từng cho GPT review 078..084; (2) KHÔNG set `agent:cline` trên PR vượt `maxLines` (sẽ bị diff-limit block); (3) cron CI orchestrator KHÔNG quét AI_PR_REVIEWER vì committed `targetRepos=['QLDA_DTXD']` — chạy thủ công phải tạm sửa config rồi restore; (4) diff-limit là Decision Gate Mức 3 → Bố chọn giữ review trực tiếp / nâng maxLines / chia PR.

## L-041 (26/08/2026) — Supervisor phải nhánh theo owner-state, không chỉ `!isReady`; live-degraded = monitor không spawn
- **Triệu chứng**: GPT-REV-079 yêu cầu runSupervisorOnce nhánh 'live-degraded' nhưng code cũ chỉ xét `if (!isReady()) → spawn`; khi instance CÒN SỐNG (có lock + heartbeat) nhưng CHƯA ready (đang khởi động / poll đầu fail) → supervisor spawn child thứ 2. Child chạy bridge thử poll → `duplicate` lock → thoát code 3, lặp 1 vòng restart churn thừa.
- **Nguyên nhân gốc**: quyết định restart chỉ dựa trên readiness flag mà không đọc trạng thái lock owner; không phân biệt "không ready vì CHẾT/STALE" (spawn 1 để heal) với "không ready nhưng owner CÒN SỐNG" (degraded — chỉ theo dõi, đợi tự hồi phục).
- **Tránh lặp lại**: trong `runSupervisorOnce`, sau khi `isReady` false thì đọc lock: nếu `isLockAlive(lock)` (pid sống + heartbeat gần) → trả `monitor-degraded`, KHÔNG gọi `startGatewayFn`; chỉ spawn khi lock không tồn tại hoặc stale. Trong main loop coi `monitor-degraded` như trạng thái không-fail (reset backoff, không tăng consecutiveFails) — chỉ mở circuit khi recovery-failed thật. Luôn kèm unit test assert `startGatewayFn` không được gọi ở nhánh live-degraded.
## L-042 (27/08/2026) — Single-instance/authorization: ưu tiên OS-owned primitive (TCP lease) hơn file-lock để hết check-then-mutate race
- **Triệu chứng**: File-lock (`openSync('wx')` + stale-takeover + heartbeat-overwrite + release-unlink) bị GPT-REV-078 liên tục flag Critical: contender/owner cũ vẫn có thể xóa/overwrite state owner mới; test chỉ chạy acquire từ lock rỗng, không race.
- **Nguyên nhân gốc**: file-lock là check-then-mutate (read→unlink→create) không nguyên tử với nhau; heartbeat/release dùng read-LOCK rồi mới write/unlink → 2 poller có thể tái lập quyền, phá single-poller invariant (Telegram 409). Một guard thêm (`TAKEOVER_GUARD`) chỉ dời race chứ không loại.
- **Tránh lặp lại**: dùng OS-owned owner primitive khi cần single-instance/ownership: bind **TCP port localhost** (OS đảm bảo chỉ 1 process giữ, tự thả khi chết → không cần stale-scan/unlink/heartbeat-overwrite). Owner là người giữ fd do kernel quản lý, không phải file → contender/old-owner không đụng được. Chứng minh bằng **child-process thật**: contention (N cùng khởi, 1 giữ còn lại từ chối), crash→reacquire, old-owner không đổi lease owner mới. `probeLease()` chỉ xác nhận owner khi đọc được identity handshake (connect tới socket đang đóng/không data → không coi là owner).
