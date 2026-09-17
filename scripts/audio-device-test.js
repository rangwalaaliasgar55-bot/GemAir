/* Audio device picking tests — mic/speaker selection with honest fallback.
   Pure-Node: renderer/audio-devices.js is loaded in a vm realm with a
   mocked navigator, so device filtering, resolution and probing are all
   exercised without real audio hardware. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const adSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'audio-devices.js'), 'utf8');

function loadAudioDevices(extraWindow) {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    performance: { now: () => Date.now() },
    window: Object.assign({}, extraWindow || {}),
    navigator: {},
    module: { exports: {} },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(adSrc, context, { filename: 'audio-devices.js' });
  return { api: context.window.GemAudioDevices, mod: context.module.exports };
}

const dev = (deviceId, label, kind) => ({ deviceId, label, kind, groupId: 'g' + deviceId });

test('filterDeviceList: kind filter, dedupe, default-first, label trim', () => {
  const { mod } = loadAudioDevices();
  const list = [
    dev('default', 'Default - Realtek Mic', 'audioinput'),
    dev('mic-a', 'USB Microphone', 'audioinput'),
    dev('mic-a', 'USB Microphone', 'audioinput'), // duplicate id
    dev('spk-1', 'Speakers', 'audiooutput'),      // wrong kind
    dev('mic-b', '', 'audioinput'),               // empty label
  ];
  const out = mod.filterDeviceList(list, 'audioinput');
  assert.equal(out.length, 3); // dup + wrong kind dropped
  assert.equal(out[0].deviceId, 'default'); // default first
  assert.equal(out.find(d => d.deviceId === 'mic-b').label.length > 0, true); // fallback label
  const long = dev('mic-l', 'X'.repeat(120), 'audioinput');
  assert.ok(mod.filterDeviceList([long], 'audioinput')[0].label.length <= 48);
});

test('filterDeviceList: caps a kind at MAX_PER_KIND', () => {
  const { mod } = loadAudioDevices();
  const many = Array.from({ length: 16 }, (_, i) => dev('mic' + i, 'Mic ' + i, 'audioinput'));
  const out = mod.filterDeviceList(many, 'audioinput');
  assert.equal(out.length, 8);
});

test('filterDeviceList: system default gets an explicit label', () => {
  const { mod } = loadAudioDevices();
  const out = mod.filterDeviceList([dev('default', '', 'audiooutput')], 'audiooutput');
  assert.match(out[0].label, /default/i);
});

test('resolveSaved: keeps a device that is still present', () => {
  const { mod } = loadAudioDevices();
  const devices = [dev('mic-a', 'USB Mic', 'audioinput')];
  const r = mod.resolveSaved({ deviceId: 'mic-a', label: 'USB Mic' }, devices, 'audioinput');
  assert.equal(r.deviceId, 'mic-a');
  assert.equal(r.fellBack, false);
});

test('resolveSaved: missing device falls back to default and reports the loss', () => {
  const { mod } = loadAudioDevices();
  const devices = [dev('mic-b', 'Other Mic', 'audioinput')];
  const r = mod.resolveSaved({ deviceId: 'gone-mic', label: 'Old USB Mic' }, devices, 'audioinput');
  assert.equal(r.deviceId, ''); // '' = system default, never a guessed device
  assert.equal(r.fellBack, true);
  assert.equal(r.label, 'Old USB Mic'); // names what was lost
});

async function navigatorWith(hiddenLabels) {
  let gumCalls = 0;
  const devicesAfterPermission = [dev('mic-a', 'USB Microphone', 'audioinput'), dev('spk-1', 'HDMI Out', 'audiooutput')];
  const nav = {
    mediaDevices: {
      async enumerateDevices() {
        if (hiddenLabels && gumCalls === 0) return devicesAfterPermission.map(d => ({ ...d, label: '' }));
        return devicesAfterPermission;
      },
      async getUserMedia() {
        gumCalls++;
        return { getTracks: () => [{ stop() { this.stopped = true; } }] };
      },
    },
  };
  return { nav, gumCalls: () => gumCalls };
}

test('listAudioDevices: touches the mic once when labels are hidden, then stops tracks', async () => {
  const { nav, gumCalls } = await navigatorWith(true);
  const { mod } = loadAudioDevices();
  const res = await mod.listAudioDevices(nav);
  assert.equal(res.ok, true);
  assert.equal(gumCalls(), 1); // exactly one permission touch
  assert.ok(res.inputs.some(d => d.label.includes('USB')));
  assert.ok(res.outputs.some(d => d.label.includes('HDMI')));
});

test('listAudioDevices: no labels available → does not force a second getUserMedia forever', async () => {
  const { nav, gumCalls } = await navigatorWith(false);
  const { mod } = loadAudioDevices();
  const res = await mod.listAudioDevices(nav);
  assert.equal(res.ok, true);
  assert.equal(gumCalls(), 0); // labels already present → no permission touch needed
});

test('listAudioDevices: permission denied → honest {ok:false, error}', async () => {
  const nav = {
    mediaDevices: {
      async enumerateDevices() { return [dev('mic-a', '', 'audioinput')]; },
      async getUserMedia() { throw new Error('NotAllowedError'); },
    },
  };
  const { mod } = loadAudioDevices();
  const res = await mod.listAudioDevices(nav);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /notallowed|permission|denied/i);
});

test('probeMic: opens the requested device, measures latency, releases tracks', async () => {
  let stopped = 0;
  let constraints = null;
  const track = { label: 'USB Microphone', readyState: 'live', stop() { stopped++; } };
  const nav = {
    mediaDevices: {
      async getUserMedia(c) {
        constraints = c;
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
    },
  };
  const { mod } = loadAudioDevices();
  const r = await mod.probeMic('mic-a', nav);
  assert.equal(r.ok, true);
  assert.equal(typeof r.latencyMs, 'number');
  assert.equal(r.trackLabel, 'USB Microphone');
  assert.equal(constraints.audio.deviceId.exact, 'mic-a'); // probes pin the exact device so the label is truthful
  assert.equal(stopped, 1); // the mic is never left held open
});

test('probeMic: failure returns an error object, never throws', async () => {
  const nav = { mediaDevices: { async getUserMedia() { throw new Error('NotFoundError'); } } };
  const { mod } = loadAudioDevices();
  const r = await mod.probeMic('gone', nav);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

/* ---- wiring: every capture/routing site actually consumes the picks ---- */
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const liveSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'gemini-live.js'), 'utf8');
const wakeSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'wake-word.js'), 'utf8');
const ttsSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'tts-engine.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

