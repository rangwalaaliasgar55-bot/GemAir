'use strict';
/**
 * Google OAuth PKCE for Gemini.
 * Requires GEMAIR_GEMINI_CLIENT_ID (Desktop OAuth client in your GCP project).
 * Optional GEMAIR_GEMINI_CLIENT_SECRET.
 *
 * WHAT THIS FLOW CAN AND CANNOT DO — and why the code says so out loud.
 * Identity scopes ONLY. The generative-language scope is deliberately NOT
 * requested: Google rejects it with `invalid_scope` unless the Cloud project
 * has the Generative Language API enabled and the scope verified, which used to
 * break sign-in entirely. An `openid email profile` token therefore proves WHO
 * the user is and nothing more — it cannot call `generateContent`.
 *
 * The old implementation stored that token as if it were a working credential,
 * so "CONNECT GEMINI" turned the hub green and then every message failed with a
 * 401. Callers now get `scopes: { generation: false }` alongside the token and
 * are expected to mark the connection "needs an AI Studio key" instead of
 * pretending. Text generation authenticates with the user's own AI Studio key
 * (see resolveGeminiAuth in lib/connections.js).
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPES = ['openid', 'email', 'profile'].join(' ');
// Google's documented "no consent screen / no refresh token" prompt for clients
// that only need identity. `consent` is kept because `access_type=offline`
// without it returns no refresh token on a first-time login.
const LOGIN_LOOPBACK_HOST = '127.0.0.1';

function clientId() {
  const id = process.env.GEMAIR_GEMINI_CLIENT_ID || '';
  if (!id) {
    const err = new Error('Set GEMAIR_GEMINI_CLIENT_ID (GCP OAuth Desktop client)');
    err.code = 'GEMINI_OAUTH_CLIENT_MISSING';
    throw err;
  }
  return id;
}

function pkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Best-effort email from the ID token, so the hub shows a real account. */
function emailFromIdToken(idToken) {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return '';
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.email === 'string' && payload.email.includes('@') ? payload.email.slice(0, 254) : '';
  } catch { return ''; }
}

/**
 * Run the loopback code exchange. Returns the token response plus
 * { email, scopes } so callers can be honest about what the session can do.
 */
