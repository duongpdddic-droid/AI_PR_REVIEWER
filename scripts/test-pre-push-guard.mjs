#!/usr/bin/env node
// test-pre-push-guard.mjs — integration test spawn THẬT pre-push-guard.mjs với stdin refs piped
// (Issue #22, [GPT-REV-CHANGES-04]).
//   - đọc toàn bộ stdin bằng readFileSync(0) → frozen drift phải exit != 0;
//   - origin không resolve được → exit 1 (fail-closed, không exit 0);
//   - ref không parse được (thiếu trường/không 40-hex) → exit != 0;
//   - không PR open / unfreeze hợp lệ → exit 0.
// Dùng fixture qua env PRE_PUSH_GUARD_FIXTURE (test seam gated — không set trong prod) thay cho
// gh/git network. Session tạm qua temp-hygiene (rule 08), cleanup trong finally.
// Exit 0 = PASS, 1 = FAIL.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionManager } from './temp-hygiene.mjs';
import { decidePrePushGuard, collectPreReviewPassRecords, isPreReviewPassCanonical } from './review-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = path.join(ROOT, 'scripts', 'pre-push-guard.mjs');
const node = process.execPath;

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const KEY = (sha, repo = 'o/r', pr = 7, pv = 'v1') =>
  `<!-- ai-pr-reviewer:key=${repo}::${pr}::${sha}::${pv}::pre-review:PRE_REVIEW_PASS -->`;
const PASS = (sha, at = '2026-08-23T01:00:00Z') => ({
  id: `p-${sha.slice(0, 4)}`,
  user: { login: 'duongpdddic-droid' },
  created_at: at,
  body: `✅ local pre-review PASS\n${KEY(sha)} <!-- ai-pr-reviewer:pre-review=PRE_REVIEW_PASS:${sha} -->`,
});
const UF = (at = '2026-08-23T02:00:00Z') => ({
  id: 'uf-1',
  user: { login: 'duongpdddic-droid' },
  created_at: at,
  body: '🔓 user push override\n<!-- ai-pr-reviewer:unfreeze:reason=fix GPT findings -->',
});

const mgr = createSessionManager({ projectRoot: ROOT, purpose: 'test-pre-push-guard' });
let fail = 0;

