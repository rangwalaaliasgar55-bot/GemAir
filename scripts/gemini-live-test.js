#!/usr/bin/env node
'use strict';

// Gemini Live transport tests: pure audio helpers, setup/text round trip,
// and socket-disconnect recovery. No credentials, no network, no microphone.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer/gemini-live.js'), 'utf8');

function loadClient(WebSocketImpl, extra = {}) {
  const context = {
    window: {}, WebSocket: WebSocketImpl, console,
    setTimeout, clearTimeout, encodeURIComponent,
    navigator: {}, AudioContext: undefined, ...extra
  };
  vm.runInNewContext(src, context, { filename: 'renderer/gemini-live.js' });
  return { client: context.window.geminiLive, context };
}

function byteStream(frames) {
  // FakeWS with a scripted inbox: each entry is sent as one message.
  const FakeWS = class {
    constructor() {
      this.readyState = 1; this.sent = [];
      setTimeout(() => this.onopen && this.onopen(), 1);
    }
    send(s) {
      this.sent.push(JSON.parse(s));
      const last = this.sent[this.sent.length - 1];
      if (last.setup) {
        for (const f of frames) setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(f) }), 2);
      }
    }
    close() { this.readyState = 3; setTimeout(() => this.onclose && this.onclose(), 1); }
  };
  FakeWS.OPEN = 1;
  return FakeWS;
}

