#!/usr/bin/env node
// extract-behavior-map.mjs (phiên bản générique AI_PR_REVIEWER)
// Quét toàn bộ file .js/.mjs du projet (scripts/ + src/ + gốc), xuất
// scripts/behavior-map-current.json: { name: { file, startLine, endLine, summary } }.
// CHỈ công cụ tra cứu (lookup) — thay vì đọc lại toàn file pour dò hàm/id.
// Không a dependency ngoài (Node stdlib fs/path).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function matchBraceClose(src, openIdx) {
  let depth = 0, i = openIdx, inS = null, inLine = false, inBlock = false, tpl = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (inS) {
      if (c === '\\') { i += 2; continue; }
      if (inS === '`' && c === '$' && n === '{') { tpl++; i += 2; continue; }
      if (inS === '`' && c === '}' && tpl > 0) { tpl--; i++; continue; }
      if (c === inS && tpl === 0) { inS = null; i++; continue; }
      i++; continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function bodyOpen(src, fromIdx, kind) {
  if (kind === 'function') {
    let i = src.indexOf('(', fromIdx);
    if (i === -1) return -1;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.indexOf('{', i);
  }
  const fi = src.indexOf('function', fromIdx);
  const ai = src.indexOf('=>', fromIdx);
  if (fi !== -1 && (ai === -1 || fi < ai)) {
    let i = src.indexOf('(', fi), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.indexOf('{', i);
  }
  if (ai !== -1) return src.indexOf('{', ai);
  return -1;
}

function summaryOf(srcLines, bodyStartLine) {
  for (let k = bodyStartLine; k < srcLines.length; k++) {
    const t = srcLines[k - 1].trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t === '{') continue;
    return t.length > 110 ? t.slice(0, 107) + '...' : t;
  }
  return '';
}

function lineToCharOffset(srcLines, lineNo, name) {
  let off = 0;
  for (let l = 0; l < lineNo - 1; l++) off += srcLines[l].length + 1;
  const idx = srcLines[lineNo - 1].indexOf(name);
  return off + (idx === -1 ? 0 : idx);
}

function findFunctions(src, fileLabel) {
  const lines = src.split('\n');
  const out = {};
  const order = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s/.test(line)) continue;
    let m = line.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
    let kind = 'function';
    if (!m) { m = line.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|\()/); kind = 'arrow'; }
    if (!m) continue;
    const name = m[1];
    const off = lineToCharOffset(lines, li + 1, name);
    const bo = bodyOpen(src, off, kind);
    if (bo === -1) continue;
    const close = matchBraceClose(src, bo);
    if (close === -1) continue;
    const endLine = src.slice(0, close + 1).split('\n').length;
    const key = out[name] ? `${name}@${fileLabel}` : name;
    out[key] = { file: fileLabel, startLine: li + 1, endLine, summary: summaryOf(lines, li + 2) };
    order.push(key);
  }
  return { out, order };
}

// Vue scope fichiers du projet (hors node_modules/.git).
function projectFiles() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(p);
      } else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) {
        if (path.relative(ROOT, p).split(path.sep).join('/') === 'scripts/behavior-map-current.json') continue;
        files.push(p);
      }
    }
  };
  walk(ROOT);
  return files.sort();
}

export function buildBehaviorMap(files) {
  const map = {};
  const order = [];
  const merge = (out) => {
    for (const [k, v] of Object.entries(out)) {
      const key = map[k] ? `${k}@${v.file}` : k;
      map[key] = v;
      order.push(key);
    }
  };
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const { out } = findFunctions(src, rel);
    merge(out);
  }
  return { map, order };
}

// Refresh scripts/behavior-map-current.json depuis source tại ROOT.
// Ghi LF ổn định, không BOM.
export function refreshBehaviorMap() {
  const files = projectFiles().filter((f) => !f.endsWith('behavior-map-current.json'));
  const { map, order } = buildBehaviorMap(files);
  const out = path.join(ROOT, 'scripts', 'behavior-map-current.json');
  fs.writeFileSync(out, JSON.stringify(map, null, 2) + '\n');
  return { count: order.length, out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const r = refreshBehaviorMap();
  console.log(`behavior-map-current.json: ${r.count} hàm -> ${path.relative(ROOT, r.out)}`);
}