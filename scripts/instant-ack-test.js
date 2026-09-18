'use strict';
/**
 * scripts/instant-ack-test.js — "it answers before it works".
 *
 * Concept port (no upstream code) of Mark-LIV's instant acknowledgment:
 * when a gap would form (a longer task starts), the shell says ONE short
 * sentence naming the start, in the user's language — while the model keeps
 * its own "never narrate tool use" contract.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createAckPicker, kindForTool, normalizeLanguage, LANGUAGES, KIND_BY_TOOL } = require('../renderer/instant-ack.js');

const ok = (m) => console.log('  ok  ', m);

function main() {
  // 1) every shipped language yields a non-empty, language-local line
  {
    const picker = createAckPicker();
    assert.ok(LANGUAGES.length >= 6, 'at least 6 languages shipped, got ' + LANGUAGES.length);
    for (const lang of LANGUAGES) {
      const ack = picker.pick({ language: lang, kind: 'task' });
      assert.ok(ack.line && ack.line.length > 2, lang + ' produces a line');
      assert.strictEqual(ack.language, lang, lang + ' round-trips');
    }
    const hi = picker.pick({ language: 'hi', kind: 'task' });
    assert.ok(/[\u0900-\u097F]/.test(hi.line), 'Hindi ack is actually Hindi script');
    const ru = picker.pick({ language: 'ru', kind: 'search' });
    assert.ok(/[а-я]/i.test(ru.line), 'Russian ack is actually Cyrillic');
  }
  ok('localized acks in every shipped language (incl. Hindi + Russian scripts)');

  // 2) language normalization: regions, uppercase, and unknowns fall back to English
  {
    assert.strictEqual(normalizeLanguage('tr-TR'), 'tr');
    assert.strictEqual(normalizeLanguage('EN'), 'en');
    assert.strictEqual(normalizeLanguage('xx-moon'), 'en');
    assert.strictEqual(normalizeLanguage(''), 'en');
    assert.strictEqual(normalizeLanguage('hinglish'), 'en', 'hinglish is not invented — callers map it explicitly');
  }
  ok('language normalization is conservative and honest');

  // 3) tool→kind routing covers the real gap-prone set
  {
    assert.strictEqual(kindForTool('run_desktop_task'), 'task');
    assert.strictEqual(kindForTool('web_search'), 'search');
    assert.strictEqual(kindForTool('organize_folder'), 'file');
    assert.strictEqual(kindForTool('rename_files'), 'file');
    assert.strictEqual(kindForTool('system_scan'), 'system');
    assert.strictEqual(kindForTool('run_coding_task'), 'code');
    assert.strictEqual(kindForTool('not_a_real_tool'), 'generic');
    for (const tool of Object.keys(KIND_BY_TOOL)) {
      assert.ok(['task', 'search', 'file', 'system', 'code'].includes(KIND_BY_TOOL[tool]), 'kind for ' + tool);
    }
  }
  ok('tool→kind map: desktop/search/file/system/code all route');

  // 4) rotation: consecutive picks for the same slot never repeat immediately
  {
    const picker = createAckPicker();
    const seq = [];
    for (let i = 0; i < 40; i++) seq.push(picker.pick({ language: 'en', kind: 'task' }).line);
    for (let i = 1; i < seq.length; i++) assert.notStrictEqual(seq[i], seq[i - 1], 'no immediate repetition at position ' + i);
  }
  ok('no immediate repetition in the ack rotation');

  // 5) unknown kinds degrade to generic without crashing
  {
    const picker = createAckPicker();
    for (const lang of LANGUAGES) {
      const ack = picker.pick({ language: lang, kind: 'mystery-kind' });
      assert.ok(ack.line.length > 2, lang + ' generic fallback');
    }
  }
  ok('unknown kinds fall back to generic per language');

  // 6) wiring: main emits tool:started for gap-prone tools after the gates;
  //    renderer speaks unless Gem is mid-sentence (then toasts)
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.ok(mainSrc.includes('const ACK_TOOLS = new Set(['), 'ACK_TOOLS declared');
    for (const tool of ['run_desktop_task', 'organize_folder', 'move_files', 'rename_files', 'system_scan', 'web_search']) {
      assert.ok(mainSrc.includes("'" + tool + "'"), 'ack tool listed: ' + tool);
    }
    assert.ok(mainSrc.includes("sendToRenderer('tool:started', { name, ts: Date.now() })"), 'shell emits tool:started');
    const emitIdx = mainSrc.indexOf("sendToRenderer('tool:started'");
    const switchIdx = mainSrc.indexOf('switch (name) {', mainSrc.indexOf('async function executeToolNow'));
    assert.ok(emitIdx !== -1 && emitIdx < switchIdx, 'ack fires after the confirmations, before dispatch');
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.ok(preloadSrc.includes('onToolStarted'), 'preload bridge onToolStarted');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    for (const frag of [
      'window.GemInstantAck.createAckPicker()', 'function setupInstantAck', 'api.onToolStarted(',
      'ackPicker.pick({ language, tool: info.name })', "contains('rgb-speaking')", 'speak(ack.line)',
      "safe('instantAck'", 'langMap'
    ]) assert.ok(appSrc.includes(frag), 'app.js instant-ack wire: ' + frag);
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    assert.ok(html.includes('src="instant-ack.js"'), 'instant-ack.js loaded in the shell');
  }
  ok('tool:started → picker → speak/toast wiring complete, mid-speech safe');

  console.log('\nAll instant-ack tests passed.');
}

main();
