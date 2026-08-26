'use strict';
/** Generate with Gemini using OAuth access token stored via oauth-bridge. */
const connections = require('./connections');
const { generateGemini } = require('./oauth-gemini-pkce');

async function generateWithStoredGemini(prompt, model) {
  const tok = connections.getDecryptedTokens('gemini');
  if (!tok || !tok.psid) throw new Error('Gemini not connected');
  return generateGemini(tok.psid, prompt, model || 'gemini-2.0-flash');
}

module.exports = { generateWithStoredGemini };
