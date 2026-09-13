'use strict';

/**
 * Main-process controller for the separately licensed FreeGPT35 sidecar.
 * The random bearer token and loopback URL never cross Electron preload.
 */

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const START_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
// OpenAI's anonymous endpoint rate-limits aggressively ("Unusual activity"
// 403s). Hammering it per-message only extends the block, so a block/rate
// limit parks the fallback in a cooldown instead of retrying every turn.
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000;
const UPSTREAM_RETRY_DELAY_MS = 1500;
let child = null;
let endpoint = '';
let bearerToken = '';
let starting = null;
let lastError = '';
let stderrTail = '';
let blockedUntil = 0;
let blockedReason = '';

function cooldownRemainingMs(now = Date.now()) {
  return Math.max(0, blockedUntil - now);
}
function noteBlocked(reason) {
  blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
  blockedReason = String(reason || 'rate-limited').slice(0, 200);
  lastError = `FREEGPT35_COOLDOWN: anonymous fallback paused for ${Math.round(BLOCK_COOLDOWN_MS / 60000)} min (${blockedReason}).`;
}
function cooldownError() {
  const mins = Math.max(1, Math.ceil(cooldownRemainingMs() / 60000));
  const error = new Error(`FREEGPT35_COOLDOWN: the free anonymous fallback is cooling down for ~${mins} more min (${blockedReason || 'rate-limited'}). Connect ChatGPT or Gemini in Settings for uninterrupted chat.`);
  error.code = 'FREEGPT35_COOLDOWN';
  error.retryable = true;
  error.retryAfterMs = cooldownRemainingMs();
  return error;
}
function isTransientFreegpt35(error) {
  const text = String((error && (error.code || error.message)) || error || '');
  return /COOLDOWN|RATE_LIMITED|UPSTREAM_DOWN|EMPTY_RESPONSE|EMPTY_STREAM|REQUEST_TIMEOUT|HTTP_502|HTTP_503|HTTP_504|HTTP_429|BLOCKED/i.test(text);
}

function sidecarScript() {
  if (process.resourcesPath && process.versions && process.versions.electron && !process.defaultApp) {
    return path.join(process.resourcesPath, 'sidecars', 'freegpt35', 'server.js');
  }
  return path.join(__dirname, '..', 'sidecars', 'freegpt35', 'server.js');
}

function publicStatus() {
  return {
    available: true,
    running: !!(child && child.exitCode == null && endpoint),
    provider: 'freegpt35',
    model: 'gpt-3.5-turbo',
    experimental: true,
    license: 'AGPL-3.0-only',
    lastError: lastError ? lastError.slice(0, 500) : '',
    cooldownMs: cooldownRemainingMs(),
    cooldownReason: blockedReason || ''
  };
}

function stop() {
  const active = child;
  child = null;
  endpoint = '';
  bearerToken = '';
  starting = null;
  if (!active || active.exitCode != null) return;
  try { if (active.connected) active.send({ type: 'shutdown' }); } catch {}
  const timer = setTimeout(() => { try { active.kill('SIGKILL'); } catch {} }, 2000);
  if (timer.unref) timer.unref();
  active.once('exit', () => clearTimeout(timer));
}

function safeEnvironment(overrides = {}) {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
  ];
  const env = {};
  for (const key of allowed) if (process.env[key] != null) env[key] = process.env[key];
  for (const key of ['FREEGPT35_REQUEST_TIMEOUT_MS', 'NEW_SESSION_RETRIES', 'USER_AGENT']) {
    if (overrides[key] != null) env[key] = String(overrides[key]);
  }
  return env;
}

function start(options = {}) {
  if (child && child.exitCode == null && endpoint) return Promise.resolve(publicStatus());
  if (starting) return starting;
  lastError = '';
  stderrTail = '';
  bearerToken = crypto.randomBytes(32).toString('base64url');

  starting = new Promise((resolve, reject) => {
    const script = options.script || sidecarScript();
    const env = {
      ...safeEnvironment(options.environment && typeof options.environment === 'object' ? options.environment : {}),
      ELECTRON_RUN_AS_NODE: '1',
      GEMAIR_SIDECAR_TOKEN: bearerToken,
      SERVER_PORT: '0'
    };
    if (options.baseUrl) env.FREEGPT35_BASE_URL = options.baseUrl;
    if (options.test) env.NODE_ENV = 'test';
    const active = spawn(options.execPath || process.execPath, [script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    });
    child = active;
    let settled = false;
    const timer = setTimeout(() => fail(new Error('FREEGPT35_START_TIMEOUT')), Number(options.timeoutMs) || START_TIMEOUT_MS);

    function cleanup() { clearTimeout(timer); starting = null; }
    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      lastError = `${error.message || error}${stderrTail ? ': ' + stderrTail.slice(-300) : ''}`;
      if (child === active) stop();
      reject(Object.assign(new Error(lastError), { code: 'FREEGPT35_START_FAILED' }));
    }

    active.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000); });
    // Keep stdout drained but do not log request data from the child.
    active.stdout.on('data', () => {});
    active.once('error', fail);
    active.once('exit', (code, signal) => {
      if (!settled) return fail(new Error(`FREEGPT35_EXIT_${code == null ? signal : code}`));
      if (child === active) {
        child = null;
        endpoint = '';
        bearerToken = '';
        if (code && !lastError) lastError = `FREEGPT35_EXIT_${code}`;
      }
    });
    active.on('message', (message) => {
      if (settled || !message || message.type !== 'ready' || !Number.isInteger(message.port)) return;
      settled = true;
      cleanup();
      endpoint = `http://127.0.0.1:${message.port}`;
      resolve(publicStatus());
    });
  });
  return starting;
}

