#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('renderer/index.html');
const app = read('renderer/app.js');
const vercel = JSON.parse(read('vercel.json'));
const download = read('download.html');

assert(/<textarea[^>]*id="chatInput"/.test(html), 'composer must be multiline');
assert(app.includes("e.key === 'Enter' && !e.shiftKey && !e.isComposing"), 'Enter/Shift+Enter composer behavior is missing');
assert(app.includes("$('#sendBtn').addEventListener('click', submitComposer)"), 'Send and Enter must share composer submission behavior');
assert(app.includes("retry.setAttribute('aria-label', 'Retry the previous request')"), 'assistant retry action is missing');
assert(app.includes("copy.setAttribute('aria-label', 'Copy message')"), 'message copy action is missing');
assert(vercel.rewrites.some((rule) => rule.source === '/download' && rule.destination === '/download.html'), '/download route is missing');
assert(download.includes('SHA256SUMS') && download.includes('checksum ?'), 'download page must detect checksums instead of claiming them');
assert(download.includes("!/Android/i.test(ua)"), 'Android must not be recommended a Linux desktop package');
console.log('ok - conversation, download route, and truthful asset states');
