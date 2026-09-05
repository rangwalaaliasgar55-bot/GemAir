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
console.log('ok - production accessibility, navigation, motion, and website surface contracts');
