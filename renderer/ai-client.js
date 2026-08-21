/* ============================================================
   GemAir — Client-Side Zero-Server AI Engine
   Layer A: Direct Client-Side Groq / OpenAI API Call (Zero Backend Required)
   Layer B: WebGPU / In-Browser Client Model Execution
   Layer C: Offline Intent Brain Fallback
   ============================================================ */
(function () {
  'use strict';

  // Check WebGPU support in current browser
  async function checkWebGPU() {
    try {
      if (!navigator.gpu) return false;
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch (e) {
      return false;
    }
  }

  /**
   * Direct client-side API completion (Groq / OpenAI (ChatGPT) / Gemini /
   * Claude / OpenRouter / Ollama). These providers expose browser-CORS
   * OpenAI-compatible endpoints, so no server-side proxy is required!
   */
  async function directClientChat(config, messages, onDelta) {
    const key = (config && config.apiKey || '').trim();
    let baseURL = (config && config.baseURL || '').trim();
    let model = (config && config.model || '').trim();

    if (!baseURL) baseURL = 'https://api.groq.com/openai/v1';
    if (!model) model = 'llama-3.3-70b-versatile';

    baseURL = baseURL.replace(/\/+$/, '');
    const url = baseURL + '/chat/completions';

    const isLocal = /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(baseURL);
    if (!key && !isLocal) {
      return { ok: false, error: 'NO_KEY' };
    }

    try {
      const isStream = typeof onDelta === 'function';
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = 'Bearer ' + key;
      // Native auth headers some providers want alongside Bearer:
      if (key && baseURL.includes('generativelanguage.googleapis.com')) headers['x-goog-api-key'] = key; // Gemini
      if (key && baseURL.includes('api.anthropic.com')) { // Claude (OpenAI-compatible endpoint)
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.6,
          max_tokens: 1200,
          stream: isStream
        })
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { ok: false, error: `HTTP_${response.status}: ${errText.slice(0, 150)}` };
      }

      if (isStream && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let fullText = '';
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (trimmed.startsWith('data: ')) {
              try {
                const json = JSON.parse(trimmed.slice(6));
                const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
                if (delta) {
                  fullText += delta;
                  onDelta(delta);
                }
              } catch (e) {}
            }
          }
        }
        return { ok: true, reply: fullText.trim() };
      } else {
        const data = await response.json();
        const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        return { ok: true, reply: (reply || '').trim() };
      }
    } catch (err) {
      return { ok: false, error: err.message || 'Direct API call failed' };
    }
  }

  // =========================================================================
  // Layer B — WebGPU in-browser model (S8)
  //
  // 2.1 shipped checkWebGPU() as a probe whose result was never used: nothing
  // consulted it, nothing loaded a model, and Layer B was purely aspirational
  // in the file header. This turns it into a REAL optional tier in the fallback
  // chain (direct key -> free core -> WebGPU local -> offline intent brain).
  //
  // The model weights are large, so this tier is strictly OPT-IN: it only ever
  // loads after enableLocalModel() is called (Settings toggle), it streams from
  // a CDN, and every failure degrades silently to the next tier. Nothing about
  // the default experience changes, and no download happens unless asked.
  // =========================================================================
  const LOCAL_MODEL = {
    // Small instruct model that fits comfortably in browser memory.
    id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    esm: 'https://esm.run/@mlc-ai/web-llm'
  };

  let localState = 'idle';       // idle | loading | ready | unavailable
  let localEngine = null;
  let localLoadPromise = null;
  let localProgress = 0;

  function localStatus() {
    return { state: localState, progress: localProgress, model: LOCAL_MODEL.id };
  }

  function emitLocalStatus(detail) {
    try {
      document.dispatchEvent(new CustomEvent('gemair:localbrain', { detail: detail || localStatus() }));
    } catch (e) {}
  }

  /**
   * Download + initialise the in-browser model. Safe to call repeatedly; the
   * same promise is reused. Returns true once the engine can answer.
   */
  async function enableLocalModel(onProgress) {
    if (localState === 'ready') return true;
    if (localState === 'unavailable') return false;
    if (localLoadPromise) return localLoadPromise;

    localLoadPromise = (async () => {
      if (!(await checkWebGPU())) {
        localState = 'unavailable';
        emitLocalStatus({ state: localState, error: 'no-webgpu' });
        return false;
      }
      localState = 'loading';
      emitLocalStatus();
      try {
        const webllm = await import(/* webpackIgnore: true */ LOCAL_MODEL.esm);
        localEngine = await webllm.CreateMLCEngine(LOCAL_MODEL.id, {
          initProgressCallback: (report) => {
            localProgress = Math.round((report && report.progress ? report.progress : 0) * 100);
            if (typeof onProgress === 'function') onProgress(localProgress, report && report.text);
            emitLocalStatus({ state: 'loading', progress: localProgress, text: report && report.text });
          }
        });
        localState = 'ready';
        localProgress = 100;
        emitLocalStatus();
        return true;
      } catch (e) {
        localState = 'unavailable';
        localEngine = null;
        emitLocalStatus({ state: localState, error: (e && e.message) || 'load-failed' });
        return false;
      } finally {
        localLoadPromise = null;
      }
    })();

    return localLoadPromise;
  }

  function disableLocalModel() {
    try { if (localEngine && localEngine.unload) localEngine.unload(); } catch (e) {}
    localEngine = null;
    localState = 'idle';
    localProgress = 0;
    emitLocalStatus();
  }

  /** Answer from the local model. Returns { ok:false } unless it is READY. */
  async function localChat(messages, onDelta) {
    if (localState !== 'ready' || !localEngine) return { ok: false, error: 'LOCAL_NOT_READY' };
    try {
      if (typeof onDelta === 'function') {
        const stream = await localEngine.chat.completions.create({ messages, stream: true, temperature: 0.6, max_tokens: 800 });
        let full = '';
        for await (const part of stream) {
          const delta = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
          if (delta) { full += delta; onDelta(delta); }
        }
        return { ok: !!full.trim(), reply: full.trim(), via: 'webgpu' };
      }
      const res = await localEngine.chat.completions.create({ messages, temperature: 0.6, max_tokens: 800 });
      const reply = res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
      return { ok: !!reply, reply: (reply || '').trim(), via: 'webgpu' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'local-chat-failed' };
    }
  }

  const aiClient = {
    checkWebGPU,
    directClientChat,
    // S8 — Layer B, now real
    enableLocalModel,
    disableLocalModel,
    localChat,
    localStatus,
    isLocalReady: () => localState === 'ready',
    LOCAL_MODEL,
    async isWebGpuSupported() {
      return await checkWebGPU();
    }
  };

  window.aiClient = aiClient;
})();
