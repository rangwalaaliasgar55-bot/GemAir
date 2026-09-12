'use strict';

/**
 * ChatGPT subscription transport for GemAir Desktop.
 *
 * The protocol implementation is provided by the MIT-licensed
 * @opencoredev/loginwithchatgpt-core package. This CommonJS adapter keeps all
 * OAuth material in Electron's main process, adds a device-code state machine,
 * adapts GemAir's existing OpenAI-style tools to the Codex Responses API, and
 * preserves encrypted reasoning items between stateless tool rounds.
 */

const crypto = require('crypto');

const DEFAULT_DEVICE_TTL_MS = 15 * 60 * 1000;
const MAX_TOOL_ROUNDS = 6;
const MAX_ERROR_BODY = 2000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
let sdkPromise = null;

function loadSdk() {
  if (!sdkPromise) sdkPromise = import('@opencoredev/loginwithchatgpt-core');
  return sdkPromise;
}

function boundedFetch(fetchFn, timeoutMs = REQUEST_TIMEOUT_MS) {
  const base = fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!base) return undefined;
  return async (input, init = {}) => {
    const controller = new AbortController();
    const upstream = init.signal;
    const abort = () => controller.abort(upstream && upstream.reason);
    if (upstream) {
      if (upstream.aborted) abort();
      else upstream.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('CHATGPT_REQUEST_TIMEOUT')), timeoutMs);
    try {
      return await base(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (upstream) upstream.removeEventListener('abort', abort);
    }
  };
}

function sdkConfig(sdk, fetchFn) {
  return sdk.resolveConfig({
    clientId: process.env.GEMAIR_CHATGPT_CLIENT_ID || undefined,
    issuer: process.env.GEMAIR_CHATGPT_ISSUER || undefined,
    codexBaseUrl: process.env.GEMAIR_CHATGPT_CODEX_BASE_URL || undefined,
    clientVersion: process.env.GEMAIR_CHATGPT_CLIENT_VERSION || undefined,
    originator: process.env.GEMAIR_CHATGPT_ORIGINATOR || 'gemair',
    fetch: boundedFetch(fetchFn)
  });
}

function publicDeviceState(pending, now = Date.now()) {
  if (!pending) return { status: 'idle' };
  if (pending.device.expiresAt <= now) {
    return { status: 'expired', loginId: pending.loginId };
  }
  return {
    status: 'pending',
    loginId: pending.loginId,
    userCode: pending.device.userCode,
    verificationUrl: pending.device.verificationUrl,
    interval: pending.device.interval,
    expiresAt: pending.device.expiresAt,
    retryAfterMs: Math.max(0, pending.nextPollAt - now)
  };
}

/**
 * One device-login coordinator per desktop process. Pending device secrets are
 * memory-only and disappear when GemAir closes. Only the user code and OpenAI
 * verification URL cross IPC.
 */
function createDeviceLoginManager(options = {}) {
  const now = options.now || Date.now;
  const getSdk = options.loadSdk || loadSdk;
  const fetchFn = options.fetch;
  let pending = null;
  let pollInFlight = false;

  return {
    async begin() {
      const sdk = await getSdk();
      const config = options.config || sdkConfig(sdk, fetchFn);
      const device = await sdk.requestDeviceCode(config, now);
      pending = {
        loginId: crypto.randomBytes(16).toString('hex'),
        device,
        config,
        nextPollAt: 0
      };
      return publicDeviceState(pending, now());
    },

    async poll(loginId) {
      if (!pending || !loginId || loginId !== pending.loginId) {
        return { status: 'idle', error: 'CHATGPT_LOGIN_NOT_FOUND', message: 'Start ChatGPT sign-in again.' };
      }
      const current = now();
      if (pending.device.expiresAt <= current) {
        const oldId = pending.loginId;
        pending = null;
        return { status: 'expired', loginId: oldId, error: 'CHATGPT_LOGIN_EXPIRED', message: 'The sign-in code expired. Start again.' };
      }
      if (pollInFlight || current < pending.nextPollAt) return publicDeviceState(pending, current);

      // Honor the server-provided cadence and allow only one network poll at a
      // time. Renderer timers, retries, and a Cancel click can otherwise race
      // a rotating authorization-code exchange.
      const active = pending;
      active.nextPollAt = current + Math.max(1, Number(active.device.interval) || 5) * 1000;
      pollInFlight = true;
      try {
        const sdk = await getSdk();
        const result = await sdk.pollDeviceCode(active.config, active.device);
        if (pending !== active) return { status: 'cancelled' };
        if (result.status !== 'authorized') return publicDeviceState(active, now());

        const tokens = await sdk.exchangeDeviceAuthorization(active.config, result);
        if (pending !== active) return { status: 'cancelled' };
        const user = sdk.parseUser(tokens.idToken || tokens.accessToken);
        const completed = {
          status: 'authenticated',
          loginId: active.loginId,
          tokens,
          user: user || {
            accountId: tokens.accountId || sdk.deriveAccountId(tokens.accessToken) || '',
            email: undefined,
            name: undefined,
            plan: undefined
          }
        };
        pending = null;
        return completed;
      } finally {
        pollInFlight = false;
      }
    },

    status(loginId) {
      if (loginId && pending && loginId !== pending.loginId) return { status: 'idle' };
      return publicDeviceState(pending, now());
    },

    cancel(loginId) {
      if (!loginId || (pending && pending.loginId === loginId)) pending = null;
      return { status: 'cancelled' };
    }
  };
}

