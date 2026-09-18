/* Wi-Fi / Brightness / Media control tests — every platform path either
   runs for real or admits its limit; wifi toggles are human-gated. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const wifi = require(path.join(ROOT, 'lib', 'wifi-tools.js'));
const bright = require(path.join(ROOT, 'lib', 'brightness-tools.js'));
const media = require(path.join(ROOT, 'lib', 'media-tools.js'));
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/* ---- Wi-Fi ---- */
test('wifi actions validate strictly; unknown actions produce no command', () => {
  assert.equal(wifi.normalizeAction('ON'), 'on');
  assert.equal(wifi.normalizeAction('status'), 'status');
  assert.equal(wifi.normalizeAction('reconnect'), null);
  assert.equal(wifi.commandFor('reconnect', 'linux'), null);
});

test('status is free; toggles always require the human', () => {
  assert.equal(wifi.needsConfirmation('status'), false);
  assert.equal(wifi.needsConfirmation('on'), true);
  assert.equal(wifi.needsConfirmation('off'), true);
});

test('wifi toggle text warns about cutting the assistant itself off', () => {
  const off = wifi.confirmTextFor('off');
  assert.match(off.detail, /DISCONNECT/i);
  assert.match(off.detail, /GemAir/i, 'self-impact is stated');
  const on = wifi.confirmTextFor('on');
  assert.match(on.detail, /Only continue if you asked/i);
});

test('wifi parsers read real outputs per OS, and refuse garbage', () => {
  assert.equal(wifi.parseStatus('enabled', 'linux').state, 'enabled');
  assert.match(wifi.parseStatus('   Name : Wi-Fi\n   SSID : HomeNet\n   State : connected', 'win32').summary, /HomeNet/);
  assert.match(wifi.parseStatus('no wireless interfaces found on the system', 'win32').summary, /no wireless/i);
  assert.equal(wifi.parseStatus('Wi-Fi Power (en0): On', 'darwin').state, 'on');
});

/* ---- Brightness ---- */
test('brightness levels clamp 1–100 and junk is rejected', () => {
  assert.equal(bright.clampLevel(50), 50);
  assert.equal(bright.clampLevel(500), 100);
  assert.equal(bright.clampLevel('x'), null);
  assert.equal(bright.clampLevel(-4), 1);
});

test('macOS is honestly unsupported; linux software fallback is labelled', () => {
  assert.equal(bright.sets(40, 'darwin'), null);
  assert.equal(bright.reads('darwin'), null);
  assert.match(bright.unsupportedText('darwin'), /refuses to fake/i);
  const linux = bright.sets(40, 'linux');
  assert.match(linux.method, /xrandr — the panel itself is unchanged/, 'software gamma is disclaimed in-method');
  assert.match(linux.cmd, /xrandr.*--brightness 0.40/s);
});

test('brightness parsers handle wmi / brightnessctl / xrandr output', () => {
  assert.equal(bright.parseLevel('75', 'win32'), 75);
  assert.equal(bright.parseLevel('amdgpu_bl0,backlight,965,42%,2550', 'linux'), 42);
  assert.equal(bright.parseLevel('Brightness: 0.35', 'linux'), 35);
  assert.equal(bright.parseLevel('garbage', 'linux'), null);
});

/* ---- Media ---- */
test('media aliases normalize; windows sends real media key virtual codes', () => {
  assert.equal(media.normalizeAction('play'), 'playpause');
  assert.equal(media.normalizeAction('skip'), 'next');
  assert.match(media.commandFor('playpause', 'win32'), /0xB3/);
  assert.match(media.commandFor('next', 'win32'), /0xB0/);
  assert.match(media.commandFor('previous', 'win32'), /0xB1/);
});

test('media failures convert to honest per-OS sentences', () => {
  assert.match(media.failureText('linux', 'playerctl: command not found'), /install.*playerctl/si);
  assert.match(media.failureText('darwin', ''), /Spotify or Music/i);
});

/* ---- wiring: everything routed through real handlers/tiers ---- */
test('all three tools exist in the switch and the wifi toggle is dialog-gated', () => {
  assert.ok(mainSrc.includes("case 'control_wifi':"), 'handler');
  assert.ok(mainSrc.includes("case 'control_brightness':"));
  assert.ok(mainSrc.includes("case 'media_control':"));
  const i = mainSrc.indexOf('async function controlWifiTool');
  const body = mainSrc.slice(i, i + 1800);
  assert.ok(body.includes('await confirmAction'), 'toggle waits on the human');
  assert.ok(!/profile\./.test(body), 'no auto-approve flag in the wifi path either');
  const d = mainSrc.indexOf("name: 'control_wifi'");
  assert.match(mainSrc.slice(d, d + 380), /human/i);
});
