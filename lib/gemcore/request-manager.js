'use strict';
/* ============================================================
   GemCore — Request Manager (ported from ALTREX CODE)
   ------------------------------------------------------------
   Every provider request goes through one hardened pipeline:
   deadlined fetch → classified failures → honest retries with
   exponential backoff → circuit breaker per provider → abort
   safety → context compaction when a model window overflows →
   optional secret redaction for durable storage.
   ============================================================ */

const { classifyProviderHttpError, ProviderErrorCategory, parseRetryAfter } = require('./provider-errors');
const { redactSensitiveText } = require('../privacy-redaction');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_DEADLINE_MS = 300000;
const MAX_ATTEMPTS = 3;
const CIRCUIT_COOLDOWN_MS = 45000;
const CIRCUIT_FAILURE_THRESHOLD = 5;

const state = {
  circuits: new Map(), // providerKey -> { failures: number, openUntil: 0, lastFailure: { code, detail } }
  abortControllers: new Map() // requestId -> AbortController
};

class ProviderRequestFailedError extends Error {
  constructor(cause) {
    super(cause.message);
    this.name = 'ProviderRequestFailedError';
    this.cause = cause;
  }
  get category() { return this.cause.category; }
  get technicalDetails() { return this.cause.technicalDetails; }
  get retryAfterMs() { return this.cause.retryAfterMs; }
  get retryable() { return this.cause.retryable; }
}

function providerKey(config) {
  return String(config && (config.provider || config.label) || 'provider') + '|' + String(config && config.baseUrl || '');
}

function circuitSnapshot() {
  const snapshot = {};
  for (const [key, circuit] of state.circuits) {
    snapshot[key] = {
      failures: circuit.failures,
      open: Date.now() < circuit.openUntil,
      openUntil: circuit.openUntil,
      ...(circuit.lastFailure ? { lastFailure: circuit.lastFailure } : {})
    };
  }
  return snapshot;
}

function resetCircuits() { state.circuits.clear(); }

function noteCircuitFailure(key, category, detail) {
  const circuit = state.circuits.get(key) || { failures: 0, openUntil: 0, lastFailure: null };
  circuit.failures += 1;
  circuit.lastFailure = {
    code: category,
    detail: redactSensitiveText(String(detail || '')).text.slice(0, 600)
  };
  if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  state.circuits.set(key, circuit);
}

function noteCircuitSuccess(key) {
  const circuit = state.circuits.get(key);
  if (circuit) { circuit.failures = 0; circuit.openUntil = 0; }
}

function assertCircuitClosed(key) {
  const circuit = state.circuits.get(key);
  if (circuit && Date.now() < circuit.openUntil) {
    throw new ProviderRequestFailedError({
      category: ProviderErrorCategory.CONNECTION_ERROR,
      message: 'The provider connection is in a cooldown after repeated failures.',
      retryable: true,
      retryAfterMs: circuit.openUntil - Date.now(),
      technicalDetails: circuit.lastFailure ? ('Circuit open after: ' + circuit.lastFailure.detail) : 'Circuit open'
    });
  }
}

function registerAbort(requestId, controller) {
  if (!requestId) return;
  const existing = state.abortControllers.get(requestId);
  if (existing) existing.abort(new Error('Superseded by a new request'));
  state.abortControllers.set(requestId, controller);
}

function releaseAbort(requestId) { if (requestId) state.abortControllers.delete(requestId); }

function abortRequest(requestId, reason) {
  const controller = state.abortControllers.get(requestId);
  if (!controller) return false;
  controller.abort(new Error(typeof reason === 'string' && reason ? reason : 'Request cancelled by user'));
  return true;
}

function abortAllRequests() {
  for (const controller of state.abortControllers.values()) controller.abort(new Error('Session cancelled'));
  state.abortControllers.clear();
}

