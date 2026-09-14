'use strict';
/* ============================================================
   GemCore provider engine tests — registry, error classification,
   request pipeline (retries, circuit breaker, compaction, SSE),
   model registry/router, provider service lifecycle.
   No network: fetch is mocked where requests are exercised.
   ============================================================ */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../lib/gemcore/provider-registry');
const errors = require('../lib/gemcore/provider-errors');
const requestManager = require('../lib/gemcore/request-manager');
const { ModelRegistry } = require('../lib/gemcore/model-registry');
const { routeModel } = require('../lib/gemcore/model-router');
const { ProviderService } = require('../lib/gemcore/provider-service');

let passed = 0;
const tests = [];
function ok(label, fn) { tests.push([label, fn]); }
function okAsync(label, fn) { tests.push([label, fn]); }
async function runTests() {
  for (const [label, fn] of tests) {
    try { await fn(); passed += 1; }
    catch (error) { console.error('✗ ' + label + ': ' + (error && error.message || error)); process.exitCode = 1; }
  }
  console.log('gemcore-provider-test: ' + passed + ' assertions passed' + (process.exitCode ? ' (WITH FAILURES)' : ''));
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-providers-'));

/* ---------------- provider registry ---------------- */
ok('registry: known providers catalog', () => {
  assert(registry.isKnownProvider('gemini'));
  assert(registry.isKnownProvider('groq'));
  assert(registry.isKnownProvider('ollama'));
  assert(registry.isKnownProvider('custom'));
  assert(!registry.isKnownProvider('evilcorp'));
});

ok('registry: officialProviderUrl enforces allowlist', () => {
  const url = registry.officialProviderUrl('gemini', 'apiKey');
  assert.equal(url, 'https://aistudio.google.com/apikey');
  assert.throws(() => registry.officialProviderUrl('nope', 'apiKey'));
  assert.throws(() => registry.officialProviderUrl('gemini', 'install'));
});

ok('registry: base URLs must be HTTPS unless local', () => {
  assert.equal(registry.normalizeProviderBaseUrl('https://api.groq.com/openai/v1/'), 'https://api.groq.com/openai/v1');
  assert.equal(registry.normalizeProviderBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.throws(() => registry.normalizeProviderBaseUrl('http://api.groq.com/openai/v1'));
  assert.throws(() => registry.normalizeProviderBaseUrl('https://user:pass@api.groq.com/v1'));
  assert.throws(() => registry.normalizeProviderBaseUrl('not a url'));
});

/* ---------------- provider error classification ---------------- */
ok('errors: 401 with invalid-key body → INVALID_API_KEY', () => {
  const result = errors.classifyProviderHttpError(401, JSON.stringify({ error: { message: 'Invalid API key provided', code: 'invalid_api_key' } }), null);
  assert.equal(result.category, errors.ProviderErrorCategory.INVALID_API_KEY);
  assert.equal(result.retryable, false);
});

ok('errors: 429 with quota-exceeded body → QUOTA_EXHAUSTED (non-retryable)', () => {
  const result = errors.classifyProviderHttpError(429, 'You exceeded your current quota, please check your plan and billing details', null);
  assert.equal(result.category, errors.ProviderErrorCategory.QUOTA_EXHAUSTED);
  assert.equal(result.retryable, false);
});

ok('errors: 429 rate limit → RATE_LIMITED (retryable, honors retry-after)', () => {
  const result = errors.classifyProviderHttpError(429, 'Too many requests, slow down', '12');
  assert.equal(result.category, errors.ProviderErrorCategory.RATE_LIMITED);
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterMs, 12000);
});

ok('errors: 404 model missing → MODEL_NOT_FOUND', () => {
  const result = errors.classifyProviderHttpError(404, JSON.stringify({ error: { message: 'The model llama-99 does not exist' } }), null);
  assert.equal(result.category, errors.ProviderErrorCategory.MODEL_NOT_FOUND);
});

ok('errors: 400 tools unsupported → TOOLS_UNSUPPORTED', () => {
  const result = errors.classifyProviderHttpError(400, 'This model does not support tool calling with parallel function calls', null);
  assert.equal(result.category, errors.ProviderErrorCategory.TOOLS_UNSUPPORTED);
});

ok('errors: 413 context → CONTEXT_TOO_LARGE with token limit parsed', () => {
  const result = errors.classifyProviderHttpError(413, 'Request exceeds the maximum context limit: 32,768 tokens', null);
  assert.equal(result.category, errors.ProviderErrorCategory.CONTEXT_TOO_LARGE);
  assert.equal(result.tokenLimit, 32768);
});

ok('errors: 500 → PROVIDER_SERVER_ERROR retryable', () => {
  const result = errors.classifyProviderHttpError(503, 'overloaded', null);
  assert.equal(result.category, errors.ProviderErrorCategory.PROVIDER_SERVER_ERROR);
  assert.equal(result.retryable, true);
});

ok('errors: secrets are scrubbed from technical details', () => {
  const result = errors.classifyProviderHttpError(401, 'Bearer sk-abc123def456ghi789jkl012 is invalid', null);
  assert(!result.technicalDetails.includes('sk-abc123def456ghi789jkl012'));
  assert(result.technicalDetails.includes('[REDACTED]'));
});

ok('errors: retry-after date parsing is bounded', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const result = errors.classifyProviderHttpError(429, 'rate limited', future);
  assert(result.retryAfterMs > 0 && result.retryAfterMs <= 5000 + 50);
});

