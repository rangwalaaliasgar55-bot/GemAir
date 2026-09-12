#!/usr/bin/env node
'use strict';

// OpenAI token-refresh tests: request shape, success, failure mapping,
// and the proactive check-and-refresh policy. No network, no Electron.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkce = require(path.join(root, 'lib/oauth-chatgpt-pkce.js'));
const bridge = require(path.join(root, 'lib/oauth-bridge.js'));

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' }
});

function fakeStore(tokens) {
  const box = { saved: null, tokens };
  return {
    box,
    getDecryptedTokens: () => box.tokens,
    setChatGPTConnection: (saved) => { box.saved = saved; return { ok: true }; }
  };
}

(async () => {
  // 1. Current OpenAI refresh request shape: JSON refresh grant with client id
  //    + scope and NO code_verifier (that belongs only to the code exchange).
  {
    let seen = null;
    const fetchFn = async (url, options) => {
      seen = { url, options, body: String(options.body) };
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    };
    const data = await pkce.refreshChatGPTAccessToken('old-refresh', fetchFn);
    assert.equal(data.access_token, 'new-access');
    assert.ok(seen.url.includes('auth.openai.com/oauth/token'), 'wrong token endpoint');
    const body = JSON.parse(seen.body);
    assert.equal(body.grant_type, 'refresh_token', 'wrong grant type');
    assert.equal(body.refresh_token, 'old-refresh', 'refresh token missing');
    assert.ok(body.client_id, 'client id missing');
    assert.match(body.scope, /offline_access/, 'refresh scope missing');
    assert.equal(body.code_verifier, undefined, 'code_verifier must not appear in refresh requests');
    assert.match(String(seen.options.headers['Content-Type'] || seen.options.headers.get && seen.options.headers.get('content-type')), /application\/json/i);
    console.log('  ok   refresh request shape (grant, no verifier, token endpoint)');
  }

  // 2. failure mapping
  {
    await assert.rejects(
      pkce.refreshChatGPTAccessToken('x', async () => json({ error: 'gone' }, 401)),
      (e) => e.code === 'REFRESH_UNAUTHORIZED',
      '401 must map to REFRESH_UNAUTHORIZED'
    );
    await assert.rejects(
      pkce.refreshChatGPTAccessToken('x', async () => json({ error: 'invalid_grant' }, 400)),
      (e) => e.code === 'REFRESH_UNAUTHORIZED',
      'invalid_grant must map to REFRESH_UNAUTHORIZED'
    );
    await assert.rejects(
      pkce.refreshChatGPTAccessToken('x', async () => json({ error: 'boom' }, 500)),
      (e) => e.code === 'REFRESH_FAILED',
      '500 must map to REFRESH_FAILED'
    );
    await assert.rejects(
      pkce.refreshChatGPTAccessToken('', async () => json({})),
      (e) => e.code === 'NO_REFRESH_TOKEN',
      'missing refresh token must fail fast'
    );
    console.log('  ok   refresh failure mapping (401, invalid_grant, 500, missing token)');
  }

  // 3. proactive policy with a fake store
  {
    const now = 1_700_000_000_000;
    let r = await bridge.checkAndRefreshChatGPT({ store: fakeStore(null), nowMs: now });
    assert.deepEqual([r.refreshed, r.reason], [false, 'NO_SESSION']);
    r = await bridge.checkAndRefreshChatGPT({
      store: fakeStore({ accessToken: 'a', refreshToken: '', expiresAt: now }), nowMs: now
    });
    assert.deepEqual([r.refreshed, r.reason], [false, 'NO_REFRESH_TOKEN']);
    r = await bridge.checkAndRefreshChatGPT({
      store: fakeStore({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 60 * 60 * 1000 }), nowMs: now
    });
    assert.deepEqual([r.refreshed, r.reason], [false, 'NOT_DUE']);
    const store = fakeStore({
      accessToken: 'old', refreshToken: 'good', expiresAt: now + 60 * 1000,
      email: 'me@example.com', plan: 'oauth'
    });
    const fetchFn = async () => json({ access_token: 'fresh', refresh_token: 'fresher', expires_in: 7200 });
    r = await bridge.checkAndRefreshChatGPT({ store, fetchFn, nowMs: now });
    assert.equal(r.refreshed, true);
    assert.equal(store.box.saved.accessToken, 'fresh');
    assert.equal(store.box.saved.refreshToken, 'fresher');
    assert.equal(store.box.saved.email, 'me@example.com', 'identity must survive rotation');
    assert.ok(store.box.saved.expiresAt > now, 'expiry must extend');
    r = await bridge.checkAndRefreshChatGPT({
      store: fakeStore({ accessToken: 'a', refreshToken: 'dead', expiresAt: now }), nowMs: now,
      fetchFn: async () => json({ error: 'invalid_grant' }, 400)
    });
    assert.deepEqual([r.refreshed, r.code], [false, 'REFRESH_UNAUTHORIZED']);
    console.log('  ok   proactive policy (no session, no token, not due, rotate, dead token)');
  }

  // 4. main-process scheduler + expiry messaging contracts
  {
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert(main.includes('function scheduleChatGPTRefresh'), 'refresh scheduler is missing');
    assert(main.includes('tokens.expiresAt - Date.now() - 5 * 60 * 1000'), 'refresh is not scheduled 5 minutes before expiry');
    assert(main.includes('ChatGPT session expired — sign in with ChatGPT again'), 'expiry message is missing');
    assert(main.includes("send('connections:expired'"), 'expiry is not broadcast to the renderer');
    const app = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
    assert(app.includes('data.message') && app.includes('CONNECTION LOST'), 'renderer does not surface the exact expiry message');
    console.log('  ok   scheduler, 5-minute window, and exact expiry messaging');
  }

  // 5. authorize URL carries every parameter auth.openai.com requires —
  // omitting originator lands on /error with missing_required_parameter.
  {
    const url = pkce.buildChatGPTAuthorizeUrl({
      clientId: 'app_test', redirectUri: 'http://localhost:1455/auth/callback',
      challenge: 'ch', state: 'st'
    });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://auth.openai.com/oauth/authorize');
    for (const [k, v] of [
      ['response_type', 'code'], ['client_id', 'app_test'],
      ['redirect_uri', 'http://localhost:1455/auth/callback'],
      ['scope', 'openid profile email offline_access'],
      ['code_challenge', 'ch'], ['code_challenge_method', 'S256'],
      ['id_token_add_organizations', 'true'],
      ['codex_cli_simplified_flow', 'true'],
      ['originator', 'gemair'], ['state', 'st']
    ]) assert.equal(u.searchParams.get(k), v, 'authorize URL missing ' + k);
    console.log('  ok   authorize URL carries originator + both Codex flags');
  }

  // 6. A malformed refresh token alone must not kill a good sign-in: it is
  // dropped (no auto-refresh) with a plain-spoken warning instead.
  {
    const good = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.' + 's'.repeat(300);
    let out = bridge.downgradeUnusableRefresh({ accessToken: good, refreshToken: '  ' + good + '\n', idToken: '' });
    assert.equal(out.tokens.refreshToken, good, 'transport whitespace must be trimmed, not punished');
    assert.equal(out.refreshWarning, '');
    out = bridge.downgradeUnusableRefresh({ accessToken: good, refreshToken: 'garbage!!', idToken: '' });
    assert.equal(out.tokens.refreshToken, '', 'unusable refresh token must be dropped');
    assert.equal(out.tokens.accessToken, good, 'good access token must survive the downgrade');
    assert.ok(/auto-refresh is off/.test(out.refreshWarning), 'downgrade must explain itself');
    out = bridge.downgradeUnusableRefresh({ accessToken: good, refreshToken: '', idToken: '' });
    assert.equal(out.refreshWarning, '', 'missing refresh token needs no warning');
    console.log('  ok   malformed refresh tokens downgrade instead of failing sign-in');
  }

  console.log('\n  All ChatGPT refresh tests passed.\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });
