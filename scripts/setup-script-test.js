#!/usr/bin/env node
'use strict';

// OS-aware setup script tests (the Node counterpart of Mark-LIV's setup.py):
// friendly interpreter gate, per-OS notes, dry-run CLI, package wiring.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const setup = require(path.join(ROOT, 'scripts/setup.js'));

console.log('\nGemAir — setup script tests\n');

// ---------------------------------------------------------------------------
// Node version gate: wrong interpreter = one clear sentence, never an npm dump
// ---------------------------------------------------------------------------
{
  const tooOld = setup.checkNodeVersion('20.11.1');
  assert.strictEqual(tooOld.ok, false, 'Node 20 must be refused');
  assert(/22\.12/.test(tooOld.message), 'refusal names the required version');
  assert(/nodejs\.org|nvm/.test(tooOld.message), 'refusal points at the fix, in one sentence');

  const ancient = setup.checkNodeVersion('18.0.0');
  assert.strictEqual(ancient.ok, false, 'Node 18 must be refused');

  const exact = setup.checkNodeVersion('22.12.0');
  assert.strictEqual(exact.ok, true, 'exact minimum accepted');
  const newer = setup.checkNodeVersion('24.1.0');
  assert.strictEqual(newer.ok, true, 'newer accepted');

  const garbage = setup.checkNodeVersion('not-a-version');
  assert.strictEqual(garbage.ok, false, 'unparseable versions refuse with guidance');
  assert(/Node 22\.12/.test(garbage.message));

  // v-prefixed strings (process.version shape) parse too.
  assert(setup.parseNodeVersion('v22.22.3').major === 22);
  assert.strictEqual(setup.parseNodeVersion('xyz'), null);
  console.log('  ok   interpreter gate: friendly one-sentence failures, exact boundaries');
}

// ---------------------------------------------------------------------------
// Checkout completeness probe
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(setup.checkoutProblems(ROOT), [], 'this repo must pass its own completeness probe');
  const missing = setup.checkoutProblems('/nonexistent-gemair-path');
  assert(missing.length >= 3, 'missing checkout reports every problem');
  console.log('  ok   checkout completeness probe');
}

// ---------------------------------------------------------------------------
// OS awareness: Windows vs macOS vs Linux get different guidance
// ---------------------------------------------------------------------------
{
  const linux = setup.osNotes('linux').join('\n');
  assert(/libnss3/.test(linux), 'Linux notes name the Electron system libraries');
  const mac = setup.osNotes('darwin').join('\n');
  assert(/xcode-select/.test(mac), 'macOS notes name the CLT');
  const win = setup.osNotes('win32').join('\n');
  assert(/Nothing OS-specific/.test(win), 'Windows notes say nothing extra is needed');
  assert(setup.npmCmd('win32') === 'npm.cmd', 'Windows npm shim spelled correctly');
  assert(setup.npmCmd('linux') === 'npm', 'Unix npm spelled correctly');
  const planWin = setup.osDependencyPlan('win32');
  const planMac = setup.osDependencyPlan('darwin');
  assert(planWin.skipped.includes('fsevents (macOS-only)'), 'Windows plan explains the macOS-only skip');
  assert.deepStrictEqual(planMac.skipped, [], 'macOS plan has no forced skips');
  console.log('  ok   OS-aware notes and dependency plan differ per platform');
}

// ---------------------------------------------------------------------------
// CLI: --check performs the full validation without installing anything
// ---------------------------------------------------------------------------
{
  const out = execSync(`node "${path.join(ROOT, 'scripts/setup.js')}" --check --no-color`, { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert(/GemAir setup/.test(out), 'check mode prints the header');
  assert(/Node\.js 22\./.test(out), 'check mode validates the running interpreter');
  assert(/checkout looks complete/.test(out), 'check mode validates the checkout');
  assert(/Environment check passed/.test(out), 'check mode passes without installing');
  assert(!/Installing npm dependencies/.test(out), '--check must not touch the network');
  console.log('  ok   CLI --check: validates environment, installs nothing');
}

// ---------------------------------------------------------------------------
// package.json wiring: npm run setup exists; engines gate matches the script
// ---------------------------------------------------------------------------
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts.setup, 'node scripts/setup.js', 'npm run setup must invoke the script');
  assert(pkg.engines && pkg.engines.node === '>=22.12.0', 'engines floor matches the script gate');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert(/npm run setup/.test(readme), 'README documents the setup command');
  console.log('  ok   package wiring + README documentation');
}

console.log('\nAll setup-script tests passed.\n');
