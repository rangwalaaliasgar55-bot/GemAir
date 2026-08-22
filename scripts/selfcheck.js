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
  if (pkg.version !== '2.5.0') fail(`package version must be 2.5.0 (found ${pkg.version})`);
  if (lock.version !== pkg.version || (lock.packages && lock.packages[''] && lock.packages[''].version !== pkg.version)) fail('package-lock version does not match package.json');
  for (const asset of ['build/icon.png', 'build/icon.ico', 'build/icons/16x16.png', 'build/icons/256x256.png', 'build/icons/512x512.png', 'build/icons/1024x1024.png']) {
    const full = path.join(ROOT, asset);
    if (!fs.existsSync(full) || fs.statSync(full).size < 100) fail(`missing/empty release icon: ${asset}`);
  }
  if (!fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) || !read('CHANGELOG.md').includes('## [2.5.0]')) fail('CHANGELOG.md must document 2.5.0');
  else ok('2.5.0 release metadata and platform icons present');
  // 2.4 new lib files must exist
  for (const f of ['lib/connections.js', 'lib/modes.js', 'lib/window-tools.js', 'CONNECTIONS.md']) {
    if (!fs.existsSync(path.join(ROOT, f))) fail(`missing 2.4 file: ${f}`);
  }
  ok('2.4 lib + CONNECTIONS.md present');
} catch (e) { fail('release metadata check failed: ' + e.message); }

// ---------------------------------------------------------------------------
// 2.5 upgrade guards — version single-sourcing, CORS tightening, PWA
// ---------------------------------------------------------------------------
try {
  const httpLib = read('api/_lib/http.js');
  const vMatch = httpLib.match(/const VERSION = '([0-9.]+)'/);
  if (!vMatch || vMatch[1] !== JSON.parse(read('package.json')).version) {
    fail(`api/_lib/http.js VERSION (${vMatch ? vMatch[1] : 'missing'}) must equal package.json version`);
  } else ok('API layer VERSION matches package.json (single source of truth)');
} catch (e) { fail('api/_lib/http.js missing or unreadable: ' + e.message); }

try {
  const vercel = JSON.parse(read('vercel.json'));
  const wildcard = (vercel.headers || []).some((h) => (h.headers || []).some((x) => x.key === 'Access-Control-Allow-Origin' && x.value === '*'));
  if (wildcard) fail('vercel.json re-introduced a wildcard Access-Control-Allow-Origin — api handlers set precise CORS themselves');
  else ok('no wildcard CORS in vercel.json (precise per-handler CORS enforced)');
} catch (e) { fail('vercel.json invalid: ' + e.message); }

try {
  for (const f of ['renderer/sw.js', 'renderer/manifest.webmanifest', 'renderer/assets/gemair-512.png']) {
    if (!fs.existsSync(path.join(ROOT, f))) fail(`missing PWA asset: ${f}`);
  }
  if (!read('renderer/index.html').includes('rel="manifest"')) fail('index.html no longer links the web manifest (PWA install broken)');
  else ok('PWA shell present (manifest linked, sw.js + icons shipped)');
} catch (e) { fail('PWA check failed: ' + e.message); }

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

// V2: ids that app.js CREATES at runtime (injected into a container that does
// exist in index.html). They can never appear in the static markup, so they are
// declared here rather than silently weakening the check. Anything not in this
// list must still exist in index.html.
const RUNTIME_IDS = new Set([
  // S1 — SAT-LINK SEARCH tab is rendered into #satPanel on demand
  'satSearchInput', 'satSearchGo', 'satSearchResults',
  // S7 — workflow gallery cards render into #workflowGallery
  'wfGalleryGrid',
  // S10 — quick-command editor renders into the expert panel
  'qcEditorInput', 'qcEditorSave', 'qcEditorCancel',
  // T2 — reasoning strip is created per reply
  'reasonStrip',
  // 2.4 — mode sites designer rows, plan-act steps, recent missions, desktop test output
  'modeSiteRow', 'planStepRow', 'recentMissionItem', 'desktopTestOutput',
  'mcHead', 'mcIcon', 'mcDesc', 'mcMeta'
]);

