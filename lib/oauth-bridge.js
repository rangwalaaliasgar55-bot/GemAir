'use strict';
/**
 * Bridge SocialBot-style PKCE logins into GemAir connections store.
 * Call from main process only (safeStorage).
 */
const connections = require('./connections');

async function loginChatGPTViaPkce(openBrowser) {
  const { loginChatGPT } = require('./oauth-chatgpt-pkce');
  let tokens;
  try { tokens = await loginChatGPT({ openBrowser }); }
  catch (error) {
    if (/CHATGPT_OAUTH_CLIENT_REQUIRED/i.test(error.message || '')) return { error: 'CHATGPT_OAUTH_CLIENT_REQUIRED', message: 'ChatGPT account OAuth requires an OpenAI-approved client configured by the operator. A free ChatGPT account does not provide a public third-party API connection by default.' };
    if (/invalid_authorize_request|invalid.*client|unauthorized_client/i.test(error.message || '')) return { error: 'CHATGPT_OAUTH_CLIENT_REJECTED', message: 'OpenAI rejected this OAuth client. A free ChatGPT account cannot be connected through an unapproved third-party OAuth client.' };
    return { error: 'CHATGPT_OAUTH_FAILED', message: error.message || 'ChatGPT OAuth failed.' };
  }
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
  let tokens;
  try { tokens = await loginGemini({ openBrowser }); }
  catch (error) {
    if (/GEMAIR_GEMINI_CLIENT_ID|client_id/i.test(error.message || '')) return { error: 'GEMINI_OAUTH_CLIENT_MISSING', message: 'Gemini OAuth is not configured. Create a Google OAuth Desktop client, add http://127.0.0.1:8766/callback, then set GEMAIR_GEMINI_CLIENT_ID before launching GemAir.' };
    return { error: 'GEMINI_OAUTH_FAILED', message: error.message || 'Gemini OAuth failed.' };
  }
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
