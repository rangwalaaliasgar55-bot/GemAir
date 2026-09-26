/* Dynamic Content Panel tests — main pushes structured results; the panel
   renders cards with open + navigate actions; the face reacts; phone says
   flow through the standard pipeline only. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

test('the panel DOM and CSS exist, hidden until results arrive', () => {
  assert.ok(htmlSrc.includes('id="contentPanel" hidden'), 'starts hidden');
  assert.ok(htmlSrc.includes('id="contentStrip"'));
  assert.ok(cssSrc.includes('.content-strip { display: flex'), 'scrollable strip');
  assert.ok(cssSrc.includes('overflow-x: auto'));
});

test('cards render title/snippet/host; empty result sets hide the panel', () => {
  const i = appSrc.indexOf('function setupContentPanel');
  const body = appSrc.slice(i, i + 2400);
  assert.ok(body.includes('cc-host') && body.includes('cc-title') && body.includes('cc-snippet'));
  assert.ok(body.includes('panel.hidden = true'), "no false content when a search returns nothing");
});

test('OPEN and BROWSER actions use immediate OS browser routes', () => {
  const i = appSrc.indexOf('function setupContentPanel');
  const body = appSrc.slice(i, i + 2400);
  assert.ok(body.includes('api.openExternal(r.url)'), 'open');
  assert.ok(body.includes('api.localsrvNav(r.url)'), 'default-browser IPC');
  assert.ok(body.includes('Opened in your default browser.'), 'reports the completed open rather than an extension queue');
  assert.ok(body.includes("gemAvatar.glance"), 'the 2.14 face acknowledges new content');
});

test('bridges exist end-to-end for results, phone says, blocked attempts, tabs', () => {
  for (const b of ['onContentResults', 'onDashboardSay', 'onBlockedAttempt', 'onExternalTab', 'localsrvInfo', 'localsrvNav', 'localsrvQr']) {
    assert.ok(preloadSrc.includes(b), 'preload: ' + b);
  }
});

test('phone-remote text goes through the normal send pipeline, visibly tagged', () => {
  const i = appSrc.indexOf('api.onDashboardSay');
  const body = appSrc.slice(i, i + 400);
  assert.ok(body.includes('sendMessage(t)'), 'same pipeline as a human typing');
  assert.ok(body.includes('PHONE'), 'visibly tagged as remote in UI');
  assert.match(body, /Could not deliver/, 'delivery failure is reported');
});

test('browser awareness is native and has no extension management controls', () => {
  assert.ok(appSrc.includes('function renderActiveBrowser(browser)'));
  assert.ok(appSrc.includes('window.air.onUpdate'), 'foreground changes update the browser line');
  assert.ok(htmlSrc.includes('ACTIVE BROWSER — AUTOMATIC'));
  assert.ok(!htmlSrc.includes('id="extPairCode"'), 'no pairing code UI');
  assert.ok(!htmlSrc.includes('id="siteBlocksEdit"'), 'no extension-only policy editor');
});