const refs = [...new Set([...appJs.matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]))];
const missing = refs.filter((r) => !ids.has(r) && !RUNTIME_IDS.has(r));
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
// V2 — 2.2 surface checks. Every feature added this round has at least one
// static assertion here, so a future refactor that drops the markup or the
// handler fails CI instead of shipping a dead control.
// V4 — 2.4 surfaces
// ---------------------------------------------------------------------------
const REQUIRED_IDS = {
  'S1 SAT-LINK feed panel': ['satPanel'],
  'S2 process monitor': ['processList', 'procFilter', 'refreshProcsBtn'],
  'S3 tasks panel': ['todoList', 'todoInput', 'todoAdd', 'todoCount'],
  'S4 language picker': ['setLanguage'],
  'S7 workflow gallery': ['workflowGallery'],
  'S8 offline brain toggle': ['setLocalBrain', 'localBrainHint'],
  'T1 account controls': ['accountState', 'signInGoogleBtn', 'signOutBtn'],
  'T3 rating controls': ['settingsStars', 'ratingSummary', 'exportRatingsBtn'],
  'T5 ambient controls': ['setAmbientTrack', 'setAmbientVolume', 'ambientVolVal'],
  'C1 Connection Hub': ['connectionHubCard', 'connectChatGPTBtn', 'chatgptStatusDot', 'chatgptEmail', 'chatgptPlanBadge', 'chatgptUsage', 'disconnectChatGPTBtn', 'captureChatGPTBtn'],
  'D Gemini Connect': ['connectGeminiBtn', 'geminiStatusDot', 'geminiEmail', 'geminiPlanBadge', 'geminiUsage', 'disconnectGeminiBtn', 'captureGeminiBtn', 'openAIStudioBtn'],
  'H Hub UI': ['freeCoreDot', 'brainPriorityPicker', 'clearAllConnectionsBtn', 'activeBrainChip', 'activeBrainName', 'activeBrainDot', 'connectionsStatusRow'],
  'A Window Tools': ['etabDesktop', 'desktopWindowsList', 'focusedApp', 'focusedTitle', 'refreshDesktopBtn'],
  'A1 Plan-Act': ['planActPanel', 'planActBody', 'planActState', 'showPlanBtn', 'runPlanBtn'],
  'M Modes': ['nowCard', 'nowMode', 'nowBrain', 'nowReminder', 'nowBattery', 'currentModeChip', 'topbarModeChips', 'modesList', 'modeDesignerCard', 'modeNameInput', 'modeAppsInput', 'modeSitesList', 'modeVolumeInput', 'modeThemeInput', 'saveModeBtn', 'applyModeBtn'],
  'U Settings Reorg': ['settingsSearch', 'settingsBody'],
  'U Experimental Modals': ['experimentalWarningModal', 'reconnectModal', 'modeSweep']
};
const missingFeatureIds = [];
for (const [feature, list] of Object.entries(REQUIRED_IDS)) {
  const gone = list.filter((id) => !ids.has(id));
  if (gone.length) missingFeatureIds.push(`${feature}: ${gone.join(', ')}`);
}
if (missingFeatureIds.length) fail(`2.2 feature markup missing — ${missingFeatureIds.join(' | ')}`);
else ok(`${Object.keys(REQUIRED_IDS).length} 2.2 feature surfaces present in the markup`);

