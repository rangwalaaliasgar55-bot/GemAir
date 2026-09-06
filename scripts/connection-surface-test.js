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

for (const channel of ['connections:oauthChatGPT', 'connections:oauthGemini', 'connections:getStatus', 'connections:chatStream', 'connections:disconnect']) {
  assert(main.includes(`ipcMain.handle('${channel}'`), `missing main handler: ${channel}`);
}
assert(preload.includes("connectionsOauthChatGPT: () => ipcRenderer.invoke('connections:oauthChatGPT')"), 'ChatGPT OAuth preload bridge missing');
assert(preload.includes("connectionsOauthGemini: () => ipcRenderer.invoke('connections:oauthGemini')"), 'Gemini OAuth preload bridge missing');
assert(renderer.includes('async connectionsOauthChatGPT()'), 'ChatGPT renderer bridge missing');
assert(renderer.includes('async connectionsOauthGemini()'), 'Gemini renderer bridge missing');
assert(renderer.includes('Opening secure OAuth sign-in'), 'renderer does not use secure OAuth flow');
assert(bridge.includes('CHATGPT_OAUTH_CLIENT_REJECTED'), 'ChatGPT OAuth rejection is not explained');
assert(bridge.includes('CHATGPT_OAUTH_CLIENT_REQUIRED'), 'ChatGPT missing OAuth client is not explained');
assert(bridge.includes('GEMINI_OAUTH_CLIENT_MISSING'), 'Gemini OAuth configuration failure is not explained');
assert(bridge.includes('setChatGPTConnection') && bridge.includes('setGeminiConnection'), 'OAuth bridge does not persist both providers');
assert(store.includes('safeStorage.encryptString'), 'connection store is not encrypted');
assert(store.includes('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'), 'Gemini official API route missing');
assert(!read('lib/oauth-gemini-pkce.js').includes('generative-language.retriever'), 'unsupported Gemini retriever scope is still requested');
assert(!read('lib/oauth-gemini-pkce.js').includes('auth/generative-language'), 'generative-language OAuth scope is still requested (Google rejects it with invalid_scope)');
assert(store.includes('apiKeyEnc'), 'Gemini AI Studio key is not stored encrypted');
assert(main.includes('connections.getDecryptedTokens(provider)'), 'connected brain does not read encrypted tokens');
assert(main.includes("if (stored.chatgpt && stored.chatgpt.connected) return { connectedProvider: 'chatgpt' }"), 'ChatGPT is not primary for desktop agent resolution');
assert(main.includes("if (stored.gemini && stored.gemini.connected) return { connectedProvider: 'gemini' }"), 'Gemini is not primary for desktop agent resolution');
assert(main.includes("ipcMain.handle('connections:importCodex'"), 'Codex import IPC handler is missing');
assert(preload.includes("connectionsImportCodex: () => ipcRenderer.invoke('connections:importCodex')"), 'Codex import preload bridge is missing');
assert(renderer.includes('async connectionsImportCodex()'), 'Codex import renderer bridge is missing');
assert(renderer.includes('handleImportCodex'), 'Codex import handler is missing');
const codex = read('lib/codex-auth-import.js');
assert(!/require\(['"]child_process['"]\)/.test(codex) && !/\bspawn\s*\(|\bexecFile\s*\(|\bexecSync\s*\(/.test(codex), 'Codex import must never download or execute third-party code');
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
  assert.ok(fakeFetch.seen.url.includes('?key=AIzaTestKey1234567890'), 'key mode must use ?key=, got: ' + fakeFetch.seen.url);
  assert.ok(!fakeFetch.seen.options.headers.Authorization, 'key mode must not send an Authorization header');
  await connections.callGeminiWeb({ psid: 'ya29.valid-looking-token-string-here', messages: [{ role: 'user', content: 'hi' }], fetchFn: fakeFetch });
  assert.ok(String(fakeFetch.seen.options.headers.Authorization || '').startsWith('Bearer '), 'bearer fallback must send the OAuth token');
  await assert.rejects(
    connections.callGeminiWeb({ messages: [{ role: 'user', content: 'hi' }], fetchFn: fakeFetch }),
    /GEMINI_KEY_REQUIRED/,
    'missing credentials must fail with an actionable error'
  );
  console.log('ok - Gemini auth resolution prefers API keys and routes honestly without credentials');
})().catch((error) => { console.error(error); process.exitCode = 1; });
