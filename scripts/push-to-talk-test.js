'use strict';
/**
 * scripts/push-to-talk-test.js — Ctrl+Space hold-to-talk verification.
 *
 * Concept port (no upstream code) of Mark-LIV's push-to-talk, with its own
 * honesty rule kept: Mark is truly global only on Windows (virtual-key
 * polling) and window-scoped elsewhere — Electron has no dependency-free
 * global key-read, so GemAir binds window-scoped on EVERY platform and says
 * so in the settings hint instead of pretending global reach.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ok = (m) => console.log('  ok  ', m);

function main() {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // 1) settings row exists with the honest window-scoped hint
  assert.ok(html.includes('id="setPushToTalk"'), 'toggle present');
  assert.ok(html.includes('id="pushToTalkHint"'), 'hint present');
  assert.ok(/window/i.test(html) && /no dependency-free global hotkey/.test(html),
    'hint says window-scoped plainly, like Mark says about macOS/Linux');
  ok('settings row + honest hint');

  // 2) the setup function: gated on the profile flag, chord = Ctrl/Meta+Space,
  //    ignores repeat, stays out of text fields (except chat input)
  const fnStart = appSrc.indexOf('function setupPushToTalk()');
  assert.ok(fnStart !== -1, 'setupPushToTalk exists');
  const body = appSrc.slice(fnStart, fnStart + 2600);
  assert.ok(body.includes('!profile.pushToTalk'), 'gated on the profile toggle');
  assert.ok(body.includes("e.code === 'Space'") && body.includes('e.ctrlKey || e.metaKey'), 'chord is Ctrl/Cmd+Space by key code (layout-proof)');
  assert.ok(body.includes('e.repeat'), 'auto-repeat ignored (no retrigger while held)');
  assert.ok(body.includes('e.preventDefault()'), 'browser quick-find suppressed');
  assert.ok(body.includes("/^(INPUT|TEXTAREA|SELECT)$/"), 'typing in fields is not hijacked');
  assert.ok(body.includes("e.target.id !== 'chatInput'"), 'chat input exception — you can hold it while focused there');
  ok('key handler: gating, chord shape, repeat, field safety');

  // 3) press opens the mic exactly like the mic button; release ends dictation
  assert.ok(body.includes('listening = true'), 'press opens listening');
  assert.ok(body.includes('startMicMeter()'), 'mic meter starts');
  assert.ok(body.includes('recognition.start()'), 'dictation starts');
  assert.ok(body.includes('recognition.stop()'), 'release ends dictation (final result still sends)');
  assert.ok(body.includes('pttHeld = true') && body.includes('pttHeld = false'), 'hold-state tracked');
  ok('press/release drives the same mic lifecycle as the button');

  // 4) never leaks an open mic: blur + tab-hidden force a release
  {
    assert.ok(appSrc.includes("window.addEventListener('blur', release)"), 'window blur releases');
    assert.ok(appSrc.includes("if (document.hidden) release()"), 'hidden tab releases');
    assert.ok(appSrc.includes("safe('pushToTalk', setupPushToTalk)"), 'registered in the boot sequence');
  }
  ok('mic never stays open in the background');

  // 5) wake-word stops so PTT owns the dictation while held
  assert.ok(body.includes('GemWakeWord') && body.includes('.stop'), 'wake loop is halted during the hold (no double-mic)');
  ok('cooperates with the wake loop');

  // 6) settings persistence: load + save rows
  assert.ok(/setPushToTalk'\); if \(ptt\) ptt\.checked/.test(appSrc), 'toggle loaded from profile');
  assert.ok(appSrc.includes('profile.pushToTalk = ptt.checked'), 'toggle saved to profile');
  assert.ok(appSrc.includes('pushToTalk: false'), 'conservative default');
  ok('load/save/default rows');

  // 7) honesty: no globalShortcut is claimed or used for PTT anywhere
  assert.ok(!mainSrc.includes('globalShortcut'), 'no fake global hotkey in main (consistent with the hint)');
  ok('no pretend-global registration');

  console.log('\nAll push-to-talk tests passed.');
}

main();
