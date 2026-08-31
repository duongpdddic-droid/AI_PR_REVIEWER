# GIAO THỨC PHỐI HỢP GPT ↔ CLINE QUA GITHUB

> REV-ISSUE-2 (22/08/2026): tách biệt tuyệt đối CI verification ≠ semantic review ≠ approval ≠
> merge authorization. Quy tắc máy đọc được nằm tại `.github/ai-review-policy.json` — tài liệu này
> là bản diễn giải cho người, KHÔNG tự định nghĩa lại quy tắc.

## 1. Mục tiêu

GitHub là kênh trao đổi chính thức giữa các tác nhân:

- **Cline** sửa code, chạy kiểm tra, commit, push và mở PR.
- **AI_PR_REVIEWER local (`reviewer:local`)** là pre-reviewer: xác minh CI (fail-closed) +
  pre-review deterministic; chỉ phát `PRE_REVIEW_PASS` | `PRE_REVIEW_FINDINGS`; **không bao giờ approve**.
- **GPT (`agent:gpt`)** là reviewer phê duyệt cuối DUY NHẤT. Approval được ghi qua
  `scripts/gpt-approval.mjs`, khóa theo full HEAD SHA + policy version.
- GitHub Issue lưu yêu cầu và quyết định; Pull Request lưu diff, bằng chứng và review thread;
  GitHub Actions kiểm tra độc lập.
- **Người dùng giữ quyền merge và deploy** — không agent nào tự thực hiện.

## 1a. Mô hình reviewer hai giai đoạn ([USER-DECISION] sau Issue #2)

Canonical: `reviewerPhases` trong `.github/ai-review-policy.json` (policyVersion `2026-08-23.5`,
canonical DUY NHẤT — Issue #5; repo dự án KHÔNG giữ bản sao, chỉ tham chiếu + pin qua
`projectPolicyContract`). Diễn giải:

### Giai đoạn chuyển tiếp — `transition`

- Hiệu lực khi Issue `duongpdddic-droid/AI_PR_REVIEWER#2` chưa hoàn thành: runtime wiring
  (`unified-orchestrator.mjs` / `review-contract.mjs` / `gpt-approval.mjs`) chưa được triển khai
  qua PR riêng được GPT duyệt và merge (`transition.runtimeWiringPrRequired = true`).
- GPT (`agent:gpt`) là reviewer cuối cho hai PR triển khai Issue #2; approval chỉ do GPT phát,
  relay bởi người dùng qua `scripts/gpt-approval.mjs`.
- `localReviewerCanApprove: false` — AI_PR_REVIEWER không tự chứng nhận thay đổi kiến trúc
  reviewer của chính nó.

### Trạng thái vận hành — `steadyState` (chỉ hiệu lực sau khi PR runtime wiring được GPT duyệt + merge)

- Reviewer mặc định là `reviewer:local`; được phép approve khi đủ TOÀN BỘ
  `approvalRequiresAllGates` (6 gate: CI pass đủ required checks, semantic review thật,
  approval khóa HEAD SHA + policyVersion, không còn finding chặn, policy hợp lệ,
  read-after-write thành công).
- GPT không re-review từng PR; chỉ escalation theo `escalateToGptWhen`
  (5 trường hợp) hoặc hậu kiểm/chọn mẫu.
- Bất kỳ thiếu bằng chứng/xung đột/nghi ngờ → fail-closed: chuyển GPT hoặc `status:blocked`.
- **Steady-state KHÔNG tự kích hoạt** khi hai PR triển khai Issue #2 được merge
  (`steadyState.activationRequires = [runtimeWiringPrGptApproved, runtimeWiringPrMerged]`,
  `transition.runtimeWiringPrRequired = true`): cần PR thứ ba wiring runtime
  (`unified-orchestrator.mjs` / `review-contract.mjs` / `gpt-approval.mjs`) được GPT duyệt đúng
  HEAD SHA và người dùng merge — acceptance criterion bắt buộc để đóng Issue #2.

