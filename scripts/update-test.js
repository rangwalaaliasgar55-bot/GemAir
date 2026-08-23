#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

console.log('\nGemAir update-check regression tests\n');

const start = main.indexOf('function parseSemver');
const end = main.indexOf('async function checkForUpdates', start);
assert(start >= 0 && end > start, 'update validation helpers are missing');
const context = { URL, RELEASE_PATH_PREFIX: '/rangwalaaliasgar55-bot/GemAir/releases/' };
vm.runInNewContext(`${main.slice(start, end)}\nthis.api = { parseSemver, isVersionNewer, verifiedReleaseUrl };`, context);
const helpers = context.api;
assert.strictEqual(helpers.isVersionNewer('2.6.0', '2.5.9'), true);
assert.strictEqual(helpers.isVersionNewer('2.5.0', '2.5.0'), false);
assert.strictEqual(helpers.isVersionNewer('2.4.9', '2.5.0'), false);
assert.strictEqual(helpers.isVersionNewer('invalid', '2.5.0'), false);
assert(helpers.verifiedReleaseUrl('https://github.com/rangwalaaliasgar55-bot/GemAir/releases/tag/v2.6.0'));
assert.strictEqual(helpers.verifiedReleaseUrl('https://evil.example/releases/tag/v9.0.0'), null);
assert.strictEqual(helpers.verifiedReleaseUrl('http://github.com/rangwalaaliasgar55-bot/GemAir/releases/tag/v2.6.0'), null);
console.log('  ok   semantic versions and release URLs are validated');

assert(main.includes("const RELEASE_API_URL = 'https://api.github.com/repos/rangwalaaliasgar55-bot/GemAir/releases/latest'"), 'release endpoint is not fixed to the GemAir repository');
assert(main.includes("setTimeout(() => controller.abort(), 8000)"), 'update request timeout is missing');
assert(main.includes('release.draft || release.prerelease'), 'draft and prerelease builds are not rejected');
assert(main.includes('String(release.body || \'\').slice(0, 4000)'), 'release notes are not bounded');
assert(main.includes("ipcMain.handle('app:checkForUpdates'"), 'update IPC handler is missing');
assert(preload.includes("ipcRenderer.invoke('app:checkForUpdates', !!force)"), 'update IPC is not exposed through the preload bridge');
console.log('  ok   desktop checks are bounded, stable-only, and exposed through guarded IPC');

assert(app.includes("autoUpdateChecks: true"), 'daily update checks are not enabled by default');
assert(app.includes('24 * 60 * 60 * 1000'), 'renderer daily throttle is missing');
assert(app.includes("profile.autoUpdateChecks === false"), 'automatic checks do not respect user preference');
assert(app.includes('function trustedReleasePage(value)'), 'renderer does not revalidate release URLs');
assert(app.includes("api.openExternal(url)"), 'release opening is not a separate user action');
assert(!main.includes('autoUpdater'), 'metadata-only update checks should not install automatically');
console.log('  ok   automatic checks are daily and never install code');

for (const id of ['setAutoUpdateChecks', 'checkUpdatesBtn', 'viewUpdateBtn', 'updateStatus']) assert(html.includes(`id="${id}"`), `missing update control ${id}`);
assert(/id="updateStatus"[^>]*role="status"[^>]*aria-live="polite"/.test(html), 'update result is not announced accessibly');
assert(html.includes('It never downloads or installs an update without you.'), 'update privacy behavior is not disclosed');
console.log('  ok   update settings are explicit, accessible, and transparent');

console.log('\n  All update-check regression tests passed.\n');
