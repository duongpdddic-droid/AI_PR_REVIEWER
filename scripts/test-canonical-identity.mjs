#!/usr/bin/env node
// test-canonical-identity.mjs — fixture tests cho Canonical Project Identity resolver (Issue #18).
// Pure + exec stub -> deterministic, KHÔNG tạo file/temp (tuân thủ 08-temp-hygiene).
// Exit 0 = PASS, 1 = FAIL.
import path from 'node:path';
import {
  normalizeRemote, gitRemoteOf, canonicalRootOf, worktreeRootContaining,
  resolveCanonicalIdentity, resolveForCapture, resolveForRetrieval, redactIdentity,
  REASON,
} from './canonical-identity.mjs';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });
const falsy = (name, got) => checks.push({ name, ok: !got, got });

const R = (p) => path.resolve(p); // chuẩn hóa path (giả — không tồn tại thật)

// registry fixture: 2 project, sibling worktree A + B (cùng parent P).
const registry = {
  schemaVersion: '1.0',
  projects: [
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER' },
    { projectId: 'cline-e2e', repository: 'duongpdddic-droid/cline-auto-capture-e2e' },
  ],
};

// exec stub: map theo canonical path (path.resolve) — mô phỏng git thật.
const stubExec = ({ toplevels, remotes }) => (args, opts) => {
  const cwd = R((opts && opts.cwd) || '');
  if (args[1] === 'rev-parse' && args[2] === '--show-toplevel') {
    const t = toplevels[cwd];
    if (!t) throw new Error('NOT_A_GIT_REPO');
    return t + '\n';
  }
  if (args[1] === 'remote' && args[2] === 'get-url' && args[3] === 'origin') {
    const r = remotes[cwd];
    if (!r) throw new Error('NO_ORIGIN');
    return r + '\n';
  }
  throw new Error('UNEXPECTED:' + args.join(' '));
};

const PA = R('C:/p/A');
const PB = R('C:/p/B');
const io = {
  exec: stubExec({
    toplevels: { [PA]: 'C:/p/A', [PB]: 'C:/p/B' },
    remotes: {
      [PA]: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git',
      [PB]: 'https://github.com/duongpdddic-droid/cline-auto-capture-e2e.git',
    },
  }),
};

// --- normalizeRemote (các dạng URL) ---
eq('norm https .git', normalizeRemote('https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git'), 'duongpdddic-droid/ai_pr_reviewer');
eq('norm https bare', normalizeRemote('https://github.com/duongpdddic-droid/cline-auto-capture-e2e'), 'duongpdddic-droid/cline-auto-capture-e2e');
eq('norm git@', normalizeRemote('git@github.com:duongpdddic-droid/Soc_brain.git'), 'duongpdddic-droid/soc_brain');
eq('norm www + case', normalizeRemote('https://www.github.com/duongpdddic-droid/QLDA_DTXD/'), 'duongpdddic-droid/qlda_dtxd');
eq('norm ssh://git@', normalizeRemote('ssh://git@github.com:duongpdddic-droid/x.git'), 'duongpdddic-droid/x');
eq('norm trailing slash', normalizeRemote('https://github.com/o/r/'), 'o/r');
eq('norm non-github -> null', normalizeRemote('https://gitlab.com/o/r.git'), null);
eq('norm garbage -> null', normalizeRemote('not a url'), null);
eq('norm empty -> null', normalizeRemote(''), null);

// --- gitRemoteOf + canonicalRootOf ---
eq('gitRemoteOf A', gitRemoteOf(PA, io.exec), 'duongpdddic-droid/ai_pr_reviewer');
eq('canonicalRootOf A = realpath(P/A)', canonicalRootOf(PA, { exec: io.exec }), PA);
falsy('canonicalRootOf non-git -> null', canonicalRootOf(R('C:/not-git'), { exec: io.exec }));
eq('worktreeRootContaining A/src', worktreeRootContaining(path.join(PA, 'src', 'x.js'), { exec: io.exec }), PA);
falsy('worktreeRootContaining ngoài worktree -> null', worktreeRootContaining(R('C:/other/y.js'), { exec: io.exec }));

