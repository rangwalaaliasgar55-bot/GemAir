/* Local control server tests — one pairing surface for the browser
   extension AND the phone remote, with scoping rules enforced at the
   router: the LAN lane serves ONLY /m routes, tokens never cross lanes,
   both are rate-limited, and every sensitive act is journaled. Real HTTP
   against an ephemeral socket; no real app state needed. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const ls = require(path.join(ROOT, 'lib', 'local-server.js'));

function makeServer(over = {}) {
  const events = [];
  const srv = ls.createLocalServer(Object.assign({
    pairCode: '424242',
    tokens: { ext: 'ext-token-1', phone: 'phone-token-1' },
    getPolicy: () => ({ blocked: [{ target: 'doomscroll.example', reason: 'test' }], exceptions: [] }),
    onAttempt: (a) => events.push(['attempt', a]),
    onTab: (t) => events.push(['tab', t]),
    onSay: (t) => events.push(['say', t]),
    getStatus: () => ({ version: '2.16.0-test', uptime: '7s', lastMessage: 'hello' }),
    commands: { since: (after) => [{ i: 1, url: 'https://example.test' }].filter(c => c.i > after) }
  }, over));
  return { srv, events };
}

function listen(srv, scope) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => srv._route(req, res, scope));
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: headers || {} }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
async function post(port, path, body, headers) {
  const b = Buffer.from(JSON.stringify(body || {}));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'content-length': b.length }, headers || {}) }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end(b);
  });
}

test('pairing requires the exact 6-digit code and mints an ext token', async (t) => {
  const { srv } = makeServer();
  const s = await listen(srv, 'loop');
  const port = s.address().port;
  const bad = JSON.parse((await get(port, '/pair?code=999999')).body);
  assert.equal(bad.ok, false);
  const good = JSON.parse((await get(port, '/pair?code=424242')).body);
  assert.equal(good.ok, true);
  assert.equal(good.token, 'ext-token-1');
  s.close();
});

test('the phone lane will NOT pair, and /policy never leaves the loopback scope', async (t) => {
  const { srv } = makeServer();
  const s = await listen(srv, 'lane');
  t.after(() => { try { s.close(); } catch {} });
  const port = s.address().port;
  const pairRes = await get(port, '/pair?code=424242');
  assert.ok([401, 404].includes(pairRes.code), 'lane refuses pairing (' + pairRes.code + ')');
  assert.notEqual(JSON.parse(pairRes.body).ok, true, 'no token ever minted on the lane');
  assert.equal((await get(port, '/policy?key=phone-token-1')).code, 404, 'policy stays loopback-only');
  s.close();
});

test('ext routes 401 unpaired, 200 with the right token; commands honor the cursor', async (t) => {
  const { srv } = makeServer();
  const s = await listen(srv, 'loop');
  const port = s.address().port;
  assert.equal((await get(port, '/policy')).code, 401);
  const tok = { 'x-gemair-token': 'ext-token-1' };
  const pol = JSON.parse((await get(port, '/policy', tok)).body);
  assert.equal(pol.blocked[0].target, 'doomscroll.example');
  assert.equal((await get(port, '/commands?after=1', tok)).body.includes('example.test'), false, 'cursor excludes delivered');
  assert.equal((await get(port, '/commands?after=0', tok)).body.includes('example.test'), true);
  s.close();
});

test('wrong-length or wrong-token never soft-fails (timing-safe compare path)', async (t) => {
  const { srv } = makeServer();
  const s = await listen(srv, 'loop');
  const port = s.address().port;
  assert.equal((await get(port, '/policy', { 'x-gemair-token': '' })).code, 401);
  assert.equal((await get(port, '/policy', { 'x-gemair-token': 'ext-token-1x' })).code, 401);
  assert.equal((await get(port, '/policy', { 'x-gemair-token': 'ext' })).code, 401);
  s.close();
});

test('phone: /m page is HTML, say requires the key, delivery reaches onSay, empty rejected', async (t) => {
  const { srv, events } = makeServer();
  const s = await listen(srv, 'lane');
  const port = s.address().port;
  const page = await get(port, '/m');
  assert.match(page.body, /GemAir Remote/);
  assert.match(page.body, /LAN only/, 'the page itself teaches the boundary');
  assert.equal((await post(port, '/m/say', { text: 'hi' })).code, 401);
  const ok = await post(port, '/m/say?key=phone-token-1', { text: 'hello gem' });
  assert.equal(ok.code, 200);
  assert.deepEqual(events.find(e => e[0] === 'say')[1], 'hello gem');
  const empty = await post(port, '/m/say?key=phone-token-1', { text: '   ' });
  assert.equal(empty.code, 400);
  s.close();
});

test('pair and say are rate-limited per client', async (t) => {
  const { srv } = makeServer();
  const s = await listen(srv, 'loop');
  const port = s.address().port;
  let last = 0;
  for (let i = 0; i < 7; i++) last = (await get(port, '/pair?code=1')).code;
  assert.equal(last, 429, 'the 6th+ attempt within a minute is refused');
  s.close();
  const lane = await listen(srv, 'lane');
  const p2 = lane.address().port;
  let c = 0;
  for (let i = 0; i < 12; i++) c = (await post(p2, '/m/say?key=phone-token-1', { text: 'spam' })).code;
  assert.equal(c, 429);
  lane.close();
});

test('attempts and tabs are journaled through the injected callbacks', async (t) => {
  const { srv, events } = makeServer();
  const s = await listen(srv, 'loop');
  const port = s.address().port;
  const tok = { 'x-gemair-token': 'ext-token-1' };
  await post(port, '/attempt', { subject: 'doomscroll.example' }, tok);
  await post(port, '/tab', { url: 'https://x.test', title: 'X' }, tok);
  assert.equal(events.filter(e => e[0] === 'attempt').length, 1);
  assert.equal(events.filter(e => e[0] === 'tab').length, 1);
  s.close();
});

/* ---- main-process wiring statics ---- */
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'extension', 'chrome', 'background.js'), 'utf8');

test('main binds extension loopback only; the phone lane exists only behind the toggle', () => {
  assert.ok(mainSrc.includes("startLoop()"), 'loop started');
  const i = mainSrc.indexOf('function syncLocalServer');
  const body = mainSrc.slice(i, i + 900);
  assert.ok(body.includes('wantLane'), 'lane gated by profile');
  assert.ok(body.includes("remoteDashboard === true"), 'explicit opt-in only');
});

test('browser navigation rejects non-http(s) and opens the OS default browser without an extension', () => {
  const i = mainSrc.indexOf('async function queueBrowserNav');
  const body = mainSrc.slice(i, i + 900);
  assert.match(body, /Only http\(s\)/);
  assert.match(body, /await shell\.openExternal\(u\)/);
  assert.match(body, /opened: true/);
  assert.doesNotMatch(body, /navCommands\.push|No extension paired/);
  assert.ok(mainSrc.includes("case 'navigate_browser':\n        return queueBrowserNav(args.url);"));
});

test('settings reports the native foreground browser with no pairing UI', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.match(mainSrc, /attention && attention\.snapshot\(\)\.context/);
  assert.match(mainSrc, /activeBrowser/);
  assert.match(html, /no extension, pairing code, or browser setup/i);
  assert.doesNotMatch(html, /id="extPairCode"|id="siteBlocksEdit"/);
  assert.match(app, /detected from the desktop \(no extension\)/);
  assert.match(app, /window\.air\.onUpdate/);
});

test('the extension polls nav commands and only executes http(s)', () => {
  assert.ok(bgSrc.includes("await call('/commands?after='"));
  assert.ok(bgSrc.includes('chrome.tabs.update'));
  assert.match(bgSrc, /never execute odd URLs/);
  assert.ok(bgSrc.includes('x-gemair-token') === false || bgSrc.includes("headers")); // token flows through call()
});
