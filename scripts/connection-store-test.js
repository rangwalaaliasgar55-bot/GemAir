#!/usr/bin/env node
'use strict';

// Hard end-to-end test of the paste-session / capture backend WITHOUT a
// display: injects a fake `electron` module (in-memory safeStorage + temp
// userData dir) through the require cache, then runs the EXACT sequence the
// main-process import handler performs: parse → store → status → decrypt.
// If any step regresses, ChatGPT "connects" in the UI but chat fails.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-conn-test-'));

let selectedStorageBackend = 'kwallet6';
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => selectedStorageBackend,
  encryptString: (s) => Buffer.from('enc:' + String(s), 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^enc:/, '')
};
const fakeApp = { getPath: (name) => (name === 'userData' ? tmp : os.tmpdir()) };
Module._cache[require.resolve('electron')] = {
  id: require.resolve('electron'),
  filename: require.resolve('electron'),
  loaded: true,
  exports: { safeStorage: fakeSafeStorage, app: fakeApp }
};

const connections = require(path.join(root, 'lib/connections.js'));

function b64url(obj) {
  return Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function testJwt(expSeconds) {
  const payload = { sub: 'user-123', exp: Math.floor(Date.now() / 1000) + expSeconds };
  return b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(payload) + '.' + b64url('sig' + 'x'.repeat(300));
}

(async () => {
  // 1. Realistic pasted /api/auth/session page → parse → store → connected.
  const jwt = testJwt(3600);
  const page = JSON.stringify({
    user: { id: 'user-123', name: 'Tester', email: 'tester@example.com', image: 'https://x/y.png' },
    expires: new Date(Date.now() + 3600000).toISOString(),
    accessToken: jwt
  });
  const parsed = connections.parseChatGPTSessionJson(page);
  assert.equal(parsed.email, 'tester@example.com');
  assert.equal(parsed.accessToken, jwt);
  const stored = connections.setChatGPTConnection({
    email: parsed.email, plan: parsed.plan,
    sessionToken: parsed.accessToken, accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt
  });
  assert.ok(!stored.error, 'store failed: ' + (stored && stored.error));
  const status = connections.getSanitizedStatus();
  assert.equal(status.chatgpt.connected, true, 'hub does not report connected after import');
  assert.equal(status.chatgpt.email, 'tester@example.com');
  const back = connections.getDecryptedTokens('chatgpt');
  assert.equal(back.accessToken, jwt, 'access token did not survive the encrypted round-trip');
  assert.equal(connections.isTokenExpired('chatgpt'), false, 'fresh import already reads as expired');
  console.log('  ok   pasted session JSON imports and reads back connected');

  // 1b. Refreshable Codex metadata survives encrypted storage, while the
  // sanitized renderer status exposes only model/profile preferences.
  const idToken = testJwt(7200);
  const codexStored = connections.setChatGPTConnection({
    email: 'plus@example.com', plan: 'plus', sessionToken: jwt,
    accessToken: jwt, refreshToken: 'refresh-token-value-that-is-long-enough',
    idToken, accountId: 'acct_test_123', authMode: 'codex-oauth',
    availableModels: ['gpt-test-a', 'gpt-test-b'], selectedModel: 'gpt-test-b',
    reasoningEffort: 'high', serviceTier: 'fast', expiresAt: Date.now() + 3600000
  });
  assert.ok(!codexStored.error);
  const publicStatus = connections.getSanitizedStatus().chatgpt;
  assert.equal(publicStatus.authMode, 'codex-oauth');
  assert.equal(publicStatus.selectedModel, 'gpt-test-b');
  assert.deepEqual(publicStatus.availableModels, ['gpt-test-a', 'gpt-test-b']);
  assert.equal(publicStatus.accessToken, undefined, 'bearer token leaked into sanitized status');
  assert.equal(publicStatus.accountId, undefined, 'account id leaked into sanitized status');
  const privateTokens = connections.getDecryptedTokens('chatgpt');
  assert.equal(privateTokens.accountId, 'acct_test_123');
  assert.equal(privateTokens.idToken, idToken);
  const preferred = connections.setChatGPTPreferences({ selectedModel: 'gpt-test-a', reasoningEffort: 'low', serviceTier: 'auto' });
  assert.equal(preferred.chatgpt.selectedModel, 'gpt-test-a');
  assert.equal(preferred.chatgpt.reasoningEffort, 'low');
  const preservedOldIdentity = connections.setChatGPTConnection({
    email: 'plus@example.com', plan: 'plus', sessionToken: jwt,
    accessToken: jwt, refreshToken: 'rotated-refresh-token-that-is-long-enough',
    idToken: testJwt(-60), accountId: 'acct_test_123', authMode: 'codex-oauth',
    expiresAt: Date.now() + 3600000
  });
  assert.ok(!preservedOldIdentity.error, 'an expired metadata-only ID token blocked fresh access-token rotation');
  console.log('  ok   Codex tokens stay private while model controls persist');

  // 2. Expired access tokens never become live sessions.
  assert.throws(
    () => connections.parseChatGPTSessionJson(JSON.stringify({
      user: { email: 'old@example.com' }, accessToken: testJwt(-7200)
    })),
    /SESSION_JSON_NO_TOKEN/,
    'an expired JWT must not parse as a usable token'
  );
  const storedOld = connections.setChatGPTConnection({
    email: 'old@example.com', plan: 'free', sessionToken: testJwt(3600),
    accessToken: testJwt(3600), refreshToken: '', expiresAt: Date.now() - 1000
  });
  assert.equal(storedOld.error, 'TOKEN_EXPIRED', 'expired import was not rejected');
  console.log('  ok   expired sessions are rejected instead of stored live');

  // 3. Gemini PSID capture stores a session the chat guard reroutes (no 401).
  const psid = 'g.a000FakeP' + 'sid-value-'.repeat(12);
  const g = connections.setGeminiConnection({ email: 'g@example.com', plan: 'free', psid, psidts: '' });
  assert.ok(!g.error, 'gemini store failed: ' + (g && g.error));
  assert.equal(connections.getSanitizedStatus().gemini.connected, true);
  const gtok = connections.getDecryptedTokens('gemini');
  assert.equal(gtok.psid, psid, 'PSID did not survive the encrypted round-trip');
  assert.equal(connections.isWebSessionOnlyToken(gtok.psid), true, 'PSID would be sent as Bearer (401 loop)');
  console.log('  ok   captured PSID stores connected and is flagged non-API');

  // Linux's basic_text backend is obfuscation, not protected storage.
  if (process.platform === 'linux') {
    selectedStorageBackend = 'basic_text';
    const insecure = connections.setChatGPTConnection({
      accessToken: testJwt(3600), expiresAt: Date.now() + 3600000
    });
    assert.equal(insecure.error, 'ENCRYPTION_UNAVAILABLE');
    selectedStorageBackend = 'kwallet6';
    console.log('  ok   insecure Linux basic_text credential storage is refused');
  }

  // 4. Clear path still works (disconnect buttons).
  connections.clearConnection('chatgpt');
  connections.clearConnection('gemini');
  const cleared = connections.getSanitizedStatus();
  assert.equal(cleared.chatgpt.connected, false);
  assert.equal(cleared.gemini.connected, false);
  console.log('  ok   disconnect clears both providers');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n  All connection store tests passed.\n');
})().catch((error) => { console.error(error); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exitCode = 1; });
