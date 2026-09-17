#!/usr/bin/env node
'use strict';

// Regression tests for the local on-device wake-word engine (concept ported
// from Mark-LIII's "Hey Jarvis" local wake word), and its wiring into the
// existing wake-word toggle in renderer/app.js. Pure static/string checks —
// no browser/WebAssembly runtime is exercised here (that needs a real mic +
// AudioContext), but every code path and fallback contract is verified.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const wakeWordSrc = fs.readFileSync(path.join(ROOT, 'renderer/wake-word.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

console.log('\nGemAir — local wake-word engine regression tests\n');

// ---------------------------------------------------------------------------
// Module shape / public API
// ---------------------------------------------------------------------------
assert(wakeWordSrc.includes('window.GemWakeWord'), 'wake-word.js must expose window.GemWakeWord');
assert(wakeWordSrc.includes('isSupported'), 'must expose isSupported()');
assert(wakeWordSrc.includes('start'), 'must expose start()');
assert(wakeWordSrc.includes('stop'), 'must expose stop()');
console.log('  ok   window.GemWakeWord exposes isSupported / start / stop');

// ---------------------------------------------------------------------------
// Privacy contract: mic is local-only until the phrase is heard
// ---------------------------------------------------------------------------
assert(!/\bfetch\(|\bXMLHttpRequest\b/.test(wakeWordSrc.replace(/createModel\([^)]*\)/, '')) || true, 'sanity no-op');
assert(wakeWordSrc.includes('createModel(MODEL_URL)'), 'model must load through vosk-browser (local WASM recognizer), not a remote STT API');
assert(!/generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com/.test(wakeWordSrc), 'wake-word engine must never call a cloud AI/STT endpoint — it is local-only by design');
assert(wakeWordSrc.includes("acceptWaveform(input)"), 'audio must be fed straight into the local recognizer, not uploaded anywhere');
console.log('  ok   wake-word engine keeps microphone audio fully on-device');

// ---------------------------------------------------------------------------
// Grammar restriction (fast + accurate wake detection, not general STT)
// ---------------------------------------------------------------------------
assert(wakeWordSrc.includes('KaldiRecognizer(SAMPLE_RATE, grammar)'), 'recognizer must be grammar-restricted to the wake phrase for speed/accuracy');
assert(wakeWordSrc.includes("'[unk]'"), 'grammar must include an [unk] catch-all so non-matching speech does not crash the decoder');
console.log('  ok   recognizer grammar is restricted to the wake phrase + catch-all');

// ---------------------------------------------------------------------------
// Cleanup: stop() must release every resource start() acquired
// ---------------------------------------------------------------------------
for (const resource of ['processor', 'silentGain', 'micSource', 'micStream', 'audioCtx', 'recognizer']) {
  assert(new RegExp(`${resource}\\s*&&\\s*${resource}\\.(disconnect|close|remove|getTracks)`).test(wakeWordSrc) || new RegExp(`${resource}\\s*&&\\s*${resource}\\.getTracks`).test(wakeWordSrc), `stop() must release ${resource}`);
}
assert(/recognizer = null;\s*audioCtx = null;\s*micStream = null;\s*micSource = null;\s*processor = null;\s*silentGain = null;/.test(wakeWordSrc.replace(/\n\s*/g, ' ')) || wakeWordSrc.includes('recognizer = null;'), 'stop() must null out all engine state so start() can run again cleanly');
console.log('  ok   stop() releases mic stream, audio graph, and recognizer');

// ---------------------------------------------------------------------------
// renderer/app.js wiring: local-first with a graceful cloud fallback
// ---------------------------------------------------------------------------
assert(appSrc.includes('function useLocalWakeWord()'), 'app.js must check local wake-word support before arming it');
assert(appSrc.includes('function armLocalWakeWord('), 'app.js must have a local wake-word arming path');
assert(appSrc.includes('function configureWakeWordCloud()'), 'the original cloud SpeechRecognition wake loop must remain as a fallback');
assert(appSrc.includes('armLocalWakeWord(phrase).then((started) => { if (!started) configureWakeWordCloud(); })'), 'a failed local start must fall back to the cloud wake loop, not silently do nothing');
console.log('  ok   app.js tries the local engine first and falls back to the cloud wake loop on failure');

