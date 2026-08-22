#!/usr/bin/env node
/**
 * MCP Task Server — điều phối vòng lặp Coder ↔ Reviewer đa repo qua GitHub Issues.
 *
 * Zero-dependency: MCP stdio transport (NDJSON JSON-RPC 2.0) + `gh` CLI.
 * Nguồn sự thật: GitHub Issues/PR theo docs/AGENT_HANDOFF_PROTOCOL.md (label agent:* / status:*).
 *
 * Env: MCP_TASK_REPOS="owner/repo1,owner/repo2" (mặc định: origin của CWD).
 * Chạy: node mcp-task-server/server.mjs
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SERVER_INFO = { name: "mcp-task-server", version: "1.0.0" };

// ---------------------------------------------------------------------------
// State machine (khớp docs/AGENT_HANDOFF_PROTOCOL.md §4)
// ---------------------------------------------------------------------------
export const TRANSITIONS = {
  claim: { from: ["ready-for-cline", "queued"], to: "in-progress", agent: "cline" },
  handoff: { from: ["in-progress", "changes-requested"], to: "review-requested", agent: "gpt" },
  approve: { from: ["review-requested"], to: "approved", agent: "gpt" },
  requestChanges: { from: ["review-requested"], to: "changes-requested", agent: "cline" },
  block: { from: "*", to: "blocked", agent: null },
};

/** Trả về status hiện tại từ danh sách label (chỉ 1 status:* hợp lệ tại một thời điểm). */
export function extractStatus(labels) {
  return (labels ?? []).find((l) => l.startsWith("status:"))?.slice("status:".length) ?? null;
}

/** Kiểm tra chuyển trạng thái; trả { ok, to, agent } hoặc { ok: false, error }. */
export function checkTransition(action, currentStatus) {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, error: `Hành động không hợp lệ: ${action}` };
  const from = t.from === "*" ? (currentStatus ? [currentStatus] : []) : t.from;
  if (!from.includes(currentStatus)) {
    return {
      ok: false,
      error: `Chuyển trạng thái không hợp lệ: ${action} yêu cầu status thuộc [${from.join(", ")}], hiện tại là '${currentStatus ?? "(không có)"}'`,
    };
  }
  return { ok: true, to: t.to, agent: t.agent };
}

// ---------------------------------------------------------------------------
// Repo config & validation
// ---------------------------------------------------------------------------
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateRepo(repo) {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    throw new Error(`Repo không hợp lệ: '${repo}' (dạng mong đợi: owner/name)`);
  }
  return repo;
}

export function parseRepos(envValue) {
  return (envValue ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(validateRepo);
}

/** Danh sách repo mặc định: env MCP_TASK_REPOS, fallback origin của CWD. */
export function defaultRepos(env = process.env, cwd = process.cwd()) {
  const fromEnv = parseRepos(env.MCP_TASK_REPOS);
  if (fromEnv.length > 0) return fromEnv;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      cwd,
      windowsHide: true,
      timeout: 10_000,
    }).trim();
    const m = url.match(/[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (m) return [`${m[1]}/${m[2]}`];
  } catch {
    /* không có git origin → trả rỗng */
  }
  return [];
}

