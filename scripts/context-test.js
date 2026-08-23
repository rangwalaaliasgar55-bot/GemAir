#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

console.log('\nGemAir context-strategy regression tests\n');

for (const [name, keep, send, threshold, summarize] of [
  ['full', 100, 48, 90, false],
  ['recent', 20, 20, 60, true],
  ['balanced', 40, 32, 70, true],
  ['minimal', 10, 10, 45, true]
]) {
  const pattern = new RegExp(`${name}: \\{ label: '[^']+', keep: ${keep}, send: ${send}, threshold: ${threshold}, summarize: ${summarize} \\}`);
  assert(pattern.test(app), `${name} context strategy is missing or changed unexpectedly`);
}
assert(app.includes("contextStrategy: 'balanced'"), 'balanced must be the default context strategy');
assert(app.includes('contextStrategy: DEFAULTS.contextStrategy'), 'new profiles do not inherit the context strategy');
console.log('  ok   all four bounded context strategies are defined');

assert(app.includes('function getContextMessages(maximum = 48)'), 'provider context selector is missing');
assert(app.includes('Math.min(maximum, strategy.send)'), 'provider context is not bounded by strategy');
assert(!/chatHistory\.slice\(-(16|14)\)/.test(app), 'legacy fixed context slices remain');
assert(app.includes('getContextMessages(48)') && app.includes('getContextMessages(24)'), 'provider and agent context caps are not applied');
console.log('  ok   provider payloads respect strategy and API message limits');

assert(app.includes('const storedLimit = strategy.keep + (strategy.summarize ? Math.max(4, Math.floor(strategy.keep * 0.25)) : 0)'), 'batched compression threshold is missing');
assert(app.includes(".join('\\n').slice(-60000)"), 'summary input is not bounded');
assert(app.includes('String(result.summary).slice(0, 12000)'), 'generated summary is not bounded');
assert(app.includes('Conversation summary (${strategy.label} strategy)'), 'compressed context is not labeled');
assert(app.includes("old.slice(-12)"), 'offline summary fallback is missing');
assert(app.includes("toast('CTX TRIMMED'") && app.includes("toast('CTX COMPRESSED'"), 'context changes are not disclosed to the user');
console.log('  ok   context compression is bounded, batched, and has an offline fallback');

assert(html.includes('id="setContextStrategy"'), 'context strategy setting is missing');
for (const value of ['full', 'balanced', 'recent', 'minimal']) assert(html.includes(`<option value="${value}">`), `missing ${value} setting option`);
assert(app.includes("$('#setContextStrategy').value ="), 'settings do not load the saved strategy');
assert(app.includes("profile.contextStrategy = CONTEXT_STRATEGIES[$('#setContextStrategy').value]"), 'settings do not validate and save the strategy');
console.log('  ok   context strategy is configurable and persistent');

console.log('\n  All context-strategy regression tests passed.\n');
