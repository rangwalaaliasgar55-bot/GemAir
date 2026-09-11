#!/usr/bin/env node
'use strict';

// Capture real screenshots of the renderer for visual review.
// Usage: npx electron scripts/capture-ui.js [outdir]
// Loads index.html like the smoke test (no main-process IPC), dismisses
// onboarding/boot, waits for first render, then saves PNGs.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outdir = process.argv[2] || path.join(root, 'release', 'shots');

async function shot(win, name) {
  await win.capturePage(); // discard: hidden windows serve a stale first frame
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.capturePage();
  const file = path.join(outdir, name);
  fs.writeFileSync(file, image.toPNG());
  console.log('saved', file, image.getSize());
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(outdir, { recursive: true });
  // In-memory session: no stored profile leaks in, so screenshots show the
  // true first-run default theme instead of a stale test profile.
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { partition: 'capture-mem', contextIsolation: true, sandbox: true }
  });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 9000));
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  // Remove overlays outright (fresh session always shows first-run).
  await evalJs("document.querySelector('#onboardOverlay')?.remove(); document.querySelector('#bootOverlay')?.remove()");
  // Friday-evening weekly-report dock would cover the chat; close it.
  await evalJs("document.querySelector('#hudDockClose')?.click(); document.querySelector('#hudDock')?.classList.remove('open')");
  console.log('overlays-gone:', await evalJs("!document.querySelector('#onboardOverlay') && !document.querySelector('#bootOverlay')"));
  await new Promise((r) => setTimeout(r, 1500));
  console.log('still-gone:', await evalJs("!document.querySelector('#onboardOverlay') && !document.querySelector('#bootOverlay')"));
  await new Promise((r) => setTimeout(r, 1500));
  await shot(win, 'assistant.png');
  // settings open state
  await evalJs("document.querySelector('#settingsBtn')?.click()");
  await new Promise((r) => setTimeout(r, 800));
  await shot(win, 'settings.png');
  await win.close();
  await app.quit();
  console.log('done');
}

main().catch((e) => { console.error('capture failed:', e && e.stack || e); process.exitCode = 1; try { app.quit(); } catch {} });
