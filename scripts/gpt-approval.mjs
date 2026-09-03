#!/usr/bin/env node
// gpt-approval.mjs — Cổng DUY NHẤT ghi nhận approval cuối của GPT lên PR (Issue #2 A3).
//
// USER-RELAY GATE (GPT-REV-032): script KHÔNG tự xác minh danh tính GPT — nó chỉ ghi nhận
// quyết định do NGƯỜI DÙNG relay qua lệnh này. Bắt buộc approval payload ràng buộc tuyệt đối:
// repository + prNumber + FULL HEAD SHA + policyVersion + decision ID.
// Thiếu/sai bất kỳ trường nào → từ chối, KHÔNG mutation. Không có code path tự động nào
// (orchestrator/pre-review) gọi gate này — chỉ người dùng chạy trực tiếp.
//
// THỨ TỰ MUTATION AN TOÀN (GPT-REV-033):
//   1. Kiểm tra toàn bộ preconditions (PR open, CI PASS, PRE_REVIEW_PASS tại HEAD, idempotent).
//   2. Xác thực payload khớp trạng thái thực tế của PR.
//   3. Đăng approval marker (khóa full HEAD SHA + policyVersion + decision ID) TRƯỚC.
//   4. Read-back comment xác nhận marker hợp lệ tại đúng HEAD.
//   5. SAU ĐÓ mới gỡ nhãn khác / gắn status:approved; mọi lệnh đều kiểm tra lỗi;
//      hỏng ở bước nào → phục hồi đảm bảo PR không bao giờ kết thúc ở approved thiếu marker.
//
// Usage:
//   node scripts/gpt-approval.mjs --repo owner/name --pr 12 \
//     --payload '{"repository":"owner/name","prNumber":12,"headSha":"<full40hex>","policyVersion":"2026-08-23.1","decisionId":"gpt-dec-001"}' \
//     [--note "trích quyết định GPT"]
//   node scripts/gpt-approval.mjs --repo owner/name --pr 12 --revoke "lý do"

// [GPT-REV-132] Bổ sung import os + realpathSync: hai ký hiệu này được dùng ở đâu đó trong
// file (expandHome os.homedir, realpathSync cho containment) nhưng thiếu import → ReferenceError
// trước mọi mutation khi chạy đường path thật. Test cũ pass vì các path đó không được exercise.
import { readFileSync, appendFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  AGENTS, LABELS, REVIEWER_LOCAL,
  buildApprovalMarker, canMutatePr, effectiveApproval, evaluateChecks,
  isApprovalValid, isManualApprovalValid, parseApprovalMarkers,
  validateApprovalPayload, computePolicyDigest,
  parseGptEvidenceArtifact, validateGptEvidenceBind, isReviewerAuthorized, validateManualActivationTarget,
} from './review-contract.mjs';
import { CANONICAL_PATH, CANONICAL_REPO, resolvePolicyForRepo } from './effective-policy.mjs';

// ---------------------------------------------------------------- IO adapter (DI cho test)

