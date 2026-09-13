/* ============================================================
   GemAir 2.7 — Account Connections Secure Store
   - ChatGPT device OAuth + account-backed Codex Responses (primary)
   - Local Codex import and legacy browser sessions (explicit fallbacks)
   - Main-process-only credentials encrypted with Electron safeStorage
   - Sanitized profile/model preferences exposed to the renderer
   - Gemini web/API-key compatibility retained
   ============================================================ */
'use strict';
const path = require('path');
const os = require('os');
const { readJsonRecovering, writeJsonAtomic, removeJsonStore } = require('./atomic-store');

// Electron 44 can try to download its runtime when `require('electron')` is
// evaluated from plain Node. Only load it inside Electron itself, or when a
// test has deliberately injected a cached bridge.
function loadElectronBridge() {
  try {
    const id = require.resolve('electron');
    if (!process.versions.electron && !require.cache[id]) return null;
    return require('electron');
  } catch { return null; }
}
const electronBridge = loadElectronBridge();
const safeStorage = electronBridge && electronBridge.safeStorage || null;
const userDataDir = electronBridge && electronBridge.app
  ? electronBridge.app.getPath('userData')
  : path.join(os.homedir(), '.gemair');

const CONNECTIONS_FILE = path.join(userDataDir, 'gemair-connections.enc');
const USAGE_FILE = path.join(userDataDir, 'gemair-usage.json');
const CONNECTION_STORE_LIMIT = 1024 * 1024;
const USAGE_STORE_LIMIT = 256 * 1024;
const CHATGPT_REQUEST_TIMEOUT_MS = 45 * 1000;

function encryptionAvailable() {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
    // Electron can fall back to Linux's `basic_text` backend when no secret
    // service is available. That backend is obfuscation, not credential-grade
    // encryption, so refuse account-token persistence rather than weakening
    // the product's encrypted-at-rest guarantee.
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
      && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch { return false; }
}

function encryptString(str) {
  if (!str) return '';
  if (!encryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
  return safeStorage.encryptString(String(str)).toString('base64');
}

function decryptString(b64) {
  if (!b64 || String(b64).endsWith(':fallback') || !encryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(String(b64), 'base64')); } catch { return ''; }
}

function isValidToken(token, { optional = false, allowExpired = false } = {}) {
  if (token == null || token === '') return optional;
  if (typeof token !== 'string' || token.length < 20 || token.length > 16384 || /[\s\0]/.test(token)) return false;
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      // An ID token is retained only for encrypted identity/account metadata;
      // unlike the access token it is never sent as bearer auth. OpenAI does
      // not always rotate it during refresh, so an expired but well-formed ID
      // token must not prevent a fresh access token from being persisted.
      if (!allowExpired && payload.exp != null && (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Date.now() / 1000)) return false;
    } catch { return false; }
  }
  return true;
}

/**
 * Safe shape descriptor for a token value — lengths and structure ONLY,
 * never content. Lets failures say WHAT was wrong (empty? too short?
 * whitespace? bad JWT?) without ever exposing secret material.
 */
function tokenShape(value) {
  if (value == null || value === '') return 'empty';
  if (typeof value !== 'string') return 'non-string:' + typeof value;
  if (/[\s\0]/.test(value)) return `len=${value.length},has-whitespace`;
  const parts = value.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload.exp != null && (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Date.now() / 1000)) return `len=${value.length},jwt-expired`;
      return `len=${value.length},jwt-ok`;
    } catch { return `len=${value.length},jwt-unparseable`; }
  }
  return `len=${value.length}`;
}

function emptyUsage() {
  const today = new Date().toISOString().slice(0, 10);
  return { chatgpt: { today: 0, date: today }, gemini: { today: 0, date: today } };
}
function readUsage() {
  const raw = readJsonRecovering(USAGE_FILE, emptyUsage(), { maxBytes: USAGE_STORE_LIMIT });
  const out = emptyUsage();
  for (const provider of ['chatgpt', 'gemini']) {
    const entry = raw[provider];
    if (!entry || typeof entry !== 'object') continue;
    out[provider] = {
      today: Math.max(0, Math.min(1000000, Number(entry.today) || 0)),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || '')) ? String(entry.date) : out[provider].date
    };
  }
  return out;
}
function writeUsage(usage) {
  return writeJsonAtomic(USAGE_FILE, usage, { maxBytes: USAGE_STORE_LIMIT });
}

function incUsage(provider) {
  const u = readUsage();
  const today = new Date().toISOString().slice(0,10);
  if (!u[provider]) u[provider] = { today: 0, date: today };
  if (u[provider].date !== today) { u[provider].today = 0; u[provider].date = today; }
  u[provider].today = (u[provider].today || 0) + 1;
  writeUsage(u);
  return u[provider].today;
}

