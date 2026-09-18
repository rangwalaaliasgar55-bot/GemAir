'use strict';
/**
 * scripts/clipboard-intel-test.js — clipboard intelligence verification.
 *
 * Concept port (no upstream code) of Mark-LIV's clipboard intelligence:
 * copy text → floating Translate/Summarise/Explain/Fix panel. Plus the
 * GemAir-parity guarantees: opt-in only, secrets redacted at rest, the ring
 * archives its evictions (nothing silently forgotten), and full end-to-end
 * wiring (IPC → preload → floating card → settings toggle).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ClipboardIntel, classify, looksSecret } = require('../lib/clipboard-intel.js');

const ok = (m) => console.log('  ok  ', m);

function makeIntel(opts) {
  const state = { clip: '' };
  const events = [];
  const archived = [];
  const intel = new ClipboardIntel(Object.assign({
    readText: () => state.clip,
    onEvent: (evt) => events.push(evt),
    archive: { append: (kind, items, meta) => archived.push({ kind, items, meta }) }
  }, opts || {}));
  return { state, events, archived, intel };
}

function main() {
  // 1) opt-in: nothing captured while disabled
  {
    const { state, intel } = makeIntel();
    state.clip = 'hello there';
    assert.strictEqual(intel.tick(), null, 'disabled watcher ignores the clipboard');
    intel.setEnabled(true);
    assert.strictEqual(intel.tick().preview, 'hello there');
    assert.strictEqual(intel.tick(), null, 'same text does not re-capture');
    state.clip = 'second copy';
    assert.strictEqual(intel.tick().preview, 'second copy');
    state.clip = 'ab'; // below the noise floor
    assert.strictEqual(intel.tick(), null, 'sub-3-char copies ignored');
    assert.strictEqual(intel.history().length, 2);
    assert.deepStrictEqual(intel.history().map((e) => e.preview), ['second copy', 'hello there'], 'newest first');
    intel.setEnabled(false);
    state.clip = 'while off';
    assert.strictEqual(intel.tick(), null, 'disabled again → silent');
  }
  ok('opt-in gate, change detection, noise floor, newest-first history');

  // 2) classification + secret quarantine: redacted at rest, panel skipped
  {
    const { state, events, intel } = makeIntel();
    intel.setEnabled(true);
    assert.strictEqual(classify('https://example.com/some/path'), 'url');
    state.clip = 'https://example.com/some/path';
    let entry = intel.tick();
    assert.strictEqual(entry.kind, 'url');
    state.clip = 'sk-ant-test-abcdef1234567890abcdef1234567890';
    assert.ok(looksSecret(state.clip), 'API-key shape detected');
    entry = intel.tick();
    assert.strictEqual(entry.kind, 'secret', 'key classified as secret');
    assert.ok(entry.text.indexOf('sk-ant') === -1, 'full key never stored');
    const secretEvents = events.filter((e) => e.type === 'secret');
    assert.strictEqual(secretEvents.length, 1, 'quarantine event fired exactly once');
    const panelEvents = events.filter((e) => e.type === 'new' && e.showPanel && e.entry.kind === 'secret');
    assert.strictEqual(panelEvents.length, 0, 'secrets never surface the floating panel');
    assert.strictEqual(intel.recall(entry.id).text, entry.text, 'recall returns the redacted copy, never the raw key');
  }
  ok('url/secret classification, redaction at rest, panel skipped for secrets');

  // 3) ring cap → eviction archived verbatim
  {
    const { state, archived, intel } = makeIntel({ maxEntries: 5 });
    intel.setEnabled(true);
    for (let i = 0; i < 8; i++) { state.clip = 'clip entry number ' + i; intel.tick(); }
    assert.strictEqual(intel.history().length, 5, 'ring holds at cap');
    assert.strictEqual(archived.length, 3, 'evicted entries archived, not dropped');
    assert.strictEqual(archived[0].kind, 'clipboardHistory');
    assert.match(archived[0].items[0].note, /evicted/, 'archive entry says why');
    assert.deepStrictEqual(intel.stats(), { enabled: true, entries: 5, evicted: 3, max: 5 }, 'stats report honestly');
    const recalled = intel.recall(intel.history()[0].id);
    assert.strictEqual(recalled.seen, undefined, 'recall payload is clean');
    assert.ok(intel.history().find((e) => e.id === recalled.id).seen, 'recall marks seen');
    assert.ok(intel.recall(99999).error, 'missing id reports instead of forging');
    intel.clear();
    assert.strictEqual(intel.history().length, 0);
  }
  ok('ring cap, archival on evict, recall/seen/stats/clear behavior');

  // 4) end-to-end wiring: IPC, preload, card, settings
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    for (const frag of [
      "ipcMain.handle('clipIntel:list'", "ipcMain.handle('clipIntel:recall'", "ipcMain.handle('clipIntel:clear'",
      "ipcMain.handle('clipIntel:stats'", 'new ClipboardIntel', 'readText: () => clipboard.readText()',
      "sendToRenderer('clipIntel:new'", "sendToRenderer('clipIntel:secret'",
      'syncClipboardIntel', 'applyAutomationSettings', 'p.clipboardIntel === true',
      'setInterval(() => { try { intel.tick(); } catch {} }, 1200)'
    ]) assert.ok(mainSrc.includes(frag), 'main.js wire: ' + frag);
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    for (const frag of ['clipIntelList', 'clipIntelRecall', 'onClipIntelNew', 'onClipIntelSecret', 'clipIntelClear', 'automationApply']) {
      assert.ok(preloadSrc.includes(frag), 'preload bridge: ' + frag);
    }
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    for (const id of ['clipIntelCard', 'clipIntelText', 'clipIntelActions', 'clipIntelClose', 'setClipboardIntel']) {
      assert.ok(html.includes(`id="${id}"`), 'index.html id: ' + id);
    }
    for (const act of ['translate', 'summarise', 'explain', 'fix']) {
      assert.ok(html.includes(`data-act="${act}"`), 'panel action: ' + act);
    }
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    for (const frag of [
      'setupClipboardIntel', "api.onClipIntelNew(", "api.onClipIntelSecret(", 'CLIP_INTEL_PROMPTS',
      'api.clipIntelRecall(', "profile.clipboardIntel = ci.checked", "safe('clipIntel'", 'stored redacted'
    ]) assert.ok(appSrc.includes(frag), 'app.js wire: ' + frag);
    const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'apple.css'), 'utf8');
    assert.ok(css.includes('.clip-intel-card'), 'card styled');
  }
  ok('IPC → preload → floating card → settings toggle wiring complete');

  console.log('\nAll clipboard-intelligence tests passed.');
}

main();