export function defaultIo() {
  function gh(args, { input } = {}) {
    const res = spawnSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...(input !== undefined ? { input: String(input) } : {}),
    });
    if (res.error || res.status !== 0) {
      throw new Error(`gh ${args.join(' ')} FAIL: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
    }
    return res.stdout;
  }
  return {
    getPrView(repo, number) {
      return JSON.parse(gh(['pr', 'view', String(number), '--repo', repo, '--json', 'state,headRefOid,labels']));
    },
    getPolicy(repo, ref, policySourceRef) {
      // [GPT-REV-042] Không còn legacy mirror: fail-closed qua resolvePolicyForRepo (throw).
      return resolvePolicyForRepo({
        repo,
        ref,
        // [GPT-REV-137] Canonical self-review: policy AUTHORITY từ server-resolved canonical
        // source commit, KHÔNG từ PR HEAD. policySourceRef (nếu truyền) hoặc resolve qua
        // resolveCanonicalSource() — tách bạch khỏi target PR.
        policySourceRef: policySourceRef || this.resolveCanonicalSource().sourceCommit,
        fetchContent: (r, p, rr) => {
          const b64 = gh(['api', `repos/${r}/contents/${p}?ref=${encodeURIComponent(rr)}`, '--jq', '.content']);
          return Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8');
        },
      }).policy;
    },
    // [GPT-REV-137] Resolve canonical policy source commit (server-controlled default branch),
    // TÁCH BIỆT khỏi target PR HEAD. Policy identity = canonical repo + default_branch, resolve
    // qua gh API để không tin caller/PR/process.cwd. Trả { repo, ref, sourceCommit, path }.
    resolveCanonicalSource() {
      const defaultBranch = String(gh(['api', `repos/${CANONICAL_REPO}`, '--jq', '.default_branch'])).trim();
      if (!defaultBranch || !/^[a-zA-Z0-9._-]+$/.test(defaultBranch)) {
        throw new Error('không resolve được canonical default_branch — fail-closed (GPT-REV-137).');
      }
      const sourceCommit = String(gh(['api', `repos/${CANONICAL_REPO}/commits/${defaultBranch}`, '--jq', '.sha'])).trim();
      if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
        throw new Error('canonical source commit không phải full 40-hex SHA — fail-closed (GPT-REV-137).');
      }
      return { repo: CANONICAL_REPO, ref: defaultBranch, sourceCommit, path: CANONICAL_PATH };
    },
    getChecks(repo, number) {
      return JSON.parse(gh(['pr', 'checks', String(number), '--repo', repo, '--json', 'name,state']));
    },
    listPrComments(repo, number) {
      // [CLINE-FIX-051] Trả comment RICH {id, user:{login}, created_at, body} — bản legacy
      // ([.[].body] join) làm mọi marker thiếu provenance → read-back approval luôn FAIL.
      const out = gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate',
        '--jq', `[.[] | ((.id // "") | tostring) + " " + ((.user.login) // "") + " " + ((.created_at) // "-") + " " + ((.body // "") | @base64)] | join("\\n")`]);
      return String(out || '').split('\n').filter(Boolean).map((line) => {
        const parts = line.split(' ');
        return {
          id: parts[0],
          user: { login: parts[1] },
          created_at: parts[2],
          body: Buffer.from(parts.slice(3).join(' '), 'base64').toString('utf8'),
        };
      });
    },
    postComment(repo, number, body) {
      return gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], { input: body });
    },
    addLabels(repo, number, labels) {
      gh(['pr', 'edit', String(number), '--repo', repo, '--add-label', labels.join(',')]);
    },
    removeLabels(repo, number, labels) {
      for (const l of labels) gh(['pr', 'edit', String(number), '--repo', repo, '--remove-label', l]);
    },
    getCurrentUser() {
      const out = gh(['api', 'user', '--jq', '.login']);
      return String(out || '').trim();
    },
    // [Issue #36] Fetch CI run details từ GitHub Actions API.
    // Trả {repository, headSha, conclusion, workflow} hoặc null nếu không tìm thấy / JSON rỗng.
    getCiRun(repo, runId) {
      let out;
      try {
        out = gh(['api', 'repos/' + repo + '/actions/runs/' + String(runId), '--jq',
          '{repository: .repository.full_name, headSha: .head_sha, status: .status, conclusion: .conclusion, workflow: .name, workflowId: (.workflow_id // 0)}']);
      } catch (e) {
        // 404 hoặc lỗi khác → coi như không tìm thấy CI run (fail-closed ở caller).
        return null;
      }
      const parsed = JSON.parse(out);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        repository: String(parsed.repository || ''),
        headSha: String(parsed.headSha || ''),
        status: String(parsed.status || ''),
        conclusion: String(parsed.conclusion || ''),
        workflow: String(parsed.workflow || ''),
        workflowId: Number(parsed.workflowId || 0),
      };
    },
    // [GPT-REV-134] Resolve canonical worktree identity/root từ GIT METADATA (không tin CLI).
    // Cwd là nơi người dùng chạy script — đó là Git metadata đáng tin (rev-parse --show-toplevel)
    // để suy ra worktree root canonical và đối chiếu remote origin với repo PR. CLI --worktree-root
    // (nếu còn) chỉ dùng cho diagnostics và bắt buộc khớp EXACT với root resolved — không dùng CLI
    // làm nguồn tin cậy. Fail-closed khi không realpath được root hoặc identity lệch repo.
    resolveGitRoot({ cwd, expectRepo } = {}) {
      const dir = String(cwd || process.cwd());
      const probe = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0 || !String(probe.stdout || '').trim()) {
        throw new Error('git rev-parse --show-toplevel FAIL tại "' + dir + '" — không xác định được worktree root canonical (GPT-REV-134).');
      }
      let root;
      try { root = realpathSync(String(probe.stdout).trim()); }
      catch {
        throw new Error('worktree root không realpath được — fail-closed, không suy đoán root theo path lexical (GPT-REV-134).');
      }
      if (expectRepo) {
        const origin = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
        if (origin.error || origin.status !== 0 || !String(origin.stdout || '').trim()) {
          throw new Error('git remote get-url origin FAIL — không xác định được worktree identity (GPT-REV-134).');
        }
        const norm = normalizeGithubRepo(String(origin.stdout || ''));
        if (!norm || norm !== String(expectRepo).toLowerCase()) {
          throw new Error('worktree identity mismatch: origin "' + norm + '" != PR repo "' + String(expectRepo) + '" (GPT-REV-134).');
        }
      }
      return root;
    },
    // [GPT-REV-128] Authoritative pre-review/gate/finding/dependency state tại exact HEAD.
    // [GPT-REV-133] KHÔNG còn derive từ text tự do trong comment. Chỉ parse MỘT artifact canonical
    // có provenance: HTML comment `ai-pr-reviewer:pre-review-artifact` mang structured JSON
    // {version, repository, prNumber, headSha, policyVersion, policyDigest, verdict, decisionGate,
    // failedGates, openBlockingFindings, dependencyBlocks}. Phải khớp: repo, PR, full HEAD,
    // policyVersion + policyDigest (chống artifact từ policy cũ/HEAD khác), và author comment
    // thuộc allowlist artifactAuthors. Không khớp → preReviewVerdict null → gate fail-closed.
    getGateState(repo, pr, headSha, expect = {}) {
      const view = this.getPrView(repo, pr);
      const names = labelNames(view);
      const blockingStatusLabels = names.filter((l) =>
        l === LABELS.blocked || l === LABELS.changesRequested || l === LABELS.queued || l === LABELS.inProgress);
      const comments = this.listPrComments(repo, pr);
      const hs = String(headSha || '').toLowerCase();
      const allow = Array.isArray(expect.artifactAuthors) ? expect.artifactAuthors.map(String) : [];
      const ARTIFACT_RE = /<!--\s*ai-pr-reviewer:pre-review-artifact:([^>]+)-->/g;
      let canonical = null;
      for (const c of comments) {
        const body = c && typeof c === 'object' && c.body != null ? String(c.body) : String(c || '');
        if (body.indexOf('ai-pr-reviewer:pre-review-artifact:') === -1) continue;
        // Nguồn có AUTHORITY: author comment phải thuộc allowlist. Comment từ account khác
        // (spoofed/bot lạ) → bỏ, không được cộng dồn vào gate state.
        const author = String(c && c.user && c.user.login || '');
        if (!allow.includes(author)) continue;
        let m;
        while ((m = ARTIFACT_RE.exec(body)) !== null) {
          let a;
          try { a = JSON.parse(m[1]); } catch { continue; } // JSON hỏng → bỏ, không tự suy diễn
          if (!a || typeof a !== 'object' || a.version !== 1) continue;
          if (String(a.repository || '') !== String(repo)) continue;
          if (Number(a.prNumber) !== Number(pr)) continue;
          // HEAD phải khớp EXACT (fuzzy → stale-head artifact vẫn match → hỏng). Duyệt tuần tự nên
          // artifact LỚN TUỔI hơn cho cùng HEAD sẽ ghi đè — giữ artifact MỚI NHẤT đúng HEAD.
          if (String(a.headSha || '').toLowerCase() !== hs) continue;
          if (expect.policyVersion && String(a.policyVersion || '') !== String(expect.policyVersion)) continue;
          if (expect.policyDigest && String(a.policyDigest || '').toLowerCase() !== String(expect.policyDigest).toLowerCase()) continue;
          if (a.verdict !== 'PRE_REVIEW_PASS' && a.verdict !== 'PRE_REVIEW_FINDINGS') continue;
          if (!Array.isArray(a.failedGates) || a.failedGates.some((g) => typeof g !== 'string')) continue;
          canonical = a;
        }
      }
      if (!canonical) {
        // Không có artifact canonical hợp lệ tại exact HEAD → fail-closed (không có gate state nào tin được).
        return { blockingStatusLabels, preReviewVerdict: null, openBlockingFindings: 0, dependencyBlocks: 0, failedGates: [] };
      }
      return {
        blockingStatusLabels,
        preReviewVerdict: canonical.verdict,
        openBlockingFindings: Number(canonical.openBlockingFindings || 0),
        dependencyBlocks: Number(canonical.dependencyBlocks || 0),
        failedGates: canonical.failedGates.map(String),
      };
    },
    // [Issue #36] Verify GPT evidence: fetch comment + check author ∈ gptApprovers +
    // body tham chiếu headSha + policyVersion. Trả {headSha, policyVersion} hoặc null.
    verifyGptEvidence(repo, pr, gptEvidence, { gptApprovers, gptAuthorities, headSha, policyVersion, actorSelf, policyDigest, decisionId }) {
      if (!gptEvidence || typeof gptEvidence !== 'object' || !gptEvidence.url || !gptEvidence.commentId) {
        throw new Error('gptEvidence phải là object {url, commentId}');
      }
      const urlRe = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)#issuecomment-(\d+)$/i;
      const um = urlRe.exec(String(gptEvidence.url));
      if (!um) throw new Error('URL không phải issuecomment URL canonical');
      const uOwner = um[1]; const uRepo = um[2]; const uNumber = um[3]; const uCommentId = um[4];
      if (uOwner + '/' + uRepo !== String(repo)) throw new Error('URL repo mismatch');
      if (Number(uNumber) !== Number(pr)) throw new Error('URL PR mismatch');
      if (uCommentId !== String(gptEvidence.commentId)) throw new Error('URL commentId mismatch');
      const comments = this.listPrComments(repo, pr);
      const match = comments.find((c) => String(c.id) === String(gptEvidence.commentId));
      if (!match) throw new Error('commentId không tồn tại trong PR comments');
      const author = String(match.user && match.user.login || '');
      if (!author) throw new Error('comment không có author login');
      // [Issue #38] Evidence artifact structured JSON — parse + exact-bind. Không còn phụ thuộc
      // regex mơ hồ; evidence phải bind repo/pr/head/policyVersion/policyDigest/decisionId.
      const parsed = parseGptEvidenceArtifact(match.body);
      if (!parsed) {
        throw new Error('GPT evidence body không chứa artifact JSON hợp lệ (<!-- ' + 'ai-pr-reviewer:gpt-evidence:' + '... -->)');
      }
      const bind = validateGptEvidenceBind(parsed, {
        repository: repo, prNumber: pr, headSha, policyVersion, policyDigest, decisionId,
      });
      if (!bind.ok) {
        throw new Error('GPT evidence bind không hợp lệ: ' + bind.error);
      }
      // [Issue #38] Reviewer authority: evidence phải do reviewer principal thuộc
      // reviewerAuthorityAllowlist đăng; KHÁC operator (self-author rejection); issuer khớp.
      const auth = isReviewerAuthorized({
        authorLogin: author, issuer: parsed.issuer, reviewerAuthorities: gptAuthorities, actorSelf,
      });
      if (!auth.ok) {
        throw new Error(auth.reason);
      }
      return {
        headSha: String(headSha).toLowerCase(),
        policyVersion: String(policyVersion),
        authorLogin: String(author),
        issuer: String(parsed.issuer),
        policyDigest: String(parsed.policyDigest),
        decisionId: String(parsed.decisionId),
        issuedAt: String(parsed.issuedAt),
        reviewDigest: String(parsed.reviewDigest),
      };
    },
    // [Issue #36] Read + parse operator ack file. Path phải ngoài worktree + ngoài memory-bank.
    // Trả {operator, reason, ackAt, issueRef} hoặc throw (invalid).
    readOperatorAck(ackPath, { worktreeRoot }) {
      if (!ackPath) throw new Error('operatorAckPath bắt buộc');
      // [GPT-REV-129] worktreeRoot BẮT BUỘC (không còn optional): thiếu → fail-closed.
      if (!worktreeRoot) throw new Error('worktreeRoot bắt buộc cho containment check — không tin path rời rạc (GPT-REV-129)');
      const absPath = path.resolve(String(ackPath));
      const wt = path.resolve(String(worktreeRoot));
      // [GPT-REV-134] Fail-closed realpath: nếu root/ack không realpath được → throw, không fallback lexical.
      // realExisting hỗ trợ ack path chưa tồn tại qua ancestor, nhưng không bao giờ bỏ qua symlink.
      const realWt = realExisting(wt);
      const rel = path.relative(realWt, realExisting(absPath));
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        throw new Error('operator ack file "' + absPath + '" nằm trong worktree (' + wt + ') — fail-closed');
      }
      const mbPath = path.join(realWt, 'memory-bank');
      const relMb = path.relative(mbPath, realExisting(absPath));
      if (!relMb.startsWith('..') && !path.isAbsolute(relMb)) {
        throw new Error('operator ack file "' + absPath + '" nằm trong memory-bank — fail-closed');
      }
      const content = readFileSync(absPath, 'utf8');
      const lines = String(content).split(/\r?\n/);
      const out = { operator: '', reason: '', ackAt: '', issueRef: '' };
      for (const line of lines) {
        const m = line.match(/^([A-Z_]+):\s*(.+)$/);
        if (!m) continue;
        const key = m[1]; const val = m[2].trim();
        if (key === 'OPERATOR') out.operator = val;
        else if (key === 'REASON') out.reason = val;
        else if (key === 'ACK_AT') out.ackAt = val;
        else if (key === 'ISSUE_REF') out.issueRef = val;
      }
      if (!out.operator) throw new Error('operator ack file thiếu OPERATOR');
      if (!out.reason) throw new Error('operator ack file thiếu REASON');
      if (!out.ackAt) throw new Error('operator ack file thiếu ACK_AT');
      if (!out.issueRef) throw new Error('operator ack file thiếu ISSUE_REF');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(out.ackAt)) {
        throw new Error('ACK_AT không phải ISO8601: ' + out.ackAt);
      }
      return out;
    },
    // [Issue #36] Append JSONL entry vào audit log. Fail-closed: throw nếu không ghi được.
    // [GPT-REV-129] Audit path phải đến từ policy manualException.auditLogPath/auditLogRoot
    // (không tin caller tự đặt path rời rạc); containment: dưới auditLogRoot, ngoài worktree,
    // ngoài memory-bank. [GPT-REV-130] Ghi audit TRƯỚC khi đăng marker (marker không bao giờ
    // tồn tại mà thiếu audit — orphan không xảy ra).
    appendAuditLog(logPath, entry) {
      if (!logPath) throw new Error('auditLogPath bắt buộc');
      const absPath = path.resolve(String(logPath));
      const dir = path.dirname(absPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(absPath, JSON.stringify(entry) + '\n', 'utf8');
    },
    // [GPT-REV-130] Read audit state: trả entry JSONL cuối cùng của audit log hoặc null.
    readAuditLog(logPath) {
      if (!logPath || !existsSync(String(logPath))) return null;
      const lines = String(readFileSync(String(logPath), 'utf8')).split(/\r?\n/).filter(Boolean);
      if (!lines.length) return null;
      try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
    },
    // [Issue #38] Đọc TOÀN BỘ audit entries (scan anti-replay/expiry), không chỉ entry cuối.
    readAuditEntries(logPath) {
      if (!logPath || !existsSync(String(logPath))) return [];
      const lines = String(readFileSync(String(logPath), 'utf8')).split(/\r?\n/).filter(Boolean);
      const out = [];
      for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* bỏ qua entry hỏng */ } }
      return out;
    },
    log(level, msg) { console.error(`[${level}] ${msg}`); },
  };
}

