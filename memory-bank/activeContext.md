# Active Context (AI_PR_REVIEWER)

## Mục tiêu
Thực hiện Issue #2 (duongpdddic-droid/AI_PR_REVIEWER#2): chuẩn hóa toàn bộ AI PR Review —
tách CI verification ≠ semantic review ≠ approval ≠ merge authorization; approval khóa HEAD SHA;
GPT là reviewer phê duyệt cuối DUY NHẤT; local reviewer chỉ pre-review
(PRE_REVIEW_PASS | PRE_REVIEW_FINDINGS). Hai PR riêng: PR1 repo này trước, PR2 QLDA_DTXD sau.

## Chế độ
Tự hành (act) — task đặc biệt, người dùng giao GPT toàn quyền quyết định kỹ thuật;
Cline executor; KHÔNG tự gắn status:approved, KHÔNG merge/deploy.

## Kế hoạch thực thi (PR 1)
1. [x] Đọc Issue #2 + khảo sát source.
2. [x] Branch `chore/issue-2-review-contract` từ main.
3. [x] Module thuần `scripts/review-contract.mjs` (policy/CI fail-closed/approval SHA-lock/drift/stale/rounds/gate/secret-scan/diff-limits/routing).
4. [x] Rewrite `scripts/unified-orchestrator.mjs` (DI io; không auto-approve; không issue [review-fix]; read-after-write; chống event muộn; drift; idempotency key repo::pr::sha::policy::action).
5. [x] `.github/ai-review-policy.json` v1 (`2026-08-22.1`, requiredChecks=[verify], blockingSeverities=[critical,high], maxReviewRounds=3, finalReviewer=agent:gpt).
6. [x] `notify-telegram.mjs`: retry qua `withRetry` (3 lần) giữ exit code 0/1/2; `gpt-approval.mjs` mới là cổng duy nhất ghi approval GPT.
7. [x] Tests: `test-pure-logic.mjs` 101/101 PASS (C.1–C.14) + `test-integration-orchestrator.mjs` mới 52/52 PASS (I.1–I.14); full-verify chạy cả hai.
8. [x] Đồng bộ docs/config: AGENT_HANDOFF_PROTOCOL.md viết lại REV-ISSUE-2; AGENTS.md; .clinerules/01 §13; PR template (+ section HEAD SHA); .agent/config.json + reviewer.config.json (label reviewing, policy file, finalReviewer/preReviewer); conventions-coder/reviewer.
9. [x] Quality gates: pnpm test 101/101, pnpm test:integration 52/52, pnpm verify 39/39 — PASS (23/08/2026 01:05).
10. [>] Commit, push, mở Draft PR liên kết Issue #2, gắn agent:gpt + status:review-requested, ghi HEAD SHA. DỪNG chờ GPT review.

## Bước hiện tại
Bàn giao PR 1 — chờ GPT review (không tự merge). Sau đó mới làm PR 2 (QLDA_DTXD).

## Quyết định
- Policy dùng JSON (`.github/ai-review-policy.json`) thay YAML — tránh thêm dependency parser;
  Issue ghi "ví dụ .yml" nên định dạng máy đọc được là đạt (ghi chú trong PR cho GPT xác nhận).
- Orchestrator đọc policy từ TARGET repo tại HEAD SHA của PR (gh api contents);
  target chưa có policy (QLDA_DTXD trước PR2) → CI_UNKNOWN fail-closed → changes-requested.
  Hành vi chủ đích, an toàn trong khoảng chuyển tiếp.
- Pre-review deterministic (secret scan trên diff + diff limit) vì reviewer-engine LLM đang inert;
  kết quả chỉ PRE_REVIEW_PASS/PRE_REVIEW_FINDINGS, không bao giờ chạm status:approved.
- Approval chỉ được ghi qua `scripts/gpt-approval.mjs` (kiểm chứng CI PASS + PRE_REVIEW_PASS tại
  đúng HEAD, idempotent theo HEAD); orchestrator quét cả PR status:approved để phát hiện approval-drift.
- Uncommitted changes cũ (AGENTS.md, .clinerules/01, protocol — mô hình "local reviewer chính"
  của Bố chốt 22/08) bị Issue #2 thay thế: gộp vào branch và sửa theo hướng GPT-final-approval,
  không mất nội dung, không reset.
- Xóa helper reviewer-side chết trong `autonomous-core.mjs` (planRouting/fixIssue*/parseChecks*/
  findingsFromFailedChecks) — coder-side giữ nguyên.
- `MO_TA_AI_PR_VIEWER.MD` giữ nguyên (tài liệu lịch sử, không phải quy tắc vận hành) — ghi Deferred.

## Vấn đề trì hoãn
- [ ] `MO_TA_AI_PR_VIEWER.MD` còn tên cũ AI_PR_VIEWER — tài liệu lịch sử, cần quyết định xóa/archive.
- [ ] Sau khi PR2 (QLDA_DTXD) thêm policy, target repo hết CI_UNKNOWN fail-closed.
- [ ] reviewer-agent/ inert giữ nguyên theo Decision Gate 21/08.
- [ ] requiredChecks="verify" cần đối chiếu tên check-run thực tế trên GitHub khi PR CI chạy.

## Bước tiếp theo
Commit + push + Draft PR (Ref #2), gắn nhãn agent:gpt + status:review-requested, dừng chờ GPT.
