/* ============================================================
   GemAir — Natural Voice & Speech Synthesis Engine (TTS)
   Supports Hybrid Neural, Kokoro/Piper, Edge-TTS, and System voices
   with emotion-aware prosody and real-time Audio Analyser lip-sync.
   ============================================================ */
'use strict';

(function () {
  let audioContext = null;
  let analyserNode = null;
  let currentAudio = null;

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

  const FEMALE_SENTINELS = ['female', 'zira', 'aria', 'samantha', 'hazel', 'susan', 'kate', 'serena', 'jenny', 'martha', 'en-us', 'aava', 'emma'];
  const MALE_SENTINELS = ['male', 'david', 'george', 'mark', 'richard', 'james', 'brian', 'steffan', 'guy', 'guy-neural'];

  const TTS = {
    gender: 'female',
    style: 'warm',
    engine: 'neural',
    rate: 1.0,
    pitch: 1.1,

    init() {
      // populate voices when available
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

    stop() {
      if (currentAudio) {
        try { currentAudio.pause(); } catch (e) {}
        currentAudio = null;
      }
      if (typeof speechSynthesis !== 'undefined') {
        try { speechSynthesis.cancel(); } catch (e) {}
      }
    },

    /**
     * Synthesize speech using Neural URL or Web Speech API, with AudioContext Analyser hookup
     */
    async speak(text, opts = {}) {
      this.stop();

      const cleanText = String(text || '')
        .replace(/```[\s\S]*?```/g, '(code).')
        .replace(/[#*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanText) return false;

      const gender = opts.gender || this.gender || 'female';
      const engine = opts.engine || this.engine || 'neural';
      const emotionMod = opts.emotionMod || { rate: 0, pitch: 0, volume: 0, pause: 0 };

      // base rate/pitch plus emotion delta (emotional voice intelligence v2)
      const finalRate = Math.max(0.5, Math.min(1.5, Number(opts.rate || this.rate) + (emotionMod.rate || 0)));
      const finalPitch = Math.max(0.5, Math.min(1.5, Number(opts.pitch || this.pitch) + (emotionMod.pitch || 0)));
      const finalVolume = Math.max(0.5, Math.min(1.2, Number(opts.volume || 1) + (emotionMod.volume || 0)));
      const pauseMs = Math.max(0, Math.min(1500, Math.round((emotionMod.pause || 0) * 400)));

      // Section IIa: Microsoft Edge neural voices are the PRIMARY engine.
      if (engine === 'edge' || engine === 'neural') {
        if (engine === 'edge') {
          const edge = window.edgeTts;
          if (edge && edge.isAvailable()) {
            try {
              const r = await this.speakEdge(cleanText, opts, finalRate, finalPitch, finalVolume, pauseMs, gender);
              if (r) return true;
            } catch (e) {
              // fall through to Google neural, then system
            }
          }
        }
        // Google neural fallback (existing free engine)
        try {
          return await this.speakNeural(cleanText, gender, opts.gen, opts.neuralVoice, finalRate);
        } catch (e) {
          // fallback to system TTS
        }
      }

      return this.speakSystem(cleanText, gender, finalRate, finalPitch, opts.onBoundary);
    },

    /** Edge neural synthesis (Section IIa/IId/IIe). Returns true on success. */
    async speakEdge(text, opts, rate, pitch, volume, pauseMs, gender) {
      const edge = window.edgeTts;
      if (!edge || !edge.isAvailable()) return false;
      // Prefer an explicitly chosen Edge voice; else map preset/STT language.
      let voice = opts.edgeVoice;
      if (!voice) {
        const preset = (opts.preset && opts.presetVoice) || null;
        voice = preset || edge.voiceForLang(opts.edgeLang || opts.neuralVoice || 'en-US');
      }
      const r = await edge.synth(text.slice(0, 500), { voice, rate, pitch, volume, pauseMs });
      if (!r.ok || !r.url) return false;
      const audio = new Audio();
      audio.src = r.url;
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';

      let settled = false;
      const done = (ok) => {
        if (!settled) {
          settled = true;
          try { audio.pause(); } catch (e) {}
          if (currentAudio === audio) currentAudio = null;
          if (ok) {
            try { URL.revokeObjectURL(r.url); } catch (e) {}
            resolve(true);
          } else reject(new Error('Edge audio failed'));
        }
      };
      let resolve, reject;
      const p = new Promise((res, rej) => { resolve = res; reject = rej; });
      audio.onended = () => done(true);
      audio.onerror = () => done(false);

      try {
        const ctx = getAudioContext();
        const analyser = getAnalyser();
        if (ctx && analyser) {
          const source = ctx.createMediaElementSource(audio);
          source.connect(analyser);
          analyser.connect(ctx.destination);
          if (window.gemAvatar) window.gemAvatar.setAudioAnalyser(analyser);
        }
      } catch (e) {}

      currentAudio = audio;
      audio.play().then(() => {}).catch(() => done(false));
      setTimeout(() => done(false), 30000); // safety
      return p;
    },

    speakNeural(text, gender, gen, neuralVoice, rate) {
      return new Promise((resolve, reject) => {
        const accent = neuralVoice || (gender === 'male' ? 'en-GB' : 'en');
        const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=' + encodeURIComponent(text.slice(0, 200)) + '&tl=' + encodeURIComponent(accent);

        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.src = url;
        audio.preload = 'auto';
        audio.playbackRate = Math.max(0.75, Math.min(1.25, Number(rate || 1)));

        let settled = false;
        const done = (ok) => {
          if (!settled) {
            settled = true;
            try { audio.pause(); } catch (e) {}
            if (currentAudio === audio) currentAudio = null;
            if (ok) resolve(true); else reject(new Error('Neural audio failed'));
          }
        };

        audio.onended = () => done(true);
        audio.onerror = () => done(false);

        try {
          const ctx = getAudioContext();
          const analyser = getAnalyser();
          if (ctx && analyser) {
            const source = ctx.createMediaElementSource(audio);
            source.connect(analyser);
            analyser.connect(ctx.destination);
            if (window.gemAvatar) window.gemAvatar.setAudioAnalyser(analyser);
          }
        } catch (e) {}

        currentAudio = audio;
        audio.play().then(() => {}).catch(() => done(false));
        setTimeout(() => done(false), 20000);
      });
    },

    speakSystem(text, gender, rate, pitch, onBoundary) {
      if (typeof speechSynthesis === 'undefined') return false;

      try {
        const u = new SpeechSynthesisUtterance(text.slice(0, 600));
        u.rate = rate;
        u.pitch = pitch;

        const voices = this.getVoices();
        const sentinels = gender === 'male' ? MALE_SENTINELS : FEMALE_SENTINELS;
        const matched = voices.find(v => v.lang && /^en/i.test(v.lang) && sentinels.some(s => v.name.toLowerCase().includes(s)));

        if (matched) u.voice = matched;

        u.onboundary = (ev) => {
          if (typeof onBoundary === 'function') onBoundary(ev);
          if (window.gemAvatar) window.gemAvatar.syllable();
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

  TTS.init();
  window.ttsEngine = TTS;
})();
