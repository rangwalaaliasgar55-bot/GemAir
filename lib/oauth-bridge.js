/**
 * Main-process account bridge.
 *
 * ChatGPT's primary path is OpenAI's device-code sign-in through the
 * MIT-licensed @opencoredev/loginwithchatgpt-core SDK. Tokens never cross IPC:
 * this module immediately moves them into Electron safeStorage and only
 * returns public profile/model metadata. Legacy loopback, browser-session and
 * local Codex imports remain available as explicit fallbacks.
 */
'use strict';

const connections = require('./connections');
const chatgptCodex = require('./chatgpt-codex');

const chatgptDeviceLogin = chatgptCodex.createDeviceLoginManager();

function publicAuthError(error, fallbackCode) {
  const code = error && error.code ? String(error.code) : fallbackCode;
  const status = error && error.status ? ` (${error.status})` : '';
  return {
    error: code,
    message: String((error && error.message) || fallbackCode) + status
  };
}

/**
 * Pure helper: trim transport whitespace off tokens; if the refresh token is
 * present but malformed, drop it (keeping a working session without
 * auto-refresh) instead of failing the whole sign-in. Returns
 * { tokens, refreshWarning }. Unit-tested.
 */
function downgradeUnusableRefresh(tokens) {
  const clean = { ...(tokens || {}) };
  for (const key of ['accessToken', 'refreshToken', 'idToken', 'sessionToken']) {
    if (typeof clean[key] === 'string') clean[key] = clean[key].trim();
  }
  const refresh = typeof clean.refreshToken === 'string' ? clean.refreshToken : '';
  if (refresh && !connections.isValidToken(refresh)) {
    clean.refreshToken = '';
    return {
      tokens: clean,
      refreshWarning: `Signed in, but OpenAI's refresh token was unusable (${connections.tokenShape(refresh)}) — auto-refresh is off; reconnect when the session expires.`
    };
  }
  return { tokens: clean, refreshWarning: '' };
}

async function persistChatGPTTokens(tokens, user, authMode) {
  const metadata = chatgptCodex.deriveTokenMetadata(tokens.accessToken, tokens.idToken);
  const accountId = tokens.accountId || (user && user.accountId) || metadata.accountId || '';
  if (!accountId) return { error: 'CHATGPT_ACCOUNT_ID_MISSING', message: 'OpenAI did not return a ChatGPT account id. Start sign-in again.' };
  // A malformed REFRESH token alone must not kill an otherwise good sign-in:
  // OpenAI sometimes withholds a usable one on this flow. Keep the session
  // without auto-refresh and say so plainly, instead of failing everything.
  const sanitized = downgradeUnusableRefresh(tokens);
  const stored = connections.setChatGPTConnection({
    email: (user && (user.email || user.name)) || metadata.email || 'ChatGPT user',
    plan: (user && user.plan) || metadata.plan || 'free',
    sessionToken: sanitized.tokens.accessToken,
    accessToken: sanitized.tokens.accessToken,
    refreshToken: sanitized.tokens.refreshToken || '',
    idToken: sanitized.tokens.idToken || '',
    accountId,
    authMode: authMode || 'codex-oauth',
    expiresAt: tokens.expiresAt || metadata.expiresAt || Date.now() + 3600 * 1000
  });
  if (stored && stored.error) return stored;

  // Model availability belongs to the account/plan and moves over time. Fetch
  // it instead of hardcoding a slug; a model-list outage never discards a
  // successfully stored login.
  let models = [];
  let modelWarning = '';
  try {
    models = await chatgptCodex.listModels({ accessToken: sanitized.tokens.accessToken, idToken: sanitized.tokens.idToken, accountId });
    connections.updateChatGPTModels(models);
  } catch (error) {
    modelWarning = error.message || String(error);
  }
  const status = connections.getSanitizedStatus();
  const warning = [sanitized.refreshWarning, modelWarning].filter(Boolean).join(' ');
  return {
    ok: true,
    status: 'authenticated',
    user: {
      email: status.chatgpt.email,
      plan: status.chatgpt.plan
    },
    models: status.chatgpt.availableModels,
    selectedModel: status.chatgpt.selectedModel,
    warning: warning || undefined
  };
}

async function startChatGPTDeviceLogin() {
  try {
    return { ok: true, ...(await chatgptDeviceLogin.begin()) };
  } catch (error) {
    return publicAuthError(error, 'CHATGPT_DEVICE_LOGIN_FAILED');
  }
}

async function pollChatGPTDeviceLogin(loginId) {
  try {
    const result = await chatgptDeviceLogin.poll(loginId);
    if (result.status !== 'authenticated') return result;
    return persistChatGPTTokens(result.tokens, result.user, 'codex-oauth');
  } catch (error) {
    return publicAuthError(error, 'CHATGPT_DEVICE_LOGIN_FAILED');
  }
}

function cancelChatGPTDeviceLogin(loginId) {
  return chatgptDeviceLogin.cancel(loginId);
}

