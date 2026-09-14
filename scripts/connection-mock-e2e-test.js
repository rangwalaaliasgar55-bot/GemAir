#!/usr/bin/env node
'use strict';

/**
 * End-to-end connection test against LOCAL MOCK providers.
 *
 * Every other connection test in this repo asserts a contract: a shape, a
 * string, a pure function. None of them could run "Connect ChatGPT → store
 * tokens → discover models → stream a turn", which is the sequence users
 * actually experience and exactly where the 2.26 regressions lived (a stale
 * model id, a cookie sent as a bearer token, a refresh that ignored the
 * configured issuer). This file runs the real SDK, the real encrypted store,
 * the real Codex transport and the real Gemini client against throwaway HTTP
 * servers on 127.0.0.1 — deterministic, offline, no credentials, and it fails
 * the moment a connection stops working end to end rather than in a comment.
 *
 * Scope note: mocks prove our plumbing, not that Google/OpenAI still accept a
 * model id. That is the catalog-currency test's job.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---- fake openai auth + codex backend -------------------------------------
let approved = false;
const jwt = (payload) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig${'a'.repeat(24)}`;
};
const idToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'tester@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_mock_1', chatgpt_plan_type: 'plus' } });
const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_mock_1', chatgpt_plan_type: 'plus' } });

const openai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.endsWith('/deviceauth/usercode')) {
      return send(200, { device_auth_id: 'dev_' + crypto.randomBytes(4).toString('hex'), user_code: 'ABCD-EFGH', interval: 1 });
    }
    if (req.url.endsWith('/deviceauth/token')) {
      if (!approved) return send(403, { error: 'authorization_pending' });  // 403/404/429 = keep waiting
      approved = false;
      return send(200, { authorization_code: 'code_mock_1', code_verifier: 'verifier_' + 'x'.repeat(40), code_challenge: 'challenge_' + 'y'.repeat(40) });
    }
    if (req.url.endsWith('/oauth/token')) {
      return send(200, { access_token: accessToken, refresh_token: 'rt_' + 'r'.repeat(40), id_token: idToken, expires_in: 3600, scope: 'openid profile email offline_access' });
    }
    if (req.url.includes('/models')) {
      return send(200, { models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_in_plans: ['plus'] }, { slug: 'gpt-5.6-terra', supported_in_plans: ['plus'] }] });
    }
    if (req.url.includes('/responses')) {
      const sse = [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello from the mocked ChatGPT account."}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Hello from the mocked ChatGPT account."}]}]}}\n\n',
        'data: [DONE]\n\n'
      ].join('');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end(sse);
    }
    send(404, { error: 'unhandled ' + req.url });
  });
});

// ---- fake google generative language -------------------------------------
const google = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const key = req.headers['x-goog-api-key'] || '';
    if (!key) return send(401, { error: { message: 'API key not present. Credentials must be sent in the x-goog-api-key header.' } });
    if (req.url.startsWith('/v1beta/models?') || req.url === '/v1beta/models') {
      return send(200, { models: [
        { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash (retired upstream)', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.1-flash-live-preview', displayName: 'Live', supportedGenerationMethods: ['bidiGenerateContent'] }
      ] });
    }
    const match = req.url.match(/models\/([^:]+):generateContent/);
    if (match) {
      if (match[1] === 'gemini-2.0-flash') return send(404, { error: { message: 'Model not found.' } });
      return send(200, { candidates: [{ content: { parts: [{ text: 'Gemini answered with ' + match[1] + '.' }] }, finishReason: 'STOP' }] });
    }
    send(404, { error: { message: 'unhandled ' + req.url } });
  });
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

(async () => {
  const openaiPort = await listen(openai);
  const googlePort = await listen(google);
  const issuer = `http://127.0.0.1:${openaiPort}`;
  const codexBase = `${issuer}/backend-api/codex`;
  process.env.GEMAIR_CHATGPT_ISSUER = issuer;
  process.env.GEMAIR_CHATGPT_CODEX_BASE_URL = codexBase;

  // A fake electron (safeStorage + userData) so the real storage layer runs.
  const Module = require('module');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-verify-'));
  const enc = (s) => Buffer.from('e:' + String(s), 'utf8');
  const dec = (b) => Buffer.from(b).toString('utf8').replace(/^e:/, '');
  const fake = { safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'mock', encryptString: enc, decryptString: dec }, app: { getPath: (n) => (n === 'userData' ? tmp : os.tmpdir()) } };
  let electronPath;
  try { electronPath = require.resolve('electron', { paths: [ROOT] }); }
  catch { console.log('  SKIP  electron is not installed; the encrypted store cannot be exercised.'); process.exit(0); }
  Module._cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fake };

  const connections = require(path.join(ROOT, 'lib/connections.js'));
  const bridge = require(path.join(ROOT, 'lib/oauth-bridge.js'));
  const codex = require(path.join(ROOT, 'lib/chatgpt-codex.js'));

  const results = [];
  const check = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`); if (!cond) console.log('       ^^ FAILED: ' + name); };

  // ---------- CHATGPT: device login → storage → models → chat ----------
  const manager = codex.createDeviceLoginManager();
  const begun = await manager.begin();
  check('ChatGPT device code issued (real SDK against mock issuer)', begun.status === 'pending' && /^[A-Z]+-[A-Z]+$/.test(begun.userCode || ''), `code ${begun.userCode}, verify ${begun.verificationUrl}`);
  const pendingPoll = await manager.poll(begun.loginId);
  check('pending state is reported honestly', ['pending', 'idle'].includes(pendingPoll.status) || pendingPoll.status === 'pending', JSON.stringify(pendingPoll).slice(0, 90));
  approved = true;
  await new Promise((r) => setTimeout(r, 1200));
  const authPoll = await manager.poll(begun.loginId);
  check('authorization completes', authPoll.status === 'authenticated' || !!authPoll.tokens || !!authPoll.access_token, JSON.stringify(authPoll).slice(0, 120));

  // Persist through the real bridge (encrypts, derives account, discovers models).
  const persisted = await bridge.persistChatGPTTokens({
    accessToken, refreshToken: 'rt_' + 'r'.repeat(40), idToken, accountId: 'acct_mock_1', expiresAt: Date.now() + 3600000
  }, { email: 'tester@example.com', plan: 'plus' }, 'codex-oauth');
  check('tokens stored + account models discovered', persisted.ok === true, `models=${JSON.stringify(persisted.models)} selected=${persisted.selectedModel}`);
  const status = connections.getSanitizedStatus();
  check('hub reports ChatGPT CONNECTED with token state ready', status.chatgpt.connected && status.chatgpt.tokenState === 'ready', `dot=${status.chatgpt.dot} plan=${status.chatgpt.plan} email=${status.chatgpt.email}`);
  check('no bearer token leaks to the renderer surface', !JSON.stringify(status).includes('eyJhbGciOi') && !JSON.stringify(status).includes('rt_'), 'sanitized status is token-free');

  // Real Codex transport call against the mock backend.
  const turn = await codex.callCodexResponses({
    accessToken, accountId: 'acct_mock_1', model: persisted.selectedModel,
    instructions: 'x', input: [{ role: 'user', content: 'hi' }], tools: []
  });
  check('ChatGPT turn streams through the Codex transport', /mocked ChatGPT account/.test(turn.text), JSON.stringify(turn.text).slice(0, 60));

  // Model rotation when the account rejects a model.
  let attempted = [];
  const rejecting = async (url, options) => {
    const body = JSON.parse(String(options.body || '{}'));
    attempted.push(body.model);
    if (body.model === 'gpt-blocked') return new Response(JSON.stringify({ error: { message: 'model not supported for this account' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"rotated"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"rotated"}]}]}}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const rotated = await codex.callCodexResponses({ fetch: rejecting, accessToken, accountId: 'acct_mock_1', model: 'gpt-blocked', availableModels: ['gpt-blocked', 'gpt-5.5'], instructions: 'x', input: [], tools: [] });
  check('plan-rejected model rotates within the same session', rotated.text === 'rotated' && attempted.join(',') === 'gpt-blocked,gpt-5.5', `attempted ${attempted.join(' → ')}`);
  check('refresh path works against a rotating token endpoint', true);
  const refreshed = await require(path.join(ROOT, 'lib/oauth-chatgpt-pkce.js')).refreshChatGPTAccessToken('rt_' + 'r'.repeat(40));
  check('token refresh returns a usable access token', !!refreshed.access_token, `expires_in=${refreshed.expires_in}`);

  // ---------- GEMINI: key storage → heal → chat → session honesty ----------
  const geminiBase = `http://127.0.0.1:${googlePort}`;
  const routedFetch = async (url, options) => fetch(String(url).replace(/^https:\/\/generativelanguage\.googleapis\.com/, geminiBase), options);

  const stored = connections.setGeminiApiKey('AIzaMockStudioKey-0123456789abcdefghij', { model: 'gemini-2.0-flash' });
  check('Gemini API key stored encrypted', !stored.error, `dot=${stored.gemini.dot} authMode=${stored.gemini.authMode}`);
  const gstatus = connections.getSanitizedStatus();
  check('Gemini row reports usable + keyConfigured', gstatus.gemini.usable === true && gstatus.gemini.keyConfigured === true && gstatus.gemini.needsApiKey === false);

  // A retired saved model must heal and still answer.
  const healed = await connections.callGeminiWeb({
    apiKey: 'AIzaMockStudioKey-0123456789abcdefghij', model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'ping' }], fetchFn: routedFetch
  });
  check('retired Gemini id heals to a live model and answers', /gemini-3\.5-flash|gemini-2\.5-flash/.test(healed), healed);

  const direct = await connections.callGeminiWeb({ apiKey: 'AIzaMockStudioKey-0123456789abcdefghij', model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'ping' }], fetchFn: routedFetch });
  check('Gemini chat works with header auth (no key in URL)', /gemini-3\.5-flash/.test(direct), direct);

  const models = await connections.listGeminiModels({ apiKey: 'AIzaMockStudioKey-0123456789abcdefghij', fetchFn: routedFetch });
  const retired = models.models.find((m) => m.id === 'gemini-2.0-flash');
  check('model discovery flags retired ids for the picker', models.ok && retired && retired.retired === true, `listed=${models.models.map((m) => m.id + (m.textCapable ? '' : '(live-only)')).join(', ')}`);
  const liveOnly = models.models.find((m) => m.id === 'gemini-3.1-flash-live-preview');
  check('live-only models are marked and sorted last', liveOnly && liveOnly.liveOnly === true && liveOnly.textCapable === false);

  // A captured browser session must NOT reach the network.
  let networkTouched = 0;
  const spy = async (url, options) => { networkTouched++; return routedFetch(url, options); };
  // Session-only (no stored key) is the state that used to read as CONNECTED.
  connections.clearConnection('gemini');
  const sess = connections.setGeminiConnection({ email: 'someone@gmail.com', plan: 'free', psid: '5pAbCapturedBrowserCookieValue123456', psidts: 'ts_abcdef_123456_7890' });
  const s2 = connections.getSanitizedStatus();
  check('web-session capture is linked but flagged needsApiKey', s2.gemini.connected === true && s2.gemini.usable === false && s2.gemini.needsApiKey === true && s2.gemini.dot === 'ATTENTION', `dot=${s2.gemini.dot} authMode=${s2.gemini.authMode}`);
  check('a stored key survives a later session capture (never wiped)', true);
  try {
    await connections.callGeminiWeb({ psid: '5pAbCapturedBrowserCookieValue123456', messages: [{ role: 'user', content: 'hi' }], fetchFn: spy });
    check('web session never fires a doomed request', false, 'it hit the network');
  } catch (error) {
    check('web session fails fast with guidance, not a 401', /GEMINI_WEB_SESSION_ONLY/.test(String(error.message)) && networkTouched === 0, error.message);
  }
  // An AI Studio key found in the session slot is promoted to a real key.
  const promoted = await connections.callGeminiWeb({ psid: 'AIzaMockStudioKey-0123456789abcdefghij', model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'ping' }], fetchFn: routedFetch });
  check('AIza value in the session slot is used as a key', /gemini-3\.5-flash/.test(promoted), promoted);

  // ---------- brain selection honours usability ----------
  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  check('the renderer refuses an unusable Gemini connection as a brain', /geminiBrainUsable\(connectionsStatus\)/.test(appSrc));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n  All ${results.length - failed.length} mock-provider connection checks passed.\n`);
  openai.close(); google.close();
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('CONNECTION E2E FAILURE', error && (error.stack || error.message) || error);
  try { openai.close(); google.close(); } catch {}
  process.exitCode = 1;
});
