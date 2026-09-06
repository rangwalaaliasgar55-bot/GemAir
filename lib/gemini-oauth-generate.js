'use strict';
/** Generate with Gemini: AI Studio key first, OAuth token as fallback. */
const connections = require('./connections');
const { generateGemini } = require('./oauth-gemini-pkce');

async function generateWithStoredGemini(prompt, model) {
  const tok = connections.getDecryptedTokens('gemini');
  if (!tok || (!tok.apiKey && !tok.psid)) throw new Error('Gemini not connected');
  const auth = connections.resolveGeminiAuth({ storedApiKey: tok.apiKey, oauthToken: tok.psid });
  if (auth.mode === 'key') {
    return connections.callGeminiWeb({ apiKey: auth.apiKey, messages: [{ role: 'user', content: prompt }] });
  }
  return generateGemini(tok.psid, prompt, model || 'gemini-2.0-flash');
}

module.exports = { generateWithStoredGemini };
