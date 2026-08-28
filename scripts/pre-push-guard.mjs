#!/usr/bin/env node
// pre-push-guard.mjs — LOCAL pre-push HEAD-Lock guard (Issue #22).
//
// Chạy từ git hook pre-push (stdin: `<local ref>\t<local sha>\t<remote ref>\t<remote sha>` mỗi
// dòng — một dòng cho mỗi ref đang push). Với mỗi branch có PR open, áp decidePrePushGuard:
//   - frozen (approved | review-requested + agent:gpt) + HEAD lệch lock → CHẶN push (exit 1),
//     trừ khi có unfreeze marker hợp lệ (reason + mới hơn lock + authorized author).
//   - chưa frozen / HEAD khớp lock / không có PR / không open → cho phép.
//   - không đọc được trạng thái PR đã biết tồn tại → CHẶN (fail-closed).
//
// Đây là phòng thủ LOCAL (client-side). GitHub không chặn push server-side được ở cấp nhãn —
// server-side protection là Phase follow-up; orchestrator vẫn kiểm tra drift sau push
// (read-before-mutation) như tuyến phòng thủ thứ hai.
//
// Cài: node scripts/setup-pre-push-hook.mjs   (ghi .git/hooks/pre-push cục bộ, không commit)

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { decidePrePushGuard } from './review-contract.mjs';
import { resolvePolicyForRepo } from './effective-policy.mjs';

const exec = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} FAIL: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  }
  return res.stdout;
};

const gh = (args) => exec('gh', args);

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
    const p = resolvePolicyForRepo({
      repo, ref: headSha,
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
  const stdin = String(process.stdin.read() || '');
  const repo = parseOrigin(exec('git', ['remote', 'get-url', 'origin']));
  if (!repo) {
    console.error('[pre-push-guard] không resolve được origin repository — BỎ QUA guard');
    process.exit(0);
  }
  const owner = repo.split('/')[0];
  const lines = stdin.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length >= 2);
  if (lines.length === 0) process.exit(0);

  let blocked = null;
  for (const [localRef, localSha] of lines) {
    if (!String(localRef).startsWith('refs/heads/')) continue;
    const branch = String(localRef).slice('refs/heads/'.length);
    let prs = [];
    try {
      prs = JSON.parse(gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open',
        '--json', 'number,state']));
    } catch (e) {
      console.error(`[pre-push-guard] không đọc được PR list cho ${branch}: ${(e && e.message) || e}`);
      process.exit(2); // fail-closed: không chắc PR state → chặn push
    }
    if (!prs.length) continue; // không có PR open → không áp freeze
    const n = prs[0].number;
    let view, comments;
    try {
      view = JSON.parse(gh(['pr', 'view', String(n), '--repo', repo, '--json', 'state,headRefOid,labels']));
      comments = listPrComments(repo, n);
    } catch (e) {
      const r = decidePrePushGuard({ branch, headSha: localSha, pr: { number: n, failed: true } });
      console.error(`[pre-push-guard] ${branch}: ${r.reason}`);
      blocked = blocked || r;
      continue;
    }
    const app = policyApprovers(repo, branch, localSha);
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
      authorizedLogins: [owner],
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