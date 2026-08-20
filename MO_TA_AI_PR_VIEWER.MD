BẢN ĐẶC TẢ HỆ THỐNG ĐIỀU PHỐI AI AGENT: LỘ TRÌNH 2 GIAI ĐOẠN (CLINE VS CODE ➔ AIDER CLI)Tài liệu hợp nhất toàn bộ kiến trúc, giao thức bàn giao trạng thái (Handoff Protocol), ma trận phân quyền, máy trạng thái GitHub và lộ trình triển khai 2 giai đoạn: Giai đoạn 1 (Tương tác trực quan trên VS Code qua Cline & ChatGPT) và Giai đoạn 2 (Tự động hóa hoàn toàn qua Aider CLI & Orchestrator Runner).  1. TỔNG QUAN LỘ TRÌNH 2 GIAI ĐOẠN (ROADMAP)Hệ thống được thiết kế để phát triển liền mạch từ mô hình bán tự động (tương tác giao diện) sang mô hình tự động hóa hoàn toàn (chạy nền headless) mà không cần thay đổi cấu trúc dữ liệu hoặc quy chuẩn cốt lõi:Plaintext┌───────────────────────────────────────────────────────────────────────────────────────┐
│ GIAI ĐOẠN 1: HYBRID WORKSPACE (HIỆN TẠI — TƯƠNG TÁC GIAO DIỆN VS CODE)                │
│                                                                                       │
│   [ Cline Executor (Coder) ]       ──(Mở PR Draft)──>       [ GitHub PR & Issue ]     │
│   (Giao diện VS Code Extension)                                       │               │
│                                                                       ▼               │
│   [ ChatGPT (Principal Review) ]   <──(Audit & Finding)──   [ Local Reviewer ]        │
│   (Thẩm định kiến trúc rủi ro cao)                          (VS Code Profile/Fallback)│
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                           │
                                           │ (Kế thừa 100% Rules, State Machine & Memory)
                                           ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ GIAI ĐOẠN 2: FULL HEADLESS AUTOMATION (MỤC TIÊU — TỰ ĐỘNG HÓA QUA AIDER CLI)          │