async function loginGemini(opts = {}) {
  const port = Number(opts.port) || 8766;
  const cid = clientId();
  const secret = process.env.GEMAIR_GEMINI_CLIENT_SECRET || '';
  const { verifier, challenge } = pkce();
  // Google Desktop/Native OAuth clients document the loopback-IP form
  // (http://127.0.0.1:port/path). The `localhost` hostname form is rejected
  // for newer Cloud projects, which surfaced as a failed login window.
  const redirectUri = `http://${LOGIN_LOOPBACK_HOST}:${port}/callback`;
  const state = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: cid,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  });
  const authUrl = `${AUTH_URL}?${params}`;

  const code = await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const settle = (kind, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer); // was left running: held the socket for
      // the full timeout and rejected a promise nobody was awaiting anymore.
      try { server.close(); } catch {}
      kind === 'ok' ? resolve(value) : reject(value);
    };
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Sign-in could not be completed.</h2></body></html>');
          return settle('err', Object.assign(new Error('state mismatch'), { code: 'GEMINI_OAUTH_STATE_MISMATCH' }));
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Gemini sign-in was cancelled. You can close this tab.</h2></body></html>');
          const error = new Error(u.searchParams.get('error_description') || err);
          error.code = /access_denied/i.test(err) ? 'GEMINI_OAUTH_CANCELLED' : 'GEMINI_OAUTH_DECLINED';
          return settle('err', error);
        }
        const c = u.searchParams.get('code');
        if (!c) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>No authorization code returned.</h2></body></html>');
          return settle('err', Object.assign(new Error('no code'), { code: 'GEMINI_OAUTH_NO_CODE' }));
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2 style="font-family:system-ui">Gemini linked. You can close this tab.</h2></body></html>');
        settle('ok', c);
      } catch (e) { settle('err', e); }
    });
    // EADDRINUSE used to escape as an uncaught exception and take the whole
    // Electron main process with it — the app "just closed" on a second
    // Connect click while a window was still open.
    server.on('error', (error) => {
      settle('err', Object.assign(
        new Error(error.code === 'EADDRINUSE'
          ? `GEMINI_CALLBACK_PORT_IN_USE: port ${port} is busy — finish or close the other Gemini sign-in window and try again.`
          : `GEMINI_CALLBACK_LISTEN_FAILED: ${error.message || String(error)}`),
        { code: error.code === 'EADDRINUSE' ? 'GEMINI_CALLBACK_PORT_IN_USE' : 'GEMINI_CALLBACK_LISTEN_FAILED' }
      ));
    });
    try {
      server.listen(port, LOGIN_LOOPBACK_HOST);
    } catch (error) {
      settle('err', error);
      return;
    }
    server.once('listening', () => {
      if (opts.openBrowser) opts.openBrowser(authUrl);
      else console.log('Open:', authUrl);
    });
    timer = setTimeout(() => settle('err', Object.assign(new Error('GEMINI_OAUTH_TIMEOUT: no response from Google within ' + Math.round((opts.timeoutMs || 180000) / 1000) + 's. Finish the sign-in in the browser tab, or press Connect Gemini again.'), { code: 'GEMINI_OAUTH_TIMEOUT' })), opts.timeoutMs || 180000);
  });

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cid,
    code_verifier: verifier
  });
  if (secret) body.set('client_secret', secret);

  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(opts.tokenTimeoutMs || 20000)
    });
  } catch (error) {
    throw Object.assign(new Error(`GEMINI_TOKEN_NETWORK: could not reach Google's token endpoint (${error.name === 'TimeoutError' ? 'timed out' : error.message}). Check your connection and try again.`), { code: 'GEMINI_TOKEN_NETWORK' });
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    // Google's error body names the actual cause (redirect_uri_mismatch,
    // invalid_client, ...). Surface it — this was previously opaque.
    let detail = '';
    try { detail = JSON.parse(text).error_description || JSON.parse(text).error || ''; } catch { detail = text.slice(0, 300); }
    const hint = /redirect_uri/i.test(detail)
      ? ` — add exactly ${redirectUri} under "Authorized redirect URIs" for this OAuth client.`
      : (/invalid_client/i.test(detail) ? ' — the client id/secret do not match this OAuth client.' : '');
    throw Object.assign(new Error(`GEMINI_TOKEN_EXCHANGE_FAILED (${response.status}): ${detail || 'Google rejected the code'}${hint}`), { code: 'GEMINI_TOKEN_EXCHANGE_FAILED', detail });
  }
  let tokens;
  try { tokens = JSON.parse(text); } catch { throw Object.assign(new Error('GEMINI_TOKEN_INVALID_RESPONSE: Google did not return JSON'), { code: 'GEMINI_TOKEN_INVALID_RESPONSE' }); }
  tokens.email = emailFromIdToken(tokens.id_token);
  tokens.scopes = { identity: true, generation: false };
  tokens.generationUsable = false;
  return tokens;
}

/** Google userinfo, used when the ID token carries no email. */
async function fetchGeminiIdentity(accessToken, fetchFn = fetch) {
  if (!accessToken) return { email: '' };
  try {
    const res = await fetchFn(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { email: '' };
    const data = await res.json();
    return { email: typeof data.email === 'string' ? data.email : '' };
  } catch { return { email: '' }; }
}

/**
 * Generate with Gemini using an OAuth access token.
 *
 * Kept for a Cloud project that HAS the Generative Language API enabled and
 * the scope approved — for the built-in identity-only client this fails, and
 * `resolveGeminiAuth`/`callGeminiWeb` is the path that explains why.
 */
async function generateGemini(accessToken, prompt, model = 'gemini-2.5-flash', fetchFn = fetch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const r = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) {
    const raw = await r.text().catch(() => '');
    throw Object.assign(new Error(`Gemini generate failed (${r.status}). Identity-only tokens cannot call the API — use an AI Studio key instead.` + (raw ? ` ${raw.slice(0, 200)}` : '')), { code: 'GEMINI_GENERATE_HTTP_' + r.status });
  }
  const data = await r.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('');
}

/**
 * Probe whether a token can actually generate. The connect path uses this so a
 * green dot always means "GemAir can talk to Gemini", never "sign-in worked".
 */
async function probeGeminiToken(accessToken, fetchFn = fetch) {
  try {
    await generateGemini(accessToken, 'Reply with exactly OK.', 'gemini-2.5-flash', fetchFn);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'GEMINI_TOKEN_NOT_USABLE_FOR_GENERATION', message: error.message };
  }
}

module.exports = {
  loginGemini,
  fetchGeminiIdentity,
  generateGemini,
  probeGeminiToken,
  emailFromIdToken,
  AUTH_URL,
  TOKEN_URL,
  USERINFO_URL,
  SCOPES
};
