#!/usr/bin/env node
'use strict';

// Dependency-free browser smoke test using the repository's Electron runtime.
// It intentionally skips ChatGPT/Gemini sign-in and external network auth.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const root = path.join(__dirname, '..');
const failures = [];
let win;

function assert(condition, message) { if (!condition) failures.push(message); }
function evaluate(script) { return win.webContents.executeJavaScript(script, true); }

async function main() {
  await app.whenReady();
  // Run the shared renderer in browser mode. Desktop IPC is covered by the
  // Electron-boundary tests; loading preload without main.js would create
  // misleading "no handler registered" noise.
  win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 900));
  await evaluate("document.querySelector('#bootOverlay')?.click(); document.querySelector('#bootOverlay')?.classList.add('done')");
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert(await evaluate("!!document.querySelector('#view-assistant.view.active')"), 'assistant view did not boot');
  assert(await evaluate("document.querySelector('#chatInput')?.tagName === 'TEXTAREA'"), 'composer is not multiline');
  assert(await evaluate("document.querySelectorAll('.nav-btn').length >= 5"), 'main navigation is incomplete');

  await evaluate("document.querySelector('.nav-btn[data-view=\\\"core\\\"]')?.click()");
  assert(await evaluate("document.querySelector('#view-core.view.active') !== null"), 'workspace navigation failed');
  await evaluate("document.querySelector('#settingsBtn')?.click()");
  assert(await evaluate("document.querySelector('#settingsModal.open') !== null"), 'settings dialog failed to open');
  await evaluate("document.querySelector('#settingsDownloadBtn')?.click()");
  assert(await evaluate("document.querySelector('#downloadModal.open') !== null"), 'download dialog failed to open');
  assert(await evaluate("document.querySelectorAll('#dlGrid .dl-card').length === 3"), 'download platform cards are incomplete');

  await win.loadFile(path.join(root, 'download.html'));
  assert(await evaluate("document.querySelector('#windows') && document.querySelector('#macos') && document.querySelector('#linux')"), 'public download page cards are missing');
  assert(await evaluate("document.querySelector('.nav a[href=\\\"/\\\"]') !== null"), 'public download page lacks web-app navigation');

  await win.close();
  await app.quit();
  if (failures.length) { console.error(failures.map((failure) => 'FAIL: ' + failure).join('\n')); process.exitCode = 1; }
  else console.log('ok - Electron smoke tested assistant, navigation, settings, download dialog, and public download page');
}

main().catch((error) => { console.error('Electron smoke test failed:', error.stack || error); process.exitCode = 1; try { app.quit(); } catch {} });
