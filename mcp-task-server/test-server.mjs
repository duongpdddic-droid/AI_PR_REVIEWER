#!/usr/bin/env node
/**
 * Test MCP Task Server: pure logic (state machine, repo parsing) + protocol e2e
 * (spawn server thật, handshake NDJSON, tools/list, tools/call read-only + negative fail-closed).
 * Chạy: node mcp-task-server/test-server.mjs  (yêu cầu `gh` đã đăng nhập)
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkTransition, extractStatus, parseRepos, validateRepo, validateRef, buildListArgs, loadRegisteredRepos } from "./server.mjs";
import { sampleReport, verifyHandoffIdentity } from "../scripts/review-handoff-contract.mjs";
import { computeRegistryDigest, SUPPORTED_REGISTRY_SCHEMA } from "./soc-registry-consumer.mjs";

const REPO = "duongpdddic-droid/QLDA_DTXD";
let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  PASS ${name}`);
}

// ---------------------------------------------------------------------------
// 1) Pure logic — state machine
// ---------------------------------------------------------------------------
console.log("[1] State machine");
ok(extractStatus(["agent:cline", "status:ready-for-cline"]) === "ready-for-cline", "extractStatus tìm đúng label status:*");
ok(extractStatus(["agent:cline"]) === null, "extractStatus trả null khi không có status:*");
ok(checkTransition("claim", "ready-for-cline").ok && checkTransition("claim", "queued").ok,
  "claim hợp lệ từ ready-for-cline và queued");
ok(checkTransition("handoff", "in-progress").to === "review-requested", "handoff: in-progress → review-requested");
ok(checkTransition("requestChanges", "review-requested").agent === "cline", "requestChanges trả agent về cline");
ok(!checkTransition("claim", "review-requested").ok, "claim bị chặn khi đang review-requested (fail-closed)");
ok(!checkTransition("approve", "in-progress").ok, "approve chỉ hợp lệ từ review-requested");
ok(checkTransition("block", "approved").ok && checkTransition("block", null).ok === false,
  "block hợp lệ từ mọi trạng thái có status");
ok(!checkTransition("hanh_dong_lao", "in-progress").ok, "hành động lạ bị từ chối");

// ---------------------------------------------------------------------------
// 2) Pure logic — repo parsing/validation
// ---------------------------------------------------------------------------
console.log("[2] Repo parsing & validation");
ok(JSON.stringify(parseRepos("a/b, c/d , ,e/f")) === JSON.stringify(["a/b", "c/d", "e/f"]),
  "parseRepos tách theo dấu phẩy, trim, bỏ rỗng");
ok(parseRepos(undefined).length === 0 && parseRepos("").length === 0, "parseRepos env rỗng → mảng rỗng");
ok(validateRepo(REPO) === REPO, "validateRepo chấp nhận owner/name chuẩn");
for (const bad of ["../etc/passwd", "a b/c", "owner/", "/repo", "a/b/c", "", "-R evil"]) {
  let threw = false;
  try { validateRepo(bad); } catch { threw = true; }
  ok(threw, `validateRepo chặn '${bad}'`);
}

// ---------------------------------------------------------------------------
// 2b) Pure logic — ref validation & task_list filter args (nâng cấp A)
// ---------------------------------------------------------------------------
console.log("[2b] Ref validation & list filter args");
ok(validateRef("feat/issue-31-coder") === "feat/issue-31-coder", "validateRef chấp nhận ref chuẩn");
ok(validateRef("main") === "main", "validateRef chấp nhận 'main'");
for (const bad of ["", "-R", "--head", "a b", "..", "a/../b", "feat\\x"]) {
  let threw = false;
  try { validateRef(bad); } catch { threw = true; }
  ok(threw, `validateRef chặn ref bẩn '${bad}'`);
}

const listArgs = buildListArgs({ state: "open", status: "ready-for-cline", agent: "cline", limit: 250 });
ok(listArgs[0] === "issue" && listArgs[1] === "list", "buildListArgs bắt đầu bằng gh issue list");
ok(listArgs.includes("--state") && listArgs.includes("open"), "buildListArgs có --state open");
ok(listArgs.includes("--limit") && listArgs.includes("250"), "buildListArgs có --limit 250");
ok(listArgs.includes("--label") && listArgs.includes("status:ready-for-cline") &&
   listArgs.includes("agent:cline"), "buildListArgs thêm --label status:*/agent:*");
ok(!buildListArgs({}).includes("status:"), "buildListArgs không thêm label khi không lọc");

for (const bad of [{ state: "weird" }, { limit: 0 }, { limit: 2000 }, { limit: 1.5 }]) {
  let threw = false;
  try { buildListArgs(bad); } catch { threw = true; }
  ok(threw, `buildListArgs chặn input sai ${JSON.stringify(bad)}`);
}

// GPT-REV-123: registered repos phải đọc từ canonical Soc_brain #17 Project Registry
// (schema v1.0.0) — consumer-only; KHÔNG dùng .agent/config.json hay legacy registry làm allowlist.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fxDir = mkdtempSync(path.join(tmpdir(), "mcp-reg-"));

/** Tạo fixture canonical registry v1.0.0 (projects object keyed by projectId) + contentDigest đúng. */
function fxRegistryPath(projectsObj, { digest = true, schema = SUPPORTED_REGISTRY_SCHEMA } = {}) {
  const p = path.join(fxDir, `reg-${Math.random().toString(36).slice(2)}.json`);
  const data = {
    $schemaVersion: schema,
    revision: 1,
    updatedAt: new Date().toISOString(),
    projects: projectsObj,
  };
  if (digest) data.contentDigest = computeRegistryDigest(data);
  writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  return p;
}

function fxProject(pid, repo, root) {
  return {
    projectId: pid,
    canonicalRepository: repo,
    canonicalRoot: root ?? path.join(tmpdir(), pid),
    status: "active",
    registeredAt: new Date().toISOString(),
    capabilities: ["verify-adapter"],
    worktreeRoots: [path.join(tmpdir(), pid, "worktree")],
    workspaceId: `${pid}-main`,
  };
}

try {
  // Registry đầy đủ 3 repo → ok (consumer đọc canonical, legacyPath không tồn tại để bypass split-brain)
  const full = fxRegistryPath({
    "ai-pr-reviewer": fxProject("ai-pr-reviewer", "duongpdddic-droid/AI_PR_REVIEWER"),
    "qlda-dtxd": fxProject("qlda-dtxd", "duongpdddic-droid/QLDA_DTXD"),
    "soc-brain": fxProject("soc-brain", "duongpdddic-droid/Soc_brain"),
  });
  const rFull = loadRegisteredRepos({ registryPath: full, legacyPath: path.join(fxDir, "no-legacy.json") });
  ok(rFull.ok === true && rFull.repos.length === 3, "canonical registry đầy đủ 3 repo → ok");
  ok(rFull.repos.includes("duongpdddic-droid/AI_PR_REVIEWER"), "registry chứa AI_PR_REVIEWER");
  ok(rFull.repos.includes("duongpdddic-droid/QLDA_DTXD"), "registry chứa QLDA_DTXD");
  ok(rFull.repos.includes("duongpdddic-droid/Soc_brain"), "registry chứa Soc_brain");
} finally {
  // fxDir giữ tới cuối file — fxRegistryPath còn được [2c]/[2e]/[3] dùng.
}

