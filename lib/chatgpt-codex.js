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
// Reasoning-heavy models stream for much longer before the first token: a
// fixed 30s budget aborts high/xhigh turns mid-reasoning and surfaces as a
// confusing CODEX_EMPTY_RESPONSE. Scale the budget with the effort instead.
const EFFORT_TIMEOUT_MS = { none: 30000, low: 45000, medium: 60000, high: 120000, xhigh: 180000 };
function timeoutForEffort(effort) {
  const key = String(effort || 'medium').toLowerCase();
  return EFFORT_TIMEOUT_MS[key] || REQUEST_TIMEOUT_MS;
}
// Error signatures that mean "try again" — never "your session is dead".
// Transient transport/provider states must not wipe a stored credential or
// pop the reconnect modal; the caller retries, then falls back gracefully.
const TRANSIENT_CODEX_PATTERN = /CODEX_EMPTY_RESPONSE|CODEX_EMPTY_STREAM|CODEX_INCOMPLETE|CODEX_STREAM_ERROR|CHATGPT_REQUEST_TIMEOUT|FREEGPT35_|HTTP_408\b|HTTP_409\b|HTTP_425\b|HTTP_429\b|HTTP_500\b|HTTP_502\b|HTTP_503\b|HTTP_504\b|HTTP_529\b|CODEX_HTTP_408\b|CODEX_HTTP_409\b|CODEX_HTTP_425\b|CODEX_HTTP_429\b|CODEX_HTTP_500\b|CODEX_HTTP_502\b|CODEX_HTTP_503\b|CODEX_HTTP_504\b|CODEX_HTTP_529\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network|timeout|temporarily|overloaded|try again/i;
function isTransientCodexError(codeOrMessage) {
  const text = String(codeOrMessage || '');
  if (/CODEX_UNAUTHORIZED|invalid_grant|refresh_token_invalid|invalid_token|ACCOUNT_ID_MISSING|SESSION_JSON|TOKEN_EXPIRED|REFRESH_UNAUTHORIZED/i.test(text)) return false;
  return TRANSIENT_CODEX_PATTERN.test(text);
}
// One-line actionable guidance attached to `detail` so the renderer can show
// something useful instead of a bare provider code.
function describeCodexError(error) {
  const text = String((error && (error.code || error.message)) || error || '');
  if (/CODEX_EMPTY_RESPONSE|CODEX_EMPTY_STREAM/.test(text)) return 'The model returned no text for this turn (often a busy endpoint or a reasoning-only reply). Nothing was deducted from your session — just retry.';
  if (/CODEX_INCOMPLETE/.test(text)) return 'The response stopped before finishing. Retry — shorter replies and lower reasoning effort finish more reliably.';
  if (/CODEX_REFUSED/.test(text)) return 'The model declined this request. Rephrase it and try again.';
  if (/TIMEOUT/i.test(text)) return 'The request timed out before the model answered. Retry, or lower reasoning effort for faster turns.';
  if (/429/.test(text)) return 'OpenAI is rate-limiting this account right now. Wait a minute, then retry.';
  if (/50[0234]|529/.test(text)) return 'OpenAI had an internal hiccup. Retry in a few seconds.';
  if (/CODEX_UNAUTHORIZED|401|403/.test(text)) return 'OpenAI rejected this session. Reconnect ChatGPT in Settings → AI & Connections.';
  return '';
}
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