function deriveTokenMetadata(token, idToken) {
  const parts = String(idToken || token || '').split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'] || {};
    return {
      accountId: typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : '',
      plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : '',
      email: typeof payload.email === 'string' ? payload.email : '',
      name: typeof payload.name === 'string' ? payload.name : '',
      expiresAt: Number.isFinite(Number(payload.exp)) ? Number(payload.exp) * 1000 : 0
    };
  } catch {
    return {};
  }
}

function normalizeTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const fn = tool && tool.type === 'function' ? tool.function : tool;
    if (!fn || typeof fn.name !== 'string' || !fn.name) return null;
    return {
      type: 'function',
      name: fn.name,
      description: String(fn.description || '').slice(0, 1024),
      parameters: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
      strict: false
    };
  }).filter(Boolean);
}

function messagesToInput(messages) {
  const instructions = [];
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.content !== 'string') continue;
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(message.content);
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    input.push({ role, content: message.content });
  }
  return { instructions: instructions.join('\n\n'), input };
}

function extractOutputText(output) {
  let text = '';
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || item.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}

function extractToolCalls(output) {
  const calls = [];
  const seen = new Set();
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || item.type !== 'function_call' || typeof item.name !== 'string') continue;
    const callId = String(item.call_id || item.id || `call_${calls.length + 1}`);
    if (seen.has(callId)) continue;
    seen.add(callId);
    let args = {};
    try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments || {}); } catch {}
    calls.push({ callId, name: item.name, arguments: args });
  }
  return calls;
}

function parseSseFrame(frame) {
  const data = String(frame || '').split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { return null; }
}

function collectEvent(state, event, onDelta) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'error') {
    const err = new Error('CODEX_STREAM_ERROR: ' + String((event.error && event.error.message) || event.message || 'Unknown stream error'));
    err.code = 'CODEX_STREAM_ERROR';
    throw err;
  }
  if (event.type === 'response.failed') {
    const detail = event.response && event.response.error;
    const err = new Error('CODEX_RESPONSE_FAILED: ' + String((detail && detail.message) || 'The response failed.'));
    err.code = 'CODEX_RESPONSE_FAILED';
    err.detail = JSON.stringify(detail || {}).slice(0, MAX_ERROR_BODY);
    throw err;
  }
  if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
    state.text += event.delta;
    state.streamed = true;
    if (onDelta) onDelta(event.delta);
  }
  if (event.type === 'response.output_item.done' && event.item) state.items.push(event.item);
  if (event.type === 'response.completed' && event.response) {
    state.completed = event.response;
    if (Array.isArray(event.response.output)) state.items = event.response.output;
  }
}

async function parseCodexResponse(response, onDelta) {
  const type = String(response.headers && response.headers.get ? response.headers.get('content-type') || '' : '');
  if (!type.includes('text/event-stream')) {
    const json = await response.json();
    if (json && json.error) {
      const err = new Error('CODEX_RESPONSE_FAILED: ' + String(json.error.message || json.error));
      err.code = 'CODEX_RESPONSE_FAILED';
      err.detail = JSON.stringify(json.error).slice(0, MAX_ERROR_BODY);
      throw err;
    }
    const output = Array.isArray(json.output) ? json.output : [];
    const text = extractOutputText(output);
    const toolCalls = extractToolCalls(output);
    if (!text && !toolCalls.length) throw new Error('CODEX_EMPTY_RESPONSE');
    if (text && onDelta) onDelta(text);
    return { text, output, toolCalls, response: json };
  }

  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) throw new Error('CODEX_EMPTY_STREAM');
  const decoder = new TextDecoder();
  const state = { text: '', streamed: false, items: [], completed: null };
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) collectEvent(state, parseSseFrame(frame), onDelta);
  }
  buffer += decoder.decode();
  if (buffer.trim()) collectEvent(state, parseSseFrame(buffer), onDelta);

  const output = (state.completed && Array.isArray(state.completed.output)) ? state.completed.output : state.items;
  const completedText = extractOutputText(output);
  if (!state.text && completedText) {
    state.text = completedText;
    if (onDelta) onDelta(completedText);
  }
  const toolCalls = extractToolCalls(output);
  if (!state.text && !completedText && !toolCalls.length) throw new Error('CODEX_EMPTY_RESPONSE');
  return { text: state.text || completedText, output, toolCalls, response: state.completed };
}