Bất biến mọi pha (`invariantsAllPhases`): CI PASS không approve; checks rỗng fail-closed;
approval khóa full HEAD SHA + policyVersion; HEAD đổi → vô hiệu; finding Critical/Important
còn mở chặn approval; PR draft/closed/merged/event muộn không bao giờ được approve;
nhiều nhãn trạng thái/mutation dở/read-back sai → blocked; không nuốt lỗi GitHub/Telegram/model;
người dùng luôn quyết merge/deploy.

## 2. Nguồn sự thật

Thứ tự ưu tiên khi có mâu thuẫn:

1. Code và lịch sử commit trong repository.
2. `.github/ai-review-policy.json` tại HEAD của PR (cho mọi quy tắc review/approval).
3. GitHub Issue đang thực hiện.
4. Pull Request và review thread.
5. `memory-bank/activeContext.md`.
6. Các tài liệu Memory Bank còn lại.
7. Nội dung chat tạm thời.

Không dùng Telegram, file inbox cục bộ hoặc lịch sử chat làm nguồn sự thật chính cho code.

### 2a. Effective policy — canonical + project config (Issue #5)

- **Canonical duy nhất**: `.github/ai-review-policy.json` trong repo `AI_PR_REVIEWER` là nguồn
  duy nhất cho toàn bộ quy tắc review toàn cầu (state machine, labels, vai trò, pha
  transition/steady-state, contract reviewer↔coder, discovery, approval, fail-closed).
- **Repo dự án** (vd `QLDA_DTXD`) KHÔNG giữ bản sao global policy/protocol; chỉ giữ:
  - `.github/project-review-policy.json`: `policySource` (repo canonical + ref +
    **pinnedVersion**) và `projectOverrides` CHỈ trên các khóa trong
    `allowedProjectOverrides` (vd `requiredChecks`, `protectedPaths`, quy tắc GAS/deploy).
  - Stub `docs/AGENT_HANDOFF_PROTOCOL.md` dẫn về canonical + pinned version.
- **Effective policy = canonical global + project overrides (allowed only)**; precedence và
  các mã fail-closed (`BLOCKED_CANONICAL_UNAVAILABLE`, `BLOCKED_CANONICAL_INVALID`,
  `BLOCKED_VERSION_MISMATCH`, `BLOCKED_INVALID_OVERRIDE`, `BLOCKED_INVARIANT_OVERRIDE`) khai
  báo trong `projectPolicyContract` của policy canonical.
- Resolver: `scripts/effective-policy.mjs`; orchestrator/gpt-approval đọc policy qua
  resolver (không còn đọc bản mirror trên target repo). Canonical không đọc được, version lệch
  pin, hoặc override chạm invariant → **status:blocked**, không approve, không suy đoán.

## 3. Vai trò

### AI_PR_REVIEWER local (`reviewer:local` — pre-reviewer)

- Xác minh CI theo `requiredChecks` trong policy: thiếu check / không đọc được → fail-closed,
  trả Cline (`status:changes-requested` + `agent:cline`), không bao giờ coi "không có gì fail" là PASS.
- Pre-review deterministic trên diff: secret scan, giới hạn diff; verdict chỉ là
  `PRE_REVIEW_PASS` hoặc `PRE_REVIEW_FINDINGS`.
- Chuyển nhãn: `status:review-requested` → `status:reviewing` → `status:changes-requested`
  hoặc bàn giao GPT (`status:review-requested` + `agent:gpt`).
- Vượt `maxReviewRounds` → `status:blocked`, hỏi người dùng.

### GPT (`agent:gpt` — final reviewer)

- Chỉ GPT được phát quyết định APPROVAL cuối, relay bởi người dùng qua:
  `node scripts/gpt-approval.mjs --repo <owner/repo> --pr <số> --payload '<json>' [--note "<trích quyết định>"]`
  với json = `{"repository":"<owner/repo>","prNumber":<số>,"headSha":"<full 40 hex>","policyVersion":"<version hiện hành>","decisionId":"<id không khoảng trắng>"}`.
- **Giới hạn xác thực (GPT-REV-032)**: script là user-relay gate fail-closed — payload phải khớp
  tuyệt đối repo + PR + full HEAD SHA + policyVersion + decision ID, nếu thiếu/lệch → từ chối,
  không mutation. Script KHÔNG tự xác minh danh tính GPT; đảm bảo relay đúng quyết định GPT
  thuộc về người dùng. Không có code path tự động nào được gọi gate này.