function sdkConfig(sdk, fetchFn, timeoutMs) {
  return sdk.resolveConfig({
    clientId: process.env.GEMAIR_CHATGPT_CLIENT_ID || undefined,
    issuer: process.env.GEMAIR_CHATGPT_ISSUER || undefined,
    codexBaseUrl: process.env.GEMAIR_CHATGPT_CODEX_BASE_URL || undefined,
    clientVersion: process.env.GEMAIR_CHATGPT_CLIENT_VERSION || undefined,
    originator: process.env.GEMAIR_CHATGPT_ORIGINATOR || 'gemair',
    fetch: boundedFetch(fetchFn, Number(timeoutMs) > 0 ? Number(timeoutMs) : REQUEST_TIMEOUT_MS)
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
    if (!item) continue;
    // Responses can encode text as message.content parts, a top-level
    // output_text item, or (in a few proxy implementations) a plain text
    // field. Accepting all documented shapes prevents a valid answer from
    // being misclassified as CODEX_EMPTY_RESPONSE.
    if (typeof item.text === 'string' && (item.type === 'output_text' || item.type === 'text' || !item.content)) text += item.text;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (typeof part === 'string') text += part;
      else if (part && typeof part.text === 'string' && (part.type === 'output_text' || part.type === 'text' || part.type === 'refusal')) text += part.text;
    }
  }
  return text;
}

function extractResponseText(response, output) {
  if (response && typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text;
  return extractOutputText(output);
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
  if (event.type === 'response.incomplete') {
    // The model stopped early (max tokens, content filter, cutoff). Record
    // the reason instead of throwing: partial text below may still be usable,
    // and finishCodexStream turns a truly empty one into CODEX_INCOMPLETE
    // with the reason attached — retryable, never session-fatal.
    const details = (event.response && event.response.incomplete_details) || event.incomplete_details || {};
    state.incompleteReason = String(details.reason || event.reason || 'unknown');
    if (event.response) {
      state.completed = event.response;
      if (Array.isArray(event.response.output)) state.items = event.response.output;
    }
    return;
  }
  if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
    state.text += event.delta;
    state.streamed = true;
    if (onDelta) onDelta(event.delta);
  }
  // Some compatible Responses gateways emit the completed text event without
  // replaying the individual deltas. Capture it before the final emptiness
  // check, while avoiding duplicate delivery when deltas already arrived.
  if (event.type === 'response.output_text.done' && typeof event.text === 'string' && event.text) {
    if (!state.text) {
      state.text = event.text;
      if (onDelta) onDelta(event.text);
    } else if (!state.text.includes(event.text)) {
      state.text += event.text;
      if (onDelta) onDelta(event.text);
    }
  }
  if (event.type === 'response.content_part.done' && event.part && typeof event.part.text === 'string' && event.part.text) {
    if (!state.text) {
      state.text = event.part.text;
      if (onDelta) onDelta(event.part.text);
    }
  }
  if ((event.type === 'response.refusal.delta' && typeof event.delta === 'string')
    || (event.type === 'response.refusal.done' && typeof event.refusal === 'string')) {
    state.refusal = (state.refusal || '') + String(event.delta || event.refusal || '');
  }
  if (event.type === 'response.output_item.done' && event.item) state.items.push(event.item);
  if (event.type === 'response.output_item.added' && event.item && event.item.type === 'reasoning') {
    // Reasoning items arrive here on some models; keep them so tool-loop
    // continuity and the empty-response diagnostic can see them.
    state.items.push(event.item);
  }
  if (event.type === 'response.completed' && event.response) {
    state.completed = event.response;
    if (Array.isArray(event.response.output)) state.items = event.response.output;
  }
}