async function callCodexResponses(options) {
  const sdk = await (options.loadSdk || loadSdk)();
  const config = options.config || sdkConfig(sdk, options.fetch);
  const metadata = deriveTokenMetadata(options.accessToken, options.idToken);
  const accountId = options.accountId || metadata.accountId || sdk.deriveAccountId(options.idToken) || sdk.deriveAccountId(options.accessToken);
  if (!accountId) {
    const err = new Error('CHATGPT_ACCOUNT_ID_MISSING: reconnect with ChatGPT device sign-in.');
    err.code = 'CHATGPT_ACCOUNT_ID_MISSING';
    throw err;
  }

  const codexFetch = sdk.createCodexFetch({
    config,
    getAuth: () => ({ accessToken: options.accessToken, accountId }),
    instructions: options.instructions,
    reasoningEffort: options.reasoningEffort || 'medium',
    textVerbosity: options.textVerbosity || 'medium',
    serviceTier: options.serviceTier === 'auto' ? undefined : options.serviceTier
  });
  const body = {
    model: options.model || sdk.DEFAULT_MODEL,
    input: Array.isArray(options.input) ? options.input : [],
    instructions: options.instructions,
    tools: normalizeTools(options.tools),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    stream: true
  };
  if (!body.tools.length) {
    delete body.tools;
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }

  const response = await codexFetch('/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: options.signal
  });
  if (!response.ok) {
    const detail = String(await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
    const err = new Error(`CODEX_HTTP_${response.status}`);
    err.code = response.status === 401 || response.status === 403 ? 'CODEX_UNAUTHORIZED' : 'CODEX_REQUEST_FAILED';
    err.status = response.status;
    err.detail = detail;
    throw err;
  }
  return parseCodexResponse(response, options.onDelta);
}

async function listModels(options) {
  const sdk = await (options.loadSdk || loadSdk)();
  const config = options.config || sdkConfig(sdk, options.fetch);
  const metadata = deriveTokenMetadata(options.accessToken, options.idToken);
  const accountId = options.accountId || metadata.accountId || sdk.deriveAccountId(options.idToken) || sdk.deriveAccountId(options.accessToken);
  if (!accountId) throw new Error('CHATGPT_ACCOUNT_ID_MISSING');
  return sdk.listCodexModels({
    config,
    getAuth: () => ({ accessToken: options.accessToken, accountId })
  });
}

function serializeToolOutput(value) {
  try {
    const normalized = value == null ? { ok: true } : value;
    return (JSON.stringify(normalized, (_key, item) => typeof item === 'bigint' ? item.toString() : item) || '{"ok":true}').slice(0, 100000);
  } catch (error) {
    return JSON.stringify({ error: 'TOOL_RESULT_NOT_SERIALIZABLE', message: String(error.message || error).slice(0, 500) });
  }
}

/**
 * Native Responses tool loop. The complete output (including encrypted
 * reasoning items) is carried into the next stateless request, followed by
 * function_call_output items. This is materially more reliable than asking a
 * model to print custom tool markers in prose.
 */
async function runCodexAgent(options) {
  const converted = messagesToInput(options.messages);
  const instructions = options.instructions || converted.instructions;
  const input = [...converted.input];
  let finalText = '';
  const rounds = Math.max(1, Math.min(Number(options.maxRounds) || MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS));

  for (let round = 0; round < rounds; round += 1) {
    const result = await callCodexResponses({ ...options, instructions, input });
    if (result.text) finalText = result.text;
    if (!result.toolCalls.length) return { text: finalText, rounds: round + 1 };

    // Preserve reasoning + function-call items. The SDK strips response ids and
    // enforces store:false before the next request.
    input.push(...result.output);
    for (const call of result.toolCalls) {
      if (options.onTool) options.onTool({ name: call.name, state: 'start', args: call.arguments });
      let value;
      try {
        value = await options.executeTool(call.name, call.arguments || {});
        if (options.onTool) options.onTool({ name: call.name, state: value && value.error ? 'error' : 'done' });
      } catch (error) {
        value = { error: error.message || String(error) };
        if (options.onTool) options.onTool({ name: call.name, state: 'error' });
      }
      input.push({
        type: 'function_call_output',
        call_id: call.callId,
        output: serializeToolOutput(value)
      });
    }
  }
  const err = new Error('CHATGPT_TOOL_LOOP_LIMIT');
  err.code = 'CHATGPT_TOOL_LOOP_LIMIT';
  throw err;
}

module.exports = {
  DEFAULT_DEVICE_TTL_MS,
  MAX_TOOL_ROUNDS,
  REQUEST_TIMEOUT_MS,
  loadSdk,
  boundedFetch,
  sdkConfig,
  createDeviceLoginManager,
  deriveTokenMetadata,
  normalizeTools,
  messagesToInput,
  extractOutputText,
  extractToolCalls,
  parseSseFrame,
  parseCodexResponse,
  callCodexResponses,
  listModels,
  serializeToolOutput,
  runCodexAgent
};