const CHATGPT_DEFAULT_MODEL = 'gpt-5.5';
const CHATGPT_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
const CHATGPT_SERVICE_TIERS = new Set(['auto', 'default', 'flex', 'priority', 'fast']);
const EMPTY = {
  chatgpt: null,
  gemini: null,
  meta: { warningAcknowledged: false, priority: 'chatgpt' }
};

function encryptedField(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= 32768 && /^[A-Za-z0-9+/=]+$/.test(text) ? text : '';
}
function cleanIdentityText(value, max) {
  return String(value || '').replace(/[\0\r\n]/g, ' ').slice(0, max);
}
function cleanModelId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9._:/-]{1,160}$/.test(text) ? text : '';
}
function cleanModelList(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const model = cleanModelId(item);
    if (model && !seen.has(model)) { seen.add(model); out.push(model); }
    if (out.length >= 100) break;
  }
  return out;
}
function cleanAuthMode(value) {
  return ['codex-oauth', 'codex-import', 'web-session'].includes(value) ? value : 'web-session';
}
function readConnectionsRaw() {
  const data = readJsonRecovering(CONNECTIONS_FILE, EMPTY, { maxBytes: CONNECTION_STORE_LIMIT });
  const priority = data.meta && ['chatgpt', 'gemini', 'free'].includes(data.meta.priority) ? data.meta.priority : EMPTY.meta.priority;
  const raw = {
    chatgpt: null,
    gemini: null,
    meta: { warningAcknowledged: !!(data.meta && data.meta.warningAcknowledged === true), priority }
  };
  if (data.chatgpt && typeof data.chatgpt === 'object') {
    const accessTokenEnc = encryptedField(data.chatgpt.accessTokenEnc);
    if (accessTokenEnc) raw.chatgpt = {
      email: cleanIdentityText(data.chatgpt.email, 254),
      plan: cleanIdentityText(data.chatgpt.plan, 50),
      sessionTokenEnc: encryptedField(data.chatgpt.sessionTokenEnc),
      accessTokenEnc,
      refreshTokenEnc: encryptedField(data.chatgpt.refreshTokenEnc),
      idTokenEnc: encryptedField(data.chatgpt.idTokenEnc),
      accountIdEnc: encryptedField(data.chatgpt.accountIdEnc),
      authMode: cleanAuthMode(data.chatgpt.authMode),
      selectedModel: cleanModelId(data.chatgpt.selectedModel) || CHATGPT_DEFAULT_MODEL,
      availableModels: cleanModelList(data.chatgpt.availableModels),
      reasoningEffort: CHATGPT_REASONING_EFFORTS.has(data.chatgpt.reasoningEffort) ? data.chatgpt.reasoningEffort : 'medium',
      serviceTier: CHATGPT_SERVICE_TIERS.has(data.chatgpt.serviceTier) ? data.chatgpt.serviceTier : 'auto',
      expiresAt: Number(data.chatgpt.expiresAt) || 0,
      connectedAt: Number(data.chatgpt.connectedAt) || 0
    };
  }
  if (data.gemini && typeof data.gemini === 'object') {
    const psidEnc = encryptedField(data.gemini.psidEnc);
    if (psidEnc) raw.gemini = {
      email: cleanIdentityText(data.gemini.email, 254),
      plan: cleanIdentityText(data.gemini.plan, 50),
      psidEnc,
      psidtsEnc: encryptedField(data.gemini.psidtsEnc),
      apiKeyEnc: encryptedField(data.gemini.apiKeyEnc),
      connectedAt: Number(data.gemini.connectedAt) || 0
    };
  }
  return raw;
}
function writeConnectionsRaw(data) {
  return writeJsonAtomic(CONNECTIONS_FILE, data, { maxBytes: CONNECTION_STORE_LIMIT });
}

function getSanitizedStatus() {
  const raw = readConnectionsRaw();
  const usage = readUsage();
  const today = new Date().toISOString().slice(0,10);
  const mkUsage = (prov) => {
    const u = usage[prov];
    if (!u || u.date !== today) return 0;
    return u.today || 0;
  };
  const chatgptExpiry = Number(raw.chatgpt && raw.chatgpt.expiresAt) || 0;
  const chatgptCredentialPresent = !!(encryptionAvailable() && raw.chatgpt && raw.chatgpt.accessTokenEnc && !String(raw.chatgpt.accessTokenEnc).endsWith(':fallback'));
  const chatgptTokenState = !chatgptCredentialPresent ? 'missing'
    : chatgptExpiry && chatgptExpiry <= Date.now() ? 'expired'
    : chatgptExpiry && chatgptExpiry <= Date.now() + 5 * 60 * 1000 ? 'expiring'
    : 'ready';
  const status = {
    chatgpt: {
      connected: chatgptCredentialPresent && chatgptTokenState !== 'expired',
      email: raw.chatgpt ? raw.chatgpt.email : null,
      plan: raw.chatgpt ? raw.chatgpt.plan : null,
      authMode: raw.chatgpt ? raw.chatgpt.authMode : null,
      selectedModel: raw.chatgpt ? raw.chatgpt.selectedModel : CHATGPT_DEFAULT_MODEL,
      availableModels: raw.chatgpt ? raw.chatgpt.availableModels : [],
      reasoningEffort: raw.chatgpt ? raw.chatgpt.reasoningEffort : 'medium',
      serviceTier: raw.chatgpt ? raw.chatgpt.serviceTier : 'auto',
      refreshable: !!(raw.chatgpt && raw.chatgpt.refreshTokenEnc),
      tokenState: chatgptTokenState,
      expiresAt: chatgptExpiry || null,
      needsRefresh: chatgptTokenState === 'expiring' || chatgptTokenState === 'expired',
      dot: chatgptTokenState === 'ready' || chatgptTokenState === 'expiring' ? 'CONNECTED' : 'DISCONNECTED',
      experimental: chatgptCredentialPresent && chatgptTokenState !== 'expired',
      usage: mkUsage('chatgpt')
    },
    gemini: {
      connected: !!(encryptionAvailable() && raw.gemini && raw.gemini.psidEnc && !String(raw.gemini.psidEnc).endsWith(':fallback')),
      email: raw.gemini ? raw.gemini.email : null,
      plan: raw.gemini ? raw.gemini.plan : null,
      keyConfigured: !!(raw.gemini && raw.gemini.apiKeyEnc),
      dot: encryptionAvailable() && raw.gemini && raw.gemini.psidEnc && !String(raw.gemini.psidEnc).endsWith(':fallback') ? 'CONNECTED' : 'DISCONNECTED',
      experimental: !!(encryptionAvailable() && raw.gemini && raw.gemini.psidEnc && !String(raw.gemini.psidEnc).endsWith(':fallback')),
      usage: mkUsage('gemini')
    },
    freeCore: {
      connected: true,
      dot: 'FALLBACK',
      usage: 0
    },
    meta: raw.meta
  };
  // map dot to color semantics for UI
  status.chatgpt.dotColor = status.chatgpt.connected ? (status.chatgpt.experimental ? 'amber' : 'green') : 'gray';
  status.gemini.dotColor = status.gemini.connected ? (status.gemini.experimental ? 'amber' : 'green') : 'gray';
  status.freeCore.dotColor = 'blue';
  return status;
}

