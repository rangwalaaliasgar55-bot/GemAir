'use strict';
/**
 * Bridge SocialBot-style PKCE logins into GemAir connections store.
 * Call from main process only (safeStorage).
 */
const connections = require('./connections');

async function loginChatGPTViaPkce(openBrowser) {
  const { loginChatGPT } = require('./oauth-chatgpt-pkce');
  const tokens = await loginChatGPT({ openBrowser });
  if (!tokens || !tokens.access_token) {
    return { error: 'NO_TOKEN', message: 'ChatGPT PKCE returned no access_token' };
  }
  const expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
  return connections.setChatGPTConnection({
    email: 'chatgpt-oauth',
    plan: 'oauth',
    sessionToken: tokens.access_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || '',
    expiresAt
  });
}

async function loginGeminiViaPkce(openBrowser) {
  const { loginGemini } = require('./oauth-gemini-pkce');
  const tokens = await loginGemini({ openBrowser });
  if (!tokens || !tokens.access_token) {
    return { error: 'NO_TOKEN', message: 'Gemini PKCE returned no access_token' };
  }
  return connections.setGeminiConnection({
    email: 'gemini-oauth',
    plan: 'oauth',
    psid: tokens.access_token,
    psidts: tokens.refresh_token || ''
  });
}

module.exports = { loginChatGPTViaPkce, loginGeminiViaPkce };