function classifyFetchFailure(error) {
  const name = error && error.name;
  const message = String(error && error.message || '');
  if (/cancel/i.test(message)) {
    return { category: ProviderErrorCategory.CANCELLED, message: 'The provider request was cancelled.', retryable: false, retryAfterMs: 0, technicalDetails: 'Cancelled by user' };
  }
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { category: ProviderErrorCategory.TIMEOUT, message: 'The provider request timed out.', retryable: true, retryAfterMs: 0, technicalDetails: 'Request aborted or timed out' };
  }
  if (error && error.cause && typeof error.cause.code === 'string') {
    const code = error.cause.code;
    if (/ETIMEDOUT|ESOCKETTIMEDOUT/.test(code)) return { category: ProviderErrorCategory.TIMEOUT, message: 'The provider connection timed out.', retryable: true, retryAfterMs: 0, technicalDetails: code };
    if (/ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH/.test(code)) return { category: ProviderErrorCategory.CONNECTION_ERROR, message: 'GemAir could not connect to the provider.', retryable: true, retryAfterMs: 0, technicalDetails: code };
    if (/CERT|SSL|TLS/.test(code)) return { category: ProviderErrorCategory.CONNECTION_ERROR, message: 'The TLS connection to the provider failed.', retryable: false, retryAfterMs: 0, technicalDetails: code };
  }
  return {
    category: ProviderErrorCategory.CONNECTION_ERROR,
    message: 'GemAir could not connect to the provider.',
    retryable: true,
    retryAfterMs: 0,
    technicalDetails: redactSensitiveText(error && error.message || String(error)).text.slice(0, 600)
  };
}

function delay(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Request cancelled by user')); }, { once: true });
  });
}

function scheduleRetry(attempt, cause) {
  if (!cause.retryable) return false;
  if (attempt >= MAX_ATTEMPTS) return false;
  return true;
}

function backoffDelay(attempt, cause, jitter = true) {
  const base = cause.retryAfterMs > 0 ? cause.retryAfterMs : Math.min(8000 * Math.pow(2, attempt - 1), 30000);
  return jitter ? base * (0.8 + Math.random() * 0.4) : base;
}

/**
 * Perform one provider HTTP request with timeout, deadline, retries,
 * and circuit-breaker protection. `config`:
 *   { provider, baseUrl, apiKey, path, method, body, requestId, signal,
 *     timeoutMs, deadlineMs, headers }
 * Returns the parsed JSON response.
 */
async function providerRequest(config) {
  const key = providerKey(config);
  assertCircuitClosed(key);
  const deadlineMs = config.deadlineMs || DEFAULT_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const requestId = config.requestId;
  const outerController = new AbortController();
  registerAbort(requestId, outerController);
  const onOuterAbort = () => outerController.abort(outerController.signal.reason || new Error('Request cancelled by user'));
  if (config.signal) {
    if (config.signal.aborted) { releaseAbort(requestId); throw new ProviderRequestFailedError({ category: ProviderErrorCategory.CANCELLED, message: 'The provider request was cancelled.', retryable: false, retryAfterMs: 0, technicalDetails: 'Cancelled before start' }); }
    config.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let attempt = 0;
  let lastCause = null;
  try {
    while (true) {
      attempt += 1;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        lastCause = { category: ProviderErrorCategory.TIMEOUT, message: 'The provider request timed out.', retryable: false, retryAfterMs: 0, technicalDetails: 'Request deadline exceeded' };
        break;
      }
      const timeoutMs = Math.min(config.timeoutMs || DEFAULT_TIMEOUT_MS, remaining);
      // Fresh controller per attempt: a timeout kills this attempt, not the retries.
      const attemptController = new AbortController();
      const onOuterAbort = () => attemptController.abort(outerController.signal.reason || new Error('Request cancelled by user'));
      if (outerController.signal.aborted) {
        lastCause = { category: ProviderErrorCategory.CANCELLED, message: 'The provider request was cancelled.', retryable: false, retryAfterMs: 0, technicalDetails: 'Cancelled before attempt' };
        break;
      }
      outerController.signal.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(() => attemptController.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
      let response;
      try {
        response = await fetch(config.baseUrl + config.path, {
          method: config.method || 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}),
            ...(config.headers || {})
          },
          body: config.body != null ? JSON.stringify(config.body) : undefined,
          signal: attemptController.signal
        });
      } catch (error) {
        lastCause = classifyFetchFailure(error);
      } finally {
        clearTimeout(timer);
        outerController.signal.removeEventListener('abort', onOuterAbort);
      }

      if (response && response.ok) {
        noteCircuitSuccess(key);
        const text = await response.text();
        try { return JSON.parse(text); } catch {
          return { raw: text };
        }
      }
      if (response) {
        const body = await response.text().catch(() => '');
        lastCause = classifyProviderHttpError(response.status, body, response.headers.get('retry-after'));
        if (lastCause.category === ProviderErrorCategory.CONTEXT_TOO_LARGE && config.onContextTooLarge) {
          const compacted = config.onContextTooLarge(lastCause);
          if (compacted) { config.body = compacted; continue; }
        }
      }

      if (!lastCause || !scheduleRetry(attempt, lastCause)) break;
      try {
        await delay(backoffDelay(attempt, lastCause), outerController.signal);
      } catch {
        lastCause = { category: ProviderErrorCategory.CANCELLED, message: 'The provider request was cancelled.', retryable: false, retryAfterMs: 0, technicalDetails: 'Cancelled during backoff' };
        break;
      }
    }
  } finally {
    if (config.signal) config.signal.removeEventListener('abort', onOuterAbort);
    releaseAbort(requestId);
  }

  if (lastCause.category !== ProviderErrorCategory.CANCELLED) noteCircuitFailure(key, lastCause.category, lastCause.technicalDetails);
  throw new ProviderRequestFailedError(lastCause);
}