function setChatGPTConnection({
  email, plan, sessionToken, accessToken, refreshToken, idToken, accountId,
  authMode, selectedModel, availableModels, reasoningEffort, serviceTier, expiresAt
}) {
  if (!encryptionAvailable()) return { error: 'ENCRYPTION_UNAVAILABLE', message: 'Secure credential storage is unavailable on this system.' };
  // Tokens arrive from browsers, CLIs and copy-paste: stray surrounding
  // whitespace is a transport artifact, never part of a real token. Trim
  // first so a pasted/trailing newline can't fail an otherwise good sign-in.
  const cleanToken = (value) => (typeof value === 'string' ? value.trim() : value);
  accessToken = cleanToken(accessToken);
  sessionToken = cleanToken(sessionToken);
  refreshToken = cleanToken(refreshToken);
  idToken = cleanToken(idToken);
  const badField = !isValidToken(accessToken) ? 'accessToken'
    : !isValidToken(sessionToken, { optional: true }) ? 'sessionToken'
    : !isValidToken(refreshToken, { optional: true }) ? 'refreshToken'
    : !isValidToken(idToken, { optional: true, allowExpired: true }) ? 'idToken' : '';
  if (badField) return { error: 'INVALID_TOKEN', field: badField, message: `OpenAI returned an unusable ${badField} (${tokenShape(badField === 'accessToken' ? accessToken : badField === 'sessionToken' ? sessionToken : badField === 'refreshToken' ? refreshToken : idToken)}) — please run sign-in again.` };
  const cleanAccountId = String(accountId || '').trim();
  if (cleanAccountId && (cleanAccountId.length > 512 || /[\s\0]/.test(cleanAccountId))) return { error: 'INVALID_ACCOUNT_ID' };
  const expiry = Number(expiresAt) || Date.now() + 14 * 24 * 3600000;
  if (expiry <= Date.now()) return { error: 'TOKEN_EXPIRED' };
  try {
    const raw = readConnectionsRaw();
    const previous = raw.chatgpt || {};
    const models = availableModels === undefined ? (previous.availableModels || []) : cleanModelList(availableModels);
    const requestedModel = cleanModelId(selectedModel) || previous.selectedModel || models[0] || CHATGPT_DEFAULT_MODEL;
    raw.chatgpt = {
      email: cleanIdentityText(email || previous.email || 'ChatGPT user', 254),
      plan: cleanIdentityText(plan || previous.plan || 'free', 50),
      sessionTokenEnc: sessionToken ? encryptString(sessionToken) : '',
      accessTokenEnc: encryptString(accessToken),
      refreshTokenEnc: refreshToken === undefined ? (previous.refreshTokenEnc || '') : (refreshToken ? encryptString(refreshToken) : ''),
      idTokenEnc: idToken === undefined ? (previous.idTokenEnc || '') : (idToken ? encryptString(idToken) : ''),
      accountIdEnc: accountId === undefined ? (previous.accountIdEnc || '') : (cleanAccountId ? encryptString(cleanAccountId) : ''),
      authMode: cleanAuthMode(authMode || previous.authMode),
      selectedModel: models.length && !models.includes(requestedModel) ? models[0] : requestedModel,
      availableModels: models,
      reasoningEffort: CHATGPT_REASONING_EFFORTS.has(reasoningEffort) ? reasoningEffort : (previous.reasoningEffort || 'medium'),
      serviceTier: CHATGPT_SERVICE_TIERS.has(serviceTier) ? serviceTier : (previous.serviceTier || 'auto'),
      expiresAt: expiry,
      connectedAt: Number(previous.connectedAt) || Date.now()
    };
    if (!writeConnectionsRaw(raw)) return { error: 'SECURE_STORE_WRITE_FAILED' };
    return getSanitizedStatus();
  } catch (error) { return { error: error.message || 'SECURE_STORE_FAILED' }; }
}

function setChatGPTPreferences({ selectedModel, reasoningEffort, serviceTier }) {
  const raw = readConnectionsRaw();
  if (!raw.chatgpt) return { error: 'NO_CHATGPT_SESSION' };
  if (selectedModel !== undefined) {
    const model = cleanModelId(selectedModel);
    if (!model) return { error: 'INVALID_MODEL' };
    if (raw.chatgpt.availableModels.length && !raw.chatgpt.availableModels.includes(model)) return { error: 'MODEL_NOT_AVAILABLE' };
    raw.chatgpt.selectedModel = model;
  }
  if (reasoningEffort !== undefined) {
    if (!CHATGPT_REASONING_EFFORTS.has(reasoningEffort)) return { error: 'INVALID_REASONING_EFFORT' };
    raw.chatgpt.reasoningEffort = reasoningEffort;
  }
  if (serviceTier !== undefined) {
    if (!CHATGPT_SERVICE_TIERS.has(serviceTier)) return { error: 'INVALID_SERVICE_TIER' };
    raw.chatgpt.serviceTier = serviceTier;
  }
  if (!writeConnectionsRaw(raw)) return { error: 'SECURE_STORE_WRITE_FAILED' };
  return getSanitizedStatus();
}

function updateChatGPTModels(models) {
  const raw = readConnectionsRaw();
  if (!raw.chatgpt) return { error: 'NO_CHATGPT_SESSION' };
  raw.chatgpt.availableModels = cleanModelList(models);
  if (raw.chatgpt.availableModels.length && !raw.chatgpt.availableModels.includes(raw.chatgpt.selectedModel)) {
    raw.chatgpt.selectedModel = raw.chatgpt.availableModels[0];
  }
  if (!writeConnectionsRaw(raw)) return { error: 'SECURE_STORE_WRITE_FAILED' };
  return getSanitizedStatus();
}