async function request(pathname, init = {}, options = {}) {
  await start(options.startOptions || {});
  const controller = new AbortController();
  const upstream = options.signal;
  const abort = () => controller.abort(upstream && upstream.reason);
  if (upstream) {
    if (upstream.aborted) abort();
    else upstream.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('FREEGPT35_REQUEST_TIMEOUT')), Number(options.timeoutMs) || REQUEST_TIMEOUT_MS);
  try {
    return await fetch(endpoint + pathname, {
      ...init,
      signal: controller.signal,
      headers: { ...(init.headers || {}), authorization: `Bearer ${bearerToken}` }
    });
  } finally {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener('abort', abort);
  }
}

async function errorFromResponse(response) {
  const text = await response.text().catch(() => '');
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = parsed && parsed.error && parsed.error.message || text;
  } catch {}
  const status = response.status;
  const unusual = /unusual activity/i.test(String(message));
  let code = 'FREEGPT35_FAILED';
  let friendly = '';
  if (status === 403 && unusual) {
    code = 'FREEGPT35_BLOCKED';
    friendly = 'OpenAI flagged unusual activity from this device/IP and refused the anonymous request. ';
    noteBlocked('unusual-activity 403');
  } else if (status === 429) {
    code = 'FREEGPT35_RATE_LIMITED';
    friendly = 'The free anonymous endpoint is rate-limited right now. ';
    noteBlocked('429 rate limit');
  } else if (status === 502 || status === 503 || status === 504) {
    code = 'FREEGPT35_UPSTREAM_DOWN';
    friendly = 'The anonymous upstream is temporarily down. ';
  }
  const error = new Error(`${code}: ${friendly}FREEGPT35_HTTP_${status}${message ? ': ' + String(message).slice(0, 300) : ''}`);
  error.code = code;
  error.status = status;
  error.retryable = code !== 'FREEGPT35_FAILED';
  error.detail = String(message).slice(0, 500);
  throw error;
}

async function parseStream(response, onDelta) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) throw new Error('FREEGPT35_EMPTY_STREAM');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const payload = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!payload || payload === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }
      if (parsed.error) throw new Error(`FREEGPT35_FAILED: ${parsed.error.message || parsed.error}`);
      const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }
  if (!text.trim()) throw new Error('FREEGPT35_EMPTY_RESPONSE');
  return text.trim();
}

async function chat(messages, options = {}) {
  if (cooldownRemainingMs() > 0 && options.ignoreCooldown !== true) throw cooldownError();
  const stream = typeof options.onDelta === 'function';
  const payload = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-3.5-turbo', messages, stream })
  };
  let response = await request('/v1/chat/completions', payload, options);
  // One automatic retry for flaky upstream 5xx (the exact FREEGPT35_HTTP_502
  // in the field report). Blocks/rate limits are NOT retried — they enter
  // the cooldown above instead.
  if (!response.ok && [502, 503, 504].includes(response.status) && options.retry !== false) {
    await new Promise((resolve) => setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS));
    response = await request('/v1/chat/completions', payload, options);
  }
  if (!response.ok) return errorFromResponse(response);
  let reply;
  if (stream) {
    reply = await parseStream(response, options.onDelta);
  } else {
    const body = await response.json();
    reply = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    if (typeof reply !== 'string' || !reply.trim()) throw new Error('FREEGPT35_EMPTY_RESPONSE');
    reply = reply.trim();
  }
  return { reply, provider: 'FreeGPT35', model: 'gpt-3.5-turbo', experimental: true };
}

async function health(options = {}) {
  try {
    const response = await request('/health', {}, options);
    if (!response.ok) await errorFromResponse(response);
    return { ...publicStatus(), ...(await response.json()) };
  } catch (error) {
    lastError = error.message || String(error);
    return publicStatus();
  }
}

module.exports = { chat, health, parseStream, publicStatus, request, sidecarScript, start, stop, cooldownRemainingMs, isTransientFreegpt35 };