- Thứ tự mutation an toàn (GPT-REV-033): đăng marker TRƯỚC → read-back xác nhận → sau đó mới
  chuyển `status:approved`; lỗi giữa chừng → PR không bao giờ kết thúc approved-thiếu-marker.
- Thu hồi approval: `--revoke "<lý do>"`.

### Cline

- Chỉ nhận task có label `status:ready-for-cline`.
- Đọc toàn bộ Issue trước khi sửa; tạo nhánh riêng từ `main` mới nhất.
- Chỉ sửa trong phạm vi Issue cho phép; chạy kiểm tra và ghi bằng chứng thật.
- Tạo Draft Pull Request liên kết Issue (`Ref #<số>`; chỉ dùng `Closes #` khi PR hoàn tất trọn vẹn Issue).
- Fix review thẳng trên branch của PR, phản hồi `[CLINE-FIX-NNN]`; **không tạo issue [review-fix]**
  — mọi vòng fix đi qua nhãn trên PR.
- Không tự merge, deploy hoặc thao tác khó hoàn tác.

### Người dùng

- Relay quyết định GPT (approval/thu hồi) qua `gpt-approval.mjs`.
- Quyết định khi task bị chặn; phê duyệt thay đổi ngoài phạm vi.
- Quyết định merge vào `main`; quyết định deploy production; quyết định thao tác ảnh hưởng dữ liệu thật.

## 4. Hệ thống label

| Label | Ý nghĩa | Bên xử lý tiếp |
|---|---|---|
| `status:queued` | Đã ghi nhận, chưa giao | Người dùng/GPT |
| `status:ready-for-cline` | Đặc tả đã sẵn sàng | Cline |
| `status:in-progress` | Cline đang thực hiện | Cline |
| `status:review-requested` | Cline đã bàn giao / chờ GPT quyết định cuối | reviewer:local hoặc GPT |
| `status:reviewing` | CI PASS — pre-review đang chạy | reviewer:local |
| `status:changes-requested` | Có finding phải sửa (kèm `agent:cline`) | Cline |
| `status:approved` | GPT đã phê duyệt cuối (có approval marker hợp lệ) | Người dùng (merge) |
| `status:blocked` | Cần người dùng quyết định | Người dùng |

Label vai trò:

| Label | Ý nghĩa |
|---|---|
| `agent:cline` | Executor |
| `agent:gpt` | Final reviewer (duy nhất được approval) |
| `reviewer:local` | Pre-reviewer (không phải agent label, không bao giờ approve) |

- KHÔNG dùng `agent:local-reviewer` hay tên `AI_PR_VIEWER` trong bất kỳ quy tắc nào.
- Một Issue/PR chỉ được có đúng MỘT label `status:*` tại một thời điểm
  (`normalizeStatusLabels` trong `scripts/review-contract.mjs` tự chữa vi phạm).
- `risk:deploy`, `risk:destructive`: đánh dấu PR cần người dùng đặc biệt chú ý trước merge.

## 5. Luồng thực hiện chuẩn

1. **Giao việc**: Issue được gắn `agent:cline` + `status:ready-for-cline`
   (đặc tả/phạm vi/tiêu chí nghiệm thu rõ ràng).
2. **Claim**: Cline tự phát hiện qua `node scripts/github-task-intake.mjs` (read-only → claim,
   preflight workspace/Git fail-closed, idempotent, read-after-write). Chi tiết cơ chế claim nằm ở
   README của script; protocol này không lặp lại.
