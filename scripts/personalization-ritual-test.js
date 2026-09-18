#!/usr/bin/env node
'use strict';

// Personalization-ritual verification (Mark's "boot chime + power-on
// animation like a machine coming to life", "voice picker", "the interface
// breathes with you — waveform pulses to YOUR voice AND to the assistant's"):
// static end-to-end checks that the ritual exists and is wired.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nGemAir — personalization ritual tests\n');

const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const avatarSrc = fs.readFileSync(path.join(ROOT, 'renderer/avatar.js'), 'utf8');
const edgeSrc = fs.readFileSync(path.join(ROOT, 'renderer/edge-tts.js'), 'utf8');
const workflowSrc = fs.readFileSync(path.join(ROOT, 'scripts/workflow-test.js'), 'utf8');

// ---------------------------------------------------------------------------
// Boot ritual: overlay + BIOS trace + power-on sweep + an actual chime
// ---------------------------------------------------------------------------
assert(htmlSrc.includes('id="bootOverlay"'), 'boot overlay must exist');
assert(appSrc.includes('function runBootSequence()'), 'boot sequence function exists');
const bootBlock = appSrc.split('function runBootSequence()')[1].split('function ')[0];
assert(/playSfx\('activate'\)/.test(bootBlock), 'the boot sequence plays the power-on chime');
assert(bootBlock.includes('logo-phase') && bootBlock.includes('sweep-phase'), 'boot has the swell + power-on sweep animation phases');
assert(bootBlock.includes('addLifecycleListener(window, \'keydown\', skip, true)'), 'boot can be skipped by keyboard');
const rafStyle = htmlSrc.includes('bootBios') && htmlSrc.includes('bootBar') && htmlSrc.includes('bootLine');
assert(rafStyle, 'boot overlay owns BIOS text, progress bar and status line');
const sfxDir = path.join(ROOT, 'renderer/assets/sfx');
assert(fs.existsSync(path.join(sfxDir, 'activate.wav')), 'the chime asset (activate.wav) exists');
assert(fs.statSync(path.join(sfxDir, 'activate.wav')).size > 1000, 'chime asset is non-empty');
console.log('  ok   boot ritual: trace + swell + sweep + chime, skippable');

// ---------------------------------------------------------------------------
// Voice picker: multiple distinct voices, live settings wiring
// ---------------------------------------------------------------------------
const voiceCount = (edgeSrc.match(/name: 'en-[A-Z-]+[A-Za-z]*Neural'/g) || []).length;
assert(voiceCount >= 6, `voice picker must offer a real roster (found ${voiceCount})`);
assert(htmlSrc.includes('voicePresets') && (htmlSrc.match(/data-voice-preset=/g) || []).length >= 3, 'voice presets (Gem/Jarvis/Nova) exist');
assert(htmlSrc.includes('id="setVoice"') || htmlSrc.includes('id="setVoiceName"') || /setVoice/.test(htmlSrc), 'a voice picker control exists in Settings');
console.log(`  ok   voice picker: ${voiceCount} neural voices + style presets + settings control`);

// ---------------------------------------------------------------------------
// The interface breathes BOTH ways: waveform pulses to mic AND to Gem's voice
// ---------------------------------------------------------------------------
const ttsEngineSrc = fs.readFileSync(path.join(ROOT, 'renderer/tts-engine.js'), 'utf8');
assert(/setMicAnalyser\(/.test(appSrc), 'app feeds the mic analyser into the avatar (user-voice direction)');
assert(/setAudioAnalyser\(/.test(ttsEngineSrc), 'the TTS engine feeds the output analyser into the avatar (Gem-voice direction)');
assert(ttsEngineSrc.includes("setState({ speaking: true })"), 'output audio also drives the speaking state');
assert(avatarSrc.includes('setAudioAnalyser(node)') && avatarSrc.includes('setMicAnalyser(node)'), 'avatar exposes both direction hooks');
assert(avatarSrc.includes('audioVolume') && avatarSrc.includes('micVolume'), 'avatar tracks BOTH user-voice and Gem-voice levels');
const avatarDraw = avatarSrc.split('function ');
assert(avatarSrc.includes('micVolume'), 'render loop reads mic level every frame');
console.log('  ok   bidirectional reactivity: mic + output analysers both drive the avatar');

// Live voice meters also measure BOTH directions on the native-audio path.
const liveSrc = fs.readFileSync(path.join(ROOT, 'renderer/gemini-live.js'), 'utf8');
assert(liveSrc.includes("onLevel({ in: level, out: outLevel })"), 'live voice meters measure mic-in and Gem-out simultaneously');
assert(htmlSrc.includes('geminiLiveMeterIn') && htmlSrc.includes('geminiLiveMeterOut'), 'live meters render both directions in the UI');
console.log('  ok   live voice: dual VU meters (in + out) wired through the UI');

// Wake auto-sleep messaging mentions the phrase (small ritual kindness).
assert(appSrc.includes('Going quiet after 2 minutes of silence'), 'wake auto-sleep keeps the user informed');
console.log('  ok   sleep ritual: auto-sleep announces itself');

// Boot overlay renders over reduced-motion users too (accessibility ritual).
assert(appSrc.includes('REDUCED_MOTION'), 'motion-sensitive users get a reduced boot');
console.log('  ok   accessibility: reduced-motion respected in the ritual');

// Sanity that these wiring files are loaded by the shell page.
for (const script of ['avatar.js', 'edge-tts.js', 'tts-engine.js', 'gemini-live.js', 'wake-word.js']) {
  assert(htmlSrc.includes(`src="${script}"`), `index.html must load ${script}`);
}
console.log('  ok   shell page loads every ritual module');

console.log('\nAll personalization ritual tests passed.\n');
