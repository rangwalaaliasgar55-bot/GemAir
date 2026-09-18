/* ============================================================
   GemAir — Local Wake Word engine ("Hey Gem")
   Concept ported from Mark-LIII (FatihMakes/Mark-LIII, MIT): a local,
   on-device wake-word gate so the microphone is processed only on this
   machine and nothing is sent anywhere until the wake phrase is heard.

   Implementation: vosk-browser (Apache-2.0), a WebAssembly build of the
   Kaldi/Vosk offline speech recognizer, running in its own Web Worker.
   The recognizer is grammar-restricted to just the wake phrase + a
   catch-all token, which keeps it fast and light. The small English
   model (~40 MB) downloads once (opt-in, on first enable) and is cached
   by the browser's IndexedDB (via vosk-browser's own persistence) so
   later launches reuse it without a network request.

   Public API (window.GemWakeWord):
     isSupported()                          -> boolean
     start({ phrase, onWake, onStatus,
              onLevel, onError })  -> Promise<void>
     stop()                                  -> void
     get active                              -> boolean

   Falls back cleanly: if WebAssembly/Workers are unavailable, or the
   model can't be downloaded (offline, blocked host), start() rejects
   and the caller (renderer/app.js) falls back to the existing
   cloud-based wake loop (browser SpeechRecognition).
   ============================================================ */
(function () {
  'use strict';

  const VOSK_SCRIPT_URL = 'vendor/vosk-browser/vosk.js';
  // Small (~40 MB) English model from the vosk-browser project's own model
  // mirror — same model the upstream vosk-browser demo uses. Keyless, free.
  const MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
  const SAMPLE_RATE = 16000;

  let voskLoader = null;
  function loadVoskScript() {
    if (window.Vosk) return Promise.resolve(window.Vosk);
    if (!voskLoader) {
      voskLoader = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = VOSK_SCRIPT_URL;
        script.onload = () => (window.Vosk ? resolve(window.Vosk) : reject(new Error('Local wake-word engine failed to initialize')));
        script.onerror = () => { voskLoader = null; reject(new Error('Local wake-word engine script failed to load')); };
        document.body.appendChild(script);
      });
    }
    return voskLoader;
  }

  let model = null;
  let modelLoader = null;
  function loadModel(onStatus) {
    if (model) return Promise.resolve(model);
    if (!modelLoader) {
      modelLoader = loadVoskScript()
        .then((Vosk) => {
          if (onStatus) onStatus('Downloading the local wake-word model (one-time, about 40 MB, stays on this device)…');
          return Vosk.createModel(MODEL_URL);
        })
        .then((loadedModel) => { model = loadedModel; if (onStatus) onStatus('Wake-word model ready.'); return loadedModel; })
        .catch((error) => { modelLoader = null; throw error; });
    }
    return modelLoader;
  }

  function normalizePhrase(phrase) {
    return String(phrase || 'hey gem')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'hey gem';
  }

  let recognizer = null;
  let audioCtx = null;
  let micStream = null;
  let micSource = null;
  let processor = null;
  let silentGain = null;
  let active = false;

  function isSupported() {
    return typeof Worker !== 'undefined'
      && typeof WebAssembly === 'object'
      && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      && typeof (window.AudioContext || window.webkitAudioContext) === 'function';
  }

  async function start({ phrase, onWake, onStatus, onLevel, micDeviceId } = {}) {
    // micDeviceId: the Settings device pick routes here too — one hardware
    // choice governs the wake listener, the dictation mic, and Live voice.
    if (!isSupported()) throw new Error('Local wake-word engine is not supported in this environment');
    if (active) return;

    const wakePhrase = normalizePhrase(phrase);
    const loadedModel = await loadModel(onStatus);

    // Restricting the grammar to the wake phrase (+ "[unk]" catch-all for
    // everything else) keeps this fast and accurate — it never has to
    // transcribe general speech, just decide "was that the phrase or not".
    const grammar = JSON.stringify([wakePhrase, '[unk]']);
    recognizer = new loadedModel.KaldiRecognizer(SAMPLE_RATE, grammar);

    let woken = false;
    const checkText = (text) => {
      const clean = String(text || '').toLowerCase().trim();
      if (!clean || woken) return;
      if ((` ${clean} `).includes(` ${wakePhrase} `)) {
        woken = true;
        if (onWake) onWake(clean);
      }
    };
    recognizer.on('result', (message) => checkText(message && message.result && message.result.text));
    recognizer.on('partialresult', (message) => checkText(message && message.result && message.result.partial));

    const micId = String(micDeviceId || '').trim();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: Object.assign(
          { channelCount: 1, sampleRate: { ideal: SAMPLE_RATE }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          micId ? { deviceId: { ideal: micId } } : {})
      });
    } catch (error) {
      recognizer = null;
      throw new Error('Microphone permission denied');
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx();
    try { await audioCtx.resume(); } catch (e) { /* some browsers require a user gesture first; caller UI already provides one via the settings toggle */ }
    micSource = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    // ScriptProcessorNode must be connected to the graph to keep firing in
    // some browsers; route through a silent gain node so nothing is audible.
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (!active || woken) return;
      const input = event.inputBuffer;
      if (onLevel) {
        const data = input.getChannelData(0);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
        onLevel(Math.min(1, Math.sqrt(sumSquares / data.length) * 4));
      }
      try { recognizer.acceptWaveform(input); } catch (e) { /* transient decoder hiccup — next chunk recovers */ }
    };
    micSource.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioCtx.destination);
    active = true;
  }

  function stop() {
    active = false;
    try { processor && processor.disconnect(); } catch (e) {}
    try { silentGain && silentGain.disconnect(); } catch (e) {}
    try { micSource && micSource.disconnect(); } catch (e) {}
    try { micStream && micStream.getTracks().forEach((track) => track.stop()); } catch (e) {}
    try { audioCtx && audioCtx.close(); } catch (e) {}
    try { recognizer && recognizer.remove(); } catch (e) {}
    recognizer = null; audioCtx = null; micStream = null; micSource = null; processor = null; silentGain = null;
  }

  // One-click model install (Settings → WAKE WORD, Mark-style): downloads and
  // caches the local recognizer model WITHOUT touching the microphone, so
  // enabling the wake word later starts instantly. Safe to call repeatedly —
  // the model is cached by vosk-browser in IndexedDB after the first fetch.
  async function installModel(onStatus) {
    if (!isSupported()) throw new Error('Local wake-word engine is not supported in this environment');
    const installed = await loadModel(onStatus);
    return !!installed;
  }

  function modelStatus() {
    return {
      supported: isSupported(),
      installed: !!model,
      downloading: !model && !!modelLoader
    };
  }

  window.GemWakeWord = {
    isSupported,
    start,
    stop,
    installModel,
    modelStatus,
    get active() { return active; }
  };
})();
