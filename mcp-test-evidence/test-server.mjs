#!/usr/bin/env node
/**
 * Test MCP Test Evidence Server (Issue #19 Phase 2) — deterministic, zero-dependency.
 * + Pure logic: findReport path-traversal, dispatch invalid, validation.
 * + E2E: tạo fixture tạm (project.json + manifest + artifact PASS/FAIL), spawn server thật với
 *   MCP_TEST_EVIDENCE_ROOT + MCP_TEST_EVIDENCE_SKIP_REMOTE=1, NDJSON handshake, assert 5 tools.
 * Chạy: node mcp-test-evidence/test-server.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeReportId, computeManifestHash } from "../scripts/test-evidence-reporter.mjs";
import { runtimeRoot } from "./cache.mjs";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const PASS_HEAD = "1111111111111111111111111111111111111111";
const FAIL_HEAD = "2222222222222222222222222222222222222222";
let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  PASS ${name}`);
}

// ---------------------------------------------------------------------------
// Fixture temporary root
// ---------------------------------------------------------------------------
// Xoá runtime store cũ (ngoài Git repo) cho projectId. Idempotent, fail-soft
// (missing dir OK). Dùng để test chạy deterministic dù session trước đã
// ghi cache/artifacts.
function _cleanRuntime(runtimeRootPath) {
  if (existsSync(runtimeRootPath)) {
    rmSync(runtimeRootPath, { recursive: true, force: true });
  }
}

function buildFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-evidence-"));
  const agent = path.join(root, ".agent");
  const artifacts = path.join(agent, "test-evidence");
  mkdirSync(artifacts, { recursive: true });

  const manifest = {
    schemaVersion: "1.0",
    projectId: "fixture-project",
    repository: "duongpdddic-droid/AI_PR_REVIEWER",
    headSha: FAIL_HEAD,
    gates: {
      verify: [
        { id: "syntax", name: "node --check", command: "node", args: ["scripts/full-verify.mjs"] },
        { id: "unit", name: "test-pure-logic", command: "node", args: ["scripts/test-pure-logic.mjs"] },
        { id: "integration", name: "integration tests", command: "node", args: ["scripts/test-integration-orchestrator.mjs"] },
      ],
      // GPT-REV-106 (Finding 2): gate thứ 2 cùng head+manifest nhưng kết quả khác
      // (PASS). Hai gate phải sinh reportId khác nhau (canonical identity tổng hợp
      // bind gateId), không ghi đè artifact lẫn nhau. Step id "unit2" (KHÔNG trùng
      // "unit" trong verify) để stepIndex map đúng gate, không phá test cũ.
      unit_only: [
        { id: "unit2", name: "test-pure-logic-alt", command: "node", args: ["scripts/test-pure-logic.mjs"] },
      ],
    },
  };
  writeFileSync(path.join(agent, "project.json"), JSON.stringify({
    schemaVersion: "1.0", projectId: "fixture-project", repository: "duongpdddic-droid/AI_PR_REVIEWER", projectType: "fixture",
  }));
  // GPT-REV-098: manifest committed (file immutable) có headSha STALE, KHÁC requested HEAD.
  // Reporter bind artifact bằng manifest RUNTIME copy với headSha=HEAD của report đó (full-verify),
  // vậy mỗi HEAD có manifestHash canonical RIÊNG theo `{...manifest, headSha: <HEAD>}`.
  const STALE_HEAD = "3333333333333333333333333333333333333333";
  manifest.headSha = STALE_HEAD;
  writeFileSync(path.join(agent, "test-manifest.json"), JSON.stringify(manifest, null, 2));
  // GPT-REV-105 (Finding 2): tạo stub scripts trong fixture root để test_run thực thi
  // (canonicalizeNodeArgs resolve + realpath containment). integration FAIL để test_run FAIL.
  const scriptsDir = path.join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, "full-verify.mjs"), "console.log('syntax ok');\n");
  writeFileSync(path.join(scriptsDir, "test-pure-logic.mjs"), "console.log('unit ok');\n");
  writeFileSync(path.join(scriptsDir, "test-integration-orchestrator.mjs"), "console.error('integration boom'); process.exit(1);\n");
  const mhPass = computeManifestHash({ ...manifest, headSha: PASS_HEAD });
  const mhFail = computeManifestHash({ ...manifest, headSha: FAIL_HEAD });
  const PASS_REPORT = computeReportId(PASS_HEAD, mhPass);
  const FAIL_REPORT = computeReportId(FAIL_HEAD, mhFail);

  // PASS artifact (bind manifestHash của PASS_HEAD)
  writeFileSync(path.join(artifacts, `${PASS_REPORT}.json`), JSON.stringify({
    schemaVersion: "1.0", headSha: PASS_HEAD, passed: true,
    tests: { passed: 10, failed: 0, total: 10 }, duration: 100,
    reportId: PASS_REPORT, manifestHash: mhPass, blocking: 0, failureCodes: [], failures: [],
  }));
  // FAIL artifact gồm secret literal để assert redaction (bind manifestHash của FAIL_HEAD)
  writeFileSync(path.join(artifacts, `${FAIL_REPORT}.json`), JSON.stringify({
    schemaVersion: "1.0", headSha: FAIL_HEAD, passed: false,
    tests: { passed: 8, failed: 2, total: 10 }, duration: 120,
    reportId: FAIL_REPORT, manifestHash: mhFail, blocking: 2,
    failureCodes: ["STEP_UNIT_FAIL", "STEP_INTEGRATION_FAIL"],
    failures: [
      { code: "STEP_UNIT_FAIL", step: "unit", detail: "expected 2 to equal 3; token=\"supersecret123\"",
        logExcerpt: "line1\ntoken=\"supersecret123\"\nerror at /test.ts:42\nline4\nline5" },
      { code: "STEP_INTEGRATION_FAIL", step: "integration", detail: "timeout 500s" },
    ],
  }));
  return { root, artifactDir: artifacts, manifest, mhPass, mhFail, PASS_REPORT, FAIL_REPORT, STALE_HEAD };
}
async function run() {
  // Self-clean runtime store cho fixture-project trước khi test để tránh
  // state bẩn từ session trước (test_run cache kết quả cũ → fail cacheKey).
  // Cleanup lại trong finally để không leak giữa các lần chạy CI.
  const fixtureRuntimeRoot = runtimeRoot("fixture-project");
  try { _cleanRuntime(fixtureRuntimeRoot); } catch { /* best effort */ }
  const { root, artifactDir, manifest, mhPass, mhFail, PASS_REPORT, FAIL_REPORT, STALE_HEAD } = buildFixture();
  try {
    // ── 1) Pure logic / security / findReport ───────────────────────
    console.log("[1] pure logic (findReport)");
    const { findReport } = await import("./server.mjs");
    for (const bad of ["../evil", "..%2f..%2fetc", "abc", "GGGGGGGGGGGGGGGG", ""]) {
      let threw = false;
      try { findReport(artifactDir, { reportId: bad }); } catch { threw = true; }
      ok(threw, `findReport chặn reportId bẩn '${bad}' (chống path traversal)`);
    }
    const byHead = findReport(artifactDir, { headSha: PASS_HEAD, manifestHash: mhPass });
    ok(byHead.passed === true && byHead.reportId === PASS_REPORT, "findReport theo headSha+PASS (bind manifest)");
    let threw = false;
    try { findReport(artifactDir, { headSha: "abcd" }); } catch { threw = true; }
    ok(threw, "findReport chặn headSha không 40-hex");
    ok(findReport(artifactDir, { reportId: FAIL_REPORT }).passed === false, "findReport theo reportId FAIL");
    // GPT-REV-095: chọn đúng 1 selector (không cả 2); bind identity filename↔reportId↔canonical.
    threw = false;
    try { findReport(artifactDir, { reportId: FAIL_REPORT, headSha: FAIL_HEAD }); } catch { threw = true; }
    ok(threw, "findReport chặn 2 selector cùng lúc (fail-closed)");
    threw = false;
    try { findReport(artifactDir, { headSha: PASS_HEAD }); } catch { threw = true; }
    ok(threw, "findReport headSha thiếu manifestHash → fail-closed cần binding");
    // GPT-REV-095: identity lệch filename↔reportId → từ chối
    const MIM = "fedcba9876543210";
    writeFileSync(path.join(artifactDir, `${MIM}.json`), JSON.stringify({
      schemaVersion: "1.0", headSha: FAIL_HEAD, passed: false,
      tests: { passed: 0, failed: 1, total: 1 }, duration: 1,
      reportId: FAIL_REPORT, manifestHash: mhFail, blocking: 1, failureCodes: [], failures: [],
    }));
    threw = false;
    try { findReport(artifactDir, { reportId: MIM }); } catch { threw = true; }
    ok(threw, "findReport từ chối artifact filename≠reportId (identity lệch)");
    // headSha không có report khớp manifest hiện tại → fail-closed
    const OHEAD = "4444444444444444444444444444444444444444";
    const otherId = computeReportId(OHEAD, "other-manifest-hash");
    writeFileSync(path.join(artifactDir, `${otherId}.json`), JSON.stringify({
      schemaVersion: "1.0", headSha: OHEAD, passed: true,
      tests: { passed: 1, failed: 0, total: 1 }, duration: 5,
      reportId: otherId, manifestHash: "other-manifest-hash", blocking: 0, failureCodes: [], failures: [],
    }));
    threw = false;
    try { findReport(artifactDir, { headSha: OHEAD, manifestHash: mhFail }); } catch { threw = true; }
    ok(threw, "findReport headSha có artifact nhưng khác manifest → fail-closed yêu cầu reportId");

    // ── 2) E2E spawn server thật ────────────────────────────────────
    console.log("[2] e2e MCP NDJSON");
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, MCP_TEST_EVIDENCE_ROOT: root, MCP_TEST_EVIDENCE_SKIP_REMOTE: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    let nextId = 1;
    const pending = new Map();
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    function rpc(method, params, timeoutMs = 30_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
        pending.set(id, (m) => { clearTimeout(t); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    ok(init.result?.serverInfo?.name === "mcp-test-evidence", "initialize trả serverInfo.name");

    const tools = await rpc("tools/list", {});
    const names = tools.result.tools.map((t) => t.name);
    ok(JSON.stringify(names) === JSON.stringify(
      ["test_run", "test_status", "test_failures", "test_failure_detail", "test_log_excerpt", "test_finding_map", "test_verify_identity"]),
      `tools/list đủ 7 tools (test_run + 5 read-only + test_verify_identity) (${names.join(", ")})`);

    const call = async (name, args) => {
      const r = await rpc("tools/call", { name, arguments: args });
      return { result: r.result, data: JSON.parse(r.result.content[0].text) };
    };

    // test_status theo headSha (PASS)
    const s1 = await call("test_status", { headSha: PASS_HEAD });
    ok(s1.result && !s1.result.isError && s1.data.passed === true, "test_status PASS theo headSha");
    ok(s1.data.summary.startsWith("VERIFY PASS head="), "test_status trả compact PASS line");

    // test_status theo reportId (FAIL) + projectId khớp
    const s2 = await call("test_status", { reportId: FAIL_REPORT, projectId: "fixture-project" });
    ok(s2.data.passed === false && s2.data.blocking === 2, "test_status FAIL blocking=2");
    ok(s2.data.failureCodes.length === 2, "test_status trả failureCodes");

    // test_failures (mức 1)
    const f = await call("test_failures", { reportId: FAIL_REPORT });
    ok(f.data.count === 2 && f.data.failures[0].code === "STEP_UNIT_FAIL", "test_failures trả code+step");
    ok(f.data.failures[0].step === "unit", "test_failures trả step");

    // test_failure_detail (mức 2) — secret bị redact
    const d = await call("test_failure_detail", { reportId: FAIL_REPORT, failureIndex: 0 });
    ok(d.data.failure.includes("expected 2 to equal 3"), "test_failure_detail chứa detail");
    ok(!/supersecret123/.test(d.data.failure), "REDACT: secret literal không lọt ra output");

    // test_log_excerpt (mức 3) — cắt 1 dòng + truncate + redact
    const l = await call("test_log_excerpt", { reportId: FAIL_REPORT, failureIndex: 0, maxLines: 1 });
    ok(l.data.truncated === true && l.data.logExcerpt === "line1", "test_log_excerpt cắt đúng 1 dòng + truncate");
    ok(!/supersecret123/.test(l.data.logExcerpt), "REDACT: logExcerpt không chứa secret");
    // GPT-REV-094: dòng CHỨA secret nằm trong phạm vi trả về phải bị redact (không còn dựa vào may-rủi maxLines=1).
    const l2 = await call("test_log_excerpt", { reportId: FAIL_REPORT, failureIndex: 0, maxLines: 5 });
    ok(l2.data.logExcerpt.includes("line1") && l2.data.logExcerpt.includes("[REDACTED_SECRET]"),
      "REDACT: dòng chứa secret trả về NHƯNG đã redact thành [REDACTED_SECRET]");
    ok(!/supersecret123/.test(l2.data.logExcerpt), "REDACT (GPT-REV-094): dòng secret trong phạm vi không lọt ra");
    // GPT-REV-094: finding_map detail cũng redact
    const m0 = await call("test_finding_map", { reportId: FAIL_REPORT });
    ok(m0.data.findings.every((fi) => !/supersecret123/.test(fi.detail || "")), "REDACT: finding_map.detail không lọt secret");

    // test_finding_map — map finding → gate/test, lọc theo findingCode
    const m = await call("test_finding_map", { reportId: FAIL_REPORT });
    ok(m.data.findings.length === 2 && m.data.findings[0].gate === "verify", "finding_map trả gate");
    ok(m.data.findings[0].test?.id === "unit" && m.data.findings[1].test?.id === "integration",
      "finding_map map đúng manifest step");
    const m1 = await call("test_finding_map", { reportId: FAIL_REPORT, findingCode: "STEP_INTEGRATION_FAIL" });
    ok(m1.data.findings.length === 1 && m1.data.findings[0].step === "integration",
      "finding_map lọc đúng 1 finding theo code");

    // ── GPT-REV-098: headSha hash manifest RUNTIME (thay headSha), không hash manifest committed stale ─
    // Manifest committed (STALE_HEAD) ≠ FAIL_HEAD. Server phải hash {manifest, headSha: FAIL_HEAD}
    // (giống reporter full-verify) để test_status({reportId}) đọc đúng artifact canonical dù file stale.
    // REGRESSION Finding 3: dùng reportId (deterministic) thay vì headSha-only để tránh
    // ambiguous sau khi test_run tạo thêm report runtime cho cùng headSha.
    ok(manifest.headSha === STALE_HEAD, "fixture: manifest committed có headSha STALE (khác requested HEAD)");
    const sStale = await call("test_status", { reportId: FAIL_REPORT });
    ok(sStale.result && !sStale.result.isError && sStale.data.passed === false && sStale.data.blocking === 2,
      "GPT-REV-098: test_status theo reportId thành công dù manifest committed headSha stale (hash runtime)");
    // Artifact built từ manifest NỘI DUNG sai (headSha đúng nhưng phần còn lại lệch) → manifestHash
    // khác canonical hiện tại → findReport theo headSha+manifestHash phải fail-closed.
    const WRONG = "abcdef0123456789abcdef0123456789abcdef01";
    const wrongMh = computeManifestHash({ ...manifest, headSha: WRONG, projectId: "tampered-project" });
    const wrongId = computeReportId(WRONG, wrongMh);
    writeFileSync(path.join(artifactDir, `${wrongId}.json`), JSON.stringify({
      schemaVersion: "1.0", headSha: WRONG, passed: true,
      tests: { passed: 1, failed: 0, total: 1 }, duration: 5,
      reportId: wrongId, manifestHash: wrongMh, blocking: 0, failureCodes: [], failures: [],
    }));
    const wrongR = await call("test_status", { headSha: WRONG });
    ok(wrongR.result?.isError === true && /không có report artifact/.test(wrongR.result.content[0].text),
      "GPT-REV-098: artifact từ manifest nội dung sai → test_status(headSha) fail-closed (không khớp canonical)");

    // ── GPT-REV-105 (Finding 1): test_verify_identity — server tự tính real identity ──
    // Server lấy real Git HEAD (SKIP_REMOTE → manifest.headSha), canonical manifestHash,
    // allowlisted envFingerprint. Caller chỉ assert expected; mismatch → fail-closed.
    const vi = await call("test_verify_identity", {
      gate: "verify", projectId: "fixture-project",
    });
    ok(vi.result && !vi.result.isError, "REV-105: test_verify_identity không lỗi");
    ok(typeof vi.data === "object" && vi.data.cacheKey && /^[0-9a-f]{64}$/.test(vi.data.cacheKey),
      "REV-105: identity trả cacheKey thực (không phải {})");
    ok(vi.data.selfComputed === true, "REV-105: selfComputed=true (server tự tính)");
    ok(vi.data.status !== "approved", "REV-105: KHÔNG tự gắn status:approved");
    // SKIP_REMOTE → real Git HEAD null → fallback manifest.headSha (STALE_HEAD, committed).
    ok(vi.data.headSha === STALE_HEAD, "REV-105: real HEAD = manifest.headSha (SKIP_REMOTE fallback)");
    // canonical manifestHash tính từ manifest runtime copy (headSha=STALE_HEAD).
    const mhStale = computeManifestHash({ ...manifest, headSha: STALE_HEAD });
    ok(vi.data.manifestHash === mhStale, "REV-105: canonical manifestHash khớp manifest runtime (headSha=STALE_HEAD)");
    // mismatch fail-closed: caller assert sai expected → lỗi IDENTITY_MISMATCH.
    const bad = await call("test_verify_identity", {
      gate: "verify", projectId: "fixture-project",
      expectHeadSha: "0000000000000000000000000000000000000000",
    });
    ok(bad.result?.isError === true && /IDENTITY_MISMATCH/.test(bad.result.content[0].text),
      "REV-105: expectHeadSha sai → fail-closed IDENTITY_MISMATCH");

    // ── GPT-REV-100/105 (Finding 1 + Finding 3): test_run tạo CompactReport vào runtime store ──
    // Server tự tính identity từ Project Registry + real Git HEAD (SKIP_REMOTE → manifest.headSha)
    // + canonical manifestHash + allowlisted envFingerprint. Caller KHÔNG gửi headSha/manifestHash/
    // envFingerprint nữa; có thể gửi expectXxx để assert.
    // → test_status/failures/detail/log đọc được qua reportId.
    const tr = await call("test_run", {
      gate: "verify", projectId: "fixture-project",
    });
    ok(tr.result && !tr.result.isError && typeof tr.data === "object" && tr.data.cacheKey,
      "REV-100: test_run dispatch await → data có cacheKey thực (không phải {})");
    ok(typeof tr.data.reportId === "string" && /^[0-9a-f]{16}$/.test(tr.data.reportId),
      "REV-105: test_run trả reportId (CompactReport đã ghi runtime store)");
    ok(tr.data.headSha === STALE_HEAD,
      "Finding 1: test_run trả headSha từ server-derived (SKIP_REMOTE → manifest.headSha), caller không tự quyết");
    const runReportId = tr.data.reportId;
    // REGRESSION Finding 1: caller pass expectHeadSha SAI → fail-closed IDENTITY_MISMATCH.
    const badRun = await call("test_run", {
      gate: "verify", projectId: "fixture-project",
      expectHeadSha: "0000000000000000000000000000000000000000",
    });
    ok(badRun.result?.isError === true && /IDENTITY_MISMATCH/.test(badRun.result.content[0].text),
      "Finding 1 REGRESSION: test_run expectHeadSha sai → IDENTITY_MISMATCH fail-closed");
    // REGRESSION Finding 3: test_run ghi vào shard KHÔNG PHẢI 'xx' (cacheKey dài hex).
    // test_status vẫn tìm được qua reportId nhờ enumerate mọi runtime shard.
    // verify gate: 3 steps (syntax, unit, integration). integration exit 1 → 1 failure,
    // blocking = max(1, failures.length) = 1. Trước fix: resolveReport luôn đọc shard 'xx'
    // → miss hoàn toàn; assert cũ `blocking===2` dựa trên pre-seeded FAIL_REPORT khác.
    const st = await call("test_status", { reportId: runReportId, projectId: "fixture-project" });
    ok(st.result && !st.result.isError && st.data.passed === false && st.data.blocking === 1,
      "Finding 3: test_status đọc được report runtime store (mọi shard) (blocking=1, integration fail)");
    // detail + log qua cùng reportId.
    // Fixture: verify gate có 3 steps (syntax, unit, integration); unit stub PASS,
    // integration stub exit 1 → failures = [integration], code = STEP_INTEGRATION_FAIL.
    const dt = await call("test_failure_detail", { reportId: runReportId, failureIndex: 0 });
    ok(dt.result && !dt.result.isError && /STEP_INTEGRATION_FAIL/.test(dt.data.failure || ""),
      "REV-105: test_failure_detail đọc được failure từ runtime report");
    const lg = await call("test_log_excerpt", { reportId: runReportId, failureIndex: 0, maxLines: 3 });
    ok(lg.result && !lg.result.isError && typeof lg.data.logExcerpt === "string",
      "REV-105: test_log_excerpt đọc được log từ runtime report");

    // ── GPT-REV-106 (Finding 1): test_run 2 lần cùng gate → lần 2 cached=true, không crash.
    // Cleanup runtime cache (cùng projectId có thể cache từ session trước) để test
    // lần 1 chắc chắn MISS, lần 2 chắc chắn HIT.
    try { rmSync(runtimeRoot("fixture-project"), { recursive: true, force: true }); } catch {}
    // Trước fix: checkCache không trả cached.result → writeRuntimeReport nhận undefined
    // → saveReport throw vì result.stepResults undefined. Bây giờ checkCache đọc canonical
    // artifact, trả result đầy đủ → cache hit ghi report mới cùng reportId (idempotent).
    const tr1 = await call("test_run", { gate: "unit_only", projectId: "fixture-project" });
    ok(tr1.result && !tr1.result.isError && tr1.data.cached === false && tr1.data.passed === true,
      "REV-106: test_run lần 1 (unit_only) → cached=false, passed=true");
    const tr1Id = tr1.data.reportId;
    const tr1Key = tr1.data.cacheKey;
    const tr2 = await call("test_run", { gate: "unit_only", projectId: "fixture-project" });
    ok(tr2.result && !tr2.result.isError && tr2.data.cached === true,
      "REV-106 (Finding 1): test_run lần 2 cùng gate → cached=true, không crash");
    ok(typeof tr2.data.reportId === "string" && /^[0-9a-f]{16}$/.test(tr2.data.reportId),
      "REV-106: test_run cache hit trả reportId hợp lệ");
    ok(tr2.data.cacheKey === tr1Key, "REV-106: cacheKey ổn định qua 2 lần gọi");
    // Cache hit dùng cùng gateId (3-arg computeReportId) → reportId giống lần 1.
    ok(tr2.data.reportId === tr1Id, "REV-106: cache hit → reportId ổn định (gate-specific canonical)");

    // ── GPT-REV-106 (Finding 2): 2 gate cùng head+manifest → 2 reportId KHÁC NHAU.
    // Trước fix: computeReportId(headSha, manifestHash) không bind gateId → 2 gate trùng
    // reportId → ghi đè artifact. Bây giờ computeReportId thêm gateId → 2 reportId
    // distinct, 2 artifact file distinct. Verify qua test_status (read tool enumerate
    // runtime shards, không cần truy cập file trực tiếp).
    const trVerify = await call("test_run", { gate: "verify", projectId: "fixture-project" });
    const trUnit = await call("test_run", { gate: "unit_only", projectId: "fixture-project" });
    ok(trVerify.result && !trVerify.result.isError && trUnit.result && !trUnit.result.isError,
      "REV-106 (Finding 2): 2 gate chạy được đồng thời");
    ok(trVerify.data.reportId !== trUnit.data.reportId,
      "REV-106 (Finding 2): 2 gate cùng head+manifest → 2 reportId KHÁC nhau (canonical identity tổng hợp bind gateId)");
    // test_status theo reportId của từng gate phải đọc đúng report tương ứng (chứng minh
    // 2 artifact tồn tại độc lập vì nếu ghi đè, cùng reportId → test_status trả cùng
    // kết quả; khác reportId + kết quả khác nhau → 2 artifact distinct).
    const stVerify = await call("test_status", { reportId: trVerify.data.reportId, projectId: "fixture-project" });
    const stUnit = await call("test_status", { reportId: trUnit.data.reportId, projectId: "fixture-project" });
    ok(stVerify.result && !stVerify.result.isError && stVerify.data.passed === false
      && stUnit.result && !stUnit.result.isError && stUnit.data.passed === true,
      "REV-106: test_status theo reportId từng gate đọc đúng kết quả (verify FAIL, unit_only PASS) → 2 artifact độc lập");

    console.log("[3] negative fail-closed");
    for (const c of [
      { name: "test_status", args: { reportId: "../evil" }, expect: "reportId" },
      { name: "test_status", args: { reportId: FAIL_REPORT, projectId: "wrong-project" }, expect: "Project Registry" },
      { name: "test_failure_detail", args: { reportId: FAIL_REPORT, failureIndex: 9 }, expect: "failureIndex" },
      { name: "test_finding_map", args: { reportId: FAIL_REPORT, findingCode: "NOPE" }, expect: "không tìm thấy finding" },
    ]) {
      const r = await call(c.name, c.args);
      ok(r.result?.isError === true && c.expect && r.result.content[0].text.includes(c.expect),
        `${c.name} fail-closed (${c.expect})`);
    }
    const unknown = await rpc("resources/list", {});
    ok(unknown.error?.code === -32601, "method lạ → -32601");
    child.stdin.end();
    child.kill();
  } finally {
    rmSync(root, { recursive: true, force: true });
    // Cleanup runtime store sau test (idempotent, fail-soft) — không leak giữa
    // các lần chạy CI / local dev.
    try { _cleanRuntime(fixtureRuntimeRoot); } catch { /* best effort */ }
  }
  console.log(`\nTổng: ${passed} assertions PASS`);
}

run().catch((err) => { console.error(err); process.exit(1); });

