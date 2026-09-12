'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');
const { after, before, test } = require('node:test');

const sidecar = require('../lib/freegpt35-sidecar');
const protocol = require('../sidecars/freegpt35/server');

let upstream;
let upstreamUrl;
const observed = { requirements: [], conversations: [] };

function snapshot(content, status = 'in_progress') {
  return JSON.stringify({
    message: {
      status,
      content: { parts: [content] },
      metadata: status === 'finished_successfully' ? { finish_details: { type: 'stop' } } : {}
    }
  });
}

before(async () => {
  upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    if (request.url === '/backend-anon/sentinel/chat-requirements') {
      observed.requirements.push({ headers: request.headers, body: text });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ token: 'requirements-token', proofofwork: { seed: 'test-seed', difficulty: 'ff' } }));
      return;
    }
    if (request.url === '/backend-api/conversation') {
      const body = JSON.parse(text || '{}');
      observed.conversations.push({ headers: request.headers, body });
      const prompt = (((body.messages || []).at(-1) || {}).content || {}).parts?.[0] || '';
      if (prompt === 'upstream-error') {
        response.writeHead(503, { 'content-type': 'text/plain' });
        response.end('deliberate upstream failure');
        return;
      }
      if (prompt === 'timeout') {
        setTimeout(() => {
          if (response.destroyed) return;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${snapshot('too late', 'finished_successfully')}\n\n`);
        }, 500);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${snapshot('Hel')}\n\n`);
      response.write(`data: ${snapshot('Hel')}\n\n`); // repeated cumulative frame
      response.write(`data: ${snapshot('He')}\n\n`); // regression must not be emitted
      response.write(`data: ${snapshot('Hello')}\n\n`);
      response.end(`data: ${snapshot('Hello world', 'finished_successfully')}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  sidecar.stop();
  await new Promise((resolve) => upstream.close(resolve));
});

test('proof token and request conversion preserve FreeGPT35 protocol behavior', () => {
  const proof = protocol.generateProofToken('seed', 'ff', 'GemAir Test');
  assert.match(proof, /^gAAAAAB/);
  const body = protocol.conversationBody([{ role: 'user', content: 'hello' }]);
  assert.equal(body.model, 'text-davinci-002-render-sha');
  assert.equal(body.history_and_training_disabled, true);
  assert.equal(body.messages[0].content.parts[0], 'hello');
  assert.equal(protocol.assistantSnapshot(snapshot('done', 'finished_successfully')).content, 'done');
  assert.throws(() => protocol.validateMessages([]), /non-empty/);
  assert.throws(() => protocol.validateMessages([{ role: 'tool', content: 'x' }]), /unsupported/);
});

test('sidecar requires bearer authentication even on loopback', async () => {
  const script = path.join(__dirname, '..', 'sidecars', 'freegpt35', 'server.js');
  const token = 'test-bearer-token-with-sufficient-entropy';
  const child = fork(script, [], {
    silent: true,
    env: { ...process.env, NODE_ENV: 'test', SERVER_PORT: '0', FREEGPT35_BASE_URL: upstreamUrl, GEMAIR_SIDECAR_TOKEN: token }
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not start')), 5000);
    child.once('message', (message) => { clearTimeout(timer); resolve(message); });
    child.once('error', reject);
  });
  try {
    const url = `http://127.0.0.1:${ready.port}/health`;
    assert.equal((await fetch(url)).status, 401);
    const authorized = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).tlsVerification, true);
  } finally {
    child.send({ type: 'shutdown' });
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('manager handles non-streaming and cumulative-to-delta streaming completions', async () => {
  await sidecar.start({
    baseUrl: upstreamUrl,
    test: true,
    environment: { FREEGPT35_REQUEST_TIMEOUT_MS: '100', NEW_SESSION_RETRIES: '0' }
  });
  const plain = await sidecar.chat([{ role: 'user', content: 'plain' }]);
  assert.equal(plain.reply, 'Hello world');
  assert.equal(plain.provider, 'FreeGPT35');

  const deltas = [];
  const streamed = await sidecar.chat([{ role: 'user', content: 'stream' }], { onDelta: (delta) => deltas.push(delta) });
  assert.equal(streamed.reply, 'Hello world');
  assert.deepEqual(deltas, ['Hel', 'lo', ' world']);

  const conversation = observed.conversations.at(-1);
  assert.equal(conversation.headers['openai-sentinel-chat-requirements-token'], 'requirements-token');
  assert.match(conversation.headers['openai-sentinel-proof-token'], /^gAAAAAB/);
  assert.ok(conversation.headers['oai-device-id']);
});

test('upstream failures and deadlines are surfaced without disabling TLS', async () => {
  await assert.rejects(
    sidecar.chat([{ role: 'user', content: 'upstream-error' }], { timeoutMs: 2000 }),
    /FREEGPT35_CHAT_HTTP_503/
  );
  await assert.rejects(
    sidecar.chat([{ role: 'user', content: 'timeout' }], { timeoutMs: 2000 }),
    /TIMEOUT|aborted|fetch failed/i
  );
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

test('manager lifecycle shuts down and can restart cleanly', async () => {
  assert.equal(sidecar.publicStatus().running, true);
  sidecar.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sidecar.publicStatus().running, false);
  const health = await sidecar.health({ startOptions: { baseUrl: upstreamUrl, test: true, environment: { NEW_SESSION_RETRIES: '0' } } });
  assert.equal(health.running, true);
  assert.equal(health.tlsVerification, true);
});
