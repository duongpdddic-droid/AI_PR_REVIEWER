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
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateHandoff, canRequestReview, verifyHandoffIdentity, verifyPreviousReportRef, CONTRACT_VERSION, reportDigest, parseReviewComment, canonicalActiveFindings, sameFindingSet } from "../scripts/review-handoff-contract.mjs";
import { scanForSecrets, scanForAbsolutePaths } from "../scripts/project-registry.mjs";
import { loadRegistryRepos, resolveCanonicalRegistryPath } from "./soc-registry-consumer.mjs";

/**
 * GPT-REV-123: danh sách repo registered đọc từ canonical Soc_brain #17 Project Registry
 * (`~/.soc-brain/registry/projects.json` theo schema v1.0.0 hoặc env SOC_PROJECT_REGISTRY_PATH).
 * Read-only consumer — KHÔNG writer/migration/project-creation.
 *
 * Fail-closed: missing/malformed/unreadable/unsupported/split-brain → ok:false.
 * Server dùng `ok===false` → HANDOFF_REGISTRY_UNAVAILABLE TRƯỚC mọi mutation.
 * KHÔNG dùng `.agent/config.json` hoặc `~/.ai-pr-reviewer/registry.json` như canonical allowlist.
 */
export function loadRegisteredRepos({ registryPath = null, legacyPath = null } = {}) {
  const resolved = registryPath ?? resolveCanonicalRegistryPath();
  return loadRegistryRepos({ registryPath: resolved, legacyPath });
}

