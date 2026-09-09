/* ============================================================
   GemAir — Natural Voice & Speech Synthesis Engine (TTS)

   THE single speech path for the whole app (U1). app.js no longer
   carries a parallel stack; everything calls window.ttsEngine.speak().

   Fallback chain: Microsoft Edge neural (free, WSS) → Google neural →
   offline system voice. Every tier honours the caller's generation token
   (opts.gen / opts.isCurrent) so a barge-in kills queued chunks instead of
   letting stale audio keep talking (R7).
   ============================================================ */
'use strict';

(function () {
  let audioContext = null;
  let analyserNode = null;
  let currentAudio = null;
  let mediaSources = null; // WeakMap: createMediaElementSource may only run once per element
  const pcmSources = new Set(); // live Gemini PCM buffer sources, stopped on barge-in

  function getAudioContext() {
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioContext = new AudioCtx();
    }
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    return audioContext;
  }

  function getAnalyser() {
    const ctx = getAudioContext();
    if (!ctx) return null;
    if (!analyserNode) {
      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 128;
    }
    return analyserNode;
  }

  /** Route an <audio> element through the analyser so the avatar can lip-sync. */
  function attachAnalyser(audio) {
    try {
      const ctx = getAudioContext();
      const analyser = getAnalyser();
      if (!ctx || !analyser) return;
      if (!mediaSources) mediaSources = new WeakMap();
      if (!mediaSources.has(audio)) {
        mediaSources.set(audio, ctx.createMediaElementSource(audio));
      }
      const source = mediaSources.get(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      if (window.gemAvatar) window.gemAvatar.setAudioAnalyser(analyser);
    } catch (e) { /* analyser is a nicety, never a requirement */ }
  }

  // U1: the ONE list of voice-name sentinels. app.js used to keep a second,
  // slightly different copy (VOICE_SENTINELS); it now reads these.
  const FEMALE_SENTINELS = ['female', 'zira', 'aria', 'samantha', 'hazel', 'susan', 'kate', 'serena', 'jenny', 'martha', 'aava', 'emma'];
  const MALE_SENTINELS = ['male', 'david', 'george', 'mark', 'richard', 'james', 'brian', 'steffan', 'guy'];

  /**
   * Split text for a synthesis backend with a hard per-request length cap,
   * preferring sentence then word boundaries so chunks never cut mid-word.
   */
  function chunk(text, max) {
    const out = [];
    let cur = '';
      const parts = String(text).match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g) || [String(text)];
    for (let part of parts) {
      while (part.length > max) {
        const slice = part.slice(0, max);
        const cut = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf(','));
        const head = cut > max * 0.5 ? slice.slice(0, cut) : slice;
        if (cur) { out.push(cur.trim()); cur = ''; }
        out.push(head.trim());
        part = part.slice(head.length);
      }
      if ((cur + part).length > max && cur) { out.push(cur.trim()); cur = ''; }
      cur += part;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
  }

  const TTS = {
    gender: 'female',
    style: 'warm',
    engine: 'edge',
    rate: 1.0,
    pitch: 1.1,

    FEMALE_SENTINELS,
    MALE_SENTINELS,
    SENTINELS: { female: FEMALE_SENTINELS, male: MALE_SENTINELS },

    init() {
      if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.onvoiceschanged = () => this.getVoices();
      }
    },

    getVoices() {
      if (typeof speechSynthesis === 'undefined') return [];
      return speechSynthesis.getVoices() || [];
    },

    getFilteredVoices(gender = 'female') {
      const voices = this.getVoices();
      const sentinels = gender === 'male' ? MALE_SENTINELS : FEMALE_SENTINELS;
      return voices.filter(v => v.lang && /^en/i.test(v.lang) && sentinels.some(s => v.name.toLowerCase().includes(s)));
    },

    /** Cancel everything currently audible (called by app.js stopSpeaking, R3). */
    stop() {
      this._cancelled = true;
      for (const source of pcmSources) {
        try { source.stop(); } catch (e) {}
        try { source.disconnect(); } catch (e) {}
      }
      pcmSources.clear();
      if (currentAudio) {
        try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
        currentAudio = null;
      }
      if (typeof speechSynthesis !== 'undefined') {
        try { speechSynthesis.cancel(); } catch (e) {}
      }
      if (window.gemAvatar) { try { window.gemAvatar.setState({ speaking: false }); } catch (e) {} }
    },

    /** Is this utterance still the current one? (generation guard, R7) */
    _alive(opts) {
      if (typeof opts.isCurrent === 'function') return !!opts.isCurrent();
      return true;
    },

    async speak(text, opts = {}) {
      this.stop();
      this._cancelled = false;

      const cleanText = String(text || '')
        .replace(/```[\s\S]*?```/g, '(code).')
        .replace(/[#*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanText) return false;
      if (!this._alive(opts)) return false;

      const gender = opts.gender || this.gender || 'female';
      const engine = opts.engine || this.engine || 'edge';
      const emotionMod = opts.emotionMod || { rate: 0, pitch: 0, volume: 0, pause: 0 };

      const finalRate = Math.max(0.5, Math.min(1.5, Number(opts.rate || this.rate) + (emotionMod.rate || 0)));
      const finalPitch = Math.max(0.5, Math.min(1.5, Number(opts.pitch || this.pitch) + (emotionMod.pitch || 0)));
      const finalVolume = Math.max(0.5, Math.min(1.2, Number(opts.volume || 1) + (emotionMod.volume || 0)));
      const pauseMs = Math.max(0, Math.min(1500, Math.round((emotionMod.pause || 0) * 400)));

      // Gemini voice is opt-in (needs the user's free AI Studio key). No key
      // or any failure falls through to the FREE Edge chain, then system —
      // speech never goes silent because of a missing key.
      if (engine === 'gemini') {
        try {
          const r = await this.speakGemini(cleanText, opts, finalVolume);
          if (r) return true;
        } catch (e) { /* fall through to the free chain */ }
        if (!this._alive(opts)) return false;
      }

      if (engine === 'edge' || engine === 'gemini' || engine === 'neural') {
        if (engine === 'edge') {
          const edge = window.edgeTts;
          if (edge && edge.isAvailable()) {
            try {
              const r = await this.speakEdge(cleanText, opts, finalRate, finalPitch, finalVolume, pauseMs, gender);
              if (r) return true;
            } catch (e) { /* fall through to Google neural, then system */ }
          }
        }
        if (!this._alive(opts)) return false;
        try {
          const r = await this.speakNeural(cleanText, gender, opts, opts.neuralVoice, finalRate);
          if (r) return true;
        } catch (e) { /* fall through to system TTS */ }
      }

      if (!this._alive(opts)) return false;
      return this.speakSystem(cleanText, gender, finalRate, finalPitch, opts.onBoundary, opts);
    },

    /**
     * Edge neural synthesis. Long replies are chunked (the endpoint truncates
     * very long SSML), and each chunk re-checks the generation guard so a
     * barge-in during sentence 1 never plays sentence 2.
     */
    async speakEdge(text, opts, rate, pitch, volume, pauseMs, gender) {
      const edge = window.edgeTts;
      if (!edge || !edge.isAvailable()) return false;
      let voice = opts.edgeVoice;
      if (!voice) {
        const preset = (opts.preset && opts.presetVoice) || null;
        voice = preset || edge.voiceForLang(opts.edgeLang || opts.neuralVoice || 'en-US');
      }

       const chunks = chunk(text, 300);
      let played = 0;
      for (const part of chunks) {
        if (!this._alive(opts) || this._cancelled) break;
        const r = await edge.synth(part, { voice, rate, pitch, volume, pauseMs });
        if (!r.ok || !r.url) break;
        if (!this._alive(opts) || this._cancelled) { try { URL.revokeObjectURL(r.url); } catch (e) {} break; }
        const ok = await this.playUrl(r.url, opts, { revoke: true, boundaries: r.boundaries, text: part });
        if (!ok) break;
        played++;
      }
      return played > 0 && played === chunks.length;
    },

    /**
     * Gemini native voice (generateContent with AUDIO modality). Uses the
     * user's own AI Studio key — free tier. Live-only model IDs can never
     * speak REST audio, so a text-capable model is chosen instead.
     * Returns true only when every chunk actually played.
     */
    GEMINI_TTS_FALLBACK_MODEL: 'gemini-2.5-flash-preview-tts',

    geminiTtsModel(configured) {
      const id = String(configured || '').trim();
      if (id && !/native[\-_]?audio|[\-_]live[\-_]/i.test(id)) return id;
      return this.GEMINI_TTS_FALLBACK_MODEL;
    },

    geminiVoiceName(requested, gender) {
      const v = String(requested || '').trim();
      if (/^(Aoede|Kore|Sulafat|Charon|Fenrir|Orus|Puck|Zephyr|Callirrhoe|Autonoe|Enceladus|Erinome|Algenib|Rasalgethi|Laomedeia|Algieba|Despina|Umbriel|Alnilam|Schedar|Gacrux|Pulcherrima|Achird|Zubenelgenubi|Vindemiatrix|Sadachbia|Sadaltager|Sulafat)$/i.test(v)) return v;
      return gender === 'male' ? 'Charon' : 'Aoede';
    },

    async speakGemini(text, opts = {}, volume = 1) {
      const apiKey = String(opts.geminiApiKey || '').trim();
      if (!apiKey) return false;
      if (typeof fetch === 'undefined') return false;
      const model = this.geminiTtsModel(opts.geminiModel);
      const voiceName = this.geminiVoiceName(opts.geminiVoice, opts.gender || this.gender);
      const chunks = chunk(text, 900);
      let played = 0;
      for (const part of chunks) {
        if (!this._alive(opts) || this._cancelled) break;
        let data = null;
        try {
          const res = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: part }] }],
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
                }
              })
            }
          );
          data = await res.json().catch(() => null);
          if (!res.ok) break;
        } catch (e) { break; }
        const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
        const audio = parts.map((p) => (p.inlineData && p.inlineData.data) || '').find(Boolean) || '';
        if (!audio) break;
        if (!this._alive(opts) || this._cancelled) break;
        const ok = await this.playPcm24k(audio, opts, volume);
        if (!ok) break;
        played++;
      }
      return played > 0 && played === chunks.length;
    },

    /** Play base64 16-bit PCM @ 24kHz mono through the shared analyser. */
    playPcm24k(b64, opts = {}, volume = 1) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          try { if (window.gemAvatar) window.gemAvatar.setState({ speaking: false }); } catch (e) {}
          resolve(ok);
        };
        try {
          const ctx = getAudioContext();
          if (!ctx) return done(false);
          const bin = atob(String(b64).replace(/\s+/g, ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
          if (!samples.length) return done(false);
          const buffer = ctx.createBuffer(1, samples.length, 24000);
          const out = buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          const gain = ctx.createGain();
          gain.gain.value = Math.max(0, Math.min(1.2, Number(volume) || 1));
          const analyser = getAnalyser();
          const sink = (node) => { try { node.connect(ctx.destination); } catch (e) {} };
          try { source.connect(gain); } catch (e) {}
          if (analyser) { try { gain.connect(analyser); analyser.connect(ctx.destination); } catch (e) { sink(gain); } }
          else sink(gain);
          try { if (window.gemAvatar) { window.gemAvatar.setAudioAnalyser(analyser); window.gemAvatar.setState({ speaking: true }); } } catch (e) {}
          pcmSources.add(source);
          const teardown = () => {
            try { source.stop(); } catch (e) {}
            try { source.disconnect(); } catch (e) {}
            try { gain.disconnect(); } catch (e) {}
            pcmSources.delete(source);
          };
          const guard = setInterval(() => {
            if (this._cancelled || !this._alive(opts)) {
              clearInterval(guard);
              teardown();
              done(false);
            }
          }, 120);
          const timer = setTimeout(() => {
            clearInterval(guard);
            teardown();
            done(false);
          }, 120000);
          source.onended = () => {
            clearInterval(guard);
            clearTimeout(timer);
            try { source.disconnect(); } catch (e) {}
            try { gain.disconnect(); } catch (e) {}
            pcmSources.delete(source);
            done(true);
          };
          try { source.start(); } catch (e) { clearInterval(guard); clearTimeout(timer); done(false); }
        } catch (e) { done(false); }
      });
    },
    /**
     * Google translate_tts neural fallback.
     *
     * R7: the `gen` parameter used to be accepted and then ignored, so stale
     * chunks kept playing after a cancel; and crossOrigin='anonymous' was set
     * against translate.google.com, which does NOT send CORS headers — the
     * element errored immediately and the engine collapsed to robotic system
     * voices almost every time. The generation is honoured between chunks and
     * crossOrigin is gone (we simply skip the analyser for this tier).
     */
    async speakNeural(text, gender, opts = {}, neuralVoice, rate) {
      const accent = neuralVoice || (gender === 'male' ? 'en-GB' : 'en');
      const chunks = chunk(text, 190); // endpoint caps around 200 chars
      let played = 0;
      for (const part of chunks) {
        if (!this._alive(opts) || this._cancelled) break;
        const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=' +
          encodeURIComponent(part) + '&tl=' + encodeURIComponent(accent);
        const ok = await this.playUrl(url, opts, { rate, noAnalyser: true, text: part });
        if (!ok) break;
        played++;
      }
      return played > 0;
    },

    /** Play one audio URL to completion. Resolves false on error/cancel. */
    playUrl(url, opts = {}, cfg = {}) {
      return new Promise((resolve) => {
        const audio = new Audio();
        let settled = false;
        let timer = null;
        let guard = null;
        const timers = [];
        const done = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(guard);
          timers.forEach(clearTimeout);
          try { audio.pause(); } catch (e) {}
          if (currentAudio === audio) currentAudio = null;
          if (cfg.revoke) { try { URL.revokeObjectURL(url); } catch (e) {} }
          if (window.gemAvatar) { try { window.gemAvatar.setState({ speaking: false }); } catch (e) {} }
          resolve(ok);
        };

        audio.preload = 'auto';
        if (cfg.rate) audio.playbackRate = Math.max(0.75, Math.min(1.25, Number(cfg.rate) || 1));
        audio.onended = () => done(true);
        audio.onerror = () => done(false);
        audio.src = url;

        if (!cfg.noAnalyser) attachAnalyser(audio);

        // R3/R7: if the caller's generation moves on, cut the audio immediately.
        guard = setInterval(() => {
          if (this._cancelled || !this._alive(opts)) done(false);
        }, 120);

        currentAudio = audio;
        audio.play().then(() => {
          if (window.gemAvatar) { try { window.gemAvatar.setState({ speaking: true }); } catch (e) {} }
          // S5: schedule word-boundary visemes from Edge WordBoundary metadata
          if (Array.isArray(cfg.boundaries) && typeof opts.onBoundary === 'function') {
            for (const b of cfg.boundaries) {
              timers.push(setTimeout(() => {
                if (!settled) opts.onBoundary({ word: b.text, charIndex: b.charIndex, charLength: (b.text || '').length });
              }, Math.max(0, b.offsetMs || 0)));
            }
          }
        }).catch(() => done(false));

        timer = setTimeout(() => done(false), 45000); // safety net
      });
    },

    speakSystem(text, gender, rate, pitch, onBoundary, opts = {}) {
      if (typeof speechSynthesis === 'undefined') return false;
      if (!this._alive(opts)) return false;

      try {
        const u = new SpeechSynthesisUtterance(text.slice(0, 1200));
        u.rate = rate;
        u.pitch = pitch;

        const voices = this.getVoices();
        const sentinels = gender === 'male' ? MALE_SENTINELS : FEMALE_SENTINELS;
        const matched = voices.find(v => v.lang && /^en/i.test(v.lang) && sentinels.some(s => v.name.toLowerCase().includes(s)));
        if (matched) u.voice = matched;

        u.onboundary = (ev) => {
          if (this._cancelled || !this._alive(opts)) { try { speechSynthesis.cancel(); } catch (e) {} return; }
          const word = (text.slice(ev.charIndex, ev.charIndex + (ev.charLength || 14)).match(/^\S+/) || [''])[0];
          if (typeof onBoundary === 'function') onBoundary({ charIndex: ev.charIndex, charLength: ev.charLength, word });
          if (window.gemAvatar) {
            if (window.gemAvatar.speakWord) window.gemAvatar.speakWord(word);
            else window.gemAvatar.syllable();
          }
        };

        u.onstart = () => { if (window.gemAvatar) window.gemAvatar.setState({ speaking: true }); };
        u.onend = () => { if (window.gemAvatar) window.gemAvatar.setState({ speaking: false }); };

        speechSynthesis.speak(u);
        return true;
      } catch (e) {
        return false;
      }
    }
  };

  TTS._cancelled = false;
  TTS.init();
  window.ttsEngine = TTS;
})();
