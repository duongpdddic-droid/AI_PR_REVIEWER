#!/usr/bin/env node
// test-pure-logic.mjs — test hành vi dự chak püre logic du khung (Nhóm 1).
// KHÔNG framework — assert-based self-check. Exit 0 = PASS, 1 = FAIL.
import { escapeHtml, eventKey, NotificationStore, buildMessage } from './tg-notify-core.mjs';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });

// escapeHtml: escape & < > pour parse_mode=HTML, laisse Viêt intact
eq('escapeHtml &', escapeHtml('A & B'), 'A &amp; B');
eq('escapeHtml < >', escapeHtml('<x>'), '&lt;x&gt;');
eq('escapeHtml accents', escapeHtml('dự an'), 'dự an');

// eventKey: repo::ref::event::state
eq('eventKey', eventKey({ repo: 'o/r', ref: '#1', eventType: 'done', state: 'ready' }), 'o/r::#1::done::ready');

// NotificationStore chống trùng: même key déjà SENT -> shouldSend false
{
  const store = new NotificationStore();
  const key = 'a::#1::done::ready';
  tru('store.shouldSend initial', store.shouldSend(key));
  store.markSent(key);
  tru('store.shouldSend after SENT', store.shouldSend(key)); // -> false
  // shouldSend do-it renvoyer false; on check directement
  checks[checks.length - 1].ok = !Boolean(store.shouldSend(key));
  checks[checks.length - 1].want = false;
}

// buildMessage: contient les champs + échappé
{
  const msg = buildMessage({ eventType: 'done', repo: 'o/r', ref: '#1', state: 'ready', summary: 'a<b', nextAction: 'merge' });
  eq('buildMessage tags', true, msg.includes('Hoàn thành / Bàn giao') && msg.includes('a&lt;b'));
}

let fail = 0;
console.log('\n=== TEST PURE LOGIC ===');
for (const c of checks) {
  if (!c.ok) fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}` + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
}
console.log(`Tổng: ${checks.length - fail}/${checks.length} PASS`);
process.exit(fail ? 1 : 0);