#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const windowTools = fs.readFileSync(path.join(ROOT, 'lib/window-tools.js'), 'utf8');

console.log('\nGemAir process-management regression tests\n');

const start = main.indexOf('const CLOSEABLE_APPS');
const end = main.indexOf('async function findLargeFiles', start);
assert(start >= 0 && end > start, 'close-app source window is missing');
let shouldFail = false;
const calls = [];
const context = {
  process: { platform: 'linux' },
  execFile(file, args, options, callback) {
    calls.push({ file, args, options });
    callback(shouldFail ? Object.assign(new Error('not found'), { code: 1 }) : null, '', shouldFail ? 'not found' : '');
  },
  logAction() {},
  setTimeout,
  clearTimeout,
  Promise,
  String,
  Set,
  Array,
  Date
};
vm.runInNewContext(`${main.slice(start, end)}\nthis.api = { closeApp, terminateAppProcess };`, context);

(async () => {
  let result = await context.api.closeApp('chrome');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(Array.from(calls[0].args), ['-f', '--', 'chrome']);
  assert.strictEqual(calls[0].file, 'pkill');
  assert.strictEqual(calls[0].options.windowsHide, true);
  assert.strictEqual(calls[0].options.timeout, 8000);
  console.log('  ok   app termination uses executable/argv calls without a shell');

  calls.length = 0;
  result = await context.api.closeApp('chrome; touch owned');
  assert(result.error, 'unsafe process name must be rejected');
  assert.strictEqual(calls.length, 0, 'unsafe process name reached process execution');
  shouldFail = true;
  result = await context.api.closeApp('chrome');
  assert(result.error && result.failures.length === 1, 'termination failures must be reported');
  console.log('  ok   unsafe names are rejected and failures are returned honestly');

  assert(main.includes("execFileCapture('taskkill', ['/PID', String(id), '/T', '/F'])"), 'PID termination is not argv-based on Windows');
  assert(main.includes("execFileCapture('kill', ['-TERM', String(id)])"), 'PID termination is not argv-based on Unix');
  assert(main.includes("await closeApp('all', keep || ['gemair'])"), 'gaming optimizer does not await app termination');
  assert(main.includes("/^\\.?gemair[-_.]/i.test(entry.name)"), 'temporary cleanup is not restricted to GemAir-owned entries');
  assert(!main.includes("exec('rm -rf /tmp/*"), 'gaming optimizer still deletes unrelated system temp files');
  assert(!main.includes("exec('del /q /s %TEMP%"), 'gaming optimizer still deletes unrelated Windows temp files');
  console.log('  ok   PID termination and gaming cleanup are bounded and awaited');

  assert(!windowTools.includes('exec(ps, ()=>{})'), 'window snapping still swallows execution errors');
  assert(!/exec\([^\n]+,\s*\(\)\s*=>\s*\{\}\)/.test(windowTools), 'desktop window tool still reports success before execution completes');
  assert(windowTools.includes("return result.err ? { error: 'Could not switch virtual desktops.' }"), 'virtual desktop errors are not returned');
  assert(windowTools.includes("return result.err ? { error: 'Could not minimize windows.' }"), 'minimize errors are not returned');
  console.log('  ok   window actions await execution and expose failures');

  console.log('\n  All process-management regression tests passed.\n');
})().catch((error) => {
  console.error('\n  PROCESS MANAGEMENT TEST FAILED:', error.stack || error);
  process.exitCode = 1;
});
