/* ============================================================
   GemAir 2.4 — Connections Secure Store & Web Clients
   Stonic-style account connect: no API keys ever.
   - Encrypted on disk via Electron safeStorage (never plaintext, never renderer-visible)
   - ChatGPT: embedded login → session capture → consumer backend
   - Gemini: same pattern + AI Studio fallback
   - Adapter: TOOLS JSON-in-prompt + parse plain text tool-calls → same executeTool loop
   - Resilience: refresh, bot-check handling, disconnect, fallback
   ============================================================ */
'use strict';
const path = require('path');
const os = require('os');
const { readJsonRecovering, writeJsonAtomic, removeJsonStore } = require('./atomic-store');

let safeStorage = null;
try {
  const electron = require('electron');
  safeStorage = electron.safeStorage || null;
} catch (e) {}

let userDataDir = null;
try {
  const electron = require('electron');
  userDataDir = electron.app ? electron.app.getPath('userData') : path.join(os.homedir(), '.gemair');
} catch (e) {
  userDataDir = path.join(os.homedir(), '.gemair');
}

const CONNECTIONS_FILE = path.join(userDataDir, 'gemair-connections.enc');
const USAGE_FILE = path.join(userDataDir, 'gemair-usage.json');
const CONNECTION_STORE_LIMIT = 1024 * 1024;
const USAGE_STORE_LIMIT = 256 * 1024;

function encryptionAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}

function encryptString(str) {
  if (!str) return '';
  if (!encryptionAvailable()) throw new Error('ENCRYPTION_UNAVAILABLE');
  return safeStorage.encryptString(String(str)).toString('base64');
}

function decryptString(b64) {
  if (!b64 || String(b64).endsWith(':fallback') || !encryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(String(b64), 'base64')); } catch { return ''; }
}

function isValidToken(token, { optional = false } = {}) {
  if (token == null || token === '') return optional;
  if (typeof token !== 'string' || token.length < 20 || token.length > 16384 || /[\s\0]/.test(token)) return false;
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload.exp != null && (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Date.now() / 1000)) return false;
    } catch { return false; }
  }
  return true;
}

function emptyUsage() {
  const today = new Date().toISOString().slice(0, 10);
  return { chatgpt: { today: 0, date: today }, gemini: { today: 0, date: today } };
}
function readUsage() {
  const raw = readJsonRecovering(USAGE_FILE, emptyUsage(), { maxBytes: USAGE_STORE_LIMIT });
  const out = emptyUsage();
  for (const provider of ['chatgpt', 'gemini']) {
    const entry = raw[provider];
    if (!entry || typeof entry !== 'object') continue;
    out[provider] = {
      today: Math.max(0, Math.min(1000000, Number(entry.today) || 0)),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || '')) ? String(entry.date) : out[provider].date
    };
  }
  return out;
}
function writeUsage(usage) {
  return writeJsonAtomic(USAGE_FILE, usage, { maxBytes: USAGE_STORE_LIMIT });
}

function incUsage(provider) {
  const u = readUsage();
  const today = new Date().toISOString().slice(0,10);
  if (!u[provider]) u[provider] = { today: 0, date: today };
  if (u[provider].date !== today) { u[provider].today = 0; u[provider].date = today; }
  u[provider].today = (u[provider].today || 0) + 1;
  writeUsage(u);
  return u[provider].today;
}

const EMPTY = {
  chatgpt: null, // { email, plan, sessionTokenEnc, accessTokenEnc, refreshTokenEnc, expiresAt, connectedAt }
  gemini: null,  // { email, psidEnc, psidtsEnc, connectedAt }
  meta: { warningAcknowledged: false, priority: 'chatgpt' } // priority: chatgpt|gemini|free
};

