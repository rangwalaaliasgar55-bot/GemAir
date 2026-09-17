/* Silent language memory tests — the app notices how you actually speak
   and future sessions adapt, without ever overriding an explicit pick.
   Renderer wiring is checked statically (app.js is DOM-bound). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

test('detection results are persisted per user message, only on change', () => {
  const i = appSrc.indexOf('const lang = detectLanguage(text);');
  const region = appSrc.slice(i, i + 700);
  assert.ok(region.includes('profile.lastSpokenLang = lang'), 'persisted');
  assert.ok(region.includes('lang !== profile.lastSpokenLang'), 'write only when it changed (no per-keystroke disk hammering)');
  assert.ok(region.includes('persistProfile()'), 'recorded to the profile file');
});

test('explicit STT choice always wins over the remembered language', () => {
  const i = appSrc.indexOf('function updateSttLanguageUi');
  const body = appSrc.slice(i, i + 900);
  assert.ok(body.includes('LANGUAGE_TO_STT'), 'mapping exists');
  const sttFirst = body.indexOf('profile.voice && profile.voice.sttLang');
  const auto = body.indexOf('auto || DEFAULTS.sttLang');
  assert.ok(sttFirst > -1 && auto > sttFirst, 'auto is a fallback after the explicit pick');
});

test('auto mode is visible in the chip — adaptation is never hidden', () => {
  const i = appSrc.indexOf('function updateSttLanguageUi');
  const body = appSrc.slice(i, i + 900);
  assert.ok(body.includes("'·auto'"), 'the chip marks when the pick is automatic');
});

test('only script-detectable languages map to STT locales (no guessing)', () => {
  const i = appSrc.indexOf('LANGUAGE_TO_STT');
  const map = appSrc.slice(i, i + 160);
  assert.ok(map.includes("hi: 'hi-IN'"));
  assert.ok(map.includes("ur"));
  assert.ok(!map.includes("'en'"), 'English needs no remap — it is the default');
});

/* The device-change-continuity feature pairs with this file's conventions:
   a remembered speaking language is profile data, like device picks. */
test('mic change mid-call reconnects live with resumption, not a restart', () => {
  const i = appSrc.indexOf('function setupAudioDevicePicker');
  const body = appSrc.slice(i, i + 2600);
  assert.ok(body.includes('window.__gemLiveVoice'), 'sees the active session');
  assert.ok(body.includes('live.reconnect()'), 'reconnects…');
  assert.ok(body.includes('/resumption/') || body.includes('resumption'), '…with the conversation kept');
  assert.ok(body.includes('micChanged'), 'only when the MIC actually changed');
});

test('speaker change does NOT reconnect — only the sink moves', () => {
  const i = appSrc.indexOf("$('#setSpeakerDevice')?.addEventListener('change'");
  assert.ok(i > -1, 'speaker listener exists');
  const body = appSrc.slice(i, i + 300);
  assert.ok(body.includes('syncSpeakerSink'));
  assert.ok(!body.includes('reconnect()'), 'speaker swap stays disruption-free');
});
