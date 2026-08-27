# Active Context
## Mục tiêu
Issue #19 — Shared Test Evidence Protocol v1 + compact reporter. Giai đoạn 1: schema + reporter + tests + full-verify --evidence.
Xử lý GPT re-review findings trên PR #20 (GPT-REV-087..089).

## Chế độ
Tự hành (kênh Cline, lệnh Bố trực tiếp).

## Kế hoạch thực thi
1. [x] Claim Issue #19, branch `feat/issue-19-test-evidence-protocol-v1`.
2. [x] Tạo schema + reporter + tests + full-verify --evidence (Phase 1).
3. [x] Commit + push + mở Draft PR #20 → CI PASS → handoff GPT.
4. [x] GPT re-review: CHANGES_REQUESTED, 3 findings (GPT-REV-087/088/089).
5. [>] Fix 3 findings (đang thực hiện + verify + commit + re-handoff).
   5a. [x] GPT-REV-087: `--evidence` đi qua pipeline (load+validate manifest, computeReportId canonical, save artifact, progressive disclosure).
   5b. [x] GPT-REV-088: deep-redact trước mọi format/save/summary/detail.
   5c. [x] GPT-REV-089: strict validators (reject extra props, empty/invalid headSha/projectId), saveReport validate + path-traversal guard (safePath).
6. [ ] Commit fix + push lên branch PR #20.
7. [ ] Local pre-review (full-verify + test:evidence PASS) → re-handoff GPT (labels agent:gpt + status:review-requested).

## Bước hiện tại
Đã fix xong 3 findings, verify local PASS. Chuẩn bị commit + push + re-handoff GPT re-review.

## Bằng chứng thực thi
### Fix GPT-REV-087/088/089
- `scripts/test-evidence-reporter.mjs`:
  - Thêm `loadManifest()` — load + parse `.agent/test-manifest.json` (fail-closed).
  - Thêm `redactReport(report)` — deep-redact `failures[].detail` + `logExcerpt`.
  - Thêm `safePath(reportId, dir)` — reject reportId chứa `../` / non-hex16, đảm bảo resolved nằm trong artifact root.
  - `formatFullJson` / `formatSummary` / `formatFailureDetail` gọi `redactReport` trước output.
  - `saveReport` validate report + safePath + redact trước write.
  - `validateReport`/`validateManifest` strict: reject extra props, empty headSha (cần 40-hex), empty projectId, invalid step timeout/args/extra props, invalid failure code.
- `scripts/full-verify.mjs` `--evidence`: build report qua pipeline — loadManifest → validateManifest → computeManifestHash → computeReportId(head, manifestHash) → validateReport → saveReport(redact) → formatCompactLine. Không còn ad-hoc hash.
- `.agent/test-manifest.json`: headSha hợp lệ 40-hex (`851fed852d7434bf31601ccf494ed7600cee11b7`) để thỏa schema.
- `scripts/test-test-evidence.mjs`: +35 tests (59→94) cover loadManifest, safePath, strict validate, redactReport, saveReport redaction + traversal, formatSummary/detail redaction, pipeline.

### Verify
- `pnpm test:evidence` (test-test-evidence.mjs): **94/94 PASS** exit 0.
- `pnpm verify` (full-verify.mjs): **121/121 PASS** exit 0, ~7.3s (đã hết treo do loại bỏ test #57 spawn đệ quy full-verify).
- `--evidence` chạy thực tế: `VERIFY PASS head=851fed852d7434bf31601ccf494ed7600cee11b7 tests=121/121 blocking=0 duration=7864ms report=8022a4c63075dc29`; artifact `.agent/test-evidence/8022a4c63075dc29.json` đúng schema, reportId khớp công thức `sha256(head:manifestHash)[:16]` (MATCH).
- `git diff --check` sạch; node --check 3 file OK; không BOM.

## Quyết định
- Giữ hand-written validators (không thêm ajv dependency — princípio lazy/no-new-dep). Strict parity với JSON Schema qua reject-extra-props + pattern checks.
- Report FAIL artifact có thể >4KB (chỉ PASS bị giới hạn) — giữ nguyên.
- Bỏ test #57 spawn `full-verify.mjs --evidence` (gây đệ quy vô hạn vì full-verify chạy test-test-evidence.mjs ở step 4) → đổi thành test pipeline trực tiếp.

## Vấn đề trì hoãn
- [ ] PR #17 diff >1500 dòng vẫn chưa có quyết định Bố. Không chặn Issue #19.
- [ ] Soak test thực tế trên máy Bố trước khi xóa legacy.

## Bước tiếp theo
1. Commit fix + push branch `feat/issue-19-test-evidence-protocol-v1`.
2. Re-handoff GPT: labels `agent:gpt` + `status:review-requested`, comment `[CLINE-FIX-...]` tóm tắt fix 3 findings.
3. Đợi GPT re-review.

## Status: IN PROGRESS