3. **Nhánh**: `fix|feat|chore/issue-<số>-<mô-tả>` từ `main` mới nhất.
4. **Thực hiện**: sửa code + quality gate PASS (`pnpm verify`, `pnpm test`) + Memory Bank.
5. **PR**: mở Draft PR theo `.github/PULL_REQUEST_TEMPLATE.md`, liên kết `Ref #<số>`.
6. **Bàn giao**: bỏ `status:in-progress`, gắn `status:review-requested`.
7. **Orchestrator review** (`scripts/unified-orchestrator.mjs`, cron/manual):
   - CI pending → chờ, không mutation.
   - CI fail/missing/unknown → `status:changes-requested` + `agent:cline`, comment fail-closed.
   - CI PASS → `status:reviewing` → pre-review deterministic trên diff:
     - `PRE_REVIEW_PASS` → bàn giao GPT: `status:review-requested` + `agent:gpt`;
     - `PRE_REVIEW_FINDINGS` → `[LOCAL-REV-NNN]` + `status:changes-requested` + `agent:cline`;
     - vượt `maxReviewRounds` → `status:blocked`.
   - Orchestrator **không bao giờ** gắn `status:approved`; PR có `agent:gpt` bị bỏ qua cho tới khi
     GPT quyết định hoặc approval-drift bị phát hiện.
8. **Approval**: người dùng relay quyết định GPT qua `scripts/gpt-approval.mjs` →
   `status:approved` + approval marker khóa HEAD SHA.
9. **Merge & deploy**: do người dùng thực hiện. Deploy luôn là task riêng.

### 5a. Approval khóa HEAD SHA (chống approval cũ còn hiệu lực)

- Approval marker là HTML comment JSON: `{repository, prNumber, reviewer:'agent:gpt', headSha (full 40-hex),
  policyVersion, ciEvidence, openBlockingFindings, reviewedAt}`.
- Approval chỉ hợp lệ khi: reviewer là `agent:gpt`; SHA khớp HEAD hiện tại; policyVersion khớp;
  repo/pr khớp; không còn finding blocking mở. Lệch bất kỳ → vô hiệu.
- **Approval-drift**: orchestrator quét cả PR `status:approved`; thấy approved mà không có marker
  hợp lệ cho HEAD hiện tại → gỡ hiệu lực, về `status:review-requested` + `agent:gpt`, comment cảnh báo.

### 5b. Event muộn và PR đóng

- Event đính kèm SHA cũ đến sau khi HEAD đổi → bỏ qua, không lùi trạng thái (`isStaleEvent`).
- PR closed/merged không bao giờ bị mutation nhãn/comment bởi agent.
- Lỗi phát hiện sau merge → regression Issue mới + nhánh mới, không tái sử dụng PR cũ.
- Mọi mutation có khóa idempotency `repo::pr::headSha::policyVersion::action` trong comment
  (`<!-- ai-pr-reviewer:key=... -->`); chạy lại chu kỳ không phát hành trùng.

## 6. Quy tắc review

Contract máy đọc được canonical: `reviewerCoderContract` trong `.github/ai-review-policy.json`.
Mục này diễn giải; khi mâu thuẫn → policy thắng.

Mỗi finding của pre-reviewer/reviewer phải có ĐỦ 5 trường bắt buộc theo policy
(`findingRequiredFields`):

- `code`: `[LOCAL-REV-NNN]` / `[GPT-REV-NNN]` (kèm `[GPT-RULE-NNN]`/`[LOCAL-RULE-NNN]` nếu trích quy tắc).
- `severity`: Critical | Important | Suggestion (taxonomy `severityTaxonomy`; Critical/Important blocking).
- `evidence`: file/khu vực/vấn đề đã xác nhận (không suy đoán).
- `risk`: rủi ro hoặc hành vi sai.
- `expectedOutcome`: yêu cầu sửa kiểm chứng được + điều kiện đóng finding.

Finding thiếu bất kỳ trường nào = malformed-finding: Cline phản hồi `[CLINE-REBUT-NNN]`
với lý do `malformed-finding`; reviewer phải bổ sung/cập nhật finding trước khi nó tiếp tục blocking.

Cline phản hồi theo MỘT trong hai verdict hợp lệ (`coderVerdicts`):

- `[CLINE-FIX-NNN]`: đã sửa — commit, nội dung sửa, lệnh kiểm tra, kết quả kiểm tra,
  trạng thái `READY_FOR_REREVIEW`.
- `[CLINE-REBUT-NNN]`: phản biện bằng bằng chứng cụ thể (code/API/test/số liệu).
  REBUT không được dùng để tự resolve thread khi chưa có commit/bằng chứng tương ứng
  (`coderSelfResolveForbidden: true`).

