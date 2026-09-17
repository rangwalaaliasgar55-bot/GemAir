/* Multi-mode search tests — mode routing shapes the request and the
   presentation contract, and price/compare modes are forbidden to invent
   numbers. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sm = require(path.join(ROOT, 'lib', 'search-modes.js'));
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

test('the five README modes exist, and that is all', () => {
  assert.deepEqual(sm.MODES, ['search', 'news', 'research', 'price', 'compare']);
  assert.equal(sm.normalizeMode('NEWS'), 'news');
  assert.equal(sm.normalizeMode('inspect'), null, 'unknown modes never silently become search');
});

test('news mode asks for recency; research keeps the plain query', () => {
  assert.match(sm.shape('news', 'ai regulation').query, /latest news/);
  assert.equal(sm.shape('research', 'crc collision').query, 'crc collision');
  assert.equal(sm.shape(null, 'plain').query, 'plain', 'empty mode behaves like search');
});

test('price mode forbids unstated prices; compare mode forbids guesses', () => {
  assert.match(sm.shape('price', 'iphone 17').hint, /ONLY prices that appear/i);
  assert.match(sm.shape('price', 'x').hint, /Never estimate/i);
  assert.match(sm.shape('compare', 'x vs y').hint, /not in sources/i);
});

test('queries are capped and identical shaping is deterministic', () => {
  const long = 'a'.repeat(500);
  assert.ok(sm.shape('news', long).query.length <= 240 + ' latest news'.length);
  assert.deepEqual(sm.shape('compare', 'a'), sm.shape('compare', 'a'));
});

/* ---- wiring ---- */
test('web_search accepts mode and surfaces its hint for the model', () => {
  assert.ok(mainSrc.includes("return await webSearch(args.query, args.mode);"));
  assert.ok(mainSrc.includes('modeHint: shaped.hint'), 'the model receives the presentation contract');
});

test('structured results are pushed to the content panel, prose-independent', () => {
  assert.ok(mainSrc.includes("'content:results'"));
  const i = mainSrc.indexOf("'content:results'");
  const body = mainSrc.slice(i, i + 260);
  assert.ok(body.includes('results') && body.includes('mode'));
});