// ---------------------------------------------------------------------------
// 2c) GPT-REV-123 — canonical registry fail-closed (fixture canonical v1.0.0)
// ---------------------------------------------------------------------------
console.log("[2c] GPT-REV-123 registry fail-closed tests (canonical v1.0.0)");

const negDir = mkdtempSync(path.join(tmpdir(), "mcp-reg-neg-"));

function noLegacy() { return path.join(negDir, "no-legacy.json"); }

try {
  // Registry đầy đủ 3 repo → ok
  const full = fxRegistryPath({
    "ai-pr-reviewer": fxProject("ai-pr-reviewer", "duongpdddic-droid/AI_PR_REVIEWER"),
    "qlda-dtxd": fxProject("qlda-dtxd", "duongpdddic-droid/QLDA_DTXD"),
    "soc-brain": fxProject("soc-brain", "duongpdddic-droid/Soc_brain"),
  });
  const rFull = loadRegisteredRepos({ registryPath: full, legacyPath: noLegacy() });
  ok(rFull.ok === true && rFull.repos.length === 3, "registry đầy đủ 3 repo → ok");

  // Registry missing → REGISTRY_MISSING fail-closed
  const rMissing = loadRegisteredRepos({ registryPath: path.join(negDir, "missing.json"), legacyPath: noLegacy() });
  ok(rMissing.ok === false && rMissing.errors.some((e) => e.startsWith("REGISTRY_MISSING")),
    "registry missing → fail-closed REGISTRY_MISSING");

  // Registry malformed JSON → REGISTRY_MALFORMED fail-closed
  const badP = path.join(negDir, "malformed.json");
  writeFileSync(badP, "{ not valid json", "utf8");
  const rBad = loadRegisteredRepos({ registryPath: badP, legacyPath: noLegacy() });
  ok(rBad.ok === false && rBad.errors.some((e) => e.startsWith("REGISTRY_MALFORMED")),
    "registry malformed → fail-closed REGISTRY_MALFORMED");

  // Registry rỗng (projects object rỗng) → REGISTRY_EMPTY fail-closed
  const empty = fxRegistryPath({}, { digest: true });
  const rEmpty = loadRegisteredRepos({ registryPath: empty, legacyPath: noLegacy() });
  ok(rEmpty.ok === false && rEmpty.errors.some((e) => e.startsWith("REGISTRY_EMPTY")),
    "registry rỗng → fail-closed REGISTRY_EMPTY");

  // Unsupported schema version → REGISTRY_UNSUPPORTED_SCHEMA fail-closed
  const badSchema = fxRegistryPath({}, { schema: "0.9", digest: false });
  const rSchema = loadRegisteredRepos({ registryPath: badSchema, legacyPath: noLegacy() });
  ok(rSchema.ok === false && rSchema.errors.some((e) => e.startsWith("REGISTRY_UNSUPPORTED_SCHEMA")),
    "unsupported schema version → fail-closed REGISTRY_UNSUPPORTED_SCHEMA");

  // Digest mismatch → REGISTRY_DIGEST_MISMATCH fail-closed
  const badDigest = fxRegistryPath({}, { digest: true });
  const raw = JSON.parse(readFileSync(badDigest, "utf8"));
  raw.contentDigest = "0000000000000000000000000000000000000000000000000000000000000000";
  writeFileSync(badDigest, JSON.stringify(raw), "utf8");
  const rDigest = loadRegisteredRepos({ registryPath: badDigest, legacyPath: noLegacy() });
  ok(rDigest.ok === false && rDigest.errors.some((e) => e.startsWith("REGISTRY_DIGEST_MISMATCH")),
    "digest mismatch → fail-closed REGISTRY_DIGEST_MISMATCH");

  // Split-brain: legacy active + canonical missing → REGISTRY_SPLIT_BRAIN
  // Tạo legacy file active (có projects) cùng thư mục với canonical missing
  const legacyActiveP = path.join(negDir, "legacy-active.json");
  writeFileSync(legacyActiveP, JSON.stringify({ schemaVersion: "1.0", projects: [{ repository: "old/repo" }] }), "utf8");
  const rSplit1 = loadRegisteredRepos({ registryPath: path.join(negDir, "no-canonical.json"), legacyPath: legacyActiveP });
  ok(rSplit1.ok === false && rSplit1.errors.some((e) => e.startsWith("REGISTRY_SPLIT_BRAIN")),
    "legacy active + canonical missing → REGISTRY_SPLIT_BRAIN");
} finally {
  rmSync(negDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2d) GPT-REV-118 — identity binding (chống replay/substitution)
// ---------------------------------------------------------------------------
console.log("[2d] GPT-REV-118 identity binding");
const PR_SHA = "0123456789abcdef0123456789abcdef01234567";
const IDENTITY = { repository: "duongpdddic-droid/AI_PR_REVIEWER", issue: 32, pullRequest: 33, branch: "feat/x", headSha: PR_SHA, baseSha: PR_SHA.replace("0", "1"), prState: "Open", noForcePushMergeDeploy: true };

// Positive: exact identity + exact PR HEAD → ok
const okId = verifyHandoffIdentity(sampleReport({ identity: IDENTITY }),
  { repo: "duongpdddic-droid/AI_PR_REVIEWER", number: 32, pr: 33, prHeadSha: PR_SHA });
ok(okId.ok === true, "identity exact + exact PR HEAD → ok (positive)");

// Negative: report repo A phát lại cho repo B
const replayRepo = verifyHandoffIdentity(sampleReport({ identity: { ...IDENTITY, repository: "duongpdddic-droid/QLDA_DTXD" } }),
  { repo: "duongpdddic-droid/AI_PR_REVIEWER", number: 32, pr: 33, prHeadSha: PR_SHA });
ok(replayRepo.ok === false && replayRepo.errors.some((e) => e.code === "IDENTITY_REPOSITORY_MISMATCH"),
  "report repo A phát lại cho repo B → IDENTITY_REPOSITORY_MISMATCH");

// Negative: issue khác
const replayIssue = verifyHandoffIdentity(sampleReport({ identity: { ...IDENTITY, issue: 99 } }),
  { repo: "duongpdddic-droid/AI_PR_REVIEWER", number: 32, pr: 33, prHeadSha: PR_SHA });
ok(replayIssue.ok === false && replayIssue.errors.some((e) => e.code === "IDENTITY_ISSUE_MISMATCH"),
  "issue khác → IDENTITY_ISSUE_MISMATCH");

// Negative: PR khác
const replayPr = verifyHandoffIdentity(sampleReport({ identity: { ...IDENTITY, pullRequest: 77 } }),
  { repo: "duongpdddic-droid/AI_PR_REVIEWER", number: 32, pr: 33, prHeadSha: PR_SHA });
ok(replayPr.ok === false && replayPr.errors.some((e) => e.code === "IDENTITY_PR_MISMATCH"),
  "PR khác → IDENTITY_PR_MISMATCH");

// Negative: stale HEAD (headSha ≠ exact PR HEAD) — không chỉ check 40-hex
const staleHead = verifyHandoffIdentity(sampleReport({ identity: { ...IDENTITY, headSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" } }),
  { repo: "duongpdddic-droid/AI_PR_REVIEWER", number: 32, pr: 33, prHeadSha: PR_SHA });
ok(staleHead.ok === false && staleHead.errors.some((e) => e.code === "IDENTITY_HEAD_SHA_MISMATCH"),
  "stale HEAD → IDENTITY_HEAD_SHA_MISMATCH");

// Negative: random 40-hex ≠ PR HEAD
const randomHex = verifyHandoffIdentity(sampleReport({ identity: { ...IDENTITY, headSha: "1111111111111111111111111111111111111111" } }),
  { repo: "duongpdddic-droid/AI_PR_REVIEWER", number: 32, pr: 33, prHeadSha: PR_SHA });
ok(randomHex.ok === false && randomHex.errors.some((e) => e.code === "IDENTITY_HEAD_SHA_MISMATCH"),
  "random 40-hex ≠ PR HEAD → IDENTITY_HEAD_SHA_MISMATCH");

// Negative: PR lookup failure (prHeadSha không đọc được)
const prLookup = verifyHandoffIdentity(sampleReport({ identity: IDENTITY }),
  { repo: "duongpdddic-droid/AI_PR_REVIEWER", number: 32, pr: 33, prHeadSha: undefined });
ok(prLookup.ok === false && prLookup.errors.some((e) => e.code === "PR_HEAD_UNREADABLE"),
  "PR lookup failure → PR_HEAD_UNREADABLE fail-closed");

// Negative: thiếu pr
const noPr = verifyHandoffIdentity(sampleReport({ identity: { ...IDENTITY, pullRequest: undefined } }),
  { repo: "duongpdddic-droid/AI_PR_REVIEWER", number: 32, pr: 33, prHeadSha: PR_SHA });
ok(noPr.ok === false && noPr.errors.some((e) => e.code === "IDENTITY_PR_MISMATCH"),
  "thiếu pr → IDENTITY_PR_MISMATCH fail-closed");

// ---------------------------------------------------------------------------
// 2e) GPT-REV-123 — canonical v1.0.0: consumer pick-up (fixture, không registerProject)
// ---------------------------------------------------------------------------
console.log("[2e] GPT-REV-123 canonical registry consumer pick-up (fixture v1.0.0)");
import { buildReportComment } from "./server.mjs";
import { reportDigest } from "../scripts/review-handoff-contract.mjs";

const pickDir = mkdtempSync(path.join(tmpdir(), "mcp-pick-"));
try {
  // Tạo fixture canonical registry v1.0.0 với Soc_brain repository
  const pickPath = path.join(pickDir, "projects.json");
  const pickData = {
    $schemaVersion: SUPPORTED_REGISTRY_SCHEMA,
    revision: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      "soc-brain": fxProject("soc-brain", "duongpdddic-droid/Soc_brain"),
    },
  };
  pickData.contentDigest = computeRegistryDigest(pickData);
  writeFileSync(pickPath, JSON.stringify(pickData, null, 2), "utf8");

  // Consumer đọc canonical registry → nhận Soc_brain repo
  const consumed = loadRegisteredRepos({ registryPath: pickPath, legacyPath: path.join(pickDir, "no-legacy.json") });
  ok(consumed.ok === true && consumed.repos.includes("duongpdddic-droid/Soc_brain"),
    "consumer nhận Soc_brain từ fixture canonical v1.0.0");

  // Mô phỏng provisioning pick-up: tạo fixture mới với QLDA_DTXD thêm vào
  const pickData2 = {
    $schemaVersion: SUPPORTED_REGISTRY_SCHEMA,
    revision: 2,
    updatedAt: new Date().toISOString(),
    projects: {
      "soc-brain": fxProject("soc-brain", "duongpdddic-droid/Soc_brain"),
      "qlda-dtxd": fxProject("qlda-dtxd", "duongpdddic-droid/QLDA_DTXD"),
    },
  };
  pickData2.contentDigest = computeRegistryDigest(pickData2);
  writeFileSync(pickPath, JSON.stringify(pickData2, null, 2), "utf8");

  const consumed2 = loadRegisteredRepos({ registryPath: pickPath, legacyPath: path.join(pickDir, "no-legacy.json") });
  ok(consumed2.ok === true && consumed2.repos.includes("duongpdddic-droid/QLDA_DTXD"),
    "consumer pick-up QLDA_DTXD từ fixture cập nhật (không cần registerProject)");

  // Consumer không tự đăng ký repo (read-only).
  const before = readFileSync(pickPath, "utf8");
  loadRegisteredRepos({ registryPath: pickPath, legacyPath: path.join(pickDir, "no-legacy.json") });
  const after = readFileSync(pickPath, "utf8");
  ok(before === after, "consumer loadRegisteredRepos read-only — KHÔNG tự đăng ký repo");
} finally {
  rmSync(pickDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2f) GPT-REV-122 — report digest + canonical comment helpers
// ---------------------------------------------------------------------------
console.log("[2f] GPT-REV-122 report digest + canonical comment");
const d1 = reportDigest(sampleReport());
ok(/^[0-9a-f]{64}$/.test(d1), "reportDigest = sha256 hex 64");
ok(reportDigest(sampleReport()) === d1, "reportDigest deterministic");
ok(reportDigest(sampleReport({ identity: { headSha: "0000000000000000000000000000000000000000" } })) !== d1,
  "reportDigest đổi khi report đổi");
const body = buildReportComment(sampleReport(), { headSha: "0".repeat(40), digest: d1, contractVersion: "1.0.0" });
ok(body.startsWith("[REVIEW-HANDOFF-REPORT v1.0.0 @ 0000000000000000000000000000000000000000]"),
  "comment header: contract version + exact HEAD");
ok(body.includes("digest: " + d1), "comment chứa digest");
ok(body.includes('"identity"') && body.includes('"terminalStatus"'),
  "comment chứa đầy đủ report JSON 10 sections");
// 3) Protocol e2e — spawn server thật qua stdio
// ---------------------------------------------------------------------------
console.log("[3] Protocol e2e (stdio NDJSON)");

// Tạo fixture canonical registry cho server (task_handoff gọi loadRegisteredRepos default → env SOC_PROJECT_REGISTRY_PATH)
const e2eDir = mkdtempSync(path.join(tmpdir(), "mcp-e2e-"));
const e2eRegPath = path.join(e2eDir, "projects.json");
const e2eRegData = {
  $schemaVersion: SUPPORTED_REGISTRY_SCHEMA,
  revision: 1,
  updatedAt: new Date().toISOString(),
  projects: {
    "qlda-dtxd": fxProject("qlda-dtxd", REPO),
    "ai-pr-reviewer": fxProject("ai-pr-reviewer", "duongpdddic-droid/AI_PR_REVIEWER"),
    "soc-brain": fxProject("soc-brain", "duongpdddic-droid/Soc_brain"),
  },
};
e2eRegData.contentDigest = computeRegistryDigest(e2eRegData);
writeFileSync(e2eRegPath, JSON.stringify(e2eRegData, null, 2), "utf8");

// Fixture review-state cho GPT-REV-125 (test-only): derive authoritative deterministically.
// Trong child, khi AI_PR_REVIEWER_FIXTURE_REVIEW_STATE set → resolveReviewState không gọi gh.
const FIXTURE_STATE = JSON.stringify([
  { id: 1, author: "duongpdddic-droid", body: "[GPT-REV-000]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: open", ts: "2026-09-02T00:00:00Z" },
]);

// GPT-REV-129: bỏ dependency live PR #47 + hard-coded remote HEAD — child dùng fixture PR HEAD.
// Skip-through env: AI_PR_REVIEWER_TEST_SKIP_E2E=1 để chỉ chạy phần deterministic [2g] (không cần gh).
const FIXTURE_PR_HEAD = "e7431244cac7484ceda6b4706fbeef97e4629d4d";
if (process.env.AI_PR_REVIEWER_TEST_SKIP_E2E === "1") {
  console.log("[skip] live e2e bị bỏ qua (AI_PR_REVIEWER_TEST_SKIP_E2E=1)");
} else {
const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
  env: { ...process.env, MCP_TASK_REPOS: REPO, SOC_PROJECT_REGISTRY_PATH: e2eRegPath, AI_PR_REVIEWER_FIXTURE_REVIEW_STATE: FIXTURE_STATE, AI_PR_REVIEWER_FIXTURE_PR_HEAD: JSON.stringify({ "47": FIXTURE_PR_HEAD }) },
  stdio: ["pipe", "pipe", "pipe"],
});
let lineBuf = "";
child.stdout.on("data", (chunk) => {
  lineBuf += chunk;
  let idx;
  while ((idx = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    } catch { /* bỏ dòng lỗi */ }
  }
});

let nextId = 1;
const pending = new Map();
function rpc(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout chờ phản hồi ${method} (id=${id})`));
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  ok(init.result?.serverInfo?.name === "mcp-task-server", "initialize trả đúng serverInfo.name");
  ok(typeof init.result?.protocolVersion === "string", "initialize trả protocolVersion");

  // Notification không có phản hồi (chuẩn JSON-RPC) — gửi không await
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  // Cho server xử lý kịp; nếu không crash, tools/list vẫn phản hồi → chứng tỏ server ổn
  ok(true, "notification initialized được gửi (không crash)");

  const tools = await rpc("tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  ok(names.length === 9 &&
     ["task_list","task_get","task_create","task_claim","task_handoff","task_review","task_block","task_comment","task_pr"]
       .every((n) => names.includes(n)), `tools/list đủ 9 tools (${names.join(", ")})`);
  ok(tools.result.tools.every((t) => t.inputSchema?.type === "object"), "mọi tool đều có inputSchema");

  // tools/call read-only trên repo thật
  const list = await rpc("tools/call", { name: "task_list", arguments: {} });
  ok(list.result && !list.result.isError, "task_list chạy không lỗi");
  const parsedList = JSON.parse(list.result.content[0].text);
  ok(Array.isArray(parsedList.tasks), "task_list trả mảng tasks");
  for (const t of parsedList.tasks) {
    ok(t.repo === REPO && Number.isInteger(t.number), `task_list item hợp lệ (#${t.number} ${t.status})`);
    break; // chỉ cần 1 item đại diện
  }

  const get35 = await rpc("tools/call", { name: "task_get", arguments: { repo: REPO, number: 35 } });
  const issue35 = JSON.parse(get35.result.content[0].text);
  ok(issue35.number === 35, "task_get #35 trả đúng số Issue");
  ok(typeof issue35.status === "string" && typeof issue35.agent === "string",
    `task_get #35 có agent/status (${issue35.agent} / ${issue35.status})`);

  // Negative fail-closed: claim #35 (đang review-requested/approved) phải bị chặn TRƯỚC mutation
  const badClaim = await rpc("tools/call", { name: "task_claim", arguments: { repo: REPO, number: 35 } });
  ok(badClaim.result?.isError === true, "task_claim sai transition → isError (fail-closed)");
  ok(/Chuyển trạng thái không hợp lệ/.test(badClaim.result.content[0].text),
    "thông báo lỗi nêu rõ lý do transition");
  const after = JSON.parse(
    (await rpc("tools/call", { name: "task_get", arguments: { repo: REPO, number: 35 } })).result.content[0].text);
  ok(after.status === issue35.status && after.agent === issue35.agent,
    "label #35 KHÔNG đổi sau claim bị chặn (không mutation rò rỉ)");

  // Issue #32: canonical REVIEW HANDOFF CONTRACT gate — handoffReport PARTIAL_EVIDENCE
  // phải bị chặn fail-closed TRƯỚC mọi mutation (kể cả khi transition lẽ ra hợp lệ).
  // Gate order (GPT-REV-125): registry → identity → PR HEAD read → policy → derive → caller-assert → validate.
  // Để chạm được validate gate, cần report identity đúng + exact PR HEAD (PR #47 thật của QLDA_DTXD).
  const badReport = { contractVersion: "9.9.9",
    identity: { repository: REPO, issue: 35, pullRequest: 47, branch: "feat/e2e", headSha: "e7431244cac7484ceda6b4706fbeef97e4629d4d", baseSha: "0123456789abcdef0123456789abcdef01234566", prState: "Open", noForcePushMergeDeploy: true },
    terminalStatus: { status: "DONE" } };
  const badHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 47, handoffReport: badReport } });
  ok(badHandoff.result?.isError === true, "task_handoff với report PARTIAL_EVIDENCE → isError (fail-closed)");
  ok(/HANDOFF_PARTIAL_EVIDENCE/.test(badHandoff.result.content[0].text),
    "lỗi bàn giao nêu rõ HANDOFF_PARTIAL_EVIDENCE");
  const afterBadHandoff = JSON.parse(
    (await rpc("tools/call", { name: "task_get", arguments: { repo: REPO, number: 35 } })).result.content[0].text);
  ok(afterBadHandoff.status === issue35.status && afterBadHandoff.agent === issue35.agent,
    "label #35 KHÔNG đổi sau handoff bị chặn (không mutation rò rỉ)");

  // GPT-REV-115: omitted handoffReport → HANDOFF_REPORT_REQUIRED, fail-closed trước mutation
  const omitHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 999 } });
  ok(omitHandoff.result?.isError === true, "task_handoff thiếu handoffReport → isError (fail-closed)");
  ok(/HANDOFF_REPORT_REQUIRED/.test(omitHandoff.result.content[0].text), "lỗi nêu rõ HANDOFF_REPORT_REQUIRED");
  const afterOmit = JSON.parse(
    (await rpc("tools/call", { name: "task_get", arguments: { repo: REPO, number: 35 } })).result.content[0].text);
  ok(afterOmit.status === issue35.status && afterOmit.agent === issue35.agent,
    "label #35 KHÔNG đổi sau handoff thiếu report (không mutation rò rỉ)");

  // GPT-REV-116: unknown repo self-declared → giờ bị chặn sớm ở identity binding
  // (gate order GPT-REV-125: identity trước validate). → HANDOFF_IDENTITY_MISMATCH, no mutation.
  const unknownRepoReport = sampleReport({ identity: { repository: "evil/repo" } });
  const unknownHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 999, handoffReport: unknownRepoReport } });
  ok(unknownHandoff.result?.isError === true, "task_handoff unknown repo → isError (fail-closed)");
  ok(/HANDOFF_IDENTITY_MISMATCH/.test(unknownHandoff.result.content[0].text), "lỗi nêu rõ HANDOFF_IDENTITY_MISMATCH");
  ok(/IDENTITY_REPOSITORY_MISMATCH/.test(unknownHandoff.result.content[0].text), "lỗi nêu rõ IDENTITY_REPOSITORY_MISMATCH");
  const afterUnknown = JSON.parse(
    (await rpc("tools/call", { name: "task_get", arguments: { repo: REPO, number: 35 } })).result.content[0].text);
  ok(afterUnknown.status === issue35.status && afterUnknown.agent === issue35.agent,
    "label #35 KHÔNG đổi sau handoff unknown repo (không mutation rò rỉ)");

  // GPT-REV-117: BLOCKED terminal status → vẫn bị chặn fail-closed (canRequestReview=false).
  // Cần identity đúng QLDA + exact PR HEAD (PR #47) để vượt được identity/PR-HEAD gate và chạm validate.
  const blockedReport = sampleReport({ identity: { repository: REPO, issue: 35, pullRequest: 47, branch: "feat/e2e", headSha: "e7431244cac7484ceda6b4706fbeef97e4629d4d", baseSha: "0123456789abcdef0123456789abcdef01234566", prState: "Open", noForcePushMergeDeploy: true }, terminalStatus: { status: "BLOCKED" } });
  const blockedHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 47, handoffReport: blockedReport } });
  ok(blockedHandoff.result?.isError === true, "task_handoff BLOCKED report → isError (fail-closed)");
  ok(/HANDOFF_PARTIAL_EVIDENCE/.test(blockedHandoff.result.content[0].text), "lỗi nêu rõ HANDOFF_PARTIAL_EVIDENCE");
  const afterBlocked = JSON.parse(
    (await rpc("tools/call", { name: "task_get", arguments: { repo: REPO, number: 35 } })).result.content[0].text);
  ok(afterBlocked.status === issue35.status && afterBlocked.agent === issue35.agent,
    "label #35 KHÔNG đổi sau handoff BLOCKED (không mutation rò rỉ)");

  // GPT-REV-118: identity binding — report hợp lệ nhưng identity mismatch → fail-closed TRƯỚC mutation.
  // Report READY_FOR_REVIEW hợp lệ (đủ semantic) với identity QLDA_DTXD #35 → qua validateHandoff,
  // nhưng các trường identity không khớp args server → HANDOFF_IDENTITY_MISMATCH, no mutation.
  const qldaIdentity = { repository: REPO, issue: 35, pullRequest: 999, branch: "feat/e2e", headSha: "0123456789abcdef0123456789abcdef01234567", baseSha: "0123456789abcdef0123456789abcdef01234566", prState: "Open", noForcePushMergeDeploy: true };
  const validQlda = () => sampleReport({ identity: qldaIdentity });

  // (a) thiếu pr → HANDOFF_PR_REQUIRED
  const noPrHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, handoffReport: validQlda() } });
  ok(noPrHandoff.result?.isError === true, "task_handoff thiếu pr → isError (fail-closed)");
  ok(/HANDOFF_PR_REQUIRED/.test(noPrHandoff.result.content[0].text), "lỗi nêu rõ HANDOFF_PR_REQUIRED");

  // (b) repo A phát lại cho repo B (report khai AI_PR_REVIEWER, gọi trên QLDA_DTXD) → IDENTITY_REPOSITORY_MISMATCH
  const replayRepo = sampleReport({ identity: { ...qldaIdentity, repository: "duongpdddic-droid/AI_PR_REVIEWER" } });
  const replayRepoHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 999, handoffReport: replayRepo } });
  ok(replayRepoHandoff.result?.isError === true, "task_handoff report repo A trên repo B → isError");
  ok(/HANDOFF_IDENTITY_MISMATCH/.test(replayRepoHandoff.result.content[0].text), "lỗi nêu rõ HANDOFF_IDENTITY_MISMATCH");
  ok(/IDENTITY_REPOSITORY_MISMATCH/.test(replayRepoHandoff.result.content[0].text), "lỗi nêu rõ IDENTITY_REPOSITORY_MISMATCH");

  // (c) issue khác → IDENTITY_ISSUE_MISMATCH
  const wrongIssue = sampleReport({ identity: { ...qldaIdentity, issue: 36 } });
  const wrongIssueHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 999, handoffReport: wrongIssue } });
  ok(wrongIssueHandoff.result?.isError === true, "task_handoff issue khác → isError");
  ok(/IDENTITY_ISSUE_MISMATCH/.test(wrongIssueHandoff.result.content[0].text), "lỗi nêu rõ IDENTITY_ISSUE_MISMATCH");

  // (d) PR khác → IDENTITY_PR_MISMATCH
  const wrongPr = sampleReport({ identity: { ...qldaIdentity, pullRequest: 48 } });
  const wrongPrHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 999, handoffReport: wrongPr } });
  ok(wrongPrHandoff.result?.isError === true, "task_handoff PR khác → isError");
  ok(/IDENTITY_PR_MISMATCH/.test(wrongPrHandoff.result.content[0].text), "lỗi nêu rõ IDENTITY_PR_MISMATCH");

  // (e) PR lookup failure (PR #999 không tồn tại) → HANDOFF_PR_HEAD_READ_FAILED
  const pr999Handoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 999, handoffReport: validQlda() } });
  ok(pr999Handoff.result?.isError === true, "task_handoff PR không tồn tại → isError");
  ok(/HANDOFF_PR_HEAD_READ_FAILED/.test(pr999Handoff.result.content[0].text), "lỗi nêu rõ HANDOFF_PR_HEAD_READ_FAILED");

  // (f) stale HEAD / random 40-hex → IDENTITY_HEAD_SHA_MISMATCH (dùng PR #47 thật của QLDA_DTXD)
  //     report khai PR 47 nhưng headSha không phải exact PR HEAD → fail-closed.
  const staleReport = sampleReport({ identity: { ...qldaIdentity, pullRequest: 47, headSha: "ffffffffffffffffffffffffffffffffffffffff" } });
  const staleHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 47, handoffReport: staleReport } });
  ok(staleHandoff.result?.isError === true, "task_handoff stale HEAD → isError");
  ok(/HANDOFF_IDENTITY_MISMATCH/.test(staleHandoff.result.content[0].text), "lỗi nêu rõ HANDOFF_IDENTITY_MISMATCH");
  ok(/IDENTITY_HEAD_SHA_MISMATCH/.test(staleHandoff.result.content[0].text), "lỗi nêu rõ IDENTITY_HEAD_SHA_MISMATCH");

  // Mọi case (a)-(f) đều KHÔNG đổi label #35 (không mutation rò rỉ)
  const after118 = JSON.parse(
    (await rpc("tools/call", { name: "task_get", arguments: { repo: REPO, number: 35 } })).result.content[0].text);
  ok(after118.status === issue35.status && after118.agent === issue35.agent,
    "label #35 KHÔNG đổi sau mọi handoff identity-mismatch (không mutation rò rỉ)");

  // GPT-REV-125: caller expectedFindings là assertion vs derived authoritative (fixture=['GPT-REV-000']),
  // KHÔNG còn là input cho validateHandoff (thay thế GPT-REV-124).
  // (g) Caller mismatch → HANDOFF_FINDINGS_CALLER_MISMATCH (fail-closed, TRƯỚC validate/mutation).
  //     Dùng PR #47 thật (PR HEAD readable) + identity đúng exact HEAD để chạm được caller-assert gate.
  const pr47Head = "e7431244cac7484ceda6b4706fbeef97e4629d4d";
  const mismatchReport = sampleReport({ identity: { ...qldaIdentity, pullRequest: 47, headSha: pr47Head } });
  const mismatchHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 47, handoffReport: mismatchReport, expectedFindings: ["GPT-REV-118", "GPT-REV-119"] } });
  ok(mismatchHandoff.result?.isError === true, "task_handoff caller expectedFindings mismatch → isError (fail-closed)");
  ok(/HANDOFF_FINDINGS_CALLER_MISMATCH/.test(mismatchHandoff.result.content[0].text), "lỗi nêu rõ HANDOFF_FINDINGS_CALLER_MISMATCH");
  const afterFindings = JSON.parse(
    (await rpc("tools/call", { name: "task_get", arguments: { repo: REPO, number: 35 } })).result.content[0].text);
  ok(afterFindings.status === issue35.status && afterFindings.agent === issue35.agent,
    "label #35 KHÔNG đổi sau handoff caller-mismatch (không mutation rò rỉ)");

  // (h) Caller expectedFindings KHỚP authoritative (fixture=['GPT-REV-000']) → qua caller-assert,
  //     tiến tới validate → report contractVersion sai → HANDOFF_PARTIAL_EVIDENCE (không mutation).
  //     Dùng PR #47 thật (readable) để derive/caller-assert chạy được.
  const okFindingsReport = sampleReport({ identity: { ...qldaIdentity, pullRequest: 47, headSha: pr47Head }, contractVersion: "9.9.9" });
  const okFindingsHandoff = await rpc("tools/call", { name: "task_handoff", arguments: { repo: REPO, number: 35, pr: 47, handoffReport: okFindingsReport, expectedFindings: ["GPT-REV-000"] } });
  ok(okFindingsHandoff.result?.isError === true, "task_handoff caller expectedFindings khớp → qua caller-assert → validate chặn PARTIAL");
  ok(/HANDOFF_PARTIAL_EVIDENCE/.test(okFindingsHandoff.result.content[0].text), "đã qua caller-assert → chặn ở HANDOFF_PARTIAL_EVIDENCE");


  // Repo bẩn bị chặn bởi validateRepo
  const badRepo = await rpc("tools/call", { name: "task_get", arguments: { repo: "../evil", number: 1 } });
  ok(badRepo.result?.isError === true, "repo dạng bẩn → isError (chống injection)");

  // Method lạ → -32601
  const unknown = await rpc("resources/list", {});
  ok(unknown.error?.code === -32601, "method lạ trả -32601 Method not found");
} finally {
  child.stdin.end();
  child.kill();
  rmSync(e2eDir, { recursive: true, force: true });
  rmSync(fxDir, { recursive: true, force: true });
}
} // end if(!skip e2e)