// ---------------------------------------------------------------------------
// gh CLI wrapper (execFileSync, args dạng mảng — không shell, chống injection)
// ---------------------------------------------------------------------------
function gh(args, { repo, cwd } = {}) {
  const full = repo ? [...args, "-R", validateRepo(repo)] : [...args];
  try {
    return execFileSync("gh", full, {
      encoding: "utf8",
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (err) {
    const stderr = (err.stderr ?? err.message ?? "").toString().trim().slice(0, 500);
    throw new Error(`gh ${args.join(" ")} thất bại: ${stderr || err.code || "unknown"}`);
  }
}

function ensureLabel(repo, name, color = "0e8a16") {
  try {
    gh(["label", "create", name, "--color", color, "--force"], { repo });
  } catch {
    /* đã tồn tại hoặc không đủ quyền — bỏ qua */
  }
}

async function listLabels(repo, number) {
  const issue = JSON.parse(gh(["issue", "view", String(number), "--json", "labels"], { repo }));
  return issue.labels.map((l) => l.name);
}

/** Đặt status mới (+ agent) cho Issue: gỡ mọi label status/agent cũ, gắn nhãn mới. */
async function setStatus(repo, number, toStatus, toAgent) {
  ensureLabel(repo, `status:${toStatus}`);
  if (toAgent) ensureLabel(repo, `agent:${toAgent}`, toAgent === "cline" ? "1d76db" : "d93f0b");
  const current = await listLabels(repo, number);
  const remove = current.filter(
    (l) =>
      l.startsWith("status:") ||
      (toAgent && l.startsWith("agent:") && l !== `agent:${toAgent}`),
  );
  const add = [`status:${toStatus}`, ...(toAgent ? [`agent:${toAgent}`] : [])]
    .filter((l) => !current.includes(l));
  if (remove.length === 0 && add.length === 0) return current;
  const args = ["issue", "edit", String(number)];
  for (const l of remove) args.push("--remove-label", l);
  for (const l of add) args.push("--add-label", l);
  gh(args, { repo });
  return listLabels(repo, number);
}

// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------
const TASK_LABEL_RE = /^(agent|status):/;

function summarize(repo, issue) {
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
  return {
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    agent: labels.find((l) => l.startsWith("agent:")) ?? null,
    status: extractStatus(labels),
    labels,
  };
}

export const ops = {
  async task_list({ repo, repos } = {}) {
    const targets = repo ? [validateRepo(repo)] : (repos?.length ? repos : defaultRepos());
    if (targets.length === 0) {
      throw new Error("Chưa xác định repo: truyền 'repo', 'repos' hoặc đặt env MCP_TASK_REPOS");
    }
    const out = [];
    for (const r of targets) {
      const issues = JSON.parse(
        gh(["issue", "list", "--state", "open", "--limit", "100",
            "--json", "number,title,labels,url"], { repo: r }),
      );
      for (const i of issues) {
        if (i.labels.some((l) => TASK_LABEL_RE.test(l.name))) out.push(summarize(r, i));
      }
    }
    return { tasks: out, count: out.length };
  },

  async task_get({ repo, number }) {
    if (!Number.isInteger(number) || number <= 0) throw new Error("'number' phải là số nguyên dương");
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    const raw = gh(["issue", "view", String(number), "--json",
      "number,title,body,state,labels,url"], { repo: r });
    return summarize(r, JSON.parse(raw));
  },

  async task_create({ repo, title, body = "", agent = "cline", queued = false }) {
    if (!title || typeof title !== "string") throw new Error("'title' là bắt buộc");
    if (!["cline", "gpt"].includes(agent)) throw new Error("'agent' phải là 'cline' hoặc 'gpt'");
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    const status = queued ? "queued" : `ready-for-${agent}`;
    ensureLabel(r, `agent:${agent}`, agent === "cline" ? "1d76db" : "d93f0b");
    ensureLabel(r, `status:${status}`);
    const url = gh(["issue", "create", "--title", title, "--body", String(body),
      "--label", `agent:${agent}`, "--label", `status:${status}`], { repo: r }).trim();
    const number = Number(url.match(/\/issues\/(\d+)$/)?.[1]);
    return { repo: r, number, url, agent: `agent:${agent}`, status: `status:${status}` };
  },

  async task_claim({ repo, number }) {
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    const current = await listLabels(r, number);
    const check = checkTransition("claim", extractStatus(current));
    if (!check.ok) throw new Error(check.error);
    const labels = await setStatus(r, number, check.to, check.agent);
    return { repo: r, number, status: `status:${check.to}`, labels };
  },

  async task_handoff({ repo, number, pr }) {
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    const current = await listLabels(r, number);
    const check = checkTransition("handoff", extractStatus(current));
    if (!check.ok) throw new Error(check.error);
    const labels = await setStatus(r, number, check.to, check.agent);
    if (pr) {
      gh(["issue", "comment", String(number), "--body",
        `Bàn giao review: PR #${pr}. Labels: agent:gpt + status:review-requested.`], { repo: r });
    }
    return { repo: r, number, status: `status:${check.to}`, labels, pr: pr ?? null };
  },

  async task_review({ repo, number, verdict, comment }) {
    if (!["approve", "request-changes"].includes(verdict)) {
      throw new Error("'verdict' phải là 'approve' hoặc 'request-changes'");
    }
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    const current = await listLabels(r, number);
    const check = checkTransition(verdict === "approve" ? "approve" : "requestChanges",
      extractStatus(current));
    if (!check.ok) throw new Error(check.error);
    if (comment) {
      gh(["issue", "comment", String(number), "--body", String(comment)], { repo: r });
    }
    const labels = await setStatus(r, number, check.to, check.agent);
    return { repo: r, number, verdict, status: `status:${check.to}`, labels };
  },

  async task_block({ repo, number, reason }) {
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    if (reason) {
      gh(["issue", "comment", String(number), "--body", `BLOCKED: ${reason}`], { repo: r });
    }
    const labels = await setStatus(r, number, "blocked", null);
    return { repo: r, number, status: "status:blocked", labels };
  },
};

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema thuần — không cần zod)
// ---------------------------------------------------------------------------
const repoProp = { type: "string", description: "Repo dạng owner/name. Bỏ qua → env MCP_TASK_REPOS / origin CWD" };
const numberProp = { type: "number", description: "Số Issue" };

export const TOOLS = [
  { name: "task_list", description: "Liệt kê task (Issue có label agent:*/status:*) trên một hoặc nhiều repo",
    inputSchema: { type: "object", properties: { repo: repoProp,
      repos: { type: "array", items: { type: "string" }, description: "Nhiều repo cho 1 lần liệt kê" } } } },
  { name: "task_get", description: "Xem chi tiết một task Issue",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp }, required: ["number"] } },
  { name: "task_create", description: "Tạo Issue task mới (mặc định agent:cline + status:ready-for-cline)",
    inputSchema: { type: "object", properties: { repo: repoProp, title: { type: "string" },
      body: { type: "string" }, agent: { type: "string", enum: ["cline", "gpt"] },
      queued: { type: "boolean", description: "true → status:queued thay vì ready-for-cline" } },
      required: ["title"] } },
  { name: "task_claim", description: "Coder nhận task: ready-for-cline/queued → in-progress",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp }, required: ["number"] } },
  { name: "task_handoff", description: "Coder bàn giao: in-progress/changes-requested → review-requested + agent:gpt",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp,
      pr: { type: "number", description: "Số PR bàn giao (tùy chọn, sẽ comment lên Issue)" } }, required: ["number"] } },
  { name: "task_review", description: "Reviewer chấm: review-requested → approved | changes-requested (+agent:cline)",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp,
      verdict: { type: "string", enum: ["approve", "request-changes"] },
      comment: { type: "string", description: "Nhận xét/findings kèm theo" } },
      required: ["number", "verdict"] } },
  { name: "task_block", description: "Đánh dấu blocked (cần người dùng quyết định)",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp,
      reason: { type: "string" } }, required: ["number"] } },
];

// ---------------------------------------------------------------------------
// MCP stdio transport (NDJSON JSON-RPC 2.0)
// ---------------------------------------------------------------------------
function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function dispatch(name, args) {
  const op = ops[name];
  if (!op) throw new Error(`Tool không tồn tại: ${name}`);
  return op(args ?? {});
}

export async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === "initialize") {
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      } };
    }
    if (method.startsWith("notifications/")) return undefined;
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};
      try {
        return { jsonrpc: "2.0", id, result: textResult(await dispatch(name, args)) };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: textResult({ error: err.message }, true) };
      }
    }
    if (!isNotification) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    return undefined;
  } catch (err) {
    if (isNotification) return undefined;
    return { jsonrpc: "2.0", id, error: { code: -32603, message: err.message } };
  }
}

async function main() {
  process.stderr.write(`[${SERVER_INFO.name}] khởi động, repos=${JSON.stringify(defaultRepos())}\n`);
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      const res = await handleRequest(msg);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[${SERVER_INFO.name}] fatal: ${err.message}\n`);
    process.exit(1);
  });
}