// --- AC1: session start/restart/compact gán đúng project ---
{
  const r = resolveCanonicalIdentity({ registry, signals: { cwd: PA }, io });
  eq('AC1 resolved (cwd A)', r.status, 'resolved');
  eq('AC1 projectId = ai-pr-reviewer', r.projectId, 'ai-pr-reviewer');
  falsy('AC1 quarantine=false', r.quarantine);
  eq('AC1 reason=RESOLVED', r.reason, REASON.RESOLVED);
}

// --- AC3: stale workspaceRoots[0] KHÔNG thắng registry+remote+real cwd ---
{
  const r = resolveCanonicalIdentity({ registry, signals: { cwd: PA, workspaceRoots: [PB] }, io });
  eq('AC3 stale ws0 -> resolved A', r.status, 'resolved');
  eq('AC3 projectId = ai-pr-reviewer (ws0 không thắng)', r.projectId, 'ai-pr-reviewer');
  tru('AC3 staleWorkspaceRoot flagged', r.resolved.staleWorkspaceRoot);
}

// --- AC4: multi-root -> chọn đúng theo context hoặc no-op an toàn ---
{
  const r = resolveCanonicalIdentity({ registry, signals: { cwd: PA, workspaceRoots: [PA, PB] }, io });
  eq('AC4 multi-root -> ambiguous', r.status, 'ambiguous');
  eq('AC4 reason=AMBIGUOUS_MULTI_ROOT', r.reason, REASON.AMBIGUOUS_MULTI_ROOT);
  tru('AC4 quarantine=true', r.quarantine);
  const r2 = resolveCanonicalIdentity({ registry, signals: { cwd: PB, workspaceRoots: [PB] }, io });
  eq('AC4 cwd B -> resolved cline-e2e', r2.projectId, 'cline-e2e');
}

// --- AC2: file events gán theo canonical containing worktree (cùng worktree -> resolve) ---
{
  const evA = path.join(PA, 'src', 'x.js');
  const r = resolveCanonicalIdentity({ registry, signals: { cwd: PA, eventFile: evA }, io });
  eq('AC2 event trong cùng worktree -> resolved', r.status, 'resolved');
  eq('AC2 projectId = ai-pr-reviewer', r.projectId, 'ai-pr-reviewer');
  falsy('AC2 quarantine=false', r.quarantine);
}

// --- AC5: worktree/sibling repo cùng parent không leak ---
{
  const evB = path.join(PB, 'memory', 'x.md');
  const r = resolveCanonicalIdentity({ registry, signals: { cwd: PA, eventFile: evB }, io });
  eq('AC5 event sibling B vs cwd A -> ambiguous', r.status, 'ambiguous');
  eq('AC5 reason=SIBLING_WORKTREE_LEAK', r.reason, REASON.SIBLING_WORKTREE_LEAK);
  tru('AC5 quarantine=true (không gán A)', r.quarantine);
}

// --- AC6: git remote / registry / cwd mismatch -> status rõ ràng ---
{
  const ioU = {
    exec: stubExec({
      toplevels: { [R('C:/p/D')]: 'C:/p/D' },
      remotes: { [R('C:/p/D')]: 'https://github.com/evil/unknown.git' },
    }),
  };
  const r = resolveCanonicalIdentity({ registry, signals: { cwd: R('C:/p/D') }, io: ioU });
  eq('AC6 wrong-repo -> unregistered', r.status, 'unregistered');
  eq('AC6 reason=UNREGISTERED_REMOTE', r.reason, REASON.UNREGISTERED_REMOTE);
  tru('AC6 quarantine=true', r.quarantine);

  const dupReg = { schemaVersion: '1.0', projects: [
    { projectId: 'a', repository: 'o/same' }, { projectId: 'b', repository: 'o/same' },
  ] };
  const ioD = {
    exec: stubExec({ toplevels: { [R('C:/p/E')]: 'C:/p/E' }, remotes: { [R('C:/p/E')]: 'https://github.com/o/same.git' } }),
  };
  const r2 = resolveCanonicalIdentity({ registry: dupReg, signals: { cwd: R('C:/p/E') }, io: ioD });
  eq('AC6 registry dup remote -> ambiguous', r2.status, 'ambiguous');

  const wrongWsReg = { schemaVersion: '1.0', projects: [
    { projectId: 'ai-pr-reviewer', repository: 'duongpdddic-droid/AI_PR_REVIEWER', workspace: { worktree: 'C:/stale/worktree' } },
  ] };
  const r3 = resolveCanonicalIdentity({ registry: wrongWsReg, signals: { cwd: PA }, io });
  eq('AC6 registry worktree lệch -> ambiguous', r3.status, 'ambiguous');
  eq('AC6 reason=REMOTE_REGISTRY_MISMATCH', r3.reason, REASON.REMOTE_REGISTRY_MISMATCH);
}

