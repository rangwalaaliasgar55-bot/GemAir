#!/usr/bin/env node
'use strict';
/** node scripts/oauth-login.js chatgpt|gemini */
const provider = process.argv[2] || 'chatgpt';
const { exec } = require('child_process');
const open = (url) => {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd);
};

(async () => {
  if (provider === 'chatgpt') {
    const { loginChatGPT } = require('../lib/oauth-chatgpt-pkce');
    const tokens = await loginChatGPT({ openBrowser: open });
    console.log(JSON.stringify({
      ok: true,
      provider: 'chatgpt',
      has_access: !!tokens.access_token,
      has_refresh: !!tokens.refresh_token,
      expires_in: tokens.expires_in
    }, null, 2));
    console.log('Store tokens via app Connections UI or connections.setChatGPTConnection in main process.');
  } else if (provider === 'gemini') {
    const { loginGemini } = require('../lib/oauth-gemini-pkce');
    const tokens = await loginGemini({ openBrowser: open });
    console.log(JSON.stringify({
      ok: true,
      provider: 'gemini',
      has_access: !!tokens.access_token,
      has_refresh: !!tokens.refresh_token,
      expires_in: tokens.expires_in
    }, null, 2));
  } else {
    console.error('Usage: node scripts/oauth-login.js chatgpt|gemini');
    process.exit(1);
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
