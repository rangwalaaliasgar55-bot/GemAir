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
      // Header, not query string — see listModels().
      assert.ok(!/key=/.test(url), 'the catalog request must not carry the key in the URL: ' + url);
      assert.equal((options.headers || {})['x-goog-api-key'], 'test-key', 'API key must authenticate the catalog request via x-goog-api-key');
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

  // -------------------------------------------------------------------------
  // 2.12 long-horizon live sessions (session resumption + sliding-window
  // compression + transcriptions + interruption), added with the Mark-heritage
  // voice-loop upgrade.
  // -------------------------------------------------------------------------

  // L1. setup carries the long-horizon fields by default
  {
    let sentSetup = null;
    const CaptureWS = class {
      constructor() { this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 1); }
      send(s) {
        const m = JSON.parse(s);
        if (m.setup && !sentSetup) {
          sentSetup = m.setup;
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
        }
      }
      close() { this.readyState = 3; }
    };
    CaptureWS.OPEN = 1;
    const { client } = loadClient(CaptureWS);
    const session = await client.connect({ apiKey: 'k', model: 'm' });
    assert(sentSetup, 'setup frame sent');
    assert(sentSetup.context_window_compression && sentSetup.context_window_compression.sliding_window, 'sliding-window context compression on by default');
    assert(sentSetup.session_resumption && typeof sentSetup.session_resumption === 'object', 'session resumption offered by default');
    assert(!('handle' in sentSetup.session_resumption), 'fresh session must not invent a resumption handle');
    session.close(1000);
    console.log('  ok   setup offers sliding-window compression + session resumption');
  }

  // L2. server handle is stashed, reported, and re-attached on reconnect
  {
    const DyingWS = class {
      constructor() { this.readyState = 1; this.sent = []; setTimeout(() => this.onopen && this.onopen(), 1); }
      send(s) {
        const m = JSON.parse(s);
        this.sent.push(m);
        if (m.setup) {
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: 'handle-abc', resumable: true } }) }), 2);
          setTimeout(() => { this.readyState = 3; this.onclose && this.onclose(); }, 5);
        }
      }
      close() { this.readyState = 3; }
    };
    DyingWS.OPEN = 1;
    const harness = loadClient(DyingWS);
    let reported = null;
    const session = await harness.client.connect({ apiKey: 'k', model: 'm', onResumption: (h) => { reported = h; }, onError: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reported, 'handle-abc', 'resumption handle reported to the caller');
    assert.equal(session._resumptionHandle, 'handle-abc', 'handle stashed on the session');

    const SuccessWS = class {
      constructor() { this.readyState = 1; this.sent = []; setTimeout(() => this.onopen && this.onopen(), 1); }
      send(s) {
        const m = JSON.parse(s);
        this.sent.push(m);
        if (m.setup) setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
      }
      close() { this.readyState = 3; }
    };
    SuccessWS.OPEN = 1;
    let refreshed = null;
    const HolderWS = class extends SuccessWS {
      constructor() { super(); refreshed = this; }
    };
    HolderWS.OPEN = 1;
    harness.context.WebSocket = HolderWS;
    await session.reconnect();
    const setupMsg = refreshed.sent.find((m) => m.setup);
    assert(setupMsg, 'reconnect sent a setup frame');
    assert(setupMsg.setup.session_resumption && setupMsg.setup.session_resumption.handle === 'handle-abc', 'reconnect re-attaches the stashed resumption handle');
    session.close(1000);
    console.log('  ok   resumption handle reported, stashed, and re-attached on reconnect');
  }

  // L3. a server that refuses the enhanced fields gets ONE degraded retry
  {
    const attempts = [];
    const RefuseThenAllowWS = class {
      constructor() { this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 1); }
      send(s) {
        const m = JSON.parse(s);
        if (!m.setup) return;
        attempts.push(m.setup);
        if (m.setup.context_window_compression || m.setup.session_resumption) {
          // Proto-style server error: close before setupComplete.
          setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1007, reason: 'unsupported field' }); }, 1);
        } else {
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
        }
      }
      close() { this.readyState = 3; }
    };
    RefuseThenAllowWS.OPEN = 1;
    const { client } = loadClient(RefuseThenAllowWS);
    const session = await client.connect({ apiKey: 'k', model: 'm', onError: () => {} });
    assert.equal(session.ready, true, 'degraded retry still reaches live');
    assert.equal(session._degraded, true, 'session records that it degraded');
    assert.equal(attempts.length, 2, 'exactly one retry, no thrash');
    assert(attempts[0].context_window_compression, 'first attempt used the enhanced setup');
    assert(!attempts[1].context_window_compression && !attempts[1].session_resumption, 'retry stripped every enhanced field');
    session.close(1000);
    console.log('  ok   enhanced-setup refusal triggers one clean degraded retry');
  }

  // L4. goAway + interruption + output transcription events (text session)
  {
    const frames = [
      { setupComplete: {} },
      { goAway: { timeLeft: '10s' } },
      { serverContent: { interrupted: true, modelTurn: { parts: [] } } },
      { serverContent: { outputTranscription: { text: 'Cape.' }, modelTurn: { parts: [] }, turnComplete: true } }
    ];
    const { client } = loadClient(byteStream(frames));
    let wentAway = null, interruptedCount = 0, transcript = '';
    const session = await client.connect({
      apiKey: 'k', model: 'm',
      onError: () => {},
      onGoAway: (t) => { wentAway = t; },
      onInterrupted: () => { interruptedCount++; },
      onOutputTranscript: (t) => { transcript += t; }
    });
    let flushCount = 0;
    session._onInterrupted = () => { flushCount++; }; // voice layer hook: flush playback
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(wentAway, '10s', 'goAway surfaces its timeLeft to the caller');
    assert.equal(interruptedCount, 1, 'server interruption fires the UI callback');
    assert.equal(flushCount, 1, 'server interruption flushes the playback queue hook');
    assert.equal(transcript, 'Cape.', 'output transcription text streams to the caller');
    session.close(1000);
    console.log('  ok   goAway, interruption (queue flush + UI), output transcription');
  }

  // L5. sendVideoFrame envelope + readiness guard (fused live vision)
  {
    const frames = [{ setupComplete: {} }];
    const { client } = loadClient(byteStream(frames));
    const session = await client.connect({ apiKey: 'k', model: 'm' });
    const sent = session.sendVideoFrame('SkVQRw==', 'image/jpeg');
    assert.equal(sent, true, 'frame accepted on a live session');
    await new Promise((r) => setTimeout(r, 10));
    const ws = session._ws;
    const videoMsg = ws.sent.find((m) => m.realtimeInput && m.realtimeInput.video);
    assert(videoMsg, 'video frame sent as realtimeInput.video');
    assert.equal(videoMsg.realtimeInput.video.data, 'SkVQRw==');
    assert.equal(videoMsg.realtimeInput.video.mimeType, 'image/jpeg');
    assert.equal(session.sendVideoFrame('', 'image/jpeg'), false, 'empty data refused');
    session.close(1000);
    assert.equal(session.sendVideoFrame('SkVQRw=='), false, 'frame refused once the session is closed');
    console.log('  ok   sendVideoFrame: realtimeInput.video envelope + readiness guard');
  }

  // L6. applyEnhancedFields merge semantics (pure)
  {
    const { client } = loadClient(byteStream([]));
    const merge = client._internals.applyEnhancedFields;
    const healthy = { _degraded: false, _resumptionHandle: null };
    const opts = { setup: { generation_config: { response_modalities: ['AUDIO'] }, model: 'models/x' } };
    merge(healthy, opts, { audio: true });
    assert(opts.setup.output_audio_transcription, 'voice sessions request output transcription (drives lip-sync)');
    assert(!opts.setup.input_audio_transcription, 'input transcription is opt-in only');
    const withHandle = { _degraded: false, _resumptionHandle: 'h9' };
    const opts2 = { setup: {} };
    merge(withHandle, opts2, { audio: false });
    assert.equal(opts2.setup.session_resumption.handle, 'h9', 'stored handle flows into future setups');
    const degradedOpts = { setup: { context_window_compression: { sliding_window: {} }, session_resumption: {} } };
    merge({ _degraded: true, _resumptionHandle: null }, degradedOpts, { audio: true });
    assert(!degradedOpts.setup.context_window_compression && !degradedOpts.setup.session_resumption && !degradedOpts.setup.output_audio_transcription, 'degraded mode strips everything enhanced');
    // merge preserves caller-owned fields
    merge({ _degraded: false, _resumptionHandle: null }, opts, { audio: true });
    assert(opts.setup.generation_config, 'merge never clobbers caller fields');
    assert(opts.setup.model === 'models/x', 'model survives the merge');
    console.log('  ok   applyEnhancedFields merge semantics (pure)');
  }

  // L7. transcript tail de-dup — the Live API re-sends the tail of a
  // transcript across the several turn-completes a tool call produces, so
  // answers used to be logged and spoken twice (Mark-LIV fix list). Now
  // duplicates are suppressed at both the chunk and the flush level.
  {
    const frames = [
      { setupComplete: {} },
      { serverContent: { outputTranscription: { text: 'Your files are ' }, modelTurn: { parts: [] } } },
      { serverContent: { outputTranscription: { text: 'ready now.' }, modelTurn: { parts: [] }, turnComplete: true } },
      // — next turn (after a tool call) re-sends the tail verbatim:
      { serverContent: { outputTranscription: { text: 'ready now.' }, modelTurn: { parts: [] } } },
      // — and once inside a longer repeated prefix:
      { serverContent: { outputTranscription: { text: 'Your files are ready now.' }, modelTurn: { parts: [] } } },
      // — genuinely new words arrive after;
      { serverContent: { outputTranscription: { text: 'Done!' }, modelTurn: { parts: [] }, turnComplete: true } }
    ];
    const { client } = loadClient(byteStream(frames));
    const heard = [];
    const session = await client.connect({
      apiKey: 'k', model: 'm', onError: () => {},
      onOutputTranscript: (t) => heard.push(t)
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(heard, ['Your files are ', 'ready now.', 'Done!'],
      'tail re-sends across turn-completes are suppressed once (chunk level)');
    session.close(1000);
    console.log('  ok   transcript tail de-dup across turn-completes (chunk+flush level)');
  }

  // L8. a rejected resumption handle is dropped after exactly one replay —
  // an expired handle can never be re-offered on every retry and block the
  // reconnect it exists to protect (Mark-LIV fix list).
  {
    const attempts = [];
    const RefuseHandleWS = class {
      constructor() { this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 1); }
      send(s) {
        const m = JSON.parse(s);
        if (!m.setup) return;
        attempts.push(JSON.parse(JSON.stringify(m.setup)));
        if (m.setup.session_resumption && m.setup.session_resumption.handle) {
          // server refuses THIS handle: close before setupComplete
          setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1007, reason: 'handle expired' }); }, 1);
        } else {
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ setupComplete: {} }) }), 1);
        }
      }
      close() { this.readyState = 3; }
    };
    RefuseHandleWS.OPEN = 1;
    // Life 1: get live and earn a resumption handle from the server.
    const dying = loadClient(byteStream([
      { setupComplete: {} },
      { sessionResumptionUpdate: { newHandle: 'handle-will-expire', resumable: true } }
    ]));
    const sess = await dying.client.connect({ apiKey: 'k', model: 'm', onError: () => {} });
    await new Promise((r) => setTimeout(r, 40)); // resumption frame arrives after setupComplete
    assert.equal(sess._resumptionHandle, 'handle-will-expire', 'handle stashed from the server');

    // Life 2: the handle has expired server-side. reconnect() re-offers it
    // exactly once; the refusal must drop it so it never replays again.
    dying.context.WebSocket = RefuseHandleWS;
    const outcome = await Promise.resolve(sess.reconnect()).catch((e) => e);
    assert(outcome && typeof outcome.message === 'string' && !(outcome || {}).ready,
      'refused-handle attempt surfaces as a failure (cross-realm Error duck-check)');
    assert.equal(attempts.length, 1, 'the stale handle was re-offered once (as designed)');
    assert(attempts[0].session_resumption && attempts[0].session_resumption.handle === 'handle-will-expire',
      'first replay carries the stale handle');
    assert.equal(sess._resumptionHandle, null, '…then dropped forever');
    assert.equal(sess._resumeAttached, false, 'no replay pending');

    // Life 3: with the poison handle gone, the same server accepts the
    // handle-less reconnect — nothing is left to block recovery.
    const revived = await Promise.resolve(sess.reconnect()).catch((e) => e);
    assert(revived && revived.ready, 'handle-less reconnect reaches live');
    assert.equal(attempts.length, 2, 'second attempt used a clean setup');
    assert(!attempts[1].session_resumption || !attempts[1].session_resumption.handle, 'no handle replayed on the recovery');
    revived.close(1000);
    console.log('  ok   rejected resumption handle is dropped, never replayed');
  }

  console.log('\n  All Gemini Live transport tests passed.\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });
