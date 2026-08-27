#!/usr/bin/env node
// test-temp-hygiene.mjs — assert-based self-check cho scripts/temp-hygiene.mjs.
// Cover: PASS cleanup, FAILURE (POC_CLEANUP_FAILED), TIMEOUT process, RECOVERY theo sessionId,
//        pid-scoped kill, path/ownership safety. Exit 0 = PASS, 1 = FAIL.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  isSafeSessionId, isInside, hasOwnershipMarker, redactHome, isAlive,
  createSessionManager, recoverSession,
} from './temp-hygiene.mjs';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
// child ở lại, không tự thoát; script nhúng identity = sessionId để verifyProcessIdentity khớp.
const tickFor = (id) => `setInterval(()=>{},1<<30);process.env.TH=${JSON.stringify(id)};`;

// temp root dùng riêng cho test, ngoài repo.
const ROOT2 = path.join(os.tmpdir(), `tmp-hygiene-test-${Date.now()}`);
const alive = []; // các child còn phải; dọn sau cùng nếu sót

// --- validators ---
eq('isSafeSessionId hex ok', isSafeSessionId('abcdef1234567890'), true);
eq('isSafeSessionId upper bị từ chối', isSafeSessionId('ABCD'.repeat(4)), false);
eq('isSafeSessionId ký tự lạ bị từ chối', isSafeSessionId('abc!def'), false);
tru('isInside child đúng', isInside('/a/b', '/a/b/c'));
eq('isInside root chính /false', isInside('/a/b', '/a/b'), false);
eq('isInside sibling false', isInside('/a/b', '/a/c'), false);

// chặn temp root đặt trong repo/workspace thật
try {
  createSessionManager({ tempRoot: ROOT, projectRoot: ROOT });
  tru('createSession tempRoot trong repo bị throw', false);
} catch { tru('createSession tempRoot trong repo bị throw', true); }

{ // 1. PASS cleanup
  const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-pass' });
  const sub = m.createDir('work');
  const file = m.createFile('work/out.txt', 'hello');
  m.createFile('note.json', JSON.stringify({ a: 1 }));
  tru('pass manifest có file+dir', m.manifest.files.length === 2 && m.manifest.dirs.length >= 2);
  tru('pass ownership marker đúng', hasOwnershipMarker(m.homeDir, m.sessionId));
  const before = null; // workspace change not asserted in happy path
  const r = m.cleanup({ projectRoot: ROOT, workspaceBefore: null });
  eq('pass verdict CLEAN', r.verdict, 'CLEAN');
  tru('pass homeGone read-back', r.readBack.homeGone);
  eq('pass leftover rỗng', r.leftover.length, 0);
  eq('pass removed >0', r.removed.length > 0, true);
  tru('pass workspace không đổi', r.readBack.workspaceUnchanged); // snapshot()==after trong same repo ổn định nếu test sạch
  // tái cleanup (idempotent)
  const r2 = m.cleanup();
  eq('pass cleanup idempotent', r2.verdict === 'CLEAN', true);
}

{ // 2. TIMEOUT process: cleanup phải có giới hạn thời gian + dừng process con (theo pid, identity verified), không treo.
  const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-timeout' });
  const child = m.spawnProcess(NODE, ['-e', tickFor(m.sessionId)]);
  alive.push(child);
  tru('timeout child có pid', Number.isInteger(child.pid));
  const t0 = Date.now();
  const r = m.cleanup({ timeoutMs: 50 });
  const elapsed = Date.now() - t0;
  tru('timeout cleanup không treo (<5000ms)', elapsed < 5000);
  eq('timeout verdict CLEAN', r.verdict, 'CLEAN');
  eq('timeout không có unverified', r.unverified.length, 0);
  tru('timeout processesGone read-back', r.readBack.processesGone);
  tru('timeout child thật không còn', !isAlive(child.pid));
}

{ // 3. FAILURE verdict: target ngoài allowed root → POC_CLEANUP_FAILED.
  const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-failure' });
  m.manifest.files.push(path.join(os.tmpdir(), 'ngoaifile-ko-ton-tai.mjs')); // giả lập target lạ xuyên qua root
  const r = m.cleanup();
  eq('failure verdict POC_CLEANUP_FAILED', r.verdict, 'POC_CLEANUP_FAILED');
  eq('failure có leftover (không thể PASS)', r.leftover.length > 0, true);
}

