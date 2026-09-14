#!/usr/bin/env node
'use strict';

/* Web-is-desktop-only policy tests.

   GemAir is a desktop app. The website must be a showcase/download page — the
   real UI (renderer/) must never be usable in a browser. These tests pin the
   whole contract:

     1. vercel.json routes / and /download to the landing page and shunts
        /app, /renderer/* and /index.html to the desktop-only notice — no
        route may serve the renderer directly.
     2. renderer/index.html loads web-gate.js FIRST: even if someone finds the
        app files, the gate covers the screen with a download card.
     3. renderer/app.js refuses to boot when the gate has fired.
     4. The landing page (download.html) links to the download/release surface
        and to GitHub, not to an "open in browser" illusion.
     5. desktop-only.html exists for non-root paths and bounces to /.
     6. Silent-update wiring and the extension pairing surface exist so the
        desktop build can keep itself current. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const vercel = JSON.parse(read('vercel.json'));
const indexHtml = read('renderer/index.html');
const app = read('renderer/app.js');
const gate = read('renderer/web-gate.js');
const landing = read('download.html');
const desktopOnly = read('desktop-only.html');
const main = read('main.js');
const preload = read('preload.js');

console.log('\nGemAir web-is-desktop-only policy tests\n');

/* 1 — routing: the web serves the landing page, never the app. */
const routes = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
function serves(route, file) {
  return route && typeof route.destination === 'string' && route.destination.includes(file);
}
const rootRoute = routes.find((r) => r.source === '/');
assert(rootRoute, 'no route for / — the root must go to the landing page');
assert(serves(rootRoute, 'download.html'), '/ must serve download.html');
const downloadRoute = routes.find((r) => r.source === '/download');
assert(downloadRoute && serves(downloadRoute, 'download.html'), '/download must serve download.html');
const appRoute = routes.find((r) => r.source === '/app');
assert(appRoute && serves(appRoute, 'desktop-only.html'), '/app must serve the desktop-only notice');
const rendererRoute = routes.find((r) => /renderer/.test(r.source));
assert(rendererRoute && serves(rendererRoute, 'desktop-only.html'), '/renderer/* must serve the desktop-only notice');
const indexRoute = routes.find((r) => r.source === '/index.html');
assert(indexRoute && serves(indexRoute, 'desktop-only.html'), '/index.html must serve the desktop-only notice');
for (const r of routes) {
  assert(!serves(r, 'renderer/index.html'), `route ${r.source} must not serve the app shell directly`);
}
assert(JSON.stringify(vercel).includes('X-Frame-Options'), 'security headers are missing from vercel.json');
console.log('  ok   vercel.json: / and /download -> landing, app paths -> desktop-only notice');

/* 2 — the gate loads before anything else in the app shell. */
const gateTag = indexHtml.indexOf('<script src="web-gate.js"></script>');
assert(gateTag >= 0, 'renderer/index.html does not load web-gate.js');
assert(indexHtml.indexOf('<script src="themes.js"></script>') > gateTag, 'web-gate.js must load before themes.js');
assert(indexHtml.indexOf('<script src="app.js"></script>') > gateTag, 'web-gate.js must load before app.js');
console.log('  ok   renderer/index.html loads web-gate.js first');

/* 3 — the gate blocks browsers and the app refuses to run behind it. */
assert(gate.includes('__GEMAIR_WEB_BLOCKED'), 'web-gate.js does not set the blocked flag');
assert(gate.includes('window.gemair'), 'web-gate.js must only act when the desktop bridge is absent');
assert(/(display\s*:\s*none|visibility\s*:\s*hidden)/.test(gate), 'web-gate.js must hide the app UI');
assert(gate.toLowerCase().includes('download'), 'web-gate.js must offer a download affordance');
assert(app.includes('__GEMAIR_WEB_BLOCKED'), 'renderer/app.js does not check the blocked flag');
assert(app.indexOf('__GEMAIR_WEB_BLOCKED') < app.indexOf('function boot') || app.indexOf('__GEMAIR_WEB_BLOCKED') < 2000, 'app.js must throw on the blocked flag before booting');
console.log('  ok   web gate flags browsers and app.js aborts behind it');

/* 4 — the landing page sells the download, not an in-browser app. */
assert(!/open web app/i.test(landing), 'landing must not offer an "open web app" link');
assert(landing.includes('github.com/rangwalaaliasgar55-bot/GemAir'), 'landing must link the GitHub repository');
assert(/download/i.test(landing), 'landing must present a download call to action');
console.log('  ok   download.html is a download-first landing page');

/* 5 — the desktop-only notice exists and bounces to the landing page. */
assert(desktopOnly.length > 500, 'desktop-only.html is missing or empty');
assert(/location\.replace\(['"]\/['"]\)|location\.href\s*=\s*['"]\/['"]/.test(desktopOnly), 'desktop-only.html must redirect non-root paths to /');
assert(!desktopOnly.includes('renderer/'), 'desktop-only.html must not reference renderer files');
console.log('  ok   desktop-only.html redirects to / and is self-contained');

/* 6 — the desktop build that the web funnels users to can update itself. */
assert(main.includes('silentUpdatesEnabled'), 'silent update preference is missing in main.js');
assert(main.includes('scheduleSilentInstallOnQuit'), 'install-on-quit fallback is missing in main.js');
assert(main.includes("ipcMain.handle('app:updaterStatus'"), 'updater status IPC is missing');
assert(preload.includes('updaterStatus'), 'preload does not expose updaterStatus');
assert(app.includes('setSilentUpdates'), 'settings UI for silent updates is missing');
assert(indexHtml.includes('id="setSilentUpdates"'), 'silent-updates toggle is missing from the settings DOM');
console.log('  ok   silent self-update wiring is complete (IPC, preload, settings UI)');

/* 7 — extension pairing surface: how the island learns the exact website. */
assert(main.includes("ipcMain.handle('app:openExtensionFolder'"), 'openExtensionFolder IPC is missing');
assert(main.includes("ipcMain.handle('connections:borrowGeminiKey'"), 'Gemini key borrow IPC is missing');
assert(read('renderer/air/attention-ui.js').includes('Open extension folder'), 'pairing UI does not offer the extension folder');
const bg = read('extension/chrome/background.js');
assert(bg.includes('reportActiveFromQuery'), 'extension heartbeat is missing from the service worker');
assert(bg.indexOf('reportActiveFromQuery();') > bg.lastIndexOf('function reportActiveFromQuery'), 'service worker must re-report the tab on cold start');
console.log('  ok   extension pairing + tab heartbeat are wired');

console.log('\nAll web-is-desktop-only policy tests passed.\n');
