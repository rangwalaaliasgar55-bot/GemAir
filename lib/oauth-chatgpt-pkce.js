'use strict';
/**
 * ChatGPT OAuth PKCE (SocialBot / Stonic-style).
 * Browser sign-in → tokens; no API key paste.
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = process.env.GEMAIR_CHATGPT_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access';

function pkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function loginChatGPT(opts = {}) {
  if (!process.env.GEMAIR_CHATGPT_CLIENT_ID) {
    throw new Error('CHATGPT_OAUTH_CLIENT_REQUIRED');
  }
  const port = opts.port || 8765;
  const { verifier, challenge } = pkce();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  });
  const authUrl = `${AUTH_URL}?${params}`;

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/callback') {
          res.writeHead(404); res.end(); return;
        }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400); res.end('bad state'); reject(new Error('state mismatch')); return;
        }
        const c = u.searchParams.get('code');
        const err = u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>ChatGPT linked. Close this tab.</h2></body></html>');
        server.close();
        if (err) reject(new Error(err));
        else if (!c) reject(new Error('no code'));
        else resolve(c);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      if (opts.openBrowser) opts.openBrowser(authUrl);
      else console.log('Open:', authUrl);
    });
    setTimeout(() => { try { server.close(); } catch {} reject(new Error('timeout')); }, opts.timeoutMs || 180000);
  });

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  return r.json();
}

module.exports = { loginChatGPT, CLIENT_ID, AUTH_URL, TOKEN_URL };
