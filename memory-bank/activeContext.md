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
8. [x] Commit + push branch; mở Draft PR `Ref #14`; handoff GPT (`agent:gpt` + `status:review-requested`).
9. [x] Re-handoff vòng 2 (HEAD 0cc5827→52a2b9e) + vòng 3 (HEAD e79e975) sau fix 3 finding còn mở.
10. [ ] Dừng chờ GPT re-review vòng 3 (không merge/deploy).

## Bước hiện tại
GPT re-review vòng 2 đóng [071][072], còn mở [069][070][073]. Đã sửa 3 finding, commit `e79e975`, push, re-handoff PR #16 (labels `agent:gpt` + `status:review-requested`). Chờ GPT re-review vòng 3.

## Bằng chứng thực thi
- `scripts/project-manifest-schema.json`: schema versioned, `repository` required + pattern `^[\w.-]+/[\w.-]+$`.
- `scripts/project-registry.mjs`:
  - [GPT-REV-069] `CANONICAL_POLICY_VERSION=''2026-08-23.7''`; gate `POLICY_VERSION_MISMATCH` khi `policy.version` lệch canonical (fail-closed).
  - [GPT-REV-070] `loadSchema()` fail-closed (ném khi file thiếu/corrupt → `MANIFEST_SCHEMA_UNAVAILABLE`); `validateAgainstSchema` rewrite đệ quy validate type/pattern/enum/minLength nested đầy đủ.
  - [GPT-REV-073] `migrateManifest` reversible lossless: `up` ghi nhận field added, `down` gỡ → `down(up(original)) === original`.
  - `scanForSecrets` quét key camelCase; `detectConflicts` idempotent; `registerProject` strip `__migrationAdded` trước save.
- `scripts/fixtures/project-registry/*.json`: 6 fixtures; generic.json/duplicate-id.json pin canonical `2026-08-23.7`; qlda-dtxd route `dm-boss-qlda`.
- `scripts/test-project-registry.mjs`: 50/50 PASS (AC1–AC11; AC11 = gate + nested fail-closed; AC10 strengthen round-trip).
- `.agent/project.json`: manifest chuẩn repo này (policy pin `2026-08-23.7`).
- `pnpm verify` 94/94 PASS exit 0; `full-verify` 94/94.
- PR #16: comment `[CLINE-FIX-069..073]`; labels `agent:gpt`+`status:review-requested`; HEAD `e79e9750b84868ab61e7efe004a9573c4472f5ee`.

## Quyết định
- Registry machine-local tại `~/.ai-pr-reviewer/registry.json` (ngoài worktree/Git).
- Branch `feat/issue-14-project-registry` từ `origin/main`.
- KHÔNG migrate `config.json` → `project.json` (out of scope); `project.json` manifest chuẩn song song.
- Bỏ qua đồng thời #12/#13/#15 và QLDA_DTXD#48 theo lệnh Bố.

## Vấn đề trì hoãn
- [ ] Chưa migrate QLDA_DTXD/AI_PR_REVIEWER sang project adapter (EPIC workstream 4–5, Issue khác).
- [ ] Chưa xây CLI init/sync/doctor (#12/#13/#15 — Bố cấm đồng thời).

## Bước tiếp theo
Chờ GPT re-review vòng 3 tại PR #16 (HEAD e79e975). Sau approval GPT qua `gpt-approval.mjs` (user-relay) → user merge. Không tự merge/deploy.