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

  console.log('\n  All Gemini Live transport tests passed.\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });
