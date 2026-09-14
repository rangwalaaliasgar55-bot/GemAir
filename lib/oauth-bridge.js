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

/**
 * Google sign-in for Gemini.
 *
 * Sign-in proves identity; it does NOT, by itself, buy API access — Google
 * only accepts the Generative Language scope for a verified OAuth client, and
 * GemAir ships the identity-only scopes so sign-in works for everyone (see
 * lib/oauth-gemini-pkce.js). The previous version stored the token and reported
 * a connected account, which is exactly how "Gemini shows green then every
 * message fails" happened.
 *
 * Now: sign in → PROBE the token against the model endpoint → store only what
 * is true. A usable token becomes a working brain; an identity-only session is
 * stored (so the account email is shown and the state survives) but is reported
 * as `needsApiKey`, and the hub marks the row ATTENTION with a one-click path to
 * a free AI Studio key instead of pretending.
 */
async function loginGeminiViaPkce(openBrowser, options = {}) {
  const { loginGemini, probeGeminiToken, fetchGeminiIdentity } = require('./oauth-gemini-pkce');
  let tokens;
  try { tokens = await loginGemini({ openBrowser, ...(options.pkce || {}) }); }
  catch (error) {
    const message = String((error && error.message) || '');
    if ((error && error.code === 'GEMINI_OAUTH_CLIENT_MISSING') || /GEMAIR_GEMINI_CLIENT_ID|client_id/i.test(message)) {
      return {
        error: 'GEMINI_OAUTH_CLIENT_MISSING',
        message: 'Gemini sign-in is not configured on this install. That is optional: the fast path is Settings → AI & Connections → Gemini → paste a free AI Studio key (aistudio.google.com/apikey) — no client setup, no card. Advanced: create a Google OAuth Desktop client, add http://127.0.0.1:8766/callback, then set GEMAIR_GEMINI_CLIENT_ID before launching GemAir.'
      };
    }
    if (error && error.code === 'GEMINI_OAUTH_CANCELLED') return { error: 'GEMINI_OAUTH_CANCELLED', message: 'Gemini sign-in was cancelled. Nothing was stored.' };
    if (error && error.code === 'GEMINI_CALLBACK_PORT_IN_USE') return { error: 'GEMINI_CALLBACK_PORT_IN_USE', message: 'Another Gemini sign-in window is still waiting on port 8766. Close it and press Connect Gemini again.' };
    return { error: 'GEMINI_OAUTH_FAILED', message: message || 'Gemini OAuth failed.' };
  }
  if (!tokens || !tokens.access_token) return { error: 'NO_TOKEN', message: 'Gemini PKCE returned no access_token' };

  let email = tokens.email || '';
  if (!email) email = (await fetchGeminiIdentity(tokens.access_token, options.fetch)).email || '';
  if (!email) email = 'gemini-oauth';

  const stored = connections.setGeminiConnection({
    email,
    plan: 'oauth',
    psid: tokens.access_token,
    psidts: tokens.refresh_token || ''
  });
  if (stored && stored.error) return stored;

  // Probe before declaring success. Only a token that can generate is a brain.
  const probe = options.skipProbe ? { ok: true } : await probeGeminiToken(tokens.access_token, options.fetch);
  if (!probe.ok) {
    return {
      ok: true,
      linked: true,
      needsApiKey: true,
      email,
      status: stored,
      message: 'Signed in to Google. Google does not let an identity-only token call the Gemini API, so paste your free AI Studio key to finish (aistudio.google.com/apikey). Your Google sign-in is kept.',
      probeError: probe.message
    };
  }
  return { ok: true, linked: true, email, models: stored && stored.gemini ? [stored.gemini.selectedModel] : [], status: stored };
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
    if (!Array.isArray(models) || !models.length) {
      // An empty list is not "no models needed": OpenAI gates the model set on
      // the client version it sees, so a stale GEMAIR_CHATGPT_CLIENT_VERSION (or
      // a changed /models shape) reads as an empty account. Say so, and keep the
      // default slug usable rather than leaving the picker blank.
      return {
        ok: true,
        empty: true,
        models: [],
        selectedModel: status.chatgpt.selectedModel,
        message: 'OpenAI returned no models for this account. GemAir will keep using the built-in default. If your account can chat but the picker stays empty, a newer Codex client version usually fixes it: set GEMAIR_CHATGPT_CLIENT_VERSION (advanced) and press Refresh models again.'
      };
    }
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
