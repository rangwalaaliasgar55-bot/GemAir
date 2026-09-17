'use strict';
/**
 * scripts/autostart-test.js — OS-native "launch at login" verification.
 *
 * Concept port (no upstream code) of Mark-LIV's auto-start: registry on
 * Windows, LaunchAgent-equivalent (Login Item) on macOS, .desktop on Linux —
 * modeled over Electron's login-item settings, with the state read back from
 * the OS rather than guessed, and the dev-mode caveat said out loud.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createAutoStart, PLATFORM_NOTES } = require('../lib/autostart.js');

const ok = (m) => console.log('  ok  ', m);

function fakeApp(enabled) {
  const state = { openAtLogin: !!enabled, calls: [] };
  return {
    isPackaged: true,
    getLoginItemSettings: () => ({ openAtLogin: state.openAtLogin, openedAsHidden: false }),
    setLoginItemSettings: (opts) => { state.calls.push(opts); state.openAtLogin = !!opts.openAtLogin; }
  };
}

function main() {
  // 1) supported platforms + honest notes
  {
    for (const p of ['win32', 'darwin', 'linux']) {
      const s = createAutoStart(fakeApp(true), { platform: p }).getState();
      assert.strictEqual(s.supported, true, p + ' supported');
      assert.strictEqual(s.enabled, true, p + ' reads back the OS state (not a profile guess)');
    }
    assert.ok(/Run/.test(PLATFORM_NOTES.win32) && /registry/i.test(PLATFORM_NOTES.win32), 'Windows note names the Run key');
    assert.ok(/Login Item/i.test(PLATFORM_NOTES.darwin), 'macOS note names Login Items');
    assert.ok(/autostart/.test(PLATFORM_NOTES.linux) && /\.desktop/.test(PLATFORM_NOTES.linux), 'Linux note names XDG autostart .desktop');
    assert.ok(/packaged|dev/i.test(PLATFORM_NOTES.linux), 'Linux note is honest about dev-mode limitations');
  }
  ok('per-OS notes are specific and honest');

  // 2) setEnabled forwards the right payload and the state reads back
  {
    const app = fakeApp(false);
    const as = createAutoStart(app, { platform: 'win32', name: 'GemAir' });
    assert.strictEqual(as.setEnabled(true).ok, true);
    assert.strictEqual(as.getState().enabled, true, 'set state is read back from the OS, not cached');
    assert.strictEqual(as.setEnabled(false).ok, true);
    assert.strictEqual(as.getState().enabled, false);
  }
  ok('setEnabled round-trips through the (mocked) OS');

  // 3) payload shape: openAtLogin flag, never openAsHidden, app named
  {
    const app = fakeApp(false);
    const seen = [];
    const capture = {
      isPackaged: true,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: (opts) => seen.push(opts)
    };
    const as = createAutoStart(capture, { platform: 'darwin', name: 'GemAir' });
    as.setEnabled(true);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].openAtLogin, true);
    assert.strictEqual(seen[0].openAsHidden, false, 'never starts hidden — GemAir announces itself');
    assert.strictEqual(seen[0].name, 'GemAir');
  }
  ok('registration payload: visible, named, honest');

  // 4) unsupported platform refused plainly; dev-mode note on linux unpackaged
  {
    const as = createAutoStart(fakeApp(false), { platform: 'freebsd' });
    assert.strictEqual(as.isSupported(), false);
    const r = as.setEnabled(true);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not available/i);
    const devLinux = { isPackaged: false, getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {} };
    const dev = createAutoStart(devLinux, { platform: 'linux' }).getState();
    assert.strictEqual(dev.devMode, true, 'dev-mode linux state carries the caveat');
  }
  ok('unsupported platforms refused; dev-mode caveat present');

  // 5) main + preload + settings wiring
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    for (const frag of [
      "require('./lib/autostart.js')", 'createAutoStart(app, { name: \'GemAir\' })',
      "ipcMain.handle('autostart:get'", "ipcMain.handle('autostart:set'",
      'p.autoStart = !!enabled', "console.log('[autostart]'"
    ]) assert.ok(mainSrc.includes(frag), 'main.js wire: ' + frag);
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    for (const frag of ['autostartGet', 'autostartSet']) assert.ok(preloadSrc.includes(frag), 'preload bridge: ' + frag);
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    for (const frag of ['refreshAutostartRow', 'api.autostartGet()', 'api.autostartSet(as_.checked)', 'autoStartHint']) {
      assert.ok(appSrc.includes(frag), 'app.js wire: ' + frag);
    }
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    for (const id of ['setAutoStart', 'autoStartHint']) assert.ok(html.includes(`id="${id}"`), 'index.html id: ' + id);
  }
  ok('OS-readback settings row wired end to end');

  console.log('\nAll autostart tests passed.');
}

main();
