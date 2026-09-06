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

const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(data)
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
  // 1. refresh request shape: form-encoded, refresh grant, client id present,
  //    and NO code_verifier (verifier belongs only to the code exchange).
  {
    let seen = null;
    const fetchFn = async (url, options) => {
      seen = { url, options, body: String(options.body) };
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    };
    const data = await pkce.refreshChatGPTAccessToken('old-refresh', fetchFn);
    assert.equal(data.access_token, 'new-access');
    assert.ok(seen.url.includes('auth.openai.com/oauth/token'), 'wrong token endpoint');
    assert.ok(seen.body.includes('grant_type=refresh_token'), 'wrong grant type');
    assert.ok(seen.body.includes('refresh_token=old-refresh'), 'refresh token missing');
    assert.ok(seen.body.includes('client_id='), 'client id missing');
    assert.ok(!seen.body.includes('code_verifier'), 'code_verifier must not appear in refresh requests');
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
    assert(main.includes('ChatGPT session expired — re-import Codex login'), 'expiry message is missing');
    assert(main.includes("send('connections:expired'"), 'expiry is not broadcast to the renderer');
    const app = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
    assert(app.includes('data.message') && app.includes('CONNECTION LOST'), 'renderer does not surface the exact expiry message');
    console.log('  ok   scheduler, 5-minute window, and exact expiry messaging');
  }

  console.log('\n  All ChatGPT refresh tests passed.\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });
