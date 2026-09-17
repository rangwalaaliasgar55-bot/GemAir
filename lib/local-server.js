/* GemAir — local control server: browser extension + phone remote dashboard.
   Pure router/factory injected with app callbacks; main process owns the
   sockets. Zero dependencies.

   Honesty contract (all enforced here):
     • pairing is a 6-digit code shown IN THE APP — nothing pairs without a
       human reading it; tokens are per-session random and constant-time
       compared;
     • the loopback listener (extension contract, port 8677) never binds a
       public interface; the phone dashboard is a SECOND, separately
       toggleable listener serving ONLY the /m route family over LAN HTTP —
       the Settings UI says exactly that (no TLS on LAN);
     • every /m/say and /attempt is journaled and rate-limited — a paired
       phone can type into the conversation, so misuse must leave a trail. */
'use strict';

const http = require('http');
const crypto = require('crypto');

const EXT_PORT = 8677;   // extension contract (background.js: const PORT = 8677)
const PHONE_PORT = 8680;
const RATES = { pairPerMin: 5, sayPerMin: 10 };

function tokensEq(a, b) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}

function genToken() { return crypto.randomBytes(18).toString('base64url'); }
function genPairCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

function now() { return Date.now(); }
const rate = new Map(); // key -> {start, count}
function limited(key, perMin) {
  const r = rate.get(key) || { start: now(), count: 0 };
  if (now() - r.start > 60000) { r.start = now(); r.count = 0; }
  r.count++; rate.set(key, r);
  return r.count > perMin;
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 16384) { d = d.slice(0, 16384); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const MOBILE_PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GemAir Remote</title>
<style>
body{background:#060a12;color:#cfe6ff;font:16px system-ui;margin:0;padding:20px;max-width:430px;margin:auto}
h1{font-size:18px;color:#7fd4ff} .card{background:#0d1626;border:1px solid #1d3350;border-radius:12px;padding:14px;margin:12px 0}
.row{display:flex;gap:8px} input{flex:1;padding:12px;border-radius:10px;border:1px solid #28496e;background:#0a1220;color:#cfe6ff;font-size:16px}
button{padding:12px 18px;border-radius:10px;border:0;background:#2f8fd4;color:#fff;font-size:16px}
#st{white-space:pre-wrap;font-size:13px;color:#9fc4e8;min-height:64px}small{color:#5f7ea0}
</style>
<h1>◈ GemAir Remote</h1>
<div class="card"><div id="st">connecting…</div></div>
<div class="card"><div class="row">
<input id="t" placeholder="Say to Gem…" autocomplete="off"/><button onclick="go()">Send</button>
</div><small id="last"></small></div>
<small>LAN only · this page talks to YOUR computer · nothing is relayed anywhere else.</small>
<script>
const key = location.hash.slice(1); let n = 0;
async function j(p, m, b){ const r = await fetch(p + '?key=' + key, { method: m||'GET', headers:{'content-type':'application/json'}, body: b?JSON.stringify(b):undefined }); return r.json(); }
async function status(){ try{ const s = await j('/m/status');
  document.getElementById('st').textContent = s.ok ? ('GemAir ' + s.version + ' · up ' + s.uptime + '\\n' + (s.lastMessage ? 'last user message: ' + s.lastMessage : 'no messages yet')) : (s.error||'offline');
 }catch(e){ document.getElementById('st').textContent='offline'; } setTimeout(status, 3000); }
async function go(){ const el = document.getElementById('t'); const text = el.value.trim(); if(!text) return;
  const r = await j('/m/say','POST',{text});
  document.getElementById('last').textContent = r.ok ? '✓ sent to Gem' : ('✗ ' + (r.error||'failed'));
  if (r.ok) el.value=''; }
status();
</script>`;

function createLocalServer(deps) {
  const d = deps || {};
  // Injected app-surface callbacks (all optional, all guarded):
  // getPolicy(), onAttempt(a), onTab(t), getStatus(), onSay(text), commands.queue/list(after)
  const pairCode = () => (d.pairCode || '');
  const extToken = () => (d.tokens && d.tokens.ext) || '';
  const phoneToken = () => (d.tokens && d.tokens.phone) || '';
  const startedAt = now();

  function authedExt(req) { return tokensEq(req.headers['x-gemair-token'], extToken()); }
  function authedPhone(url) { return tokensEq(url.searchParams.get('key'), phoneToken()); }

  function send(res, code, obj, type) {
    res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store' });
    res.end(type === 'text/html' ? String(obj) : JSON.stringify(obj));
  }

  async function route(req, res, scope) {
    const u = new URL(req.url, 'http://x');
    const ip = req.socket && req.socket.remoteAddress || 'ip';
    const path = u.pathname;

    // -- pairing (loopback scope ONLY — a phone token never mints here) --
    if (scope === 'loop' && path === '/pair') {
      if (limited('pair:' + ip, RATES.pairPerMin)) return send(res, 429, { ok: false, error: 'too many pairing attempts — wait a minute' });
      if (!tokensEq(u.searchParams.get('code'), pairCode())) return send(res, 403, { ok: false, error: 'wrong code — read it from GemAir Settings' });
      return send(res, 200, { ok: true, token: extToken() });
    }

    // -- browser-extension loopback routes (x-gemair-token) --
    if (scope === 'loop') {
      if (!authedExt(req)) return send(res, 401, { ok: false, error: 'unpaired' });
      if (path === '/policy' && req.method === 'GET') return send(res, 200, d.getPolicy ? d.getPolicy() : { blocked: [], exceptions: [] });
      if (path === '/attempt' && req.method === 'POST') { const b = await readBody(req); try { d.onAttempt && d.onAttempt(b); } catch {} return send(res, 200, { ok: true }); }
      if (path === '/tab' && req.method === 'POST') { const b = await readBody(req); try { d.onTab && d.onTab(b); } catch {} return send(res, 200, { ok: true }); }
      if (path === '/commands' && req.method === 'GET') {
        const after = Number(u.searchParams.get('after') || 0);
        const list = d.commands && d.commands.since ? d.commands.since(after) : [];
        return send(res, 200, { ok: true, commands: list });
      }
      if (path === '/status' && req.method === 'GET') {
        const s = d.getStatus ? d.getStatus() : {};
        return send(res, 200, Object.assign({ ok: true }, s));
      }
      return send(res, 404, { ok: false, error: 'no route' });
    }

    // -- phone remote dashboard (/m family only, key in URL/fragment) --
    if (scope === 'lane') {
      if (path === '/m' && req.method === 'GET') return send(res, 200, MOBILE_PAGE, 'text/html');
      if (!authedPhone(u)) return send(res, 401, { ok: false, error: 'scan the QR in GemAir Settings — the key belongs in the link' });
      if (path === '/m/status' && req.method === 'GET') {
        const s = d.getStatus ? d.getStatus() : {};
        return send(res, 200, Object.assign({ ok: true, version: s.version || '', uptime: s.uptime || '', lastMessage: (s.lastMessage || '') }));
      }
      if (path === '/m/say' && req.method === 'POST') {
        if (limited('say:' + ip, RATES.sayPerMin)) return send(res, 429, { ok: false, error: 'slow down — max ' + RATES.sayPerMin + ' per minute' });
        const b = await readBody(req);
        const text = String(b.text || '').trim().slice(0, 1000);
        if (!text) return send(res, 400, { ok: false, error: 'empty message' });
        try { d.onSay && d.onSay(text); } catch (e) { return send(res, 500, { ok: false, error: 'delivery failed' }); }
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { ok: false, error: 'no route' });
    }
    return send(res, 404, { ok: false, error: 'no route' });
  }

  const servers = [];
  function listen(port, host, scope) {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => { route(req, res, scope).catch(() => { try { send(res, 500, { ok: false, error: 'server fault' }); } catch {} }); });
      srv.on('error', (e) => resolve({ ok: false, error: e.code === 'EADDRINUSE' ? 'port ' + port + ' is already in use' : String(e.message) }));
      srv.listen(port, host, () => { servers.push(srv); resolve({ ok: true, port, host }); });
      srv.unref && srv.unref();
    });
  }

  return {
    // Loopback (extension) listener — ALWAYS loopback, never LAN.
    startLoop: () => listen(EXT_PORT, '127.0.0.1', 'loop'),
    startLane: () => listen(PHONE_PORT, '0.0.0.0', 'lane'),
    async stop() { await Promise.all(servers.map((s) => new Promise((r) => { try { s.close(() => r()); } catch { r(); } }))); },
    ports: { EXT_PORT, PHONE_PORT },
    _route: route // tests drive the router without sockets when needed
  };
}

module.exports = { createLocalServer, genToken, genPairCode, tokensEq, EXT_PORT, PHONE_PORT, MOBILE_PAGE };
