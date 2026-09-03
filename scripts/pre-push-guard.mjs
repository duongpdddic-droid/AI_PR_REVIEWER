#!/usr/bin/env node
// pre-push-guard.mjs — LOCAL pre-push HEAD-Lock guard (Issue #22).
//
// Chạy từ git hook pre-push (stdin: `<local ref>\t<local sha>\t<remote ref>\t<remote sha>` mỗi
// dòng — một dòng cho mỗi ref đang push). Với mỗi branch có PR open, áp decidePrePushGuard:
//   - frozen (approved | review-requested + agent:gpt) + HEAD lệch lock → CHẶN push (exit 1),
//     trừ khi có unfreeze marker hợp lệ (reason + mới hơn lock + authorized author).
//   - chưa frozen / HEAD khớp lock / không có PR / không open → cho phép.
//   - không đọc được trạng thái PR đã biết tồn tại → CHẶN (fail-closed).
//   - không resolve được origin / không parse được ref → CHẶN (fail-closed) [GPT-REV-CHANGES-04].
//
// Đây là phòng thủ LOCAL (client-side). GitHub không chặn push server-side được ở cấp nhãn —
// server-side protection là Phase follow-up; orchestrator vẫn kiểm tra drift sau push
// (read-before-mutation) như tuyến phòng thủ thứ hai.
//
// Cài: node scripts/setup-pre-push-hook.mjs   (ghi .git/hooks/pre-push cục bộ, không commit)
//
// [GPT-REV-CHANGES-04] Fail-closed: không exit 0 khi origin/ref không parse được. Đọc toàn bộ
// stdin bằng readFileSync(0, 'utf8') (không phải process.stdin.read() có thể trả rỗng/thiếu).
//
// Test seam: khi đặt env PRE_PUSH_GUARD_FIXTURE=<path JSON> thì guard dùng fixture thay vì gh/git,
// dùng cho integration test spawn thật (xác định exit code theo piped refs). Fixture shape:
//   { origin: "owner/repo", authorizedLogins: ["owner"], prs: { "branch": { number, state,
//     labels, comments, policyVersion, gptApprovers, localApprovers, headRefOid } } }

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { decidePrePushGuard } from './review-contract.mjs';
import { CANONICAL_REPO, resolvePolicyForRepo } from './effective-policy.mjs';

const exec = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} FAIL: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  }
  return res.stdout;
};

const gh = (args) => exec('gh', args);

// [GPT-REV-137] Resolve canonical policy source commit (server-controlled default branch) —
// TÁCH BIỆT khỏi PR HEAD. Không tin caller/PR/process.cwd.
function canonicalSourceCommit() {
  const defaultBranch = String(gh(['api', `repos/${CANONICAL_REPO}`, '--jq', '.default_branch'])).trim();
  if (!defaultBranch || !/^[a-zA-Z0-9._-]+$/.test(defaultBranch)) {
    throw new Error('không resolve được canonical default_branch — fail-closed (GPT-REV-137).');
  }
  const commit = String(gh(['api', `repos/${CANONICAL_REPO}/commits/${defaultBranch}`, '--jq', '.sha'])).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('canonical source commit không phải full 40-hex SHA — fail-closed (GPT-REV-137).');
  }
  return commit;
}

