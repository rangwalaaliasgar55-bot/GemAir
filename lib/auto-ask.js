// auto-ask.js
const fs = require('fs');
const path = require('path');
const { request } = require('undici');
const { randomUUID } = require('crypto');

const SESSION_FILE = path.resolve('./chatgpt-session.json');

async function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return Date.now() < data.expiresAt ? data : null;
  } catch {
    return null;
  }
}

async function ask(prompt) {
  let session = await loadSession();
  if (!session) {
    throw new Error("NO_SESSION");
  }

  const url = 'https://chat.openai.com/backend-api/conversation';

  const reqData = {
    action: "next",
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: {
          content_type: "text",
          parts: [prompt]
        }
      }
    ],
    model: "text-davinci-002-render-sha",
    parent_message_id: randomUUID()
  };

  try {
    const response = await request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://chat.openai.com/chat',
        'Origin': 'https://chat.openai.com'
      },
      body: JSON.stringify(reqData),
      timeout: 30000
    });

    if (response.statusCode === 401) {
      console.log("🔐 Unauthorized: token expired.");
      fs.unlinkSync(SESSION_FILE);
      throw new Error("TOKEN_EXPIRED");
    }

    if (response.statusCode === 429) {
      throw new Error("RATE_LIMITED");
    }

    let body = '';
    for await (const chunk of response.body) {
      body += chunk.toString();
    }

    const lines = body.split('\n');
    let text = '';
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

    return text || "No response.";
  } catch (err) {
    if (err.message === 'NO_SESSION' || err.message === 'TOKEN_EXPIRED') {
      throw err;
    }
    console.log("❌ Request failed:", err.message);
    return "I'm offline.";
  }
}

module.exports = { ask };
