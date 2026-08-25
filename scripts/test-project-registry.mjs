#!/usr/bin/env node
// test-project-registry.mjs — integration tests cho Project Registry + versioned manifest (Issue #14).
// KHÔNG framework. Exit 0 = PASS, 1 = FAIL.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  validateManifest, scanForSecrets, scanForAbsolutePaths,
  loadRegistry, saveRegistry, detectConflicts, assertWorkspaceRemote,
  registerProject, migrateManifest, assertSingleOwner, registryOutsideWorktree,
  OWNERSHIP_MATRIX, isAllowedOverride, DEFAULT_REGISTRY_PATH,
  CANONICAL_POLICY_VERSION, SCHEMA_PATH,
} from './project-registry.mjs';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });
const falsy = (name, got) => checks.push({ name, ok: !got, got });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(DIR, 'fixtures', 'project-registry');
const load = (f) => JSON.parse(readFileSync(path.join(FX, f), 'utf8'));
const tmpPath = path.join(os.tmpdir(), `reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

// AC1: schema versioned + fail-closed thiếu repo identity.
{
  const valid = load('ai-pr-reviewer.json');
  tru('AC1 valid manifest pass', validateManifest(valid).ok);
  const noRepo = { ...valid }; delete noRepo.repository;
  falsy('AC1 thiếu repository -> reject', validateManifest(noRepo).ok);
  const noId = { ...valid }; delete noId.projectId;
  falsy('AC1 thiếu projectId -> reject', validateManifest(noId).ok);
  const badRepo = { ...valid, repository: 'not-a-repo' };
  falsy('AC1 repository sai định dạng -> reject', validateManifest(badRepo).ok);
}

// AC2: registry phát hiện duplicate projectId / telegramRoute / workspace trùng.
{
  const reg = { schemaVersion: '1.0', projects: [load('ai-pr-reviewer.json')] };
  const dup = load('duplicate-id.json');
  const c = detectConflicts({ registry: reg, manifest: dup });
  tru('AC2 phát hiện duplicate projectId', c.some((x) => x.type === 'projectId'));
  const sameRoute = { ...load('generic.json'), telegram: { route: 'dm-boss' }, projectId: 'x1' };
  const c2 = detectConflicts({ registry: reg, manifest: sameRoute });
  tru('AC2 phát hiện duplicate telegramRoute', c2.some((x) => x.type === 'telegramRoute'));
  const sameWs = { ...load('generic.json'), workspace: { workspaceId: 'ai-pr-reviewer-main' }, projectId: 'x2' };
  const c3 = detectConflicts({ registry: reg, manifest: sameWs });
  tru('AC2 phát hiện duplicate workspaceId', c3.some((x) => x.type === 'workspaceId'));
}

// AC3: workspace remote phải khớp manifest trước mutation.
{
  const m = load('ai-pr-reviewer.json');
  tru('AC3 remote khớp -> ok', assertWorkspaceRemote({ manifest: m, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' }).ok);
  falsy('AC3 remote lệch -> reject', assertWorkspaceRemote({ manifest: m, actualRemote: 'https://github.com/evil/repo.git' }).ok);
  const w = load('wrong-remote.json');
  falsy('AC3 wrong-remote fixture mismatch', assertWorkspaceRemote({ manifest: w, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' }).ok);
}

// AC4: secrets + absolute paths không commit trong manifest.
{
  const withSecret = { repository: 'o/r', projectId: 'p', workspace: { workspaceId: 'w' }, secret: "apiKey = 'AKIAIOSFODNN7EXAMPLE'" };
  tru('AC4 phát hiện secret', scanForSecrets(withSecret).length >= 1);
  falsy('AC4 manifest chứa secret -> reject', validateManifest(withSecret).ok);
  const withAbs = { repository: 'o/r', projectId: 'p', workspace: { workspaceId: 'w' }, path: 'C:\\Users\\x\\cfg.json' };
  tru('AC4 phát hiện absolute path', scanForAbsolutePaths(withAbs).length >= 1);
  falsy('AC4 manifest chứa absolute path -> reject', validateManifest(withAbs).ok);
}

// AC5: machine registry lưu path local ngoài Git (default path không nằm trong cwd).
{
  const r = registryOutsideWorktree(DEFAULT_REGISTRY_PATH, process.cwd());
  tru('AC5 registry mặc định ngoài worktree', r.outside);
  const inside = registryOutsideWorktree(path.join(process.cwd(), '.agent', 'registry.json'), process.cwd());
  falsy('AC5 path trong worktree -> inside', inside.outside);
}

// AC6: migration N->N+1 và rollback.
{
  const stale = load('stale-schema.json');
  falsy('AC6 stale schema chưa migrate -> reject', validateManifest(stale).ok);
  const up = migrateManifest({ manifest: stale, toVersion: '1.0' });
  eq('AC6 migrate up direction', up.direction, 'up');
  tru('AC6 migrated manifest valid', validateManifest(up.manifest).ok);
  const down = migrateManifest({ manifest: up.manifest, toVersion: '0.9' });
  eq('AC6 rollback direction', down.direction, 'down');
  eq('AC6 rollback giữ projectId', down.manifest.projectId, 'legacy-proj');
}

// AC7: platform capability đúng 1 canonical owner.
{
  const s = assertSingleOwner(OWNERSHIP_MATRIX);
  tru('AC7 mỗi capability 1 owner', s.ok);
  const dup = [...OWNERSHIP_MATRIX, OWNERSHIP_MATRIX[0]];
  falsy('AC7 trùng capability -> fail', assertSingleOwner(dup).ok);
}

// AC8: overrides giới hạn allowlist.
{
  tru('AC8 allowlist chứa policy', isAllowedOverride('policy'));
  falsy('AC8 override ngoài allowlist -> reject', isAllowedOverride('secret'));
  const m = load('ai-pr-reviewer.json');
  m.allowedOverrides = ['policy', 'hack'];
  falsy('AC8 manifest override trái phép -> reject', validateManifest(m).ok);
}

// AC9: fixtures valid (AI_PR, QLDA, generic) + load/save roundtrip + conflict.
{
  for (const f of ['ai-pr-reviewer.json', 'qlda-dtxd.json', 'generic.json']) {
    tru('AC9 ' + f + ' valid', validateManifest(load(f)).ok);
  }
  const reg = { schemaVersion: '1.0', projects: [] };
  const res = registerProject({ manifest: load('ai-pr-reviewer.json'), registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' });
  tru('AC9 register ai-pr-reviewer', res.ok);
  const dupRes = registerProject({ manifest: load('duplicate-id.json'), registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/another-org/duplicate-project.git' });
  falsy('AC9 duplicate id -> conflict', dupRes.ok);
  const reloaded = loadRegistry({ registryPath: tmpPath });
  tru('AC9 roundtrip load', reloaded.projects.length === 1 && reloaded.projects[0].projectId === 'ai-pr-reviewer');
}

// AC10: idempotent re-registration + secret-in-key + unsupported version + route uniqueness + rollback preserves data.
{
  const reg = { schemaVersion: '1.0', projects: [] };
  const m1 = load('ai-pr-reviewer.json');
  const r1 = registerProject({ manifest: m1, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' });
  tru('AC10 register lần 1', r1.ok);
  const r2 = registerProject({ manifest: m1, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' });
  tru('AC10 register lại cùng project -> idempotent', r2.ok);
  const withApiKey = { ...m1, apiKey: 'sk-1234567890abcdef' };
  tru('AC10 phát hiện secret trong key apiKey', scanForSecrets(withApiKey).length >= 1);
  falsy('AC10 manifest có key apiKey -> reject', validateManifest(withApiKey).ok);
  const withBotToken = { ...m1, botToken: 'AKIAIOSFODNN7EXAMPLE' };
  tru('AC10 phát hiện secret trong key botToken', scanForSecrets(withBotToken).length >= 1);
  const future = { ...m1, schemaVersion: '2.0' };
  falsy('AC10 schemaVersion tương lai -> reject', validateManifest(future).ok);
  const other = { ...load('generic.json'), projectId: 'other-proj', repository: 'other/proj', telegram: { route: 'dm-boss' }, workspace: { workspaceId: 'other-ws' } };
  const rc = registerProject({ manifest: other, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/other/proj.git' });
  falsy('AC10 different project cùng route -> conflict', rc.ok);
  const stale = load('stale-schema.json');
  const up = migrateManifest({ manifest: stale, toVersion: '1.0' });
  tru('AC10 up direction', up.direction === 'up');
  const down = migrateManifest({ manifest: up.manifest, toVersion: '0.9' });
  eq('AC10 rollback direction', down.direction, 'down');
  eq('AC10 rollback schemaVersion', down.manifest.schemaVersion, '0.9');
  // [GPT-REV-073] round-trip lossless: down(up(original)) === original.
  eq('AC10 rollback khôi phục nguyên bản (lossless)', JSON.stringify(down.manifest), JSON.stringify(stale));
}

// AC11: [GPT-REV-069] gate policy version đối chiếu canonical; [GPT-REV-070] schema nested fail-closed.
{
  const ROOT = path.resolve(DIR, '..');
  const canonical = JSON.parse(readFileSync(path.join(ROOT, '.github', 'ai-review-policy.json'), 'utf8'));
  eq('AC11 canonical policyVersion khớp hằng CANONICAL_POLICY_VERSION', canonical.policyVersion, CANONICAL_POLICY_VERSION);
  const badPV = { ...load('ai-pr-reviewer.json'), policy: { pin: 'ai-review-policy.json', version: '2026-08-22.6' } };
  const r = validateManifest(badPV);
  falsy('AC11 policy version lệch canonical -> reject', r.ok);
  tru('AC11 sinh POLICY_VERSION_MISMATCH', r.errors.some((e) => e.startsWith('POLICY_VERSION_MISMATCH')));
  tru('AC11 policy version đúng canonical -> pass', validateManifest(load('ai-pr-reviewer.json')).ok);
  // nested required: thiếu policy.version -> schema reject.
  const noPolVer = { ...load('ai-pr-reviewer.json') }; delete noPolVer.policy.version;
  const r2 = validateManifest(noPolVer);
  tru('AC11 nested thiếu policy.version -> SCHEMA_MISSING_POLICY_VERSION', r2.errors.includes('SCHEMA_MISSING_POLICY_VERSION'));
  // nested type: telegram.route phải là string.
  const badTel = { ...load('ai-pr-reviewer.json'), telegram: { route: 123 } };
  const r3 = validateManifest(badTel);
  tru('AC11 nested telegram.route sai type -> SCHEMA_TYPE_TELEGRAM', r3.errors.some((e) => e.startsWith('SCHEMA_TYPE_TELEGRAM')));
  // schema file hợp lệ (guard không corrupt -> không rơi vào MANIFEST_SCHEMA_UNAVAILABLE).
  const schemaOk = (() => { try { JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')); return true; } catch { return false; } })();
  tru('AC11 schema file hợp lệ (guard)', schemaOk);
}

const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log(`\nTổng: ${pass}/${checks.length} PASS`);
process.exit(pass === checks.length ? 0 : 1);

