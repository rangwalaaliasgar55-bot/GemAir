#!/usr/bin/env node
'use strict';

const assert = require('assert');
const codex = require('../lib/chatgpt-codex');
const { selectRelevantTools } = require('../lib/tool-router');

function jwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.${Buffer.from('signature-is-long-enough-for-tests').toString('base64url')}`;
}

function sse(events, splits = []) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = Buffer.from(text);
  const chunks = [];
  let offset = 0;
  for (const size of splits) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.subarray(offset));
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const accountId = 'acct_gemair_test';
const accessToken = jwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' }
});

(async () => {
  // 1. Direct Responses transport: account header, model gate, native tools,
  // stateless/reasoning normalization, and chunk-safe SSE parsing.
  {
    let seen;
    const fetch = async (url, options) => {
      seen = { url: String(url), options, body: JSON.parse(String(options.body)) };
      return sse([
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: '🌍' },
        { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello 🌍' }] }] } }
      ], [11, 17, 3, 29]);
    };
    const chunks = [];
    const result = await codex.callCodexResponses({
      fetch, accessToken, accountId, model: 'gpt-test',
      instructions: 'Be useful.',
      input: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: {} } } }],
      onDelta: (delta) => chunks.push(delta)
    });
    const headers = new Headers(seen.options.headers);
    assert.match(seen.url, /chatgpt\.com\/backend-api\/codex\/responses/);
    assert.match(seen.url, /client_version=/);
    assert.equal(headers.get('authorization'), `Bearer ${accessToken}`);
    assert.equal(headers.get('chatgpt-account-id'), accountId);
    assert.equal(seen.body.store, false);
    assert.equal(seen.body.reasoning.effort, 'medium');
    assert.ok(seen.body.include.includes('reasoning.encrypted_content'));
    assert.equal(seen.body.tools[0].name, 'get_weather');
    assert.equal(seen.body.tools[0].function, undefined);
    assert.equal(result.text, 'Hello 🌍');
    assert.equal(chunks.join(''), 'Hello 🌍');
    console.log('  ok   Codex request normalization, auth boundary, native tools, and SSE');
  }

  // The retired free-chatgpt entry point remains a side-effect-free facade and
  // must still pass its prompt into the Responses payload.
  {
    const legacy = require('../lib/free-chatgpt');
    let input;
    const answer = await legacy.ask('Facade prompt', { accessToken, accountId, selectedModel: 'gpt-test' }, {
      fetch: async (_url, options) => {
        input = JSON.parse(String(options.body)).input;
        return sse([
          { type: 'response.output_text.delta', delta: 'Facade answer.' },
          { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Facade answer.' }] }] } }
        ]);
      }
    });
    assert.equal(input[0].content, 'Facade prompt');
    assert.equal(answer, 'Facade answer.');
    console.log('  ok   compatibility facade is inert and forwards the prompt');
  }

  // 2. Native function-call loop carries output + encrypted reasoning and
  // returns real tool results in a bounded follow-up request.
  {
    const bodies = [];
    let call = 0;
    const fetch = async (_url, options) => {
      bodies.push(JSON.parse(String(options.body)));
      call += 1;
      if (call === 1) {
        return sse([{ type: 'response.completed', response: { output: [
          { id: 'rs_1', type: 'reasoning', encrypted_content: 'opaque' },
          { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'calculate', arguments: '{"expression":"2+2"}' }
        ] } }]);
      }
      return sse([
        { type: 'response.output_text.delta', delta: 'Four.' },
        { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Four.' }] }] } }
      ]);
    };
    const runs = [];
    const result = await codex.runCodexAgent({
      fetch, accessToken, accountId, model: 'gpt-test',
      messages: [{ role: 'system', content: 'Helpful.' }, { role: 'user', content: 'What is 2+2?' }],
      tools: [{ type: 'function', function: { name: 'calculate', description: 'Math', parameters: { type: 'object', properties: {} } } }],
      executeTool: async (name, args) => { runs.push({ name, args }); return { value: 4 }; }
    });
    assert.equal(result.text, 'Four.');
    assert.equal(result.rounds, 2);
    assert.deepEqual(runs, [{ name: 'calculate', args: { expression: '2+2' } }]);
    assert.ok(bodies[1].input.some((item) => item.type === 'reasoning' && item.encrypted_content === 'opaque'));
    assert.ok(bodies[1].input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1' && item.output.includes('4')));
    assert.ok(!bodies[1].input.some((item) => item.id), 'server ids must be stripped for stateless requests');
    console.log('  ok   native function loop carries reasoning and tool output');
  }

  // 3. Device coordinator stores pending secrets in memory, honors cadence,
  // and exchanges only after the user has authorized.
  {
    let current = 1000;
    let polls = 0;
    const fakeSdk = {
      requestDeviceCode: async () => ({ deviceAuthId: 'private-device-id', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device', interval: 5, expiresAt: current + 900000 }),
      pollDeviceCode: async () => (++polls < 2 ? { status: 'pending' } : { status: 'authorized', authorizationCode: 'code', codeVerifier: 'verifier', codeChallenge: 'challenge' }),
      exchangeDeviceAuthorization: async () => ({ accessToken, refreshToken: 'refresh-token-that-is-long-enough', accountId }),
      parseUser: () => ({ accountId, email: 'me@example.com', plan: 'plus' }),
      deriveAccountId: () => accountId
    };
    const manager = codex.createDeviceLoginManager({
      now: () => current,
      loadSdk: async () => fakeSdk,
      config: { fetch: async () => {} }
    });
    const start = await manager.begin();
    assert.equal(start.userCode, 'ABCD-1234');
    assert.equal(JSON.stringify(start).includes('private-device-id'), false, 'device auth id crossed the public boundary');
    let result = await manager.poll(start.loginId);
    assert.equal(result.status, 'pending');
    result = await manager.poll(start.loginId);
    assert.equal(result.status, 'pending');
    assert.equal(polls, 1, 'poll cadence was not enforced');
    current += 5000;
    result = await manager.poll(start.loginId);
    assert.equal(result.status, 'authenticated');
    assert.equal(result.user.email, 'me@example.com');

    // An overlapping renderer timer must not create a second network poll, and
    // cancelling while the first poll is pending must prevent token exchange.
    let releasePoll;
    let slowPolls = 0;
    let exchanges = 0;
    const slowSdk = {
      ...fakeSdk,
      pollDeviceCode: async () => {
        slowPolls += 1;
        return new Promise((resolve) => { releasePoll = resolve; });
      },
      exchangeDeviceAuthorization: async () => { exchanges += 1; return { accessToken, accountId }; }
    };
    const slowManager = codex.createDeviceLoginManager({ now: () => current, loadSdk: async () => slowSdk, config: {} });
    const slowStart = await slowManager.begin();
    const firstPoll = slowManager.poll(slowStart.loginId);
    const overlap = await slowManager.poll(slowStart.loginId);
    assert.equal(overlap.status, 'pending');
    assert.equal(slowPolls, 1);
    slowManager.cancel(slowStart.loginId);
    releasePoll({ status: 'authorized', authorizationCode: 'code' });
    assert.equal((await firstPoll).status, 'cancelled');
    assert.equal(exchanges, 0);
    console.log('  ok   device login state machine, cancellation, and server cadence');
  }

  // 4. Context-aware routing keeps a utility core and relevant desktop tools,
  // but does not dump the entire 98-tool catalog into each model turn.
  {
    const tools = Array.from({ length: 50 }, (_, index) => ({
      type: 'function', function: { name: `unused_${index}`, description: `Unrelated utility ${index}`, parameters: { type: 'object', properties: {} } }
    }));
    tools.push(
      { type: 'function', function: { name: 'web_search', description: 'Search current web', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'search_memory', description: 'Search memory', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'mouse_click', description: 'Click the desktop mouse', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'capture_agent_screen', description: 'Capture desktop screen', parameters: { type: 'object', properties: {} } } }
    );
    const selected = selectRelevantTools(tools, [{ role: 'user', content: 'Capture the screen and click the button.' }], { limit: 12 });
    const names = selected.map((tool) => tool.function.name);
    assert.ok(names.includes('mouse_click'));
    assert.ok(names.includes('capture_agent_screen'));
    assert.ok(names.includes('web_search'));
    assert.ok(names.includes('search_memory'));
    assert.equal(selected.length, 12);
    console.log('  ok   context-aware tool routing limits context without losing intent');
  }

  console.log('\n  All ChatGPT Codex integration tests passed.\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });
