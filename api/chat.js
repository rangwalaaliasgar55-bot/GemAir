// Server-side AI proxy. Only real provider completions are successful replies.
// Credentials stay in server env; unavailable providers return actionable errors.
// Optional AI_BASE_URL/AI_MODEL select a custom OpenAI-compatible gateway.

const { originAllowed, applyCors, requestOrigin, env } = require('./_lib/http');

const KEY_ENV_NAMES = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'AI_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY'];

// Free provider fallback chain. Each entry is an OpenAI-compatible endpoint;
// a key under any of keyEnv makes it usable. `nativeHeader` is sent alongside
// Bearer where a provider wants its own auth header (Gemini).
// A much broader free fallback chain. Each entry is OpenAI-compatible; any key
// under keyEnv makes it usable. Adding more providers here means the FREE CORE
// is more resilient: if one rate-limits or goes down, the next answers.
const FREE_PROVIDERS = [
  {
    id: 'groq', free: true,
    base: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY'],
    models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768']
  },
  {
    id: 'gemini', free: true,
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: ['GEMINI_API_KEY', 'GEMINI_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
    nativeHeader: 'x-goog-api-key',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
  },
  {
    id: 'openrouter', free: true,
    base: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
    models: ['meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.1-8b-instruct', 'mistralai/mistral-7b-instruct', 'deepseek/deepseek-chat-v3-0324']
  },
  {
    id: 'cerebras', free: true,
    base: 'https://api.cerebras.ai/v1',
    keyEnv: ['CEREBRAS_API_KEY', 'CEREBRAS_KEY'],
    models: ['llama-3.3-70b', 'qwen-3-32b']
  },
  {
    id: 'sambanova', free: true,
    base: 'https://api.sambanova.ai/v1',
    keyEnv: ['SAMBANOVA_API_KEY', 'SAMBANOVA_KEY'],
    models: ['Meta-Llama-3.1-8B-Instruct', 'Meta-Llama-3.3-70B-Instruct']
  },
  {
    id: 'together', free: true,
    base: 'https://api.together.xyz/v1',
    keyEnv: ['TOGETHER_API_KEY', 'TOGETHER_KEY'],
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo']
  },
  {
    id: 'nvidia', free: true,
    base: 'https://integrate.api.nvidia.com/v1',
    keyEnv: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
    models: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1']
  },
  {
    id: 'xai', free: true,
    base: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
    models: ['grok-3-mini']
  },
  {
    id: 'zai', free: true,
    base: 'https://api.z.ai/api/paas/v4',
    keyEnv: ['ZAI_API_KEY'],
    nativeHeader: 'x-api-key',
    models: ['glm-4-flash']
  },
  {
    id: 'hf', free: true,
    base: 'https://router.huggingface.co/v1',
    keyEnv: ['HF_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct']
  },
  {
    id: 'deepseek', free: true,
    base: 'https://api.deepseek.com/v1',
    keyEnv: ['DEEPSEEK_API_KEY'],
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'deepinfra', free: true,
    base: 'https://api.deepinfra.com/v1/openai',
    keyEnv: ['DEEPINFRA_API_KEY'],
    models: ['meta-llama/Llama-3.3-70B-Instruct']
  },
  {
    id: 'openai', free: false,
    base: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
    models: ['gpt-4o-mini']
  }
];

// Collect providers that have at least one key available. If the user set
// AI_BASE_URL (a specific provider like a local Ollama or a custom gateway),
// honor that first — it is the explicit, intentional choice.
function availableProviders() {
  const out = [];
  const baseOverride = env('AI_BASE_URL');
  const modelOverride = env('AI_MODEL');
  if (baseOverride) {
    const key = KEY_ENV_NAMES.map(env).find(Boolean) || '';
    out.push({ id: 'override', base: baseOverride.replace(/\/+$/, ''), key, models: modelOverride ? [modelOverride] : ['llama-3.1-8b-instant'] });
  }
  for (const p of FREE_PROVIDERS) {
    const key = p.keyEnv.map(env).find(Boolean) || '';
    if (key) out.push({ ...p, key, base: p.base.replace(/\/+$/, '') });
  }
  return out;
}

function aiHeaders(provider, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = 'Bearer ' + key;
  if (key && provider.nativeHeader) headers[provider.nativeHeader] = key;
  return headers;
}

// ---------------------------------------------------------------------------
// Per-identity fair-use limits (Section 0). Keyed by an explicit identity sent
// by the renderer (profile.userId) when available, otherwise by client IP.
// A daily cap keeps the shared tier responsive; exhaustion returns HTTP 429.
// ---------------------------------------------------------------------------
const _usage = new Map(); // `${day}:${identity}` -> count (per-instance best effort)
const FAIR_USE_DAILY = (() => { const n = parseInt(env('FAIR_USE_DAILY'), 10); return Number.isFinite(n) && n > 0 ? n : 200; })();

function clientIdentities(req, body) {
  // R10 — charge BOTH buckets. A client-supplied userId alone was trivially
  // rotated to reset the daily cap, so the IP bucket is ALWAYS charged; a
  // signed-in userId adds a second bucket so one account cannot dodge the cap
  // by hopping networks either. A request is limited if EITHER is exhausted.
  const fwd = req.headers && req.headers['x-forwarded-for'];
  const ip = fwd ? String(fwd).split(',')[0].trim().slice(0, 64)
    : (req.headers && req.headers['x-real-ip']) ? String(req.headers['x-real-ip']).trim().slice(0, 64)
    : 'unknown';
  const out = ['ip:' + ip];
  if (body && typeof body.userId === 'string' && body.userId.trim()) {
    out.push('u:' + body.userId.trim().slice(0, 64));
  }
  return out;
}

function fairUseLeft(identity) {
  const day = new Date().toISOString().slice(0, 10);
  const key = day + ':' + identity;
  const count = _usage.get(key) || 0;
  const left = Math.max(0, FAIR_USE_DAILY - count);
  return { day, key, left, count };
}

function consumeFairUse(identity) {
  const { day, key, count } = fairUseLeft(identity);
  _usage.set(key, count + 1);
  // keep the map small: prune other days periodically
  if (_usage.size > 5000) {
    for (const k of _usage.keys()) if (!k.startsWith(day)) _usage.delete(k);
  }
  return count + 1;
}

// ---------------------------------------------------------------------------
// R10 — hardening
//
// (a) Every upstream fetch gets an AbortController timeout. A hung provider
//     used to pin the serverless function until the platform killed it, so the
//     fallback chain never got a chance to rotate.
// (b) A light Origin/Referer allow-check plus per-IP throttling. Before this,
//     any script on the internet could POST here and burn the shared free
//     provider keys; fair-use was keyed on a client-supplied userId which is
//     trivially rotated.
// ---------------------------------------------------------------------------
const UPSTREAM_TIMEOUT_MS = (() => {
  const n = parseInt(env('AI_TIMEOUT_MS'), 10);
  return Number.isFinite(n) && n >= 2000 ? n : 20000;
})();

/** fetch() with a hard deadline. Rejects with a tagged error on timeout. */
async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return consume ? await consume(response) : response;
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
      const err = new Error('timeout after ' + timeoutMs + 'ms');
      err.isTimeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Sliding-window per-IP throttle (best effort, per serverless instance). */
const _throttle = new Map(); // ip -> number[] (recent request timestamps)
const THROTTLE_WINDOW_MS = 60000;
const THROTTLE_MAX = (() => { const n = parseInt(env('THROTTLE_PER_MIN'), 10); return Number.isFinite(n) && n > 0 ? n : 12; })();

function clientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim().slice(0, 64);
  const real = req.headers && req.headers['x-real-ip'];
  if (real) return String(real).trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Per-IP throttle: shared fixed-window via KV when enabled, else in-memory sliding window. */
async function throttleCheck(ip) {
  const now = Date.now();
  const memCheck = () => {
    const hits = (_throttle.get(ip) || []).filter((t) => now - t < THROTTLE_WINDOW_MS);
    if (hits.length >= THROTTLE_MAX) {
      return { ok: false, retryAfter: Math.ceil((THROTTLE_WINDOW_MS - (now - hits[0])) / 1000) };
    }
    hits.push(now);
    _throttle.set(ip, hits);
    if (_throttle.size > 5000) {
      for (const [k, v] of _throttle) if (!v.length || now - v[v.length - 1] > THROTTLE_WINDOW_MS) _throttle.delete(k);
    }
    return { ok: true };
  };
  if (!kvEnabled) return memCheck();
  try {
    const slot = Math.floor(now / THROTTLE_WINDOW_MS); // 1-minute buckets
    const key = 'gemair:th:' + slot + ':' + ip;
    const out = await kvPipeline([['INCR', key], ['EXPIRE', key, '120', 'NX']]);
    const first = Array.isArray(out) ? out[0] : out;
    const count = parseInt((first && first.result) || 0, 10) || 0;
    if (count > THROTTLE_MAX) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((THROTTLE_WINDOW_MS - (now % THROTTLE_WINDOW_MS)) / 1000)) };
    }
    return { ok: true };
  } catch {
    return memCheck(); // KV unreachable → degrade to per-instance counting
  }
}

