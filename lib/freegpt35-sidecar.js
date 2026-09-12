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
let child = null;
let endpoint = '';
let bearerToken = '';
let starting = null;
let lastError = '';
let stderrTail = '';

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
    lastError: lastError ? lastError.slice(0, 500) : ''
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
  const error = new Error(`FREEGPT35_HTTP_${response.status}${message ? ': ' + String(message).slice(0, 500) : ''}`);
  error.code = response.status === 429 ? 'FREEGPT35_RATE_LIMITED' : 'FREEGPT35_FAILED';
  error.status = response.status;
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
  const stream = typeof options.onDelta === 'function';
  const response = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-3.5-turbo', messages, stream })
  }, options);
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

module.exports = { chat, health, parseStream, publicStatus, request, sidecarScript, start, stop };
