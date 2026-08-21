#!/usr/bin/env node
/* ============================================================
   GemAir — self-check.
   A zero-dependency guard that runs the renderer in a strict fake DOM and
   fails loudly on the classes of bug that have actually broken this app.

   Run:  npm run check

   Checks
     1. every JS file parses
     2. JSON files parse
     3. no assignment to read-only DOM geometry properties
        (this is the exact bug that made the whole UI unclickable:
         `canvas.clientWidth = x` throws under 'use strict')
     4. no duplicate element ids
     5. no $('#id') that resolves to null
     6. no dead $$() selectors
     7. the app boots AND the controls actually get wired
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const ok = (m) => notes.push('  ok   ' + m);

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// 1 + 2. Syntax
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', '.git', 'release', 'dist', 'out', 'build'].includes(e.name)) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const files = walk('.');
for (const f of files.filter((f) => f.endsWith('.js'))) {
  try {
    new vm.Script(read(f), { filename: f });
  } catch (e) {
    fail(`syntax error in ${f}: ${e.message}`);
  }
}
ok(`${files.filter((f) => f.endsWith('.js')).length} JS files parse`);

for (const f of files.filter((f) => f.endsWith('.json'))) {
  try { JSON.parse(read(f)); } catch (e) { fail(`invalid JSON in ${f}: ${e.message}`); }
}
ok('JSON files parse');

// Release metadata and cross-platform packaging assets
try {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  if (pkg.version !== '2.0.0') fail(`package version must be 2.0.0 (found ${pkg.version})`);
  if (lock.version !== pkg.version || (lock.packages && lock.packages[''] && lock.packages[''].version !== pkg.version)) fail('package-lock version does not match package.json');
  for (const asset of ['build/icon.png', 'build/icon.ico', 'build/icons/16x16.png', 'build/icons/256x256.png', 'build/icons/512x512.png', 'build/icons/1024x1024.png']) {
    const full = path.join(ROOT, asset);
    if (!fs.existsSync(full) || fs.statSync(full).size < 100) fail(`missing/empty release icon: ${asset}`);
  }
  if (!fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) || !read('CHANGELOG.md').includes('## [2.0.0]')) fail('CHANGELOG.md must document 2.0.0');
  else ok('2.0.0 release metadata and platform icons present');
} catch (e) { fail('release metadata check failed: ' + e.message); }

// ---------------------------------------------------------------------------
// 3. Read-only DOM properties must never be assigned
// ---------------------------------------------------------------------------
const READ_ONLY = [
  'clientWidth', 'clientHeight', 'clientTop', 'clientLeft',
  'offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft',
  'scrollWidth', 'scrollHeight',
  'naturalWidth', 'naturalHeight'
];
const roRe = new RegExp(`\\.(${READ_ONLY.join('|')})\\s*=(?!=)`, 'g');
for (const f of files.filter((f) => f.endsWith('.js') && !f.includes('selfcheck'))) {
  const src = read(f);
  src.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
    let m;
    roRe.lastIndex = 0;
    while ((m = roRe.exec(line))) {
      fail(`${f}:${i + 1} assigns to read-only DOM property "${m[1]}" — this throws under 'use strict' and can kill boot()\n        ${line.trim()}`);
    }
  });
}
ok('no assignments to read-only DOM geometry properties');

// ---------------------------------------------------------------------------
// 4-6. Markup / selector integrity
// ---------------------------------------------------------------------------
const html = read('renderer/index.html');
const appJs = read('renderer/app.js');

const idList = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const ids = new Set(idList);
const dupes = idList.filter((v, i) => idList.indexOf(v) !== i);
if (dupes.length) fail(`duplicate element ids: ${[...new Set(dupes)].join(', ')}`);
else ok(`${ids.size} unique element ids`);

const classes = new Set();
for (const m of html.matchAll(/\bclass="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && classes.add(c));
const dataAttrs = new Set([...html.matchAll(/\b(data-[a-z0-9-]+)=/g)].map((m) => m[1]));

const refs = [...new Set([...appJs.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]))];
const missing = refs.filter((r) => !ids.has(r));
if (missing.length) fail(`$('#id') with no matching element: ${missing.join(', ')}`);
else ok(`${refs.length} $('#id') references all resolve`);

const dead = [];
for (const sel of new Set([...appJs.matchAll(/\$\$\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))) {
  const head = sel.trim().split(/\s+/)[0];
  const m = head.match(/^([.#]?[A-Za-z0-9_-]*)(\[([a-z0-9-]+)\])?$/);
  if (!m) continue;
  const [, base, , attr] = m;
  let good = true;
  if (base.startsWith('.') && !classes.has(base.slice(1))) good = false;
  if (base.startsWith('#') && !ids.has(base.slice(1))) good = false;
  if (attr && !dataAttrs.has(attr)) good = false;
  if (!good) dead.push(sel);
}
if (dead.length) fail(`dead $$() selectors: ${dead.join(', ')}`);
else ok('all $$() selectors match something');

// ---------------------------------------------------------------------------
// 7. Boot the renderer in a STRICT fake DOM
//
// The key detail: geometry properties are defined with a getter and NO setter,
// exactly like a real Element. Assigning to one therefore throws in strict
// mode here too — which is what the previous harness got wrong, letting the
// unclickable-UI bug slip through.
// ---------------------------------------------------------------------------
const listeners = [];

function ctx2d() {
  const noop = () => {};
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'canvas') return makeEl('canvas');
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return typeof t[k] === 'undefined' ? noop : t[k];
    },
    set: () => true
  });
}

function makeEl(tag = 'div', id = null) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: id || '',
    dataset: new Proxy({}, { get: (t, k) => (k in t ? t[k] : 'x'), set: (t, k, v) => ((t[k] = v), true) }),
    style: (() => {
      const b = { setProperty(k, v) { b[k] = v; }, getPropertyValue: (k) => b[k] || '', removeProperty(k) { delete b[k]; } };
      return new Proxy(b, { get: (t, k) => (k in t ? t[k] : ''), set: (t, k, v) => ((t[k] = v), true) });
    })(),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hidden: false, disabled: false, value: '', textContent: '', innerHTML: '',
    checked: false, selectedIndex: 0, options: [], files: [], scrollTop: 0,
    width: 560, height: 560,
    addEventListener(type) { listeners.push({ id: el.id || el.tagName, type }); },
    removeEventListener() {}, click() {}, focus() {}, blur() {}, remove() {},
    appendChild(c) { return c; }, append() {}, prepend() {}, insertBefore(c) { return c; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    closest: () => null, scrollIntoView() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 560, bottom: 560, width: 560, height: 560 }),
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    getContext: (k) => (k === '2d' ? ctx2d() : null),
    play: () => Promise.resolve(), pause() {}, load() {}
  };
  // real Elements expose these as getters only — assignment must throw
  for (const prop of READ_ONLY) {
    Object.defineProperty(el, prop, { get: () => 560, configurable: false });
  }
  return el;
}

const cache = new Map();
const byId = (id) => {
  if (!ids.has(id)) return null;
  if (!cache.has(id)) cache.set(id, makeEl('div', id));
  return cache.get(id);
};
function selectorAll(sel) {
  const s = String(sel).trim();
  let m = s.match(/^#([A-Za-z0-9_-]+)$/);
  if (m) { const e = byId(m[1]); return e ? [e] : []; }
  m = s.match(/^\.([A-Za-z0-9_-]+)$/);
  if (m) return classes.has(m[1]) ? [makeEl('div'), makeEl('div')] : [];
  const am = s.match(/\[(data-[a-z0-9-]+)/);
  if (am) return dataAttrs.has(am[1]) ? [makeEl('div'), makeEl('div')] : [];
  const f = s.split(/\s+/)[0];
  if (f.startsWith('#')) return byId(f.slice(1)) ? [makeEl('div'), makeEl('div')] : [];
  if (f.startsWith('.')) return classes.has(f.slice(1)) ? [makeEl('div'), makeEl('div')] : [];
  return [makeEl('div')];
}

const doc = {
  readyState: 'loading', body: makeEl('body'), documentElement: makeEl('html'), head: makeEl('head'),
  getElementById: byId,
  querySelector: (s) => { const r = selectorAll(s); return r.length ? r[0] : null; },
  querySelectorAll: selectorAll,
  createElement: (t) => makeEl(t), createElementNS: (n, t) => makeEl(t),
  createTextNode: (t) => ({ textContent: t }),
  addEventListener(t, f) { (doc._l || (doc._l = {}))[t] = f; },
  removeEventListener() {}, execCommand() {}
};

const store = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(), key: () => null,
    get length() { return m.size; }
  };
};

const win = {
  document: doc,
  location: { href: 'https://gemair.vercel.app/', origin: 'https://gemair.vercel.app', protocol: 'https:', hostname: 'gemair.vercel.app', search: '', pathname: '/' },
  navigator: { userAgent: 'selfcheck', platform: 'Linux x86_64', language: 'en-US', onLine: true, clipboard: { writeText: async () => {} }, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
  localStorage: store(), sessionStorage: store(),
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  setTimeout: (f, ms) => setTimeout(f, Math.min(ms || 0, 1)),
  setInterval: () => 1, clearInterval() {}, clearTimeout() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '#ff3b3b' }),
  open() {}, alert() {}, confirm: () => true, prompt: () => null, scrollTo() {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  Blob: class {}, File: class {}, FileReader: class { readAsText() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
  speechSynthesis: { speak() {}, cancel() {}, getVoices: () => [], onvoiceschanged: null },
  Notification: class { static permission = 'granted'; static requestPermission = async () => 'granted'; },
  Image: class {}, performance: { now: () => Date.now() }
};
win.window = win;
win.self = win;

const sandbox = Object.assign(Object.create(null), win, {
  window: win, document: doc, console,
  performance: win.performance,
  setTimeout: win.setTimeout, setInterval: win.setInterval,
  clearInterval: win.clearInterval, clearTimeout: win.clearTimeout,
  requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
  fetch: win.fetch, localStorage: win.localStorage, navigator: win.navigator,
  location: win.location, speechSynthesis: win.speechSynthesis,
  URL: win.URL, Blob: win.Blob, SpeechSynthesisUtterance: win.SpeechSynthesisUtterance,
  process: undefined
});
const ctx = vm.createContext(sandbox);

let loadFailed = false;
for (const f of ['renderer/store.js', 'renderer/avatar.js', 'renderer/app.js']) {
  try {
    new vm.Script(read(f), { filename: f }).runInContext(ctx);
  } catch (e) {
    fail(`${f} threw while loading: ${e.message}`);
    loadFailed = true;
  }
}

(async () => {
  if (!loadFailed) {
    const boot = doc._l && doc._l.DOMContentLoaded;
    if (!boot) {
      fail('no DOMContentLoaded handler was registered — the app would never start');
    } else {
      try {
        await boot();
      } catch (e) {
        fail(`boot() threw: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 60));

      // THE check that matters: are the controls actually live?
      const wired = new Set(listeners.map((l) => l.id));
      const mustBeWired = ['startBtn', 'micBtn', 'sendBtn', 'chatInput', 'settingsBtn'];
      const notWired = mustBeWired.filter((id) => !wired.has(id));
      if (notWired.length) {
        fail(`these controls have NO event listener — the UI would be dead: ${notWired.join(', ')}`);
      } else {
        ok(`controls wired (${listeners.length} listeners across ${wired.size} targets)`);
      }

      const initFails = sandbox.window.__gemairInitFailures || [];
      if (initFails.length) {
        notes.push(`  warn ${initFails.length} init step(s) degraded: ${initFails.map((f) => f.label).join(', ')}`);
      }
    }
  }

  console.log('\nGemAir self-check\n');
  notes.forEach((n) => console.log(n));
  if (failures.length) {
    console.log('\n  ' + failures.length + ' FAILURE(S):\n');
    failures.forEach((f) => console.log('  ✗  ' + f));
    console.log('');
    process.exit(1);
  }
  console.log('\n  All checks passed.\n');
  process.exit(0);
})();
