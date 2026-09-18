/* prepare_message tests — composition, never sending. The tool result and
   description must be incapable of claiming a sent message. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ml = require(path.join(ROOT, 'lib', 'message-links.js'));
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

test('whatsapp links need a sane international number or go numberless', () => {
  assert.equal(ml.cleanPhone('+91 98765 43210'), '919876543210');
  assert.equal(ml.cleanPhone('abc-def'), null);
  const ok = ml.build('whatsapp', '+91 98765 43210', 'hi there');
  assert.ok(ok.ok && ok.url.startsWith('https://wa.me/919876543210'));
  const noTarget = ml.build('whatsapp', '', 'hi');
  assert.ok(noTarget.ok, 'contact picker fallback when no number given');
  const bad = ml.build('whatsapp', 'grandma', 'hi');
  assert.equal(bad.ok, false, 'letters in target = honest error, not a broken link');
});

test('telegram handles username / share-sheet / honesty about prefill', () => {
  const user = ml.build('telegram', '@friend_test', 'hello');
  assert.ok(user.url.startsWith('https://t.me/friend_test'));
  assert.match(user.note, /prefill depends/i, 'prefill uncertainty is disclosed');
  const share = ml.build('telegram', '', 'hello');
  assert.ok(share.url.startsWith('https://t.me/share/url'));
});

test('text is clipped, empty text errors, unknown channels say which ones work', () => {
  assert.equal(ml.build('whatsapp', '', '   ').ok, false);
  assert.equal(ml.build('whatsapp', '', 'x'.repeat(5000)).text === undefined, true);
  const long = ml.build('whatsapp', '', 'x'.repeat(5000));
  assert.ok(decodeURIComponent(long.url).length < 900, 'clipped to 800');
  const bad = ml.build('signal', '', 'hi');
  assert.match(bad.error, /others honestly unsupported/);
});

/* ---- wiring ---- */
test('the tool opens the link and the result wrapper says sent:false always', () => {
  const i = mainSrc.indexOf('async function prepareMessageTool');
  const body = mainSrc.slice(i, i + 600);
  assert.ok(body.includes('shell.openExternal'), 'opens, does not send');
  assert.ok(body.includes('sent: false'), 'machine-truthful result');
  assert.ok(!body.includes("action: 'send'") && !body.includes('app.push'), 'no send path exists');
  const d = mainSrc.indexOf("name: 'prepare_message'");
  assert.match(mainSrc.slice(d, d + 420), /USER presses send/i);
  assert.match(mainSrc.slice(d, d + 420), /not possible by design/i);
});
