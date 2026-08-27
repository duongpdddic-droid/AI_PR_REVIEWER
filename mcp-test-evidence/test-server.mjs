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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    },
  };
  writeFileSync(path.join(agent, "project.json"), JSON.stringify({
    schemaVersion: "1.0", projectId: "fixture-project", repository: "duongpdddic-droid/AI_PR_REVIEWER", projectType: "fixture",
  }));
  writeFileSync(path.join(agent, "test-manifest.json"), JSON.stringify(manifest, null, 2));

  // PASS artifact
  writeFileSync(path.join(artifacts, "aaaaaaaaaaaaaaaa.json"), JSON.stringify({
    schemaVersion: "1.0", headSha: PASS_HEAD, passed: true,
    tests: { passed: 10, failed: 0, total: 10 }, duration: 100,
    reportId: "aaaaaaaaaaaaaaaa", manifestHash: "mh-pass", blocking: 0, failureCodes: [], failures: [],
  }));
  // FAIL artifact gồm secret literal để assert redaction
  writeFileSync(path.join(artifacts, "bbbbbbbbbbbbbbbb.json"), JSON.stringify({
    schemaVersion: "1.0", headSha: FAIL_HEAD, passed: false,
    tests: { passed: 8, failed: 2, total: 10 }, duration: 120,
    reportId: "bbbbbbbbbbbbbbbb", manifestHash: "mh-fail", blocking: 2,
    failureCodes: ["STEP_UNIT_FAIL", "STEP_INTEGRATION_FAIL"],
    failures: [
      { code: "STEP_UNIT_FAIL", step: "unit", detail: "expected 2 to equal 3; token=\"supersecret123\"",
        logExcerpt: "line1\ntoken=\"supersecret123\"\nerror at /test.ts:42\nline4\nline5" },
      { code: "STEP_INTEGRATION_FAIL", step: "integration", detail: "timeout 500s" },
    ],
  }));
  return root;
}
async function run() {
  const root = buildFixture();
  const artifactDir = path.join(root, ".agent", "test-evidence");
  try {
    // ── 1) Pure logic / security / findReport ───────────────────────
    console.log("[1] pure logic (findReport)");
    const { findReport } = await import("./server.mjs");
    for (const bad of ["../evil", "..%2f..%2fetc", "abc", "GGGGGGGGGGGGGGGG", ""]) {
      let threw = false;
      try { findReport(artifactDir, { reportId: bad }); } catch { threw = true; }
      ok(threw, `findReport chặn reportId bẩn '${bad}' (chống path traversal)`);
    }
    const byHead = findReport(artifactDir, { headSha: PASS_HEAD });
    ok(byHead.passed === true && byHead.reportId === "aaaaaaaaaaaaaaaa", "findReport theo headSha PASS");
    let threw = false;
    try { findReport(artifactDir, { headSha: "abcd" }); } catch { threw = true; }
    ok(threw, "findReport chặn headSha không 40-hex");
    ok(findReport(artifactDir, { reportId: "bbbbbbbbbbbbbbbb" }).passed === false, "findReport theo reportId FAIL");

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
      ["test_status", "test_failures", "test_failure_detail", "test_log_excerpt", "test_finding_map"]),
      `tools/list đủ 5 read-only tools (${names.join(", ")})`);

    const call = async (name, args) => {
      const r = await rpc("tools/call", { name, arguments: args });
      return { result: r.result, data: JSON.parse(r.result.content[0].text) };
    };

    // test_status theo headSha (PASS)
    const s1 = await call("test_status", { headSha: PASS_HEAD });
    ok(s1.result && !s1.result.isError && s1.data.passed === true, "test_status PASS theo headSha");
    ok(s1.data.summary.startsWith("VERIFY PASS head="), "test_status trả compact PASS line");

    // test_status theo reportId (FAIL) + projectId khớp
    const s2 = await call("test_status", { reportId: "bbbbbbbbbbbbbbbb", projectId: "fixture-project" });
    ok(s2.data.passed === false && s2.data.blocking === 2, "test_status FAIL blocking=2");
    ok(s2.data.failureCodes.length === 2, "test_status trả failureCodes");

    // test_failures (mức 1)
    const f = await call("test_failures", { reportId: "bbbbbbbbbbbbbbbb" });
    ok(f.data.count === 2 && f.data.failures[0].code === "STEP_UNIT_FAIL", "test_failures trả code+step");
    ok(f.data.failures[0].step === "unit", "test_failures trả step");

    // test_failure_detail (mức 2) — secret bị redact
    const d = await call("test_failure_detail", { reportId: "bbbbbbbbbbbbbbbb", failureIndex: 0 });
    ok(d.data.failure.includes("expected 2 to equal 3"), "test_failure_detail chứa detail");
    ok(!/supersecret123/.test(d.data.failure), "REDACT: secret literal không lọt ra output");

    // test_log_excerpt (mức 3) — cắt 1 dòng + truncate + redact
    const l = await call("test_log_excerpt", { reportId: "bbbbbbbbbbbbbbbb", failureIndex: 0, maxLines: 1 });
    ok(l.data.truncated === true && l.data.logExcerpt === "line1", "test_log_excerpt cắt đúng 1 dòng + truncate");
    ok(!/supersecret123/.test(l.data.logExcerpt), "REDACT: logExcerpt không chứa secret");

    // test_finding_map — map finding → gate/test, lọc theo findingCode
    const m = await call("test_finding_map", { reportId: "bbbbbbbbbbbbbbbb" });
    ok(m.data.findings.length === 2 && m.data.findings[0].gate === "verify", "finding_map trả gate");
    ok(m.data.findings[0].test?.id === "unit" && m.data.findings[1].test?.id === "integration",
      "finding_map map đúng manifest step");
    const m1 = await call("test_finding_map", { reportId: "bbbbbbbbbbbbbbbb", findingCode: "STEP_INTEGRATION_FAIL" });
    ok(m1.data.findings.length === 1 && m1.data.findings[0].step === "integration",
      "finding_map lọc đúng 1 finding theo code");

    // ── Negative fail-closed ────────────────────────────────────────
    console.log("[3] negative fail-closed");
    for (const c of [
      { name: "test_status", args: { reportId: "../evil" }, expect: "reportId" },
      { name: "test_status", args: { reportId: "bbbbbbbbbbbbbbbb", projectId: "wrong-project" }, expect: "Project Registry" },
      { name: "test_failure_detail", args: { reportId: "bbbbbbbbbbbbbbbb", failureIndex: 9 }, expect: "failureIndex" },
      { name: "test_finding_map", args: { reportId: "bbbbbbbbbbbbbbbb", findingCode: "NOPE" }, expect: "không tìm thấy finding" },
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
  }
  console.log(`\nTổng: ${passed} assertions PASS`);
}

run().catch((err) => { console.error(err); process.exit(1); });

