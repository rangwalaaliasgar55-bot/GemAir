#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { readJsonRecovering, writeJsonAtomic, removeJsonStore } = require(path.join(ROOT, 'lib/atomic-store.js'));

console.log('\nGemAir auxiliary-storage regression tests\n');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-aux-store-'));
const file = path.join(temp, 'state.json');
assert.strictEqual(writeJsonAtomic(file, { revision: 1 }, { maxBytes: 1024 }), true);
assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
assert.strictEqual(writeJsonAtomic(file, { revision: 2 }, { maxBytes: 1024 }), true);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { revision: 1 });
fs.writeFileSync(file, '{corrupt');
assert.deepStrictEqual(readJsonRecovering(file, { revision: 0 }, { maxBytes: 1024 }), { revision: 1 });
assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { revision: 1 });
assert.strictEqual(fs.readdirSync(temp).some((name) => name.endsWith('.tmp')), false);
removeJsonStore(file);
assert.strictEqual(fs.existsSync(file) || fs.existsSync(file + '.bak'), false);
console.log('  ok   shared auxiliary store writes atomically and restores backups');

const home = path.join(temp, 'home');
const dataDir = path.join(home, '.gemair');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'gemair-modes.json'), JSON.stringify({
  SAFE: { name: 'SAFE', apps: ['calculator'], sites: [{ url: 'https://example.com' }], volume: 30 },
  BAD: { name: '../../BAD', apps: ['calc; shutdown'], sites: [{ url: 'file:///etc/passwd' }] }
}));
fs.writeFileSync(path.join(dataDir, 'gemair-connections.enc'), JSON.stringify({
  chatgpt: { email: 'attacker\n@example.com', accessTokenEnc: 'not:encrypted:fallback' },
  meta: { priority: 'attacker', warningAcknowledged: 'yes' }
}));

const childScript = `
  const fs = require('fs');
  const modes = require(${JSON.stringify(path.join(ROOT, 'lib/modes.js'))});
  const connections = require(${JSON.stringify(path.join(ROOT, 'lib/connections.js'))});
  const listed = modes.listModes();
  const saved = modes.saveMode({ name: 'FOCUS', apps: ['calculator'], sites: [{ url: 'https://example.com' }], volume: 25 });
  modes.saveMode({ name: 'FOCUS', apps: ['calculator'], sites: [], volume: 30 });
  const priority = connections.setPriority('free');
  connections.setPriority('chatgpt');
  process.stdout.write(JSON.stringify({
    names: listed.map((mode) => mode.name),
    saved: saved.ok,
    deleteBuiltin: modes.deleteMode('WORK'),
    modeFile: modes.MODES_FILE,
    connectionFile: connections.CONNECTIONS_FILE,
    priority: priority.meta.priority
  }));
`;
const child = spawnSync(process.execPath, ['-e', childScript], { cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
assert.strictEqual(child.status, 0, child.stderr);
const output = JSON.parse(child.stdout);
assert(output.names.includes('SAFE'));
assert(!output.names.includes('../../BAD'));
assert.strictEqual(output.saved, true);
assert(output.deleteBuiltin.error, 'built-in mode deletion should be rejected');
assert.strictEqual(output.priority, 'free');
assert.strictEqual(fs.statSync(output.modeFile).mode & 0o777, 0o600);
assert.strictEqual(fs.statSync(output.connectionFile).mode & 0o777, 0o600);
assert(fs.existsSync(output.modeFile + '.bak'), 'mode backup was not created');
assert(fs.existsSync(output.connectionFile + '.bak'), 'connection backup was not created');
console.log('  ok   modes and connection metadata are validated, private, and backed up');

const connectionsSource = fs.readFileSync(path.join(ROOT, 'lib/connections.js'), 'utf8');
const modesSource = fs.readFileSync(path.join(ROOT, 'lib/modes.js'), 'utf8');
assert(!/fs\.writeFileSync\((?:CONNECTIONS_FILE|USAGE_FILE)/.test(connectionsSource), 'connection storage still writes directly');
assert(!/fs\.writeFileSync\(MODES_FILE/.test(modesSource), 'mode storage still writes directly');
assert(connectionsSource.includes("removeJsonStore(CONNECTIONS_FILE)"), 'clearing connections does not remove backups');
assert(modesSource.includes('normalizeModeRecord(data[key])'), 'loaded modes are not revalidated');
console.log('  ok   auxiliary stores consistently use the atomic storage layer');

fs.rmSync(temp, { recursive: true, force: true });
console.log('\n  All auxiliary-storage regression tests passed.\n');
