#!/usr/bin/env node
'use strict';

// Avatar phoneme-lip-sync tests (Mark-LIV's "real mouth shapes you can read
// with the sound off", mapped onto GemAir's 2.5D avatar): distinct shapes
// for bilabials/vowels from the WORD TEXT, Unicode reduction so Latin,
// Cyrillic and Greek articulate from one rule set, plus the wiring that
// drives the avatar from TTS boundaries AND the Live loop's output
// transcription.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

console.log('\nGemAir — avatar phoneme lip-sync tests\n');

const src = fs.readFileSync(path.join(ROOT, 'renderer/avatar.js'), 'utf8');
const context = {
  window: { matchMedia: () => ({ matches: false }) },
  document: { createElement: () => ({ getContext: () => null, style: {} }), querySelector: () => null },
  navigator: {}, Image: function () {},
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  setTimeout, clearTimeout, console
};
context.window.document = context.document;
vm.runInNewContext(src, context, { filename: 'renderer/avatar.js' });
const internals = context.window.gemAvatar && context.window.gemAvatar._internals;
assert(internals && typeof internals.visemesForWord === 'function', 'avatar must expose its viseme pipeline for tests');
const { visemesForWord, VISEMES } = internals;
// visemesForWord returns arrays from the vm realm — compare structurally
// (deepStrictEqual would reject the foreign Array prototype).
const eqVisemes = (word, want, message) => {
  const got = JSON.parse(JSON.stringify(visemesForWord(word)));
  assert.deepStrictEqual(got, want, message);
};

// The rig must own the full Mark-style shape vocabulary.
const keys = new Set(VISEMES.map((v) => v.k));
for (const required of ['MM', 'FV', 'L', 'AA', 'EH', 'EE', 'OH', 'OO']) {
  assert(keys.has(required), `missing viseme shape: ${required}`);
}
const shape = Object.fromEntries(VISEMES.map((v) => [v.k, v]));
assert(shape.MM.h < 0.1, 'MM (bilabial) = lips closed — minimal opening');
assert(shape.OO.r > 0.8 && shape.OO.w < 0.7, 'OO = strongly rounded, narrow');
assert(shape.EE.w > 1.2 && shape.EE.h < 0.5, 'EE = spread wide, low opening');
assert(shape.AA.h >= 1.0, 'AA = fully open');
assert(shape.FV.h < 0.3, 'FV = teeth-on-lip nearly closed');
console.log('  ok   rig owns the full shape vocabulary (closure/round/spread/open/teeth)');

// Latin articulation: distinct consonant classes and vowel families.
eqVisemes('mum', ['MM', 'OO', 'MM'], 'bilabial closures bookend the rounded vowel');
eqVisemes('bip', ['MM', 'EE', 'MM'], 'b/p share the m-closure, i spreads');
eqVisemes('feather', ['FV', 'EH', 'AA', 'EH', 'OH'], 'f uses the teeth-on-lip shape; each vowel articulates; r rounds off');
// Consecutive duplicates collapse (aa is one opening, not two flaps).
eqVisemes('baa', ['MM', 'AA'], 'repeated vowels collapse into one held shape');
console.log('  ok   Latin: distinct bilabial/spread/round/teeth shapes, held-vowel collapse');

// Unicode reduction: accented Latin, Cyrillic and Greek from one rule set.
eqVisemes('café', ['AA', 'FV', 'EH'], 'NFD reduces é→e (accented Latin works)');
eqVisemes('мама', ['MM', 'AA', 'MM', 'AA'], 'Cyrillic м closed, а open');
eqVisemes('улица', ['OO', 'L', 'EE', 'AA'], 'Cyrillic у rounds, л articulates tongue');
eqVisemes('μπαμπάς', ['MM', 'AA', 'MM', 'AA'], 'Greek μπ/μπ closed, ά open');
eqVisemes('που', ['MM', 'OO'], 'Greek digraph ου = /u/ — one rounded shape');
eqVisemes('λόγου', ['L', 'OH', 'OO'], 'digraph reduction works mid-word after NFD accents');
console.log('  ok   Unicode reduction: Latin / Cyrillic / Greek articulate from one rule set');

// Scripts with no mouth-shape mapping fall back cleanly (never crash).
eqVisemes('你好', ['EH'], 'CJK falls back to a neutral open shape');
eqVisemes('', [], 'empty input yields nothing, not an error');
eqVisemes('123 456', ['EH'], 'digits-only input gets the neutral fallback');
console.log('  ok   clean fallbacks for scripts that hide pronunciation');

// ---------------------------------------------------------------------------
// Wiring: spoken text reaches the avatar from both TTS paths and Gemini Live
// ---------------------------------------------------------------------------
{
  const tts = fs.readFileSync(path.join(ROOT, 'renderer/tts-engine.js'), 'utf8');
  assert(tts.includes('speakWord'), 'TTS boundary events drive the avatar via speakWord()');
  const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert(app.includes('window.gemAvatar.speakWord'), 'app passes spoken words into the avatar');
  // Live loop: output transcription -> word pump -> speakWord (phoneme sync
  // for the native-audio voice, not a volume-meter jaw).
  assert(app.includes('onOutputTranscript'), 'live voice consumes output transcription');
  assert(/liveLipSync\.queue\.push\(word\)/.test(app), 'live transcript words feed the avatar lip-sync pump');
  assert(app.includes('pumpLiveLipSync'), 'the lip-sync pump is scheduled');
  // Both analysers drive the visualizer (mic while listening, Gem while speaking).
  assert(app.includes('setMicAnalyser'), 'mic analyser feeds avatar/waveform while listening');
  assert(internals && context.window.gemAvatar.setAudioAnalyser && context.window.gemAvatar.setMicAnalyser, 'avatar exposes both analyser hooks');
  console.log('  ok   wiring: TTS boundaries + live transcription both drive the phoneme mouth');
}

console.log('\nAll avatar lip-sync tests passed.\n');
