'use strict';
/**
 * ChatGPT OAuth PKCE (SocialBot / Stonic-style).
 * Browser sign-in → tokens; no API key paste.
 *
 * Uses the PUBLIC Codex CLI client ID by default (it ships inside OpenAI's
 * own Codex CLI and is reused by every third-party Codex-compatible client).
 * An operator can override it with GEMAIR_CHATGPT_CLIENT_ID, but no private
 * credential is required: the user signs in with their own ChatGPT account
 * and only their own tokens are stored (encrypted, this device only).
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { boundedFetch } = require('./chatgpt-codex');

const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = process.env.GEMAIR_CHATGPT_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access';
// Identifies the calling app to OpenAI's authorize endpoint.
const ORIGINATOR = 'gemair';

function pkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the auth.openai.com authorize URL. Pure function (no network) so the
 * exact parameter set is unit-tested.
 *
 * Besides the standard OAuth2 PKCE set, OpenAI requires THREE non-standard
 * parameters — omitting any one of them lands on auth.openai.com/error with
 * `missing_required_parameter`:
 *   • id_token_add_organizations=true
 *   • codex_cli_simplified_flow=true
 *   • originator=<app>   (attribution; every working third-party client sends one)
 */
function buildChatGPTAuthorizeUrl({ clientId, redirectUri, challenge, state, originator }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: originator || ORIGINATOR,
    state
  });
  return `${AUTH_URL}?${params}`;
}

async function loginChatGPT(opts = {}) {
  // The built-in public Codex client is always usable; an operator override
  // via GEMAIR_CHATGPT_CLIENT_ID wins when present.
  const clientId = process.env.GEMAIR_CHATGPT_CLIENT_ID || CLIENT_ID;
  if (!opts.quiet) console.log('[oauth] ChatGPT client: ' + (process.env.GEMAIR_CHATGPT_CLIENT_ID ? 'operator override' : 'built-in public Codex client'));
  // Redirect MUST be http://localhost:1455/auth/callback: it is the exact
  // shape the known-good Codex flow registers (host + port + path all
  // matter — 127.0.0.1:8765/callback is rejected as missing_required_parameter).
  const port = opts.port || 1455;
  const { verifier, challenge } = pkce();
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = buildChatGPTAuthorizeUrl({ clientId, redirectUri, challenge, state });
  // Full URL on stdout BEFORE the browser opens, so any rejection can be
  // diffed parameter-by-parameter against the known-good set.
  console.log('[oauth] authorize URL:', authUrl);

  const code = await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    // One settle, and it always clears the timer and the listener. Previously
    // each early path (cancel, state mismatch, no code) left the 180s timer and
    // the loopback socket running, so a retried sign-in could be rejected by a
    // stale attempt's timer and the port stayed occupied until it fired.
    const settle = (kind, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch {}
      if (kind === 'ok') resolve(value); else reject(value);
    };
    const page = (status, heading) => '<html><body style="font-family:system-ui"><h2>' + heading + '</h2></body></html>';
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/auth/callback') {
          res.writeHead(404); res.end(); return;
        }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(page(400, 'Sign-in could not be completed.'));
          return settle('err', Object.assign(new Error('ChatGPT sign-in returned a mismatched state parameter. Start sign-in again.'), { code: 'CHATGPT_OAUTH_STATE_MISMATCH' }));
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(page(200, 'ChatGPT sign-in was not completed. You can close this tab.'));
          const error = new Error(u.searchParams.get('error_description') || err);
          error.code = /access_denied/i.test(err) ? 'CHATGPT_OAUTH_CANCELLED' : 'CHATGPT_OAUTH_DECLINED';
          return settle('err', error);
        }
        const c = u.searchParams.get('code');
        if (!c) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(page(400, 'No authorization code returned.'));
          return settle('err', Object.assign(new Error('ChatGPT did not return an authorization code.'), { code: 'CHATGPT_OAUTH_NO_CODE' }));
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page(200, 'ChatGPT linked. You can close this tab.'));
        settle('ok', c);
      } catch (e) {
        settle('err', e);
      }
    });
    server.on('error', (err) => {
      settle('err', new Error('CALLBACK_PORT_IN_USE: port ' + port + ' is busy — close the other login window and retry.'));
    });
    try {
      server.listen(port, 'localhost');
    } catch (error) {
      settle('err', error);
      return;
    }
    server.once('listening', () => {
      if (opts.openBrowser) opts.openBrowser(authUrl);
      else console.log('Open:', authUrl);
    });
    timer = setTimeout(() => settle('err', Object.assign(new Error('ChatGPT sign-in timed out. Finish the code in the browser tab, then press Connect ChatGPT again.'), { code: 'CHATGPT_OAUTH_TIMEOUT' })), opts.timeoutMs || 180000);
  });

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier
  });
  let r;
  try {
    r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(opts.tokenTimeoutMs || 20000)
    });
  } catch (error) {
    throw Object.assign(new Error(`CHATGPT_TOKEN_NETWORK: could not reach OpenAI's token endpoint (${error.name === 'TimeoutError' ? 'timed out' : error.message}). Try again, or use the device-code Connect button, which needs no loopback port.`), { code: 'CHATGPT_TOKEN_NETWORK' });
  }
  const text = await r.text().catch(() => '');
  if (!r.ok) {
    let detail = '';
    try { const parsed = JSON.parse(text); detail = (parsed.error && (parsed.error.description || parsed.error.message)) || parsed.error_description || parsed.error || ''; } catch { detail = text.slice(0, 240); }
    const hint = /redirect_uri/i.test(String(detail))
      ? ` — OpenAI's Codex client only accepts ${redirectUri}; the device-code sign-in avoids this entirely.`
      : '';
    throw Object.assign(new Error(`CHATGPT_TOKEN_EXCHANGE_FAILED (${r.status}): ${detail || 'OpenAI rejected the authorization code'}${hint}`), { code: 'CHATGPT_TOKEN_EXCHANGE_FAILED', detail });
  }
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('CHATGPT_TOKEN_INVALID_RESPONSE: OpenAI did not return JSON for the token exchange.'), { code: 'CHATGPT_TOKEN_INVALID_RESPONSE' }); }
}