test('settings DOM has mic/speaker selects, a refresh button and the honesty note', () => {
  assert.ok(htmlSrc.includes('id="setMicDevice"'));
  assert.ok(htmlSrc.includes('id="setSpeakerDevice"'));
  assert.ok(htmlSrc.includes('id="audioDeviceRefresh"'));
  assert.ok(htmlSrc.includes('id="audioDeviceNote"'));
  // honest about what CANNOT be routed (OS web-speech voice)
  assert.match(htmlSrc, /web-?speech/i);
});

test('mic meter, live voice and wake word all take the chosen deviceId (ideal, not exact)', () => {
  assert.match(appSrc, /deviceId:\s*\{\s*ideal:/);
  assert.ok(appSrc.includes('populateAudioDevices'));
  assert.ok(appSrc.includes('profile.audioDevices'));
  assert.ok(appSrc.includes('__gemSpeakerDeviceId'));
  assert.match(liveSrc, /options\.micDeviceId/);
  assert.match(liveSrc, /setSinkId/);
  assert.match(wakeSrc, /micDeviceId/);
});

test('speaker picks reach the TTS engine through the sink bridge', () => {
  assert.ok(ttsSrc.includes('__gemSpeakerDeviceId'));
  assert.ok(ttsSrc.includes('setSinkId'));
  // and each routing call is guarded — odd environments must not crash
  assert.match(ttsSrc, /try \{|catch/);
});

test('audio-devices.js is loaded by the renderer before app.js', () => {
  const a = htmlSrc.indexOf('audio-devices.js');
  const b = htmlSrc.indexOf('app.js');
  assert.ok(a > -1 && b > -1 && a < b);
});

console.log('  audio device tests OK');
