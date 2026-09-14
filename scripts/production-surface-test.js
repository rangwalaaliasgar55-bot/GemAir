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
// Web policy: the site is download-only — it must point at the download page
// and GitHub, never pretend the app runs in a browser.
assert(!/open web app/i.test(website), 'website must not offer an in-browser app path');
assert(website.includes('/download'), 'website download path is missing');
assert(website.includes('github.com/rangwalaaliasgar55-bot/GemAir'), 'website GitHub link is missing');
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
const themes = read('renderer/themes.js');
assert(/const DEFAULT = 'cyan'/.test(themes), 'default theme must be cyan (reference look)');
assert(html.includes('href="reference.css"'), 'reference fidelity layer is not loaded');
assert(read('renderer/sw.js').includes('reference.css'), 'reference layer is not precached offline');
for (const id of ['mediaLinkPanel', 'mediaMicBtn', 'mediaShotBtn', 'mediaBrainState', 'mediaLinkState', 'feedbackBtn']) {
  assert(html.includes('id="' + id + '"'), 'media/feedback surface missing: ' + id);
}
for (const id of ['mediaMicBtn', 'mediaShotBtn', 'mediaBrainState', 'mediaLinkState', 'feedbackBtn']) {
  assert(apple.includes("'" + id + "'"), 'media/feedback control unwired: ' + id);
}
assert(html.includes('id="refreshNewsMini"'), 'headlines refresh control is missing');
assert(app.includes("$('#refreshNewsMini')"), 'headlines refresh is unwired');
assert(html.includes('id="townShareMini"'), 'town share control is missing');
assert(app.includes("$('#townShareMini')"), 'town share is unwired');
// Dead MCP URLs fail once with guidance, never raw transport text.
assert(app.includes('No MCP server is listening'), 'MCP discovery has no dead-server guidance');
assert(app.includes('turn off Local MCP'), 'MCP guidance must offer the off-ramp');
// Landing page: Apple-minimal pill nav + real-feature tabs, GemAir brand only.
assert(website.includes('id="pillnav"'), 'landing pill nav is missing');
assert(website.includes('id="featnav"'), 'landing feature tabs are missing');
for (const label of ["label:'Voice'", "label:'Memory'", "label:'Agents'", "label:'Focus'", "label:'World'", "label:'Accounts'"]) {
  assert(website.includes(label), 'landing feature missing: ' + label);
}
assert(!/boredom/i.test(website), 'landing page must not carry third-party branding');
// App sidebar uses the original thin-stroke icon set, not emoji glyphs.
for (const glyph of ['>◉<', '>⬢<', '>♥<', '>▦<', '>◍<']) {
  assert(!app.includes(glyph) && !html.includes(glyph), 'emoji nav glyph still present: ' + glyph);
}
assert(html.includes('class="nav-ico"><svg'), 'thin sidebar icons are missing');
console.log('ok - reference parity surfaces exist, wired, and precached');
console.log('ok - production accessibility, navigation, motion, and website surface contracts');
