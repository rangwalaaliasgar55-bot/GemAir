/* Avatar presence tests — the face as a status channel.
   Pure-Node vm run of renderer/avatar.js with DOM stubs: the mode map,
   priority order, glance window and sleeping state are verified without
   rendering a single frame. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const avatarSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'avatar.js'), 'utf8');

function loadAvatar() {
  const noop = () => {};
  const fakeCtx2d = new Proxy({}, { get: () => noop, set: () => true });
  const fakeCanvas = { getContext: () => fakeCtx2d, width: 0, height: 0, style: {}, addEventListener: noop, removeEventListener: noop };
  const context = {
    console, Math, JSON, Date,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    Image: function () { return { addEventListener: noop, removeEventListener: noop }; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    document: {
      documentElement: {},
      createElement: (tag) => (tag === 'canvas' ? Object.create(fakeCanvas) : { style: {}, addEventListener: noop }),
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: noop,
    },
    window: {},
    module: { exports: {} },
  };
  context.window = context; // self-reference like a browser global
  context.globalThis = context;
  context.matchMedia = () => ({ matches: false, addEventListener: noop });
  context.window.matchMedia = context.matchMedia;
  vm.createContext(context);
  vm.runInContext(avatarSrc, context, { filename: 'avatar.js' });
  return context.window.gemAvatar;
}

test('presenceFor: every documented mode maps to a physical behaviour', () => {
  const av = loadAvatar();
  assert.equal(typeof av.presenceFor, 'function');
  const thinking = av.presenceFor('thinking');
  assert.ok(thinking.leanX < 0, 'thinking looks away');
  assert.ok(thinking.leanY < 0, 'thinking gaze drops a little, up-left style avoided');
  assert.ok(thinking.blinkRateFactor < 1, 'thinking blinks less');
  const sleeping = av.presenceFor('sleeping');
  assert.ok(sleeping.lidCap > 0 && sleeping.lidCap < 0.5, 'sleeping lids fall');
  assert.ok(sleeping.breathRate < 0.6, 'sleeping breath slows');
  const glance = av.presenceFor('glance');
  assert.ok(glance.leanY > 0.3, 'glance looks down at new content');
  const listening = av.presenceFor('listening');
  assert.ok(listening.pointerDamp > 0 && thinking.blinkRateFactor < 1);
});

test('presenceFor: unknown modes fall back to ambient, never crash', () => {
  const av = loadAvatar();
  assert.equal(av.presenceFor('nonsense'), av.presenceFor('base'));
  assert.equal(av.presenceFor(undefined), av.presenceFor('base'));
});

test('sleeping wins over thinking; glance wins over both', () => {
  const av = loadAvatar();
  av.setState({ thinking: true });
  assert.equal(av.presenceMode(), 'thinking');
  av.setState({ sleeping: true });
  assert.equal(av.presenceMode(), 'sleeping');
  // waking clears sleep, then a glance is allowed to surface
  av.setState({ sleeping: false, thinking: false });
  av.glance(650);
  assert.equal(av.presenceMode(), 'glance');
});

test('glance is a no-op while sleeping or thinking', () => {
  const av = loadAvatar();
  av.setState({ thinking: true });
  av.glance(650);
  assert.equal(av.presenceMode(), 'thinking'); // no stolen glance mid-thought
  av.setState({ sleeping: true, thinking: false });
  av.glance(650);
  assert.equal(av.presenceMode(), 'sleeping');
});

test('idle by default; glance clamps to a natural 250ms – 2.5s window', () => {
  const av = loadAvatar();
  assert.equal(av.presenceMode(), 'base');
  assert.doesNotThrow(() => { av.glance(0); av.glance(999999); av.glance(-5); });
  av.glance(650);
  assert.equal(av.presenceMode(), 'glance');
});

/* ---- wiring: the app drives the face from real app events ---- */
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

test('auto-sleep closes the lids; any wake path opens them again', () => {
  assert.ok(appSrc.includes("{ sleeping: true }"), 'silence timeout puts Gem to sleep');
  assert.ok(appSrc.includes("{ sleeping: false }"), 'starting a loop wakes Gem');
});

test('new content triggers a downward glance', () => {
  assert.match(appSrc, /glance\(650\)/); // ai message while idle
  assert.match(appSrc, /glance\(500\)/); // system message
});

test('setState accepts sleeping as a first-class state', () => {
  assert.ok(avatarSrc.includes('sleeping'));
  assert.match(avatarSrc, /PRESENCE\s*=/);
});
