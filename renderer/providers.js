/* ============================================================
   GemAir — AI Provider & Free-Model Catalog (shared, single source of truth)
   ------------------------------------------------------------
   A curated, current directory of OpenAI-compatible AI providers and the
   FREE models each exposes. Used by:
     • Settings → AI BRAIN (provider presets + a free-model picker)
     • detectProvider() / PROVIDER_NAMES (status chips, hints)
     • the /providers and /models slash commands
     • resolveComputerUseConfig() hints (desktop / coding agents)

   Design: free-first, keyless-first. Every entry speaks the OpenAI
   chat/completions protocol, and the SAME tool-calling engine drives them all.
   Claude is intentionally NOT in the free catalog (GemAir is keyless/no-vendor);
   the app still detects an Anthropic base URL if a user pastes one.
   ============================================================ */
(function () {
  'use strict';

  const PROVIDERS = [
    {
      id: 'groq', name: 'Groq', free: true, noCard: true,
      baseURL: 'https://api.groq.com/openai/v1',
      keyUrl: 'https://console.groq.com/keys',
      note: 'Ultra-fast Llama/Qwen/Mistral. Generous free tier, no credit card.',
      models: [
        { id: 'llama-3.1-8b-instant', free: true },
        { id: 'llama-3.3-70b-versatile', free: true },
        { id: 'qwen-2.5-32b', free: true },
        { id: 'mixtral-8x7b-32768', free: true }
      ]
    },
    {
      id: 'gemini', name: 'Google Gemini', free: true, noCard: true,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      keyUrl: 'https://aistudio.google.com/apikey',
      nativeHeader: 'x-goog-api-key',
      note: 'Frontier models, permanent free tier (~1,500 req/day).',
      models: [
        { id: 'gemini-2.5-flash', free: true },
        { id: 'gemini-2.0-flash', free: true },
        { id: 'gemini-flash-latest', free: true }
      ]
    },
    {
      id: 'cerebras', name: 'Cerebras', free: true, noCard: true,
      baseURL: 'https://api.cerebras.ai/v1',
      keyUrl: 'https://cloud.cerebras.ai',
      note: '2,600+ tokens/sec. Free daily tier, 1M tokens/day.',
      models: [
        { id: 'llama-3.3-70b', free: true },
        { id: 'qwen-3-32b', free: true },
        { id: 'gpt-oss-120b', free: true }
      ]
    },
    {
      id: 'sambanova', name: 'SambaNova', free: true, noCard: true,
      baseURL: 'https://api.sambanova.ai/v1',
      keyUrl: 'https://cloud.sambanova.ai',
      note: 'Fast Llama up to 405B. Free tier, no credit card.',
      models: [
        { id: 'Meta-Llama-3.1-8B-Instruct', free: true },
        { id: 'Meta-Llama-3.3-70B-Instruct', free: true }
      ]
    },
    {
      id: 'nvidia', name: 'NVIDIA NIM', free: true, noCard: true,
      baseURL: 'https://integrate.api.nvidia.com/v1',
      keyUrl: 'https://build.nvidia.com',
      note: '90+ models incl. DeepSeek-R1, Llama, Kimi. Free credits.',
      models: [
        { id: 'meta/llama-3.3-70b-instruct', free: true },
        { id: 'deepseek-ai/deepseek-r1', free: true }
      ]
    },
    {
      id: 'together', name: 'Together AI', free: true,
      baseURL: 'https://api.together.xyz/v1',
      keyUrl: 'https://api.together.xyz/settings/api-keys',
      note: '200+ open models. Sign-up credits + free-tier models.',
      models: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', free: true },
        { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', free: true }
      ]
    },
    {
      id: 'fireworks', name: 'Fireworks AI', free: true,
      baseURL: 'https://api.fireworks.ai/inference/v1',
      keyUrl: 'https://fireworks.ai/login',
      note: 'Fast Llama/DeepSeek-R1. Free tier + trial credit.',
      models: [
        { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', free: true }
      ]
    },
    {
      id: 'xai', name: 'xAI (Grok)', free: true,
      baseURL: 'https://api.x.ai/v1',
      keyUrl: 'https://console.x.ai',
      note: 'Grok models. Sign-up credits; free data tier.',
      models: [
        { id: 'grok-3-mini', free: true },
        { id: 'grok-4-fast', free: true }
      ]
    },
    {
      id: 'zai', name: 'Z.AI (GLM)', free: true,
      baseURL: 'https://api.z.ai/api/paas/v4',
      keyUrl: 'https://z.ai/glm',
      nativeHeader: 'x-api-key',
      note: 'GLM reasoning models. Free-tier friendly.',
      models: [
        { id: 'glm-4-flash', free: true }
      ]
    },
    {
      id: 'cohere', name: 'Cohere', free: true,
      baseURL: 'https://api.cohere.ai/v1',
      keyUrl: 'https://cohere.com/api-key',
      note: 'Command R/R+ + Aya. Free trial key (~1k calls/mo).',
      models: [
        { id: 'command-r-plus', free: true },
        { id: 'command-r', free: true }
      ]
    },
    {
      id: 'hf', name: 'Hugging Face', free: true, noCard: true,
      baseURL: 'https://router.huggingface.co/v1',
      keyUrl: 'https://huggingface.co/settings/tokens',
      note: '3000+ open models, rate-limited free tier.',
      models: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct', free: true },
        { id: 'Qwen/Qwen2.5-72B-Instruct', free: true }
      ]
    },
    {
      id: 'deepseek', name: 'DeepSeek', free: true, noCard: true,
      baseURL: 'https://api.deepseek.com/v1',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      note: 'V3 / R1 reasoning. Very cheap, generous free start.',
      models: [
        { id: 'deepseek-chat', free: true },
        { id: 'deepseek-reasoner', free: true }
      ]
    },
    {
      id: 'hyperbolic', name: 'Hyperbolic', free: true,
      baseURL: 'https://api.hyperbolic.xyz/v1',
      keyUrl: 'https://app.hyperbolic.xyz',
      note: 'Open models + free tier.',
      models: [
        { id: 'meta-llama/Llama-3.1-70B-Instruct', free: true },
        { id: 'Qwen/Qwen2.5-72B-Instruct', free: true }
      ]
    },
    {
      id: 'deepinfra', name: 'DeepInfra', free: true,
      baseURL: 'https://api.deepinfra.com/v1/openai',
      keyUrl: 'https://deepinfra.com',
      note: 'Massive open-model catalog, fast.',
      models: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct', free: true }
      ]
    },
    {
      id: 'siliconflow', name: 'SiliconFlow', free: true,
      baseURL: 'https://api.siliconflow.com/v1',
      keyUrl: 'https://cloud.siliconflow.com',
      note: 'China-friendly open models, free tier.',
      models: [
        { id: 'Qwen/Qwen2.5-72B-Instruct', free: true }
      ]
    },
    {
      id: 'novita', name: 'Novita AI', free: true,
      baseURL: 'https://api.novita.ai/v3/openai',
      keyUrl: 'https://novita.ai',
      note: 'Open models incl. DeepSeek, flux. Free credits.',
      models: [
        { id: 'meta-llama/llama-3.3-70b-instruct', free: true }
      ]
    },
    {
      id: 'openrouter', name: 'OpenRouter', free: true, noCard: true,
      baseURL: 'https://openrouter.ai/api/v1',
      keyUrl: 'https://openrouter.ai/keys',
      note: 'One key → 300+ models, many free-tier. Best "free models" aggregator.',
      models: [
        { id: 'meta-llama/llama-3.3-70b-instruct', free: true },
        { id: 'meta-llama/llama-3.1-8b-instruct', free: true },
        { id: 'mistralai/mistral-7b-instruct', free: true },
        { id: 'deepseek/deepseek-chat-v3-0324', free: true }
      ]
    },
    {
      id: 'mistral', name: 'Mistral', free: true,
      baseURL: 'https://api.mistral.ai/v1',
      keyUrl: 'https://console.mistral.ai',
      note: 'Mistral Small/Large + Codestral. Free Experiment plan.',
      models: [
        { id: 'mistral-small-latest', free: true },
        { id: 'mistral-large-latest', free: true },
        { id: 'codestral-latest', free: true }
      ]
    },
    {
      id: 'openai', name: 'ChatGPT / OpenAI', free: false,
      baseURL: 'https://api.openai.com/v1',
      keyUrl: 'https://platform.openai.com/api-keys',
      note: 'GPT-4o-mini & friends. Needs a paid/paid-trial OpenAI key.',
      models: [
        { id: 'gpt-4o-mini', free: false },
        { id: 'gpt-4.1-mini', free: false }
      ]
    },
    {
      id: 'claude', name: 'Anthropic Claude', free: false,
      baseURL: 'https://api.anthropic.com/v1',
      keyUrl: 'https://console.anthropic.com',
      note: 'Best-in-class reasoning. Paid key only — GemAir stays keyless by default.',
      models: [
        { id: 'claude-sonnet-4-5', free: false },
        { id: 'claude-haiku-4-5', free: false }
      ]
    },
    {
      id: 'ollama', name: 'Ollama (local)', free: true, noCard: true, local: true,
      baseURL: 'http://localhost:11434/v1',
      keyUrl: '',
      note: '100% offline, local, keyless. Pull any model with `ollama pull …`.',
      models: [
        { id: 'llama3', free: true, local: true },
        { id: 'qwen2.5-coder', free: true, local: true },
        { id: 'llava', free: true, local: true }
      ]
    }
  ];

  // Ordered: free + no card first so the "free models" picker is useful.
  const FREE_MODELS = [];
  PROVIDERS.forEach((p) => {
    p.models.forEach((m) => {
      if (m.free && !m.local) FREE_MODELS.push({ provider: p.id, providerName: p.name, baseURL: p.baseURL, model: m.id, note: p.note, keyUrl: p.keyUrl });
    });
  });

  function byId(id) { return PROVIDERS.find((p) => p.id === id); }

  function detect(base) {
    const b = (base || '').toLowerCase();
    if (!b) return 'free';
    if (/localhost|127\.0\.0\.1/.test(b)) return 'ollama';
    const hit = PROVIDERS.find((p) => p.baseURL && b.includes(p.baseURL.replace(/^https?:\/\//, '').split('/')[0]));
    if (hit) return hit.id;
    if (b.includes('openai.com')) return 'openai';
    if (b.includes('anthropic.com')) return 'claude';
    return 'custom';
  }

  window.GemAirProviders = { PROVIDERS, FREE_MODELS, byId, detect, name: (id) => (byId(id) ? byId(id).name : (id === 'custom' ? 'Custom endpoint' : id === 'free' ? 'Free Core' : id || '—')) };
})();
