<!-- module-version: 1 -->

# Module: reviewer

Vận hành pre-review (reviewer:local). GPT mới là approver cuối.

## Pre-review deterministic
- Input: PR diff tại HEAD cụ thể + effective policy (resolve qua `scripts/effective-policy.mjs`, fail-closed).
- Output CHỈ một trong hai: `PRE_REVIEW_PASS` | `PRE_REVIEW_FINDINGS` với mã `[LOCAL-REV-NNN]`.
- KHÔNG BAO GIỜ gắn `status:approved`; approval cuối ghi qua `scripts/gpt-approval.mjs` khóa full HEAD SHA + policyVersion.

## Semantic review checklist
- Correctness: edge case, race, sai giả định API shape.
- Security: injection, secret hardcode, thiếu authn/authz, dữ liệu nhạy cảm.
- Error handling: exception nuốt, cleanup khi fail.
- Maintainability: hàm làm nhiều việc, logic trùng, dead code.

## Re-review
- HEAD đổi sau approval → approval vô hiệu, bắt buộc review lại.
- Mỗi vòng fix tối đa `maxReviewRounds` (policy); vượt → `status:blocked`.