│                                                                                       │
│   ┌───────────────────────────────────────────────────────────────────────────────┐   │
│   │                 UNIVERSAL ORCHESTRATOR RUNNER (agent-runner.mjs)              │   │
│   └──────────────────────┬─────────────────────────────────┬──────────────────────┘   │
│                          │                                 │                          │
│                          ▼                                 ▼                          │
│              [ Aider Coder CLI ]                 [ Aider Reviewer CLI ]               │
│         (Worktree 1: coder-workspace)        (Worktree 2: reviewer-workspace)         │
│          - Quét issue, code, push             - Audit diff, test suite độc lập        │
│          - Tạo Draft PR                       - Gắn mã lỗi [REV-NNN] / Approve        │
└───────────────────────────────────────────────────────────────────────────────────────┘
2. MA TRẬN PHÂN VAI & BẢO MẬT (RBAC THEO 2 GIAI ĐOẠN)Thành phầnGiai đoạn 1 (Interactive)Giai đoạn 2 (Headless Automation)Quyền hạn cho phépHành động bị cấm tuyệt đốiHuman / PMTrình duyệt Web / GitTrình duyệt Web / GitQuyết định tạo task, duyệt kiến trúc, bấm Merge PR, Clasp Push, Deploy.  N/ACoderCline (VS Code GUI)  Aider Coder CLI (Terminal)Đọc Issue, tạo branch, sửa code, chạy test cục bộ, mở PR, gửi [CLINE-FIX-*].  Không tự approve finding của mình, không tự merge PR.  ReviewerChatGPT + Local Agent  Aider Reviewer CLI (Terminal)Checkout PR, chạy Quality Gates, phân tích diff, phát hành [*-REV-NNN], gắn label.  Không commit/push mã nguồn, không sửa working tree.  SSOTGitHub Repository  GitHub Repository  Lưu trữ Issue, PR, Diff, Labels, Review comments, CI Results.  N/A3. GIAO THỨC TRẠNG THÁI DÙNG CHUNG (STATE MACHINE PROTOCOL)Dù ở Giai đoạn 1 hay Giai đoạn 2, hai Agent đều giao tiếp gián tiếp qua GitHub API/CLI theo một giao thức duy nhất.  3.1. Phân nhóm Label độc quyền (Mutual Exclusion)Nhóm Reviewer (reviewer:* — Chỉ đúng 1 nhãn active cùng lúc):  reviewer:chatgpt: ChatGPT đang giữ quyền review (Giai đoạn 1).  reviewer:local: Local Agent (Giai đoạn 1) hoặc Aider Reviewer (Giai đoạn 2) đang giữ quyền review.  reviewer:none: Giải phóng lease review, sẵn sàng chuyển giao.  Nhóm Tiến trình (status:*):  status:ready-for-code: Task đã sẵn sàng cho Coder nhận việc.  status:in-progress: Coder đang xử lý trên branch riêng.status:review-requested: Đã mở PR kèm bằng chứng nghiệm thu, chờ Reviewer.  status:changes-requested: Reviewer phát hiện lỗi, yêu cầu sửa đổi.  status:approved: Đạt 100% Quality Gates, chờ con người Merge.  status:blocked: Vượt quá 3 vòng review chưa đạt chuẩn $\to$ Chờ con người xử lý.  3.2. Cấu trúc Khóa Phiên (Review Lease Object)Quản lý tránh xung đột review qua .agent/review-lease.json (hoặc PR Metadata Comment):  JSON{
  "schemaVersion": 1,
  "prNumber": 24,
  "headSha": "163d687b996fd54ef74a4393d0a66f0387198ab2",
  "activeReviewer": "local",
  "leaseExpiresAt": "2026-08-20T21:30:00Z",
  "lastFindingId": "LOCAL-REV-003",
  "handoffReason": "chatgpt-rate-limit"
}
Quy tắc bảo vệ (Guardrail): Reviewer chỉ được publish kết quả nếu SHA lúc bắt đầu phân tích trùng khớp 100% với HEAD hiện tại của PR. Nếu Coder vừa push commit mới $\to$ Hủy kết quả cũ, chạy lại từ đầu.  3.3. Quy chuẩn Finding và FeedbackĐịnh dạng Finding từ Reviewer:Markdown### [LOCAL-REV-001] (hoặc [GPT-REV-001])
- **Severity**: BLOCKING | HIGH | MEDIUM | LOW
- **Status**: OPEN
- **File/Symbol**: `src/auth/jwt.service.ts` / `verifyToken()`
- **Evidence**: Chuỗi token được giải mã trực tiếp mà không kiểm tra hạn dùng (`exp` claim).
- **Risk**: Lỗ hổng cho phép sử dụng token hết hạn để truy cập tài nguyên.
- **Required Fix**: Bổ sung logic kiểm tra `exp` claim và bắt lỗi `TokenExpiredError`.
- **Acceptance Criteria**: Unit test `test_token_expired()` phải PASS 100%.
Định dạng Phản hồi từ Coder:Markdown### [CLINE-FIX-LOCAL-REV-001] (hoặc [AIDER-FIX-LOCAL-REV-001])
- **Target Finding**: [LOCAL-REV-001]
- **Commit SHA**: `8f4b2c1`
- **Changes Made**: Đã thêm logic kiểm tra `exp` và ném exception chuẩn.
- **Verification Evidence**: `pnpm test` PASS (24/24 assertions).
4. CHI TIẾT GIAI ĐOẠN 1: CLINE (VS CODE) ↔ CHATGPT / LOCAL REVIEWERGiai đoạn 1 tập trung vào sự kiểm soát trực quan, làm việc trực tiếp trong giao diện VS Code.  4.1. Cấu hình Cline làm Coder (Custom Instructions)Dán nội dung sau vào mục Custom Instructions của Cline:MarkdownBạn là SENIOR DEVELOPER (Coder). Nhiệm vụ: Nhận Issue từ GitHub, lập trình, test và mở PR.

QUY TRÌNH LÀM VIỆC:
1. Intake: Quét issue có nhãn `status:ready-for-code` (`gh issue list --label "status:ready-for-code" --limit 1`).
2. Claim: Đổi nhãn sang `status:in-progress` và tạo nhánh `feat/issue-<id>-<name>`.
3. Triển khai: Sửa code, viết unit test, chạy `pnpm verify` (hoặc test tương đương) đảm bảo PASS 100%.
4. Bàn giao: Commit, push và tạo Draft PR (`gh pr create --draft --title "feat(issue-<id>): ..." --body-file REVIEW_PACKET.md`).
5. Gắn nhãn PR: `status:review-requested` và `reviewer:chatgpt` (hoặc `reviewer:local`).
6. Fix Loop: Khi PR bị `status:changes-requested`, đọc `[*-REV-NNN]`, sửa code, commit và comment phản hồi dạng `[CLINE-FIX-*]`.