/* ---------------- abort-safe SSE stream parsing (ALTREX) ---------------- */

/**
 * Parse a streaming OpenAI-compatible SSE body. Callbacks receive
 * complete events only — never partial lines — even when chunks
 * split mid-event or an abort lands between chunks.
 */
async function parseSseStream(reader, { onEvent, signal } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      if (signal && signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { finished = true; break; }
          if (payload) {
            try { const event = JSON.parse(payload); if (onEvent) onEvent(event); } catch { /* skip malformed event */ }
          }
        }
      }
      if (finished) break;
    }
  } finally {
    try { reader.cancel(); } catch { /* reader already closed */ }
  }
  return finished;
}

/**
 * Streamed chat completion through the same protections as
 * providerRequest. `config.onEvent(event)` receives each SSE event;
 * `config.signal` aborts. Returns aggregate usage when the provider
 * sends one.
 */
async function providerRequestStream(config) {
  const key = providerKey(config);
  assertCircuitClosed(key);
  const requestId = config.requestId;
  const outerController = new AbortController();
  registerAbort(requestId, outerController);
  const onOuterAbort = () => outerController.abort(outerController.signal.reason || new Error('Request cancelled by user'));
  if (config.signal) {
    if (config.signal.aborted) { releaseAbort(requestId); throw new ProviderRequestFailedError({ category: ProviderErrorCategory.CANCELLED, message: 'The provider request was cancelled.', retryable: false, retryAfterMs: 0, technicalDetails: 'Cancelled before start' }); }
    config.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    let response = null;
    let lastCause = null;
    const deadlineMs = config.deadlineMs || DEFAULT_DEADLINE_MS;
    const deadlineAt = Date.now() + deadlineMs;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) { lastCause = { category: ProviderErrorCategory.TIMEOUT, message: 'The provider request timed out.', retryable: false, retryAfterMs: 0, technicalDetails: 'Request deadline exceeded' }; break; }
      // Fresh controller per attempt: a timeout kills this attempt, not the retries.
      const attemptController = new AbortController();
      const onOuterAbort = () => attemptController.abort(outerController.signal.reason || new Error('Request cancelled by user'));
      if (outerController.signal.aborted) { lastCause = { category: ProviderErrorCategory.CANCELLED, message: 'The provider request was cancelled.', retryable: false, retryAfterMs: 0, technicalDetails: 'Cancelled before attempt' }; break; }
      outerController.signal.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(() => attemptController.abort(new DOMException('Request timed out', 'TimeoutError')), Math.min(config.timeoutMs || DEFAULT_TIMEOUT_MS, remaining));
      try {
        response = await fetch(config.baseUrl + config.path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}),
            ...(config.headers || {})
          },
          body: JSON.stringify(config.body),
          signal: attemptController.signal
        });
      } catch (error) {
        lastCause = classifyFetchFailure(error);
        response = null;
      } finally {
        clearTimeout(timer);
        outerController.signal.removeEventListener('abort', onOuterAbort);
      }

      if (!response) {
        if (lastCause.category === ProviderErrorCategory.CANCELLED) break;
        if (!lastCause.retryable || attempt === MAX_ATTEMPTS) break;
        try { await delay(backoffDelay(attempt, lastCause), outerController.signal); } catch {
          lastCause = { category: ProviderErrorCategory.CANCELLED, message: 'The provider request was cancelled.', retryable: false, retryAfterMs: 0, technicalDetails: 'Cancelled during backoff' };
          break;
        }
        continue;
      }
      if (response.ok) { lastCause = null; break; }

      const body = await response.text().catch(() => '');
      lastCause = classifyProviderHttpError(response.status, body, response.headers.get('retry-after'));
      if (!lastCause.retryable || attempt === MAX_ATTEMPTS) break;
      try { await delay(backoffDelay(attempt, lastCause), outerController.signal); } catch {
        lastCause = { category: ProviderErrorCategory.CANCELLED, message: 'The provider request was cancelled.', retryable: false, retryAfterMs: 0, technicalDetails: 'Cancelled during backoff' };
        break;
      }
      response = null;
    }

    if (!response || !response.ok) {
      if (lastCause && lastCause.category !== ProviderErrorCategory.CANCELLED) noteCircuitFailure(key, lastCause.category, lastCause.technicalDetails);
      throw new ProviderRequestFailedError(lastCause || { category: ProviderErrorCategory.UNKNOWN, message: 'The provider request failed for an unknown reason.', retryable: false, retryAfterMs: 0, technicalDetails: 'No response' });
    }

    noteCircuitSuccess(key);
    const reader = response.body.getReader();
    let usage = null;
    await parseSseStream(reader, {
      signal: outerController.signal,
      onEvent: (event) => {
        if (event && event.usage) usage = event.usage;
        if (config.onEvent) config.onEvent(event);
      }
    });
    return { usage };
  } finally {
    if (config.signal) config.signal.removeEventListener('abort', onOuterAbort);
    releaseAbort(requestId);
  }
}

