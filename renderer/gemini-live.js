/* ============================================================
   GemAir — Gemini Live API dialog transport (renderer).

   Opens the documented bidirectional streaming endpoint and runs a
   TEXT dialog over it. The model ID is always caller-supplied: GemAir
   ships no hardcoded "live" model names, because live model availability
   changes and must be verified in AI Studio docs, not trusted from chat.
   An API key from https://aistudio.google.com/apikey is required.

   Usage:
     const session = await window.geminiLive.connect({
       apiKey, model,
       onText: (text, done) => {...},
       onError: (message) => {...},
       timeoutMs: 30000
     });
     session.send('Hello');
     session.close();
   ============================================================ */
'use strict';

(function () {
  const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

  function buildUrl(apiKey) {
    return ENDPOINT + '?key=' + encodeURIComponent(apiKey);
  }

  function connect(options = {}) {
    const apiKey = String(options.apiKey || '').trim();
    const model = String(options.model || '').trim();
    const onText = typeof options.onText === 'function' ? options.onText : () => {};
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000;

    return new Promise((resolve, reject) => {
      if (!apiKey) { reject(new Error('MISSING_API_KEY')); return; }
      if (!model) { reject(new Error('MISSING_MODEL')); return; }
      if (typeof WebSocket === 'undefined') { reject(new Error('WEBSOCKET_UNAVAILABLE')); return; }

      let settled = false;
      let setupDone = false;
      let ws = null;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { ws && ws.close(); } catch {} reject(new Error('SETUP_TIMEOUT')); }
      }, timeoutMs);

      const session = {
        get ready() { return setupDone && ws && ws.readyState === WebSocket.OPEN; },
        send(text) {
          if (!session.ready) throw new Error('SESSION_NOT_READY');
          ws.send(JSON.stringify({
            clientContent: { turns: [{ role: 'user', parts: [{ text: String(text) }] }], turnComplete: true }
          }));
        },
        close() { try { ws && ws.close(); } catch {} }
      };

      try {
        ws = new WebSocket(buildUrl(apiKey));
      } catch (e) { clearTimeout(timer); reject(new Error('SOCKET_FAILED')); return; }

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            setup: {
              model: 'models/' + model,
              generation_config: { response_modalities: ['TEXT'] }
            }
          }));
        } catch (e) { clearTimeout(timer); reject(new Error('SETUP_SEND_FAILED')); }
      };

      ws.onmessage = (event) => {
        let msg = null;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.setupComplete !== undefined) {
          if (!settled) { settled = true; clearTimeout(timer); setupDone = true; resolve(session); }
          return;
        }
        const content = msg.serverContent;
        if (!content) return;
        const parts = (content.modelTurn && content.modelTurn.parts) || [];
        for (const part of parts) {
          if (part && typeof part.text === 'string' && part.text) {
            try { onText(part.text, content.turnComplete === true); } catch {}
          }
        }
      };

      ws.onerror = () => {
        try { onError('Live socket error — check the API key, model ID, and network.'); } catch {}
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('SOCKET_ERROR')); }
      };

      ws.onclose = () => {
        setupDone = false;
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('SOCKET_CLOSED')); }
      };
    });
  }

  window.geminiLive = { connect, ENDPOINT };
})();