/**
 * Refresh through the maintained login-with-chatgpt core. OpenAI's current
 * refresh endpoint expects JSON (including scope), rotates refresh tokens, and
 * returns typed invalid/reused/expired errors. The compatibility return value
 * remains the snake_case token shape used by older GemAir callers.
 */
async function refreshChatGPTAccessToken(refreshToken, fetchFn) {
  if (!refreshToken) {
    const err = new Error('NO_REFRESH_TOKEN');
    err.code = 'NO_REFRESH_TOKEN';
    throw err;
  }
  try {
    // Reuse the one config builder the Codex transport uses. This used to call
    // sdk.resolveConfig directly with only clientId/originator, so
    // GEMAIR_CHATGPT_ISSIVER-style overrides applied to the transport but NOT
    // to refresh — an operator (or a test harness) pointing the issuer at a
    // different host got a working connection that then refreshed against
    // auth.openai.com and died there.
    const codex = require('./chatgpt-codex');
    const sdk = await codex.loadSdk();
    const config = codex.sdkConfig(sdk, fetchFn);
    const tokens = await sdk.refreshTokens(config, refreshToken);
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken || refreshToken,
      id_token: tokens.idToken,
      account_id: tokens.accountId,
      expires_at: tokens.expiresAt,
      expires_in: tokens.expiresAt ? Math.max(0, Math.round((tokens.expiresAt - Date.now()) / 1000)) : undefined
    };
  } catch (error) {
    const err = new Error(error.message || 'ChatGPT token refresh failed.');
    err.code = (error.code === 'refresh_token_invalid' || error.status === 401) ? 'REFRESH_UNAUTHORIZED' : 'REFRESH_FAILED';
    err.detail = String(error.body || '').slice(0, 200);
    throw err;
  }
}

module.exports = { loginChatGPT, refreshChatGPTAccessToken, buildChatGPTAuthorizeUrl, CLIENT_ID, AUTH_URL, TOKEN_URL, ORIGINATOR };