{ // 4. RECOVERY tích cực theo sessionId (simulate crash, không cleanup) + idempotent.
  const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-rec' });
  m.createFile('payload.bin', 'x');
  const id = m.sessionId, home = m.homeDir;
  tru('rec trước khi recovery dir tồn tại', fs.existsSync(home));
  const rec1 = recoverSession({ sessionId: id, tempRoot: ROOT2 });
  eq('recovery lần 1 CLEAN', rec1.verdict, 'CLEAN');
  eq('recovery lần 1 removed 1', rec1.removed.length, 1);
  eq('recovery xóa sạch dir', fs.existsSync(home), false);
  const rec2 = recoverSession({ sessionId: id, tempRoot: ROOT2 });
  eq('recovery lần 2 idempotent CLEAN', rec2.verdict, 'CLEAN');
}

{ // 5. RECOVERY từ chối dir không có ownership marker (không tự xóa).
  const orphan = path.join(ROOT2, 'cafe'.repeat(8)); // 32 hex hợp lệ, nhưng KO có marker
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'stray.txt'), 't');
  const r = recoverSession({ sessionId: 'cafe'.repeat(8), tempRoot: ROOT2 });
  eq('recovery unowned POC_CLEANUP_FAILED', r.verdict, 'POC_CLEANUP_FAILED');
  tru('recovery unowned không xóa dir', fs.existsSync(orphan));
  tru('recovery unowned báo leftover', r.leftover.length > 0);
}

{ // 6. pid-scoped kill: dừng ĐÚNG process của session mình, KHÔNG đụng process session khác.
  const a = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-iso-a' });
  const b = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-iso-b' });
  const ca = a.spawnProcess(NODE, ['-e', tickFor(a.sessionId)]);
  const cb = b.spawnProcess(NODE, ['-e', tickFor(b.sessionId)]);
  alive.push(ca, cb);
  const ra = a.cleanup({ timeoutMs: 50 });
  eq('iso A verdict CLEAN', ra.verdict, 'CLEAN');
  eq('iso A không unverified', ra.unverified.length, 0);
  tru('iso A child đã dừng', !isAlive(ca.pid));
  tru('iso B child VẪN chạy (chưa bị đụng)', isAlive(cb.pid));
  b.cleanup({ timeoutMs: 50 }); // dọn B
}

{ // 7. PID reuse / identity lệch: KHÔNG kill nếu không xác minh được owner identity → fail-closed read-back.
  const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-pid-reuse' });
  const child = m.spawnProcess(NODE, ['-e', tickFor(m.sessionId)]);
  alive.push(child);
  // giả lập identity lệch (PID được tái sử dụng bởi process khác không mang identity session)
  m.manifest.processes[0].identity = 'OTHER-PROCESS-TOKEN-12345';
  const r = m.cleanup({ timeoutMs: 50 });
  eq('pid-reuse verdict POC_CLEANUP_FAILED (không verify được)', r.verdict, 'POC_CLEANUP_FAILED');
  eq('pid-reuse có unverified', r.unverified.length, 1);
  eq('pid-reuse NOT kill process lạ', isAlive(child.pid), true);
  eq('pid-reuse processesGone read-back=false (fail-closed)', r.readBack.processesGone, false);
  try { if (isAlive(child.pid)) process.kill(child.pid, 'SIGKILL'); } catch {}
}

{ // 8. symlink/junction escape: không xóa target ngoài temp root; cleanup fail-closed; target ngoài nguyên vẹn.
  const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-junction' });
  const outsideDir = path.join(os.tmpdir(), `tmp-hygiene-outside-${Date.now()}`);
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, 'kho-bau.txt');
  fs.writeFileSync(outsideFile, 'KHONG-DUOC-XOA');
  const link = path.join(m.homeDir, 'leak-junction');
  try {
    fs.symlinkSync(outsideDir, link, 'junction'); // junction trỏ ra ngoài temp root
    m.manifest.dirs.push(link);
    const r = m.cleanup();
    eq('junction verdict POC_CLEANUP_FAILED', r.verdict, 'POC_CLEANUP_FAILED');
    eq('junction báo leftover chứa link', r.leftover.some((l) => l.includes('leak')), true);
    tru('junction target ngoài VẪN nguyên (file còn)', fs.existsSync(outsideFile));
    eq('junction home không còn (link bị gỡ, target giữ)', !fs.existsSync(m.homeDir), true);
  } catch (e) {
    eq('junction tạo được trên platform này (skip nếu failed)', false, true); // báo lỗi nếu không thể tạo link
    console.log('  (junction không tạo được → bỏ qua: ' + (e && e.message) + ')');
  }
  try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch {}
}

// --- runner ---
let fail = 0;
console.log('\n=== TEST TEMP HYGIENE ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
// dọn mọi child còn sống (an toàn hơn) + temp root test
for (const c of alive) { try { if (isAlive(c.pid)) process.kill(c.pid, 'SIGKILL'); } catch {} }
try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

