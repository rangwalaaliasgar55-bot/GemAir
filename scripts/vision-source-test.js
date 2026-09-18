/* Vision source-labelling tests — every frame stream tells the model what
   it came from, so a screenshot containing GemAir's own avatar is never
   mistaken for a photo of the user. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const liveSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'gemini-live.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function loadLive() {
  const fetched = [];
  const context = {
    console, Math, JSON, Date, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    window: {},
    navigator: { onLine: true },
    location: { protocol: 'file:' },
    fetch: (...a) => { fetched.push(a); return Promise.resolve({ ok: false, json: () => Promise.resolve({}) }); },
    WebSocket: function () { throw new Error('no socket in tests'); },
    AudioContext: null,
    module: { exports: {} },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(liveSrc, context, { filename: 'gemini-live.js' });
  return context.window.geminiLive;
}

function fakeSession() {
  const sent = [];
  return {
    sent,
    ready: true,
    log: [],
    _ws: { send: (m) => sent.push(JSON.parse(m)) },
  };
}

test('labelVisionSource sends a clientContent note BEFORE frames flow', () => {
  const live = loadLive();
  const s = fakeSession();
  const ok = live.labelVisionSource(s, 'screen');
  assert.equal(ok, true);
  assert.equal(s.sent.length, 1);
  const msg = s.sent[0];
  assert.ok(msg.clientContent, 'goes through clientContent so the model reads it in-context');
  const parts = msg.clientContent.turns[0].parts;
  assert.equal(msg.clientContent.turns[0].role, 'user');
  assert.match(String(parts[0].text), /screen/i);
  assert.match(String(parts[0].text), /avatar/i); // names the trap explicitly
});

test('screen note and camera note say different things', () => {
  const live = loadLive();
  const s1 = fakeSession(); live.labelVisionSource(s1, 'screen');
  const s2 = fakeSession(); live.labelVisionSource(s2, 'camera');
  const t1 = s1.sent[0].clientContent.turns[0].parts[0].text;
  const t2 = s2.sent[0].clientContent.turns[0].parts[0].text;
  assert.notEqual(t1, t2);
  assert.match(t1, /SCREEN/);
  assert.match(t2, /CAMERA/);
});

test('labelVisionSource: unready session or send failure → graceful false, never throws', () => {
  const live = loadLive();
  assert.equal(live.labelVisionSource(null, 'screen'), false);
  assert.equal(live.labelVisionSource({ ready: false }, 'screen'), false);
  const broken = { ready: true, log: [], _ws: { send() { throw new Error('closed'); } } };
  assert.equal(live.labelVisionSource(broken, 'screen'), false);
});

test('live screen share labels its source before the first frame', () => {
  const fnStart = appSrc.indexOf('function startLiveScreenShare');
  const label = appSrc.indexOf("labelVisionSource(geminiLiveVoice, 'screen')", fnStart);
  const send = appSrc.indexOf('const send = async', fnStart);
  assert.ok(label > fnStart && label < send, 'the note must precede the send loop');
});

test('live camera share labels its source as camera', () => {
  const fnStart = appSrc.indexOf('function startLiveCameraShare');
  assert.ok(appSrc.indexOf("labelVisionSource(geminiLiveVoice, 'camera')", fnStart) > fnStart);
});

test('one-shot see_screen tool annotates its result as a screen capture', () => {
  const fnStart = mainSrc.indexOf('async function seeScreen');
  const fnEnd = mainSrc.indexOf('async function inspectScreenChange', fnStart);
  const body = mainSrc.slice(fnStart, fnEnd);
  assert.ok(body.includes("source: 'screen'"));
  assert.match(body, /avatar/i);
  assert.match(body, /not a photo of the user/i);
});

test('gemini-live exports labelVisionSource', () => {
  const live = loadLive();
  assert.equal(typeof live.labelVisionSource, 'function');
});
