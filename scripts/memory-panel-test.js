/* Memory transparency tests — see every fact with when it was learned,
   delete any of it, or all of it. The delete-all path is irreversible and
   the UI must say so BEFORE the click. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

test('fact rows show when Gem learned the fact', () => {
  const i = appSrc.indexOf('function renderFacts');
  const body = appSrc.slice(i, i + 2400);
  assert.ok(body.includes('new Date(f.created).toLocaleDateString()'), 'date visible');
  assert.ok(body.includes("title=\"Learned "), 'full timestamp on hover');
  assert.ok(body.includes("updated "), 'updates shown when distinct');
});

test('a forget-everything control exists and is marked as irreversible on its face', () => {
  assert.ok(htmlSrc.includes('id="forgetAllFacts"'));
  const i = htmlSrc.indexOf('id="forgetAllFacts"');
  assert.match(htmlSrc.slice(i, i + 140), /irreversible/i, 'the button title itself warns');
});

test('the confirmation dialog says what this is before the click lands', () => {
  const i = appSrc.indexOf("const fab = $('#forgetAllFacts')");
  const body = appSrc.slice(i, i + 1200);
  assert.ok(body.includes('window.confirm'), 'human gate');
  assert.match(body, /irreversible/i);
  assert.match(body, /NOT on the undo stack/i, 'honest about recoverability');
  assert.match(body, /nothing to forget/i, 'empty state handled honestly');
});

test('main actually wipes and reports a truthful count', () => {
  const i = mainSrc.indexOf("ipcMain.handle('memory:clearFacts'");
  const body = mainSrc.slice(i, i + 500);
  assert.ok(body.includes('m.facts = []'));
  assert.ok(body.includes('logAction'), 'the wipe is journaled');
  assert.match(body, /forgotten/, 'count reported back');
  assert.ok(preloadSrc.includes('memoryClearFacts'), 'preload bridge');
});

test('the model has no bulk-delete tool — only the panel can do this', () => {
  const toolDefs = mainSrc.match(/name: '[a-z_]+', description:/g) || [];
  const bad = toolDefs.filter(s => /delete|forget|clear|wipe/i.test(s) && /memory|fact/i.test(s));
  assert.equal(bad.length, 0, 'no memory-bulk-delete tool may be exposed to the model');
});
