#!/usr/bin/env node
/* Gem Air — preview harness.

   Runs the REAL engines (store, classification, blocking, planning, tracking) behind an
   HTTP shim so the island and the attention UI can be exercised in a browser on a machine
   without Electron. The only thing simulated is the foreground-window feed, which normally
   comes from the OS: here you drive it from the simulator strip.

   This is a development harness, not the product. `npm start` runs the real Electron app. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const { AttentionService } = require(path.join(ROOT, 'lib/attention/service'));
const tracking = require(path.join(ROOT, 'lib/attention/core/tracking'));
const schedule = require(path.join(ROOT, 'lib/attention/core/schedule'));
const blocking = require(path.join(ROOT, 'lib/attention/core/blocking'));
const classifyLib = require(path.join(ROOT, 'lib/attention/core/classify'));

const PORT = Number(process.env.PORT) || 3000;
const dataDir = path.join(os.tmpdir(), 'gemair-preview');
fs.mkdirSync(dataDir, { recursive: true });

const service = new AttentionService({ userDataDir: dataDir, notify: () => {} });
service.detector.start = () => {};
service.detector.stop = () => {};
// Do not kill real processes in the preview — record the intent instead.
const enforcer = require(path.join(ROOT, 'lib/attention/native/enforcer'));
const enforcements = [];
enforcer.closeApp = async (name) => { enforcements.push({ name, at: Date.now() }); return { ok: true, target: name, preview: true }; };
service.bridge.start();

// Seed a believable day so the dashboard has something to show.
(function seed() {
  const s = service.state;
  if (Object.keys(s.activity.days).length) return;
  // Lay a believable morning down ending "now", so the dashboard has real shape.
  const plan = [
    ['code', '', 75], ['chrome', 'https://github.com/org/repo', 20],
    ['chrome', 'https://youtube.com', 18], ['slack', '', 12],
    ['code', '', 55], ['figma', '', 40], ['chrome', 'https://x.com', 9]
  ];
  const totalMin = plan.reduce((a, p) => a + p[2], 0);
  let t = Date.now() - totalMin * 60000;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  if (t < midnight.getTime()) t = midnight.getTime();
  for (const [app, url, mins] of plan) {
    const ctx = classifyLib.classify(s, { app, url });
    t += mins * 60000;
    tracking.record(s, ctx, Math.min(t, Date.now()), mins * 60000);
  }
  service.store.markDirty();
  service.store.flush();
})();

/* ---- the IPC surface, re-hosted over HTTP ---- */
const handlers = {
  'air:snapshot': () => service.snapshot(),
  'air:state': () => ({
    categories: service.state.categories, appRules: service.state.appRules, siteRules: service.state.siteRules,
    blocks: service.state.blocks, plans: service.state.plans, sleep: service.state.sleep,
    settings: service.state.settings, attempts: service.state.attempts.slice(-100).reverse()
  }),
  'air:capabilities': () => ({ ...enforcer.capabilities, platform: process.platform, detector: true, preview: true }),
  'air:summary': (d) => tracking.summarize(service.state, d || tracking.dayKey(Date.now())),
  'air:timeline': (d) => tracking.timeline(service.state, d || tracking.dayKey(Date.now())),
  'air:trend': (n) => tracking.trend(service.state, Number(n) || 7),
  'air:recent': (n) => tracking.recent(service.state, Number(n) || 20),
  'air:lastHour': () => tracking.lastHour(service.state),
  'air:resetActivity': () => { service.store.update((s) => { s.activity = { days: {} }; s.attempts = []; return s; }); return { ok: true }; },
  'air:export': () => ({ exportedAt: Date.now(), state: service.state }),
  'air:answer': (qid, cat) => service.answerQuestion(qid, cat),
  'air:dismissQuestion': () => service.dismissQuestion(),
  'air:createCategory': (p) => service.createCategory(p || {}),
  'air:deleteCategory': (id) => { service.store.update((s) => { s.categories = s.categories.filter((c) => c.id !== id || c.builtin); return s; }); return { ok: true }; },
  'air:classify': (p) => { service.store.update((s) => classifyLib.learn(s, p || {})); return service.emitState(); },
  'air:deleteRule': (kind, match) => { service.store.update((s) => { const k = kind === 'site' ? 'siteRules' : 'appRules'; s[k] = s[k].filter((r) => r.match !== match); return s; }); return { ok: true }; },
  'air:addBlock': (p) => {
    const kind = p.kind === 'site' ? 'sites' : 'apps';
    const rule = { id: 'b' + Date.now().toString(36), target: String(p.target || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), reason: p.reason || null, protected: !!p.protected, enabled: true, schedule: null, createdAt: Date.now() };
    service.store.update((s) => { s.blocks[kind].push(rule); return s; });
    return { ok: true, rule };
  },
  'air:removeBlock': (kind, id) => { service.store.update((s) => { const k = kind === 'site' ? 'sites' : 'apps'; s.blocks[k] = s.blocks[k].filter((r) => r.id !== id); return s; }); return { ok: true }; },
  'air:toggleBlock': (kind, id, en) => { service.store.update((s) => { const k = kind === 'site' ? 'sites' : 'apps'; const r = s.blocks[k].find((x) => x.id === id); if (r && !(r.protected && en === false)) r.enabled = !!en; return s; }); return { ok: true }; },
  'air:addException': (p) => {
    const ex = { id: 'e' + Date.now().toString(36), kind: p.kind === 'site' ? 'site' : 'app', target: String(p.target || '').toLowerCase(), reason: p.reason || null, until: p.minutes ? Date.now() + p.minutes * 60000 : null, overridesProtected: false, createdAt: Date.now() };
    service.store.update((s) => { s.blocks.exceptions.push(ex); return s; });
    return { ok: true, exception: ex };
  },
  'air:removeException': (id) => { service.store.update((s) => { s.blocks.exceptions = s.blocks.exceptions.filter((e) => e.id !== id); return s; }); return { ok: true }; },
  'air:attempts': (n) => service.state.attempts.slice(-(Number(n) || 50)).reverse(),
  'air:systemBlockRequest': (hosts) => enforcer.blockSiteSystemWide(hosts),
  'air:savePlan': (plan) => {
    const p = { ...plan, id: plan.id || 'p' + Date.now().toString(36), enabled: plan.enabled !== false };
    service.store.update((s) => { const i = s.plans.findIndex((x) => x.id === p.id); if (i >= 0) s.plans[i] = p; else s.plans.push(p); return s; });
    service.emitState();
    return { ok: true, plan: p };
  },
  'air:startFocus': (minutes) => {
    const duration = Math.min(Math.max(Number(minutes) || 25, 5), 180);
    const start = new Date();
    const end = new Date(start.getTime() + duration * 60000);
    const hhmm = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const p = { id: 'gem-air-quick-focus', name: 'Quick Focus', enabled: true, expiresAt: end.getTime(), days: [...new Set([start.getDay(), end.getDay()])], blocks: [{ start: hhmm(start), end: hhmm(end), kind: 'focus', label: `Quick focus · ${duration} min` }], rules: {} };
    service.store.update((s) => { s.plans = s.plans.filter((x) => x.id !== p.id); s.plans.push(p); return s; });
    service.emitState();
    return { ok: true, plan: p, endsAt: end.toISOString() };
  },
  'air:deletePlan': (id) => { service.store.update((s) => { s.plans = s.plans.filter((p) => p.id !== id); return s; }); service.emitState(); return { ok: true }; },
  'air:togglePlan': (id, en) => { service.store.update((s) => { const p = s.plans.find((x) => x.id === id); if (p) p.enabled = !!en; return s; }); return service.emitState(); },
  'air:activeBlocks': () => schedule.activePlanBlocks(service.state.plans, new Date()),
  'air:setSleep': (sleep) => { service.store.update((s) => { s.sleep = { ...s.sleep, ...sleep }; return s; }); return service.emitState(); },
  'air:sleepStatus': () => schedule.sleepStatus(service.state.sleep, new Date()),
  'air:setSettings': (patch) => { service.store.update((s) => { s.settings = { ...s.settings, ...patch }; return s; }); return service.state.settings; },
  'air:setStartup': () => ({ ok: false, reason: 'Startup registration is a Windows-only action; unavailable in the preview harness.' }),
  'air:bridgeStatus': () => service.bridge.status(),
  'air:bridgePair': () => ({ code: service.bridge.newPairCode(), port: service.bridge.port }),
  'air:browserPolicy': () => blocking.browserPolicy(service.state, new Date()),
  'air:island': () => ({ ok: true }),
  'air:islandResize': () => ({ ok: true }),
  'air:openMain': () => ({ ok: true }),
  'air:openFocusx': (p) => ({ ok: true, url: 'https://focusarx.site/' + (p || '') }),
  // preview-only: drive the foreground feed
  'preview:feed': (sample) => {
    if (sample.url) service.onBrowserTab({ url: sample.url, title: sample.title || '' });
    service.onSample({ app: sample.app, title: sample.title || '', pid: 1, idleSeconds: sample.idleSeconds || 0, at: Date.now() });
    return service.snapshot();
  },
  'preview:enforcements': () => enforcements.slice(-20).reverse()
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const clients = new Set();
service.on('state', (snap) => {
  for (const res of clients) {
    try { res.write(`event: update\ndata: ${JSON.stringify(snap)}\n\n`); } catch {}
  }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/invoke' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let out;
      try {
        const { channel, args } = JSON.parse(body || '{}');
        const fn = handlers[channel];
        out = fn ? await fn(...(args || [])) : { error: 'unknown channel ' + channel };
      } catch (e) { out = { error: e.message }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out === undefined ? null : out));
    });
    return;
  }

  let file = url.pathname === '/' ? '/preview/index.html' : url.pathname;
  const full = path.join(ROOT, 'renderer', file.replace(/^\/+/, ''));
  if (!full.startsWith(path.join(ROOT, 'renderer'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Gem Air preview harness on http://0.0.0.0:${PORT}`);
  console.log('Real engines, simulated foreground feed. Run `npm start` for the actual Windows app.');
});
