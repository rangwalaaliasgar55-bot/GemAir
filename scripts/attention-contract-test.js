#!/usr/bin/env node
/* Gem Air — contract test.
   The UI, the preload bridge, the main-process IPC and the preview shim must agree.
   This catches a renderer calling an API that was never registered. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

const preload = read('preload.js');
const ipc = read('lib/attention/ipc.js');
const previewHarness = read('scripts/attention-preview.js');
const previewShim = read('renderer/preview/bridge.js');
const uiSources = ['renderer/air/attention-ui.js', 'renderer/air/island.js'].map(read).join('\n');
const mainJs = read('main.js');

/** Methods the renderers actually call: api.foo( / air.foo( */
function calledMethods(src) {
  const found = new Set();
  for (const m of src.matchAll(/\b(?:api|air)\.([a-zA-Z]+)\s*\(/g)) found.add(m[1]);
  return found;
}
/** Methods the preload bridge exposes on window.air */
function exposedMethods() {
  const block = preload.slice(preload.indexOf("exposeInMainWorld('air'"));
  const found = new Set();
  for (const m of block.matchAll(/^\s{2}([a-zA-Z]+):/gm)) found.add(m[1]);
  return found;
}
function ipcChannels(src) {
  const found = new Set();
  for (const m of src.matchAll(/'(air:[a-zA-Z]+)'/g)) found.add(m[1]);
  return found;
}

console.log('\napi contract');

const called = calledMethods(uiSources);
const exposed = exposedMethods();

test('every method the UI calls is exposed by the preload bridge', () => {
  const missing = [...called].filter((m) => !exposed.has(m) && m !== 'feed' && m !== 'enforcements');
  assert.deepStrictEqual(missing, [], 'missing from preload: ' + missing.join(', '));
});

test('every preload method maps to a registered IPC channel', () => {
  const registered = new Set();
  for (const m of ipc.matchAll(/ipcMain\.handle\('(air:[a-zA-Z]+)'/g)) registered.add(m[1]);
  for (const m of mainJs.matchAll(/ipcMain\.handle\('(air:[a-zA-Z]+)'/g)) registered.add(m[1]);

  const invoked = new Set();
  const block = preload.slice(preload.indexOf("exposeInMainWorld('air'"));
  for (const m of block.matchAll(/invoke\('(air:[a-zA-Z]+)'/g)) invoked.add(m[1]);

  const missing = [...invoked].filter((c) => !registered.has(c));
  assert.deepStrictEqual(missing, [], 'preload invokes unregistered channel(s): ' + missing.join(', '));
});

test('the preview shim implements the same surface as the preload bridge', () => {
  const shim = new Set();
  const block = previewShim.slice(previewShim.indexOf('window.air = {'));
  for (const m of block.matchAll(/^\s{4}([a-zA-Z]+):/gm)) shim.add(m[1]);
  const missing = [...exposed].filter((m) => !shim.has(m));
  assert.deepStrictEqual(missing, [], 'preview shim missing: ' + missing.join(', '));
});

test('the preview harness handles every channel the shim invokes', () => {
  const invoked = new Set();
  for (const m of previewShim.matchAll(/invoke\('([a-z]+:[a-zA-Z]+)'/g)) invoked.add(m[1]);
  const handled = new Set();
  for (const m of previewHarness.matchAll(/'([a-z]+:[a-zA-Z]+)':/g)) handled.add(m[1]);
  const missing = [...invoked].filter((c) => !handled.has(c));
  assert.deepStrictEqual(missing, [], 'preview harness missing handler(s): ' + missing.join(', '));
});

console.log('\nwindows integration wiring');

test('main process boots the attention service and the island window', () => {
  assert.ok(mainJs.includes('new AttentionService'), 'service not constructed');
  assert.ok(mainJs.includes('attentionIpc.register'), 'ipc not registered');
  assert.ok(mainJs.includes('ensureIslandWindow'), 'island window not created');
  assert.ok(mainJs.includes('attention.stop()'), 'service not stopped on quit');
});

test('the island window is frameless, transparent, always-on-top and sandboxed', () => {
  const win = read('lib/attention/island-window.js');
  for (const key of ['frame: false', 'transparent: true', 'alwaysOnTop: true', 'skipTaskbar: true', 'sandbox: true', 'contextIsolation: true', 'nodeIntegration: false']) {
    assert.ok(win.includes(key), 'island window missing ' + key);
  }
});

test('the tray exposes island and dashboard controls', () => {
  assert.ok(mainJs.includes('Show Gem Air island'), 'tray missing island control');
  assert.ok(mainJs.includes('Attention dashboard'), 'tray missing dashboard control');
});

test('the island renderer declares a strict CSP and loads no remote code', () => {
  const html = read('renderer/air/island.html');
  assert.ok(html.includes("default-src 'none'"), 'island CSP not locked down');
  assert.ok(!/src="https?:/.test(html), 'island loads remote resources');
});

console.log('\nreference-product exclusions');

test('no community, leaderboard, beta, donate or build-in-public surfaces exist', () => {
  const files = ['renderer/air/attention-ui.js', 'renderer/air/island.js', 'renderer/air/island.html', 'lib/attention/ipc.js', 'lib/attention/service.js'];
  const banned = [/leaderboard/i, /build in public/i, /join beta/i, /\bdonate\b/i, /community/i];
  for (const f of files) {
    const src = read(f);
    for (const re of banned) assert.ok(!re.test(src), `${f} contains banned surface ${re}`);
  }
});

test('focusx.site is integrated as a resource, not an advertisement', () => {
  const ui = read('renderer/air/attention-ui.js');
  const hits = (ui.match(/focusx/gi) || []).length;
  assert.ok(hits > 0, 'focusx.site should be reachable from the app');
  assert.ok(hits < 20, 'focusx.site should not dominate the UI');
  assert.ok(ipc.includes('air:openFocusx'), 'focusx link should go through the guarded IPC');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures' : ''}\n`);
