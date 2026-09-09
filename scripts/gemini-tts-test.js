#!/usr/bin/env node
'use strict';

// Gemini voice-tier tests: request shape, voice/model selection, PCM
// playback wiring, and free-fallback silence rules. No network, no display —
// WebAudio and fetch are faked, the real tts-engine.js runs.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');

const started = [];
function FakeAudioContext() {}
FakeAudioContext.prototype.state = 'running';
FakeAudioContext.prototype.resume = function () { return Promise.resolve(); };
FakeAudioContext.prototype.destination = {};
FakeAudioContext.prototype.createAnalyser = function () {
  return { fftSize: 0, connect() {} };
};
FakeAudioContext.prototype.createGain = function () {
  return { gain: { value: 1 }, connect() {}, disconnect() {} };
};
FakeAudioContext.prototype.createBuffer = function (channels, length, rate) {
  return { sampleRate: rate, length, getChannelData: () => new Float32Array(length) };
};
FakeAudioContext.prototype.createBufferSource = function () {
  const source = {
    buffer: null,
    playbackRate: { value: 1 },
    onended: null,
    connect() {},
    disconnect() {},
    stop() {},
    start() {
      started.push(source);
      setTimeout(() => { if (source.onended) source.onended(); }, 5);
    }
  };
  return source;
};

global.window = { AudioContext: FakeAudioContext };
if (typeof global.atob === 'undefined') {
  global.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
}
const pcmB64 = Buffer.from(new Int16Array([0, 1000, -1000, 32000]).buffer).toString('base64');
const ttsFixture = () => ({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmB64 } }] } }]
});

require(path.join(root, 'renderer', 'tts-engine.js'));
const tts = global.window.ttsEngine;

(async () => {
  assert(tts && typeof tts.speak === 'function', 'tts engine did not load');

  // 1. No key → false WITHOUT any network, so the caller falls back to Edge.
  {
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('must not fetch'); };
    const r = await tts.speak('hello', { engine: 'gemini', geminiApiKey: '' });
    assert.equal(r, false, 'keyless gemini must decline');
    assert.equal(calls, 0, 'keyless gemini must not touch the network');
    console.log('  ok   keyless Gemini declines silently for free fallback');
  }

  // 2. Request shape: REST generateContent + ?key=, AUDIO modality, male voice.
  {
    let seen = null;
    global.fetch = async (url, options) => {
      seen = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ttsFixture() };
    };
    const r = await tts.speak('hello there', {
      engine: 'gemini', geminiApiKey: 'AIzaTestKey1234567890',
      geminiModel: 'gemini-2.5-flash', geminiVoice: '', gender: 'male'
    });
    assert.equal(r, true, 'gemini speech failed');
    assert.ok(seen.url.includes(':generateContent?key=AIzaTestKey1234567890'), 'key must ride ?key=, got: ' + seen.url);
    assert.deepEqual(seen.body.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(seen.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
    assert.ok(started.length >= 1, 'no PCM source was started');
    console.log('  ok   Gemini request shape (key, AUDIO modality, male default voice)');
  }

  // 3. Live-only configured model is rerouted to a speakable one.
  {
    let seen = null;
    global.fetch = async (url) => {
      seen = url;
      return { ok: true, json: async () => ttsFixture() };
    };
    const r = await tts.speak('hi', {
      engine: 'gemini', geminiApiKey: 'AIzaTestKey1234567890',
      geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025', gender: 'female'
    });
    assert.equal(r, true);
    assert.ok(!seen.includes('native-audio'), 'live-only model reached the TTS endpoint: ' + seen);
    assert.ok(seen.includes('gemini-2.5-flash-preview-tts'), 'wrong fallback model: ' + seen);
    console.log('  ok   live-only models reroute to a speakable fallback');
  }

  // 4. Provider failure → false so Edge/system still get their turn.
  {
    global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) });
    const r = await tts.speak('hi', { engine: 'gemini', geminiApiKey: 'AIzaTestKey1234567890', geminiModel: 'gemini-2.5-flash' });
    assert.equal(r, false, 'failed gemini must decline to the free chain');
    console.log('  ok   Gemini failure declines to the free chain');
  }

  // 5. Explicit voice names pass through; unknown names fall back by gender.
  {
    assert.equal(tts.geminiVoiceName('Kore', 'male'), 'Kore');
    assert.equal(tts.geminiVoiceName('nope', 'female'), 'Aoede');
    assert.equal(tts.geminiVoiceName('', 'male'), 'Charon');
    console.log('  ok   voice-name allowlist with gender defaults');
  }

  console.log('\n  All Gemini voice tests passed.\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });
