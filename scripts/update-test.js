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
assert(main.includes('release.draft'), 'draft builds are not rejected');
assert(main.includes('release.prerelease'), 'prerelease builds are not accepted on the stable channel');
assert(main.includes('String(release.body || \'\').slice(0, 4000)'), 'release notes are not bounded');
assert(main.includes("ipcMain.handle('app:checkForUpdates'"), 'update IPC handler is missing');
assert(preload.includes("ipcRenderer.invoke('app:checkForUpdates', !!force)"), 'update IPC is not exposed through the preload bridge');
assert(main.includes("ipcMain.handle('app:installUpdate'"), 'installer update IPC handler is missing');
assert(preload.includes("ipcRenderer.invoke('app:installUpdate', releaseUrl)"), 'installer update IPC is not exposed');
assert(main.includes("ipcMain.handle('app:applyUpdate'"), 'one-click apply-update IPC handler is missing');
assert(preload.includes("ipcRenderer.invoke('app:applyUpdate')"), 'one-click apply-update IPC is not exposed');
assert(main.includes('verifiedWindowsAsset'), 'Windows installer URL is not verified');
assert(main.includes('UPDATE_CANCELLED'), 'update install cancellation is not handled');
assert(main.includes('predownloadUpdate'), 'background pre-download is missing');
assert(main.includes('pendingUpdate'), 'downloaded-update state is missing');
assert(main.includes('RELEASE_NIGHTLY_API_URL'), 'nightly release endpoint is missing');
assert(main.includes('getUpdateChannel'), 'update channel selection is missing');
assert(main.includes('NIGHTLY_NOT_PUBLISHED'), 'missing nightly pre-release is not reported');
assert(main.includes('writeNightlyState'), 'applied nightly builds are not recorded');
assert(html.includes('id="setUpdateChannel"'), 'update channel selector is missing');
assert(app.includes("profile.updateChannel = $('#setUpdateChannel')"), 'update channel is not persisted');
const nightly = fs.readFileSync(path.join(ROOT, '.github/workflows/nightly.yml'), 'utf8');
assert(nightly.includes('ncipollo/release-action@v1'), 'nightly workflow must use the maintained rolling-release action');
assert(nightly.includes('tag: nightly') && nightly.includes('replacesArtifacts: true'), 'nightly workflow does not publish a rolling pre-release');
assert(nightly.includes('branches:') && nightly.includes('- main'), 'nightly workflow does not build on pushes to main');
assert(nightly.includes('fail-fast: false'), 'one OS build failure should not cancel the other nightly builds');
const autoRelease = fs.readFileSync(path.join(ROOT, '.github/workflows/auto-release.yml'), 'utf8');
assert(autoRelease.includes('refs/tags/'), 'auto-release workflow never creates the version tag');
assert(autoRelease.includes('getLatestRelease'), 'auto-release workflow does not compare against the latest release');
assert(autoRelease.includes('package.json'), 'auto-release workflow is not driven by the package version');
assert(main.includes('startAutoUpdateWatcher'), 'background auto-update watcher is missing');
assert(main.includes('AUTO_UPDATE_POLL_MS'), 'auto-update poll interval is missing');
assert(main.includes("mainWindow.webContents.send('app:update-available'"), 'auto-update availability event is missing');
assert(preload.includes("subscribeIpc('app:update-available'"), 'auto-update event is not exposed through preload');
assert(app.includes('onUpdateAvailable'), 'renderer does not subscribe to auto-update events');
assert(html.includes('id="updatePill"'), 'update pill control is missing');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const published = JSON.stringify(((pkg.build || {}).publish) || []);
assert(published.includes('rangwalaaliasgar55-bot') && published.includes('GemAir'), 'electron-builder publish config must point at the GemAir GitHub repo');
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
assert(/no manual reinstall needed/i.test(html), 'one-click update promise is not disclosed');
assert(app.includes('RESTART TO UPDATE'), 'downloaded-update apply path is missing');
console.log('  ok   update settings are explicit, accessible, and transparent');

console.log('\n  All update-check regression tests passed.\n');
