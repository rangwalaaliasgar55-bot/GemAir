/* Power-tier confirmation tests — the model cannot confirm its own
   irreversible actions. Pure lib tests plus static wiring checks that no
   code path can reach a power command without a human dialog. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const power = require(path.join(ROOT, 'lib', 'power-actions.js'));
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

test('shutdown and restart are power tier; lock and sleep are convenience', () => {
  assert.equal(power.tierFor('shutdown'), 'power');
  assert.equal(power.tierFor('restart'), 'power');
  assert.equal(power.tierFor('lock'), 'convenience');
  assert.equal(power.tierFor('sleep'), 'convenience');
  assert.equal(power.tierFor('nonsense'), 'unknown');
});

test('aliases normalize, unknown never maps to a power command', () => {
  assert.equal(power.normalizeAction('Reboot'), 'restart');
  assert.equal(power.normalizeAction('poweroff'), 'shutdown');
  assert.equal(power.commandFor('wipe-disk', 'linux'), null);
});

test('every OS has a power command path', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    assert.ok(power.commandFor('shutdown', p), p);
    assert.ok(power.commandFor('restart', p), p);
  }
});

test('confirm text states the consequence and that no setting can approve it', () => {
  for (const a of ['shutdown', 'restart']) {
    const t = power.confirmTextFor(a);
    assert.match(t.detail, /10 seconds/i);
    assert.match(t.detail, /cannot be undone/i);
    assert.match(t.detail, /only this button/i, 'the dialog itself teaches the rule');
  }
});

test('result text never claims an action that was not approved', () => {
  assert.match(power.resultTextFor('shutdown', true), /shutting down/i);
  assert.match(power.resultTextFor('shutdown', false), /cancelled/i);
  assert.match(power.resultTextFor('restart', false), /stays on/i);
  assert.doesNotMatch(power.resultTextFor('restart', false), /^Approved/);
});

/* ---- static wiring: no bypass exists ---- */

const ctlStart = mainSrc.indexOf('async function controlSystem');
const ctlEnd = mainSrc.indexOf('\n}', ctlStart);
const ctlBody = mainSrc.slice(ctlStart, ctlEnd);

test('power tier waits for confirmAction — unconditional on settings', () => {
  assert.ok(ctlBody.includes("await confirmAction"));
  assert.ok(!/profile\./.test(ctlBody), 'no auto-approve flag may appear in the power path');
  assert.ok(!/computerUseAuto|codingAgentAuto|autoApprove/.test(ctlBody));
});

test('both the model tool path and the typed shortcut path route through the gate', () => {
  assert.ok(mainSrc.includes('return await controlSystem(args.action)'), 'tool handler');
  assert.ok(mainSrc.includes("const r = await controlSystem('shutdown')"), 'shortcut must await the verdict, not fire blindly');
});

test('the tool description itself tells the model it cannot self-confirm', () => {
  const i = mainSrc.indexOf("name: 'control_system'");
  const desc = mainSrc.slice(i, i + 420);
  assert.match(desc, /cannot be self-confirmed/i);
  assert.match(desc, /human/i);
});

test('declined power calls are logged, not silent', () => {
  assert.ok(ctlBody.includes("' declined by user'"));
});