/* ---------------- request pipeline (mocked fetch) ---------------- */
const realFetch = global.fetch;

function mockFetch(handler) {
  let calls = 0;
  global.fetch = async (url, options) => {
    calls += 1;
    return handler(calls, url, options);
  };
  return () => calls;
}

okAsync('pipeline: retries a 500 then succeeds', async () => {
  requestManager.resetCircuits();
  const getCalls = mockFetch((n) => n === 1
    ? new Response(JSON.stringify({ error: 'overloaded' }), { status: 503, headers: { 'retry-after': '0.01' } })
    : new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const result = await requestManager.providerRequest({ provider: 'test-retry', baseUrl: 'https://t.example', path: '/x', body: {}, timeoutMs: 2000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(getCalls(), 2);
  global.fetch = realFetch;
});

okAsync('pipeline: non-retryable 401 fails immediately with one call', async () => {
  requestManager.resetCircuits();
  const getCalls = mockFetch(() => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }));
  await assert.rejects(
    () => requestManager.providerRequest({ provider: 'test-auth', baseUrl: 'https://t.example', path: '/x', body: {}, timeoutMs: 2000 }),
    (error) => error.category === errors.ProviderErrorCategory.INVALID_API_KEY
  );
  assert.equal(getCalls(), 1);
  global.fetch = realFetch;
});

okAsync('pipeline: circuit opens after repeated failed requests and blocks fast', async () => {
  requestManager.resetCircuits();
  const getCalls = mockFetch(() => new Response('boom', { status: 500, headers: { 'retry-after': '0.01' } }));
  const config = { provider: 'circuit-test', baseUrl: 'https://t.example', path: '/x', body: {}, timeoutMs: 500 };
  // The breaker counts failed REQUESTS (each retried 3x internally).
  for (let i = 0; i < requestManager.CIRCUIT_FAILURE_THRESHOLD; i += 1) {
    await assert.rejects(() => requestManager.providerRequest(config));
  }
  const callsToOpen = getCalls();
  await assert.rejects(
    () => requestManager.providerRequest(config),
    (error) => /cooldown/.test(error.message)
  );
  assert.equal(getCalls(), callsToOpen); // the blocked call never reached fetch
  const circuits = requestManager.circuitSnapshot();
  const open = Object.values(circuits).find((c) => c.open);
  assert(open, 'circuit should be open');
  global.fetch = realFetch;
  requestManager.resetCircuits();
});

okAsync('pipeline: success resets the circuit', async () => {
  requestManager.resetCircuits();
  let fail = true;
  mockFetch(() => fail
    ? new Response('boom', { status: 500, headers: { 'retry-after': '0.01' } })
    : new Response('{"ok":1}', { status: 200 }));
  const config = { provider: 'reset-test', baseUrl: 'https://t.example', path: '/x', body: {}, timeoutMs: 500 };
  await assert.rejects(() => requestManager.providerRequest(config)); // creates the circuit entry
  fail = false;
  await requestManager.providerRequest(config); // success resets it
  const circuits = requestManager.circuitSnapshot();
  const reset = Object.values(circuits)[0];
  assert(reset, 'circuit entry should exist');
  assert.equal(reset.failures, 0);
  assert.equal(reset.open, false);
  global.fetch = realFetch;
  requestManager.resetCircuits();
});

okAsync('pipeline: context-too-large triggers compaction callback and retries', async () => {
  requestManager.resetCircuits();
  let compacted = false;
  const getCalls = mockFetch((n) => {
    if (n === 1) return new Response('request exceeds the maximum context limit of this model', { status: 413 });
    return new Response(JSON.stringify({ ok: true, compacted }), { status: 200 });
  });
  const result = await requestManager.providerRequest({
    provider: 'compact-test', baseUrl: 'https://t.example', path: '/x',
    body: { messages: [{ role: 'user', content: 'x' }] }, timeoutMs: 2000,
    onContextTooLarge: () => { compacted = true; return { messages: [{ role: 'system', content: 'compacted' }] }; }
  });
  assert(result.compacted === true);
  assert.equal(getCalls(), 2);
  global.fetch = realFetch;
});

/* ---------------- compaction ---------------- */
ok('compaction: small message lists pass through untouched', () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }];
  const result = requestManager.compactMessages(messages, 1000);
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