async function parseCodexResponse(response, onDelta) {
  const type = String(response.headers && response.headers.get ? response.headers.get('content-type') || '' : '');
  if (!type.includes('text/event-stream')) {
    const rawText = await response.text();
    if (/^\s*(event:|data:)/.test(rawText)) {
      // The server streamed SSE frames without the event-stream header.
      // Parse them as a stream instead of crashing in response.json().
      return finishCodexStream(parseCodexSseText(rawText, onDelta), onDelta);
    }
    let json = null;
    try {
      json = JSON.parse(rawText);
    } catch {
      const err = new Error('CODEX_BAD_RESPONSE: provider returned neither JSON nor an event stream');
      err.code = 'CODEX_BAD_RESPONSE';
      err.detail = String(rawText).slice(0, MAX_ERROR_BODY);
      throw err;
    }
    if (json && json.error) {
      const err = new Error('CODEX_RESPONSE_FAILED: ' + String(json.error.message || json.error));
      err.code = 'CODEX_RESPONSE_FAILED';
      err.detail = JSON.stringify(json.error).slice(0, MAX_ERROR_BODY);
      throw err;
    }
    const output = Array.isArray(json.output) ? json.output : [];
    const text = extractResponseText(json, output);
    const toolCalls = extractToolCalls(output);
    if (!text && !toolCalls.length) {
      const err = new Error('CODEX_EMPTY_RESPONSE');
      err.code = 'CODEX_EMPTY_RESPONSE';
      err.detail = describeCodexError({ code: 'CODEX_EMPTY_RESPONSE' });
      throw err;
    }
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

  return finishCodexStream(state, onDelta);
}

// Parse already-buffered SSE text (used when the server streams frames
// without the event-stream content-type header).
function parseCodexSseText(text, onDelta) {
  const state = { text: '', streamed: false, items: [], completed: null };
  for (const frame of String(text || '').split(/\r?\n\r?\n/)) {
    if (frame.trim()) collectEvent(state, parseSseFrame(frame), onDelta);
  }
  return state;
}

function finishCodexStream(state, onDelta) {
  const output = (state.completed && Array.isArray(state.completed.output)) ? state.completed.output : state.items;
  const completedText = extractResponseText(state.completed, output);
  if (!state.text && completedText) {
    state.text = completedText;
    if (onDelta) onDelta(completedText);
  }
  const toolCalls = extractToolCalls(output);
  const text = state.text || completedText;
  if (!text && !toolCalls.length) {
    // Classify the empty turn so the caller (and the user) knows whether to
    // retry, rephrase, or reconnect. A bare CODEX_EMPTY_RESPONSE used to wipe
    // healthy sessions and read as a dead connection.
    if (state.refusal) {
      const err = new Error('CODEX_REFUSED: the model declined this request.');
      err.code = 'CODEX_REFUSED';
      err.detail = String(state.refusal).slice(0, MAX_ERROR_BODY);
      throw err;
    }
    if (state.incompleteReason) {
      const err = new Error('CODEX_INCOMPLETE: the response stopped early (' + state.incompleteReason + ').');
      err.code = 'CODEX_INCOMPLETE';
      err.detail = 'incomplete_details.reason=' + state.incompleteReason;
      throw err;
    }
    const kinds = {};
    for (const item of output) kinds[item && item.type] = (kinds[item && item.type] || 0) + 1;
    const err = new Error('CODEX_EMPTY_RESPONSE');
    err.code = 'CODEX_EMPTY_RESPONSE';
    err.detail = 'The model returned no text for this turn'
      + (Object.keys(kinds).length ? ' (received items: ' + Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(', ') + ')' : ' (no output items arrived)')
      + '. ' + describeCodexError({ code: 'CODEX_EMPTY_RESPONSE' });
    throw err;
  }
  return { text, output, toolCalls, response: state.completed };
}

async function callCodexResponses(options) {
  const sdk = await (options.loadSdk || loadSdk)();
  const effortTimeout = options.timeoutMs || timeoutForEffort(options.reasoningEffort);
  const config = options.config || sdkConfig(sdk, options.fetch, effortTimeout);
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
    stream: options.stream !== false
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
  let emptyRetryUsed = false;
  const rounds = Math.max(1, Math.min(Number(options.maxRounds) || MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS));

  for (let round = 0; round < rounds; round += 1) {
    let result;
    try {
      result = await callCodexResponses({ ...options, instructions, input });
    } catch (error) {
      // A small number of Responses-compatible gateways acknowledge a streamed
      // request but close it before sending output_text. Retry once as a plain
      // JSON response without tools before surfacing a connection failure.
      if (!emptyRetryUsed && /CODEX_EMPTY_(?:RESPONSE|STREAM)|CODEX_BAD_RESPONSE/.test(String(error && error.message || ''))) {
        emptyRetryUsed = true;
        result = await callCodexResponses({ ...options, instructions, input, tools: [], stream: false });
      } else {
        throw error;
      }
    }
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
  timeoutForEffort,
  isTransientCodexError,
  describeCodexError,
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
