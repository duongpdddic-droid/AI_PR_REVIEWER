#!/usr/bin/env node
// test-protocol-drift.mjs — Protocol drift/duplicate detection (Issue #6 C2, kế thừa #5).
// Phát hiện:
//   1) Mirror policy: file JSON nào ngoài .github/ai-review-policy.json chứa "projectPolicyContract".
//   2) Câu quy tắc nguyên văn (>=80 ký tự) bị nhân bản giữa docs/AGENT_HANDOFF_PROTOCOL.md (canonical)
//      và các nguồn hướng dẫn khác (root *.md, docs/, .agent/, .clinerules/) — bỏ code fence.
// Fail = exit 1 với danh sách drift.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CANONICAL_POLICY = '.github/ai-review-policy.json';
const CANONICAL_PROTOCOL = path.join('docs', 'AGENT_HANDOFF_PROTOCOL.md');

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}: ${(e && e.message) || e}`); process.exitCode = 1; }
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'pr-reviewer-worktrees', 'coder-workspace', 'reviewer-workspace']);

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), exts, out); }
    else if (exts.some((x) => e.name.endsWith(x))) out.push(path.join(dir, e.name));
  }
  return out;
}

const stripFences = (s) => s.replace(/```[\s\S]*?```/g, ' ');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const sentencesOf = (file) => stripFences(fs.readFileSync(file, 'utf8'))
  .split(/(?<=[.:!?])\s+|\n+/)
  .map(norm)
  .filter((s) => s.length >= 80);

// 1. Không mirror canonical policy ngoài vị trí canonical.
{
  const jsonFiles = walk(ROOT, ['.json']).map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
    .filter((p) => p !== CANONICAL_POLICY && !p.endsWith('pnpm-lock.yaml'));
  const mirrors = [];
  for (const rel of jsonFiles) {
    try {
      const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (raw.includes('"projectPolicyContract"') || raw.includes("'projectPolicyContract'")) mirrors.push(rel);
    } catch { /* binary/không đọc được -> bỏ qua */ }
  }
  assert.deepEqual(mirrors, [], `mirror canonical policy tại: ${mirrors.join(', ')}`);
}

// 2. Không câu quy tắc >=80 ký tự trùng nguyên văn giữa protocol canonical và nguồn khác.
{
  const canonSet = new Set(sentencesOf(path.join(ROOT, CANONICAL_PROTOCOL)));
  const sources = walk(ROOT, ['.md'])
    .filter((p) => path.relative(ROOT, p).split(path.sep).join('/') !== 'docs/AGENT_HANDOFF_PROTOCOL.md')
    // memory-bank/review-state là trạng thái thực thi, không phải nguồn quy tắc.
    .filter((p) => !p.split(path.sep).includes('memory-bank'))
    .filter((p) => !p.endsWith('review-comment.md'));
  const dupes = [];
  for (const f of sources) {
    const rel = path.relative(ROOT, f);
    if (!rel.startsWith('.clinerules') && !rel.startsWith('docs') && !rel.startsWith('.agent')
      && path.dirname(rel) !== '.') continue; // chỉ so nguồn rule chính thức
    for (const s of new Set(sentencesOf(f))) {
      if (canonSet.has(s)) dupes.push(`${rel}: "${s.slice(0, 60)}..."`);
    }
  }
  assert.deepEqual(dupes, [], `câu quy tắc nhân bản từ canonical protocol:\n${dupes.join('\n')}`);
}

console.log(`\nprotocol-drift: ${passed} PASS${process.exitCode ? ' (có FAIL)' : ''}`);
