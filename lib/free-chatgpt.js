'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const fetch = require('node-fetch');

// === CONFIG ===
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://chat.openai.com/api/auth/session'; // Where we get the real session
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const STATE = crypto.randomBytes(16).toString('hex');
const SESSION_FILE = './chatgpt-session.json';

// === PKCE ===
function pkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// === BUILD LOGIN URL ===
function buildAuthUrl({ clientId, challenge, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'gemair',
    state
  });
  return `${AUTH_URL}?${params}`;
}

// === SAVE SESSION TOKEN ===
function saveToken(token) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ token, createdAt: Date.now() }, null, 2));
  console.log(`[✔] Session saved. You're now free to use ChatGPT forever.`);
}

// === LOAD TOKEN ===
function loadToken() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    // Refresh if older than 24h
    if (Date.now() - data.createdAt > 24 * 60 * 60 * 1000) {
      console.log("[!] Session too old. Re-login needed.");
      return null;
    }
    return data.token;
  } catch {
    return null;
  }
}

// === START LOGIN FLOW ===
function startLogin() {
  const { challenge } = pkce();
  const authUrl = buildAuthUrl({ clientId: CLIENT_ID, challenge, state: STATE });

  console.log(`🚀 Opening browser...`);
  console.log(`🔹 Paste this if it fails: ${authUrl}\n`);
  
  require('child_process').exec(`start ${authUrl}`); // Windows
  // For macOS: `open "${authUrl}"`
  // For Linux: `xdg-open "${authUrl}"`

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body>
            <h2>🎉 You're logged in! Close this tab.</h2>
            <p>You can now use ChatGPT from your terminal.</p>
          </body>
        </html>
      `);
      server.close();

      // Now extract session cookie from browser (you'll do this manually once)
      console.log("\n[!] Login successful. Now go to:");
      console.log("👉 https://chat.openai.com/api/auth/session");
      console.log("Copy the JSON response and paste it below.\n");
      
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (chunk) => {
        try {
          const data = JSON.parse(chunk.trim());
          const token = data.accessToken;
          if (!token) throw new Error("No accessToken found");
          saveToken(token);
          resolve(token);
        } catch (e) {
          reject(new Error("Invalid session JSON"));
        }
      });
    });

    server.listen(1455, 'localhost', () => {
      console.log(`🔗 Listening on ${REDIRECT_URI}`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Login timeout"));
    }, 180000);
  });
}

// === ASK CHATGPT ===
async function ask(prompt, token) {
  const reqData = {
    action: 'next',
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: { content_type: 'text', parts: [prompt] }
      }
    ],
    model: 'text-davinci-002-render-sha',
    parent_message_id: crypto.randomUUID()
  };

  try {
    const r = await fetch('https://chat.openai.com/backend-api/conversation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(reqData)
    });

    if (r.status === 401) throw new Error("Unauthorized — session expired");
    if (r.status === 429) throw new Error("Rate limited — slow down");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    let text = '';
    const body = await r.text();
    const lines = body.split('\n');
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.message?.content?.parts?.[0]) {
            text = parsed.message.content.parts[0];
          }
        } catch {}
      }
    }
    return text;
  } catch (err) {
    throw err;
  }
}

// === MAIN ===
(async () => {
  console.log("🔓 Free ChatGPT — No API Key, Just Your Login\n");

  let token = loadToken();

  if (!token) {
    console.log("[!] No session found. Starting login flow...\n");
    try {
      await startLogin();
      token = loadToken();
    } catch (e) {
      console.log("❌ Login failed:", e.message);
      return;
    }
  }

  // Test it
  console.log("\n💬 Asking ChatGPT: 'Write a poem about freedom'...\n");
  try {
    const response = await ask("Write a short poem about freedom and coffee", token);
    console.log("☕ Response:\n", response);
  } catch (e) {
    if (e.message.includes("Unauthorized")) {
      console.log("⚠️ Session expired. Please re-login.");
      fs.unlinkSync(SESSION_FILE);
    } else {
      console.log("❌ Error:", e.message);
    }
  }
})();
