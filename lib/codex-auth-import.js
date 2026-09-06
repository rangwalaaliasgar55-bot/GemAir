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
        expiresAt: Number(c.expires_at || c.expiresAt || 0) || 0,
        expiresIn: Number(c.expires_in || c.expiresIn || 0) || 0,
        email: c.email || c.user_email || ''
      };
    }
  }
  return null;
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
  const expiresAt = tokens.expiresAt > Date.now()
    ? tokens.expiresAt
    : Date.now() + (tokens.expiresIn || 3600) * 1000;
  return connections.setChatGPTConnection({
    email: tokens.email || 'codex-cli-import',
    plan: 'oauth',
    sessionToken: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt
  });
}

module.exports = { importChatGPTFromCodex, codexAuthPath };
