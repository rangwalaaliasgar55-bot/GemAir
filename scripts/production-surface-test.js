#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('renderer/index.html');
const app = read('renderer/app.js');
const css = read('renderer/depth.css');
const website = read('download.html');

assert(/<textarea[^>]*id="chatInput"[^>]*aria-label="Message Gem"/.test(html), 'composer accessibility contract is missing');
assert(/id="settingsModal"[^>]*role="dialog"[^>]*aria-modal="true"/.test(html), 'settings dialog semantics are missing');
assert(/id="downloadModal"[^>]*role="dialog"[^>]*aria-modal="true"/.test(html), 'download dialog semantics are missing');
assert(app.includes("b.setAttribute('aria-current', active ? 'page' : 'false')"), 'navigation current-page state is missing');
assert(css.includes('prefers-reduced-motion'), 'reduced-motion support is missing');
assert(website.includes('id="windows"') && website.includes('id="macos"') && website.includes('id="linux"'), 'website platform cards are missing');
assert(website.includes('Open web app'), 'website web-app path is missing');
assert(website.includes('checksum ?'), 'website makes checksum claims conditionally');
assert(html.includes('id="topbarDownloadBtn"'), 'desktop download action must be visible in the app shell');
const vercel = JSON.parse(read('vercel.json'));
assert(vercel.rewrites.some((rule) => rule.source === '/download'), '/download rewrite is missing from production routing');
const devServer = read('scripts/dev-server.js');
assert(devServer.includes("rel === '/download'"), 'local dev server does not mirror the /download route');
const sfxDir = path.join(root, 'renderer/assets/sfx');
for (const file of ['click.wav', 'hover.wav', 'activate.wav', 'message.wav', 'swoosh.wav', 'alert.wav', 'mic.wav', 'success.wav']) {
  assert(fs.existsSync(path.join(sfxDir, file)), 'missing original sfx asset ' + file);
}
assert(app.includes('assets/sfx/'), 'original sfx pack is not wired into playback');
assert(html.includes('src="gemini-live.js"'), 'Gemini Live transport is not loaded');
assert(html.includes('id="setGeminiLiveModel"') && html.includes('id="setGeminiLiveKey"'), 'Gemini Live settings fields are missing');
assert(html.includes('id="testGeminiLiveBtn"'), 'Gemini Live self-test control is missing');
assert(html.includes('id="importCodexBtn"'), 'Codex import control is missing');
const live = read('renderer/gemini-live.js');
assert(live.includes('BidiGenerateContent'), 'Live transport does not use the documented streaming endpoint');
assert(live.includes('response_modalities'), 'Live transport does not negotiate a response modality');
assert(!/gemini-3\.[15]-flash-live-preview|gemini-3\.5-transcribe-live/.test(live + html + app), 'unverified live model IDs must never ship as fact');
console.log('ok - production accessibility, navigation, motion, and website surface contracts');
