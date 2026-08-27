# Active Context
## Mục tiêu
Issue #19 — Shared Test Evidence Protocol v1 + compact reporter. Giai đoạn 1: schema + reporter + tests + full-verify --evidence. Giai đoạn 2: MCP server + executor + cache. Giai đoạn 3: orchestrator integration + QLDA_DTXD adoption.

## Chế độ
Tự hành (kênh Cline, lệnh Bố trực tiếp).

## Kế hoạch thực thi
1. [x] Claim Issue #19, branch `feat/issue-19-test-evidence-protocol-v1` từ `fa9fec3` (main sau merge PR #17).
2. [x] Tạo `scripts/test-evidence-schema.json` — JSON Schema v1.0: TestManifest + CompactReport + FailureRecord.
3. [x] Tạo `.agent/test-manifest.json` — manifest cho AI_PR_REVIEWER (5 gates: syntax, unit, integration, policy, drift).
4. [x] Tạo `scripts/test-evidence-reporter.mjs` — core reporter: hash, format, validate, redact, save, progressive disclosure.
5. [x] Tạo `scripts/test-test-evidence.mjs` — 59 tests: schema validation, output format, redaction, size limits, edge cases.
6. [x] Sửa `scripts/full-verify.mjs` — +`--evidence` flag: compact one-line output `VERIFY PASS/FAIL`.
7. [x] Verify: `pnpm test:evidence` 59/59 PASS; `pnpm verify` 121/121 PASS; `test:drift` 0 FAIL.
8. [x] Commit + push + mở Draft PR #20.
9. [ ] Local pre-review:labels + checks pass.
10. [ ] Handoff GPT review (sau local PASS).

## Bước hiện tại
PR #20 đã mở (Draft). Chờ CI/verify pass + local pre-review trước khi chuyển status:review-requested.

## Bằng chứng thực thi
- `scripts/test-evidence-schema.json` (120 dòng): TestManifest (5 required: schemaVersion/projectId/repository/headSha/gates), CompactReport (tests summary + reportId + failureCodes), FailureRecord (code/step/detail/logExcerpt).
- `.agent/test-manifest.json` (35 dòng): self-repo AI_PR_REVIEWER gates.
- `scripts/test-evidence-reporter.mjs` (~140 dòng): computeEnvironmentFingerprint, computeManifestHash, computeReportId, formatCompactLine, formatFullJson, saveReport, validateReport, validateManifest, redact, failureCodeFromStep, formatSummary, formatFailureDetail.
- `scripts/test-test-evidence.mjs` (~240 dòng): 59 asserts覆盖hash, format, validate, redact, size, edge.
- `scripts/full-verify.mjs` (+40/-9 dòng): +createHash import, +startTime, +--evidence flag, +compact output mode.
- `package.json` (+1): +`"test:evidence"` script.

## Quyết định
- Compact PASS default 1 dòng: `VERIFY PASS head=<sha> tests=<p>/<t> blocking=0 duration=<ms> report=<id>`.
- FAIL: failure codes + reportId; detail đọc progressive disclosure, không đưa vào output mặc định.
- JSON PASS ≤4 KB enforced at save time.
- Manifest command allowlist: chỉ `[a-z0-9._/-]+`, reject `rm -rf` etc.
- Report ID = sha256(headSha:manifestHash)[0:16] — deterministic.
- Environment fingerprint = sha256(node+platform+arch).

## Vấn đề trì hoãn
- [ ] PR #17 diff >1500 dòng vẫn chưa có quyết định Bố (giữ A/B/C). Không chặn Issue #19.
- [ ] Soak test thực tế trên máy Bố trước khi xóa legacy.

## Bước tiếp theo
- Chờ CI PASS trên PR #20.
- Local pre-review: +`status:review-requested` labels.
- Handoff GPT review.

## Status: IN PROGRESS
