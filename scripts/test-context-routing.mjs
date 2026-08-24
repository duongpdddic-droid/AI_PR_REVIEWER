#!/usr/bin/env node
// test-context-routing.mjs — Context routing/module tests (Issue #6 B4).
// Assert-based (AAA), không framework, không phụ thuộc thứ tự.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextRoutingError, loadManifest, routeContext } from './context-router.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${(e && e.message) || e}`); process.exitCode = 1; }
};

const ROOT = process.cwd();
const manifest = loadManifest(ROOT);
const REAL = { root: ROOT };

// 1. Happy path thật: đọc manifest + modules từ repo root.
{
  const r = routeContext(manifest, { repo: 'duongpdddic-droid/AI_PR_REVIEWER', taskType: 'coder-task' }, REAL);
  const names = r.modules.map((m) => m.name);
  assert.ok(names.includes('_invariants'), 'invariants luôn được tải');
  assert.ok(names.includes('coder') && names.includes('github-workflow'), 'coder-task tải đúng module');
  assert.ok(!names.includes('reviewer'), 'task coder KHÔNG tải module reviewer');
  assert.ok(!names.includes('telegram'), 'task coder KHÔNG tải module telegram');
  assert.ok(!names.includes('project-qlda'), 'repo AI_PR_REVIEWER KHÔNG tự tải project-qlda');
}

// 2. Reviewer luôn nhận approval invariants: mọi taskType đều có _invariants đứng đầu.
for (const taskType of Object.keys(manifest.routing)) {
  const r = routeContext(manifest, { repo: null, taskType }, REAL);
  assert.equal(r.modules[0].name, '_invariants', `${taskType}: invariant đầu tiên`);
  assert.ok(r.modules.some((m) => m.name === '_invariants'), `${taskType}: có invariants`);
}

// 3. Repo QLDA tự tải project module; repo khác thì không.
{
  const q = routeContext(manifest, { repo: 'duongpdddic-droid/QLDA_DTXD', taskType: 'coder-task' }, REAL);
  assert.ok(q.modules.some((m) => m.name === 'project-qlda'), 'QLDA_DTXD tự tải project-qlda');
  const a = routeContext(manifest, { repo: 'duongpdddic-droid/AI_PR_REVIEWER', taskType: 'coder-task' }, REAL);
  assert.ok(!a.modules.some((m) => m.name === 'project-qlda'), 'AI_PR_REVIEWER không tải project-qlda');
}

// 4. Module thiếu trên disk -> BLOCKED_MODULE_MISSING (fail-closed).
{
  const io = { root: ROOT, exists: () => false, readFile: () => '' };
  assert.throws(() => routeContext(manifest, { repo: null, taskType: 'coder-task' }, io),
    (e) => e instanceof ContextRoutingError && e.code === 'BLOCKED_MODULE_MISSING');
}

// 5. Stale module (file version != manifest version) không thắng canonical -> BLOCKED_MODULE_VERSION_STALE.
{
  const stale = { root: ROOT, exists: () => true, readFile: () => '<!-- module-version: 99 -->\nnoi dung cu' };
  assert.throws(() => routeContext(manifest, { repo: null, taskType: 'coder-task' }, stale),
    (e) => e instanceof ContextRoutingError && e.code === 'BLOCKED_MODULE_VERSION_STALE');
}

// 6. Prompt/context budget không vượt giới hạn policy cấu hình -> BLOCKED_BUDGET_EXCEEDED.
{
  const tight = JSON.parse(JSON.stringify(manifest));
  tight.budget.maxTokensPerTask = 1;
  assert.throws(() => routeContext(tight, { repo: null, taskType: 'reviewer-task' }, REAL),
    (e) => e instanceof ContextRoutingError && e.code === 'BLOCKED_BUDGET_EXCEEDED');
}

// 7. Routing không xác định -> BLOCKED_TASK_TYPE_UNKNOWN.
assert.throws(() => routeContext(manifest, { repo: null, taskType: 'deploy-prod' }, REAL),
  (e) => e instanceof ContextRoutingError && e.code === 'BLOCKED_TASK_TYPE_UNKNOWN');

console.log(`\ncontext-routing: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);