function parseOrigin(repoUrl) {
  const s = String(repoUrl || '').trim();
  let m = s.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^([^/:]+\/[^/:]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

// Đọc comments rich {id, user:{login}, created_at, body} — pattern khớp orchestrator.
function listPrComments(repo, number) {
  const out = gh(['api', `repos/${repo}/issues/${number}/comments`, '--paginate',
    '--jq', `[.[] | ((.id // "")|tostring) + " " + ((.user.login) // "") + " " + ((.created_at) // "-") + " " + ((.body // "") | @base64)] | join("\\n")`]);
  return String(out || '').split('\n').filter(Boolean).map((line) => {
    const parts = line.split(' ');
    return {
      id: parts[0] || '',
      user: { login: parts[1] || '' },
      created_at: parts[2] || '',
      body: Buffer.from(parts.slice(3).join(' '), 'base64').toString('utf8'),
    };
  });
}

function policyApprovers(repo, branch, headSha) {
  try {
    // [GPT-REV-137] Policy AUTHORITY phải đến từ server-resolved canonical default-branch source
    // commit (không tin PR HEAD/headSha làm nguồn policy cho canonical self-review).
    const sourceCommit = canonicalSourceCommit();
    const p = resolvePolicyForRepo({
      repo, ref: headSha, policySourceRef: sourceCommit,
      fetchContent: (r, path, rr) => {
        const b64 = gh(['api', `repos/${r}/contents/${path}?ref=${encodeURIComponent(rr)}`, '--jq', '.content']);
        return Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8');
      },
    });
    const aa = p && p.policy && p.policy.approvalAuthorities;
    return {
      policyVersion: p && p.policy ? p.policy.policyVersion : undefined,
      gptApprovers: aa ? aa.gptApprovalCommentAuthors : undefined,
      localApprovers: aa ? aa.localApprovalCommentAuthors : undefined,
    };
  } catch (e) {
    return { policyVersion: undefined, gptApprovers: undefined, localApprovers: undefined };
  }
}

function main() {
  // [GPT-REV-CHANGES-04] đọc toàn bộ stdin bằng readFileSync(0, 'utf8') — KHÔNG dùng
  // process.stdin.read() (có thể trả rỗng/không đầy đủ trên pipe lớn/đồng bộ).
  let stdin;
  try { stdin = readFileSync(0, 'utf8'); }
  catch (e) { console.error('[pre-push-guard] không đọc được stdin — BLOCK'); process.exit(1); }
    // Mỗi dòng stdin: `<local ref> <local sha> <remote ref> <remote sha>` (các trường cách nhau
  // bằng whitespace — Git dùng tab trên POSIX nhưng space trên Git-for-Windows). Dòng không đủ
  // 4 trường / bất kỳ trường nào rỗng → không parse được ref → BLOCK, không exit 0.
  const rows = String(stdin || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const refs = [];
  for (const line of rows) {
    const parts = line.split(/\s+/);
    if (parts.length < 4 || !parts[0] || !parts[1] || !parts[2] || !parts[3]) {
      console.error(`[pre-push-guard] dòng ref không parse được (cần 4 trường whitespace-separated) — BLOCK: ${JSON.stringify(line)}`);
      process.exit(1);
    }
    refs.push({ localRef: parts[0], localSha: parts[1], remoteRef: parts[2], remoteSha: parts[3] });
  }
  if (refs.length === 0) process.exit(0);

  // Origin: từ git remote get-url (prod) hoặc fixture (test seam). Không resolve → BLOCK exit 1.
  let repo, owner, fixturePrs, fixtureLogins;
  if (process.env.PRE_PUSH_GUARD_FIXTURE) {
    try {
      const fx = JSON.parse(readFileSync(process.env.PRE_PUSH_GUARD_FIXTURE, 'utf8'));
      repo = fx.origin || null;
      owner = repo ? repo.split('/')[0] : '';
      fixturePrs = fx.prs || {};
      fixtureLogins = fx.authorizedLogins || (owner ? [owner] : []);
    } catch (e) {
      console.error(`[pre-push-guard] fixture lỗi — BLOCK: ${(e && e.message) || e}`);
      process.exit(1);
    }
  } else {
    repo = parseOrigin(exec('git', ['remote', 'get-url', 'origin']));
  }
  if (!repo) {
    console.error('[pre-push-guard] không resolve được origin repository — BLOCK (fail-closed, không exit 0)');
    process.exit(1);
  }
  if (!owner) owner = repo.split('/')[0];

  let blocked = null;
  for (const { localRef, localSha } of refs) {
    if (!String(localRef).startsWith('refs/heads/')) continue; // tag/notes: không áp freeze
    // [GPT-REV-CHANGES-04] localSha phải là 40-hex (commit thật); delete ref/toàn zero/rỗng →
    // không parse được ref → BLOCK (không exit 0).
    if (!/^[0-9a-f]{40}$/i.test(String(localSha))) {
      console.error(`[pre-push-guard] localSha không hợp lệ (phải 40-hex): ${JSON.stringify(localSha)} — BLOCK`);
      process.exit(1);
    }
    const branch = String(localRef).slice('refs/heads/'.length);
    let prs = [];
    if (fixturePrs != null) {
      const f = fixturePrs[branch];
      if (f && !f.failed) prs = [{ number: f.number, state: f.state }];
      // branch không có fixture → không có PR open → không áp freeze
    } else {
      try {
        prs = JSON.parse(gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open',
          '--json', 'number,state']));
      } catch (e) {
        console.error(`[pre-push-guard] không đọc được PR list cho ${branch}: ${(e && e.message) || e}`);
        process.exit(2); // fail-closed: không chắc PR state → chặn push
      }
    }
    if (!prs.length) continue; // không có PR open → không áp freeze
    const n = prs[0].number;
    let view, comments, app;
    if (fixturePrs != null) {
      const f = fixturePrs[branch];
      if (f.failed) {
        const r = decidePrePushGuard({ branch, headSha: localSha, pr: { number: n, failed: true } });
        console.error(`[pre-push-guard] ${branch}: ${r.reason}`);
        blocked = blocked || r;
        continue;
      }
      view = { state: f.state, headRefOid: f.headRefOid, labels: f.labels || [] };
      comments = f.comments || [];
      app = { policyVersion: f.policyVersion, gptApprovers: f.gptApprovers, localApprovers: f.localApprovers };
    } else {
      try {
        view = JSON.parse(gh(['pr', 'view', String(n), '--repo', repo, '--json', 'state,headRefOid,labels']));
        comments = listPrComments(repo, n);
        // GPT-REV-099: resolve policy tại remote PR HEAD (view.headRefOid), không tại localSha chưa push
        app = policyApprovers(repo, branch, view.headRefOid);
      } catch (e) {
        const r = decidePrePushGuard({ branch, headSha: localSha, pr: { number: n, failed: true } });
        console.error(`[pre-push-guard] ${branch}: ${r.reason}`);
        blocked = blocked || r;
        continue;
      }
    }
    const r = decidePrePushGuard({
      branch,
      headSha: localSha,
      pr: {
        number: n,
        state: view.state,
        labels: (view.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
        comments,
        repository: repo,
        policyVersion: app.policyVersion,
        gptApprovers: app.gptApprovers,
        localApprovers: app.localApprovers,
      },
      authorizedLogins: fixturePrs != null ? fixtureLogins : [owner],
    });
    if (r.decision === 'block') blocked = blocked || r;
    else console.error(`[pre-push-guard] ${branch}: CHO PHÉP — ${r.reason}`);
  }

  if (blocked) {
    console.error(`[pre-push-guard] ✋ ${blocked.reason}`);
    console.error('[pre-push-guard] Push bị CHẶN nhằm giữ HEAD-Lock (Issue #22). Muốn sửa tiếp sau freeze: comment unfreeze marker hợp lệ rồi push lại.');
    process.exit(1);
  }
  process.exit(0);
}

main();