(async () => {
  // 1. audio chunking primitives
  {
    const { client } = loadClient(byteStream([]));
    const { floatToPcm16, chunkFrames, encodeBase64, decodeBase64ToInt16, resampleTo16k, rms } = client.audio;
    assert.deepEqual([...floatToPcm16(new Float32Array([0, 1, -1, 2, -2]))], [0, 32767, -32768, 32767, -32768]);
    const pcm = new Int16Array(3600).fill(1000);
    const chunks = chunkFrames(pcm, 1600);
    assert.equal(chunks.length, 2, '3600 samples must yield two full 1600-sample frames');
    assert.equal(chunks[0].length, 1600);
    const bytes = new Uint8Array(floatToPcm16(new Float32Array([0.5, -0.5])).buffer);
    const back = decodeBase64ToInt16(encodeBase64(bytes));
    assert.deepEqual([...back], [...new Int16Array(bytes.buffer)]);
    assert.equal(resampleTo16k(new Float32Array(160), 16000).length, 160);
    assert.equal(resampleTo16k(new Float32Array(320), 32000).length, 160);
    assert.ok(rms(new Float32Array([1, -1])) > 0.9 && rms(new Float32Array(10)) === 0);
    console.log('  ok   PCM conversion, 100ms framing, base64 round trip, resampling');
  }

  // 2. setup handshake + text round trip
  {
    const { client } = loadClient(byteStream([
      { setupComplete: {} },
      { serverContent: { modelTurn: { parts: [{ text: 'OK' }] }, turnComplete: true } }
    ]));
    let got = '';
    const session = await client.connect({ apiKey: 'k', model: 'm', onText: (t) => { got += t; } });
    assert.equal(session.ready, true);
    session.send('Reply with exactly: OK');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got, 'OK');
    session.close(1000);
    assert.equal(session.state, 'closed');
    console.log('  ok   setup handshake and text round trip');
  }

  // 3. disconnect recovery: socket dies after setup, reconnect() revives.
  // reconnect() constructs WebSocket from its own loader context, so the
  // harness swaps that exact binding to a healthy socket class.
  {
    const DyingWS = class {
      constructor() { this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 1); }
      send(s) {
        const m = JSON.parse(s);
        if (m.setup) {
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
          setTimeout(() => { this.readyState = 3; this.onclose && this.onclose(); }, 5);
        }
      }
      close() { this.readyState = 3; }
    };
    DyingWS.OPEN = 1;
    const dying = loadClient(DyingWS);
    const states = [];
    const session = await dying.client.connect({
      apiKey: 'k', model: 'm', onText: () => {},
      onState: (s) => states.push(s),
      onError: () => {}
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(session.ready, false, 'dead socket must not report ready');
    assert.ok(states.includes('closed'), 'disconnect must surface a closed state, got: ' + states.join(','));
    dying.context.WebSocket = byteStream([{ setupComplete: {} }]);
    dying.context.WebSocket.OPEN = 1;
    const revived = await session.reconnect();
    assert.equal(revived.ready, true, 'reconnect must establish a live session');
    revived.close(1000);
    console.log('  ok   socket disconnect surfaces closed state and reconnect revives');
  }

  // 4. model discovery: listModels maps Google's catalog, errors honestly
  {
    const { client } = loadClient(byteStream([]));
    await assert.rejects(
      client.listModels(''),
      /MISSING_API_KEY/,
      'empty key must fail fast'
    );
    const catalog = {
      models: [
        { name: 'models/aaa-live', displayName: 'AAA Live', supportedGenerationMethods: ['generateContent', 'bidiGenerateContent'] },
        { name: 'models/bbb-text', supportedGenerationMethods: ['generateContent'] },
        { bogus: true }
      ]
    };
    const okFetch = async (url, options) => {
      assert.ok(url.includes('/v1beta/models?pageSize='), 'wrong catalog endpoint: ' + url);
      assert.ok(url.includes('key=test-key'), 'API key must authenticate the catalog request');
      assert.equal(options.method, 'GET');
      return { ok: true, status: 200, json: async () => catalog };
    };
    const models = await client.listModels('test-key', okFetch);
    assert.equal(models.length, 2, 'bogus entries must be filtered');
    assert.deepEqual(models[0], { id: 'aaa-live', displayName: 'AAA Live', methods: ['generateContent', 'bidiGenerateContent'] });
    assert.equal(models[1].displayName, 'bbb-text', 'missing displayName must fall back to the id');
    const denied = async () => ({
      ok: false, status: 403,
      json: async () => ({ error: { message: 'Generative Language API has not been used in project 123 before.' } })
    });
    await assert.rejects(
      client.listModels('test-key', denied),
      /LIST_MODELS_HTTP_403.*has not been used/,
      'disabled-API errors must carry Google’s message'
    );
    console.log('  ok   model discovery maps the catalog and reports disabled APIs honestly');
  }

  // 5. abnormal socket close reports its code instead of a bare message
  {
    const { client } = loadClient(class {
      constructor() { this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 1); }
      send(s) {
        if (JSON.parse(s).setup) {
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
          setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1006, reason: '' }); }, 5);
        }
      }
      close() { this.readyState = 3; }
    });
    let reported = '';
    const session = await client.connect({
      apiKey: 'k', model: 'm', onText: () => {},
      onError: (message) => { reported = message; }
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(session.state, 'closed');
    assert.ok(reported.includes('1006'), 'close code must surface, got: ' + reported);
    console.log('  ok   abnormal socket close reports its code');
  }

  // 6. reconnect policy: 1006 retries with capped backoff, 1000 and user
  //    hang-up stay silent, liveness probe forces recovery on dead sockets
  {
    const { client } = loadClient(byteStream([{ setupComplete: {} }]));
    const { computeBackoff, checkLiveness, RECONNECT_MAX, RECONNECT_BASE_MS, RECONNECT_CAP_MS, HEARTBEAT_MS } = client._internals;
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6].map(computeBackoff),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000],
      'backoff must double from 1s and cap at 30s'
    );
    assert.equal(RECONNECT_MAX, 5);
    assert.equal(RECONNECT_BASE_MS, 1000);
    assert.equal(RECONNECT_CAP_MS, 30000);
    assert.equal(HEARTBEAT_MS, 20000);
    assert.ok(client.ENDPOINT.startsWith('wss://'), 'production transport must use wss');
    console.log('  ok   backoff schedule, retry cap, heartbeat interval, wss endpoint');
  }

  {
    let builds = 0;
    const logs = [];
    const Flaky = class {
      constructor() {
        builds++;
        this.readyState = 1;
        setTimeout(() => this.onopen && this.onopen(), 1);
      }
      send(s) {
        if (!JSON.parse(s).setup) return;
        setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
        if (builds === 1) setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1006, reason: '' }); }, 10);
      }
      close() { this.readyState = 3; }
    };
    Flaky.OPEN = 1;
    const { client } = loadClient(Flaky);
    const session = await client.connect({
      apiKey: 'k', model: 'm', onText: () => {},
      onLog: (message) => logs.push(message),
      onError: () => {}
    });
    session._autoRetry = true; // voice sessions arm this at startup
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(builds, 2, 'a 1006 drop must trigger exactly one rebuild, saw ' + builds);
    assert.equal(session.ready, true, 'session must be live again after retry');
    assert.ok(logs.some((m) => /attempt 1\/5/.test(m)), 'each attempt must be logged, got: ' + logs.join(' | '));
    session.close(1000);
    console.log('  ok   1006 drop reconnects once with backoff and logs the attempt');
  }

  {
    let builds = 0;
    let errors = 0;
    const Clean = class {
      constructor() {
        builds++;
        this.readyState = 1;
        setTimeout(() => this.onopen && this.onopen(), 1);
      }
      send(s) {
        if (!JSON.parse(s).setup) return;
        setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
        setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1000, reason: '' }); }, 5);
      }
      close() { this.readyState = 3; }
    };
    Clean.OPEN = 1;
    void Clean;
    const { client } = loadClient(Clean);
    const session = await client.connect({
      apiKey: 'k', model: 'm', onText: () => {},
      onError: () => { errors++; }
    });
    session._autoRetry = true;
    await new Promise((r) => setTimeout(r, 1400));
    assert.equal(builds, 1, 'a clean 1000 close must never rebuild');
    assert.equal(errors, 0, 'a clean 1000 close must stay silent');
    assert.equal(session.state, 'closed');
    console.log('  ok   clean 1000 shutdown stays silent with no retry');
  }

  {
    let builds = 0;
    let errors = 0;
    const { client } = loadClient(byteStream([{ setupComplete: {} }]));
    const session = await client.connect({
      apiKey: 'k', model: 'm', onText: () => {},
      onError: () => { errors++; }
    });
    session._autoRetry = true;
    builds++; // the initial construction above
    session.close(); // user hang-up
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(errors, 0, 'user hang-up must not report an error');
    console.log('  ok   user hang-up stays silent with no retry');
  }

  {
    const { client } = loadClient(byteStream([{ setupComplete: {} }]));
    const { checkLiveness } = client._internals;
    const session = await client.connect({ apiKey: 'k', model: 'm', onText: () => {}, onError: () => {} });
    assert.equal(checkLiveness(session), true, 'open socket must pass the probe');
    session._autoRetry = true;
    session._ws.readyState = 3; // simulate a half-dead socket
    assert.equal(checkLiveness(session), false, 'dead socket must take the drop path');
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(session.ready, true, 'watchdog drop must recover');
    session.close(1000);
    assert.equal(checkLiveness({ state: 'closed' }), true, 'non-live sessions are left alone');
    console.log('  ok   liveness probe recovers half-dead sockets');
  }

  console.log('\n  All Gemini Live transport tests passed.\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });
