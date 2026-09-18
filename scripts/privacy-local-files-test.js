#!/usr/bin/env node
'use strict';

// Local-privacy hardening tests (Mark-LIV's local-first posture, applied to
// GemAir): .gitignore blocks the leak paths, SECURITY.md documents the
// revoke-and-rotate rule, the startup git-tracking guard classifies real
// hits without network access, and the warning path is wired end to end.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const { findTrackedSecrets, classifyTrackedFiles, SENSITIVE_PATTERNS, RECOMMENDED_GITIGNORE } = require(path.join(ROOT, 'lib/local-secret-check.js'));

console.log('\nGemAir — local privacy hardening tests\n');

// ---------------------------------------------------------------------------
// Classifier: every classic leak path is caught, templates stay allowed
// ---------------------------------------------------------------------------
{
  const tracked = [
    '.env', '.env.local', 'frontend/.env.production',
    'config/api_keys.json', 'api-keys.json',
    'config/certs/jarvis.crt', 'server.pem', 'id.p12', 'backup/certs/prod.key',
    '.ssh/id_rsa', 'keys/id_ed25519',
    'gemair-memory-backup.json', 'exports/gemair-profile-backup.json', 'memory-backup-2026.json',
    'config/secrets.yml',
    // allowed / safe entries:
    '.env.example', 'package.json', 'renderer/app.js', 'lib/plugin-loader.js',
    'GUIDE.md', 'certs.md', 'monkey.jpg'
  ];
  const hits = classifyTrackedFiles(tracked);
  const files = hits.map((h) => h.file);
  for (const expected of ['.env', '.env.local', 'frontend/.env.production', 'config/api_keys.json', 'api-keys.json', 'config/certs/jarvis.crt', 'server.pem', 'id.p12', 'backup/certs/prod.key', '.ssh/id_rsa', 'keys/id_ed25519', 'gemair-memory-backup.json', 'exports/gemair-profile-backup.json', 'memory-backup-2026.json', 'config/secrets.yml']) {
    assert(files.includes(expected), `must flag: ${expected}`);
  }
  for (const safe of ['.env.example', 'package.json', 'renderer/app.js', 'GUIDE.md', 'monkey.jpg']) {
    assert(!files.includes(safe), `must NOT flag harmless file: ${safe}`);
  }
  assert(hits.every((h) => h.kind && h.label), 'hits carry kind + human label');
  assert(SENSITIVE_PATTERNS.length >= 6 && SENSITIVE_PATTERNS.every((p) => p.re instanceof RegExp), 'patterns export stays shaped');
  console.log('  ok   classifier catches classic leak paths, allows templates/docs');
}

function runStaticChecks() {
  // -------------------------------------------------------------------------
  // .gitignore contract + guard wiring + SECURITY.md
  // -------------------------------------------------------------------------
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const pattern of RECOMMENDED_GITIGNORE) {
    if (pattern.startsWith('#')) continue;
    assert(gitignore.includes(pattern), `.gitignore missing recommended pattern: ${pattern}`);
  }
  console.log('  ok   .gitignore carries every recommended secrets pattern');

  const security = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  for (const phrase of ['revoke and rotate', 'does not remove', 'git history', 'local-first', 'no GemAir telemetry']) {
    assert(security.toLowerCase().includes(phrase.toLowerCase()), `SECURITY.md must include: "${phrase}"`);
  }
  console.log('  ok   SECURITY.md documents the revoke-and-rotate rule and the local-first inventory');

  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert(mainSrc.includes("require('./lib/local-secret-check')"), 'main.js must require the guard');
  assert(mainSrc.includes('runLocalSecretGuard()'), 'guard must run from app.whenReady');
  assert(mainSrc.includes("sendToRenderer('security:localSecrets'"), 'hits must be pushed to the renderer');

  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert(preloadSrc.includes('onLocalSecretsWarning'), 'preload must expose the warning channel');

  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert(appSrc.includes('api.onLocalSecretsWarning'), 'renderer must subscribe to the warning');
  assert(/git rm --cached/.test(appSrc), 'renderer warning must name the untrack command');
  assert(/revoke and rotate/i.test(appSrc), 'renderer warning must name rotation');
  console.log('  ok   guard wiring: main → preload → renderer warning with actionable text');
}

async function runAsyncChecks() {
  // findTrackedSecrets: no .git dir → not a checkout → checked:false
  {
    const result = await findTrackedSecrets(ROOT, { runGit: async () => { throw new Error('should not be called'); }, fsImpl: { existsSync: () => false } });
    assert.deepStrictEqual(result, { checked: false, reason: 'NOT_A_CHECKOUT', hits: [] }, 'non-git dirs short-circuit');
    console.log('  ok   non-git directories are skipped safely');
  }

  // findTrackedSecrets end-to-end with an injected git
  {
    const listing = ['package.json', 'config/api_keys.json', '.env', 'renderer/app.js'].join('\0') + '\0';
    const result = await findTrackedSecrets(ROOT, {
      runGit: async (_dir, args) => {
        assert.deepStrictEqual(args, ['ls-files', '-z'], 'guard asks git for the tracked list');
        return listing;
      },
      fsImpl: { existsSync: () => true }
    });
    assert.strictEqual(result.checked, true);
    assert.deepStrictEqual(result.hits.map((h) => h.file).sort(), ['.env', 'config/api_keys.json']);
    assert.strictEqual(result.totalTracked, 4);
    console.log('  ok   injected-git end-to-end: flags tracked secrets, counts the listing');
  }

  // A hung/failed git never breaks startup
  {
    const result = await findTrackedSecrets(ROOT, { runGit: async () => { throw new Error('git is not installed'); }, fsImpl: { existsSync: () => true } });
    assert.strictEqual(result.checked, false);
    assert.strictEqual(result.reason, 'GIT_FAILED');
    console.log('  ok   missing/broken git degrades to checked:false');
  }
}

runAsyncChecks()
  .then(() => {
    runStaticChecks();
    console.log('\nAll local-privacy hardening tests passed.\n');
  })
  .catch((error) => { console.error(error); process.exit(1); });
