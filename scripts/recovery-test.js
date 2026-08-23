#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

console.log('\nGemAir crash-recovery regression tests\n');

const start = main.indexOf('const MAX_STATE_FILE_BYTES');
const end = main.indexOf('const readProfile', start);
assert(start >= 0 && end > start, 'atomic persistence source window is missing');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-recovery-test-'));
const recoveryFile = path.join(temporaryDirectory, 'recovery.json');
const context = { fs, path, Buffer, process, console, RECOVERY_FILE: recoveryFile };
vm.runInNewContext(`${main.slice(start, end)}\nthis.api = { safeReadJSONFile, atomicWriteJSON, readJSON };`, context);
const api = context.api;
const stateFile = path.join(temporaryDirectory, 'state.json');

fs.writeFileSync(stateFile, '[]');
assert.strictEqual(api.safeReadJSONFile(stateFile), null, 'array roots must not be accepted as state objects');
assert.strictEqual(api.atomicWriteJSON(stateFile, { revision: 1 }), true);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { revision: 1 });
assert.strictEqual(fs.statSync(stateFile).mode & 0o777, 0o600, 'state file permissions must be private');
assert.strictEqual(api.atomicWriteJSON(stateFile, { revision: 2 }), true);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile + '.bak', 'utf8')), { revision: 1 }, 'previous valid state was not backed up');
assert.strictEqual(fs.readdirSync(temporaryDirectory).some((name) => name.endsWith('.tmp')), false, 'temporary state files were not cleaned up');
console.log('  ok   state writes are private, atomic, and retain a valid backup');

fs.writeFileSync(stateFile, '{broken json');
const recovered = api.readJSON(stateFile, { revision: 0 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(recovered)), { revision: 1 });
assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { revision: 1 }, 'backup was not restored over corrupt primary state');
console.log('  ok   corrupt primary state is restored automatically from backup');

assert(main.includes("readJSON(PROFILE_FILE, {}, 'profile')"), 'profile does not fall back to emergency recovery');
assert(main.includes("readJSON(MEMORY_FILE, freshEmptyMemory(), 'memory')"), 'memory does not fall back to emergency recovery');
assert(main.includes("readJSON(WINDOW_STATE_FILE, {}, 'windowState')"), 'window state does not fall back to emergency recovery');
assert(main.includes("clean.ai = { ...clean.ai, apiKey: '' }"), 'API keys are not redacted from emergency state');
assert(main.includes('MAX_STATE_FILE_BYTES = 20 * 1024 * 1024'), 'recovery files are not size bounded');
assert(main.includes("process.on('uncaughtException'"), 'fatal crash handler is missing');
assert(main.includes("process.on('unhandledRejection'"), 'rejection checkpoint handler is missing');
assert(main.includes("webContents.on('render-process-gone'"), 'renderer crash recovery handler is missing');
assert(main.includes('rendererCrashHistory.length === 1'), 'renderer reload loop protection is missing');
assert(main.includes('fatalCrashInProgress = true'), 'fatal checkpoints may be cleared during shutdown');
assert(main.includes("recovery.kind !== 'unhandledRejection'"), 'nonfatal checkpoints are not cleared after graceful shutdown');
console.log('  ok   emergency checkpoints are bounded, redacted, and lifecycle-aware');

assert(main.includes("ipcMain.handle('recovery:consume'"), 'recovery status IPC is missing');
assert(preload.includes("ipcRenderer.invoke('recovery:consume')"), 'recovery IPC is not exposed through preload');
assert(renderer.includes('const recovery = await api.consumeRecovery()'), 'renderer does not consume recovery status');
assert(renderer.includes("toast('STATE RECOVERED'"), 'user is not notified after recovery');
console.log('  ok   recovery is reported once through guarded IPC');

fs.rmSync(temporaryDirectory, { recursive: true, force: true });
console.log('\n  All crash-recovery regression tests passed.\n');