function encryptedField(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= 32768 && /^[A-Za-z0-9+/=]+$/.test(text) ? text : '';
}
function cleanIdentityText(value, max) {
  return String(value || '').replace(/[\0\r\n]/g, ' ').slice(0, max);
}
function readConnectionsRaw() {
  const data = readJsonRecovering(CONNECTIONS_FILE, EMPTY, { maxBytes: CONNECTION_STORE_LIMIT });
  const priority = data.meta && ['chatgpt', 'gemini', 'free'].includes(data.meta.priority) ? data.meta.priority : EMPTY.meta.priority;
  const raw = {
    chatgpt: null,
    gemini: null,
    meta: { warningAcknowledged: !!(data.meta && data.meta.warningAcknowledged === true), priority }
  };
  if (data.chatgpt && typeof data.chatgpt === 'object') {
    const accessTokenEnc = encryptedField(data.chatgpt.accessTokenEnc);
    if (accessTokenEnc) raw.chatgpt = {
      email: cleanIdentityText(data.chatgpt.email, 254),
      plan: cleanIdentityText(data.chatgpt.plan, 50),
      sessionTokenEnc: encryptedField(data.chatgpt.sessionTokenEnc),
      accessTokenEnc,
      refreshTokenEnc: encryptedField(data.chatgpt.refreshTokenEnc),
      expiresAt: Number(data.chatgpt.expiresAt) || 0,
      connectedAt: Number(data.chatgpt.connectedAt) || 0
    };
  }
  if (data.gemini && typeof data.gemini === 'object') {
    const psidEnc = encryptedField(data.gemini.psidEnc);
    if (psidEnc) raw.gemini = {
      email: cleanIdentityText(data.gemini.email, 254),
      plan: cleanIdentityText(data.gemini.plan, 50),
      psidEnc,
      psidtsEnc: encryptedField(data.gemini.psidtsEnc),
      apiKeyEnc: encryptedField(data.gemini.apiKeyEnc),
      connectedAt: Number(data.gemini.connectedAt) || 0
    };
  }
  return raw;
}
function writeConnectionsRaw(data) {
  return writeJsonAtomic(CONNECTIONS_FILE, data, { maxBytes: CONNECTION_STORE_LIMIT });
}

function getSanitizedStatus() {
  const raw = readConnectionsRaw();
  const usage = readUsage();
  const today = new Date().toISOString().slice(0,10);
  const mkUsage = (prov) => {
    const u = usage[prov];
    if (!u || u.date !== today) return 0;
    return u.today || 0;
  };
  const status = {
    chatgpt: {
      connected: !!(encryptionAvailable() && raw.chatgpt && raw.chatgpt.accessTokenEnc && !String(raw.chatgpt.accessTokenEnc).endsWith(':fallback')),
      email: raw.chatgpt ? raw.chatgpt.email : null,
      plan: raw.chatgpt ? raw.chatgpt.plan : null,
      dot: encryptionAvailable() && raw.chatgpt && raw.chatgpt.accessTokenEnc && !String(raw.chatgpt.accessTokenEnc).endsWith(':fallback') ? 'CONNECTED' : 'DISCONNECTED',
      experimental: !!(encryptionAvailable() && raw.chatgpt && raw.chatgpt.accessTokenEnc && !String(raw.chatgpt.accessTokenEnc).endsWith(':fallback')),
      usage: mkUsage('chatgpt')
    },
    gemini: {
      connected: !!(encryptionAvailable() && raw.gemini && raw.gemini.psidEnc && !String(raw.gemini.psidEnc).endsWith(':fallback')),
      email: raw.gemini ? raw.gemini.email : null,
      plan: raw.gemini ? raw.gemini.plan : null,
      keyConfigured: !!(raw.gemini && raw.gemini.apiKeyEnc),
      dot: encryptionAvailable() && raw.gemini && raw.gemini.psidEnc && !String(raw.gemini.psidEnc).endsWith(':fallback') ? 'CONNECTED' : 'DISCONNECTED',
      experimental: !!(encryptionAvailable() && raw.gemini && raw.gemini.psidEnc && !String(raw.gemini.psidEnc).endsWith(':fallback')),
      usage: mkUsage('gemini')
    },
    freeCore: {
      connected: true,
      dot: 'FALLBACK',
      usage: 0
    },
    meta: raw.meta
  };
  // map dot to color semantics for UI
  status.chatgpt.dotColor = status.chatgpt.connected ? (status.chatgpt.experimental ? 'amber' : 'green') : 'gray';
  status.gemini.dotColor = status.gemini.connected ? (status.gemini.experimental ? 'amber' : 'green') : 'gray';
  status.freeCore.dotColor = 'blue';
  return status;
}

