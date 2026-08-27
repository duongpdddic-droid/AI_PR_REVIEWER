// _test_transport.mjs — Mock fetch cho integration test (gateway child). KHÔNG commit behavior production.
// Usage: gateway --fetch-impl <abs path to this file>
import fs from 'node:fs';

const logPath = process.env.GATEWAY_TEST_LOG;
function log(entry) { if (logPath) { try { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); } catch {} } }

const PING_UPDATE = { update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: '/ping' } };
let firstUpdate = true;

function makeRes(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    headers: { get: () => null },
  };
}

export default async function mockFetch(url, opts) {
  if (typeof url === 'string' && url.includes('/getUpdates')) {
    if (firstUpdate) { firstUpdate = false; return makeRes({ ok: true, result: [PING_UPDATE] }); }
    return makeRes({ ok: true, result: [] });
  }
  if (typeof url === 'string' && url.includes('/sendMessage')) {
    log({ op: 'sendMessage', body: opts && opts.body });
    return makeRes({ ok: true, text: 'ok' });
  }
  return makeRes({ ok: false, status: 500 });
}