// ---------------------------------------------------------------------------
// 2g) Policy-authority deterministic (KHÔNG phụ thuộc process.cwd) + GPT-REV-125
//     server derive authoritative finding set + caller assertion.
//     Pure helpers, không cần gh — fixture qua AI_PR_REVIEWER_FIXTURE_REVIEW_STATE.
// ---------------------------------------------------------------------------
console.log("[2g] Policy-authority deterministic + GPT-REV-125 derive authoritative findings");

const GPT_REVIEWER = "gpt-reviewer-bot-125";
import {
  loadPolicyAuthority, resolvePolicyAuthorityPath, resolveReviewState, deriveAuthoritativeFindings,
} from "./server.mjs";

// Regression cho Soc_brain #35 / PR #36: reviewer policy KHÔNG resolve từ process.cwd().
// Fixtures: canonicalRoot (authority hợp lệ), unrelatedRoot (cwd chứa policy TRAP),
// bareRoot (không có policy — chứng minh no-fabrication + path deterministic),
// badRoot (policy sai shape — fail-closed).
const polDir = mkdtempSync(path.join(tmpdir(), "mcp-pol-"));
const prevCwd = process.cwd();
const prevPolicyEnv = process.env.AI_PR_POLICY_PATH;
delete process.env.AI_PR_POLICY_PATH; // ép resolution canonical module-relative trong test
try {
  const canonicalRoot = path.join(polDir, "canonical-root");
  const unrelatedRoot = path.join(polDir, "unrelated-cwd");
  const bareRoot = path.join(polDir, "bare-cwd");
  const badRoot = path.join(polDir, "bad-cwd");
  for (const d of [canonicalRoot, unrelatedRoot, bareRoot, badRoot]) mkdirSync(d, { recursive: true });
  mkdirSync(path.join(canonicalRoot, ".github"), { recursive: true });
  writeFileSync(path.join(canonicalRoot, ".github", "ai-review-policy.json"),
    JSON.stringify({ approvalAuthorities: {
      gptApprovalCommentAuthors: [GPT_REVIEWER],
      localApprovalCommentAuthors: ["human-admin"],
    } }), { encoding: "utf8" });
  mkdirSync(path.join(unrelatedRoot, ".github"), { recursive: true });
  writeFileSync(path.join(unrelatedRoot, ".github", "ai-review-policy.json"),
    JSON.stringify({ approvalAuthorities: {
      gptApprovalCommentAuthors: ["imposter-cwd"],
      localApprovalCommentAuthors: [],
    } }), { encoding: "utf8" });
  mkdirSync(path.join(badRoot, ".github"), { recursive: true });
  writeFileSync(path.join(badRoot, ".github", "ai-review-policy.json"),
    JSON.stringify({ foo: 1 }), { encoding: "utf8" });

  // (1) Task server launched từ unrelated cwd KHÔNG resolve reviewer policy từ cwd đó.
  process.chdir(unrelatedRoot);
  try {
    const p = resolvePolicyAuthorityPath();
    ok(!p.startsWith(unrelatedRoot), "(1) resolvePolicyAuthorityPath không resolve từ cwd (policy trap)");
    const authTrapped = loadPolicyAuthority();
    ok(authTrapped.ok === true && !authTrapped.gpt.includes("imposter-cwd"),
      "(1) loadPolicyAuthority bỏ qua policy giả trong cwd (KHÔNG đọc từ process.cwd)");
  } finally {
    process.chdir(prevCwd);
  }

  // (4) No target-repo/cwd policy fabrication + path deterministic bất kể cwd.
  process.chdir(bareRoot);
  let pathFromBare;
  try {
    pathFromBare = resolvePolicyAuthorityPath();
    ok(!existsSync(path.join(bareRoot, ".github", "ai-review-policy.json")),
      "(4) no policy fabrication trong cwd (không tạo .github/ai-review-policy.json)");
  } finally {
    process.chdir(canonicalRoot);
    const pathFromCanon = resolvePolicyAuthorityPath();
    process.chdir(prevCwd);
    ok(pathFromBare === pathFromCanon, "(4) resolvePolicyAuthorityPath deterministic bất kể cwd");
    ok(/ai-review-policy\.json$/.test(pathFromBare), "(4) resolvePolicyAuthorityPath trỏ tới canonical .github/ai-review-policy.json");
  }

  // (2) Valid canonical reviewer context resolve đúng (explicit validated root).
  const auth = loadPolicyAuthority({ policyRoot: canonicalRoot });
  ok(auth.ok === true && auth.gpt.includes(GPT_REVIEWER) && auth.local.includes("human-admin"),
    "(2) loadPolicyAuthority(policyRoot=canonical) → đọc đúng allowlist gpt/local");

  // (3) Missing/invalid authority vẫn fail-closed.
  ok(loadPolicyAuthority({ policyRoot: bareRoot }).ok === false,
    "(3) loadPolicyAuthority(policyRoot không có policy) → fail-closed (missing)");
  ok(loadPolicyAuthority({ policyRoot: badRoot }).ok === false,
    "(3) loadPolicyAuthority(policy sai shape) → fail-closed (invalid)");

  // GPT-REV-128 — canonical policy binding: repo/version/digest/split-brain (fail-closed).
  const writePol = (d, pol) => { mkdirSync(path.join(d, ".github"), { recursive: true }); writeFileSync(path.join(d, ".github", "ai-review-policy.json"), JSON.stringify(pol), "utf8"); };
  const boundRoot = path.join(polDir, "bound-root");
  const badRepoRoot = path.join(polDir, "bad-repo-root");
  const badVerRoot = path.join(polDir, "bad-ver-root");
  const badDigestRoot = path.join(polDir, "bad-digest-root");
  const sinRoot = path.join(polDir, "sin-root");
  writePol(boundRoot, { policyVersion: "2026-09-02.1", scope: { appliesTo: [REPO, "duongpdddic-droid/AI_PR_REVIEWER"] }, approvalAuthorities: { gptApprovalCommentAuthors: [GPT_REVIEWER], localApprovalCommentAuthors: ["human-admin"] } });
  writePol(badRepoRoot, { policyVersion: "2026-09-02.1", scope: { appliesTo: ["duongpdddic-droid/AI_PR_REVIEWER"] }, approvalAuthorities: { gptApprovalCommentAuthors: [GPT_REVIEWER], localApprovalCommentAuthors: ["human-admin"] } });
  writePol(badVerRoot, { policyVersion: "2026-08-23.7", scope: { appliesTo: [REPO] }, approvalAuthorities: { gptApprovalCommentAuthors: [GPT_REVIEWER], localApprovalCommentAuthors: ["human-admin"] } });
  writePol(badDigestRoot, { policyVersion: "2026-09-02.1", scope: { appliesTo: [REPO] }, approvalAuthorities: { gptApprovalCommentAuthors: [GPT_REVIEWER], localApprovalCommentAuthors: ["human-admin"] } });
  writePol(sinRoot, { policyVersion: "2026-09-02.1", scope: { appliesTo: [REPO] }, approvalAuthorities: { gptApprovalCommentAuthors: [GPT_REVIEWER], localApprovalCommentAuthors: ["human-admin"] } });

  // (5) Valid canonical binding → ok + policyVersion + digest sha256 (bind repo/version/digest).
  const bauth = loadPolicyAuthority({ policyRoot: boundRoot, expectedRepo: REPO, requireVersion: true });
  ok(bauth.ok === true && bauth.policyVersion === "2026-09-02.1" && typeof bauth.digest === "string" && /^[0-9a-f]{64}$/.test(bauth.digest),
    "(5) bind canonical → ok + policyVersion + digest sha256");
  // (6) Wrong-repo (policy không áp dụng cho repo đích) → POLICY_REPO_MISMATCH fail-closed.
  ok(loadPolicyAuthority({ policyRoot: badRepoRoot, expectedRepo: REPO, requireVersion: true }).errors?.[0]?.code === "POLICY_REPO_MISMATCH",
    "(6) policy không áp dụng cho repo → POLICY_REPO_MISMATCH fail-closed");
  // (7) Missing policyVersion (requireVersion) → POLICY_VERSION_MISSING fail-closed.
  ok(loadPolicyAuthority({ policyRoot: canonicalRoot, requireVersion: true }).errors?.[0]?.code === "POLICY_VERSION_MISSING",
    "(7) policy thiếu policyVersion (requireVersion) → POLICY_VERSION_MISSING fail-closed");
  // (8) Pinned version khác policy → POLICY_VERSION_MISMATCH fail-closed.
  ok(loadPolicyAuthority({ policyRoot: badVerRoot, expectedRepo: REPO, expectedVersion: "2099-01-01.0", requireVersion: true }).errors?.[0]?.code === "POLICY_VERSION_MISMATCH",
    "(8) pinned version khác policy → POLICY_VERSION_MISMATCH fail-closed");
  // (9) expectedDigest sai → POLICY_DIGEST_MISMATCH fail-closed.
  ok(loadPolicyAuthority({ policyRoot: badDigestRoot, expectedRepo: REPO, requireVersion: true, expectedDigest: "deadbeef" }).errors?.[0]?.code === "POLICY_DIGEST_MISMATCH",
    "(9) expectedDigest sai → POLICY_DIGEST_MISMATCH fail-closed");
  // (10) Split-brain (compareCanonical + policyRoot ≠ canonical, digest khác) → POLICY_SPLIT_BRAIN fail-closed.
  ok(loadPolicyAuthority({ policyRoot: sinRoot, compareCanonical: true, requireVersion: true }).errors?.[0]?.code === "POLICY_SPLIT_BRAIN",
    "(10) 2 nguồn policy khác digest → POLICY_SPLIT_BRAIN fail-closed");
  // GPT-REV-130 — deterministic scope-gate: policy resolution chấp nhận đúng repo đã đăng ký
  // (AI_PR_REVIEWER / QLDA_DTXD / Soc_brain) và từ chối repo lạ bằng POLICY_REPO_MISMATCH.
  // Soc_brain là registered sole control plane + target thực tế của Issue #35; dùng fixture policy
  // (cấu trúc y hệt canonical) — KHÔNG mutation Soc_brain PR #36, KHÔNG phụ thuộc cwd/env override.
  const AIPR_REPO = "duongpdddic-droid/AI_PR_REVIEWER";
  const SOC_REPO = "duongpdddic-droid/Soc_brain";
  const socGateRoot = path.join(polDir, "soc-gate-root");
  writePol(socGateRoot, { policyVersion: "2026-09-02.1", scope: { appliesTo: [REPO, AIPR_REPO, SOC_REPO] }, approvalAuthorities: { gptApprovalCommentAuthors: [GPT_REVIEWER], localApprovalCommentAuthors: ["human-admin"] } });
  for (const r of [REPO, AIPR_REPO, SOC_REPO]) {
    const a = loadPolicyAuthority({ policyRoot: socGateRoot, expectedRepo: r, requireVersion: true });
    ok(a.ok === true, `GPT-REV-130: policy chấp nhận repo đã đăng ký ${r} (scope gate PASS)`);
  }
  ok(loadPolicyAuthority({ policyRoot: socGateRoot, expectedRepo: "duongpdddic-droid/unknown-repo", requireVersion: true }).errors?.[0]?.code === "POLICY_REPO_MISMATCH",
    "GPT-REV-130: repo chưa đăng ký (unknown) → POLICY_REPO_MISMATCH fail-closed");
  // Canonical policy thật (module-anchored, không policyRoot) phải bind được Soc_brain: nếu canonical
  // chưa liệt kê Soc_brain trong scope.appliesTo thì production fail-closed HANDOFF_FINDINGS_AUTHORITY_UNAVAILABLE.
  const authSocCanon = loadPolicyAuthority({ expectedRepo: SOC_REPO, requireVersion: true });
  ok(authSocCanon.ok === true, "GPT-REV-130: canonical policy bind được Soc_brain (scope.appliesTo có Soc_brain)");


    const fixture = JSON.stringify([
      { id: 1, author: GPT_REVIEWER,
        body: "[GPT-REV-118]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: open", ts: "2026-09-02T01:00:00Z" },
      { id: 2, author: GPT_REVIEWER,
        body: "[GPT-REV-119]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: open", ts: "2026-09-02T02:00:00Z" },
      { id: 3, author: GPT_REVIEWER,
        body: "[GPT-REV-120]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: withdrawn", ts: "2026-09-02T03:00:00Z" },
    ]);
    const prevEnv = process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE;
    process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE = fixture;
    try {
      const st = resolveReviewState("duongpdddic-droid/QLDA_DTXD", 35);
      ok(st.ok === true && Array.isArray(st.comments) && st.comments.length === 3,
        "resolveReviewState(.fixture) → trả 3 comments (không gọi gh)");

      const derived = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: auth });
      ok(derived.ok === true && derived.findings.length === 2 &&
         derived.findings.includes("GPT-REV-118") && derived.findings.includes("GPT-REV-119"),
        `deriveAuthoritativeFindings: active 118,119 / withdrawn 120 (got ${JSON.stringify(derived.findings)})`);
      const { sameFindingSet } = await import("../scripts/review-handoff-contract.mjs");
      ok(sameFindingSet(derived.findings, ["GPT-REV-119", "GPT-REV-118"]) === true,
        "sameFindingSet authoritative vs caller exact set (khác thứ tự) → true");
      ok(sameFindingSet(derived.findings, ["GPT-REV-118"]) === false,
        "sameFindingSet authoritative vs caller subset → false");

      // Non-authority actor (unauthorized-only): comment từ actor KHÔNG có authority, không có
      // finding nào do authority hợp lệ tạo → GPT-REV-127 fail-closed (KHÔNG silent drop).
      process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE = JSON.stringify([
        { id: 9, author: "imposter-bot",
          body: "[GPT-REV-200]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: open", ts: "2026-09-02T01:00:00Z" },
      ]);
      const derivedNA = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: auth });
      ok(derivedNA.ok === false && derivedNA.errors.some((e) => e.code === "AUTHORITY_UNAVAILABLE"),
        "unauthorized-only findings → AUTHORITY_UNAVAILABLE (không scrape comment tùy ý)");

      // Malformed marker: comment thiếu FINDING_REQUIRED_FIELDS → parser bỏ qua (không authoritative).
      process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE = JSON.stringify([
        { id: 7, author: GPT_REVIEWER, body: "xem thêm GPT-REV-118 ở đâu đó", ts: "2026-09-02T01:00:00Z" },
      ]);
      const derivedMal = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: auth });
      ok(derivedMal.ok === true && derivedMal.findings.length === 0,
        "comment không có marker đầy đủ → parser skip → authoritative rỗng");

      // GPT-REV-127: Empty authority allowlist (arrays present nhưng rỗng) → KHÔNG reviewer principal có
      // quyền → AUTHORITY_UNAVAILABLE (fail-closed), KHÔNG được coi authoritative rỗng là thành công.
      process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE = fixture;
      const derivedEmptyAuth = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: { gpt: [], local: [] } });
      ok(derivedEmptyAuth.ok === false && derivedEmptyAuth.errors.some((e) => e.code === "AUTHORITY_UNAVAILABLE"),
        "empty authority allowlist → AUTHORITY_UNAVAILABLE (fail-closed, không silent drop)");

      // Missing authority (null) khi có finding → AUTHORITY_UNAVAILABLE fail-closed.
      const derivedNoAuth = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: null });
      ok(derivedNoAuth.ok === false && derivedNoAuth.errors.some((e) => e.code === "AUTHORITY_UNAVAILABLE"),
        "missing authority + có finding → AUTHORITY_UNAVAILABLE");

      // GPT-REV-129 — reader injection: reader synthetic ≡ production adapter (fixture env) cho cùng dữ liệu.
      const derivedViaReader = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: auth, reader: (repo, pr) => resolveReviewState(repo, pr) });
      ok(sameFindingSet(derivedViaReader.findings, derived.findings) === true,
        "GPT-REV-129: reader injected ≡ production adapter cho cùng authoritative set");

      // Pagination: reader ghép toàn bộ comments (nhiều hơn 1 trang) → derive dedupe trên 3 finding active.
      const manyComments = Array.from({ length: 120 }, (_, i) => ({
        id: 1000 + i, author: GPT_REVIEWER,
        body: `[GPT-REV-${String((i % 3) + 118).padStart(3, "0")}]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: open`,
        ts: `2026-09-02T${String(i % 24).padStart(2, "0")}:00:00Z`,
      }));
      const derivedPaged = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: auth, reader: () => ({ ok: true, comments: manyComments }) });
      ok(derivedPaged.ok === true && derivedPaged.findings.length === 3 && sameFindingSet(derivedPaged.findings, ["GPT-REV-118", "GPT-REV-119", "GPT-REV-120"]),
        "GPT-REV-129: pagination (120 comments) → dedupe trên 3 finding active, không tràn");

      // Malformed shape: reader trả comments không phải mảng → REVIEW_STATE_MALFORMED fail-closed.
      const derivedBadShape = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: auth, reader: () => ({ ok: true, comments: "not-array" }) });
      ok(derivedBadShape.ok === false && derivedBadShape.errors.some((e) => e.code === "REVIEW_STATE_MALFORMED"),
        "GPT-REV-129: malformed review-state shape → REVIEW_STATE_MALFORMED fail-closed");

      // API failure: reader throw → REVIEW_STATE_READER_FAILED fail-closed (no mutation).
      const derivedFail = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: auth, reader: () => { throw new Error("gh api 500"); } });
      ok(derivedFail.ok === false && derivedFail.errors.some((e) => e.code === "REVIEW_STATE_READER_FAILED"),
        "GPT-REV-129: API failure (reader throw) → REVIEW_STATE_READER_FAILED fail-closed");

      // Duplicate comments: cùng finding ID, trạng thái sau (withdrawn) thắng → loại khỏi active.
      process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE = JSON.stringify([
        { id: 1, author: GPT_REVIEWER, body: "[GPT-REV-118]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: open", ts: "2026-09-02T01:00:00Z" },
        { id: 2, author: GPT_REVIEWER, body: "[GPT-REV-118]\nseverity: high\nevidence: x\nrisk: y\nexpectedOutcome: z\nstatus: withdrawn", ts: "2026-09-02T03:00:00Z" },
      ]);
      const derivedDup = deriveAuthoritativeFindings("duongpdddic-droid/QLDA_DTXD", 35, { authority: auth });
      ok(derivedDup.ok === true && derivedDup.findings.length === 0,
        "GPT-REV-129: duplicate comment cùng finding ID → trạng thái cuối (withdrawn) thắng → rỗng");
      process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE = fixture;

    } finally {
      if (prevEnv === undefined) delete process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE;
      else process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE = prevEnv;
    }
} finally {
  process.chdir(prevCwd);
  if (prevPolicyEnv === undefined) delete process.env.AI_PR_POLICY_PATH;
  else process.env.AI_PR_POLICY_PATH = prevPolicyEnv;
  rmSync(polDir, { recursive: true, force: true });
}

console.log(`\nTổng: ${passed} assertions PASS`);