const runGuard = (fixture, stdin) => {
  const fxPath = mgr.createFile(`fx-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(fixture));
  const r = spawnSync(node, [guard], {
    encoding: 'utf8',
    env: { ...process.env, PRE_PUSH_GUARD_FIXTURE: fxPath },
    input: stdin, // pipe refs vào stdin tiến trình con (guard đọc readFileSync(0))
  });
  if (r.status !== 0 || r.error) { console.error(`[guard stderr] ${JSON.stringify(r.stderr || String(r.error))}`); }
  return r.status;
};

try {
  const basePr = {
    number: 7, state: 'open', headRefOid: A,
    labels: ['status:review-requested', 'agent:gpt'],
    policyVersion: 'v1',
    gptApprovers: ['duongpdddic-droid'],
    localApprovers: ['duongpdddic-droid'],
  };

  // 1. frozen drift: PASS khóa A, local push B → BLOCK (exit 1)
  {
    const fx = {
      origin: 'o/r', authorizedLogins: ['duongpdddic-droid'],
      prs: { 'feat/x': { ...basePr, comments: [PASS(A)] } },
    };
    eq('I.G1 frozen drift (PASS khóa A, push B) → exit != 0',
      runGuard(fx, `refs/heads/feat/x\t${B}\trefs/heads/feat/x\t${A}\n`) !== 0, true);
  }

  // 2. HEAD khớp lock (uncommitted) → allow exit 0
  {
    const fx = {
      origin: 'o/r', authorizedLogins: ['duongpdddic-droid'],
      prs: { 'feat/x': { ...basePr, comments: [PASS(A)] } },
    };
    eq('I.G2 HEAD khớp lock → exit 0',
      runGuard(fx, `refs/heads/feat/x\t${A}\trefs/heads/feat/x\t${A}\n`) === 0, true);
    // debug: eval canonical trực tiếp trên cùng fixture
    {
      const recs = collectPreReviewPassRecords(fx.prs['feat/x'].comments);
      const e0 = recs[0];
      const bodyT = String(e0.body || '');
      const ms = 'ai-pr-reviewer:key=';
      const ks = bodyT.indexOf(ms);
      const ke = bodyT.indexOf(' -->', ks + ms.length);
      const k = ks === -1 || ke === -1 ? '' : bodyT.slice(ks + ms.length, ke);
      console.error('[dbg] ks:', ks, 'ke:', ke, 'key:', JSON.stringify(k));
      console.error('[dbg] expected:', JSON.stringify([fx.origin, String(fx.prs['feat/x'].number), e0.sha, String(fx.prs['feat/x'].policyVersion), 'pre-review:PRE_REVIEW_PASS'].join('::')));
      console.error('[dbg] authorIn:', JSON.stringify((fx.prs['feat/x'].localApprovers || []).includes(e0.authorLogin)), 'commentId:', JSON.stringify(e0.commentId));
      console.error('[dbg] decide:', JSON.stringify(decidePrePushGuard({ branch: 'feat/x', headSha: A, pr: { number: 7, state: 'open', labels: fx.prs['feat/x'].labels, comments: fx.prs['feat/x'].comments, repository: 'o/r', policyVersion: 'v1', gptApprovers: ['duongpdddic-droid'], localApprovers: ['duongpdddic-droid'] }, authorizedLogins: ['duongpdddic-droid'] })));
    }
  }

  // 3. unfreeze hợp lệ (mới hơn lock + authorized author) → allow exit 0
  {
    const fx = {
      origin: 'o/r', authorizedLogins: ['duongpdddic-droid'],
      prs: { 'feat/x': { ...basePr, comments: [PASS(A), UF()] } },
    };
    eq('I.G3 unfreeze hợp lệ → exit 0',
      runGuard(fx, `refs/heads/feat/x\t${B}\trefs/heads/feat/x\t${A}\n`) === 0, true);
  }

  // 4. không resolve được origin (fixture origin thiếu) → BLOCK exit 1
  {
    const fx = {
      origin: null, authorizedLogins: ['duongpdddic-droid'],
      prs: { 'feat/x': basePr },
    };
    eq('I.G4 origin không resolve → exit != 0',
      runGuard(fx, `refs/heads/feat/x\t${A}\trefs/heads/feat/x\t${A}\n`) !== 0, true);
  }

  // 5. ref không parse được (thiếu trường) → BLOCK exit != 0
  {
    const fx = { origin: 'o/r', authorizedLogins: ['duongpdddic-droid'], prs: {} };
    eq('I.G5 dòng ref thiếu trường → exit != 0',
      runGuard(fx, `refs/heads/feat/x\t${A}\n`) !== 0, true);
  }

  // 6. localSha không 40-hex (delete ref toàn zero) trên branch có PR frozen → BLOCK exit != 0
  {
    const fx = {
      origin: 'o/r', authorizedLogins: ['duongpdddic-droid'],
      prs: { 'feat/x': { ...basePr, comments: [PASS(A)] } },
    };
    eq('I.G6 localSha không 40-hex → exit != 0',
      runGuard(fx, `refs/heads/feat/x\t${'0'.repeat(40)}\trefs/heads/feat/x\t${A}\n`) !== 0, true);
  }

  // 7. không có PR open cho branch → allow exit 0
  {
    const fx = { origin: 'o/r', authorizedLogins: ['duongpdddic-droid'], prs: {} };
    eq('I.G7 không PR open → exit 0',
      runGuard(fx, `refs/heads/feat/x\t${B}\trefs/heads/feat/x\t${A}\n`) === 0, true);
  }
} finally {
  const res = mgr.cleanup();
  if (res && res.verdict && res.verdict !== 'CLEAN') {
    console.error(`cleanup không sạch: ${res.verdict}`);
    fail++;
  }
}

console.log('\n=== TEST PRE-PUSH GUARD (integration spawn) ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);
