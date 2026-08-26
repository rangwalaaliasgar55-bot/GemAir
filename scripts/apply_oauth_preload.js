#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'preload.js');
let t = fs.readFileSync(p, 'utf8');
if (t.includes('connectionsOauthChatGPT')) {
  console.log('preload oauth already present');
  process.exit(0);
}
const needle = 'connectionsGetStatus:';
const i = t.indexOf(needle);
if (i < 0) { console.error('no connectionsGetStatus'); process.exit(1); }
const add = `  connectionsOauthChatGPT: () => ipcRenderer.invoke('connections:oauthChatGPT'),
  connectionsOauthGemini: () => ipcRenderer.invoke('connections:oauthGemini'),
  `;
t = t.slice(0, i) + add + t.slice(i);
fs.writeFileSync(p, t);
console.log('preload oauth exposed');
