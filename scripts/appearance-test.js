#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nGemAir appearance regression tests\n');

const variables = new Map();
global.window = {};
global.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
global.document = {
  body: {
    dataset: {},
    style: { setProperty(name, value) { variables.set(name, value); } }
  },
  documentElement: { style: { setProperty(name, value) { variables.set(name, value); } } },
  dispatchEvent(event) { this.lastEvent = event; }
};

require(path.join(ROOT, 'renderer/themes.js'));
const themes = global.window.GemAirThemes;
assert(themes, 'theme engine did not initialize');
let result = themes.setAppearance('light');
result = themes.apply('cyan');
assert.strictEqual(themes.appearance(), 'light');
assert.strictEqual(document.body.dataset.appearance, 'light');
assert.strictEqual(variables.get('--bg'), '#f4f7fb');
assert.strictEqual(variables.get('--text'), '#111827');
assert.strictEqual(variables.get('--accent'), '#066a9c', 'light cyan accent must retain readable contrast');
assert.strictEqual(result.appearance, 'light');
assert.strictEqual(document.lastEvent.detail.appearance, 'light');
console.log('  ok   light appearance derives high-contrast theme tokens');

themes.setAppearance('dark');
result = themes.apply('cyan');
assert.strictEqual(variables.get('--bg'), '#04080d');
assert.strictEqual(variables.get('--text'), '#e6f6ff');
assert.strictEqual(variables.get('--accent'), '#3bc9ff');
assert.strictEqual(result.appearance, 'dark');
console.log('  ok   dark appearance restores the original HUD theme tokens');

delete global.window;
delete global.document;
delete global.CustomEvent;

const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const lightCss = fs.readFileSync(path.join(ROOT, 'renderer/light-mode.css'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'renderer/sw.js'), 'utf8');
assert(app.includes("appearance: 'dark'"), 'default profile appearance is missing');
assert(app.includes('appearance: DEFAULTS.appearance'), 'new profiles do not inherit appearance');
assert(app.includes('function toggleAppearance()'), 'appearance toggle behavior is missing');
assert(app.includes("persistProfile();\n}"), 'appearance toggle is not persisted');
assert(app.includes("id: 'toggle-appearance'"), 'command palette appearance action is missing');
assert(html.includes('id="appearanceToggle"') && html.includes('aria-pressed="false"'), 'accessible appearance control is missing');
assert(html.includes('href="light-mode.css"'), 'light appearance stylesheet is not linked');
assert(lightCss.includes("body[data-appearance='light']"), 'light appearance selectors are missing');
assert(sw.includes("'light-mode.css'"), 'PWA shell does not cache the light appearance stylesheet');
console.log('  ok   appearance controls persist and ship in desktop and PWA surfaces');

console.log('\n  All appearance regression tests passed.\n');