function isValidApiKey(value) {
  const text = String(value || '').trim();
  return text.length >= 20 && text.length <= 256 && !/[\s\0]/.test(text) ? text : '';
}
function setGeminiConnection({ email, plan, psid, psidts, apiKey }) {
  if (!encryptionAvailable()) return { error: 'ENCRYPTION_UNAVAILABLE', message: 'Secure credential storage is unavailable on this system.' };
  if (typeof psid === 'string') psid = psid.trim();
  if (typeof psidts === 'string') psidts = psidts.trim();
  if (!isValidToken(psid) || !isValidToken(psidts, { optional: true })) return { error: 'INVALID_TOKEN', field: !isValidToken(psid) ? 'psid' : 'psidts' };
  try {
    const raw = readConnectionsRaw();
    const previousKeyEnc = raw.gemini ? raw.gemini.apiKeyEnc : '';
    raw.gemini = {
      email: String(email || 'unknown@gmail.com').slice(0, 254),
      plan: String(plan || 'free').slice(0, 50),
      psidEnc: encryptString(psid),
      psidtsEnc: psidts ? encryptString(psidts) : '',
      // An AI Studio key is optional and never wiped by a later OAuth login
      // that does not provide one.
      apiKeyEnc: apiKey !== undefined ? (isValidApiKey(apiKey) ? encryptString(isValidApiKey(apiKey)) : '') : (previousKeyEnc || ''),
      connectedAt: Number(raw.gemini && raw.gemini.connectedAt) || Date.now()
    };
    if (!writeConnectionsRaw(raw)) return { error: 'SECURE_STORE_WRITE_FAILED' };
    return getSanitizedStatus();
  } catch (error) { return { error: error.message || 'SECURE_STORE_FAILED' }; }
}

/**
 * Parse a pasted ChatGPT session JSON page (the free-chatgpt.js flow: log in
 * at chatgpt.com in your own browser, open /api/auth/session, copy the whole
 * JSON, paste it here). Shape: { user: { email }, accessToken, expires }.
 * Returns { email, plan, accessToken, refreshToken, expiresAt } or throws an
 * Error with a machine-readable message. Pure function — unit-tested.
 */
function parseChatGPTSessionJson(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    const err = new Error('SESSION_JSON_EMPTY');
    err.code = 'SESSION_JSON_EMPTY';
    throw err;
  }
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const err = new Error('SESSION_JSON_INVALID');
    err.code = 'SESSION_JSON_INVALID';
    throw err;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const err = new Error('SESSION_JSON_INVALID');
    err.code = 'SESSION_JSON_INVALID';
    throw err;
  }
  const accessToken = obj.accessToken || obj.access_token || '';
  if (!isValidToken(accessToken)) {
    const err = new Error('SESSION_JSON_NO_TOKEN');
    err.code = 'SESSION_JSON_NO_TOKEN';
    throw err;
  }
  const user = obj.user && typeof obj.user === 'object' ? obj.user : {};
  const email = cleanIdentityText(user.email || user.id || 'chatgpt_user', 254);
  const plan = cleanIdentityText(user.plan || 'free', 50);
  let expiresAt = 0;
  const parsed = Date.parse(obj.expires || '');
  if (Number.isFinite(parsed) && parsed > Date.now()) expiresAt = parsed;
  if (!expiresAt) expiresAt = Date.now() + 14 * 24 * 3600000;
  return {
    email,
    plan,
    accessToken,
    refreshToken: typeof (obj.refreshToken || obj.refresh_token) === 'string' ? (obj.refreshToken || obj.refresh_token) : '',
    expiresAt
  };
}

function clearConnection(provider) {
  const raw = readConnectionsRaw();
  if (provider === 'chatgpt') raw.chatgpt = null;
  if (provider === 'gemini') raw.gemini = null;
  if (provider === 'all') { raw.chatgpt = null; raw.gemini = null; }
  writeConnectionsRaw(raw);
  // also clear usage? no, keep usage
  return getSanitizedStatus();
}

function clearAllEncrypted() {
  removeJsonStore(CONNECTIONS_FILE);
  removeJsonStore(USAGE_FILE);
  return getSanitizedStatus();
}

function getDecryptedTokens(provider) {
  const raw = readConnectionsRaw();
  if (provider === 'chatgpt' && raw.chatgpt) {
    return {
      email: raw.chatgpt.email,
      plan: raw.chatgpt.plan,
      sessionToken: decryptString(raw.chatgpt.sessionTokenEnc),
      accessToken: decryptString(raw.chatgpt.accessTokenEnc),
      refreshToken: decryptString(raw.chatgpt.refreshTokenEnc),
      idToken: decryptString(raw.chatgpt.idTokenEnc),
      accountId: decryptString(raw.chatgpt.accountIdEnc),
      authMode: raw.chatgpt.authMode,
      selectedModel: raw.chatgpt.selectedModel,
      availableModels: raw.chatgpt.availableModels,
      reasoningEffort: raw.chatgpt.reasoningEffort,
      serviceTier: raw.chatgpt.serviceTier,
      expiresAt: raw.chatgpt.expiresAt
    };
  }
  if (provider === 'gemini' && raw.gemini) {
    return {
      email: raw.gemini.email,
      plan: raw.gemini.plan,
      psid: decryptString(raw.gemini.psidEnc),
      psidts: decryptString(raw.gemini.psidtsEnc),
      apiKey: decryptString(raw.gemini.apiKeyEnc)
    };
  }
  return null;
}