GIỚI HẠN: Không tự ý merge PR, không commit secrets (.env).
4.2. Quy trình Reviewer trong Giai đoạn 1Khi dùng ChatGPT Web: Bạn copy Diff + PR description sang ChatGPT, yêu cầu xuất finding dạng [GPT-REV-NNN]. Sau đó dán comment vào PR trên GitHub.  Khi ChatGPT hết hạn mức: Chuyển nhãn sang reviewer:local. Sử dụng Local Agent trong VS Code (chế độ chỉ đọc/chạy test) để quét diff và xuất finding [LOCAL-REV-NNN].  5. CHI TIẾT GIAI ĐOẠN 2: AIDER CLI (HEADLESS & FULL AUTOMATION)Giai đoạn 2 loại bỏ hoàn toàn thao tác copy thủ công trên giao diện. Hai thực thể Aider CLI chạy tự động nền qua Terminal Orchestrator.  5.1. Cài đặt môi trường Giai đoạn 2Cài đặt Aider CLI:Bashpip install pipx
pipx ensurepath
pipx install aider-chat
Cài đặt GitHub CLI & Đăng nhập:Bashgh auth login
Khai báo API Key:Bashexport ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
5.2. Phân lập Git Worktree cho AiderTại thư mục repo gốc, tạo 2 workspace độc lập:  Bashcd /projects/my-project
git worktree add ../coder-workspace main
git worktree add ../reviewer-workspace main
5.3. Thư mục cấu hình tiêu chuẩn .agent/Tạo thư mục .agent/ tại gốc repository:File 1: .agent/config.jsonJSON{
  "project_name": "Universal-Project",
  "default_branch": "main",
  "max_review_loops": 3,
  "commands": {
    "test": "npm test",
    "lint": "npm run lint",
    "verify": "npm test"
  },
  "protected_paths": [
    ".env*",
    "**/secrets/**",
    ".agent/**"
  ],
  "labels": {
    "ready_to_code": "status:ready-for-code",
    "in_progress": "status:in-progress",
    "review_requested": "status:review-requested",
    "changes_requested": "status:changes-requested",
    "approved": "status:approved",
    "blocked": "status:blocked"
  }
}
File 2: .agent/conventions-coder.mdMarkdown# QUY CHUẨN THỰC THI CHO AIDER CODER

Bạn là Senior Software Engineer. Nhiệm vụ: Nhận Issue, viết code, chạy test và tạo Pull Request.

QUY TRÌNH BẮT BUỘC:
1. Đọc yêu cầu từ Issue qua `gh issue view <id>`.
2. Gắn nhãn `status:in-progress` và tạo nhánh `feat/issue-<id>-implementation`.
3. Viết code sạch, bổ sung Unit Test đầy đủ.
4. Chạy lệnh kiểm thử (`commands.verify` trong `.agent/config.json`) đảm bảo PASS 100%.
5. Commit: `git commit -m "feat(#<id>): hoàn thành nội dung task"`.
6. Push: `git push -u origin feat/issue-<id>-implementation`.
7. Tạo Draft PR: `gh pr create --draft --title "feat(issue-<id>): ..." --body-file REVIEW_PACKET.md`.
8. Đổi nhãn PR sang `status:review-requested` và `reviewer:local`.
9. Khi nhận `status:changes-requested`:
   - Đọc comment `[*-REV-NNN]` qua `gh pr view <pr_id> --comments`.
   - Sửa lỗi chính xác, chạy lại verify.
   - Commit, push và phản hồi comment dạng `[AIDER-FIX-*-REV-NNN]`.
   - Đổi lại nhãn `status:review-requested`.

GIỚI HẠN: Không sửa protected_paths, không tự merge PR.
File 3: .agent/conventions-reviewer.mdMarkdown# QUY CHUẨN AUDIT CHO AIDER REVIEWER

Bạn là QA Lead & Security Reviewer. Nhiệm vụ: Đánh giá độc lập chất lượng code và an toàn bảo mật trên Pull Request.

QUY TRÌNH AUDIT:
1. Quét PR có nhãn `status:review-requested`.
2. Checkout PR về workspace: `gh pr checkout <pr_id>`.
3. Lấy diff: `gh pr diff <pr_id>`.
4. Chạy toàn bộ lệnh kiểm thử độc lập (`commands.verify`, `commands.lint`).
5. Đánh giá:
   - Scope: Có sửa ngoài phạm vi Issue không?
   - Logic: Có lỗi boundary/null/rollover không?
   - Security: Có lỗ hổng SQLi/XSS/lộ secret không?

KẾT LUẬN:
- CÓ LỖI:
  - Xuất finding `[LOCAL-REV-NNN]` (File, Line, Evidence, Risk, Required Fix).
  - Chạy: `gh pr review <pr_id> --request-changes --body "<Nội dung finding>"`.
  - Đổi nhãn: `status:changes-requested`.
- PASS 100%:
  - Chạy: `gh pr review <pr_id> --approve --body "✅ Verification PASS 100%."`.
  - Đổi nhãn: `status:approved`.