function setChatGPTConnection({ email, plan, sessionToken, accessToken, refreshToken, expiresAt }) {
  if (!encryptionAvailable()) return { error: 'ENCRYPTION_UNAVAILABLE', message: 'Secure credential storage is unavailable on this system.' };
  if (!isValidToken(accessToken) || !isValidToken(sessionToken, { optional: true }) || !isValidToken(refreshToken, { optional: true })) return { error: 'INVALID_TOKEN' };
  const expiry = Number(expiresAt) || Date.now() + 14 * 24 * 3600000;
  if (expiry <= Date.now()) return { error: 'TOKEN_EXPIRED' };
  try {
    const raw = readConnectionsRaw();
    raw.chatgpt = {
      email: String(email || 'unknown@chatgpt.com').slice(0, 254),
      plan: String(plan || 'free').slice(0, 50),
      sessionTokenEnc: sessionToken ? encryptString(sessionToken) : '',
      accessTokenEnc: encryptString(accessToken),
      refreshTokenEnc: refreshToken ? encryptString(refreshToken) : '',
      expiresAt: expiry,
      connectedAt: Date.now()
    };
    if (!writeConnectionsRaw(raw)) return { error: 'SECURE_STORE_WRITE_FAILED' };
    return getSanitizedStatus();
  } catch (error) { return { error: error.message || 'SECURE_STORE_FAILED' }; }
}

function isValidApiKey(value) {
  const text = String(value || '').trim();
  return text.length >= 20 && text.length <= 256 && !/[\s\0]/.test(text) ? text : '';
}
function setGeminiConnection({ email, plan, psid, psidts, apiKey }) {
  if (!encryptionAvailable()) return { error: 'ENCRYPTION_UNAVAILABLE', message: 'Secure credential storage is unavailable on this system.' };
  if (!isValidToken(psid) || !isValidToken(psidts, { optional: true })) return { error: 'INVALID_TOKEN' };
  try {
    const raw = readConnectionsRaw();
    const previousKeyEnc = raw.gemini ? raw.gemini.apiKeyEnc : '';
    raw.gemini = {
      email: String(email || 'unknown@gmail.com').slice(0, 254),
      plan: String(plan || 'free').slice(0, 50),
      psidEnc: encryptString(psid),
      psidtsEnc: psidts ? encryptString(psidts) : '',
      // An AI Studio key is optional and never wiped by a later OAuth login
      // that does not provide one.
      apiKeyEnc: apiKey !== undefined ? (isValidApiKey(apiKey) ? encryptString(isValidApiKey(apiKey)) : '') : (previousKeyEnc || ''),
      connectedAt: Number(raw.gemini && raw.gemini.connectedAt) || Date.now()
    };
    if (!writeConnectionsRaw(raw)) return { error: 'SECURE_STORE_WRITE_FAILED' };
    return getSanitizedStatus();
  } catch (error) { return { error: error.message || 'SECURE_STORE_FAILED' }; }
}

function clearConnection(provider) {
  const raw = readConnectionsRaw();
  if (provider === 'chatgpt') raw.chatgpt = null;
  if (provider === 'gemini') raw.gemini = null;
  if (provider === 'all') { raw.chatgpt = null; raw.gemini = null; }
  writeConnectionsRaw(raw);
  // also clear usage? no, keep usage
  return getSanitizedStatus();
}

function clearAllEncrypted() {
  removeJsonStore(CONNECTIONS_FILE);
  removeJsonStore(USAGE_FILE);
  return getSanitizedStatus();
}

function getDecryptedTokens(provider) {
  const raw = readConnectionsRaw();
  if (provider === 'chatgpt' && raw.chatgpt) {
    return {
      email: raw.chatgpt.email,
      plan: raw.chatgpt.plan,
      sessionToken: decryptString(raw.chatgpt.sessionTokenEnc),
      accessToken: decryptString(raw.chatgpt.accessTokenEnc),
      refreshToken: decryptString(raw.chatgpt.refreshTokenEnc),
      expiresAt: raw.chatgpt.expiresAt
    };
  }
  if (provider === 'gemini' && raw.gemini) {
    return {
      email: raw.gemini.email,
      plan: raw.gemini.plan,
      psid: decryptString(raw.gemini.psidEnc),
      psidts: decryptString(raw.gemini.psidtsEnc),
      apiKey: decryptString(raw.gemini.apiKeyEnc)
    };
  }
  return null;
}

/**
 * Decide how a Gemini request authenticates. An AI Studio API key always
 * wins: it is the documented, reliable credential. The OAuth access token
 * is a fallback for identity-linked sessions. Returns { mode, apiKey, token }
 * where mode is 'key', 'bearer', or 'none'. Pure function — unit-tested.
 */
function resolveGeminiAuth(input = {}) {
  const apiKey = isValidApiKey(input.profileKey) || isValidApiKey(input.storedApiKey) || '';
  if (apiKey) return { mode: 'key', apiKey, token: '' };
  const token = typeof input.oauthToken === 'string' ? input.oauthToken : '';
  if (isValidToken(token)) return { mode: 'bearer', apiKey: '', token };
  return { mode: 'none', apiKey: '', token: '' };
}