/**
 * Decide how a Gemini request authenticates. An AI Studio API key always
 * wins: it is the documented, reliable credential. The OAuth access token
 * is a fallback for identity-linked sessions. Returns { mode, apiKey, token }
 * where mode is 'key', 'bearer', or 'none'. Pure function — unit-tested.
 */
function resolveGeminiAuth(input = {}) {
  const apiKey = isValidApiKey(input.profileKey) || isValidApiKey(input.storedApiKey) || '';
  if (apiKey) return { mode: 'key', apiKey, token: '' };
  const token = typeof input.oauthToken === 'string' ? input.oauthToken : '';
  if (isValidToken(token)) return { mode: 'bearer', apiKey: '', token };
  return { mode: 'none', apiKey: '', token: '' };
}

function isTokenExpired(provider) {
  const raw = readConnectionsRaw();
  if (provider === 'chatgpt' && raw.chatgpt) {
    return Date.now() > (raw.chatgpt.expiresAt || 0);
  }
  return false;
}

/**
 * True for Gemini model IDs that ONLY work over the Live voice API
 * (bidirectional WebSocket streaming) and reject generateContent with
 * HTTP 400 — e.g. native-audio preview and *-live-* models. Sending one to
 * generateContent can never succeed, so callers must reroute or explain.
 * Pure function — unit-tested.
 */
function isLiveOnlyModelId(modelId) {
  return /native[\-_]?audio|[\-_]live[\-_]/i.test(String(modelId || ''));
}

/**
 * True when a stored "OAuth token" is actually a captured google.com PSID
 * browser-session cookie rather than a real OAuth access token (which always
 * starts with `ya29.`). PSIDs authorize gemini.google.com in a browser but
 * Google's API rejects them as Bearer — sending one only produces a 401
 * that looks like a dead session. Pure function — unit-tested.
 */
function isWebSessionOnlyToken(token) {
  const text = String(token || '');
  return text.length > 0 && !/^ya29\./.test(text);
}

/**
 * Decide whether a connected-brain chat failure means the stored session is
 * DEAD (UI should show expired + reconnect) or is a config/transient problem
 * (session stays, error is shown inline). Pure function — unit-tested.
 */
function isSessionExpiredError(provider, message, authMode) {
  const msg = String(message || '');
  // Transient transport/provider states are NEVER expiry: an empty turn, a
  // timeout, a rate limit, or a 5xx must retry — not wipe the stored session
  // and pop the reconnect modal. Checked FIRST so a message that mentions
  // both (e.g. "CODEX_EMPTY_RESPONSE ... unauthorized..." in a detail blob)
  // still retries instead of disconnecting a healthy account.
  if (/CODEX_EMPTY_RESPONSE|CODEX_EMPTY_STREAM|CODEX_INCOMPLETE|CODEX_REFUSED|CODEX_STREAM_ERROR|CHATGPT_REQUEST_TIMEOUT|CHATGPT_TOOL_LOOP_LIMIT|FREEGPT35_|REQUEST_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed/i.test(msg)) return false;
  if (/(?:HTTP_|CODEX_HTTP_|GEMINI_HTTP_)(408|409|425|429|500|502|503|504|529)\b/.test(msg)) return false;
  if (/TOKEN_EXPIRED|REFRESH_UNAUTHORIZED|refresh_token_invalid|invalid_grant|CODEX_UNAUTHORIZED/.test(msg)) return true;
  if (/(?:HTTP_|CODEX_HTTP_)40[13]\b|invalid_token|unauthorized/i.test(msg)) {
    // A 401 on an API key means a bad key (config), not a dead session.
    if (provider === 'gemini') return authMode === 'bearer';
    return true;
  }
  return false;
}

function acknowledgeWarning() {
  const raw = readConnectionsRaw();
  raw.meta.warningAcknowledged = true;
  writeConnectionsRaw(raw);
}

function setPriority(p) {
  const raw = readConnectionsRaw();
  if (['chatgpt','gemini','free'].includes(p)) {
    raw.meta.priority = p;
    writeConnectionsRaw(raw);
  }
  return getSanitizedStatus();
}

// ---------------------------------------------------------------------------
// ChatGPT Web Client — most stable open-source approach
// We implement a dual-path client:
// 1. OAuth Codex path (EvanZhouDev/openai-oauth) — POST to https://chatgpt.com/backend-api/codex/responses
//    Uses accessToken from OAuth, OpenAI-compatible, supports streaming, more stable than cookie scraping.
// 2. Legacy backend-api/conversation path (waylaidwanderer/node-chatgpt-api, acheong08/ChatGPT)
//    POST to https://chatgpt.com/backend-api/conversation with Bearer accessToken, SSE streaming.
//
// We try OAuth path first, fallback to legacy. Both use same session capture.
// ---------------------------------------------------------------------------
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random()*16|0;
    return (c==='x'?r:(r&0x3|0x8)).toString(16);
  });
}