Reviewer BẮT BUỘC xử lý từng `[CLINE-REBUT-NNN]` với một verdict
(`reviewerRebuttalVerdicts`): `ACCEPTED` (đóng finding, ghi nhận lập luận) hoặc
`REJECTED` (trả lời từng điểm bằng evidence). Im lặng = finding còn mở.

Bất đồng không phân xử được sau một vòng `REBUT → REJECTED` → fail-closed
(`unresolvedDisputeBehavior`): chuyển `agent:gpt` hoặc `status:blocked` hỏi người dùng.
Cline KHÔNG tự đóng thread, KHÔNG tự gắn nhãn approved.
Tối đa `maxReviewRounds` vòng fix cho một HEAD; vượt → `status:blocked`.

### 6a. Lệnh tối thiểu và task discovery fail-closed

Canonical: `minimalCommandDiscovery` trong policy. Diễn giải:

- Hai lệnh tối thiểu **"Xử lý tiếp."** và **"Thực thi tiếp."** TƯƠNG ĐƯƠNG tuyệt đối
  (`equivalentTo: discover-and-resume`): Coder và Reviewer hiểu cùng một nghĩa —
  tự khám phá trạng thái rồi tiếp tục. Người dùng KHÔNG phải nhớ số Issue/PR.
- Thứ tự tự đối chiếu bắt buộc (`discoveryOrder`): repo/origin + worktree → Memory Bank
  (`activeContext.md`, `progress.md`) → GitHub (Issue/PR/HEAD/CI/findings).
- Hành vi theo số lượng task (`zeroTaskBehavior` / `oneTaskBehavior` /
  `manyOrConflictingTaskBehavior`):
  - Zero → `NO_TASK`, không mutation.
  - One → claim đúng một task (sau preflight PASS) rồi thực thi.
  - Many/mâu thuẫn → `status:blocked` hỏi người dùng; KHÔNG đoán, KHÔNG tự chọn.
- Stale checkpoint trong Memory Bank KHÔNG bao giờ thắng trạng thái GitHub thật
  (Issue đã đổi labels/PR đã merge → trạng thái GitHub thắng; cập nhật Memory Bank sau).

## 7. Quality Gate

PR chỉ đủ điều kiện bàn giao GPT khi:

- GitHub Actions PASS đủ `requiredChecks` trong policy (fail-closed nếu thiếu/không đọc được).
- `pnpm verify` PASS; `pnpm test` (+ `pnpm test:integration`) PASS với dự án có cấu hình.
- Không có review thread Critical/Important chưa xử lý.
- Không có file ngoài phạm vi; không chứa secret, backup, file tạm hoặc log.
- Memory Bank cập nhật nếu task làm thay đổi trạng thái dự án.

## 8. Decision Gate

Cline và GPT phải dừng, gắn `status:blocked` và hỏi người dùng khi:

- Cần sửa ngoài phạm vi Issue.
- Cần đổi schema hoặc dữ liệu thật.
- Cần deploy hoặc thay đổi deployment production.
- Cần xóa dữ liệu, force-push, reset hoặc thao tác khó hoàn tác.
- Có xung đột giữa yêu cầu và trạng thái repository.
- Vượt quá `maxReviewRounds` vòng review–fix, hoặc một finding thất bại hai lần liên tiếp.

Khi chuyển `status:blocked`: **BẮT BUỘC** gửi Telegram qua `node scripts/notify-telegram.mjs`
(tiêu đề ghi `BLOCKED` + Issue/PR, tóm tắt câu hỏi cần quyết định), kiểm tra exit code và ghi
bằng chứng `SENT`/`FAILED` (xem §11).

## 9. Giới hạn vòng lặp

