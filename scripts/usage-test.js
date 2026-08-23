#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

console.log('\nGemAir local-usage regression tests\n');

const start = main.indexOf('function freshUsageStats');
const end = main.indexOf('// Emotion + language + support', start);
assert(start >= 0 && end > start, 'usage aggregation source window is missing');
let enabled = false;
let stored = null;
const context = {
  readProfile: () => ({ usageStats: enabled }),
  readJSON: (_file, fallback) => stored || fallback,
  writeJSON: (_file, value) => { stored = JSON.parse(JSON.stringify(value)); return true; },
  USAGE_STATS_FILE: '/tmp/not-written-by-test.json',
  fs: { unlinkSync() {} },
  Date,
  Number,
  String,
  Object,
  Math
};
vm.runInNewContext(`${main.slice(start, end)}\nthis.api = { trackUsage, normalizeUsageAction };`, context);

let result = context.api.trackUsage('message', { ok: true, prompt: 'private prompt text' });
assert.strictEqual(result.recorded, false);
assert.strictEqual(stored, null, 'disabled statistics must not write a file');
enabled = true;
result = context.api.trackUsage('Tool.Web Search / private', { ok: true, durationMs: 125, prompt: 'private prompt text', path: '/private/file' });
assert.strictEqual(result.recorded, true);
const key = 'tool.web_search___private';
assert(stored.actions[key], 'action name was not safely normalized');
assert.deepStrictEqual(Object.keys(stored.actions[key]).sort(), ['count', 'error', 'lastAt', 'success', 'totalMs'].sort());
assert.strictEqual(JSON.stringify(stored).includes('private prompt text'), false, 'prompt content leaked into usage statistics');
assert.strictEqual(JSON.stringify(stored).includes('/private/file'), false, 'file path leaked into usage statistics');
console.log('  ok   statistics require consent and discard sensitive metadata');

for (let index = 0; index < 110; index++) context.api.trackUsage('action-' + index, { ok: index % 2 === 0, durationMs: 10 });
assert(Object.keys(stored.actions).length <= 100, 'action cardinality is unbounded');
assert(Object.keys(stored.days).length <= 30, 'daily history is unbounded');
assert(stored.total >= 111, 'aggregate total did not count events');
console.log('  ok   local counters are aggregated and bounded');

assert(main.includes("trackUsage('tool.' + name"), 'tool execution is not tracked');
assert(!main.includes('fetch(USAGE_STATS_FILE'), 'usage statistics must never be uploaded');
assert(main.includes("ipcMain.handle('usage:get'"), 'usage read IPC is missing');
assert(main.includes("ipcMain.handle('usage:clear'"), 'usage clear IPC is missing');
assert(preload.includes("ipcRenderer.invoke('usage:track'"), 'usage tracking is not exposed through preload');
assert(renderer.includes("api.trackUsage('message')") && renderer.includes("api.trackUsage('view.'"), 'message and view aggregates are missing');
console.log('  ok   tools, messages, and views use guarded local aggregation');

for (const id of ['setUsageStats', 'refreshUsageBtn', 'exportUsageBtn', 'clearUsageBtn', 'usageStatsSummary']) assert(html.includes(`id="${id}"`), `missing usage control ${id}`);
assert(html.includes('Off by default.') && html.includes('Nothing is uploaded.'), 'consent and local-only behavior are not disclosed');
assert(/id="usageStatsSummary"[^>]*role="status"[^>]*aria-live="polite"/.test(html), 'usage summary is not accessible');
assert(renderer.includes('downloadText(JSON.stringify(stats, null, 2)'), 'usage export is missing');
console.log('  ok   users can inspect, export, disable, and clear local counters');

console.log('\n  All local-usage regression tests passed.\n');