async function fetchWithTimeout(input, init = {}, timeoutMs = CHATGPT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const upstream = init.signal;
  const abort = () => controller.abort(upstream && upstream.reason);
  if (upstream) {
    if (upstream.aborted) abort();
    else upstream.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('CHATGPT_REQUEST_TIMEOUT')), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener('abort', abort);
  }
}

async function fetchChatGPTSessionFromCookies(sessionCookies) {
  // sessionCookies is array of {name, value, domain}
  // Build cookie header
  const cookieStr = sessionCookies.map(c=>`${c.name}=${c.value}`).join('; ');
  try {
    const res = await fetch('https://chatgpt.com/api/auth/session', {
      headers: {
        'Cookie': cookieStr,
        'Accept': 'application/json',
        'Origin': 'https://chatgpt.com',
        'Referer': 'https://chatgpt.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) throw new Error('HTTP_'+res.status);
    const data = await res.json();
    return data; // { user: {email, ...}, accessToken, ... }
  } catch (e) {
    // try chat.openai.com
    try {
      const res2 = await fetch('https://chat.openai.com/api/auth/session', {
        headers: {
          'Cookie': cookieStr,
          'Accept': 'application/json',
          'Origin': 'https://chat.openai.com',
          'Referer': 'https://chat.openai.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        }
      });
      if (!res2.ok) throw new Error('HTTP_'+res2.status);
      return await res2.json();
    } catch (e2) {
      throw e;
    }
  }
}

async function callChatGPTWeb({ accessToken, messages, onDelta }) {
  // messages: OpenAI format
  // Try to use backend-api/conversation streaming
  const url = 'https://chatgpt.com/backend-api/conversation';
  const parentId = uuid();
  const convId = uuid();
  const body = {
    action: 'next',
    messages: messages.map((m,i)=>({
      id: uuid(),
      author: { role: m.role },
      content: { content_type: 'text', parts: [m.content] }
    })),
    parent_message_id: parentId,
    conversation_id: convId,
    model: 'auto',
    timezone_offset_min: new Date().getTimezoneOffset(),
    history_and_training_disabled: false
  };

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Origin': 'https://chatgpt.com',
        'Referer': 'https://chatgpt.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      throw new Error('HTTP_'+res.status+' '+txt.slice(0,200));
    }
    // SSE streaming
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()||'';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          // Different shapes: json.message.content.parts[0] or delta
          let delta = '';
          if (json.message && json.message.content && json.message.content.parts) {
            delta = json.message.content.parts[0] || '';
            // This is not delta but full content incremental; we need to diff
            // For simplicity, if full is prefix, send remainder
            if (delta.startsWith(full)) {
              const diff = delta.slice(full.length);
              if (diff) { full = delta; if (onDelta) onDelta(diff); }
            } else {
              // fallback: treat as delta
              full += delta;
              if (onDelta) onDelta(delta);
            }
          } else if (json.content) {
            delta = json.content;
            full += delta;
            if (onDelta) onDelta(delta);
          }
        } catch (e) {}
      }
    }
    return full;
  } catch (e) {
    throw e;
  }
}