// buildReportComment — report canonical (GPT-REV-122): header bind contract version + exact HEAD
// + digest, thân chứa đầy đủ report JSON (lossless). Comment này là nguồn canonical để reviewer
// đối chiếu: stale HEAD / version / digest mismatch → không coi là handoff hiện hành.
export function buildReportComment(report, { headSha, digest, contractVersion }) {
  return [
    `[REVIEW-HANDOFF-REPORT v${contractVersion} @ ${headSha}]`,
    `digest: ${digest}`,
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
  ].join("\n");
}

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

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Validate tên nhánh/ref cho `gh pr create` (chặn flag injection kiểu `-R`, `--head`, path traversal `..`). */
export function validateRef(ref) {
  if (typeof ref !== "string" || !REF_RE.test(ref) || ref.startsWith("-") || ref.includes("..")) {
    throw new Error(`Ref không hợp lệ: '${ref}'`);
  }
  return ref;
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

/** Đặt status mới (+ agent) cho Issue: gỡ mọi label status/agent cũ, gắn nhãn mới.
 *  `expect`: danh sách status hợp lệ tại thời điểm này (re-check chống race giữa 2 gh call).
 *  Nếu trạng thái đã đổi ngoài `expect` → fail-closed, KHÔNG mutation. */
async function setStatus(repo, number, toStatus, toAgent, expect) {
  ensureLabel(repo, `status:${toStatus}`);
  if (toAgent) ensureLabel(repo, `agent:${toAgent}`, toAgent === "cline" ? "1d76db" : "d93f0b");
  const current = await listLabels(repo, number);
  const cur = extractStatus(current);
  if (expect && !expect.includes(cur)) {
    throw new Error(
      `Trạng thái đã đổi khi đang xử lý: mong đợi [${expect.join(", ")}], hiện tại '${cur ?? "(không có)"}' — không mutation`,
    );
  }
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

/** Dựng args cho `gh issue list` (lọc server-side status/agent/state/limit). */
export function buildListArgs({ state = "open", status, agent, limit = 100 } = {}) {
  if (!["open", "closed", "all"].includes(state)) {
    throw new Error("'state' phải là 'open' | 'closed' | 'all'");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("'limit' phải là số nguyên 1..1000");
  }
  const args = ["issue", "list", "--state", state, "--limit", String(limit),
    "--json", "number,title,labels,url"];
  if (status) args.push("--label", `status:${status}`);
  if (agent) args.push("--label", `agent:${agent}`);
  return args;
}

// ---------------------------------------------------------------------------
// GPT-REV-125 — derive authoritative finding set từ canonical review state.
// Authority = allowlist reviewer principal từ policy approvalAuthorities (không hard-code login).
// Reader review-state: test-only fixture env (AI_PR_REVIEWER_FIXTURE_REVIEW_STATE) hoặc gh thật.
// Fail-closed: policy missing / review-state unreadable / ambiguous → từ chối task_handoff trước mutation.
// ---------------------------------------------------------------------------
export const REVIEWER_POLICY_FILE = ".github/ai-review-policy.json";

/** Canonical reviewer policy path — module-anchored (KHÔNG process.cwd, KHÔNG env override).
 *  Nguồn sự thật: chính AI_PR_REVIEWER repo (.github/ai-review-policy.json). */
export function canonicalPolicyPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", REVIEWER_POLICY_FILE);
}

/**
 * Resolve deterministic đường dẫn tới canonical reviewer policy.
 * KHÔNG BAO GIỜ dùng `process.cwd()` — fix blocker Soc_brain Issue #35 / PR #36: trước đây
 * resolve theo cwd của tiến trình MCP (khi Cline bắn server với cwd = nơi cài VS Code) nên đọc nhầm
 * `<cwd>/.github/ai-review-policy.json` ở nơi không có → HANDOFF_FINDINGS_AUTHORITY_UNAVAILABLE.
 *
 * GPT-REV-128: policy trust root là canonical module-relative (server-controlled); caller (MCP client)
 * KHÔNG chọn/override được. `policyRoot` chỉ là DI cho tests (được validate fail-closed ở load).
 * KHÔNG còn fallback env `AI_PR_POLICY_PATH` (bỏ để không cho caller chọn nguồn policy).
 */
export function resolvePolicyAuthorityPath({ policyRoot = null } = {}) {
  if (policyRoot) return path.resolve(policyRoot, REVIEWER_POLICY_FILE);
  return canonicalPolicyPath();
}

/**
 * Đọc + validate canonical reviewer policy, fail-closed TRƯỚC mọi mutation (GPT-REV-128).
 * - Missing file → POLICY_MISSING; unparseable → POLICY_INVALID_JSON; shape sai → POLICY_SCHEMA_INVALID.
 * - Split-brain (policyRoot ≠ canonical, khác digest) → POLICY_SPLIT_BRAIN.
 * - Bind repository: `expectedRepo` phải nằm trong policy.scope.appliesTo → POLICY_REPO_MISMATCH.
 * - Bind version/digest: `expectedVersion`/`expectedDigest` (nếu truyền) phải khớp → *_MISMATCH.
 * - `requireVersion` (production) bắt buộc policy có `policyVersion` → POLICY_VERSION_MISSING.
 * Trả { ok:true, gpt, local, policyVersion, digest, path } hoặc { ok:false, errors }.
 */
export function loadPolicyAuthority({ policyRoot = null, expectedRepo = null, expectedVersion = null, expectedDigest = null, requireVersion = false, compareCanonical = false } = {}) {
  const pAbs = path.resolve(resolvePolicyAuthorityPath({ policyRoot }));
  const canonical = path.resolve(canonicalPolicyPath());
  const sha256 = (b) => createHash("sha256").update(b).digest("hex");
  // Split-brain (chỉ khi `compareCanonical` — DI chủ động so với canonical): policyRoot được cấp khác
  // canonical VÀ canonical tồn tại với nội dung khác → fail-closed. Production không bao giờ đặt
  // policyRoot → split-brain không áp dụng (chỉ 1 nguồn policy).
  if (policyRoot && pAbs !== canonical && compareCanonical && existsSync(canonical)) {
    let altBuf = null, canonBuf = null;
    try { altBuf = readFileSync(pAbs); } catch { /* alt missing → không split-brain */ }
    try { canonBuf = readFileSync(canonical); } catch { /* canonical unreadable → xử lý ở bước đọc */ }
    if (altBuf && canonBuf && sha256(altBuf) !== sha256(canonBuf)) {
      return { ok: false, errors: [{ code: 'POLICY_SPLIT_BRAIN', path: pAbs, message: 'Phát hiện 2 nguồn policy authority khác digest (canonical vs injected) → fail-closed' }] };
    }
  }
  let buf;
  try { buf = readFileSync(pAbs); }
  catch (err) { return { ok: false, errors: [{ code: 'POLICY_MISSING', path: pAbs, message: `Không đọc được policy tại ${pAbs}: ${err.message}` }] }; }
  let pol;
  try { pol = JSON.parse(buf.toString("utf8")); }
  catch (err) { return { ok: false, errors: [{ code: 'POLICY_INVALID_JSON', path: pAbs, message: `policy JSON không parse được tại ${pAbs}: ${err.message}` }] }; }
  const aa = pol && pol.approvalAuthorities;
  if (!aa || !Array.isArray(aa.gptApprovalCommentAuthors) || !Array.isArray(aa.localApprovalCommentAuthors)) {
    return { ok: false, errors: [{ code: 'POLICY_SCHEMA_INVALID', path: pAbs, message: 'policy.approvalAuthorities thiếu gptApprovalCommentAuthors/localApprovalCommentAuthors (fail-closed)' }] };
  }
  const digest = sha256(buf);
  // Bind repository: repo đích phải thuộc policy.scope.appliesTo.
  if (expectedRepo) {
    const applies = pol.scope && pol.scope.appliesTo;
    if (!Array.isArray(applies) || applies.length === 0) {
      return { ok: false, errors: [{ code: 'POLICY_REPO_MISMATCH', path: pAbs, message: `policy thiếu scope.appliesTo hợp lệ để bind repo ${expectedRepo} → fail-closed` }] };
    }
    if (!applies.includes(expectedRepo)) {
      return { ok: false, errors: [{ code: 'POLICY_REPO_MISMATCH', path: pAbs, message: `policy không áp dụng cho repo ${expectedRepo} (scope.appliesTo=${JSON.stringify(applies)}) → fail-closed` }] };
    }
  }
  // Bind version: production bắt buộc policyVersion; nếu caller pin version thì phải khớp.
  if (requireVersion && (typeof pol.policyVersion !== 'string' || pol.policyVersion.length === 0)) {
    return { ok: false, errors: [{ code: 'POLICY_VERSION_MISSING', path: pAbs, message: 'policy thiếu policyVersion → fail-closed (không đủ thông tin bind version/digest)' }] };
  }
  if (expectedVersion && expectedVersion !== pol.policyVersion) {
    return { ok: false, errors: [{ code: 'POLICY_VERSION_MISMATCH', path: pAbs, message: `pinned version ${expectedVersion} != policy ${pol.policyVersion}` }] };
  }
  if (expectedDigest && expectedDigest !== digest) {
    return { ok: false, errors: [{ code: 'POLICY_DIGEST_MISMATCH', path: pAbs, message: `digest ${digest} != expected ${expectedDigest} → fail-closed` }] };
  }
  return { ok: true, gpt: aa.gptApprovalCommentAuthors, local: aa.localApprovalCommentAuthors, policyVersion: pol.policyVersion ?? null, digest, path: pAbs };
}

export function resolveReviewState(repo, pr) {
  // Test-only fixture (JSON array of { author, body, ts }) — không dùng trong production.
  const fixture = process.env.AI_PR_REVIEWER_FIXTURE_REVIEW_STATE;
  if (fixture) {
    try {
      const arr = JSON.parse(fixture);
      if (!Array.isArray(arr)) return { ok: false, errors: ["fixture review-state không phải array"] };
      return {
        ok: true,
        comments: arr.map((c) => ({
          id: c.id ?? null,
          author: c.author ?? null,
          body: String(c.body ?? ""),
          ts: c.ts ?? null,
        })),
      };
    } catch (err) {
      return { ok: false, errors: [`fixture review-state parse: ${err.message}`] };
    }
  }
  try {
    const raw = gh(["api", `repos/${validateRepo(repo)}/issues/${pr}/comments`]);
    const arr = JSON.parse(raw);
    return {
      ok: true,
      comments: arr.map((c) => ({
        id: c.id ?? null,
        author: c.user?.login ?? null,
        body: c.body ?? "",
        ts: c.created_at ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

// Ghép resolveReviewState + parseReviewComment + canonicalActiveFindings → authoritative set
// (hoặc fail-closed nếu review-state unreadable / authority thiếu / finding ID unknown).
// GPT-REV-129: `reader` injectable (test-only) — production dùng reader=null → resolveReviewState.
export function deriveAuthoritativeFindings(repo, pr, { authority = null, reader = null } = {}) {
  let st;
  try {
    st = typeof reader === "function" ? reader(repo, pr) : resolveReviewState(repo, pr);
  } catch (err) {
    return { ok: false, findings: [], errors: [{ code: 'REVIEW_STATE_READER_FAILED', message: `reader review-state thất bại (API error/injection): ${err.message}` }] };
  }
  if (!st || st.ok !== true) return { ok: false, findings: [], errors: (st && st.errors) || [{ code: 'REVIEW_STATE_UNREADABLE' }] };
  if (!Array.isArray(st.comments)) return { ok: false, findings: [], errors: [{ code: 'REVIEW_STATE_MALFORMED', message: 'review-state trả comments không phải mảng' }] };
  const entries = st.comments.flatMap((c) => parseReviewComment(c.body, { author: c.author, ts: c.ts, commentId: c.id }).findings);
  return canonicalActiveFindings(entries, { authority });
}

export const ops = {
  async task_list({ repo, repos, state, status, agent, limit } = {}) {
    const targets = repo ? [validateRepo(repo)] : (repos?.length ? repos : defaultRepos());
    if (targets.length === 0) {
      throw new Error("Chưa xác định repo: truyền 'repo', 'repos' hoặc đặt env MCP_TASK_REPOS");
    }
    const listArgs = buildListArgs({ state, status, agent, limit });
    const out = [];
    for (const r of targets) {
      const issues = JSON.parse(gh(listArgs, { repo: r }));
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
    const labels = await setStatus(r, number, check.to, check.agent, TRANSITIONS.claim.from);
    return { repo: r, number, status: `status:${check.to}`, labels };
  },

  async task_handoff({ repo, number, pr, handoffReport, expectedFindings = null }) {
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    // GPT-REV-115: handoffReport BẮT BUỘC — thiếu → fail-closed TRƯỚC mọi mutation.
    if (handoffReport === undefined || handoffReport === null) {
      throw new Error("HANDOFF_REPORT_REQUIRED: task_handoff sang review-requested bắt buộc kèm handoffReport theo canonical REVIEW HANDOFF CONTRACT (Issue #32)");
    }
    // GPT-REV-119: registered repos từ Project Registry canonical (machine-local).
    // Registry missing/unreadable/malformed/mismatch-config → fail-closed TRƯỚC mọi mutation.
    const reg = loadRegisteredRepos();
    if (reg.ok !== true) {
      throw new Error(`HANDOFF_REGISTRY_UNAVAILABLE: ${reg.errors.join("; ")}`);
    }
    // GPT-REV-124 — resolver previous report (incremental chain): đọc comment report trước đó
    // theo previousReportRef.repo/commentId, parse JSON từ block ```json. Unresolved → { resolved:false }
    // → validateHandoff fail-closed (PREVIOUS_REPORT_UNRESOLVED) nếu report khai incremental ref.
    const resolvePreviousReport = (ref) => {
      try {
        const raw = gh(["api", `repos/${validateRepo(ref.repo)}/issues/comments/${ref.commentId}`]);
        const c = JSON.parse(raw);
        const m = c.body && c.body.match(/```json\n([\s\S]*?)\n```/);
        if (!m) return { resolved: false };
        return { resolved: true, report: JSON.parse(m[1]) };
      } catch {
        return { resolved: false };
      }
    };
    // GPT-REV-118: identity binding với dữ liệu SERVER kiểm soát, fail-closed TRƯỚC mutation.
    // PR bắt buộc (thiếu → không thể bind PR HEAD).
    if (pr === undefined || pr === null) {
      throw new Error("HANDOFF_PR_REQUIRED: task_handoff sang review-requested bắt buộc kèm pr để bind identity (repository/issue/pullRequest/headSha)");
    }
    // So khớp repo/issue/pullRequest với args server nhận (không phải caller tự khai).
    const idv = verifyHandoffIdentity(handoffReport, { repo: r, number, pr, checkHead: false });
    if (idv.ok !== true) {
      throw new Error(`HANDOFF_IDENTITY_MISMATCH: ${JSON.stringify(idv.errors)}`);
    }
    // Đọc exact PR HEAD từ nguồn tin cậy (gh pr view) — fail-closed nếu không đọc được.
    let prHeadSha = null;
    // GPT-REV-129: test-only fixture env AI_PR_REVIEWER_FIXTURE_PR_HEAD — bỏ dependency live PR #47
    // + hard-coded remote HEAD khỏi test. Có thể là string (áp dụng mọi PR) hoặc JSON map {pr: head}.
    // KHÔNG dùng trong production.
    const fxPrHead = process.env.AI_PR_REVIEWER_FIXTURE_PR_HEAD;
    let fxMapped = null;
    if (fxPrHead) {
      let fx;
      try { fx = JSON.parse(fxPrHead); } catch { fx = fxPrHead; }
      fxMapped = fx && typeof fx === "object" && !Array.isArray(fx) ? fx[String(pr)] : fx;
    }
    if (fxMapped) {
      prHeadSha = fxMapped;
    } else {
      try {
        const prJson = JSON.parse(gh(["pr", "view", String(pr), "--json", "headRefOid"], { repo: r }));
        prHeadSha = prJson?.headRefOid ?? null;
      } catch (err) {
        throw new Error(`HANDOFF_PR_HEAD_READ_FAILED: không đọc được exact PR HEAD #${pr} — ${err.message}`);
      }
    }
    // So khớp headSha với exact PR HEAD (chống stale HEAD / random 40-hex / replay).
    const hv = verifyHandoffIdentity(handoffReport, { repo: r, number, pr, prHeadSha });
    if (hv.ok !== true) {
      throw new Error(`HANDOFF_IDENTITY_MISMATCH: ${JSON.stringify(hv.errors)}`);
    }
    // GPT-REV-125 — derive authoritative finding set cho exact repo/PR/HEAD từ canonical review state
    // (structured reviewer markers + reviewer-authority allowlist từ policy approvalAuthorities), KHÔNG tin caller.
    // GPT-REV-128: bind repo + version/digest — policy thiếu/bỏ repo/khác version → fail-closed TRƯỚC mutation.
    const auth = loadPolicyAuthority({ expectedRepo: r, requireVersion: true });
    if (auth.ok !== true) {
      throw new Error(`HANDOFF_FINDINGS_AUTHORITY_UNAVAILABLE: ${auth.errors.join("; ")}`);
    }
    const derived = deriveAuthoritativeFindings(r, pr, { authority: auth });
    if (derived.ok !== true) {
      throw new Error(`HANDOFF_REVIEW_STATE_UNAVAILABLE: ${derived.errors.join("; ")} (review-state missing/unreadable/ambiguous → fail-closed)`);
    }
    const authoritativeFindings = derived.findings;
    // Caller expectedFindings (nếu có) chỉ là assertion: phải khớp TUYỆT ĐỐI authoritative set.
    if (Array.isArray(expectedFindings) && !sameFindingSet(expectedFindings, authoritativeFindings)) {
      throw new Error(`HANDOFF_FINDINGS_CALLER_MISMATCH: caller expectedFindings ${JSON.stringify(expectedFindings)} != derived authoritative ${JSON.stringify(authoritativeFindings)}`);
    }
    // GPT-REV-117: gate — chỉ report canRequestReview===true mới được transition;
    // BLOCKED / PARTIAL_EVIDENCE / invalid / exception đều chặn fail-closed.
    let v;
    try {
      v = validateHandoff(handoffReport, { registeredRepos: reg.repos, authoritativeFindings, resolvePreviousReport });
    } catch (err) {
      throw new Error(`HANDOFF_PARTIAL_EVIDENCE: report không hợp lệ (exception khi validate) — ${err.message}`);
    }
    if (canRequestReview(v) !== true) {
      throw new Error(`HANDOFF_PARTIAL_EVIDENCE: chỉ report READY_FOR_REVIEW (contract v${CONTRACT_VERSION}) mới được bàn giao. status=${v.status}, errors=${JSON.stringify(v.errors)}`);
    }
    // GPT-REV-122 — persist report canonical lên PR comment (bind version + exact HEAD + digest).
    // Scan secret / absolute machine path trong report → fail-closed TRƯỚC mọi mutation.
    // Persist fail → throw, KHÔNG đổi label (không để review-requested mà thiếu report canonical).
    const digest = reportDigest(handoffReport);
    const secHits = scanForSecrets(handoffReport);
    const absHits = scanForAbsolutePaths(handoffReport);
    if (secHits.length > 0 || absHits.length > 0) {
      throw new Error(`HANDOFF_REPORT_LEAK: report chứa ${secHits.length} secret / ${absHits.length} absolute machine path → từ chối persist`);
    }
    // Transition hợp lệ phải được xác nhận TRƯỚC khi persist report (tránh comment mồ côi).
    const current = await listLabels(r, number);
    const check = checkTransition("handoff", extractStatus(current));
    if (!check.ok) throw new Error(check.error);
    const reportBody = buildReportComment(handoffReport, { headSha: prHeadSha, digest, contractVersion: CONTRACT_VERSION });
    let reportUrl = null;
    let reportCommentId = null;
    try {
      reportUrl = gh(["pr", "comment", String(pr), "--body", reportBody], { repo: r }).trim();
      const cm = reportUrl.match(/#issuecomment-(\d+)/);
      reportCommentId = cm ? cm[1] : null;
    } catch (err) {
      throw new Error(`HANDOFF_REPORT_PERSIST_FAILED: không persist được report canonical lên PR #${pr} — ${err.message}`);
    }
    const labels = await setStatus(r, number, check.to, check.agent, TRANSITIONS.handoff.from);
    if (pr) {
      gh(["issue", "comment", String(number), "--body",
        `Bàn giao review: PR #${pr}. Labels: agent:gpt + status:review-requested.`], { repo: r });
    }
    return {
      repo: r,
      number,
      pr,
      headSha: prHeadSha,
      contractVersion: CONTRACT_VERSION,
      terminalStatus: v.status,
      reportCommentId,
      reportUrl,
      reportDigest: digest,
      status: `status:${check.to}`,
      labels,
    };
  },

  async task_review({ repo, number, verdict, comment }) {
    if (!["approve", "request-changes"].includes(verdict)) {
      throw new Error("'verdict' phải là 'approve' hoặc 'request-changes'");
    }
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    const current = await listLabels(r, number);
    const action = verdict === "approve" ? "approve" : "requestChanges";
    const check = checkTransition(action, extractStatus(current));
    if (!check.ok) throw new Error(check.error);
    if (comment) {
      gh(["issue", "comment", String(number), "--body", String(comment)], { repo: r });
    }
    const labels = await setStatus(r, number, check.to, check.agent, TRANSITIONS[action].from);
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

  async task_comment({ repo, number, body }) {
    if (!Number.isInteger(number) || number <= 0) throw new Error("'number' phải là số nguyên dương");
    if (!body || typeof body !== "string") throw new Error("'body' là bắt buộc");
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    gh(["issue", "comment", String(number), "--body", String(body)], { repo: r });
    return { repo: r, number, commented: true };
  },

  async task_pr({ repo, number, head, base = "main", title, body }) {
    if (!Number.isInteger(number) || number <= 0) throw new Error("'number' phải là số nguyên dương");
    if (!head || typeof head !== "string") throw new Error("'head' là bắt buộc (tên nhánh coder)");
    validateRef(head);
    validateRef(base);
    const r = repo ?? defaultRepos()[0];
    if (!r) throw new Error("Chưa xác định repo");
    const prTitle = title ?? `PR cho Issue #${number}`;
    const prBody = body ?? `Closes #${number}`;
    const url = gh(["pr", "create", "--base", base, "--head", head,
      "--title", prTitle, "--body", prBody], { repo: r }).trim();
    const prNumber = Number(url.match(/\/pull\/(\d+)$/)?.[1]);
    gh(["issue", "comment", String(number), "--body",
      `Bàn giao review: PR #${prNumber ?? "?"}.`], { repo: r });
    return { repo: r, number, pr: prNumber ?? null, url };
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
      repos: { type: "array", items: { type: "string" }, description: "Nhiều repo cho 1 lần liệt kê" },
      state: { type: "string", enum: ["open", "closed", "all"], description: "Trạng thái Issue (mặc định open)" },
      status: { type: "string", description: "Lọc theo status:* (vd: ready-for-cline)" },
      agent: { type: "string", enum: ["cline", "gpt"], description: "Lọc theo agent:*" },
      limit: { type: "number", description: "Số task tối đa (1..1000, mặc định 100)" } } } },
  { name: "task_get", description: "Xem chi tiết một task Issue",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp }, required: ["number"] } },
  { name: "task_create", description: "Tạo Issue task mới (mặc định agent:cline + status:ready-for-cline)",
    inputSchema: { type: "object", properties: { repo: repoProp, title: { type: "string" },
      body: { type: "string" }, agent: { type: "string", enum: ["cline", "gpt"] },
      queued: { type: "boolean", description: "true → status:queued thay vì ready-for-cline" } },
      required: ["title"] } },
  { name: "task_claim", description: "Coder nhận task: ready-for-cline/queued → in-progress",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp }, required: ["number"] } },
  { name: "task_handoff", description: "Coder bàn giao: in-progress/changes-requested → review-requested + agent:gpt. BẮT BUỘC kèm handoffReport đạt READY_FOR_REVIEW theo canonical REVIEW HANDOFF CONTRACT (Issue #32); thiếu hoặc không hợp lệ → chặn fail-closed trước mọi mutation.",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp,
      pr: { type: "number", description: "Số PR bàn giao (tùy chọn, sẽ comment lên Issue)" },
      handoffReport: { type: "object", description: "Handoff report theo REVIEW HANDOFF CONTRACT v1.0.0 (bắt buộc, phải READY_FOR_REVIEW)" },
      expectedFindings: { type: "array", items: { type: "string" }, description: "Asserción ONLY (GPT-REV-125): nếu caller gửi, phải khớp TUYỆT ĐỐI set authoritative do server derive từ canonical review state; mismatch/subset/superset → fail-closed. Bỏ qua → server tự derive." } }, required: ["number", "handoffReport"] } },
  { name: "task_review", description: "Reviewer chấm: review-requested → approved | changes-requested (+agent:cline)",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp,
      verdict: { type: "string", enum: ["approve", "request-changes"] },
      comment: { type: "string", description: "Nhận xét/findings kèm theo" } },
      required: ["number", "verdict"] } },
  { name: "task_block", description: "Đánh dấu blocked (cần người dùng quyết định)",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp,
      reason: { type: "string" } }, required: ["number"] } },
  { name: "task_comment", description: "Thêm comment vào Issue task (tiến độ, ghi chú)",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp,
      body: { type: "string", description: "Nội dung comment" } }, required: ["number", "body"] } },
  { name: "task_pr", description: "Tạo Pull Request từ nhánh coder và liên kết Issue (Closes #N)",
    inputSchema: { type: "object", properties: { repo: repoProp, number: numberProp,
      head: { type: "string", description: "Nhánh nguồn (coder) — bắt buộc" },
      base: { type: "string", description: "Nhánh đích (mặc định main)" },
      title: { type: "string" }, body: { type: "string" } },
      required: ["number", "head"] } },
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
