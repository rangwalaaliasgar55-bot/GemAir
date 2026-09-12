'use strict';
/**
 * Optional import of ChatGPT tokens created OUTSIDE GemAir.
 *
 * If the user has already run the third-party Codex CLI login themselves,
 * its tokens live at ~/.codex/auth.json
 * (%USERPROFILE%\.codex\auth.json on Windows). GemAir never downloads,
 * installs, or executes that package — it only reads the token file the
 * user created, validates the contents, and stores them through the same
 * encrypted connections store as the built-in OAuth flow.
 *
 * Call from main process only (safeStorage).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const connections = require('./connections');
const chatgptCodex = require('./chatgpt-codex');

function codexAuthPath() {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

function pickTokens(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [obj];
  for (const key of ['tokens', 'auth', 'credentials', 'oauth', 'data']) {
    if (obj[key] && typeof obj[key] === 'object') candidates.push(obj[key]);
  }
  for (const c of candidates) {
    const access = c.access_token || c.accessToken;
    if (typeof access === 'string' && access) {
      return {
        accessToken: access,
        refreshToken: c.refresh_token || c.refreshToken || '',
        idToken: c.id_token || c.idToken || obj.id_token || obj.idToken || '',
        accountId: c.account_id || c.accountId || c.chatgpt_account_id || obj.account_id || obj.accountId || obj.chatgpt_account_id || '',
        expiresAt: Number(c.expires_at || c.expiresAt || 0) || 0,
        expiresIn: Number(c.expires_in || c.expiresIn || 0) || 0,
        email: c.email || c.user_email || ''
      };
    }
  }
  return null;
}

/**
 * Check the Codex login state without importing anything: reports whether
 * the user-created token file exists and holds a usable access token.
 * Pure file read — never executes anything.
 */
function codexStatus() {
  const file = codexAuthPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { exists: false, valid: false, path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, valid: false, path: file, error: 'CODEX_FILE_INVALID' };
  }
  const tokens = pickTokens(parsed);
  return { exists: true, valid: !!tokens, path: file, error: tokens ? undefined : 'CODEX_NO_TOKENS' };
}

async function importChatGPTFromCodex() {
  const file = codexAuthPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: 'CODEX_FILE_MISSING', message: 'No Codex token file found at ' + file + '. Run `npx openai-oauth login` yourself first, then retry the import.' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'CODEX_FILE_INVALID', message: 'The Codex token file is not valid JSON. Re-run the Codex login to regenerate it.' };
  }
  const tokens = pickTokens(parsed);
  if (!tokens) {
    return { error: 'CODEX_NO_TOKENS', message: 'The Codex token file has no usable access_token. Re-run the Codex login to regenerate it.' };
  }
  let active = { ...tokens };
  const metadata = chatgptCodex.deriveTokenMetadata(active.accessToken, active.idToken);
  let expiresAt = active.expiresAt || metadata.expiresAt || Date.now() + (active.expiresIn || 3600) * 1000;

  // Codex auth.json can contain an expired short-lived access token alongside
  // a valid rotating refresh token. Refresh before validation instead of
  // rejecting a perfectly recoverable local login.
  if (expiresAt <= Date.now() + 60 * 1000 && active.refreshToken) {
    try {
      const sdk = await chatgptCodex.loadSdk();
      const config = chatgptCodex.sdkConfig(sdk);
      const fresh = await sdk.refreshTokens(config, active.refreshToken);
      active = {
        ...active,
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || active.refreshToken,
        idToken: fresh.idToken || active.idToken,
        accountId: fresh.accountId || active.accountId,
        expiresAt: fresh.expiresAt
      };
      expiresAt = fresh.expiresAt || Date.now() + 3600 * 1000;
    } catch (error) {
      return { error: error.code || 'CODEX_REFRESH_FAILED', message: error.message || 'The local Codex login has expired. Sign in again, then retry.' };
    }
  }

  const activeMeta = chatgptCodex.deriveTokenMetadata(active.accessToken, active.idToken);
  const stored = connections.setChatGPTConnection({
    email: active.email || activeMeta.email || 'Codex CLI user',
    plan: activeMeta.plan || 'oauth',
    sessionToken: active.accessToken,
    accessToken: active.accessToken,
    refreshToken: active.refreshToken,
    idToken: active.idToken,
    accountId: active.accountId || activeMeta.accountId,
    authMode: 'codex-import',
    expiresAt
  });
  if (stored && stored.error) return stored;
  try {
    const models = await chatgptCodex.listModels({
      accessToken: active.accessToken,
      idToken: active.idToken,
      accountId: active.accountId || activeMeta.accountId
    });
    connections.updateChatGPTModels(models);
  } catch {}
  return { ok: true, ...connections.getSanitizedStatus() };
}

module.exports = { importChatGPTFromCodex, codexAuthPath, codexStatus };
