#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer/style.css'), 'utf8');

console.log('\nGemAir quick-access regression tests\n');

assert(/id="quickCommands"[^>]*role="toolbar"[^>]*aria-label="Quick assistant actions"/.test(html), 'quick actions need accessible toolbar semantics');
const expected = [
  ['1', 'Search the web for ', 'Alt+1'],
  ['2', "What's the weather?", 'Alt+2'],
  ['3', 'Write a note: ', 'Alt+3'],
  ['4', 'Remind me to ', 'Alt+4']
];
for (const [shortcut, command, keyLabel] of expected) {
  assert(html.includes(`data-cmd="${command}"`), `missing quick command: ${command}`);
  assert(html.includes(`data-shortcut="${shortcut}"`), `missing shortcut mapping ${shortcut}`);
  assert(html.includes(`aria-keyshortcuts="${keyLabel}"`), `missing accessible shortcut ${keyLabel}`);
}
const toolbarMarkup = (html.match(/<div class="quick-commands" id="quickCommands"[\s\S]*?<\/div>/) || [''])[0];
assert.strictEqual((toolbarMarkup.match(/class="qc"/g) || []).length, 10, 'quick toolbar should retain all ten actions');
assert(!/<button class="qc"/.test(toolbarMarkup), 'quick buttons must declare type="button"');
console.log('  ok   Search, Weather, Note, and Reminder expose accessible shortcuts');

assert(app.includes('function activateQuickButton(button)'), 'shared quick-action behavior is missing');
assert(app.includes("$('.expert-tab[data-etab=\"agent\"]')"), 'quick actions do not reveal the agent input pane');
assert(app.includes("input.setSelectionRange(input.value.length, input.value.length)"), 'quick actions do not place the caret after the prompt');
assert(app.includes("['ArrowLeft', 'ArrowRight', 'Home', 'End']"), 'toolbar arrow-key navigation is missing');
assert(app.includes("e.altKey && !e.ctrlKey && !e.metaKey && /^[1-4]$/.test(e.key)"), 'global Alt+1…4 shortcuts are missing');
console.log('  ok   quick actions work from every view with roving keyboard focus');

assert(css.includes('.qc:focus-visible'), 'quick actions lack a visible keyboard focus style');
assert(css.includes('.quick-commands { flex-wrap: nowrap; overflow-x: auto;'), 'mobile quick toolbar is not horizontally scrollable');
console.log('  ok   quick toolbar remains focused and usable on narrow layouts');

console.log('\n  All quick-access regression tests passed.\n');
