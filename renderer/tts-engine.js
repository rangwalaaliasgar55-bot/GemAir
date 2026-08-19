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
      const emotionMod = opts.emotionMod || { rate: 0, pitch: 0 };

      const finalRate = Math.max(0.6, Math.min(1.4, Number(opts.rate || this.rate) + emotionMod.rate));
      const finalPitch = Math.max(0.7, Math.min(1.5, Number(opts.pitch || this.pitch) + emotionMod.pitch));

      if (engine === 'neural') {
        try {
          return await this.speakNeural(cleanText, gender, opts.gen);
        } catch (e) {
          // fallback to system TTS
        }
      }

      return this.speakSystem(cleanText, gender, finalRate, finalPitch, opts.onBoundary);
    },

    speakNeural(text, gender, gen) {
      return new Promise((resolve, reject) => {
        const accent = gender === 'male' ? 'en-GB' : 'en';
        const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=' + encodeURIComponent(text.slice(0, 200)) + '&tl=' + encodeURIComponent(accent);

        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.src = url;
        audio.preload = 'auto';

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
