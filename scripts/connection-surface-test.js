#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer/app.js');
const bridge = read('lib/oauth-bridge.js');
const store = read('lib/connections.js');

for (const channel of ['connections:oauthChatGPT', 'connections:pollChatGPT', 'connections:cancelChatGPT', 'connections:refreshChatGPTModels', 'connections:setChatGPTPreferences', 'connections:oauthGemini', 'connections:getStatus', 'connections:chatStream', 'connections:disconnect']) {
  assert(main.includes(`ipcMain.handle('${channel}'`), `missing main handler: ${channel}`);
}
assert(preload.includes("connectionsOauthChatGPT: () => ipcRenderer.invoke('connections:oauthChatGPT')"), 'ChatGPT OAuth preload bridge missing');
assert(preload.includes("connectionsOauthGemini: () => ipcRenderer.invoke('connections:oauthGemini')"), 'Gemini OAuth preload bridge missing');
assert(renderer.includes('async connectionsOauthChatGPT()'), 'ChatGPT renderer bridge missing');
assert(renderer.includes('async connectionsOauthGemini()'), 'Gemini renderer bridge missing');
assert(renderer.includes('Requesting a one-time sign-in code from OpenAI'), 'renderer does not use device OAuth');
assert(bridge.includes('startChatGPTDeviceLogin') && bridge.includes('pollChatGPTDeviceLogin'), 'ChatGPT device-code state machine is missing');
assert(read('lib/chatgpt-codex.js').includes('@opencoredev/loginwithchatgpt-core'), 'maintained ChatGPT SDK adapter is missing');
assert(preload.includes("connectionsPollChatGPT: (loginId) => ipcRenderer.invoke('connections:pollChatGPT', loginId)"), 'device login poll is not isolated behind preload');
assert(bridge.includes('GEMINI_OAUTH_CLIENT_MISSING'), 'Gemini OAuth configuration failure is not explained');
assert(bridge.includes('setChatGPTConnection') && bridge.includes('setGeminiConnection'), 'OAuth bridge does not persist both providers');
assert(store.includes('safeStorage.encryptString'), 'connection store is not encrypted');
assert(store.includes('generativelanguage.googleapis.com/v1beta/models/') && store.includes(':generateContent'), 'Gemini official API route missing');
assert(!read('lib/oauth-gemini-pkce.js').includes('generative-language.retriever'), 'unsupported Gemini retriever scope is still requested');
assert(!read('lib/oauth-gemini-pkce.js').includes('auth/generative-language'), 'generative-language OAuth scope is still requested (Google rejects it with invalid_scope)');
assert(store.includes('apiKeyEnc'), 'Gemini AI Studio key is not stored encrypted');
assert(main.includes('connections.getDecryptedTokens(provider)'), 'connected brain does not read encrypted tokens');
assert(main.includes('connections.clearConnection(provider)') && preload.includes('sessionExpired: data.sessionExpired === true'), 'dead account sessions do not clear and cross the IPC fallback boundary');
assert(renderer.includes('SESSION EXPIRED — LIVE TOOLS / LOCAL FALLBACK'), 'the failed turn does not finish through the local fallback');
assert(main.includes("if (stored.chatgpt && stored.chatgpt.connected) return { connectedProvider: 'chatgpt' }"), 'ChatGPT is not primary for desktop agent resolution');
assert(main.includes("if (stored.gemini && stored.gemini.connected) return { connectedProvider: 'gemini' }"), 'Gemini is not primary for desktop agent resolution');
assert(main.includes("ipcMain.handle('connections:importCodex'"), 'Codex import IPC handler is missing');
assert(preload.includes("connectionsImportCodex: () => ipcRenderer.invoke('connections:importCodex')"), 'Codex import preload bridge is missing');
assert(renderer.includes('async connectionsImportCodex()'), 'Codex import renderer bridge is missing');
assert(renderer.includes('handleImportCodex'), 'Codex import handler is missing');
const codex = read('lib/codex-auth-import.js');
assert(!/require\(['"]child_process['"]\)/.test(codex) && !/\bspawn\s*\(|\bexecFile\s*\(|\bexecSync\s*\(/.test(codex), 'Codex import itself must never download or execute third-party code');
assert(codex.includes('function codexStatus'), 'Codex login state check is missing');
assert(main.includes("ipcMain.handle('connections:launchCodexLogin'"), 'guided Codex login launcher is missing');
assert(main.includes("ipcMain.handle('connections:codexStatus'"), 'Codex status IPC handler is missing');
assert(preload.includes("connectionsLaunchCodexLogin: () => ipcRenderer.invoke('connections:launchCodexLogin')"), 'Codex launcher preload bridge is missing');
assert(preload.includes("connectionsCodexStatus: () => ipcRenderer.invoke('connections:codexStatus')"), 'Codex status preload bridge is missing');
assert(renderer.includes('codexPollTimer'), 'renderer does not poll for the login result');
assert(main.includes('windowsHide: false'), 'guided login must run in a visible console window');
assert(main.includes('NEED_NODE'), 'missing Node.js is not reported honestly');
assert(codex.includes('.codex'), 'Codex import does not read the user-created token file');
console.log('ok - ChatGPT and Gemini OAuth, encrypted storage, IPC, and provider routing contracts');

(async () => {
  const connections = require(path.join(root, 'lib/connections.js'));
  assert.equal(connections.resolveGeminiAuth({}).mode, 'none');
  assert.equal(connections.resolveGeminiAuth({ storedApiKey: 'short' }).mode, 'none');
  assert.equal(connections.resolveGeminiAuth({ storedApiKey: 'AIzaTestKey1234567890' }).mode, 'key');
  assert.equal(connections.resolveGeminiAuth({ profileKey: '  AIzaTestKey1234567890  ' }).mode, 'key');
  assert.equal(connections.resolveGeminiAuth({ oauthToken: 'ya29.valid-looking-token-string-here' }).mode, 'bearer');
  assert.equal(
    connections.resolveGeminiAuth({ profileKey: 'AIzaTestKey1234567890', oauthToken: 'ya29.valid-looking-token-string-here' }).mode,
    'key',
    'an API key must win over an OAuth token'
  );
  const fakeFetch = async (url, options) => {
    fakeFetch.seen = { url, options };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) };
  };
  const out = await connections.callGeminiWeb({ apiKey: 'AIzaTestKey1234567890', messages: [{ role: 'user', content: 'hi' }], fetchFn: fakeFetch });
  assert.equal(out, 'hi');
  // The key must ride in the documented x-goog-api-key HEADER, never in the
  // URL: query strings end up in proxy logs, browser history and crash reports.
  assert.ok(!/key=/.test(fakeFetch.seen.url), 'key mode must not put the credential in the URL, got: ' + fakeFetch.seen.url);
  assert.equal(fakeFetch.seen.options.headers['x-goog-api-key'], 'AIzaTestKey1234567890', 'key mode must send x-goog-api-key');
  // A captured google.com browser cookie can never be spent on the REST API, so
  // it must be classified as a web session and reported, not sent as Bearer.
  const cookieFetch = async (url, options) => { cookieFetch.seen = { url, options }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) }; };
  await assert.rejects(
    () => connections.callGeminiWeb({ psid: '5pAb1QlZC8-not-an-oauth-token-abcdef', messages: [{ role: 'user', content: 'hi' }], fetchFn: cookieFetch }),
    /GEMINI_WEB_SESSION_ONLY/,
    'a PSID cookie must be reported as unusable instead of fired at the API as a bearer token'
  );
  assert.equal(cookieFetch.seen, undefined, 'a web-session credential must never reach the network');
  // An AI Studio key scraped by the AI Studio capture path used to be stored in
  // the psid slot and then sent as Bearer (guaranteed 401). Same slot, now the
  // right credential type.
  const scraped = await connections.callGeminiWeb({ psid: 'AIzaScrapedStudioKey0123456789', messages: [{ role: 'user', content: 'hi' }], fetchFn: cookieFetch });
  assert.equal(scraped, 'x');
  assert.equal(cookieFetch.seen.options.headers['x-goog-api-key'], 'AIzaScrapedStudioKey0123456789', 'an AIza-shaped value in the session slot must be treated as an API key');
  // A retired id from an old profile heals before the request goes out.
  const retiredFetch = async (url, options) => { retiredFetch.seen = { url, options }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'healed' }] } }] }) }; };
  const healedOut = await connections.callGeminiWeb({ apiKey: 'AIzaTestKey1234567890', model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }], fetchFn: retiredFetch });
  assert.equal(healedOut, 'healed');
  assert.ok(retiredFetch.seen.url.includes('gemini-2.5-flash'), 'a retired Gemini model must be healed, got: ' + retiredFetch.seen.url);
  assert.ok(!fakeFetch.seen.options.headers.Authorization, 'key mode must not send an Authorization header');
  await connections.callGeminiWeb({ psid: 'ya29.valid-looking-token-string-here', messages: [{ role: 'user', content: 'hi' }], fetchFn: fakeFetch });
  assert.ok(String(fakeFetch.seen.options.headers.Authorization || '').startsWith('Bearer '), 'bearer fallback must send the OAuth token');
  await assert.rejects(
    connections.callGeminiWeb({ messages: [{ role: 'user', content: 'hi' }], fetchFn: fakeFetch }),
    /GEMINI_KEY_REQUIRED/,
    'missing credentials must fail with an actionable error'
  );
  const modelSeen = {};
  const modelFetch = async (url, options) => {
    modelSeen.url = url;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) };
  };
  await connections.callGeminiWeb({ apiKey: 'AIzaTestKey1234567890', model: 'my-live-model', messages: [{ role: 'user', content: 'hi' }], fetchFn: modelFetch });
  assert.ok(modelSeen.url.includes('/models/my-live-model:generateContent'), 'caller-supplied model ID must reach the URL, got: ' + modelSeen.url);
  const goneFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(
    connections.callGeminiWeb({ apiKey: 'AIzaTestKey1234567890', model: 'retired-model', messages: [{ role: 'user', content: 'hi' }], fetchFn: goneFetch }),
    /GEMINI_HTTP_404.*retired\/unknown or/i,
    'a 404 must explain retired-model vs disabled-API instead of a bare status'
  );
  // Pasted session-JSON import (free-chatgpt.js flow): pure parse first.
  const goodJwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'e30.' + 'c2lnbmF0dXJlLW1vcmUtdGhhbi10d2VudHktY2hhcnMtbG9uZw';
  const parsed = connections.parseChatGPTSessionJson(JSON.stringify({
    user: { email: 'me@example.com' }, accessToken: goodJwt, expires: new Date(Date.now() + 3600000).toISOString()
  }));
  assert.equal(parsed.email, 'me@example.com');
  assert.equal(parsed.accessToken, goodJwt);
  assert.ok(parsed.expiresAt > Date.now(), 'session expires must be honored');
  assert.throws(() => connections.parseChatGPTSessionJson(''), /SESSION_JSON_EMPTY/);
  assert.throws(() => connections.parseChatGPTSessionJson('{nope'), /SESSION_JSON_INVALID/);
  assert.throws(() => connections.parseChatGPTSessionJson(JSON.stringify({ user: {} })), /SESSION_JSON_NO_TOKEN/);
  assert.throws(() => connections.parseChatGPTSessionJson(JSON.stringify({ accessToken: 'short' })), /SESSION_JSON_NO_TOKEN/);
  console.log('ok - Pasted session JSON parses honestly without credentials');
  // Validate-before-import IPC, preload bridge, renderer wiring, and the
  // agent retry entry (failed runs re-run through approvals, never silent).
  assert(main.includes("ipcMain.handle('connections:validateSessionJson'"), 'session validate IPC handler is missing');
  assert(preload.includes("connectionsValidateSessionJson: (text) => ipcRenderer.invoke('connections:validateSessionJson', text)"), 'session validate preload bridge is missing');
  assert(renderer.includes('validateSessionJsonLive'), 'live session validation is not wired');
  assert(renderer.includes('logAgentRetry'), 'agent retry entry is missing');
  assert(renderer.includes('each action still asks first'), 'retry must disclose that approvals still apply');
  assert.equal(connections.isLiveOnlyModelId('gemini-2.5-flash-native-audio-preview-12-2025'), true);
  assert.equal(connections.isLiveOnlyModelId('gemini-2.0-flash-live-001'), true);
  assert.equal(connections.isLiveOnlyModelId('gemini-2.5-flash'), false);
  assert.equal(connections.isLiveOnlyModelId('gemini-2.0-flash'), false);
  assert.equal(connections.isLiveOnlyModelId(''), false);
  // PSID cookies are browser sessions, not OAuth tokens — misusing one as
  // Bearer caused a 401 that flipped the UI to "disconnected" on first chat.
  assert.equal(connections.isWebSessionOnlyToken('ya29.valid-looking-token'), false);
  assert.equal(connections.isWebSessionOnlyToken('g.a000random-psid-cookie-value-xyz'), true);
  assert.equal(connections.isWebSessionOnlyToken(''), false);
  // Only dead sessions expire the UI; config problems keep it.
  assert.equal(connections.isSessionExpiredError('chatgpt', 'TOKEN_EXPIRED'), true);
  assert.equal(connections.isSessionExpiredError('chatgpt', 'CHATGPT_WEB_FAILED: HTTP_401 boom'), true);
  assert.equal(connections.isSessionExpiredError('chatgpt', 'CHATGPT_WEB_FAILED: HTTP_500 boom'), false);
  assert.equal(connections.isSessionExpiredError('gemini', 'GEMINI_WEB_FAILED: GEMINI_HTTP_401 bad', 'bearer'), true);
  assert.equal(connections.isSessionExpiredError('gemini', 'GEMINI_WEB_FAILED: GEMINI_HTTP_401 bad', 'key'), false);
  assert.equal(connections.isSessionExpiredError('gemini', 'GEMINI_WEB_FAILED: GEMINI_HTTP_404 gone', 'key'), false);
  assert.equal(connections.isSessionExpiredError('gemini', 'GEMINI_KEY_REQUIRED: add a key'), false);
  console.log('ok - Gemini auth resolution prefers API keys and routes honestly without credentials');
})().catch((error) => { console.error(error); process.exitCode = 1; });