ok('compaction: oversized lists keep system + recent, summarize the rest', () => {
  const messages = [{ role: 'system', content: 'be helpful' }];
  for (let i = 0; i < 60; i += 1) messages.push({ role: 'user', content: 'message number ' + i + ' ' + 'x'.repeat(200) });
  const result = requestManager.compactMessages(messages, 1000, { summarizer: (dropped) => 'summary of ' + dropped.length + ' messages' });
  assert.equal(result.compacted, true);
  assert(result.dropped > 0);
  assert.equal(result.messages[0].role, 'system');
  assert(result.messages[1].content.includes('summary of'));
  const last = result.messages[result.messages.length - 1];
  assert(last.content.includes('message number 59'));
});

/* ---------------- SSE parsing ---------------- */
okAsync('sse: chunks split mid-event parse into complete events only', async () => {
  const full = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n';
  // Simulate a reader that returns awkward chunk boundaries.
  const chunks = [full.slice(0, 20), full.slice(20, 45), full.slice(45)];
  let index = 0;
  const reader = {
    read: async () => index < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[index++]) } : { done: true, value: undefined },
    cancel: async () => {}
  };
  const events = [];
  const finished = await requestManager.parseSseStream(reader, { onEvent: (event) => events.push(event) });
  assert.equal(finished, true);
  assert.deepEqual(events.map((e) => e.choices[0].delta.content), ['Hel', 'lo']);
});

/* ---------------- model registry ---------------- */
ok('model registry: list, default resolution, disable, remove, restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-models-'));
  const models = new ModelRegistry(dir);
  const gemini = models.listModels('gemini');
  assert(gemini.some((m) => m.id === 'gemini-2.5-flash'));
  assert.equal(models.resolveModel('gemini', null), 'gemini-2.5-flash');
  assert.equal(models.resolveModel('gemini', 'gemini-2.5-pro'), 'gemini-2.5-pro');
  models.setDefault('gemini', 'gemini-2.5-pro');
  assert.equal(models.resolveModel('gemini', null), 'gemini-2.5-pro');
  let updated = models.setDisabled('gemini', 'gemini-2.5-pro', true);
  assert(updated.find((m) => m.id === 'gemini-2.5-pro').disabled);
  assert.equal(models.resolveModel('gemini', null), 'gemini-2.5-flash'); // falls back
  updated = models.removeModel('gemini', 'gemini-2.5-flash');
  assert(!updated.some((m) => m.id === 'gemini-2.5-flash'));
  updated = models.restoreModel('gemini', 'gemini-2.5-flash');
  assert(updated.some((m) => m.id === 'gemini-2.5-flash'));
  // persistence
  const reloaded = new ModelRegistry(dir);
  assert.equal(reloaded.resolveModel('gemini', null), 'gemini-2.5-flash');
  assert.throws(() => models.setDefault('gemini', 'nonexistent-model'));
});

/* ---------------- model router ---------------- */
ok('router: tool-heavy and analysis requests route to reasoning tier', () => {
  const models = { reasoning: 'deepseek-r1', direct: 'fast-chat', default: 'fast-chat' };
  const reasoned = routeModel(models, { messages: [], tools: [{ type: 'function' }], userText: 'Analyze the root cause of this failure' });
  assert.equal(reasoned.tier, 'reasoning');
  assert.equal(reasoned.model, 'deepseek-r1');
  const quick = routeModel(models, { messages: [], userText: 'hey thanks!' });
  assert.equal(quick.tier, 'direct');
  assert.equal(quick.model, 'fast-chat');
});

ok('router: falls back to default when no reasoning model configured', () => {
  const result = routeModel({ reasoning: null, direct: null, default: 'solo' }, { userText: 'design an architecture with trade-offs', tools: [] });
  assert.equal(result.model, 'solo');
});

/* ---------------- provider service (mocked network) ---------------- */
okAsync('service: connect requires keys for key providers, validates URLs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-service-'));
  const service = new ProviderService(dir);
  await assert.rejects(() => service.connectProvider({ providerId: 'groq', apiKey: '' }), /API key is required/);
  await assert.rejects(() => service.connectProvider({ providerId: 'custom', baseUrl: 'http://evil.example.com', apiKey: 'x' }), /HTTPS/);
  await assert.rejects(() => service.connectProvider({ providerId: 'evilcorp' }), /Unknown provider/);
});

okAsync('service: connect + test discovers models, never leaks keys in listing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-service2-'));
  const service = new ProviderService(dir);
  mockFetch(() => new Response(JSON.stringify({ data: [
    { id: 'llama-3.3-70b-versatile' }, { id: 'brand-new-model' }, { id: 'text-embedding-004' }
  ] }), { status: 200 }));
  const result = await service.connectProvider({ providerId: 'groq', apiKey: 'gsk_testkey1234567890' });
  assert.equal(result.connected, true);
  assert(result.models.some((m) => m.id === 'brand-new-model'));
  assert(!result.models.some((m) => m.id === 'text-embedding-004')); // embedding filtered
  global.fetch = realFetch;
  const listing = service.listProviders();
  const groq = listing.find((p) => p.id === 'groq');
  assert.equal(groq.configured, true);
  assert.equal(groq.connected, true);
  assert(groq.hasKey === true);
  assert(!JSON.stringify(listing).includes('gsk_testkey1234567890')); // keys never cross the bridge
});

okAsync('service: failed test records honest error and disconnects on invalid key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-service3-'));
  const service = new ProviderService(dir);
  mockFetch(() => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }));
  const result = await service.connectProvider({ providerId: 'gemini', apiKey: 'AIzaBadKey1234567890ab' });
  assert.equal(result.connected, false);
  assert.equal(result.error.category, errors.ProviderErrorCategory.INVALID_API_KEY);
  global.fetch = realFetch;
  const status = service.status().find((p) => p.providerId === 'gemini');
  assert.equal(status.connected, false);
  assert(status.lastError && status.lastError.category === 'INVALID_API_KEY');
});

okAsync('service: completeWithRecovery falls through to a healthy alternate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-service4-'));
  const service = new ProviderService(dir);
  mockFetch((n, url) => {
    if (String(url).includes('primary.example')) return new Response('{"error":{"message":"invalid api key"}}', { status: 401 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
  });
  await service.connectProvider({ providerId: 'custom', label: 'Primary', baseUrl: 'https://primary.example/v1', apiKey: 'k1' });
  const primary = service.getProvider('custom');
  // second configured provider via another custom slot is not possible; use gemini with the same mock
  await service.connectProvider({ providerId: 'gemini', apiKey: 'g-key' });
  // Force gemini's baseUrl to the healthy mock endpoint.
  service.updateProvider('gemini', { baseUrl: 'https://healthy.example/v1' });
  const result = await service.completeWithRecovery({
    providerId: 'custom', messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(result.content, 'recovered answer');
  assert.equal(result.recovered, true);
  assert(!result.providerId || result.providerId !== 'custom' || result.recovered === true);
  global.fetch = realFetch;
});

okAsync('service: recovery order prefers requested, then connected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-service5-'));
  const service = new ProviderService(dir);
  mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  await service.connectProvider({ providerId: 'gemini', apiKey: 'a' });
  await service.connectProvider({ providerId: 'groq', apiKey: 'b' });
  global.fetch = realFetch;
  const order = service.recoveryOrder('groq');
  assert.equal(order[0], 'groq');
  assert(order.includes('gemini'));
});

/* ---------------- abort plumbing ---------------- */
okAsync('pipeline: abortRequest cancels an in-flight request', async () => {
  requestManager.resetCircuits();
  global.fetch = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  });
  const pending = requestManager.providerRequest({ provider: 'abort-test', baseUrl: 'https://t.example', path: '/x', body: {}, requestId: 'abort-1', timeoutMs: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requestManager.abortRequest('abort-1'), true);
  await assert.rejects(() => pending, (error) => error.category === 'CANCELLED');
  global.fetch = realFetch;
});

runTests();
