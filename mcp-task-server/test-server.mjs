#!/usr/bin/env node
/**
 * Test MCP Task Server: pure logic (state machine, repo parsing) + protocol e2e
 * (spawn server thật, handshake NDJSON, tools/list, tools/call read-only + negative fail-closed).
 * Chạy: node mcp-task-server/test-server.mjs  (yêu cầu `gh` đã đăng nhập)
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkTransition, extractStatus, parseRepos, validateRepo, validateRef, buildListArgs } from "./server.mjs";

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

// ---------------------------------------------------------------------------
// 3) Protocol e2e — spawn server thật qua stdio
// ---------------------------------------------------------------------------
console.log("[3] Protocol e2e (stdio NDJSON)");
const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
  env: { ...process.env, MCP_TASK_REPOS: REPO },
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

  // Repo bẩn bị chặn bởi validateRepo
  const badRepo = await rpc("tools/call", { name: "task_get", arguments: { repo: "../evil", number: 1 } });
  ok(badRepo.result?.isError === true, "repo dạng bẩn → isError (chống injection)");

  // Method lạ → -32601
  const unknown = await rpc("resources/list", {});
  ok(unknown.error?.code === -32601, "method lạ trả -32601 Method not found");
} finally {
  child.stdin.end();
  child.kill();
}

console.log(`\nTổng: ${passed} assertions PASS`);