// The SAT-LINK tabs must carry the data-sat attribute the handler switches on.
const satTabs = [...html.matchAll(/class="sat-tab[^"]*"[^>]*data-sat="([a-z]+)"/g)].map((m) => m[1]);
const wantSat = ['today', 'rap', 'search', 'alerts'];
const missingSat = wantSat.filter((t) => !satTabs.includes(t));
if (missingSat.length) fail(`S1: SAT-LINK tab(s) missing data-sat: ${missingSat.join(', ')}`);
else ok('S1: all four SAT-LINK tabs carry a data-sat target');

// Every modal must be an announced dialog (U4).
const modalIds = [...html.matchAll(/class="modal-backdrop"[^>]*id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const unannounced = modalIds.filter((id) => {
  const idx = html.indexOf(`id="${id}"`);
  const tag = html.slice(Math.max(0, idx - 200), idx + 200);
  return !/role="dialog"/.test(tag) || !/aria-modal="true"/.test(tag);
});
if (unannounced.length) fail(`U4: modal(s) without role=dialog/aria-modal: ${unannounced.join(', ')}`);
else ok(`U4: all ${modalIds.length} modals declare role=dialog + aria-modal`);

// U5: the --dim token does not exist (themes.js emits --text-dim).
const cssSrc = read('renderer/style.css');
if (/var\(--dim[,)]/.test(cssSrc)) fail('U5: style.css references the nonexistent --dim token (use --text-dim)');
else ok('U5: no references to the nonexistent --dim token');

// R4: the 3-column layout rule must be inside a valid comment context.
if (!/^\.stx-left,\s*\.stx-center,\s*\.stx-right\s*\{[^}]*display:\s*flex/m.test(cssSrc)) {
  fail('R4: the .stx-left/.stx-center/.stx-right flex rule is missing or malformed');
} else ok('R4: the 3-column .stx flex rule is intact');
if (/border:\s*1px\s+border-dashed/.test(cssSrc)) fail('R4: invalid "1px border-dashed" shorthand is back');
else ok('R4: no invalid border shorthand');

// U3: exactly one DEFAULTS source, and no stray contradicting literals.
if (!/const DEFAULTS = Object\.freeze\(/.test(appJs)) fail('U3: the DEFAULTS constant is gone');
else ok('U3: a single frozen DEFAULTS constant exists');
if (/profile\.theme \|\| 'cyan'/.test(appJs)) fail("U3: the stray 'cyan' theme default is back");
else ok('U3: no contradicting hard-coded theme default');

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
  printManualMatrix();
  process.exit(0);
})();

/**
 * V4 — 2.4 manual test matrix (extends V3)
 */
function printManualMatrix() {
  const rows = [
    ['1', 'Boot', 'Launch GemAir. Boot sequence completes; SYS chip reads SYSTEMS NOMINAL (or names degraded). Version tag v2.5.0'],
    ['2', 'Free reply', 'With NO API key, send "hello". Real reply streams in. TEST CONNECTION reports free core'],
    ['3', 'Bad key honest', 'Paste bogus key + Groq preset, TEST CONNECTION must FAIL visibly, says free core NOT used'],
    ['4', 'EDGE voice', 'Voice engine = Edge neural. Send message. Gem speaks with Microsoft neural voice'],
    ['5', 'Streaming speech', 'Ask 3-sentence answer. Speech starts on sentence 1 while rest generating, no duplicate final read'],
    ['6', 'Barge-in', 'While Gem mid-sentence, press mic and speak. Audio stops INSTANTLY, no queued resume'],
    ['7', 'START off', 'Start AI loop, let Gem talk, click STOP. Speech stops immediately'],
    ['8', 'Visemes', 'Mouth tracks words; aura reacts to mic level'],
    ['9', 'Workflows', 'Agent Town → Workflow Gallery: click each 12 cards. Each opens HITL confirm or real result'],
    ['10', 'HITL', 'Optimize for gaming CANCEL does nothing; accept switches to High Performance not Power Saver'],
    ['11', 'Process monitor', 'System Core → PROCESSES: real names/PIDs, filter works, End prompts confirm and refuses protected'],
    ['12', 'Tasks', 'System Core → TASKS add/complete/delete, weekly sparklines move'],
    ['13', 'SAT-LINK', 'TODAY/RAP/SEARCH/ALERTS all load real data or honest empty'],
    ['14', 'Themes', 'Cycle every theme incl RGB, sparklines/mood/map keep rendering'],
    ['15', 'Settings persist', 'Change voice, theme, language, ambient track+volume, save, quit, relaunch restored'],
    ['16', 'Ambient preview', 'Toggle ambient score — audio starts immediately, track+volume change live'],
    ['17', 'Language RTL', 'Language → اردو translates and mirrors RTL'],
    ['18', 'Accessibility', 'Open each modal (settings, theme, download, breathe, report, experimental, reconnect). Tab trapped, Escape closes all'],
    ['19', 'Layout', 'Resize to 950px wide and 700px tall — topbar wraps, nothing clipped'],
    ['20', 'Reasoning', 'Multi-step request shows REASONING strip narrating real tool calls'],
    ['21', 'Window memory', 'Move/resize, quit, relaunch returns same place; unplug monitor clamped on-screen'],
    ['22', 'Rating', 'After 8 missions star prompt appears once, average shown, export JSON'],
    ['23', 'Connect ChatGPT', 'Settings → CONNECTIONS → CONNECT CHATGPT → embedded real chatgpt.com login (email/Google SSO) → Capture → shows email + plan badge, dot green/amber, encrypted via safeStorage (never renderer-visible)'],
    ['24', 'Streamed via ChatGPT', 'With ChatGPT connected, chat streams reply voiced via Edge TTS, MEDIA LINK shows ACTIVE brain CHATGPT live'],
    ['25', 'Tools over connected', 'Over connected ChatGPT brain, run 3 tools: get_weather, web_search, list_windows — adapter injects TOOLS as JSON-in-prompt, parses tool-calls from plain text, feeds SAME executeTool loop'],
    ['26', 'Disconnect fallback', 'Disconnect ChatGPT → dot gray, free-core fallback instant, never dead air, toast shows fallback'],
    ['27', 'Gemini connect', 'CONNECT GEMINI → Google login embedded → capture Gemini web session (PSID) → route through consumer backend with identical adapter, fallback and warning'],
    ['28', 'AI Studio fallback', 'If Gemini capture unstable, one tap opens AI Studio, user signs in with Google inside it, app reads credential locally — still zero key copy-paste'],
    ['29', 'Connection Hub UI', 'One card rows CHATGPT|GEMINI|FREE CORE: live dots (CONNECTED green/EXPERIMENTAL amber/FALLBACK blue), account email, plan, today usage, priority picker. MEDIA LINK + status chips show ACTIVE brain live'],
    ['30', 'Create CHILL mode', 'Settings → Desktop & Modes → Mode Designer: add apps and sites rows, pick browser per site, volume slider, save — creates CHILL mode, syncs into profile'],
    ['31', 'Voice trigger modes', 'Say "chill mode" → cinematic sweep using themes.js tokens, launches apps+sites+volume+sweep, topbar shows current mode chip, announces via TTS'],
    ['32', 'Plan-Act loops', 'Big request "set up my workspace for editing" → decomposed into numbered steps, live progress checklist, per-step retry once, final spoken+written summary, dry-run chip SHOW PLAN / RUN'],
    ['33', 'Window tools', 'Test launch_app, focus_app, snap_window left|right|max, minimize_all, next_virtual_desktop, open_site url+ browser, list_windows returns titles+apps'],
    ['34', 'Context awareness', 'Track focused app/window (polling IPC) so follow-ups work: "open it there too", "move this to the right"'],
    ['35', 'Restart persists', 'Restart app — sessions and modes persist (encrypted storage + modes file)'],
    ['36', 'Clear storage', 'Disconnect clears encrypted storage — gemair-connections.enc deleted, dots gray']
  ];
  const line = (n, area, what) => console.log('  ' + n.padStart(2, ' ') + '  ' + area.padEnd(23, ' ') + what);
  console.log('  ============================================================');
  console.log('  MANUAL TEST MATRIX — confirm on a real machine before release');
  console.log('  ============================================================');
  line('#', 'AREA', 'EXPECTED');
  console.log('  ' + '-'.repeat(58));
  rows.forEach(([n, area, what]) => line(n, area, what));
  console.log('');
}
