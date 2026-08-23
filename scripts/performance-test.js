#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

console.log('\nGemAir performance regression tests\n');

const coreFilesStart = main.indexOf('async function listDirectory');
const coreFilesEnd = main.indexOf('const SAFE_COMMANDS', coreFilesStart);
assert(coreFilesStart >= 0 && coreFilesEnd > coreFilesStart, 'core file-operation source window is missing');
const coreFiles = main.slice(coreFilesStart, coreFilesEnd);
assert(coreFiles.includes('fs.promises.readdir'), 'directory listing is not asynchronous');
assert(coreFiles.includes('fs.promises.stat'), 'file stat is not asynchronous');
assert(coreFiles.includes('fs.promises.readFile'), 'file reading is not asynchronous');
assert(coreFiles.includes('fs.promises.writeFile'), 'file writing is not asynchronous');
assert(!/fs\.(?:readdirSync|statSync|readFileSync|writeFileSync)/.test(coreFiles), 'a synchronous core file operation remains');
console.log('  ok   core list/read/write/search operations are asynchronous');

const workflowsStart = main.indexOf('async function organizeFolder');
const workflowsEnd = main.indexOf('async function optimizeGaming', workflowsStart);
assert(workflowsStart >= 0 && workflowsEnd > workflowsStart, 'file workflow source window is missing');
const workflows = main.slice(workflowsStart, workflowsEnd);
assert(!/fs\.(?:readdirSync|statSync|renameSync|mkdirSync)/.test(workflows), 'a synchronous file workflow operation remains');
for (const operation of ['organizeFolder', 'findDuplicates', 'renameFiles', 'archiveOldFiles', 'findLargeFiles', 'createFolderTree', 'moveFiles']) {
  assert(workflows.includes(`async function ${operation}`), `${operation} must remain asynchronous`);
}
console.log('  ok   organize/scan/rename/archive/move workflows do not block the main loop');

assert(main.includes("await fs.promises.readdir(base)"), 'Linux battery scan is still synchronous');
assert((main.match(/await fs\.promises\.writeFile\(file, source\.thumbnail\.toPNG\(\)\)/g) || []).length >= 2, 'screen captures are still written synchronously');
assert(main.includes('await fs.promises.writeFile(res.filePath, content)'), 'save-code IPC still writes synchronously');
console.log('  ok   battery, screenshot, and save-dialog I/O are asynchronous');

assert(renderer.includes('function debounce(fn, wait = 120)'), 'renderer debounce helper is missing');
const resizeListeners = renderer.match(/window\.addEventListener\('resize', debounce\(resize\), \{ passive: true \}\)/g) || [];
assert.strictEqual(resizeListeners.length, 3, 'all three canvas resize listeners must be debounced');
assert(!renderer.includes("window.addEventListener('resize', resize)"), 'an immediate resize listener remains');
console.log('  ok   canvas resize work is debounced and passive');

console.log('\n  All performance regression tests passed.\n');
