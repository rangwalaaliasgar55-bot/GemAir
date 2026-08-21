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

  const aiClient = {
    checkWebGPU,
    directClientChat,
    async isWebGpuSupported() {
      return await checkWebGPU();
    }
  };

  window.aiClient = aiClient;
})();