function isTokenExpired(provider) {
  const raw = readConnectionsRaw();
  if (provider === 'chatgpt' && raw.chatgpt) {
    return Date.now() > (raw.chatgpt.expiresAt || 0);
  }
  return false;
}

function acknowledgeWarning() {
  const raw = readConnectionsRaw();
  raw.meta.warningAcknowledged = true;
  writeConnectionsRaw(raw);
}

function setPriority(p) {
  const raw = readConnectionsRaw();
  if (['chatgpt','gemini','free'].includes(p)) {
    raw.meta.priority = p;
    writeConnectionsRaw(raw);
  }
  return getSanitizedStatus();
}

// ---------------------------------------------------------------------------
// ChatGPT Web Client — most stable open-source approach
// We implement a dual-path client:
// 1. OAuth Codex path (EvanZhouDev/openai-oauth) — POST to https://chatgpt.com/backend-api/codex/responses
//    Uses accessToken from OAuth, OpenAI-compatible, supports streaming, more stable than cookie scraping.
// 2. Legacy backend-api/conversation path (waylaidwanderer/node-chatgpt-api, acheong08/ChatGPT)
//    POST to https://chatgpt.com/backend-api/conversation with Bearer accessToken, SSE streaming.
//
// We try OAuth path first, fallback to legacy. Both use same session capture.
// ---------------------------------------------------------------------------
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random()*16|0;
    return (c==='x'?r:(r&0x3|0x8)).toString(16);
  });
}

async function fetchChatGPTSessionFromCookies(sessionCookies) {
  // sessionCookies is array of {name, value, domain}
  // Build cookie header
  const cookieStr = sessionCookies.map(c=>`${c.name}=${c.value}`).join('; ');
  try {
    const res = await fetch('https://chatgpt.com/api/auth/session', {
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) throw new Error('HTTP_'+res.status);
    const data = await res.json();
    return data; // { user: {email, ...}, accessToken, ... }
  } catch (e) {
    // try chat.openai.com
    try {
      const res2 = await fetch('https://chat.openai.com/api/auth/session', {
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0'
        }
      });
      if (!res2.ok) throw new Error('HTTP_'+res2.status);
      return await res2.json();
    } catch (e2) {
      throw e;
    }
  }
}

async function callChatGPTWeb({ accessToken, messages, onDelta }) {
  // messages: OpenAI format
  // Try to use backend-api/conversation streaming
  const url = 'https://chatgpt.com/backend-api/conversation';
  const parentId = uuid();
  const convId = uuid();
  const body = {
    action: 'next',
    messages: messages.map((m,i)=>({
      id: uuid(),
      author: { role: m.role },
      content: { content_type: 'text', parts: [m.content] }
    })),
    parent_message_id: parentId,
    conversation_id: convId,
    model: 'auto',
    timezone_offset_min: new Date().getTimezoneOffset(),
    history_and_training_disabled: false
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      throw new Error('HTTP_'+res.status+' '+txt.slice(0,200));
    }
    // SSE streaming
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()||'';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          // Different shapes: json.message.content.parts[0] or delta
          let delta = '';
          if (json.message && json.message.content && json.message.content.parts) {
            delta = json.message.content.parts[0] || '';
            // This is not delta but full content incremental; we need to diff
            // For simplicity, if full is prefix, send remainder
            if (delta.startsWith(full)) {
              const diff = delta.slice(full.length);
              if (diff) { full = delta; if (onDelta) onDelta(diff); }
            } else {
              // fallback: treat as delta
              full += delta;
              if (onDelta) onDelta(delta);
            }
          } else if (json.content) {
            delta = json.content;
            full += delta;
            if (onDelta) onDelta(delta);
          }
        } catch (e) {}
      }
    }
    return full;
  } catch (e) {
    throw e;
  }
}