GIỚI HẠN: Sau 3 vòng review không đạt $\to$ gắn `status:blocked`. Tuyệt đối không tự merge/deploy.
File 4: .agent/REVIEW_PACKET_TEMPLATE.mdMarkdown# REVIEW PACKET — Issue #{{ISSUE_ID}} (PR #{{PR_ID}})
- **Nhánh**: `{{BRANCH_NAME}}`
- **Các file sửa đổi**: {{FILE_LIST}}
- **Kết quả kiểm thử**: PASS ({{TEST_OUTPUT_SUMMARY}})
- **Danh sách Fix**: [CLINE-FIX-*] / [AIDER-FIX-*][cite: 1]
5.4. Universal Orchestrator Runner (agent-runner.mjs)Script tự động quét trạng thái và gọi Aider CLI:JavaScript#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET_REPO = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const CONFIG_PATH = path.join(TARGET_REPO, '.agent/config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`❌ Không tìm thấy cấu hình tại: ${CONFIG_PATH}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const CODER_DIR = path.resolve(TARGET_REPO, '../coder-workspace');
const REVIEWER_DIR = path.resolve(TARGET_REPO, '../reviewer-workspace');

function run(cmd, cwd = TARGET_REPO) {
  console.log(`\n⚡ [EXEC in ${path.basename(cwd)}]: ${cmd}`);
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'inherit' });
}

function query(cmd, cwd = TARGET_REPO) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function orchestrate() {
  console.log(`\n🔍 [${config.project_name}] QUÉT TRẠNG THÁI TASK GITHUB...`);

  // 1. Quét PR cần Review (Aider Reviewer)
  const reviewPr = query(`gh pr list --label "${config.labels.review_requested}" --label "reviewer:local" --limit 1 --json number --jq ".[0].number"`);
  if (reviewPr) {
    console.log(`🧐 Phát hiện PR #${reviewPr} chờ Review. Khởi chạy Aider Reviewer...`);
    run(
      `aider --read .agent/conventions-reviewer.md --message "Audit PR #${reviewPr} theo đúng tiêu chuẩn trong .agent/conventions-reviewer.md." --yes-always --no-auto-commits`,
      REVIEWER_DIR
    );
    return;
  }

  // 2. Quét PR bị Changes Requested (Aider Coder)
  const fixPr = query(`gh pr list --label "${config.labels.changes_requested}" --limit 1 --json number --jq ".[0].number"`);
  if (fixPr) {
    console.log(`🔧 Phát hiện PR #${fixPr} cần sửa lỗi. Khởi chạy Aider Coder...`);
    run(
      `aider --read .agent/conventions-coder.md --message "Đọc review comments trên PR #${fixPr}, sửa đúng các finding [*-REV-xxx] và phản hồi [AIDER-FIX-*]." --yes-always --no-auto-commits`,
      CODER_DIR
    );
    return;
  }

  // 3. Quét Issue mới (Aider Coder)
  const newIssue = query(`gh issue list --label "${config.labels.ready_to_code}" --limit 1 --json number --jq ".[0].number"`);
  if (newIssue) {
    console.log(`🚀 Phát hiện Issue #${newIssue} mới. Khởi chạy Aider Coder...`);
    run(
      `aider --read .agent/conventions-coder.md --message "Nhận Issue #${newIssue}, triển khai code và tạo Draft PR theo .agent/conventions-coder.md." --yes-always --no-auto-commits`,
      CODER_DIR
    );
    return;
  }

  console.log('💤 Không có task nào ở trạng thái chờ.');
}

orchestrate().catch(console.error);
6. KẾ THỪA DỮ LIỆU TỪ GIAI ĐOẠN 1 SANG GIAI ĐOẠN 2Khi chuyển từ Giai đoạn 1 (Cline) sang Giai đoạn 2 (Aider), toàn bộ dữ liệu dự án được kế thừa như sau:Quy tắc (.clinerules) $\to$ Kế thừa 100%[cite: 1]: Aider đọc trực tiếp thông qua --read .agent/conventions-coder.md (hoặc --read .clinerules).Ngữ cảnh & Bộ nhớ (Memory Bank) $\to$ Kế thừa qua file Markdown & Git[cite: 1]:Aider tự động phân tích toàn bộ cấu trúc mã nguồn qua cơ chế Tree-sitter AST Repo Map.Để nạp context tiến độ từ Cline sang Aider, xuất file PROJECT_CONTEXT.md (hoặc activeContext.md)[cite: 1] và chạy:Bashaider --read .agent/conventions-coder.md --read memory-bank/activeContext.md
Lịch sử sửa lỗi & Findings $\to$ Kế thừa trực tiếp qua GitHub PR Threads: Aider đọc toàn bộ thread thảo luận cũ qua lệnh gh pr view <id> --comments.  