<!-- module-version: 1 -->

# Module: policy-resolver

Quản lý canonical/project/effective policy.

## Nguồn
- Canonical global machine policy: `.github/ai-review-policy.json` (repo này).
- Canonical human protocol: `docs/AGENT_HANDOFF_PROTOCOL.md`.
- Repo dự án chỉ giữ project config `.github/project-review-policy.json`: pin full 40-hex SHA + policyVersion + allowed overrides.

## Effective policy
- Mô hình: canonical + project config → validate → effective policy tạm thời (runtime/CI), KHÔNG phải nguồn luật mới.
- Resolver: `scripts/effective-policy.mjs`.

## Fail-closed codes
- `BLOCKED_CANONICAL_UNAVAILABLE` / `_INVALID` — canonical không đọc được / sai shape / duplicate JSON keys.
- `BLOCKED_VERSION_MISMATCH` — pin lệch canonical.policyVersion.
- `BLOCKED_INVARIANT_OVERRIDE` — override chạm invariantLockedKeys.
- `BLOCKED_POLICY_DUPLICATE_KEYS` — key trùng trong canonical.

## Cấm
- Không mirror global policy vào repo dự án; không sync hai chiều; không embedded/local fallback; ref pin phải full SHA (cấm main/tag di động ở production).
