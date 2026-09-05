/* ============================================================
   GemAir — AI transport and optional in-browser inference
   Layer A: Server SSE proxy or direct provider API
   Layer B: WebGPU / In-Browser Client Model Execution
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

  // Network chunks are not SSE events. Decode UTF-8 incrementally and dispatch
  // only complete frames (also accepting a final frame without a blank line).
  async function* chatEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', data = [], event = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error('SSE_FRAME_TOO_LARGE');
        let match;
        while ((match = /[\r\n]/.exec(buffer))) {
          const i = match.index;
          if (!done && buffer[i] === '\r' && i === buffer.length - 1) break;
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + (buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1));
          if (!line) {
            if (data.length) yield { data: data.join('\n'), event };
            data = []; event = '';
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /, ''));
            if (data.join('\n').length > 1024 * 1024) throw new Error('SSE_FRAME_TOO_LARGE');
          } else if (line.startsWith('event:')) event = line.slice(6).trim();
        }
        if (done) {
          if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
          if (data.length) yield { data: data.join('\n'), event };
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function readChatResponse(response, onDelta, provenance, server, signal) {
    let reply = '', completed = false;
    const meta = { ...provenance, status: response.status };
    const failure = (data, fallback) => ({
      ...meta, ok: false,
      error: typeof data.error === 'string' ? data.error : fallback,
      message: data.message || (data.error && data.error.message) || 'AI request failed. Check the service configuration and retry.',
      ...(typeof data.retryable === 'boolean' ? { retryable: data.retryable } : {}),
      ...(data.retryAfter != null ? { retryAfter: data.retryAfter } : {}),
      ...(Array.isArray(data.attempts) ? { attempts: data.attempts } : {}),
      ...(reply ? { partial: true, partialReply: reply } : {})
    });
    const updateMeta = (data) => {
      if (server && typeof data.provider === 'string') meta.provider = data.provider;
      if (typeof data.model === 'string') meta.model = data.model;
      if (typeof data.free === 'boolean') meta.free = data.free;
    };
    const emit = (delta) => {
      reply += delta;
      if (typeof onDelta === 'function') onDelta(delta, { ...meta });
    };
    try {
      if (signal && signal.aborted) throw new Error('ABORTED');
      if (!response.ok) {
        const parsed = await response.json().catch(() => null);
        const data = parsed && typeof parsed === 'object' ? parsed : {};
        updateMeta(data);
        const retryAfter = response.headers.get('retry-after');
        if (data.retryAfter == null && retryAfter) data.retryAfter = Number(retryAfter) || retryAfter;
        return failure(data, 'HTTP_' + response.status);
      }
      if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
        const data = await response.json();
        if (!data || typeof data !== 'object') return failure({}, 'INVALID_COMPLETION');
        updateMeta(data);
        if (data.error || data.ok === false) return failure(data, 'UPSTREAM_ERROR');
        const text = server ? data.reply : data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if ((server && data.ok !== true) || typeof text !== 'string' || !text.trim()) return failure({}, 'INVALID_COMPLETION');
        emit(text); // A real non-stream completion, delivered once, not simulated typing.
      } else {
        if (!response.body || typeof response.body.getReader !== 'function') return failure({}, 'STREAM_UNSUPPORTED');
        for await (const frame of chatEvents(response.body)) {
          if (signal && signal.aborted) throw new Error('ABORTED');
          if (!server && frame.data.trim() === '[DONE]') { completed = true; break; }
          const data = JSON.parse(frame.data);
          if (!data || typeof data !== 'object') throw new Error('INVALID_STREAM_EVENT');
          updateMeta(data);
          if (frame.event === 'error' || data.error || data.ok === false) return failure(data, 'UPSTREAM_STREAM_ERROR');
          const choice = data.choices && data.choices[0];
          const delta = server ? data.delta : choice && choice.delta && choice.delta.content;
          if (delta != null && typeof delta !== 'string') throw new Error('INVALID_DELTA');
          if (delta) emit(delta);
          if (server && data.done === true) {
            if (typeof data.reply === 'string') {
              if (!reply) emit(data.reply);
              else if (data.reply !== reply) throw new Error('STREAM_REPLY_MISMATCH');
            }
            completed = true;
            break;
          }
          if (!server && choice && choice.finish_reason != null) completed = true;
        }
        if (!completed) return failure({}, 'STREAM_INTERRUPTED');
      }
      if (!reply.trim()) return failure({}, 'EMPTY_COMPLETION');
      return { ...meta, ok: true, reply };
    } catch (error) {
      return failure({ message: error.message }, signal && signal.aborted ? 'ABORTED' : 'INVALID_RESPONSE');
    }
  }

  /**
   * POST /api/chat. onDelta(text, {via, provider, model, status}) receives real
   * deltas only. JSON completions arrive once. Returns a result, never retries
   * a failed/partial stream or silently switches to direct/local providers.
   * options: endpoint, userId, stream, signal, timeoutMs (default 120000).
   */
  async function serverChat(messages, onDelta, options = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    try {
      const body = {
        messages,
        stream: options.stream !== false && typeof onDelta === 'function' && typeof ReadableStream !== 'undefined'
      };
      const userId = options.userId === undefined ? window.__gemairUserId : options.userId;
      if (userId) body.userId = userId;
      const response = await fetch(options.endpoint || '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream, application/json' : 'application/json' },
        body: JSON.stringify(body), signal: controller.signal
      });
      const result = await readChatResponse(response, onDelta, { via: 'server' }, true, controller.signal);
      if (timedOut) return { ...result, ok: false, error: 'TIMEOUT', message: 'Server chat timed out. Retry the request.' };
      return result;
    } catch (error) {
      return { ok: false, via: 'server', error: timedOut ? 'TIMEOUT' : controller.signal.aborted ? 'ABORTED' : 'NETWORK_ERROR', message: timedOut ? 'Server chat timed out. Retry the request.' : error.message };
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abort);
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
    const url = baseURL + (baseURL.endsWith('/chat/completions') ? '' : '/chat/completions');
    const provenance = { via: 'direct', provider: baseURL, model };

    const isLocal = /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(baseURL);
    if (!key && !isLocal) {
      return { ...provenance, ok: false, error: 'NO_KEY', message: 'Add credentials for this provider or explicitly choose server chat.' };
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

      return await readChatResponse(response, onDelta, provenance, false);
    } catch (err) {
      return { ...provenance, ok: false, error: 'NETWORK_ERROR', message: err.message || 'Direct API call failed' };
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
    serverChat,
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
