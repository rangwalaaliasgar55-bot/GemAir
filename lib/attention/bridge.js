'use strict';
/* Gem Air — browser integration boundary.

   A loopback-only HTTP endpoint that the Gem Air browser extension talks to.
   The extension is the ONLY reliable way to know the active tab's URL and to block a site
   inside the browser — a web page cannot read or control another browser's tabs, and we
   do not pretend otherwise.

   Protocol (all JSON, all on 127.0.0.1, all token-guarded):
     GET  /pair?code=XXXX      -> { token }            one-time pairing using a code shown in the UI
     GET  /policy              -> { blocked, exceptions, categoryRules }
     POST /tab                 -> { ok }               active tab changed { url, title, active, browser }
     POST /attempt             -> { ok }               a blocked navigation was stopped
   Native-messaging hosts can speak the same JSON over stdio via lib/attention/native/messaging-host.js. */

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 8677;

class BrowserBridge {
  constructor({ port = DEFAULT_PORT, onTab, onAttempt, getPolicy } = {}) {
    this.port = port;
    this.onTab = onTab || (() => {});
    this.onAttempt = onAttempt || (() => {});
    this.getPolicy = getPolicy || (() => ({ blocked: [], exceptions: [], categoryRules: [] }));
    this.tokens = new Set();
    this.pairCode = null;
    this.pairCodeExpires = 0;
    this.server = null;
    this.lastSeen = 0;
    this.connected = false;
  }

  newPairCode() {
    this.pairCode = String(crypto.randomInt(100000, 999999));
    this.pairCodeExpires = Date.now() + 5 * 60 * 1000;
    return this.pairCode;
  }

  status() {
    return {
      running: !!this.server,
      port: this.port,
      connected: this.connected && Date.now() - this.lastSeen < 30000,
      lastSeen: this.lastSeen || null,
      pairCode: this.pairCode && Date.now() < this.pairCodeExpires ? this.pairCode : null
    };
  }

  authorized(req) {
    const token = (req.headers['x-gemair-token'] || '').toString();
    return token && this.tokens.has(token);
  }

  start() {
    if (this.server) return Promise.resolve(this.status());
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', () => { this.server = null; resolve(this.status()); });
      this.server.listen(this.port, '127.0.0.1', () => resolve(this.status()));
    });
  }

  stop() {
    if (this.server) try { this.server.close(); } catch {}
    this.server = null;
    this.connected = false;
  }

  send(res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,x-gemair-token',
      'cache-control': 'no-store'
    });
    res.end(payload);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') return this.send(res, 204, {});

    if (url.pathname === '/pair') {
      const code = url.searchParams.get('code');
      if (!this.pairCode || Date.now() > this.pairCodeExpires || code !== this.pairCode) {
        return this.send(res, 403, { ok: false, error: 'invalid or expired pairing code' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      this.tokens.add(token);
      this.pairCode = null;
      this.connected = true;
      this.lastSeen = Date.now();
      return this.send(res, 200, { ok: true, token });
    }

    if (!this.authorized(req)) return this.send(res, 401, { ok: false, error: 'unauthorized' });
    this.lastSeen = Date.now();
    this.connected = true;

    if (url.pathname === '/policy' && req.method === 'GET') {
      return this.send(res, 200, { ok: true, ...this.getPolicy() });
    }

    if (req.method === 'POST' && (url.pathname === '/tab' || url.pathname === '/attempt')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 64_000) req.destroy(); });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body || '{}'); } catch { return this.send(res, 400, { ok: false, error: 'bad json' }); }
        try {
          if (url.pathname === '/tab') this.onTab(data);
          else this.onAttempt(data);
        } catch {}
        this.send(res, 200, { ok: true });
      });
      return undefined;
    }

    return this.send(res, 404, { ok: false, error: 'not found' });
  }
}

module.exports = { BrowserBridge, DEFAULT_PORT };
