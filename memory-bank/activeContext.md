# Active Context
## Mục tiêu
Issue #14 — Shared Agent Platform: Project Registry và versioned project manifest (child của EPIC #11). Định nghĩa `.agent/project.json` versioned + machine-local registry + ownership matrix + registration/validation/migration APIs + fixtures. Không thay đổi Claude Mem hooks/retrieval.

## Chế độ
Tự hành (kênh Cline, lệnh Bố trực tiếp).

## Kế hoạch thực thi
1. [x] Đọc EPIC #11, Issue #14, `.agent/config.json`, conventions (test pattern, full-verify).
2. [x] Preflight: backup mb notes issue9 → `C:\Users\Admin\mb-issue9-backup`; stash 3 mb file; checkout `main` (fbfd2ff); tạo branch `feat/issue-14-project-registry` từ `origin/main`.
3. [x] Set label #14 `agent:cline`+`status:ready-for-cline` (bỏ `status:queued`); claim qua `github-task-intake.mjs --claim 14` → `CLAIMED`, remote `agent:cline`+`status:in-progress`.
4. [x] Viết `scripts/project-manifest-schema.json` (JSON Schema draft-07, required repo identity) + `scripts/project-registry.mjs` (validate fail-closed / registry / detectConflicts / assertWorkspaceRemote / registerProject / migrateManifest up+down / assertSingleOwner / registryOutsideWorktree).
5. [x] Fixtures 6 file (`ai-pr-reviewer`, `qlda-dtxd`, `generic`, `duplicate-id`, `wrong-remote`, `stale-schema`) + `.agent/project.json` mẫu chuẩn.
6. [x] `scripts/test-project-registry.mjs` (32 check, AC1–AC9) + đăng ký `test-project-registry.mjs` vào `optionalSuites` của full-verify.
7. [x] Verify: `node scripts/test-project-registry.mjs` 32/32 PASS; `pnpm verify` **94/94 PASS exit 0**.
8. [>] Commit + push branch; mở Draft PR `Ref #14`; handoff GPT (`agent:gpt` + `status:review-requested`).
9. [ ] Dừng chờ GPT review (không merge/deploy).

## Bước hiện tại
Đang bàn giao GPT review.

## Bằng chứng thực thi
- `scripts/project-manifest-schema.json`: schema versioned, `repository` required + pattern `^[\w.-]+/[\w.-]+$`.
- `scripts/project-registry.mjs`: `validateManifest` fail-closed (`MISSING_REPO_IDENTITY`/`CONTAINS_SECRET`/`CONTAINS_ABSOLUTE_PATH`/`STALE_SCHEMA`/`OVERRIDE_NOT_ALLOWED`); `detectConflicts` (projectId/repository/telegramRoute/workspaceId); `assertWorkspaceRemote`; `registerProject`; `migrateManifest` (up/down); `assertSingleOwner`; `registryOutsideWorktree`.
- `scripts/fixtures/project-registry/*.json`: 6 fixtures theo AC.
- `scripts/test-project-registry.mjs`: 32/32 PASS (AC1–AC9).
- `.agent/project.json`: manifest chuẩn repo này (valid qua `validateManifest`).
- `pnpm verify` 94/94 PASS exit 0.

## Quyết định
- Registry machine-local tại `~/.ai-pr-reviewer/registry.json` (ngoài worktree/Git).
- Branch tạo thủ công (script claim không tạo nhánh); slug `feat/issue-14-project-registry`.
- KHÔNG migrate `config.json` → `project.json` (out of scope, risk); `project.json` là manifest chuẩn mới song song.
- Bỏ qua đồng thời #12/#13/#15 và QLDA_DTXD#48 theo lệnh Bố.

## Vấn đề trì hoãn
- [ ] Chưa migrate QLDA_DTXD/AI_PR_REVIEWER sang project adapter (EPIC workstream 4–5, Issue khác).
- [ ] Chưa xây CLI init/sync/doctor (#12/#13/#15 — Bố cấm đồng thời).

## Bước tiếp theo
Push branch, mở Draft PR, handoff GPT. Sau approval GPT → user merge (không tự merge/deploy).
