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

  // --------------------------------------------------------------------------
  // The catalog. Model IDs here were reconciled against each provider's own
  // deprecation notice on CATALOG_REVISION below — provider catalogs move
  // several times a year and a retired ID fails with a bare 404 that reads to
  // a user as "GemAir is broken". Two guards exist:
  //   1. GemAirModelCurrency.repairModelId() heals stale saved settings.
  //   2. scripts/catalog-currency-test.js fails CI if a retired ID reappears.
  // `verified` marks entries checked against a first-party deprecation/models
  // page; the rest are documented-but-unconfirmed, so the picker says so.
  // --------------------------------------------------------------------------
  const CATALOG_REVISION = (window.GemAirModelCurrency && window.GemAirModelCurrency.CATALOG_REVISION) || 'unknown';

  const PROVIDERS = [
    {
      id: 'gemini', name: 'Google Gemini', free: true, noCard: true, verified: true,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      keyUrl: 'https://aistudio.google.com/apikey',
      nativeHeader: 'x-goog-api-key',
      note: 'Frontier Flash models, permanent free tier. Since 2026-05 the free tier is Flash-only (Pro needs billing); the 2.0 family was retired 2026-06-01.',
      models: [
        { id: 'gemini-3.5-flash', free: true },
        { id: 'gemini-3.1-flash-lite', free: true },
        { id: 'gemini-2.5-flash', free: true },
        { id: 'gemini-2.5-flash-lite', free: true },
        { id: 'gemma-4-31b-it', free: true }
      ]
    },
    {
      id: 'groq', name: 'Groq', free: true, noCard: true, verified: true,
      baseURL: 'https://api.groq.com/openai/v1',
      keyUrl: 'https://console.groq.com/keys',
      note: 'Very fast open models. The whole Llama 3.x line was shut down 2026-08-16 — GPT-OSS is the current free path.',
      models: [
        { id: 'openai/gpt-oss-120b', free: true },
        { id: 'openai/gpt-oss-20b', free: true },
        { id: 'qwen/qwen3.6-27b', free: true }
      ]
    },
    {
      id: 'openrouter', name: 'OpenRouter', free: true, noCard: true, verified: true,
      baseURL: 'https://openrouter.ai/api/v1',
      keyUrl: 'https://openrouter.ai/keys',
      note: 'One key, hundreds of models. Free routes MUST carry the :free suffix, otherwise they bill against credits.',
      models: [
        { id: 'meta-llama/llama-3.3-70b-instruct:free', free: true },
        { id: 'deepseek/deepseek-chat-v3-0324:free', free: true },
        { id: 'z-ai/glm-5.2:free', free: true },
        { id: 'qwen/qwen3-coder:free', free: true }
      ]
    },
    {
      id: 'zai', name: 'Z.AI (GLM)', free: true, noCard: true, verified: true,
      baseURL: 'https://api.z.ai/api/paas/v4',
      keyUrl: 'https://z.ai/subscribe/api-key',
      note: 'GLM Flash models are priced at $0 (not a trial). glm-4-flash was replaced by the 4.7/4.5 Flash line.',
      models: [
        { id: 'glm-4.7-flash', free: true },
        { id: 'glm-4.5-flash', free: true },
        { id: 'glm-4.6v-flash', free: true }
      ]
    },
    {
      id: 'sambanova', name: 'SambaNova', free: true, noCard: true, verified: true,
      baseURL: 'https://api.sambanova.ai/v1',
      keyUrl: 'https://cloud.sambanova.ai',
      note: 'Fast open models on RDU silicon, 200k tokens/day free per model. Llama 3.1 8B was removed 2026-04-14.',
      models: [
        { id: 'Meta-Llama-3.3-70B-Instruct', free: true },
        { id: 'DeepSeek-V3.1', free: true },
        { id: 'gpt-oss-120b', free: true },
        { id: 'Gemma-4-31B-it', free: true }
      ]
    },
    {
      id: 'cerebras', name: 'Cerebras', free: false, noCard: false, verified: true,
      baseURL: 'https://api.cerebras.ai/v1',
      keyUrl: 'https://cloud.cerebras.ai',
      note: 'Fastest public inference. The standing free tier ended 2026-07-21 — it is now a one-time $5 trial, and Llama/Qwen moved to dedicated endpoints.',
      models: [
        { id: 'gpt-oss-120b', free: false },
        { id: 'llama3.1-8b', free: false }
      ]
    },
    {
      id: 'mistral', name: 'Mistral', free: true, noCard: true,
      baseURL: 'https://api.mistral.ai/v1',
      keyUrl: 'https://console.mistral.ai',
      note: 'Mistral Small/Large + Codestral. Free Experiment plan, no card required.',
      models: [
        { id: 'mistral-small-latest', free: true },
        { id: 'mistral-large-latest', free: true },
        { id: 'codestral-latest', free: true },
        { id: 'devstral-small-latest', free: true }
      ]
    },
    {
      id: 'nvidia', name: 'NVIDIA NIM', free: true, noCard: true,
      baseURL: 'https://integrate.api.nvidia.com/v1',
      keyUrl: 'https://build.nvidia.com',
      note: 'Large open catalog on a credit allotment. Confirm the model is still listed on build.nvidia.com before relying on it.',
      models: [
        { id: 'meta/llama-3.3-70b-instruct', free: true },
        { id: 'deepseek-ai/deepseek-r1', free: true }
      ]
    },
    {
      id: 'together', name: 'Together AI', free: false,
      baseURL: 'https://api.together.xyz/v1',
      keyUrl: 'https://api.together.xyz/settings/api-keys',
      note: 'Large open-model catalog. Sign-up credits rather than a standing free tier.',
      models: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', free: true },
        { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', free: true }
      ]
    },
    {
      id: 'fireworks', name: 'Fireworks AI', free: false,
      baseURL: 'https://api.fireworks.ai/inference/v1',
      keyUrl: 'https://fireworks.ai/login',
      note: 'Fast Llama/DeepSeek-R1 with trial credit rather than a standing free tier.',
      models: [
        { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', free: true }
      ]
    },
    {
      id: 'xai', name: 'xAI (Grok)', free: false, noCard: true, verified: true,
      baseURL: 'https://api.x.ai/v1',
      keyUrl: 'https://console.x.ai',
      note: 'Grok via API. Grok 3/4/4-Fast were retired 2026-05-15; access is monthly signup credits, not a free model tier.',
      models: [
        { id: 'grok-4.1-fast', free: false },
        { id: 'grok-4.20', free: false }
      ]
    },
    {
      id: 'cohere', name: 'Cohere', free: true, noCard: true,
      baseURL: 'https://api.cohere.ai/v1',
      keyUrl: 'https://cohere.com/api-key',
      note: 'Command R/R+ trial key: ~1,000 calls/month, non-commercial only.',
      models: [
        { id: 'command-r-plus', free: true },
        { id: 'command-r', free: true }
      ]
    },
    {
      id: 'hf', name: 'Hugging Face', free: true, noCard: true,
      baseURL: 'https://router.huggingface.co/v1',
      keyUrl: 'https://huggingface.co/settings/tokens',
      note: '3000+ open models behind a small monthly credit allowance.',
      models: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct', free: true },
        { id: 'Qwen/Qwen2.5-72B-Instruct', free: true }
      ]
    },
    {
      id: 'deepseek', name: 'DeepSeek', free: false, noCard: true,
      baseURL: 'https://api.deepseek.com/v1',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      note: 'V3 / R1 reasoning. Very cheap; signup credit rather than a free tier.',
      models: [
        { id: 'deepseek-chat', free: true },
        { id: 'deepseek-reasoner', free: true }
      ]
    },
    {
      id: 'hyperbolic', name: 'Hyperbolic', free: true,
      baseURL: 'https://api.hyperbolic.xyz/v1',
      keyUrl: 'https://app.hyperbolic.xyz',
      note: 'Open models + free credits. Llama 3.1 70B was delisted; use 3.3.',
      models: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct', free: true },
        { id: 'Qwen/Qwen2.5-72B-Instruct', free: true }
      ]
    },
    {
      id: 'deepinfra', name: 'DeepInfra', free: false,
      baseURL: 'https://api.deepinfra.com/v1/openai',
      keyUrl: 'https://deepinfra.com',
      note: 'Massive open-model catalog, fast. Credit-based.',
      models: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct', free: true }
      ]
    },
    {
      id: 'siliconflow', name: 'SiliconFlow', free: true,
      baseURL: 'https://api.siliconflow.cn/v1',
      keyUrl: 'https://cloud.siliconflow.cn',
      note: 'Open models with a free allowance. Uses the .cn host — the .com mirror is not the documented endpoint.',
      models: [
        { id: 'Qwen/Qwen2.5-72B-Instruct', free: true }
      ]
    },
    {
      id: 'novita', name: 'Novita AI', free: false,
      baseURL: 'https://api.novita.ai/v3/openai',
      keyUrl: 'https://novita.ai',
      note: 'Open models incl. DeepSeek. Signup credits.',
      models: [
        { id: 'meta-llama/llama-3.3-70b-instruct', free: true }
      ]
    },
    {
      id: 'openai', name: 'ChatGPT / OpenAI', free: false,
      baseURL: 'https://api.openai.com/v1',
      keyUrl: 'https://platform.openai.com/api-keys',
      note: 'Paid OpenAI key. Prefer Connect ChatGPT in Settings — your existing plan, no API billing.',
      models: [
        { id: 'gpt-5.6-terra', free: false },
        { id: 'gpt-5.6-luna', free: false },
        { id: 'gpt-5.5', free: false }
      ]
    },
    {
      id: 'claude', name: 'Anthropic Claude', free: false,
      baseURL: 'https://api.anthropic.com/v1',
      keyUrl: 'https://console.anthropic.com',
      note: 'Best-in-class reasoning. Paid key only — GemAir stays keyless by default.',
      models: [
        { id: 'claude-sonnet-5', free: false },
        { id: 'claude-opus-5', free: false },
        { id: 'claude-haiku-4-5', free: false }
      ]
    },
    {
      id: 'ollama', name: 'Ollama (local)', free: true, noCard: true, local: true,
      baseURL: 'http://localhost:11434/v1',
      keyUrl: '',
      note: '100% offline, local, keyless. Pull any model with `ollama pull …`.',
      models: [
        { id: 'llama3.2', free: true, local: true },
        { id: 'qwen3:14b', free: true, local: true },
        { id: 'gpt-oss:20b', free: true, local: true },
        { id: 'llava', free: true, local: true }
      ]
    }
  ];

  // Heal retired model IDs straight in the catalog, so every consumer (the
  // picker, the presets, the /models command) sees live IDs only.
  const CURRENCY = window.GemAirModelCurrency || null;
  if (CURRENCY && CURRENCY.repairModelId) {
    PROVIDERS.forEach((p) => {
      p.models = p.models
        .map((m) => ({ ...m, id: CURRENCY.repairModelId(m.id, p.id).model }))
        .filter((m, i, arr) => m.id && arr.findIndex((x) => x.id === m.id) === i);
    });
  }

  // Ordered: free + no card first so the "free models" picker is useful.
  const FREE_MODELS = [];
  PROVIDERS.forEach((p) => {
    p.models.forEach((m) => {
      if (m.free && !m.local) FREE_MODELS.push({ provider: p.id, providerName: p.name, baseURL: p.baseURL, model: m.id, note: p.note, keyUrl: p.keyUrl });
    });
  });

  function byId(id) { return PROVIDERS.find((p) => p.id === id); }

  function detect(base) {
    // The shared ledger owns the URL→provider question (it also answers it for
    // the desktop main process and the serverless proxy); the catalog is passed
    // in so a listed provider always wins over the generic host hints.
    if (CURRENCY && CURRENCY.providerForBase) return CURRENCY.providerForBase(base, PROVIDERS);
    const b = (base || '').toLowerCase();
    if (!b) return 'free';
    if (/localhost|127\.0\.0\.1/.test(b)) return 'ollama';
    const hit = PROVIDERS.find((p) => p.baseURL && b.includes(p.baseURL.replace(/^https?:\/\//, '').split('/')[0]));
    if (hit) return hit.id;
    if (b.includes('openai.com')) return 'openai';
    if (b.includes('anthropic.com')) return 'claude';
    return 'custom';
  }

  /** One-click Settings preset for a provider: { baseURL, model, apiKey }. */
  function presetFor(id) {
    const p = byId(id);
    if (!p) return null;
    const first = (p.models[0] && p.models[0].id) || '';
    return { id: p.id, name: p.name, baseURL: p.baseURL, model: first, apiKey: p.local ? '' : undefined, keyUrl: p.keyUrl };
  }

  /** Repair a possibly stale saved model id against this catalog + ledger. */
  function repairModel(id, providerId) {
    if (CURRENCY && CURRENCY.repairModelId) return CURRENCY.repairModelId(id, providerId);
    return { model: String(id || ''), repaired: false, from: String(id || ''), reason: '' };
  }

  window.GemAirProviders = {
    PROVIDERS, FREE_MODELS, byId, detect, presetFor, repairModel, CATALOG_REVISION,
    name: (id) => (byId(id) ? byId(id).name : (id === 'custom' ? 'Custom endpoint' : id === 'free' ? 'Free Core' : id || '—'))
  };
})();