// --- no remote / non-git cwd ---
{
  const ioNR = { exec: stubExec({ toplevels: { [R('C:/p/F')]: 'C:/p/F' }, remotes: {} }) };
  const r = resolveCanonicalIdentity({ registry, signals: { cwd: R('C:/p/F') }, io: ioNR });
  eq('NO_REMOTE -> error', r.reason, REASON.NO_REMOTE);
  const ioNG = { exec: stubExec({ toplevels: {}, remotes: {} }) };
  const r2 = resolveCanonicalIdentity({ registry, signals: { cwd: R('C:/not-git') }, io: ioNG });
  eq('non-git cwd -> WORKTREE_UNRESOLVED', r2.reason, REASON.WORKTREE_UNRESOLVED);
}

// --- resolveForCapture: quarantine khi mâu thuẫn, không inject từ project khác ---
{
  const cA = resolveForCapture({ registry, signals: { cwd: PA }, io });
  tru('capture A ok', cA.ok);
  eq('capture A projectId', cA.projectId, 'ai-pr-reviewer');
  const cB = resolveForCapture({ registry, signals: { cwd: PB }, io });
  eq('capture B projectId = cline-e2e (không phải A)', cB.projectId, 'cline-e2e');
  const cAmb = resolveForCapture({ registry, signals: { cwd: PA, workspaceRoots: [PA, PB] }, io });
  falsy('capture multi-root -> not ok', cAmb.ok);
  tru('capture multi-root -> quarantine', cAmb.quarantine);
}

// --- resolveForRetrieval: explicit read-only search yêu cầu project canonical ---
{
  const ok = resolveForRetrieval({ registry, projectId: 'ai-pr-reviewer', signals: { cwd: PA }, io });
  tru('retrieval đúng project -> allowed', ok.allowed);
  const leak = resolveForRetrieval({ registry, projectId: 'cline-e2e', signals: { cwd: PA }, io });
  falsy('retrieval project B từ cwd A -> NOT allowed (không leak)', leak.allowed);
  eq('retrieval lệch -> IDENTITY_MISMATCH', leak.reason, REASON.IDENTITY_MISMATCH);
  const unknown = resolveForRetrieval({ registry, projectId: 'nope', signals: { cwd: PA }, io });
  falsy('retrieval project chưa đăng ký -> NOT allowed', unknown.allowed);
  eq('retrieval unknown -> PROJECT_NOT_REGISTERED', unknown.reason, REASON.PROJECT_NOT_REGISTERED);
  const none = resolveForRetrieval({ registry, signals: { cwd: PA }, io });
  falsy('retrieval thiếu projectId -> NOT allowed', none.allowed);
}

// --- redact home + absolute path ---
{
  const home = R('C:/Users/Admin');
  const out = redactIdentity({ sources: { cwd: R('C:/Users/Admin/.cline/AI_PR_REVIEWER') }, reason: 'X' }, { home });
  tru('redact home -> ~', out.sources.cwd.startsWith('~'));
}

// --- AC9 negative: project A không nhận observation/artifact của B ---
{
  const cA = resolveForCapture({ registry, signals: { cwd: PA }, io });
  const cB = resolveForCapture({ registry, signals: { cwd: PB }, io });
  tru('AC9 capture A != B', cA.projectId !== cB.projectId);
  falsy('AC9 capture A không phải B', cA.projectId === 'cline-e2e');
  const r = resolveCanonicalIdentity({ registry, signals: { cwd: PA, eventFile: path.join(PB, 'f.md') }, io });
  tru('AC9 event B không gán A', r.projectId !== 'ai-pr-reviewer');
  tru('AC9 event B -> quarantine', r.quarantine);
}

let fail = 0;
for (const c of checks) {
  if (!c.ok) { fail++; console.log(`FAIL: ${c.name} | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`); }
}
console.log(`canonical-identity fixture: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);

