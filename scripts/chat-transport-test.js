#!/usr/bin/env node
'use strict';

// No credentials or network required. Exercise the actual handler and browser
// client with Fetch streams fragmented at every byte, not line-shaped mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'api/chat.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'renderer/ai-client.js'), 'utf8');
const messages = [{ role: 'user', content: 'Hello' }];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const frame = (data) => 'data: ' + JSON.stringify(data) + '\r\n\r\n';
function stream(text) {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index));
      else controller.close();
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function handler(env = {}, fetch = () => { throw new Error('Unexpected network request'); }) {
  const context = {
    module: { exports: {} }, process: { env }, Buffer, fetch,
    AbortController, TextDecoder, setTimeout, clearTimeout,
    require(name) {
      assert.equal(name, './_lib/http');
      return { ...require('../api/_lib/http'), env: (key) => env[key] || '' };
    }
  };
  vm.runInNewContext(serverSource, context, { filename: 'api/chat.js' });
  return context.module.exports;
}
let ip = 0;
async function invoke(handle, body = { messages }, identity = 'test-' + ++ip) {
  const headers = {};
  const res = {
    statusCode: 200, text: '', ended: false,
    setHeader(key, value) { headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    writeHead(code, values) { this.statusCode = code; Object.assign(headers, values); },
    write(text) { this.text += text; },
    end() { this.ended = true; return this; },
    json(data) { headers['Content-Type'] = 'application/json'; this.data = data; this.text = JSON.stringify(data); return this.end(); }
  };
  await handle({ method: 'POST', headers: { 'x-real-ip': identity }, body }, res);
  assert.equal(res.ended, true);
  return { ...res, response: () => new Response(res.text, { status: res.statusCode, headers }) };
}
function client(fetch, extra = {}) {
  const context = { window: {}, fetch, TextDecoder, ReadableStream, AbortController, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(clientSource, context, { filename: 'renderer/ai-client.js' });
  return context.window.aiClient;
}

(async () => {
  for (const streaming of [false, true]) {
    const res = await invoke(handler(), { messages, stream: streaming });
    assert.equal(res.statusCode, 503);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.error, 'NO_PROVIDERS_CONFIGURED');
    assert.match(res.data.message, /GROQ_API_KEY/);
    assert.equal(res.data.reply, undefined);
  }
  console.log('ok - absent credentials never return JSON or SSE success');

  const success = async () => json({ choices: [{ message: { content: 'Real response' } }] });
  const limited = handler({ GROQ_API_KEY: 'g', FAIR_USE_DAILY: '1', THROTTLE_PER_MIN: '100' }, success);
  assert.equal((await invoke(limited, { messages }, 'limited')).data.ok, true);
  const daily = await invoke(limited, { messages }, 'limited');
  assert.equal(daily.statusCode, 429);
  assert.equal(daily.data.error, 'DAILY_LIMIT_REACHED');
  assert.equal(daily.data.ok, false);
  const throttled = handler({ GROQ_API_KEY: 'g', THROTTLE_PER_MIN: '1' }, success);
  await invoke(throttled, { messages }, 'throttled');
  const rate = await invoke(throttled, { messages }, 'throttled');
  assert.equal(rate.statusCode, 429);
  assert.equal(rate.data.error, 'RATE_LIMITED');
  assert.equal(rate.data.ok, false);
  console.log('ok - fair-use and throttle limits return truthful 429 errors');

  for (const streaming of [false, true]) {
    for (const status of [401, 429, 500]) {
      const res = await invoke(handler({ GROQ_API_KEY: 'secret' }, async () => json({ error: 'secret upstream details' }, status)), { messages, stream: streaming });
      assert.equal(res.statusCode, 503);
      assert.equal(res.data.ok, false);
      assert.equal(res.data.error, 'PROVIDERS_UNAVAILABLE');
      assert.equal(res.data.attempts[0].status, status);
      assert.equal(res.data.attempts[0].provider, 'groq');
      assert.equal(res.text.includes('secret'), false);
    }
    const res = await invoke(handler({ GROQ_API_KEY: 'secret' }, async () => { throw new Error('offline'); }), { messages, stream: streaming });
    assert.equal(res.data.ok, false);
  }
  console.log('ok - upstream authentication, quota, outage and network errors are structured');

  const rotation = handler({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, async (url) => url.includes('groq')
    ? json({}, 401) : json({ model: 'actual-openai-model', choices: [{ message: { content: 'Real completion' } }] }));
  const rotated = await invoke(rotation);
  assert.equal(rotated.data.provider, 'openai');
  assert.equal(rotated.data.model, 'actual-openai-model');
  assert.equal(rotated.data.free, false);
  console.log('ok - real fallback reports the responding provider/model');

  const delta = { model: 'actual-model', choices: [{ delta: { content: 'Hi \u{1f30d}' } }] };
  const upstream = ': heartbeat\r\n\r\n' + frame(delta) + 'data: [DONE]';
  const res = await invoke(handler({ GROQ_API_KEY: 'g' }, async () => stream(upstream)), { messages, stream: true });
  assert.equal(res.statusCode, 200);
  const deltas = [];
  const ai = client(async (url, options) => {
    assert.equal(url, '/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    assert.equal(body.userId, 'user-1');
    return stream(res.text);
  });
  const result = await ai.serverChat(messages, (text, meta) => deltas.push({ text, meta }), { userId: 'user-1' });
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'Hi \u{1f30d}');
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'actual-model');
  assert.equal(result.via, 'server');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].meta.model, 'actual-model');
  console.log('ok - backend/client round trip handles byte-split UTF-8, CRLF and EOF framing');

  const multiline = 'event: message\ndata: {"delta":"hello",\ndata: "provider":"groq","model":"m"}\n\n' + frame({ done: true, reply: 'hello', provider: 'groq', model: 'm' });
  assert.equal((await client(async () => stream(multiline)).serverChat(messages, () => {})).reply, 'hello');
  for (const ending of ['', 'data: {bad}\n\n', frame({ error: 'UPSTREAM_FAILED', message: 'Retry later', ok: false }), 'event: error\ndata: {"message":"broken"}\n\n']) {
    const out = await client(async () => stream(frame({ delta: 'partial', provider: 'groq', model: 'm' }) + ending)).serverChat(messages, () => {});
    assert.equal(out.ok, false);
    assert.equal(out.partialReply, 'partial');
    assert.equal(out.reply, undefined);
    assert.equal(out.provider, 'groq');
  }
  assert.equal((await client(async () => stream(frame({ done: true }))).serverChat(messages, () => {})).ok, false);
  console.log('ok - multiline events, malformed/error frames and truncated/empty streams');

  let calls = 0;
  const interrupted = await invoke(handler({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, async () => { calls++; return stream(frame(delta)); }), { messages, stream: true });
  const incomplete = await client(async () => stream(interrupted.text)).serverChat(messages, () => {});
  assert.equal(calls, 1, 'must not rotate after emitting partial content');
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error, 'STREAM_INTERRUPTED');
  assert.equal(interrupted.text.includes('"done":true'), false);
  console.log('ok - upstream truncation is not blessed or spliced with another provider');

  const namedError = await invoke(handler({ GROQ_API_KEY: 'g' }, async () => stream(frame(delta) + 'event: error\ndata: {"message":"broken"}\n\ndata: [DONE]\n\n')), { messages, stream: true });
  assert.equal(namedError.text.includes('"done":true'), false);
  assert.equal((await client(async () => stream(namedError.text)).serverChat(messages, () => {})).ok, false);

  const gateway = await invoke(handler({ AI_BASE_URL: 'http://localhost:11434/v1', AI_MODEL: 'local' }, async () => json({ model: 'actual-local', choices: [{ message: { content: 'JSON reply' } }] })), { messages, stream: true });
  assert.equal((await client(async () => stream(gateway.text)).serverChat(messages, () => {})).model, 'actual-local');
  const chunks = [];
  const nonstream = await client(async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, false);
    return json({ ok: true, reply: 'Full JSON reply', provider: 'openai', model: 'm' });
  }).serverChat(messages, (text) => chunks.push(text), { stream: false });
  assert.equal(nonstream.ok, true);
  assert.deepEqual(chunks, ['Full JSON reply']);
  const noStreams = client(async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, false);
    return json({ ok: true, reply: 'Full reply', provider: 'groq', model: 'm' });
  }, { ReadableStream: undefined });
  assert.equal((await noStreams.serverChat(messages, () => {})).ok, true);
  const httpError = await client(async () => json({ ok: false, error: 'RATE_LIMITED', message: 'Retry later', retryAfter: 5 }, 429)).serverChat(messages);
  assert.equal(httpError.ok, false);
  assert.equal(httpError.status, 429);
  assert.equal(httpError.retryAfter, 5);
  assert.equal((await client(async () => new Response('<html>bad gateway</html>', { status: 502 })).serverChat(messages)).ok, false);
  console.log('ok - JSON fallback is one real completion; HTTP errors remain failures');

  const config = { apiKey: 'key', baseURL: 'https://selected.example/v1', model: 'selected' };
  calls = 0;
  const direct = client(async () => { calls++; return json({ error: { message: 'Invalid key' } }, 401); });
  const failed = await direct.directClientChat(config, messages);
  assert.equal(failed.ok, false);
  assert.equal(failed.via, 'direct');
  assert.equal(failed.provider, config.baseURL);
  assert.equal(calls, 1);
  assert.equal((await direct.directClientChat({}, messages)).error, 'NO_KEY');
  assert.equal((await client(async () => stream(frame(delta))).directClientChat(config, messages, () => {})).ok, false);
  assert.equal((await client(async () => stream(upstream)).directClientChat(config, messages, () => {})).model, 'actual-model');
  assert.equal((await client(async () => json({ choices: [] })).directClientChat(config, messages)).ok, false);
  console.log('ok - direct failures do not trigger fallback or appear successful');

  const hangingFetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    const fail = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  assert.equal((await client(hangingFetch).serverChat(messages, null, { timeoutMs: 5 })).error, 'TIMEOUT');
  const controller = new AbortController();
  controller.abort();
  assert.equal((await client(hangingFetch).serverChat(messages, null, { signal: controller.signal })).error, 'ABORTED');
  console.log('ok - deadline and caller cancellation return explicit failures');
  console.log('All focused chat transport tests passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
