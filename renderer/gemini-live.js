/* ============================================================
   GemAir — Gemini Live API dialog transport (renderer).

   Real-time TEXT + VOICE dialog over the documented bidirectional
   streaming endpoint. No new dependencies: native WebSocket +
   native Web Audio API only. Everything stays in the renderer;
   nothing is proxied through the main process.

   The model ID is always caller-supplied (Settings field): GemAir
   ships no hardcoded "live" model names, because live model
   availability changes and must be verified in AI Studio docs,
   not trusted from chat. An API key from
   https://aistudio.google.com/apikey is required.

   Text dialog:
     const session = await window.geminiLive.connect({
       apiKey, model,
       onText: (text, done) => {...},
       onError: (message) => {...},
       onState: (state) => {...},   // connecting | live | closed | error
       timeoutMs: 30000
     });
     session.send('Hello');
     session.reconnect();  // re-run connect() with the same options
     session.close();      // ws.close(1000) on hang-up

   Voice dialog:
     const voice = await window.geminiLive.startVoice({
       apiKey, model,
       onText, onError, onState,
       onLevel: ({ in: 0..1, out: 0..1 }) => {...},  // meter callbacks
       vadThreshold: 0.02,   // input RMS that counts as "user speaking"
       timeoutMs: 30000
     });
     voice.send('Hello');  // typed injection into the live dialog
     voice.close();        // stops mic + playback, ws.close(1000)

   Audio contract (per Live API spec):
     mic  -> 16-bit PCM, 16 kHz, mono, little-endian, 100 ms frames
              (1600 samples), base64 in realtimeInput.audio
     spkr <- 16-bit PCM, 24 kHz, mono, little-endian base64 in
              serverContent.modelTurn.parts[].inlineData.data
   ============================================================ */
'use strict';