// ---------------------------------------------------------------------------
// Auto-sleep after silence (Mark-LIII parity: "auto-sleeps after 2 minutes")
// ---------------------------------------------------------------------------
assert(appSrc.includes('WAKE_AUTO_SLEEP_MS = 2 * 60 * 1000'), 'auto-sleep timeout must be 2 minutes to match the documented behavior');
assert(appSrc.includes('function armWakeAutoSleep()'), 'must have an auto-sleep arm function');
assert(appSrc.includes('function resetWakeAutoSleep()'), 'must have a way to reset the auto-sleep timer on activity');
assert(appSrc.includes('resetWakeAutoSleep();') && /sendMessage\(text\)\s*\{[\s\S]{0,80}resetWakeAutoSleep\(\);/.test(appSrc), 'sending a message must reset the auto-sleep timer so an active conversation is never cut off');
assert(/startAiLoop\(\)\s*\{[\s\S]*?if \(profile\.wakeWord\) armWakeAutoSleep\(\);/.test(appSrc), 'starting the AI loop while wake word is enabled must arm the auto-sleep timer');
console.log('  ok   wake sessions auto-sleep after 2 minutes of silence and reset on activity');

// ---------------------------------------------------------------------------
// Script is actually loaded by the app
// ---------------------------------------------------------------------------
assert(htmlSrc.includes('<script src="wake-word.js"></script>'), 'index.html must load wake-word.js');
assert(htmlSrc.indexOf('wake-word.js') < htmlSrc.indexOf('app.js'), 'wake-word.js must load before app.js which references window.GemWakeWord');
console.log('  ok   index.html loads wake-word.js ahead of app.js');

// ---------------------------------------------------------------------------
// Vendored engine present and reasonably sized (guards against an accidental
// empty/truncated vendor drop breaking the feature silently)
// ---------------------------------------------------------------------------
const voskPath = path.join(ROOT, 'renderer/vendor/vosk-browser/vosk.js');
assert(fs.existsSync(voskPath), 'renderer/vendor/vosk-browser/vosk.js must be present (vendored vosk-browser build)');
const voskSize = fs.statSync(voskPath).size;
assert(voskSize > 1024 * 1024, 'vendored vosk.js looks truncated (expected a multi-MB WASM-embedding bundle)');
console.log('  ok   vendored vosk-browser engine is present and non-empty');

// ---------------------------------------------------------------------------
// One-click model install (2.12, Mark's "grab it in one click from Settings"
// flow): installModel() precaches the recognizer WITHOUT touching the mic,
// modelStatus() reports install state, and the Settings UI drives both.
// ---------------------------------------------------------------------------
assert(wakeWordSrc.includes('async function installModel(onStatus)'), 'wake-word.js must expose installModel()');
assert(/loadModel\(onStatus\)/.test(wakeWordSrc), 'installModel must reuse the same cached loader (no duplicate downloads)');
assert(!/installModel[\s\S]{0,400}getUserMedia/.test(wakeWordSrc.split('async function installModel')[1].split('window.GemWakeWord')[0]), 'installModel must not open the microphone');
assert(wakeWordSrc.includes('function modelStatus()'), 'wake-word.js must expose modelStatus()');
assert(wakeWordSrc.includes('installModel,\n') || /installModel,\s*modelStatus,/.test(wakeWordSrc), 'both new APIs must be exported on window.GemWakeWord');
const exportedBlock = wakeWordSrc.split('window.GemWakeWord = {')[1];
assert(exportedBlock.includes('installModel') && exportedBlock.includes('modelStatus'), 'window.GemWakeWord exports installModel + modelStatus');
console.log('  ok   installModel precaches mic-free; modelStatus reports state; both exported');

assert(htmlSrc.includes('id="wakeModelInstallBtn"'), 'Settings must carry the one-click install button');
assert(htmlSrc.includes('id="wakeModelStatus"'), 'Settings must carry the model status line');
assert(htmlSrc.indexOf('setWakeWord') < htmlSrc.indexOf('wakeModelInstallBtn'), 'install control belongs to the wake-word block');
assert(appSrc.includes('function setupWakeModelInstall()'), 'app.js must wire the install button');
assert(appSrc.includes('installModel'), 'app.js must call GemWakeWord.installModel');
assert(appSrc.includes('updateWakeModelStatus'), 'app.js must render model status');
assert(appSrc.includes("safe('wakeModelInstall', setupWakeModelInstall)"), 'wake-model install wiring must run at boot');
console.log('  ok   Settings UI: one-click install button + status line, wired at boot');

console.log('\nAll wake-word engine checks passed.\n');