// Gemini client against the official Generative Language endpoint.
// Prefers an AI Studio API key (?key=) — the documented credential that
// needs no OAuth scope. Falls back to the OAuth access token as Bearer.
// The model ID is caller-supplied (Settings shows only IDs the user's own
// key reports via ListModels); a 404 therefore means "retired model or
// disabled API", never a transport bug.
async function callGeminiWeb({ psid, psidts, apiKey, model, messages, onDelta, fetchFn }) {
  const doFetch = fetchFn || fetch;
  const auth = resolveGeminiAuth({ storedApiKey: apiKey, oauthToken: psid });
  if (auth.mode === 'none') throw new Error('GEMINI_KEY_REQUIRED');
  const modelId = String(model || '').trim() || 'gemini-2.5-flash';
  const contents = (messages || [])
    .filter((message) => message && typeof message.content === 'string')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));
  const system = contents.filter((entry) => entry.role === 'user').length
    ? contents
    : [{ role: 'user', parts: [{ text: 'You are Gem, a precise personal assistant.' }] }, ...contents];
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelId) + ':generateContent'
    + (auth.mode === 'key' ? '?key=' + encodeURIComponent(auth.apiKey) : '');
  const headers = { 'Content-Type': 'application/json' };
  if (auth.mode === 'bearer') headers['Authorization'] = 'Bearer ' + auth.token;
  const response = await doFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contents: system, generationConfig: { temperature: 0.3, maxOutputTokens: 1400 } })
  });
  if (!response.ok) {
    // Capture the FULL response body (capped): Google's error object names
    // the real cause (bad key, disabled API, unknown model) and never
    // contains our key, so it is safe to surface. `detail` carries the body;
    // the message keeps a short summary for toasts.
    let fullBody = '';
    try { fullBody = String(await response.text()).slice(0, 2000); } catch {}
    let summary = '';
    try {
      const errBody = JSON.parse(fullBody);
      if (errBody && errBody.error && errBody.error.message) summary = ': ' + String(errBody.error.message).slice(0, 220);
    } catch {}
    const makeError = (message) => {
      const err = new Error(message);
      err.status = response.status;
      err.detail = fullBody;
      return err;
    };
    if (response.status === 404) {
      throw makeError('GEMINI_HTTP_404: model "' + modelId + '" is retired/unknown or the Generative Language API is disabled' + (summary || ' — refresh the model list in Settings → Voice and pick an ID your key reports.'));
    }
    throw makeError('GEMINI_HTTP_' + response.status + summary);
  }
  const data = await response.json();
  const text = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
    .map((part) => part.text || '').join('').trim();
  if (!text) throw new Error('GEMINI_EMPTY_RESPONSE');
  if (onDelta) onDelta(text);
  return text;
}

// Adapter layer: inject TOOLS as JSON-in-prompt, parse tool-calls from plain text
function buildToolPrompt(tools) {
  const toolList = tools.map(t=>{
    const fn = t.function;
    return `- ${fn.name}: ${fn.description} | params: ${JSON.stringify(fn.parameters)}`;
  }).join('\n');
  return `\n\nYou have access to these TOOLS on the user's computer. To use a tool, you MUST output exactly:\n<<TOOL_CALL>>\n{"name": "tool_name", "arguments": {"param": "value"}}\n<</TOOL_CALL>>\nYou can call multiple tools sequentially, one per block. After tool results, continue answering.\n\nAvailable tools:\n${toolList}\n\nIf no tool needed, answer normally. For file/system actions, always explain what you will do first.\n`;
}

function parseToolCallsFromText(text) {
  const calls = [];
  const regex = /<<TOOL_CALL>>\s*([\s\S]*?)\s*<\/TOOL_CALL>>/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj.name) calls.push(obj);
    } catch (e) {
      // try to extract name/args via looser parse
      try {
        const nameMatch = m[1].match(/\"name\"\s*:\s*\"([^\"]+)\"/);
        const argsMatch = m[1].match(/\"arguments\"\s*:\s*(\{[\s\S]*\})/);
        if (nameMatch) {
          let args = {};
          if (argsMatch) { try { args = JSON.parse(argsMatch[1]); } catch {} }
          calls.push({ name: nameMatch[1], arguments: args });
        }
      } catch {}
    }
  }
  // Also support ```tool: {...}``` style
  const altRegex = /```(?:tool|json)?\s*\{\s*\"name\"\s*:\s*\"([^\"]+)\"[\s\S]*?```/gi;
  while ((m = altRegex.exec(text)) !== null) {
    try {
      const jsonStr = m[0].replace(/```(tool|json)?/i,'').replace(/```/,'').trim();
      const obj = JSON.parse(jsonStr);
      if (obj.name && !calls.find(c=>JSON.stringify(c)===JSON.stringify(obj))) calls.push(obj);
    } catch {}
  }
  return calls;
}

function stripToolCalls(text) {
  return String(text||'').replace(/<<TOOL_CALL>>[\s\S]*?<\/TOOL_CALL>>/gi, '').trim();
}

module.exports = {
  CONNECTIONS_FILE,
  encryptString,
  decryptString,
  readConnectionsRaw,
  writeConnectionsRaw,
  getSanitizedStatus,
  setChatGPTConnection,
  setChatGPTPreferences,
  updateChatGPTModels,
  setGeminiConnection,
  clearConnection,
  clearAllEncrypted,
  getDecryptedTokens,
  isValidToken,
  tokenShape,
  isValidApiKey,
  resolveGeminiAuth,
  isTokenExpired,
  isLiveOnlyModelId,
  isWebSessionOnlyToken,
  isSessionExpiredError,
  acknowledgeWarning,
  setPriority,
  incUsage,
  fetchChatGPTSessionFromCookies,
  parseChatGPTSessionJson,
  callChatGPTWeb,
  callGeminiWeb,
  buildToolPrompt,
  parseToolCallsFromText,
  stripToolCalls
};
