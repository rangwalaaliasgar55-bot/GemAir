#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

console.log('\nGemAir renderer-lifecycle regression tests\n');

const start = app.indexOf("const rendererLifecycle = typeof AbortController === 'function'");
const end = app.indexOf('// ---------------------------------------------------------------------------\n// Theme', start);
assert(start >= 0 && end > start, 'renderer lifecycle helpers are missing');
const windowTarget = new EventTarget();
const context = { AbortController, EventTarget, Event, window: windowTarget, Set };
vm.runInNewContext(`${app.slice(start, end)}\nthis.api = { addLifecycleListener, registerRendererDisposer, disposeRendererLifecycle };`, context);
const target = new EventTarget();
let eventCount = 0, disposed = 0;
context.api.addLifecycleListener(target, 'change', () => eventCount++);
context.api.registerRendererDisposer(() => disposed++);
target.dispatchEvent(new Event('change'));
assert.strictEqual(eventCount, 1);
context.api.disposeRendererLifecycle();
target.dispatchEvent(new Event('change'));
assert.strictEqual(eventCount, 1, 'DOM listener remained after lifecycle disposal');
assert.strictEqual(disposed, 1, 'registered IPC disposer was not called');
context.api.disposeRendererLifecycle();
assert.strictEqual(disposed, 1, 'lifecycle disposal must be idempotent');
console.log('  ok   lifecycle disposal aborts DOM listeners and runs disposers once');

assert(preload.includes('function subscribeIpc(channel, callback)'), 'preload subscription helper is missing');
assert(preload.includes("return () => ipcRenderer.removeListener(channel, handler)"), 'IPC subscriptions do not return an unsubscribe function');
for (const channel of ['reminder:due', 'wake:toggle', 'ai:activity', 'hud:panel', 'connections:updated', 'connections:expired', 'desktop:focus', 'desktop:volume', 'desktop:theme', 'desktop:dnd', 'mode:changed']) {
  assert(preload.includes(`subscribeIpc('${channel}', cb)`), `${channel} is not disposable`);
}
assert(app.includes('return registerRendererDisposer(window.gemair && window.gemair.onActivity'), 'renderer does not retain IPC unsubscribe callbacks');
console.log('  ok   every long-lived main-to-renderer IPC subscription is disposable');

for (const guard of ['background3DStarted', 'orbStarted', 'globeStarted']) {
  assert(app.includes(`if (${guard}) return;`), `${guard} duplicate-start guard is missing`);
}
assert.strictEqual((app.match(/addLifecycleListener\(window, 'resize'/g) || []).length, 3, 'all canvas resize listeners must use the lifecycle scope');
assert(app.includes("addLifecycleListener(document, 'visibilitychange'"), 'visibility listener is not lifecycle-scoped');
assert(app.includes("addLifecycleListener(canvas, 'pointermove'"), 'globe pointer listener is not lifecycle-scoped');
console.log('  ok   canvas engines cannot duplicate loops and their listeners are scoped');

const ensureStart = app.indexOf('function ensureInteractive()');
const ensureEnd = app.indexOf('// ---------------------------------------------------------------------------', ensureStart);
const ensureSource = app.slice(ensureStart, ensureEnd);
assert(ensureSource.includes('bindEvents();'), 'interactive safety net does not invoke event binding');
assert(!ensureSource.includes('_eventsBound = true'), 'interactive safety net still marks events bound before binding');
assert(app.includes("function bindEvents() {\n  if (_eventsBound) return;\n  _eventsBound = true;"), 'primary event binding is not idempotent');
console.log('  ok   emergency interaction recovery no longer short-circuits bindEvents');

console.log('\n  All renderer-lifecycle regression tests passed.\n');