/* ---------------- context compaction (ALTREX) ---------------- */

const APPROX_CHARS_PER_TOKEN = 4;

function estimateTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / APPROX_CHARS_PER_TOKEN);
  try { return Math.ceil(JSON.stringify(value).length / APPROX_CHARS_PER_TOKEN); } catch { return 0; }
}

function messageTokens(message) {
  if (!message) return 0;
  let total = estimateTokens(message.content);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) total += estimateTokens(call.function && call.function.arguments);
  }
  if (message.tool_calls) total += estimateTokens(message.tool_calls);
  return total + 8;
}

/**
 * Compact a message list to fit a token budget: keep the system
 * prompt and the most recent turns; summarize the middle when it
 * must be dropped. Used when providers reject oversized contexts
 * and proactively for large agent transcripts.
 */
function compactMessages(messages, tokenBudget, { summarizer } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const total = messages.reduce((sum, message) => sum + messageTokens(message), 0);
  if (total <= tokenBudget) return { messages, compacted: false, dropped: 0 };

  const systemMessages = [];
  const conversation = [];
  for (const message of messages) {
    (message && message.role === 'system' ? systemMessages : conversation).push(message);
  }

  const reserve = systemMessages.reduce((sum, message) => sum + messageTokens(message), 0)
    + Math.ceil(tokenBudget * 0.1); // headroom for the summary line
  let available = Math.max(0, tokenBudget - reserve);

  const kept = [];
  let keptTokens = 0;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const cost = messageTokens(conversation[index]);
    if (keptTokens + cost > available) break;
    kept.unshift(conversation[index]);
    keptTokens += cost;
  }

  const droppedCount = conversation.length - kept.length;
  if (droppedCount <= 0) return { messages, compacted: false, dropped: 0 };

  let summary = null;
  const dropped = conversation.slice(0, droppedCount);
  if (summarizer) {
    try { summary = summarizer(dropped); } catch { summary = null; }
  }
  const summaryMessage = summary
    ? { role: 'system', content: '[Conversation summary — earlier turns were compacted to fit the context window]\n' + summary }
    : { role: 'system', content: '[Earlier turns were compacted to fit the context window. ' + droppedCount + ' messages were dropped.]' };

  return { messages: [...systemMessages, summaryMessage, ...kept], compacted: true, dropped: droppedCount };
}

function redactForStorage(value) {
  const result = redactSensitiveText(value);
  return { text: result.text, redacted: result.redacted, categories: result.categories };
}

module.exports = {
  ProviderRequestFailedError,
  providerRequest,
  providerRequestStream,
  parseSseStream,
  compactMessages,
  estimateTokens,
  messageTokens,
  redactForStorage,
  circuitSnapshot,
  resetCircuits,
  abortRequest,
  abortAllRequests,
  classifyProviderHttpError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  MAX_ATTEMPTS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_COOLDOWN_MS
};
