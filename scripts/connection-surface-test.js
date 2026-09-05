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
assert(bridge.includes('setChatGPTConnection') && bridge.includes('setGeminiConnection'), 'OAuth bridge does not persist both providers');
assert(store.includes('safeStorage.encryptString'), 'connection store is not encrypted');
assert(store.includes('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'), 'Gemini official API route missing');
assert(main.includes('connections.getDecryptedTokens(provider)'), 'connected brain does not read encrypted tokens');
console.log('ok - ChatGPT and Gemini OAuth, encrypted storage, IPC, and provider routing contracts');