- Tối đa `maxReviewRounds` (policy) vòng pre-review → Cline Fix cho một PR.
- Không tạo finding mới chỉ để thay đổi phong cách nếu không ảnh hưởng tiêu chí.
- Thay đổi ngoài Issue phải tạo Issue mới hoặc được người dùng duyệt.
- Diff vượt `diffLimits.maxLines` (policy, metric additions-plus-deletions) → finding Critical
  blocking + **Decision Gate**: chuyển `status:blocked`, không trả Cline như lỗi code và không
  handoff approval; chỉ người dùng có thể ghi nhận ngoại lệ hoặc yêu cầu tách PR (GPT-REV-031).
- GPT không tự merge; Cline không tự deploy; reviewer:local không approve.

## 10. Quy tắc hoàn thành

`COMPLETE` chỉ hợp lệ khi có đủ:

1. Implementation tồn tại trong commit.
2. GitHub Actions PASS (required checks theo policy).
3. Các test áp dụng PASS.
4. Review thread chặn đã được giải quyết.
5. GPT đã phê duyệt cuối (approval marker hợp lệ tại HEAD merge).
6. Memory Bank đã ghi nhận.
7. Người dùng đã quyết định merge hoặc xác nhận không cần merge.

Thiếu một điều kiện phải báo `IN PROGRESS`, `CHANGES REQUESTED` hoặc `BLOCKED`.

## 11. Thông báo Telegram

- KHÔNG gửi báo cáo Telegram khi tạo Issue hay trong lúc thực hiện Issue.
- Chỉ gửi báo cáo tổng kết MỘT LẦN khi một vòng xử lý kết luận (`notify` do orchestrator gọi sau
  mutation thành công; script tự retry tối đa 3 lần). Kiểm tra exit code: `0` = SENT;
  `1` = Telegram API lỗi (đã retry hết); `2` = thiếu token/config. Ghi bằng chứng `SENT`/`FAILED`
  vào `memory-bank/activeContext.md` ngay sau khi chạy. Lỗi gửi không được nuốt: chu kỳ có lỗi
  Telegram phải hiện trong evidence, không được coi là "đã thông báo".
- Riêng `status:blocked` hoặc mở Decision Gate vẫn bắt buộc gửi Telegram hỏi người dùng (xem §8).
- `node scripts/telegram-bridge.mjs --process` chỉ đọc hàng đợi lệnh cục bộ, **KHÔNG được coi là
  bằng chứng đã thông báo**.
- Không sửa logic/secret của `notify-telegram.mjs`/`telegram-bridge.mjs`
  (`watchdog-hibernate.mjs` đã xóa khỏi repo này — Issue #15: gateway quản lý lock/heartbeat/supervisor thay thế) trừ khi có yêu cầu riêng.

## 12. Canonical REVIEW HANDOFF CONTRACT (Issue #32)

- **Canonical duy nhất**: `scripts/review-handoff-contract.mjs` trong repo `AI_PR_REVIEWER`,
  versioned (`CONTRACT_VERSION`). Bản diễn giải cho người: `docs/REVIEW_HANDOFF_CONTRACT.md`.
- **KHÔNG copy** contract vào repo dự án. Task packet/handoff prompt tham chiếu pin version khi
  runtime resolve được (`buildTaskPacket`); nếu không resolve được → inline toàn bộ content,
  vượt `maxBytes` → fail-closed `PACKET_TRUNCATED`.
- **Validator**: `validateHandoff(report)` → `{ ok, status, errors }` (structured errors). Thiếu
  required section / exact HEAD / commands+exit code / safety / unverified-risks / terminal status,
  hoặc "all green" mâu thuẫn failure → `PARTIAL_EVIDENCE` (fail-closed).
- **Gate**: chỉ report `READY_FOR_REVIEW` mới qua `canRequestReview`. `task_handoff` (MCP) chặn
  `HANDOFF_PARTIAL_EVIDENCE` trước mọi mutation nếu `handoffReport` không hợp lệ.
- **Short operator command**:

  > "Thực hiện tiếp và bàn giao theo canonical REVIEW HANDOFF CONTRACT."

  Agent tự khám phá trạng thái (Issue/PR/branch/HEAD), hoàn thành phần còn lại, lập báo cáo 10
  section theo contract, chạy `validateHandoff` → `READY_FOR_REVIEW`, rồi `task_handoff` kèm
  `handoffReport` hợp lệ. KHÔNG tự merge/deploy/approve.