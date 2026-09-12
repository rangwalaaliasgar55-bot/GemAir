'use strict';

/**
 * Backward-compatible entry point for GemAir's old "free ChatGPT" experiment.
 *
 * The former implementation scraped undocumented chatgpt.com web sessions,
 * opened a Windows-only shell command, wrote bearer tokens to plaintext, and
 * executed immediately when required. It has intentionally been retired.
 *
 * GemAir now uses the user's own ChatGPT plan through OpenAI device OAuth and
 * the Codex Responses transport. Credentials are persisted only by
 * lib/connections.js through Electron safeStorage. This module contains no
 * token files, subprocesses, browser-cookie scraping, or import-time network
 * side effects.
 */

const codex = require('./chatgpt-codex');

async function ask(prompt, credentials, options = {}) {
  if (!credentials || !credentials.accessToken) throw new Error('CHATGPT_SIGN_IN_REQUIRED');
  const converted = codex.messagesToInput([{ role: 'user', content: String(prompt || '') }]);
  const result = await codex.callCodexResponses({
    ...options,
    accessToken: credentials.accessToken,
    idToken: credentials.idToken,
    accountId: credentials.accountId,
    model: options.model || credentials.selectedModel,
    instructions: options.instructions || converted.instructions,
    input: converted.input
  });
  return result.text;
}

module.exports = {
  ask,
  createDeviceLoginManager: codex.createDeviceLoginManager,
  callCodexResponses: codex.callCodexResponses,
  listModels: codex.listModels
};

if (require.main === module) {
  console.log('GemAir ChatGPT connection is available in Desktop → Settings → AI & Connections → Connect ChatGPT.');
}
