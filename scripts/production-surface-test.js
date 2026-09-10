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

// Reference-parity surfaces: every control must exist AND be wired.
const apple = read('renderer/apple.js');
const appleCss = read('renderer/apple.css');
for (const id of ['satGlobeImg', 'satZoomWrap', 'satZoomIn', 'satZoomOut', 'satZoomReset', 'satMapToggle', 'satMode2d', 'satMode3d', 'satFullscreen', 'satUpdateCard', 'satUpdateReload', 'satUpdateDismiss', 'townStageImg', 'chatAttachBtn', 'chatAttachInput', 'chatNewMsgPill']) {
  assert(html.includes('id="' + id + '"'), 'reference surface missing from markup: ' + id);
  assert(apple.includes("'" + id + "'") || apple.includes('"' + id + '"'), 'reference control unwired in apple.js: ' + id);
}
// Bottom nav targets must resolve to real tabs/views (no dead buttons).
const satTabs = new Set([...html.matchAll(/class="sat-tab[^"]*" data-sat="([^"]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/data-goto-sat="([^"]+)"/g)) {
  assert(satTabs.has(m[1]), 'bottom nav points at a nonexistent sat tab: ' + m[1]);
}
const views = new Set([...html.matchAll(/class="nav-btn[^"]*" data-view="([^"]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/data-goto-view="([^"]+)"/g)) {
  assert(views.has(m[1]), 'bottom nav points at a nonexistent view: ' + m[1]);
}
// Reference art ships with the app and precaches offline.
for (const art of ['renderer/assets/globe.jpg', 'renderer/assets/agent-town.jpg']) {
  assert(fs.statSync(path.join(root, art)).size > 50000, 'reference art missing/too small: ' + art);
}
assert(read('renderer/sw.js').includes('assets/globe.jpg'), 'map art is not precached offline');
assert(appleCss.includes('#satGlobeImg') && appleCss.includes('.sat-bottomnav'), 'reference surfaces lack Apple styling');
console.log('ok - reference parity surfaces exist, wired, and precached');
console.log('ok - production accessibility, navigation, motion, and website surface contracts');
