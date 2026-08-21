/* ============================================================
   GemAir — Microsoft Edge neural voices (free TTS endpoint)
   Section II: Stonic-grade voice at $0.

   Uses Microsoft Edge's "Read Aloud" neural synthesis WebSocket
   (speech.platform.bing.com) — the same free endpoint Edge uses in
   the browser. No key, no account, no cost.

   This file is OPTIONAL and fully guarded: if the WebSocket is
   unavailable, times out, or any step fails, the caller (tts-engine.js)
   falls back to the Google neural engine, then the offline system voice.
   ============================================================ */
'use strict';

(function () {
  const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const WS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
  const GEC_VERSION = '1-131.0.2903.99';
  const WIN_EPOCH_OFFSET = 11644473600; // seconds between 1601-01-01 and 1970-01-01

  /**
   * Sec-MS-GEC token (R2).
   *
   * Microsoft now rejects the Read-Aloud handshake unless the URL carries
   * Sec-MS-GEC / Sec-MS-GEC-Version. The token is the uppercase SHA-256 hex of
   * `<windows-file-time-ticks><TrustedClientToken>` where the ticks are the
   * current time snapped DOWN to a 5-minute boundary. It is deterministic, so
   * no account or key is involved — this stays a free endpoint.
   */
  async function secMsGec() {
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
    if (!subtle) return null;
    const nowSec = Math.floor(Date.now() / 1000) + WIN_EPOCH_OFFSET;
    const rounded = nowSec - (nowSec % 300);
    const ticks = BigInt(rounded) * 10000000n;
    const payload = String(ticks) + TOKEN;
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  /** Build the fully-qualified synthesis WSS URL, GEC params included. */
  async function buildUrl(connId) {
    let url = `${WS_BASE}?TrustedClientToken=${TOKEN}&ConnectionId=${connId}`;
    try {
      const gec = await secMsGec();
      if (gec) url += `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${encodeURIComponent(GEC_VERSION)}`;
    } catch (e) { /* no subtle crypto — try the bare URL */ }
    return url;
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // Real Microsoft Edge neural voice names (Section IIa / IId).
  const VOICES = [
    { name: 'en-US-AriaNeural', lang: 'en-US', gender: 'Female', label: 'Aria (US) · warm female' },
    { name: 'en-US-JennyNeural', lang: 'en-US', gender: 'Female', label: 'Jenny (US) · bright female' },
    { name: 'en-US-EmmaNeural', lang: 'en-US', gender: 'Female', label: 'Emma (US) · soft female' },
    { name: 'en-US-GuyNeural', lang: 'en-US', gender: 'Male', label: 'Guy (US) · male' },
    { name: 'en-US-ChristopherNeural', lang: 'en-US', gender: 'Male', label: 'Christopher (US) · deep male' },
    { name: 'en-US-EricNeural', lang: 'en-US', gender: 'Male', label: 'Eric (US) · male' },
    { name: 'en-GB-SoniaNeural', lang: 'en-GB', gender: 'Female', label: 'Sonia (UK) · warm female' },
    { name: 'en-GB-LibbyNeural', lang: 'en-GB', gender: 'Female', label: 'Libby (UK) · female' },
    { name: 'en-GB-RyanNeural', lang: 'en-GB', gender: 'Male', label: 'Ryan (UK) · male' },
    { name: 'en-IN-NeerjaNeural', lang: 'en-IN', gender: 'Female', label: 'Neerja (India) · female' },
    { name: 'en-IN-PrabhatNeural', lang: 'en-IN', gender: 'Male', label: 'Prabhat (India) · male' },
    { name: 'hi-IN-SwaraNeural', lang: 'hi-IN', gender: 'Female', label: 'Swara (हिन्दी) · female' },
    { name: 'hi-IN-MadhurNeural', lang: 'hi-IN', gender: 'Male', label: 'Madhur (हिन्दी) · male' },
    { name: 'ur-PK-UzmaNeural', lang: 'ur-PK', gender: 'Female', label: 'Uzma (اردو) · female' },
    { name: 'ur-PK-AsadNeural', lang: 'ur-PK', gender: 'Male', label: 'Asad (اردو) · male' },
    { name: 'ur-IN-GulNeural', lang: 'ur-IN', gender: 'Female', label: 'Gul (Urdu IN) · female' },
    { name: 'ur-IN-SalmanNeural', lang: 'ur-IN', gender: 'Male', label: 'Salman (Urdu IN) · male' }
  ];

  // Which Edge voice best matches an STT language code (Section IId).
  function voiceForLang(lang) {
    const L = String(lang || '').toLowerCase();
    const preferred = {
      'hi': 'hi-IN-SwaraNeural',
      'ur': 'ur-PK-UzmaNeural',
      'en-gb': 'en-GB-SoniaNeural',
      'en-in': 'en-IN-NeerjaNeural'
    };
    for (const [prefix, voice] of Object.entries(preferred)) {
      if (L === prefix || L.startsWith(prefix)) return voice;
    }
    return 'en-US-AriaNeural';
  }

  function isAvailable() {
    return typeof WebSocket !== 'undefined';
  }

  /**
   * Synthesize one chunk of text with a real Edge neural voice.
   * Returns { ok, url, voice } where url is an object URL to an mp3 blob.
   */
  function synth(text, opts = {}) {
    return new Promise(async (resolve) => {
      if (!isAvailable()) return resolve({ ok: false, error: 'no-websocket' });
      const voice = opts.voice || 'en-US-AriaNeural';
      const rate = clamp(opts.rate, 0.5, 1.5);
      const pitch = clamp(opts.pitch, 0.5, 1.5);
      const volume = clamp(opts.volume, 0.5, 1.2);
      const pauseMs = clamp(opts.pauseMs || 0, 0, 2000);

      const connId = uuid();
      const reqId = uuid();
      let ws;
      let audioParts = [];
      let boundaries = [];   // S5: WordBoundary metadata for real visemes
      let settled = false;
      let settleTimer = null;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(settleTimer);
        try { if (ws) ws.close(); } catch (e) {}
        resolve(result);
      };

      try {
        ws = new WebSocket(await buildUrl(connId));
      } catch (e) {
        return resolve({ ok: false, error: 'ws-construct' });
      }

      const lang = (VOICES.find((v) => v.name === voice) || {}).lang || 'en-US';
      const breakTag = pauseMs > 0 ? `<break time="${Math.round(pauseMs)}ms"/>` : '';
      const escaped = String(text || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
        `<voice name='${voice}'><prosody rate='${rate.toFixed(2)}' pitch='${pitch.toFixed(2)}' volume='${volume.toFixed(2)}'>` +
        breakTag + escaped +
        `</prosody></voice></speak>`;

      ws.onopen = () => {
        try {
          ws.send(
            `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
          );
          ws.send(
            `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n` + ssml
          );
        } catch (e) { done({ ok: false, error: 'send' }); }
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          // S5: audio.metadata frames carry WordBoundary events. Offsets are in
          // 100-nanosecond ticks from the start of the audio, so /10000 = ms.
          if (/Path:\s*audio\.metadata/i.test(ev.data)) {
            try {
              const body = ev.data.slice(ev.data.indexOf('\r\n\r\n') + 4);
              const meta = JSON.parse(body);
              for (const m of meta.Metadata || []) {
                if (m.Type !== 'WordBoundary' || !m.Data) continue;
                boundaries.push({
                  offsetMs: Math.round((m.Data.Offset || 0) / 10000),
                  durationMs: Math.round((m.Data.Duration || 0) / 10000),
                  text: (m.Data.text && m.Data.text.Text) || ''
                });
              }
            } catch (e) { /* metadata is optional */ }
          }
          return;
        }
        // Binary frame layout (R2). The Edge Read-Aloud protocol prefixes each
        // binary message with a TWO-byte BIG-ENDIAN header length, followed by
        // the ASCII header block, and the audio payload begins immediately at
        // 2 + headerLen. 2.1 read a FOUR-byte length and then skipped a further
        // 2-6 bytes, so `offset` always overran the buffer and every synthesis
        // resolved 'no-audio' — Edge TTS could never actually play.
        try {
          const buf = ev.data;
          const data = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
          if (data.length < 3) return;
          const headerLen = (data[0] << 8) | data[1];
          const offset = 2 + headerLen;
          if (offset >= data.length) return;
          // Only "Path:audio" frames carry sound; turn.start/metadata do not.
          const header = new TextDecoder('utf-8').decode(data.subarray(2, offset));
          if (!/Path:\s*audio/i.test(header)) return;
          const audio = data.subarray(offset);
          if (audio.length) audioParts.push(new Uint8Array(audio));
        } catch (e) { /* skip malformed frame */ }
      };

      ws.onerror = () => { done({ ok: false, error: 'ws-error' }); };
      ws.onclose = () => {
        if (audioParts.length) {
          try {
            const len = audioParts.reduce((n, a) => n + a.length, 0);
            const merged = new Uint8Array(len);
            let at = 0;
            for (const a of audioParts) { merged.set(a, at); at += a.length; }
            const blob = new Blob([merged.buffer], { type: 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            return done({ ok: true, url, voice, boundaries });
          } catch (e) { return done({ ok: false, error: 'blob' }); }
        }
        done({ ok: false, error: 'no-audio' });
      };

      settleTimer = setTimeout(() => done({ ok: false, error: 'timeout', parts: audioParts.length }), 15000);
    });
  }

  function clamp(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  const edgeTts = { VOICES, isAvailable, synth, voiceForLang };
  window.edgeTts = edgeTts;
})();