// ---------------------------------------------------------------------------
// SHARED COUNTERS (2.5) — fair-use and throttle across ALL serverless instances.
//
// The in-memory Maps below are per-instance: every cold start resets them, so
// at real scale one user could get a fresh budget from each instance. When
// Vercel KV credentials are configured (KV_REST_API_URL + KV_REST_API_TOKEN,
// an Upstash-compatible REST endpoint), counters move to INCR/GET commands
// over plain fetch — no SDK, ~one extra round-trip per message. Any KV failure
// silently degrades to the in-memory counters, never to an error for the user.
// ---------------------------------------------------------------------------
const KV_URL = env('KV_REST_API_URL') || env('KV_URL');
const KV_TOKEN = env('KV_REST_API_TOKEN');
const kvEnabled = !!(KV_URL && KV_TOKEN);

async function kvPipeline(cmds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(KV_URL.replace(/\/+$/, ''), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.length === 1 ? cmds[0] : cmds),
      signal: controller.signal
    });
    if (!r.ok) throw new Error('KV_HTTP_' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Current daily counts for each identity (shared when KV is on). */
async function fairUseCounts(identities) {
  if (!kvEnabled) return identities.map((id) => fairUseLeft(id).count);
  const day = new Date().toISOString().slice(0, 10);
  try {
    const out = await kvPipeline(identities.map((id) => ['GET', day + ':' + id]));
    const arr = Array.isArray(out) ? out : [out];
    return arr.map((p) => parseInt((p && p.result) || 0, 10) || 0);
  } catch {
    return identities.map((id) => fairUseLeft(id).count); // degrade, don't fail
  }
}

/** Charge today's message against every identity bucket. */
async function fairUseBump(identities) {
  if (!kvEnabled) { for (const id of identities) consumeFairUse(id); return; }
  const day = new Date().toISOString().slice(0, 10);
  const cmds = [];
  for (const id of identities) {
    cmds.push(['INCR', day + ':' + id]);
    cmds.push(['EXPIRE', day + ':' + id, '172800', 'NX']); // 48h TTL self-cleanup
  }
  try { await kvPipeline(cmds); } catch { /* best effort */ }
}

// Single, guarded chat/completions call to one provider+model. Returns
// { ok, status, reply } — `status` lets the caller rotate on 429.
async function tryProvider(provider, messages, temperature, maxTokens) {
  const url = provider.base + (provider.base.endsWith('/chat/completions') ? '' : '/chat/completions');
  try {
    return await fetchWithTimeout(url, {
      method: 'POST',
      headers: aiHeaders(provider, provider.key),
      body: JSON.stringify({ model: provider.models[0], messages, temperature, max_tokens: maxTokens })
    }, UPSTREAM_TIMEOUT_MS, async (res) => {
      if (!res.ok) {
        if (res.body) await res.body.cancel().catch(() => {});
        return { ok: false, status: res.status, error: 'HTTP_' + res.status };
      }
      const data = await res.json();
      const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (data.error || typeof reply !== 'string' || !reply.trim()) return { ok: false, status: 502, error: 'INVALID_COMPLETION' };
      return { ok: true, status: res.status, reply, model: data.model || provider.models[0] };
    });
  } catch (e) {
    if (e && e.isTimeout) return { ok: false, status: 504, error: 'timeout' };
    return { ok: false, status: 502, error: 'UPSTREAM_FAILURE' };
  }
}

function unavailable(attempts) {
  return {
    ok: false, error: 'PROVIDERS_UNAVAILABLE',
    message: 'No configured AI provider completed this request. Retry later; the server operator should check provider credentials, model access, quotas and connectivity.',
    retryable: true, attempts
  };
}

// Rotate providers on 429 (rate-limit): move the failing provider to the back
// and pick the next free one. Each rotation retries at most once per provider.
async function chatWithFallback(providers, messages) {
  const temperature = 0.6, maxTokens = 1200;
  const queue = providers.slice();
  const attempts = [];
  while (queue.length && attempts.length < providers.length * 2) {
    const provider = queue.shift();
    const r = await tryProvider(provider, messages, temperature, maxTokens);
    if (r.ok) return { ok: true, reply: r.reply, provider: provider.id, model: r.model, free: provider.free === true };
    attempts.push({ provider: provider.id, model: provider.models[0], status: r.status, error: r.error });
    if (r.status === 429 || r.status === 504) {
      // rate-limited or timed out → rotate to the next provider and retry
      queue.push(provider);
      continue;
    }
    // hard error (bad key, model missing, provider down) → just move on
  }
  return unavailable(attempts);
}

// Frame SSE independently of network chunks, including multiline data and CRLF.
async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [], event = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('SSE_FRAME_TOO_LARGE');
      let match;
      while ((match = /[\r\n]/.exec(buffer))) {
        const i = match.index;
        if (!done && buffer[i] === '\r' && i === buffer.length - 1) break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + (buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1));
        if (!line) {
          if (data.length) yield { data: data.join('\n'), event };
          data = []; event = '';
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
          if (data.join('\n').length > 1024 * 1024) throw new Error('SSE_FRAME_TOO_LARGE');
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
        if (data.length) yield { data: data.join('\n'), event };
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Rotate only before emitting content. Never splice providers or bless partial output.
async function streamPassthrough(req, res, providers, messages) {
  const temperature = 0.6, maxTokens = 1200;
  const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  };
  const callerOrigin = requestOrigin(req);
  if (callerOrigin && originAllowed({ headers: { origin: callerOrigin } }).ok) sseHeaders['Access-Control-Allow-Origin'] = callerOrigin;
  const queue = providers.slice();
  let started = false;
  const send = (obj) => {
    if (!started) { res.writeHead(200, sseHeaders); started = true; }
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };
  const attempts = [];
  while (queue.length && attempts.length < providers.length * 2) {
    const provider = queue.shift();
    const url = provider.base + (provider.base.endsWith('/chat/completions') ? '' : '/chat/completions');
    let content = '', model = provider.models[0];
    let status = 502, code = 'UPSTREAM_FAILURE';
    try {
      await fetchWithTimeout(url, {
        method: 'POST',
        headers: aiHeaders(provider, provider.key),
        body: JSON.stringify({ model: provider.models[0], messages, temperature, max_tokens: maxTokens, stream: true })
      }, UPSTREAM_TIMEOUT_MS, async (up) => {
        if (!up.ok) {
          status = up.status; code = 'HTTP_' + status;
          if (up.body) await up.body.cancel().catch(() => {});
          throw new Error(code);
        }
        // Some compatible gateways ignore stream:true and return a real JSON completion.
        if ((up.headers.get('content-type') || '').includes('application/json')) {
          const json = await up.json();
          const reply = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
          if (json.error || typeof reply !== 'string' || !reply.trim()) throw new Error('INVALID_COMPLETION');
          model = json.model || model;
          content = reply;
          send({ delta: reply, provider: provider.id, model });
          return;
        }
        if (!up.body || !(up.headers.get('content-type') || '').includes('text/event-stream')) throw new Error('INVALID_STREAM');
        let completed = false;
        for await (const frame of sseEvents(up.body)) {
          const payload = frame.data;
          if (frame.event === 'error') throw new Error('UPSTREAM_STREAM_ERROR');
          if (payload.trim() === '[DONE]') { completed = true; break; }
          const json = JSON.parse(payload);
          if (!json || typeof json !== 'object') throw new Error('INVALID_STREAM');
          if (json.error) throw new Error('UPSTREAM_STREAM_ERROR');
          if (typeof json.model === 'string' && json.model) model = json.model;
          const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
          if (delta != null && typeof delta !== 'string') throw new Error('INVALID_DELTA');
          if (delta) { content += delta; send({ delta, provider: provider.id, model }); }
          const choice = json.choices && json.choices[0];
          if (choice && choice.finish_reason != null) completed = true;
        }
        if (!completed || !content.trim()) throw new Error('INCOMPLETE_STREAM');
      });
      send({ ok: true, done: true, reply: content, provider: provider.id, model, free: provider.free === true });
      return res.end();
    } catch (e) {
      if (e.isTimeout) { status = 504; code = 'UPSTREAM_TIMEOUT'; }
      attempts.push({ provider: provider.id, model, status, error: code });
      if (started) {
        send({ ok: false, error: 'STREAM_INTERRUPTED', message: 'The AI stream failed before completion. Retry the request; the partial response is not complete.', retryable: true, provider: provider.id, model, partial: true, attempts });
        return res.end();
      }
      if (status === 429 || status === 504) queue.push(provider);
    }
  }
  return res.status(503).json(unavailable(attempts));
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_MESSAGES_COUNT = 50;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_TOTAL_MESSAGE_CHARS = 128000;
const VALID_MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);

function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0) return { error: 'messages must be a non-empty array' };
  if (value.length > MAX_MESSAGES_COUNT) return { error: `too many messages (maximum ${MAX_MESSAGES_COUNT})` };
  let total = 0;
  const messages = [];
  for (const message of value) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return { error: 'each message must be an object' };
    if (!VALID_MESSAGE_ROLES.has(message.role) || typeof message.content !== 'string') return { error: 'each message requires a valid role and string content' };
    if (message.content.length > MAX_MESSAGE_LENGTH) return { error: `message exceeds ${MAX_MESSAGE_LENGTH} characters` };
    total += message.content.length;
    if (total > MAX_TOTAL_MESSAGE_CHARS) return { error: 'combined message content is too large' };
    messages.push({ role: message.role, content: message.content });
  }
  if (!messages.some((message) => message.role === 'user' && message.content.trim())) return { error: 'at least one non-empty user message is required' };
  return { messages };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    applyCors(req, res);
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const declaredLength = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return res.status(413).json({ error: 'request too large' });
  res.setHeader('Cache-Control', 'no-store');
  applyCors(req, res); // precise CORS on real responses too (vercel.json no longer sends a wildcard)

  // R10a: only GemAir's own origins may spend the shared free provider keys.
  const origin = originAllowed(req);
  if (!origin.ok) {
    return res.status(403).json({ ok: false, error: 'origin_not_allowed', origin: origin.origin });
  }

  // R10b: per-IP throttle so one client cannot drain the free tier.
  const ip = clientIp(req);
  const gate = await throttleCheck(ip);
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({
      ok: false, error: 'RATE_LIMITED',
      message: `Too many chat requests. Retry in ${gate.retryAfter} seconds.`,
      retryable: true, throttled: true, retryAfter: gate.retryAfter
    });
  }

  let body = {};
  try { body = req.body || {}; } catch {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'invalid request body' });
  let actualBytes = 0;
  try { actualBytes = Buffer.byteLength(JSON.stringify(body), 'utf8'); } catch { return res.status(400).json({ error: 'request body must be serializable' }); }
  if (actualBytes > MAX_REQUEST_BYTES) return res.status(413).json({ error: 'request too large' });
  const validated = validateMessages(body.messages);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const messages = validated.messages;

  const providers = availableProviders();
  if (!providers.length) {
    return res.status(503).json({
      ok: false, error: 'NO_PROVIDERS_CONFIGURED', retryable: false,
      message: 'Server AI is not configured. The server operator must set a provider credential such as GROQ_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY, or configure AI_BASE_URL and AI_MODEL for a compatible gateway.'
    });
  }

  // Counters are shared when Vercel KV credentials are configured.
  const identities = clientIdentities(req, body);
  const counts = await fairUseCounts(identities);
  const left = Math.min(...counts.map((c) => Math.max(0, FAIR_USE_DAILY - c)));
  if (left <= 0) {
    const retryAfter = Math.ceil((Date.parse(new Date().toISOString().slice(0, 10)) + 86400000 - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ ok: false, error: 'DAILY_LIMIT_REACHED', message: 'The shared AI daily message limit has been reached. Retry after midnight UTC.', limited: true, retryable: true, retryAfter });
  }
  await fairUseBump(identities);

  if (body.stream === true) return streamPassthrough(req, res, providers, messages);

  const result = await chatWithFallback(providers, messages);
  return res.status(result.ok ? 200 : 503).json(result);
};
