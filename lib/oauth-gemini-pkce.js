'use strict';
/**
 * Google OAuth PKCE for Gemini Generative Language API.
 * Requires GEMAIR_GEMINI_CLIENT_ID (Desktop OAuth client in your GCP project).
 * Optional GEMAIR_GEMINI_CLIENT_SECRET.
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Identity scopes ONLY. The generative-language scope is deliberately NOT
// requested: Google rejects it with invalid_scope unless the Cloud project
// has the Generative Language API enabled and the scope approved, which
// broke sign-in entirely. Text generation authenticates with a user-supplied
// AI Studio API key instead (see resolveGeminiAuth in lib/connections.js).
const SCOPES = ['openid', 'email', 'profile'].join(' ');

function clientId() {
  const id = process.env.GEMAIR_GEMINI_CLIENT_ID || '';
  if (!id) throw new Error('Set GEMAIR_GEMINI_CLIENT_ID (GCP OAuth Desktop client)');
  return id;
}

function pkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function loginGemini(opts = {}) {
  const port = opts.port || 8766;
  const cid = clientId();
  const secret = process.env.GEMAIR_GEMINI_CLIENT_SECRET || '';
  const { verifier, challenge } = pkce();
  // Google Desktop OAuth clients commonly register localhost loopback redirects.
  const redirectUri = `http://localhost:${port}/callback`;
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
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400); res.end('bad state'); reject(new Error('state mismatch')); return;
        }
        const c = u.searchParams.get('code');
        const err = u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Gemini linked. Close this tab.</h2></body></html>');
        server.close();
        if (err) reject(new Error(err));
        else if (!c) reject(new Error('no code'));
        else resolve(c);
      } catch (e) { reject(e); }
    });
    server.listen(port, 'localhost', () => {
      if (opts.openBrowser) opts.openBrowser(authUrl);
      else console.log('Open:', authUrl);
    });
    setTimeout(() => { try { server.close(); } catch {} reject(new Error('timeout')); }, opts.timeoutMs || 180000);
  });

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cid,
    code_verifier: verifier
  });
  if (secret) body.set('client_secret', secret);

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  return r.json();
}

async function generateGemini(accessToken, prompt, model = 'gemini-2.0-flash') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    })
  });
  if (!r.ok) throw new Error(`generate ${r.status} ${await r.text()}`);
  const data = await r.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('');
}

module.exports = { loginGemini, generateGemini, AUTH_URL, TOKEN_URL, SCOPES };
