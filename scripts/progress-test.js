#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer/style.css'), 'utf8');

console.log('\nGemAir progress regression tests\n');

assert(/id="operationProgress"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/.test(html), 'accessible operation status region is missing');
assert(/id="operationProgressTrack"[^>]*role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"/.test(html), 'progressbar semantics are missing');
for (const id of ['operationProgressLabel', 'operationProgressValue', 'operationProgressBar']) {
  assert(html.includes(`id="${id}"`), `missing progress element ${id}`);
}
console.log('  ok   operation progress exposes accessible live semantics');

assert(app.includes('function showOperationProgress(label, percent = null)'), 'progress display function is missing');
assert(app.includes("track.setAttribute('aria-valuenow', String(bounded))"), 'determinate progress does not update aria-valuenow');
assert(app.includes("track.removeAttribute('aria-valuenow')"), 'indeterminate progress does not clear aria-valuenow');
assert(app.includes("showOperationProgress('Understanding request…')"), 'message requests do not start progress');
assert(app.includes("showOperationProgress('Generating response…')"), 'tool completion does not transition to response generation');
assert(app.includes('updateToolOperationProgress(name, state)'), 'tool activity is not connected to operation progress');
console.log('  ok   requests and real tool events drive indeterminate progress');

assert(app.includes('processed / plan.length * 100'), 'plan completion percentage is missing');
assert(app.includes("showOperationProgress('Plan complete', 100)"), 'plans do not reach determinate completion');
assert(app.includes('hideOperationProgress(1800)'), 'completed plan progress is not dismissed');
console.log('  ok   Plan-Act missions report determinate step completion');

assert(css.includes('.operation-progress-track.indeterminate i'), 'indeterminate progress styling is missing');
assert(css.includes('@keyframes operationProgressSweep'), 'progress sweep animation is missing');
assert(css.includes('transition: width .25s ease'), 'determinate progress transitions are missing');
console.log('  ok   determinate and indeterminate visual states are styled');

console.log('\n  All progress regression tests passed.\n');