// ---------------------------------------------------------------- helpers

function labelNames(view) {
  return (view.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

// [GPT-REV-134] Chuẩn hóa remote URL GitHub gh -> "owner/name" (lowercase) để so sánh identity
// worktree với repo PR. Hỗ trợ cả https://github.com/owner/name(.git) và git@github.com:owner/name(.git).
function normalizeGithubRepo(url) {
  const s = String(url || '').trim().replace(/\.git$/i, '');
  const m = s.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i) || s.match(/^([^/]+)\/([^/#?]+)$/);
  return m ? (m[1] + '/' + m[2]).toLowerCase() : '';
}

// [GPT-REV-132][GPT-REV-134] realpath của "ancestor tồn tại gần nhất" + nối lại phần dư.
// Khác `real` cũ (fail-soft trả path.resolve): với audit path chưa tồn tại (lần ghi đầu) vẫn
// resolve được qua ancestor; nhưng với path KHÔNG có ancestor realpath được (cấu trúc hỏng/không
// tồn tại tới root) thì THROW -> fail-closed, không bao giờ dùng đường dẫn lexical chưa được kiểm
// chứng làm anchor. Dùng cho: audit destination, operator ack, worktree root.
function realExisting(p) {
  let cur = path.resolve(String(p));
  const suffixes = [];
  for (;;) {
    try { return path.join(realpathSync(cur), ...suffixes); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error('không realpath được path: ' + String(p));
      suffixes.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// [GPT-REV-135] Phân tách mã lỗi redacted từ message để ghi audit entry FAIL mà KHÔNG rò rỉ
// đường dẫn/credentials/raw env. Chỉ lấy token [A-Z_]+ trong ngoặc sau "TỪ CHỐI (...)". Không khớp
// → code tổng quát. Message không bao giờ được ghi vào audit — chỉ code.
function failureCode(err) {
  const msg = String((err && err.message) || err || '');
  const m = msg.match(/TỪ CHỐI \((\w+)\)/);
  return m ? m[1] : 'MANUAL_APPROVAL_FAIL';
}

// [GPT-REV-138] Error class dành cho bootstrap failure mà KHÔNG THỂ xác định trusted audit
// destination (policy thiếu auditLogPath/auditLogRoot, hoặc resolve path lỗi trước khi có
// canonical destination). Khi error này được throw:
//   - KHÔNG có audit entry nào được ghi (không có nơi an toàn để ghi);
//   - KHÔNG có mutation nào xảy ra (fail-closed);
//   - lý do được nêu rõ để người vận hành biết vì sao invocation không có audit record.
// Phân biệt với validation failure có trusted destination: loại đó ghi FAIL redacted rồi rethrow.
export class NonAuditableBootstrapFailure extends Error {
  constructor(code, message) {
    super('[NON_AUDITABLE_BOOTSTRAP] ' + String(code || 'UNKNOWN') + ': ' + String(message || ''));
    this.name = 'NonAuditableBootstrapFailure';
    this.code = String(code || 'NON_AUDITABLE_BOOTSTRAP');
    this.audited = false; // explicit: invocation KHÔNG có audit entry
  }
}

// [GPT-REV-138] Resolve trusted audit destination từ policy manualException.
// Trả { path, root } canonical, hoặc throw NonAuditableBootstrapFailure nếu thiếu/sai.
// Không nhận input từ caller (CLI flag) làm trusted source — CLI chỉ là assertion bắt buộc khớp.
function resolveTrustedAuditDestination(manualPolicy, trustedRoot, cliAuditLogPath) {
  if (!manualPolicy || typeof manualPolicy !== 'object') {
    throw new NonAuditableBootstrapFailure('AUDIT_POLICY_MISSING', 'policy manualException thiếu');
  }
  const policyAuditPath = manualPolicy.auditLogPath ? String(manualPolicy.auditLogPath) : '';
  const auditRoot = manualPolicy.auditLogRoot ? String(manualPolicy.auditLogRoot) : '';
  if (!policyAuditPath || !auditRoot) {
    throw new NonAuditableBootstrapFailure('AUDIT_POLICY_INCOMPLETE', 'policy manualException.auditLogPath/auditLogRoot bắt buộc');
  }
  const expandHome = (p) => (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(2)) : p;
  let resolvedPath, resolvedRoot;
  try {
    resolvedPath = path.resolve(expandHome(policyAuditPath));
    resolvedRoot = path.resolve(expandHome(auditRoot));
  } catch (e) {
    throw new NonAuditableBootstrapFailure('AUDIT_PATH_INVALID', String((e && e.message) || e).slice(0, 120));
  }
  if (cliAuditLogPath && path.resolve(String(cliAuditLogPath)) !== resolvedPath) {
    // CLI flag lệch policy = lỗi caller; vẫn throw NonAuditable (chưa có destination canonical nào
    // được confirm cho invocation này — ghi audit ở path sai sẽ che lấp evidence).
    throw new NonAuditableBootstrapFailure('AUDIT_PATH_MISMATCH', 'CLI audit-log-path lệch policy path');
  }
  // Containment bằng realpath fail-closed (GPT-REV-132): không fallback lexical làm anchor.
  let realPath, realRoot;
  try {
    realPath = realExisting(resolvedPath);
    realRoot = realExisting(resolvedRoot);
  } catch (e) {
    throw new NonAuditableBootstrapFailure('AUDIT_PATH_UNRESOLVABLE', String((e && e.message) || e).slice(0, 120));
  }
  const relRoot = path.relative(realRoot, realPath);
  if (relRoot.startsWith('..') || path.isAbsolute(relRoot)) {
    throw new NonAuditableBootstrapFailure('AUDIT_OUTSIDE_ROOT', 'audit path ngoài auditLogRoot');
  }
  const relWt = path.relative(trustedRoot, realPath);
  if (!relWt.startsWith('..') && !path.isAbsolute(relWt)) {
    throw new NonAuditableBootstrapFailure('AUDIT_IN_WORKTREE', 'audit path nằm trong worktree');
  }
  const mbPath = path.join(trustedRoot, 'memory-bank');
  const relMb = path.relative(mbPath, realPath);
  if (!relMb.startsWith('..') && !path.isAbsolute(relMb)) {
    throw new NonAuditableBootstrapFailure('AUDIT_IN_MEMORY_BANK', 'audit path nằm trong memory-bank');
  }
  return { path: realPath, root: realRoot };
}

// [GPT-REV-138] Helper: ghi FAIL audit redacted. Best-effort: lỗi ghi audit KHÔNG che lỗi gốc.
function writeFailAudit(io, resolvedAuditPath, fields, err) {
  if (!resolvedAuditPath || !io || typeof io.appendAuditLog !== 'function') return;
  const failCode = failureCode(err);
  const failEntry = {
    timestamp: new Date().toISOString(),
    repository: fields.repo, prNumber: fields.pr, headSha: fields.headSha || '',
    reason: fields.reason, ciRunId: fields.ciRunId,
    policyVersion: fields.policyVersion, decisionId: fields.decisionId,
    gptEvidence: String((fields.gptEvidence && fields.gptEvidence.url) || ''),
    result: 'FAIL', failureCode: failCode, failureReason: failCode,
  };
  try { io.appendAuditLog(resolvedAuditPath, failEntry); } catch (_) { /* best-effort */ }
}

const OTHER_STATUSES = [
  LABELS.reviewRequested, LABELS.reviewing, LABELS.changesRequested,
  LABELS.blocked, LABELS.queued, LABELS.readyForCline, LABELS.inProgress,
];

// Phục hồi fail-closed: bảo đảm status:approved KHÔNG còn trên PR khi giao dịch lỗi.
async function ensureNotApproved(io, repo, pr, originalError) {
  let names = labelNames(io.getPrView(repo, pr));
  if (names.includes(LABELS.approved)) {
    try { io.removeLabels(repo, pr, [LABELS.approved]); } catch { /* báo lỗi gốc kèm trạng thái */ }
    names = labelNames(io.getPrView(repo, pr));
  }
  if (names.includes(LABELS.approved)) {
    throw new Error(`${originalError.message}; PHỤC HỒI THẤT BẠI: status:approved vẫn còn mà không chắc có marker — cần người dùng kiểm tra/chạy drift-repair.`);
  }
  throw new Error(`${originalError.message}; đã phục hồi: PR KHÔNG ở status:approved (marker nếu đã đăng sẽ bị drift-check vô hiệu hóa).`);
}

// ---------------------------------------------------------------- approval

export async function performApproval(io, { repo, pr, payload, note = '' }) {
  // --- Preconditions (chỉ đọc; chưa mutation gì) ---
  const view = io.getPrView(repo, pr);
  const headSha = view.headRefOid;
  if (!canMutatePr(view.state)) {
    throw new Error(`TỪ CHỐI: PR ${repo}#${pr} state=${view.state} — chỉ PR open được mutation.`);
  }

  let policy;
  let policySource = null;
  try {
    policySource = io.resolveCanonicalSource();
    policy = io.getPolicy(repo, headSha, policySource.sourceCommit);
  } catch (e) {
    throw new Error(`TỪ CHỐI (CI_UNKNOWN): không đọc được policy tại canonical source — ${String((e && e.message) || e).slice(0, 160)}`);
  }

  const gptApprovers = policy && policy.approvalAuthorities && policy.approvalAuthorities.gptApprovalCommentAuthors;
  if (!Array.isArray(gptApprovers) || gptApprovers.length === 0) {
    throw new Error('TỪ CHỐI: policy thiếu approvalAuthorities.gptApprovalCommentAuthors — không xác định được actor được phép đăng GPT approval marker');
  }
  // [GPT-REV-049] Xác minh DANH TÍNH THẬT của actor đang đăng comment phải thuộc allowlist.
  // gh pr comment đăng dưới tư cách tài khoản gh đã xác thực; script từ chối nếu actor đó
  // không thuộc gptApprovalCommentAuthors (không một bot/third-party nào được giả GPT approval).
  const actor = io.getCurrentUser();
  if (!gptApprovers.includes(String(actor || ''))) {
    throw new Error(`TỪ CHỐI: actor "${String(actor || '(rỗng)')}" không thuộc approvalAuthorities.gptApprovalCommentAuthors — không được đăng GPT approval marker`);
  }

  let checks = null;
  try { checks = io.getChecks(repo, pr); } catch { checks = null; }
  const ciState = evaluateChecks(policy, checks);
  if (ciState !== 'pass') {
    throw new Error(`TỪ CHỐI: CI=${ciState} — approval chỉ được ghi khi CI PASS (fail-closed).`);
  }

  const bodies = io.listPrComments(repo, pr);
  const passMarker = `<!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${headSha} -->`;
  // [GPT-REV-048] bodies có thể là rich comment object {body} hoặc legacy string.
  if (!bodies.some((b) => String(b && b.body != null ? b.body : b).includes(passMarker))) {
    throw new Error(`TỪ CHỐI: chưa có ${REVIEWER_LOCAL} PRE_REVIEW_PASS cho HEAD ${headSha.slice(0, 12)} — chạy orchestrator pre-review trước.`);
  }

  // Idempotent: approval trùng HEAD/repo/pr đã hợp lệ → không ghi lần 2.
  // [GPT-REV-048] r là kết quả parseApprovalMarkers {marker, commentId, authorLogin}; cần spread marker.
  // [GPT-REV-049] Duplicate detection: CHỈ marker do author thuộc gptApprovers mới tính là
  // approval hợp lệ. Marker giả (sai author) KHÔNG được coi là duplicate → không chặn việc
  // tạo approval hợp lệ mới, và không được nhận là approval thật.
  const existing = parseApprovalMarkers(bodies).filter((r) =>
    r.authorLogin && gptApprovers.includes(String(r.authorLogin))
      && isApprovalValid({ ...r.marker, commentId: r.commentId, authorLogin: r.authorLogin },
        { headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion, gptApprovers }).valid);
  if (existing.length) {
    return { mutated: false, skipped: 'duplicate', headSha, message: `BỎ QUA: approval ${AGENTS.gpt} cho HEAD ${headSha.slice(0, 12)} đã tồn tại (${existing.length} marker) — không ghi trùng.` };
  }

  // --- USER-RELAY PAYLOAD GATE (GPT-REV-032) — fail-closed trước mọi mutation ---
  const verdict = validateApprovalPayload(payload, {
    repository: repo, prNumber: pr, headSha, policyVersion: policy.policyVersion,
  });
  if (!verdict.ok) {
    throw new Error(`TỪ CHỐI (payload): ${verdict.error} — không mutation nào được thực hiện.`);
  }

  // --- GIAO DỊCH (GPT-REV-033): marker TRƯỚC → read-back → approved SAU ---
  const reviewerPrincipals = Array.isArray(policy && policy.approvalAuthorities && policy.approvalAuthorities.reviewerAuthorityAllowlist)
    ? policy.approvalAuthorities.reviewerAuthorityAllowlist.map(String) : [];
  const marker = buildApprovalMarker({
    repository: repo,
    prNumber: pr,
    reviewer: AGENTS.gpt,
    headSha,
    policyVersion: policy.policyVersion,
    decisionId: payload.decisionId,
    ciEvidence: { ciState, checks: ((checks && checks.checks) || []).map((c) => `${c.name}=${c.state}`) },
    openBlockingFindings: 0,
    reviewedAt: new Date().toISOString(),
    // [GPT-REV-137] Provenance: policy identity tách bạch khỏi target; identities derive từ policy.
    policySource,
    operator: String(actor || ''),
    reviewerPrincipals,
  });
  const body = [
    '## ✅ APPROVAL CUỐI — GPT (quyết định relay bởi người dùng)',
    note ? `\n> ${note}` : '',
    '',
    `Decision ID: \`${payload.decisionId}\`. CI PASS + ${REVIEWER_LOCAL} PRE_REVIEW_PASS tại HEAD \`${headSha}\`.`,
    'Lưu ý: script ghi nhận quyết định do người dùng relay; tính đúng đắn của việc chuyển tiếp quyết định GPT thuộc về kênh relay con người.',
    'Merge/deploy vẫn do người dùng thực hiện.',
    '',
    marker,
  ].join('\n');

  io.postComment(repo, pr, body); // lỗi → ném ra, CHƯA mutation nhãn nào

  const afterComments = io.listPrComments(repo, pr);
  const recorded = effectiveApproval(afterComments, { headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion, gptApprovers });
  if (!recorded || String(recorded.decisionId || '') !== String(payload.decisionId)) {
    throw new Error('read-back FAIL: marker approval chưa ghi nhận được/không hợp lệ tại HEAD — giữ nguyên nhãn, KHÔNG gắn status:approved.');
  }

  try {
    io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.approved));
    io.addLabels(repo, pr, [LABELS.approved]);
    const finalNames = labelNames(io.getPrView(repo, pr));
    if (!finalNames.includes(LABELS.approved)) throw new Error(`read-after-write FAIL: thiếu ${LABELS.approved}`);
    const statuses = finalNames.filter((l) => l.startsWith('status:'));
    if (statuses.length !== 1) throw new Error(`read-after-write FAIL: PR có ${statuses.length} status:* (${statuses.join(', ')})`);
  } catch (e) {
    await ensureNotApproved(io, repo, pr, e instanceof Error ? e : new Error(String(e)));
  }

  return {
    mutated: true,
    skipped: null,
    headSha,
    message: `ĐÃ GHI approval ${AGENTS.gpt} cho ${repo}#${pr} tại HEAD ${headSha.slice(0, 12)} (policy ${policy.policyVersion}, decision ${payload.decisionId}) — status:approved.`,
  };
}

// ---------------------------------------------------------------- manual approval (Issue #36)

// [Issue #36] Sanctioned degraded path: cho phép ghi GPT approval khi pre-review fail vì
// PRE_REVIEW_DIFF_LIMIT (diff > policy.diffLimits.maxLines). KHÔNG phải alternate approval
// source — chỉ waive đúng reason đó; mọi blocker/finding/dependency khác vẫn fail-closed.
// Evidence bắt buộc (GPT amendment 2026-09-01): reason ∈ manualException.allowedReason;
// CI run verify qua io.getCiRun; GPT evidence canonical không self-authored; operator ack
// file ngoài worktree + memory-bank; policyDigest SHA-256. Mutation order (GPT-REV-033):
// validate ALL → re-read state → marker → read-back → audit log → labels SAU.
export async function performManualApproval(io, {
  repo, pr, reason, ciRunId, gptEvidence, operatorAckPath, policyDigest,
  decisionId, note = '', worktreeRoot = '', auditLogPath = '',
}) {
  // [GPT-REV-138] Mở rộng audit boundary: bọc TOÀN BỘ invocation từ PR view đến cuối function.
  // Mọi lỗi có trusted audit destination (resolvedAuditPath đã có) → FAIL redacted.
  // Mọi lỗi KHÔNG có destination (resolveTrustedAuditDestination fail, hoặc lỗi trước resolve)
  // → NonAuditableBootstrapFailure, KHÔNG ghi audit, KHÔNG mutation.
  let resolvedAuditPath = '';
  let policy = null;
  let policySource = null;
  let headSha = '';
  try {
  // --- 1. Preconditions (chỉ đọc) ---
  const view = io.getPrView(repo, pr);
  headSha = view.headRefOid;
  if (!canMutatePr(view.state)) {
    throw new Error('TỪ CHỐI: PR ' + repo + '#' + pr + ' state=' + view.state + ' — chỉ PR open được mutation.');
  }
  try {
    policySource = io.resolveCanonicalSource();
    policy = io.getPolicy(repo, headSha, policySource.sourceCommit);
  } catch (e) {
    throw new Error('TỪ CHỐI (CI_UNKNOWN): không đọc được policy tại canonical source — ' + String((e && e.message) || e).slice(0, 160));
  }
  const manualPolicy = policy && policy.manualException;
  if (!manualPolicy || typeof manualPolicy !== 'object' || manualPolicy.enabled !== true) {
    throw new Error('TỪ CHỐI: policy manualException.enabled !== true — manual path chưa được bật (fail-closed).');
  }
  const gptApprovers = policy && policy.approvalAuthorities && policy.approvalAuthorities.gptApprovalCommentAuthors;
  if (!Array.isArray(gptApprovers) || gptApprovers.length === 0) {
    throw new Error('TỪ CHỐI: policy thiếu approvalAuthorities.gptApprovalCommentAuthors.');
  }
  // [Issue #38] Reviewer authority allowlist TÁCH BIỆT khỏi operator/transport: evidence comment
  // phải do reviewer principal (GitHub App/bot/service principal, login riêng) đăng; operator
  // (chạy script) phải khác. Rỗng = chưa provision → real verifyGptEvidence fail-closed.
  const reviewerAuthorities = policy && policy.approvalAuthorities && policy.approvalAuthorities.reviewerAuthorityAllowlist;
  const reviewerAuthList = Array.isArray(reviewerAuthorities) ? reviewerAuthorities.map(String) : [];
  // [GPT-REV-134] Trusted root từ GIT METADATA (không tin CLI --worktree-root làm nguồn tin cậy).
  // resolveGitRoot suy ra worktree root canonical + đối chiếu origin với repo PR. CLI worktreeRoot
  // (nếu còn) chỉ cho diagnostics và bắt buộc khớp EXACT → sai root = mismatch, fail-closed.
  let trustedRoot;
  try {
    trustedRoot = io.resolveGitRoot
      ? io.resolveGitRoot({ expectRepo: repo })
      : path.resolve(String(worktreeRoot || ''));
  } catch (e) {
    throw new Error('TỪ CHỐI (WORKTREE_ROOT): không resolve được worktree root canonical — ' + String((e && e.message) || e).slice(0, 160) + ' (GPT-REV-134).');
  }
  if (worktreeRoot && path.resolve(String(worktreeRoot)) !== trustedRoot) {
    throw new Error('TỪ CHỐI (WORKTREE_ROOT_MISMATCH): CLI --worktree-root "' + worktreeRoot + '" khác worktree root canonical "' + trustedRoot + '" (GPT-REV-134).');
  }

  // [GPT-REV-138] Resolve trusted audit destination SỚM — NGAY SAU trustedRoot, TRƯỚC mọi validation
  // caller-controlled (actor/policy-digest/CI) để các lỗi đó đều có destination ghi FAIL redacted.
  // Lỗi resolve destination = NonAuditableBootstrapFailure (KHÔNG có audit entry — không có nơi an toàn).
  const auditDest = resolveTrustedAuditDestination(manualPolicy, trustedRoot, auditLogPath);
  resolvedAuditPath = auditDest.path; // gán biến ngoài try để catch (GPT-REV-138) nhìn thấy destination

  const actor = io.getCurrentUser();
  if (!gptApprovers.includes(String(actor || ''))) {
    throw new Error('TỪ CHỐI: actor "' + actor + '" không thuộc gptApprovalCommentAuthors — không được relay approval.');
  }

  // [GPT-REV-133] expectedPolicyDigest + artifactAuthors sớm — cần cho provenance gate state.
  let expectedPolicyDigest;
  try {
    expectedPolicyDigest = computePolicyDigest(policy);
  } catch (e) {
    throw new Error('TỪ CHỐI (POLICY_DIGEST): ' + String((e && e.message) || e).slice(0, 120));
  }
  const artifactAuthors = Array.isArray(policy && policy.approvalAuthorities && policy.approvalAuthorities.localApprovalCommentAuthors)
    ? policy.approvalAuthorities.localApprovalCommentAuthors.map(String) : [];

  // ===== [GPT-REV-135/138] SANCTIONED INVOCATION OUTCOME BOUNDARY =====
  // (try/catch bao ngoài đã mở rộng ở đầu function — GPT-REV-138; không cần try lồng ở đây.)
  // --- 2. Config/identity checks (reason/decisionId/headSha/policyDigest) ---
  const allowedReasons = Array.isArray(manualPolicy.allowedReason) ? manualPolicy.allowedReason.map(String) : [];
  if (!allowedReasons.includes(String(reason || ''))) {
    throw new Error('TỪ CHỐI: reason "' + reason + '" không thuộc [' + allowedReasons.join(', ') + '] — manual path chỉ waive reason được phép.');
  }
  if (String(decisionId || '').trim() === '' || /\s/.test(String(decisionId || ''))) {
    throw new Error('TỪ CHỐI: decisionId bắt buộc, không chứa khoảng trắng.');
  }
  if (!/^[0-9a-f]{40}$/i.test(String(headSha || ''))) {
    throw new Error('TỪ CHỐI: headSha "' + headSha + '" không phải full 40-hex.');
  }
  if (String(policyDigest || '').toLowerCase() !== String(expectedPolicyDigest).toLowerCase()) {
    throw new Error('TỪ CHỐI (POLICY_DIGEST_MISMATCH): policyDigest="' + policyDigest + '" != computed "' + expectedPolicyDigest + '" — policy đã đổi, không approve.');
  }

  // --- 2. Verify CI run qua GitHub API (khong tin client-side) ---
  // [GPT-REV-131] Bat buoc: status==='completed', conclusion==='success',
  // workflow thuoc policy manualException.approvedCiWorkflows (approved workflow identity).
  let ciRun;
  try {
    ciRun = io.getCiRun(repo, ciRunId);
  } catch (e) {
    throw new Error('TỪ CHỐI (CI_NOT_FOUND): không đọc được CI run ' + ciRunId + ' — ' + String((e && e.message) || e).slice(0, 160));
  }
  if (ciRun && ciRun.repository && String(ciRun.repository) !== String(repo)) {
    throw new Error('TỪ CHỐI (CI_REPO_MISMATCH): CI run thuộc repo "' + ciRun.repository + '" không khớp "' + repo + '".');
  }
  if (ciRun && String(ciRun.headSha || '').toLowerCase() !== String(headSha).toLowerCase()) {
    throw new Error('TỪ CHỐI (CI_HEAD_MISMATCH): CI head_sha "' + ciRun.headSha + '" không khớp PR head "' + headSha + '".');
  }
  if (!ciRun || String(ciRun.status || '') !== 'completed') {
    throw new Error('TỪ CHỐI (CI_NOT_COMPLETED): CI run ' + ciRunId + ' status="' + (ciRun && ciRun.status) + '" — yêu cầu completed (GPT-REV-131).');
  }
  if (!ciRun || String(ciRun.conclusion || '') !== 'success') {
    throw new Error('TỪ CHỐI (CI_FAIL): CI run ' + ciRunId + ' conclusion="' + (ciRun && ciRun.conclusion) + '" — yêu cầu success.');
  }
  const approvedWorkflows = Array.isArray(manualPolicy.approvedCiWorkflows) ? manualPolicy.approvedCiWorkflows.map(String) : [];
  if (approvedWorkflows.length > 0 && !approvedWorkflows.includes(String(ciRun.workflow || ''))) {
    throw new Error('TỪ CHỐI (CI_WORKFLOW_NOT_APPROVED): workflow "' + ciRun.workflow + '" không thuộc [' + approvedWorkflows.join(', ') + '] (GPT-REV-131).');
  }

  // --- 3. Verify GPT evidence (canonical artifact, không self-authored) ---
  let verifiedGptEvidence;
  try {
    verifiedGptEvidence = io.verifyGptEvidence(repo, pr, gptEvidence, {
      gptApprovers, gptAuthorities: reviewerAuthList, headSha,
      policyVersion: policy.policyVersion, actorSelf: actor,
      policyDigest: String(expectedPolicyDigest).toLowerCase(), decisionId: String(decisionId),
    });
  } catch (e) {
    throw new Error('TỪ CHỐI (GPT_EVIDENCE): ' + String((e && e.message) || e).slice(0, 200));
  }

  // --- 4. Verify operator ack (file ngoài worktree + ngoài memory-bank) ---
  // [GPT-REV-129] worktreeRoot bắt buộc (đã check bước 1); containment realpath.
  let verifiedOperatorAck;
  try {
    verifiedOperatorAck = io.readOperatorAck(operatorAckPath, { worktreeRoot: trustedRoot });
  } catch (e) {
    throw new Error('TỪ CHỐI (OPERATOR_ACK): ' + String((e && e.message) || e).slice(0, 200));
  }

  // --- 5. [GPT-REV-128] Authoritative gate state tại exact HEAD ---
  // Chứng minh PRE_REVIEW_DIFF_LIMIT là blocker DUY NHẤT: pre-review verdict phải là
  // PRE_REVIEW_FINDINGS với đúng 1 finding blocking (diff-limit); không có blocking status,
  // dependency block, hay failed gate khác. openBlockingFindings DERIVE từ gate state
  // (không synthesize 0).
  let gate;
  try {
    gate = io.getGateState(repo, pr, headSha, { policyVersion: policy.policyVersion, policyDigest: String(expectedPolicyDigest).toLowerCase(), artifactAuthors });
  } catch (e) {
    throw new Error('TỪ CHỐI (GATE_STATE): ' + String((e && e.message) || e).slice(0, 200));
  }
  const blockingStatusLabels = Array.isArray(gate.blockingStatusLabels) ? gate.blockingStatusLabels : [];
  if (blockingStatusLabels.length) {
    throw new Error('TỪ CHỐI (STATUS_BLOCKED): PR đang ở trạng thái blocking [' + blockingStatusLabels.join(', ') + '] — không được waive (GPT-REV-128).');
  }
  if (String(gate.preReviewVerdict || '') !== 'PRE_REVIEW_FINDINGS') {
    throw new Error('TỪ CHỐI (NO_DIFF_LIMIT_FINDING): pre-review verdict="' + gate.preReviewVerdict + '" — cần PRE_REVIEW_FINDINGS tại HEAD (GPT-REV-128).');
  }
  // [GPT-REV-137] gate numeric fields phải là finite non-negative integers (fail-closed nếu NaN/negative/float).
  if (!Number.isInteger(gate.openBlockingFindings) || gate.openBlockingFindings < 0) {
    throw new Error('TỪ CHỐI (BLOCKER_COUNT_MALFORMED): openBlockingFindings=' + JSON.stringify(gate.openBlockingFindings) + ' — cần finite non-negative integer (GPT-REV-137).');
  }
  if (!Number.isInteger(gate.dependencyBlocks) || gate.dependencyBlocks < 0) {
    throw new Error('TỪ CHỐI (DEPENDENCY_BLOCKS_MALFORMED): dependencyBlocks=' + JSON.stringify(gate.dependencyBlocks) + ' — cần finite non-negative integer (GPT-REV-137).');
  }
  if (gate.openBlockingFindings !== 1) {
    throw new Error('TỪ CHỐI (BLOCKER_COUNT): openBlockingFindings=' + gate.openBlockingFindings + ' — cần đúng 1 blocker (diff-limit) (GPT-REV-128).');
  }
  if (gate.dependencyBlocks > 0) {
    throw new Error('TỪ CHỐI (DEPENDENCY_BLOCK): có ' + gate.dependencyBlocks + ' dependency block — không được waive (GPT-REV-128).');
  }
  // [GPT-REV-137] failedGates phải bằng CHÍNH XÁC ["PRE_REVIEW_DIFF_LIMIT"]: cardinality 1,
  // không duplicate, không gate khác. Mọi shape khác (rỗng, [diff, other], [diff, diff]) đều reject.
  const failedGatesExact = ['PRE_REVIEW_DIFF_LIMIT'];
  const failedGatesArr = Array.isArray(gate.failedGates) ? gate.failedGates : null;
  const failedGatesOk = failedGatesArr
    && failedGatesArr.length === failedGatesExact.length
    && failedGatesArr.every((g, i) => String(g) === failedGatesExact[i]);
  if (!failedGatesOk) {
    throw new Error('TỪ CHỐI (FAILED_GATES_NOT_DIFF_LIMIT_ONLY): failedGates=' + JSON.stringify(gate.failedGates) + ' — cần chính xác ["PRE_REVIEW_DIFF_LIMIT"] (GPT-REV-137).');
  }
  // Derive: 1 blocker (diff-limit) được waive → còn 0. Không synthesize.
  const openBlockingFindings = Math.max(0, Number(gate.openBlockingFindings || 0) - 1);

  const manualCtx = {
    manualExceptionPolicy: manualPolicy, gptApprovers, reviewerAuthorities: reviewerAuthList, actorSelf: actor,
    verifiedCiRun: ciRun, verifiedGptEvidence, verifiedOperatorAck,
    expectedPolicyDigest: String(expectedPolicyDigest).toLowerCase(),
  };
  // [GPT-REV-152] Activation time-window (Issue #38): activatedAt/expiresAt ISO, expiresAt > activatedAt,
  // duration <= activationTtlSeconds, now & evidence.issuedAt trong cửa sổ, evidence mới không thể gia hạn.
  // Chạy TRƯỚC mọi mutation/marker/audit SUCCESS — fail-closed (đặt trước section 9 ghi audit PASS).
  {
    const windowCheck = validateManualActivationTarget({
      policyTarget: manualPolicy.target,
      invocation: { repository: repo, prNumber: pr, headSha, decisionId },
      evidence: verifiedGptEvidence
        ? { repository: repo, prNumber: pr, headSha, decisionId, issuedAt: verifiedGptEvidence.issuedAt }
        : null,
      nowMs: Date.now(),
      ttlSeconds: Number(manualPolicy.activationTtlSeconds ?? 0),
    });
    if (!windowCheck.ok) {
      throw new Error('TỪ CHỐI (MANUAL_TARGET_WINDOW): ' + windowCheck.reason);
    }
  }


  // --- 8. Re-read exact state TRƯỚC mutation (drift check) ---
  const view2 = io.getPrView(repo, pr);
  if (String(view2.headRefOid || '').toLowerCase() !== String(headSha).toLowerCase()) {
    throw new Error('TỪ CHỐI (HEAD_DRIFT): PR HEAD đổi giữa validation và mutation (' + headSha.slice(0, 12) + ' → ' + String(view2.headRefOid || '').slice(0, 12) + ') — fail-closed.');
  }
  if (!canMutatePr(view2.state)) {
    throw new Error('TỪ CHỐI: PR state đổi thành ' + view2.state + ' — không mutation.');
  }

  // --- 9. [GPT-REV-130] Audit TRƯỚC marker (transaction state) + idempotency/repair ---
  // Giao dịch: audit PASS phải tồn tại TRƯỚC khi marker được coi là hoàn chỉnh.
  // Ghi audit trước → nếu audit fail, chưa có marker nào (không orphan). Retry: marker có
  // sẵn + audit PASS → duplicate; marker có sẵn nhưng audit thiếu → repair (ghi audit) rồi
  // tiếp tục labels. effectiveApproval yêu cầu auditVerified + auditWritten (contract đã thêm).
  // [Issue #38] activationTtlSeconds (bounded) → entry audit có expiresAt = timestamp + TTL.
  // ttlSeconds <= 0 hoặc missing → không có expiry (giữ tương thích forward cho hạ tầng deploy cũ).
  const ttlSeconds = Number(manualPolicy.activationTtlSeconds ?? 0);
  const nowMs = Date.now();
  const reviewerPrincipalsAudit = Array.isArray(policy && policy.approvalAuthorities && policy.approvalAuthorities.reviewerAuthorityAllowlist)
    ? policy.approvalAuthorities.reviewerAuthorityAllowlist.map(String) : [];
  const auditEntry = {
    timestamp: new Date(nowMs).toISOString(), repository: repo, prNumber: pr, headSha, reason, ciRunId,
    gptEvidence: String(gptEvidence && gptEvidence.url || ''), operatorAckPath,
    policyVersion: policy.policyVersion, policyDigest: String(expectedPolicyDigest),
    decisionId, result: 'PASS', failureReason: null,
    // [GPT-REV-137] Policy identity provenance (server-resolved canonical source), TÁCH BIỆT
    // khỏi target repo/PR/HEAD. Không lộ secret/credential.
    policySource,
    operator: String(actor || ''),
    reviewerPrincipals: reviewerPrincipalsAudit,
    // [GPT-REV-149] Activation target: bind exact repository/prNumber/full-40-hex headSha/decisionId
    // (Issue #38) — activation không thể được tái sử dụng cho target khác.
    target: { repository: repo, prNumber: pr, headSha, decisionId },
    expiresAt: ttlSeconds > 0 ? new Date(nowMs + ttlSeconds * 1000).toISOString() : null,
  };
  // [Issue #38] Anti-replay + expiry: scan TOÀN BỘ audit entries cho decisionId (không chỉ entry cuối).
  const auditEntries = io.readAuditEntries
    ? io.readAuditEntries(resolvedAuditPath)
    : (io.readAuditLog ? [io.readAuditLog(resolvedAuditPath)].filter(Boolean) : []);
  const priorForDecision = auditEntries.find((e) => e && String(e.decisionId || '') === String(decisionId));
  let auditPassed = false;
  if (priorForDecision && String(priorForDecision.result || '') === 'PASS') {
    const expMs = priorForDecision.expiresAt ? Date.parse(priorForDecision.expiresAt) : NaN;
    if (!Number.isNaN(expMs) && expMs <= nowMs) {
      throw new Error('TỪ CHỐI (EXCEPTION_EXPIRED): manual activation decisionId "' + decisionId + '" đã SUCCESS và hết hạn ' + priorForDecision.expiresAt + ' — cần reviewer principal evidence mới (Issue #38).');
    }
    const sameTarget = String(priorForDecision.repository || '') === repo
      && Number(priorForDecision.prNumber) === Number(pr)
      && String(priorForDecision.headSha || '').toLowerCase() === String(headSha).toLowerCase()
      && String(priorForDecision.policyDigest || '').toLowerCase() === String(expectedPolicyDigest).toLowerCase()
      && String(priorForDecision.gptEvidence || '') === String(gptEvidence && gptEvidence.url || '');
    if (!sameTarget) {
      throw new Error('TỪ CHỐI (REPLAY_CONFLICT): decisionId "' + decisionId + '" đã SUCCESS cho target khác (repo/pr/head/policy/evidence) — chống replay (Issue #38).');
    }
    auditPassed = true; // cùng target + chưa hết hạn → idempotent, skip append.
  }
  if (!auditPassed) {
    try {
      io.appendAuditLog(resolvedAuditPath, auditEntry);
    } catch (e) {
      throw new Error('TỪ CHỐI (AUDIT_FAIL): ' + String((e && e.message) || e).slice(0, 160) + ' — chưa có marker (ghi audit trước marker).');
    }
  }

  // Existing marker + audit đủ → duplicate (idempotent, không ghi trùng).
  const existing = parseApprovalMarkers(io.listPrComments(repo, pr)).filter((r) =>
    r.authorLogin && gptApprovers.includes(String(r.authorLogin))
      && isApprovalValid({ ...r.marker, commentId: r.commentId, authorLogin: r.authorLogin },
        { ...manualCtx, auditVerified: true, headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion }).valid);
  if (existing.length) {
    // [GPT-REV-130] Repair/resume: marker + audit PASS da du nhung labels chua approved
    // (truoc do labels fail giua chung) → apply labels de kha phuc, khong bo qua im lang.
    const currentNames = labelNames(io.getPrView(repo, pr));
    if (!currentNames.includes(LABELS.approved)) {
      io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.approved));
      io.addLabels(repo, pr, [LABELS.approved]);
      const finalNames = labelNames(io.getPrView(repo, pr));
      if (!finalNames.includes(LABELS.approved)) {
        throw new Error('RESUME_FAIL: marker + audit PASS ton tai nhung khong gan duoc status:approved — can nguoi dung kiem tra.');
      }
      return { mutated: true, skipped: null, headSha, message: 'RESUME: marker + audit PASS da ton tai, da kha phuc status:approved.' };
    }
    return { mutated: false, skipped: 'duplicate', headSha, message: 'BO QUA: manual approval cho HEAD ' + headSha.slice(0, 12) + ' da ton tai (' + existing.length + ' marker + audit PASS) — idempotent, khong ghi trung.' };
  }

  // --- 10. Mutation order (GPT-REV-033 + GPT-REV-130): audit đã ghi → marker comment ---
  const probeMarker = {
    repository: repo, prNumber: pr, reviewer: AGENTS.gpt, headSha,
    policyVersion: policy.policyVersion, policyDigest: String(expectedPolicyDigest).toLowerCase(),
    decisionId, kind: 'MANUAL_REVIEW_EXCEPTION_APPROVED', reason: String(reason),
    ciRunId: String(ciRunId), gptEvidence: verifiedGptEvidence
      ? { ...gptEvidence, authorLogin: verifiedGptEvidence.authorLogin, issuer: verifiedGptEvidence.issuer,
          policyDigest: verifiedGptEvidence.policyDigest, decisionId: verifiedGptEvidence.decisionId,
          issuedAt: verifiedGptEvidence.issuedAt, reviewDigest: verifiedGptEvidence.reviewDigest }
      : { ...gptEvidence, authorLogin: '' },
    operatorAck: verifiedOperatorAck ? { source: 'local-state', ackPath: operatorAckPath, operator: verifiedOperatorAck.operator, reason: String(reason), ackAt: verifiedOperatorAck.ackAt, issueRef: verifiedOperatorAck.issueRef } : null,
    openBlockingFindings, reviewedAt: new Date().toISOString(),
    // [GPT-REV-137] Provenance: policy identity tách bạch khỏi target; identities derive từ policy.
    policySource, operator: String(actor || ''), reviewerPrincipals: reviewerPrincipalsAudit,
    auditWritten: true, auditRef: String(decisionId),
  };
  const preVerdict = isManualApprovalValid({ ...probeMarker, commentId: 'probe', authorLogin: actor }, { ...manualCtx, auditVerified: true });
  if (!preVerdict.valid) {
    throw new Error('TỪ CHỐI (MANUAL_VALIDATION): ' + preVerdict.reason);
  }
  const marker = buildApprovalMarker(probeMarker);
  const body = [
    '## ✅ APPROVAL CUỐI — GPT (manual exception, PRE_REVIEW_DIFF_LIMIT)',
    note ? '\n> ' + note : '',
    '',
    'Reason: \`' + reason + '\`. CI run \`' + ciRunId + '\` SUCCESS tại HEAD \`' + headSha + '\`.',
    'Policy: \`' + policy.policyVersion + '\` (digest \`' + String(expectedPolicyDigest).slice(0, 12) + '…\`).',
    'Audit: PASS tại \`' + resolvedAuditPath + '\`.',
    'Lưu ý: path này chỉ waive \`PRE_REVIEW_DIFF_LIMIT\`; mọi blocker/finding/dependency khác vẫn fail-closed.',
    'Merge/deploy vẫn do người dùng thực hiện.',
    '', marker,
  ].join('\n');
  io.postComment(repo, pr, body);

  const afterComments = io.listPrComments(repo, pr);
  const recorded = effectiveApproval(afterComments, { ...manualCtx, auditVerified: true, headSha, repository: repo, prNumber: pr, policyVersion: policy.policyVersion });
  if (!recorded || String(recorded.decisionId || '') !== String(decisionId)) {
    throw new Error('read-back FAIL: manual approval marker chưa ghi nhận được tại HEAD — giữ nguyên nhãn, KHÔNG gắn status:approved.');
  }

  // --- 11. Labels SAU (approved chỉ khi marker + audit đều thành công) ---
  try {
    io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.approved));
    io.addLabels(repo, pr, [LABELS.approved]);
    const finalNames = labelNames(io.getPrView(repo, pr));
    if (!finalNames.includes(LABELS.approved)) throw new Error('read-after-write FAIL: thiếu ' + LABELS.approved);
    const statuses = finalNames.filter((l) => l.startsWith('status:'));
    if (statuses.length !== 1) throw new Error('read-after-write FAIL: PR có ' + statuses.length + ' status:* (' + statuses.join(', ') + ')');
  } catch (e) {
    await ensureNotApproved(io, repo, pr, e instanceof Error ? e : new Error(String(e)));
  }

  return {
    mutated: true, skipped: null, headSha,
    message: 'ĐÃ GHI manual approval ' + AGENTS.gpt + ' cho ' + repo + '#' + pr + ' tại HEAD ' + headSha.slice(0, 12) + ' (reason ' + reason + ', policy ' + policy.policyVersion + ', decision ' + decisionId + ') — status:approved.',
  };
  } catch (err) {
    // [GPT-REV-138] Mở rộng audit boundary. Phân biệt 2 loại failure:
    //   1. Có trusted audit destination (resolvedAuditPath đã có) → ghi FAIL redacted, rethrow.
    //   2. Không có trusted audit destination (resolveTrustedAuditDestination chưa thành công,
    //      hoặc throw NonAuditableBootstrapFailure) → KHÔNG ghi audit, throw NonAuditableBootstrapFailure
    //      giữ nguyên (hoặc wrap nếu lỗi gốc không phải NonAuditable) để người vận hành biết invocation
    //      này không có audit record.
    if (resolvedAuditPath) {
      writeFailAudit(io, resolvedAuditPath, {
        repo, pr, headSha, reason, ciRunId,
        policyVersion: policy && policy.policyVersion,
        decisionId, gptEvidence,
      }, err);
      throw err;
    }
    // Không có audit destination — wrap để rõ ràng cho người vận hành, KHÔNG ghi audit.
    if (err instanceof NonAuditableBootstrapFailure) throw err;
    throw new NonAuditableBootstrapFailure('PRE_DESTINATION_FAIL', String((err && err.message) || err).slice(0, 200));
  }
}

// ---------------------------------------------------------------- revoke

export async function performRevoke(io, { repo, pr, reason }) {
  const view = io.getPrView(repo, pr);
  const headSha = view.headRefOid;
  if (!canMutatePr(view.state)) {
    throw new Error(`TỪ CHỐI: PR ${repo}#${pr} state=${view.state} — chỉ PR open được mutation.`);
  }
  // [GPT-REV-137] Revoke idempotency: nếu đã có marker revoke cho cùng repo/pr/head và PR đã ở
  // status:review-requested (không còn status:approved) → KHÔNG đăng comment trùng, không mutation
  // thừa. Giữ audit append-only (không xoá entry cũ). Skip idempotent fail-closed.
  const revokeKey = `ai-pr-reviewer:key=${repo}::${pr}::${headSha}::revoke`;
  const bodies = io.listPrComments(repo, pr);
  const alreadyRevoked = bodies.some((b) =>
    String(b && b.body != null ? b.body : b).includes(revokeKey));
  const currentNames = labelNames(io.getPrView(repo, pr));
  const stillApproved = currentNames.includes(LABELS.approved);
  if (alreadyRevoked && !stillApproved) {
    return { mutated: false, skipped: 'already-revoked', headSha, message: `BỎ QUA: revoke cho ${repo}#${pr} tại HEAD ${headSha.slice(0, 12)} đã tồn tại — idempotent, không đăng trùng.` };
  }
  io.removeLabels(repo, pr, [LABELS.approved]);
  io.removeLabels(repo, pr, OTHER_STATUSES.filter((l) => l !== LABELS.reviewRequested));
  io.addLabels(repo, pr, [LABELS.reviewRequested]);
  const finalNames = labelNames(io.getPrView(repo, pr));
  if (!finalNames.includes(LABELS.reviewRequested)) throw new Error(`read-after-write FAIL: thiếu ${LABELS.reviewRequested}`);
  const statuses = finalNames.filter((l) => l.startsWith('status:'));
  if (statuses.length !== 1) throw new Error(`read-after-write FAIL: PR có ${statuses.length} status:* (${statuses.join(', ')})`);
  io.postComment(repo, pr, `🚫 Thu hồi approval: ${reason}\n\nChuyển về \`status:review-requested\`, chờ ${AGENTS.gpt} review lại.\n<!-- ai-pr-reviewer:key=${repo}::${pr}::${headSha}::revoke -->`);
  return { mutated: true, headSha, message: `ĐÃ THU HỒI approval trên ${repo}#${pr} (HEAD ${headSha.slice(0, 12)}).` };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--pr') out.pr = Number(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--payload') out.payloadRaw = argv[++i];
    else if (a === '--payload-file') out.payloadFile = argv[++i];
    else if (a === '--revoke') out.revoke = argv[++i] || 'người dùng thu hồi';
    // [Issue #36] Manual exception flags
    else if (a === '--manual-approval') out.manualApproval = true;
    else if (a === '--reason') out.reason = argv[++i];
    else if (a === '--ci-run-id') out.ciRunId = argv[++i];
    else if (a === '--gpt-evidence-url') out.gptEvidenceUrl = argv[++i];
    else if (a === '--gpt-evidence-comment-id') out.gptEvidenceCommentId = argv[++i];
    else if (a === '--operator-ack-file') out.operatorAckFile = argv[++i];
    else if (a === '--policy-digest') out.policyDigest = argv[++i];
    else if (a === '--decision-id') out.decisionId = argv[++i];
    else if (a === '--worktree-root') out.worktreeRoot = argv[++i];
    else if (a === '--audit-log-path') out.auditLogPath = argv[++i];
    else out._.push(a);
  }
  const hasNormal = out.repo && out.pr && (out.payloadRaw || out.payloadFile);
  const hasRevoke = out.repo && out.pr && out.revoke;
  const hasManual = out.manualApproval && out.repo && out.pr && out.reason && out.ciRunId
    && out.gptEvidenceUrl && out.gptEvidenceCommentId && out.operatorAckFile
    && out.policyDigest && out.decisionId && out.worktreeRoot;
  if (!hasNormal && !hasRevoke && !hasManual) {
    console.error([
      'Usage:',
      '  node scripts/gpt-approval.mjs --repo owner/name --pr <number> --payload \'<json>\' [--note "..."]',
      '    json: {"repository":"owner/name","prNumber":N,"headSha":"<full40hex>","policyVersion":"...","decisionId":"id-khong-trang"}',
      '  (hoặc --payload-file <path>)',
      '  node scripts/gpt-approval.mjs --repo owner/name --pr <number> --revoke "lý do"',
      '',
      '  # Manual exception (Issue #36, reason=PRE_REVIEW_DIFF_LIMIT only):',
      '  node scripts/gpt-approval.mjs --repo owner/name --pr <number> --manual-approval \\',
      '    --reason PRE_REVIEW_DIFF_LIMIT --ci-run-id <numeric> \\',
      '    --gpt-evidence-url "https://github.com/owner/repo/issues/<pr>#issuecomment-<id>" \\',
      '    --gpt-evidence-comment-id <id> --operator-ack-file <path OUTSIDE worktree> \\',
      '    --policy-digest <sha256hex> --decision-id id-khong-trang --worktree-root <git worktree root> \\',
      '    [--audit-log-path <path> (bắt buộc khớp policy manualException.auditLogPath)] [--note "..."]',
    ].join('\n'));
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const io = defaultIo();
  if (args.revoke) {
    const r = await performRevoke(io, { repo: args.repo, pr: args.pr, reason: args.revoke });
    console.log(r.message);
    return;
  }
  if (args.manualApproval) {
    const r = await performManualApproval(io, {
      repo: args.repo,
      pr: args.pr,
      reason: args.reason,
      ciRunId: args.ciRunId,
      gptEvidence: { url: args.gptEvidenceUrl, commentId: args.gptEvidenceCommentId },
      operatorAckPath: args.operatorAckFile,
      policyDigest: args.policyDigest,
      decisionId: args.decisionId,
      note: args.note || '',
      worktreeRoot: args.worktreeRoot || '',
      auditLogPath: args.auditLogPath,
    });
    console.log(r.message);
    return;
  }
  let payload;
  try {
    payload = JSON.parse(args.payloadFile ? readFileSync(args.payloadFile, 'utf8') : args.payloadRaw);
  } catch (e) {
    console.error(`TỪ CHỐI: --payload không phải JSON hợp lệ — ${(e && e.message) || e}`);
    process.exitCode = 2;
    return;
  }
  const r = await performApproval(io, { repo: args.repo, pr: args.pr, payload, note: args.note || '' });
  console.log(r.message);
}

// Chỉ chạy CLI khi được gọi trực tiếp (import từ test không kích hoạt main).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[FATAL]', e && e.message ? e.message : e);
    process.exitCode = 1;
  });
}

