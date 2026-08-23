#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

console.log('\nGemAir adaptive-personality regression tests\n');

const start = app.indexOf('function clampPersonalityScore');
const end = app.indexOf('function renderAdaptivePersonalityState', start);
assert(start >= 0 && end > start, 'adaptive personality source window is missing');
const source = app.slice(start, end);

function evaluate(profile, memory, currentEmotion) {
  const context = { profile, memory, currentEmotion };
  vm.runInNewContext(`${source}\nthis.result = getPersonalityAdjustments();`, context);
  return JSON.parse(JSON.stringify(context.result));
}

const manual = evaluate(
  { adaptivePersonality: false, soul: { warmth: 55, wit: 35, brevity: 65 } },
  { mood: [{ valence: -1 }] },
  { emotion: 'sadness', valence: -1, intensity: 1 }
);
assert.deepStrictEqual({ warmth: manual.warmth, wit: manual.wit, brevity: manual.brevity }, { warmth: 55, wit: 35, brevity: 65 });
assert.strictEqual(manual.mode, 'custom');
assert.strictEqual(manual.adaptive, false);
console.log('  ok   disabling adaptation follows manual sliders exactly');

const supportive = evaluate(
  { adaptivePersonality: true, soul: { warmth: 60, wit: 40, brevity: 70 } },
  { mood: [{ valence: -0.4 }, { valence: -0.8 }] },
  { emotion: 'anxiety', valence: -0.9, intensity: 1 }
);
assert.strictEqual(supportive.mode, 'supportive');
assert(supportive.warmth > 60, 'supportive mode should increase warmth');
assert(supportive.wit < 40, 'supportive mode should suppress wit');
assert(supportive.brevity > 70, 'supportive mode should become more concise');
assert([supportive.warmth, supportive.wit, supportive.brevity].every((value) => value >= 0 && value <= 100), 'effective values must remain bounded');
console.log('  ok   distress produces a bounded warmer, gentler, shorter tone');

const celebratory = evaluate(
  { adaptivePersonality: true, soul: { warmth: 60, wit: 40, brevity: 70 } },
  { mood: [{ valence: 0.5 }, { valence: 0.8 }] },
  { emotion: 'joy', valence: 0.9, intensity: 0.8 }
);
assert.strictEqual(celebratory.mode, 'celebratory');
assert(celebratory.wit > 40 && celebratory.warmth >= 60, 'celebratory mode should be warmer and more playful');
console.log('  ok   positive mood produces a celebratory adjustment');

assert(app.includes('Personality baseline — warmth ${personality.base.warmth}'), 'system prompt does not preserve the manual baseline');
assert(app.includes('Effective tone — ${personality.mode}'), 'system prompt does not include effective adaptive values');
assert(app.includes('bounded mood-based adjustment'), 'system prompt does not constrain adaptation');
assert(html.includes('id="soulAdaptive"') && html.includes('id="adaptivePersonalityState"'), 'adaptive personality controls are missing');
assert(/id="adaptivePersonalityState"[^>]*role="status"[^>]*aria-live="polite"/.test(html), 'adaptive status is not accessible');
console.log('  ok   adaptive state is transparent, accessible, and supplied to the AI');

console.log('\n  All adaptive-personality regression tests passed.\n');
