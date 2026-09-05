#!/usr/bin/env node
'use strict';

// Release metadata verification. Network calls are opt-in so the normal test
// suite stays deterministic; run with VERIFY_RELEASE=1 for a live GitHub check.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const expectedTag = 'v' + version;
const repo = 'rangwalaaliasgar55-bot/GemAir';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/^\d+\.\d+\.\d+$/.test(version), 'package version must be semver');
assert(fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() === version, 'VERSION disagrees with package.json');
assert(fs.readFileSync(path.join(root, 'api/_lib/http.js'), 'utf8').includes(`const VERSION = '${version}'`), 'API version disagrees with package.json');
assert(fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').includes(`v${version}`), 'renderer version label is stale');

async function main() {
  if (process.env.VERIFY_RELEASE !== '1') {
    console.log(`ok - local release metadata is consistent (${expectedTag})`);
    return;
  }
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${expectedTag}`, { headers: { Accept: 'application/vnd.github+json' } });
  assert(response.ok, `GitHub release ${expectedTag} is not published (HTTP ${response.status})`);
  const release = await response.json();
  assert(release.draft === false && release.prerelease === false, `${expectedTag} must be a stable published release`);
  const assets = Array.isArray(release.assets) ? release.assets.map((asset) => asset.name) : [];
  assert(assets.some((name) => /\.exe$/i.test(name)), 'Windows installer asset is missing');
  assert(assets.some((name) => /\.dmg$/i.test(name)), 'macOS DMG asset is missing');
  assert(assets.some((name) => /\.(AppImage|deb)$/i.test(name)), 'Linux package asset is missing');
  assert(assets.some((name) => /SHA256SUMS\.txt$/i.test(name)), 'SHA256SUMS.txt asset is missing');
  console.log(`ok - ${expectedTag} has stable Windows, macOS, Linux, and checksum assets`);
}

main().catch((error) => { console.error('release verification failed:', error.message); process.exitCode = 1; });