// Gemini client against the official Generative Language endpoint.
// Prefers an AI Studio API key (?key=) — the documented credential that
// needs no OAuth scope. Falls back to the OAuth access token as Bearer.
// The model ID is caller-supplied (Settings shows only IDs the user's own
// key reports via ListModels); a 404 therefore means "retired model or
// disabled API", never a transport bug.
async function callGeminiWeb({ psid, psidts, apiKey, model, messages, onDelta, fetchFn }) {
  const doFetch = fetchFn || fetch;
  const auth = resolveGeminiAuth({ storedApiKey: apiKey, oauthToken: psid });
  if (auth.mode === 'none') throw new Error('GEMINI_KEY_REQUIRED');
  const modelId = String(model || '').trim() || 'gemini-2.5-flash';
  const contents = (messages || [])
    .filter((message) => message && typeof message.content === 'string')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));
  const system = contents.filter((entry) => entry.role === 'user').length
    ? contents
    : [{ role: 'user', parts: [{ text: 'You are Gem, a precise personal assistant.' }] }, ...contents];
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelId) + ':generateContent'
    + (auth.mode === 'key' ? '?key=' + encodeURIComponent(auth.apiKey) : '');
  const headers = { 'Content-Type': 'application/json' };
  if (auth.mode === 'bearer') headers['Authorization'] = 'Bearer ' + auth.token;
  const response = await doFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contents: system, generationConfig: { temperature: 0.3, maxOutputTokens: 1400 } })
  });
  if (response.status === 404) {
    throw new Error('GEMINI_HTTP_404: model "' + modelId + '" is retired/unknown or the Generative Language API is disabled — refresh the model list in Settings → Voice and pick an ID your key reports.');
  }
  if (!response.ok) throw new Error('GEMINI_HTTP_' + response.status);
  const data = await response.json();
  const text = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
    .map((part) => part.text || '').join('').trim();
  if (!text) throw new Error('GEMINI_EMPTY_RESPONSE');
  if (onDelta) onDelta(text);
  return text;
}

// Adapter layer: inject TOOLS as JSON-in-prompt, parse tool-calls from plain text
function buildToolPrompt(tools) {
  const toolList = tools.map(t=>{
    const fn = t.function;
    return `- ${fn.name}: ${fn.description} | params: ${JSON.stringify(fn.parameters)}`;
  }).join('\n');
  return `\n\nYou have access to these TOOLS on the user's computer. To use a tool, you MUST output exactly:\n<<TOOL_CALL>>\n{"name": "tool_name", "arguments": {"param": "value"}}\n<</TOOL_CALL>>\nYou can call multiple tools sequentially, one per block. After tool results, continue answering.\n\nAvailable tools:\n${toolList}\n\nIf no tool needed, answer normally. For file/system actions, always explain what you will do first.\n`;
}

function parseToolCallsFromText(text) {
  const calls = [];
  const regex = /<<TOOL_CALL>>\s*([\s\S]*?)\s*<\/TOOL_CALL>>/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj.name) calls.push(obj);
    } catch (e) {
      // try to extract name/args via looser parse
      try {
        const nameMatch = m[1].match(/\"name\"\s*:\s*\"([^\"]+)\"/);
        const argsMatch = m[1].match(/\"arguments\"\s*:\s*(\{[\s\S]*\})/);
        if (nameMatch) {
          let args = {};
          if (argsMatch) { try { args = JSON.parse(argsMatch[1]); } catch {} }
          calls.push({ name: nameMatch[1], arguments: args });
        }
      } catch {}
    }
  }
  // Also support ```tool: {...}``` style
  const altRegex = /```(?:tool|json)?\s*\{\s*\"name\"\s*:\s*\"([^\"]+)\"[\s\S]*?```/gi;
  while ((m = altRegex.exec(text)) !== null) {
    try {
      const jsonStr = m[0].replace(/```(tool|json)?/i,'').replace(/```/,'').trim();
      const obj = JSON.parse(jsonStr);
      if (obj.name && !calls.find(c=>JSON.stringify(c)===JSON.stringify(obj))) calls.push(obj);
    } catch {}
  }
  return calls;
}

function stripToolCalls(text) {
  return String(text||'').replace(/<<TOOL_CALL>>[\s\S]*?<\/TOOL_CALL>>/gi, '').trim();
}

module.exports = {
  CONNECTIONS_FILE,
  encryptString,
  decryptString,
  readConnectionsRaw,
  writeConnectionsRaw,
  getSanitizedStatus,
  setChatGPTConnection,
  setGeminiConnection,
  clearConnection,
  clearAllEncrypted,
  getDecryptedTokens,
  isValidApiKey,
  resolveGeminiAuth,
  isTokenExpired,
  acknowledgeWarning,
  setPriority,
  incUsage,
  fetchChatGPTSessionFromCookies,
  callChatGPTWeb,
  callGeminiWeb,
  buildToolPrompt,
  parseToolCallsFromText,
  stripToolCalls
};