async function loginChatGPTViaPkce(openBrowser) {
  const { loginChatGPT } = require('./oauth-chatgpt-pkce');
  let tokens;
  try { tokens = await loginChatGPT({ openBrowser }); }
  catch (error) {
    if (/invalid_authorize_request|invalid.*client|unauthorized_client|missing_required_parameter/i.test(error.message || '')) return { error: 'CHATGPT_OAUTH_CLIENT_REJECTED', message: 'OpenAI rejected loopback sign-in. Use the device-code Connect button instead.' };
    return { error: 'CHATGPT_OAUTH_FAILED', message: error.message || 'ChatGPT OAuth failed.' };
  }
  if (!tokens || !tokens.access_token) return { error: 'NO_TOKEN', message: 'ChatGPT PKCE returned no access_token' };
  const metadata = chatgptCodex.deriveTokenMetadata(tokens.access_token, tokens.id_token);
  return persistChatGPTTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || '',
    idToken: tokens.id_token || '',
    accountId: metadata.accountId,
    expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000
  }, metadata, 'codex-oauth');
}

async function loginGeminiViaPkce(openBrowser) {
  const { loginGemini } = require('./oauth-gemini-pkce');
  let tokens;
  try { tokens = await loginGemini({ openBrowser }); }
  catch (error) {
    if (/GEMAIR_GEMINI_CLIENT_ID|client_id/i.test(error.message || '')) return { error: 'GEMINI_OAUTH_CLIENT_MISSING', message: 'Gemini OAuth is not configured. Create a Google OAuth Desktop client, add http://127.0.0.1:8766/callback, then set GEMAIR_GEMINI_CLIENT_ID before launching GemAir.' };
    return { error: 'GEMINI_OAUTH_FAILED', message: error.message || 'Gemini OAuth failed.' };
  }
  if (!tokens || !tokens.access_token) return { error: 'NO_TOKEN', message: 'Gemini PKCE returned no access_token' };
  return connections.setGeminiConnection({
    email: 'gemini-oauth',
    plan: 'oauth',
    psid: tokens.access_token,
    psidts: tokens.refresh_token || ''
  });
}

async function importChatGPTFromCodex() {
  const { importChatGPTFromCodex: importTokens } = require('./codex-auth-import');
  return importTokens();
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;
let refreshInFlight = null;

/**
 * Refresh rotation is single-flight. OpenAI may rotate refresh tokens, so two
 * concurrent callers must never race and invalidate the newly issued token.
 */
async function checkAndRefreshChatGPT(opts = {}) {
  if (refreshInFlight && !opts.store && !opts.fetchFn && !Number.isFinite(opts.nowMs)) return refreshInFlight;
  const operation = (async () => {
    const store = opts.store || connections;
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const tokens = store.getDecryptedTokens('chatgpt');
    if (!tokens || !tokens.accessToken) return { refreshed: false, reason: 'NO_SESSION' };
    if (!tokens.refreshToken) return { refreshed: false, reason: 'NO_REFRESH_TOKEN' };
    if (tokens.expiresAt && tokens.expiresAt - nowMs > REFRESH_SKEW_MS) return { refreshed: false, reason: 'NOT_DUE' };

    try {
      const sdk = await chatgptCodex.loadSdk();
      const config = chatgptCodex.sdkConfig(sdk, opts.fetchFn);
      const fresh = await sdk.refreshTokens(config, tokens.refreshToken);
      const metadata = chatgptCodex.deriveTokenMetadata(fresh.accessToken, fresh.idToken);
      const result = store.setChatGPTConnection({
        email: metadata.email || tokens.email,
        plan: metadata.plan || tokens.plan,
        sessionToken: fresh.accessToken,
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || tokens.refreshToken,
        idToken: fresh.idToken || tokens.idToken,
        accountId: fresh.accountId || metadata.accountId || tokens.accountId,
        authMode: tokens.authMode || 'codex-oauth',
        expiresAt: fresh.expiresAt || Date.now() + 3600 * 1000
      });
      if (result && result.error) return { refreshed: false, code: result.error, message: result.message };
      return { refreshed: true };
    } catch (error) {
      const code = error && error.code === 'refresh_token_invalid' ? 'REFRESH_UNAUTHORIZED' : (error.code || 'REFRESH_FAILED');
      return { refreshed: false, code, message: error.message || String(error) };
    }
  })();
  if (!opts.store && !opts.fetchFn && !Number.isFinite(opts.nowMs)) {
    refreshInFlight = operation.finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }
  return operation;
}

async function refreshChatGPTModels() {
  try {
    await checkAndRefreshChatGPT();
    const tokens = connections.getDecryptedTokens('chatgpt');
    if (!tokens || !tokens.accessToken) return { error: 'NO_CHATGPT_SESSION' };
    if (!tokens.accountId) return { error: 'CHATGPT_ACCOUNT_ID_MISSING', message: 'Reconnect using device sign-in to enable account model discovery.' };
    const models = await chatgptCodex.listModels(tokens);
    const status = connections.updateChatGPTModels(models);
    if (status && status.error) return status;
    return { ok: true, models: status.chatgpt.availableModels, selectedModel: status.chatgpt.selectedModel };
  } catch (error) {
    return publicAuthError(error, 'CHATGPT_MODELS_FAILED');
  }
}

module.exports = {
  startChatGPTDeviceLogin,
  pollChatGPTDeviceLogin,
  cancelChatGPTDeviceLogin,
  loginChatGPTViaPkce,
  loginGeminiViaPkce,
  importChatGPTFromCodex,
  persistChatGPTTokens,
  downgradeUnusableRefresh,
  checkAndRefreshChatGPT,
  refreshChatGPTModels,
  REFRESH_SKEW_MS
};