(function () {
  const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  const MIC_RATE = 16000;
  const MIC_FRAME = 1600; // 100 ms @ 16 kHz
  const OUT_RATE = 24000;

  // --- pure helpers (DOM-free; unit-tested in scripts/gemini-live-test.js) ---
  function floatToPcm16(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    return out;
  }

  function chunkFrames(pcm, size) {
    const chunks = [];
    for (let i = 0; i + size <= pcm.length; i += size) chunks.push(pcm.slice(i, i + size));
    return chunks;
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function encodeBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=');
    }
    return s;
  }

  function decodeBase64ToInt16(b64) {
    const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
    const bytes = [];
    for (let i = 0; i + 3 < clean.length + 1; i += 4) {
      const a = B64.indexOf(clean[i]), b = B64.indexOf(clean[i + 1]);
      const c = clean[i + 2] === '=' ? 0 : B64.indexOf(clean[i + 2]);
      const d = clean[i + 3] === '=' ? 0 : B64.indexOf(clean[i + 3]);
      if (a < 0 || b < 0) break;
      bytes.push((a << 2) | (b >> 4));
      if (clean[i + 2] !== '=') bytes.push(((b & 15) << 4) | (c >> 2));
      if (clean[i + 3] !== '=') bytes.push(((c & 3) << 6) | d);
    }
    const pcm = new Int16Array(Math.floor(bytes.length / 2));
    for (let i = 0; i < pcm.length; i++) {
      const v = (bytes[i * 2] | (bytes[i * 2 + 1] << 8));
      pcm[i] = v >= 32768 ? v - 65536 : v;
    }
    return pcm;
  }

  function pcm16ToFloat(pcm) {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    return out;
  }

  function buildUrl(apiKey) {
    return ENDPOINT + '?key=' + encodeURIComponent(apiKey);
  }

  function setState(session, state) {
    session.state = state;
    try { session._onState && session._onState(state); } catch {}
  }

  function attachCommon(ws, session, opts, onReady) {
    const timeoutMs = opts.timeoutMs;
    const timer = setTimeout(() => {
      if (session.state === 'connecting') {
        setState(session, 'error');
        try { opts.onError && opts.onError('Live setup timed out.'); } catch {}
        try { ws.close(); } catch {}
        session._settled = true;
        session._reject && session._reject(new Error('SETUP_TIMEOUT'));
      }
    }, timeoutMs);
    session._timer = timer;
    session._finishSetup = () => {
      clearTimeout(timer);
      if (!session._settled) {
        session._settled = true;
        setState(session, 'live');
        onReady();
      }
    };
  }

  function handleMessage(session, opts, raw, emit) {
    let msg = null;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.setupComplete !== undefined) {
      session._finishSetup && session._finishSetup();
      return;
    }
    const content = msg.serverContent;
    if (!content) return;
    const parts = (content.modelTurn && content.modelTurn.parts) || [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string' && part.text) {
        try { opts.onText && opts.onText(part.text, content.turnComplete === true); } catch {}
      }
      if (part.inlineData && typeof part.inlineData.data === 'string' && part.inlineData.data) {
        try { emit && emit(part.inlineData.data, content.turnComplete === true); } catch {}
      }
    }
  }

  function openSocket(session, opts, emit) {
    return new Promise((resolve, reject) => {
      session._settled = false;
      session._reject = reject;
      setState(session, 'connecting');
      let ws = null;
      try {
        ws = new WebSocket(buildUrl(opts.apiKey));
      } catch (e) { setState(session, 'error'); reject(new Error('SOCKET_FAILED')); return; }
      session._ws = ws;
      attachCommon(ws, session, opts, () => resolve(session));
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            setup: Object.assign(
              { model: 'models/' + opts.model },
              opts.setup || {}
            )
          }));
        } catch (e) {
          clearTimeout(session._timer);
          setState(session, 'error');
          reject(new Error('SETUP_SEND_FAILED'));
        }
      };
      ws.onmessage = (event) => handleMessage(session, opts, event.data, emit);
      ws.onerror = () => {
        try { opts.onError && opts.onError('Live socket error — check the API key, model ID, and network.'); } catch {}
        if (!session._settled) {
          session._settled = true;
          clearTimeout(session._timer);
          setState(session, 'error');
          reject(new Error('SOCKET_ERROR'));
        } else {
          setState(session, 'error');
        }
      };
      ws.onclose = () => {
        const wasLive = session.state === 'live';
        setState(session, 'closed');
        if (!session._settled) {
          session._settled = true;
          clearTimeout(session._timer);
          reject(new Error('SOCKET_CLOSED'));
        } else if (wasLive) {
          try { opts.onError && opts.onError('Live socket disconnected.'); } catch {}
        }
        try { session._onSocketClosed && session._onSocketClosed(); } catch {}
      };
    });
  }

  function baseSession(opts, onState) {
    const session = {
      state: 'connecting',
      _onState: typeof onState === 'function' ? onState : null,
      get ready() { return session.state === 'live' && session._ws && session._ws.readyState === WebSocket.OPEN; },
      reconnect() {
        try { session._ws && session._ws.close(); } catch {}
        return openSocket(session, session._opts, session._emit);
      },
      close(code) {
        try { session._teardown && session._teardown(); } catch {}
        try { session._ws && session._ws.close(typeof code === 'number' ? code : 1000); } catch {}
        setState(session, 'closed');
      }
    };
    session._opts = opts;
    return session;
  }

  function connect(options = {}) {
    const apiKey = String(options.apiKey || '').trim();
    const model = String(options.model || '').trim();
    if (!apiKey) return Promise.reject(new Error('MISSING_API_KEY'));
    if (!model) return Promise.reject(new Error('MISSING_MODEL'));
    if (typeof WebSocket === 'undefined') return Promise.reject(new Error('WEBSOCKET_UNAVAILABLE'));
    const opts = {
      apiKey, model,
      timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000,
      onText: options.onText, onError: options.onError,
      setup: { generation_config: { response_modalities: ['TEXT'] } }
    };
    const session = baseSession(opts, options.onState);
    session.send = (text) => {
      if (!session.ready) throw new Error('SESSION_NOT_READY');
      session._ws.send(JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text: String(text) }] }], turnComplete: true }
      }));
    };
    return openSocket(session, opts, null);
  }

  // --- voice pipeline ------------------------------------------------------
  function resampleTo16k(input, fromRate) {
    if (!fromRate || fromRate === MIC_RATE) return input;
    const ratio = fromRate / MIC_RATE;
    const len = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos), i1 = Math.min(input.length - 1, i0 + 1);
      out[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0);
    }
    return out;
  }

  function rms(values) {
    if (!values || !values.length) return 0;
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
    return Math.sqrt(sum / values.length);
  }

  async function startVoice(options = {}) {
    const apiKey = String(options.apiKey || '').trim();
    const model = String(options.model || '').trim();
    if (!apiKey) throw new Error('MISSING_API_KEY');
    if (!model) throw new Error('MISSING_MODEL');
    if (typeof WebSocket === 'undefined') throw new Error('WEBSOCKET_UNAVAILABLE');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('MIC_UNAVAILABLE');
    if (typeof AudioContext === 'undefined') throw new Error('WEBAUDIO_UNAVAILABLE');

    const onLevel = typeof options.onLevel === 'function' ? options.onLevel : () => {};
    const vadThreshold = Number.isFinite(options.vadThreshold) ? options.vadThreshold : 0.02;
    const opts = {
      apiKey, model,
      timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000,
      onText: options.onText, onError: options.onError,
      setup: {
        generation_config: {
          response_modalities: ['AUDIO'],
          speech_config: { voice_config: { prebuilt_voice_config: { voice_name: 'Kore' } } }
        },
        system_instruction: { parts: [{ text: 'You are a helpful voice assistant.' }] }
      }
    };
    // NOTE: model travels in setup.model via opts.model (see openSocket);
    // the extra setup object above only carries generation config.

    const session = baseSession(opts, options.onState);
    let micStream = null, inCtx = null, micSource = null, micAnalyser = null, micTap = null;
    let outCtx = null, outAnalyser = null, outEndTime = 0;
    let playing = [];
    let micCarry = new Float32Array(0);
    let stopped = false;

    const stopOutput = (barge) => {
      for (const src of playing) { try { src.stop(); } catch {} try { src.disconnect(); } catch {} }
      playing = [];
      if (outCtx) outEndTime = outCtx.currentTime;
      if (barge) { try { options.onBargeIn && options.onBargeIn(); } catch {} }
    };

    const playPcm24k = (b64) => {
      const pcm = decodeBase64ToInt16(b64);
      if (!pcm.length || !outCtx || stopped) return;
      const buffer = outCtx.createBuffer(1, pcm.length, OUT_RATE);
      buffer.getChannelData(0).set(pcm16ToFloat(pcm));
      const src = outCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(outAnalyser);
      const now = outCtx.currentTime;
      outEndTime = Math.max(now + 0.02, outEndTime);
      src.start(outEndTime);
      outEndTime += buffer.duration;
      playing.push(src);
      src.onended = () => { playing = playing.filter((s) => s !== src); };
    };

    const pushMic = (float32, fromRate) => {
      const resampled = resampleTo16k(float32, fromRate);
      const joined = new Float32Array(micCarry.length + resampled.length);
      joined.set(micCarry, 0); joined.set(resampled, micCarry.length);
      const frames = chunkFrames(joined, MIC_FRAME);
      const used = frames.length * MIC_FRAME;
      micCarry = joined.slice(used);
      for (const frame of frames) {
        const pcm = floatToPcm16(frame);
        const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        try {
          session._ws.send(JSON.stringify({
            realtimeInput: { audio: { data: encodeBase64(bytes), mimeType: 'audio/pcm;rate=16000' } }
          }));
        } catch { return; }
      }
    };

    session._teardown = () => {
      stopped = true;
      stopOutput(false);
      try { micTap && micTap.disconnect(); } catch {}
      try { micSource && micSource.disconnect(); } catch {}
      try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch {}
      try { inCtx && inCtx.close(); } catch {}
      try { outCtx && outCtx.close(); } catch {}
    };

    session.send = (text) => {
      if (!session.ready) throw new Error('SESSION_NOT_READY');
      session._ws.send(JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text: String(text) }] }], turnComplete: true }
      }));
    };

    // 1. microphone first, so a denied permission fails fast with MIC_UNAVAILABLE
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: { ideal: MIC_RATE }, channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      setState(session, 'error');
      throw new Error('MIC_UNAVAILABLE');
    }

    inCtx = new AudioContext({ sampleRate: MIC_RATE });
    outCtx = new AudioContext({ sampleRate: OUT_RATE });
    try { await inCtx.resume(); await outCtx.resume(); } catch {}
    micSource = inCtx.createMediaStreamSource(micStream);
    micAnalyser = inCtx.createAnalyser();
    micAnalyser.fftSize = 1024;
    micSource.connect(micAnalyser);
    outAnalyser = outCtx.createAnalyser();
    outAnalyser.fftSize = 1024;
    outAnalyser.connect(outCtx.destination);
    micTap = inCtx.createScriptProcessor(4096, 1, 1);
    const meterBuf = new Float32Array(1024);
    const outMeterBuf = new Float32Array(1024);
    micTap.onaudioprocess = (event) => {
      if (stopped || session.state !== 'live') return;
      const input = event.inputBuffer.getChannelData(0);
      const level = Math.min(1, rms(input) * 4);
      let outLevel = 0;
      try { outAnalyser.getFloatTimeDomainData(outMeterBuf); outLevel = Math.min(1, rms(outMeterBuf) * 4); } catch {}
      try { onLevel({ in: level, out: outLevel }); } catch {}
      // barge-in: user starts speaking while Gem is talking -> cut playback
      if (playing.length && rms(input) > vadThreshold) stopOutput(true);
      const mono = new Float32Array(input.length);
      mono.set(input);
      pushMic(mono, inCtx.sampleRate);
    };
    micSource.connect(micTap);
    micTap.connect(inCtx.destination);
    try { micAnalyser.getFloatTimeDomainData(meterBuf); } catch {}

    session._onSocketClosed = () => session._teardown();
    session._emit = (b64) => playPcm24k(b64);
    await openSocket(session, opts, (b64) => playPcm24k(b64));
    return session;
  }

  window.geminiLive = {
    connect, startVoice, ENDPOINT,
    audio: { floatToPcm16, chunkFrames, encodeBase64, decodeBase64ToInt16, pcm16ToFloat, resampleTo16k, rms, MIC_RATE, MIC_FRAME, OUT_RATE }
  };
})();
