<!-- module-version: 1 -->

# Module: github-workflow

Issue, PR, labels, state machine.

## State machine (labels)
`status:queued` → `status:ready-for-cline` → `status:in-progress` → (`status:changes-requested` ⇄ fix) → `status:review-requested` → `status:reviewing` → `status:approved`.
Ngoài luồng: `status:blocked`, `status:needs-user-input`.

## Claim Issue
- Điều kiện: `agent:cline` + `status:ready-for-cline`, worktree sạch, HEAD = origin/main.
- `pnpm intake` read-only trước; claim idempotent + read-after-write.

## PR
- Mở Draft PR từ nhánh task; liên kết `Ref #<số>` (chỉ `Closes #<só>` khi hoàn tất trọn vẹn Issue).
- Bàn giao cần: full HEAD SHA, AC→file/test mapping, `pnpm verify` output, CI run đúng SHA, evidence không duplicate/stale rule.

## Intake an toàn
- Mọi trạng thái chặn preflight (`BLOCKED_*`) là fail-closed — không mutation, không tự reset/stash/clean.
