#!/usr/bin/env node
/**
 * Patch main.js to register PKCE OAuth IPC handlers if missing.
 */
const fs = require('fs');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'main.js');
let text = fs.readFileSync(mainPath, 'utf8');
if (text.includes('connections:oauthChatGPT')) {
  console.log('oauth IPC already present');
  process.exit(0);
}

const ipcBlock = text.indexOf("ipcMain.handle('connections:");
if (ipcBlock < 0) {
  console.error('no connections ipc');
  process.exit(1);
}

const inject = `
  // Stonic-style OAuth PKCE (browser login, no API key paste)
  ipcMain.handle('connections:oauthChatGPT', async () => {
    try {
      const { shell } = require('electron');
      const { loginChatGPTViaPkce } = require('./lib/oauth-bridge');
      return await loginChatGPTViaPkce((url) => shell.openExternal(url));
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });
  ipcMain.handle('connections:oauthGemini', async () => {
    try {
      const { shell } = require('electron');
      const { loginGeminiViaPkce } = require('./lib/oauth-bridge');
      return await loginGeminiViaPkce((url) => shell.openExternal(url));
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });

`;

text = text.slice(0, ipcBlock) + inject + text.slice(ipcBlock);
fs.writeFileSync(mainPath, text);
console.log('oauth IPC injected into main.js');
