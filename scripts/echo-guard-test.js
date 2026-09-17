'use strict';
/**
 * scripts/echo-guard-test.js — "never answers its own last sentence".
 *
 * Concept port (no upstream code) of Mark-LIV's self-echo guard: the tail of
 * Gem's own voice ringing in the room is recognised and dropped WITHOUT
 * muting the mic — genuine continuations in your voice survive.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEchoGuard, normalize, RECENT_WINDOW_MS } = require('../renderer/echo-guard.js');

const ok = (m) => console.log('  ok  ', m);

function main() {
  // 1) normalization: case, punctuation and diacritics must not defeat the match
  {
    assert.strictEqual(normalize('  Hello,  WORLD!! '), 'hello world');
    assert.strictEqual(normalize('Naïve café — Москва'), 'naive cafe москва');
  }
  ok('normalization is case/punct/diacritic-insensitive');

  // 2) exact echo + substring echo dropped
  {
    const g = createEchoGuard();
    g.noteSpoken('Your files are ready in the Documents folder.', 1000);
    const exact = g.inspect('Your files are ready in the Documents folder.', 1400);
    assert.strictEqual(exact.dropped, true, 'exact echo dropped');
    const partial = g.inspect('files are ready in the documents', 1600);
    assert.strictEqual(partial.dropped, true, 'partial echo (mic clipped the edges) dropped');
  }
  ok('exact and partial echoes are dropped');

  // 3) echo prefix + your continuation → only the continuation survives
  {
    const g = createEchoGuard();
    g.noteSpoken('The meeting is at 3 pm tomorrow.', 2000);
    const heard = g.inspect('3 pm tomorrow what about friday instead', 2600);
    assert.strictEqual(heard.dropped, false, 'continuation is not dropped');
    assert.strictEqual(heard.remainder, 'what about friday instead', 'your words ride through');
    assert.strictEqual(heard.echoMatched, true, 'the echo part was recognised');
  }
  ok('echo prefix stripped, genuine continuation kept');

  // 4) unrelated speech lives; stale echoes expire
  {
    const g = createEchoGuard();
    g.noteSpoken('Searching the web for laptop prices.', 1000);
    const you = g.inspect('no actually compare the macbook air instead', 1500);
    assert.strictEqual(you.dropped, false, 'real user speech is untouched');
    assert.strictEqual(you.echoMatched, false);
    const stale = g.inspect('Searching the web for laptop prices.', 1000 + RECENT_WINDOW_MS + 500);
    assert.strictEqual(stale.dropped, false, 'after the window, matching text is coincidence — not echo');
  }
  ok('window expiry: old echoes never silence real repeats');

  // 5) tiny overlaps are coincidence, not echo; guard stays honest under churn
  {
    const g = createEchoGuard();
    g.noteSpoken('OK done.', 1000);
    const r = g.inspect('ok', 1200);
    assert.strictEqual(r.dropped, false, 'sub-4-char matches do not count as echo');
    for (let i = 0; i < 40; i++) g.noteSpoken('sentence ' + i + ' with some words', 2000 + i);
    assert.ok(g.size() <= 12, 'spoken ring is bounded');
    g.clear();
    assert.strictEqual(g.inspect('sentence 39 with some words', 3000).dropped, false, 'clear() wipes memory');
  }
  ok('coincidence threshold, bounded ring, clear');

  // 6) wiring: speak() feeds the guard; STT final+interim pass through it
  {
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    for (const frag of [
      'window.GemEchoGuard.createEchoGuard()', 'echoGuard.noteSpoken(clean)',
      'echoGuard.inspect(interim)', 'echoGuard.inspect(finalText.trim())',
      'g.remainder'
    ]) assert.ok(appSrc.includes(frag), 'app.js echo-guard wire: ' + frag);
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    assert.ok(html.includes('src="echo-guard.js"'), 'echo-guard.js loaded in the shell');
  }
  ok('speak → noteSpoken, STT → inspect fully wired');

  console.log('\nAll echo-guard tests passed.');
}

main();
