#!/usr/bin/env node
// find-in-map.mjs <tên-hàm-hoặc-id> — tra nhanh 1 tên trong behavior-map-current.json.
// In ra file + dòng bắt đầu/kết thúc + tóm tắt 1 dòng. Chỉ công cụ tra cứu.
// Dùng: node scripts/find-in-map.mjs <tên>
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const q = (process.argv[2] || '').toLowerCase();
const MAP = path.join(ROOT, 'scripts', 'behavior-map-current.json');

if (!q) { console.error('Dùng: node scripts/find-in-map.mjs <tên-hàm-hoặc-id>'); process.exit(2); }
if (!fs.existsSync(MAP)) {
  console.error('Chưa có behavior-map-current.json. Chạy trước: node scripts/extract-behavior-map.mjs');
  process.exit(3);
}
const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const hits = Object.entries(map).filter(([k, v]) =>
  k.toLowerCase().includes(q) || (v.summary || '').toLowerCase().includes(q));
if (!hits.length) { console.log(`Không tìm thấy "${q}" trong behavior map.`); process.exit(1); }
for (const [k, v] of hits) {
  console.log(`${k}\n  file:    ${v.file}\n  dòng:    ${v.startLine}-${v.endLine}\n  tóm tắt: ${v.summary}\n`);
}
