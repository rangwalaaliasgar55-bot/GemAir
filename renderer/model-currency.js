/**
 * GemAir — model currency ledger (single source of truth).
 *
 * WHY THIS FILE EXISTS
 * Provider catalogs churn constantly. In August 2026 Groq shut down
 * `llama-3.1-8b-instant` and `llama-3.3-70b-versatile`; Google retired the
 * whole Gemini 2.0 family on 2026-06-01; xAI dropped the Grok 3/4 line on
 * 2026-05-15; SambaNova removed `Meta-Llama-3.1-8B-Instruct` on 2026-04-14.
 * A hard-coded model ID is therefore a time bomb: the app keeps its wiring
 * intact and every request starts failing with a bare 404, which users read
 * as "the connection is broken".
 *
 * WHAT IT DOES
 *   • CATALOG_REVISION — the date this ledger was last reconciled upstream.
 *   • RETIRED_MODELS   — dead id -> live replacement (verified against each
 *                         provider's own deprecation notice).
 *   • repairModelId()  — pure migration used at every trust boundary: saved
 *                         profile settings, the serverless free chain, and the
 *                         per-connection Gemini model. A stale preference heals
 *                         itself instead of failing forever.
 *   • isKnownRetired() — used by the catalog-currency test so a retired id can
 *                         never be re-introduced into first-party code.
 *
 * Delivery: CommonJS for Node (api/, main.js, lib/) AND a browser global
 * (`window.GemAirModelCurrency`) so renderer/providers.js and the server share
 * one ledger instead of two drifting copies.
 */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GemAirModelCurrency = api;
}(
  typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this),
  function () {
    'use strict';

    // Bumped whenever this ledger is reconciled against provider docs. Surfaced
    // in Settings so a user can tell how old the built-in catalog is.
    const CATALOG_REVISION = '2026-09-13';

    /**
     * Retired model id -> live replacement.
     * Sources: console.groq.com/docs/deprecations, ai.google.dev model docs,
     * docs.sambanova.ai/models/deprecations, xAI's 2026-05-06 migration notice,
     * Z.ai's current free catalogue, and the OpenAI/Anthropic current ids.
     */
    const RETIRED_MODELS = {
      // ---- Groq (shutdown 2026-08-16 / 2026-07-17 / 2026-03-09 / 2026-04-15) --
      'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
      'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
      'llama-3.3-70b-specdec': 'openai/gpt-oss-120b',
      'llama3-8b-8192': 'openai/gpt-oss-20b',
      'llama3-70b-8192': 'openai/gpt-oss-120b',
      'mixtral-8x7b-32768': 'openai/gpt-oss-120b',
      'gemma2-9b-it': 'openai/gpt-oss-20b',
      'qwen-2.5-32b': 'openai/gpt-oss-120b',
      'qwen-2.5-coder-32b': 'openai/gpt-oss-120b',
      'qwen/qwen3-32b': 'openai/gpt-oss-120b',
      'meta-llama/llama-4-scout-17b-16e-instruct': 'qwen/qwen3.6-27b',
      'meta-llama/llama-4-maverick-17b-128e-instruct': 'openai/gpt-oss-120b',
      'meta-llama/llama-4-scout-17b-16e-instruct': 'qwen/qwen3.6-27b',
      'moonshotai/kimi-k2-instruct-0905': 'openai/gpt-oss-120b',
      'llama-guard-3-8b': 'openai/gpt-oss-safeguard-20b',
      'playai-tts': 'canopylabs/orpheus-v1-english',

      // ---- Google Gemini (2.0 family retired 2026-06-01; 1.5 long gone) ------
      'gemini-pro': 'gemini-2.5-flash',
      'gemini-1.0-pro': 'gemini-2.5-flash',
      'gemini-1.5-flash': 'gemini-2.5-flash',
      'gemini-1.5-flash-8b': 'gemini-2.5-flash-lite',
      'gemini-1.5-pro': 'gemini-2.5-flash',
      'gemini-2.0-flash': 'gemini-2.5-flash',
      'gemini-2.0-flash-001': 'gemini-2.5-flash',
      'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
      'gemini-2.0-flash-lite-001': 'gemini-2.5-flash-lite',
      'gemini-2.0-flash-exp': 'gemini-2.5-flash',
      'gemini-2.0-pro': 'gemini-2.5-flash',
      'gemini-2.5-pro-preview-05-06': 'gemini-2.5-flash',
      // Live / native-audio previews that no longer exist.
      'gemini-2.0-flash-live-001': 'gemini-2.5-flash-native-audio-preview-12-2025',
      'gemini-2.5-flash-native-audio-preview-09-2025': 'gemini-2.5-flash-native-audio-preview-12-2025',

      // ---- xAI (retired 2026-05-15) -----------------------------------------
      'grok-3': 'grok-4.20',
      'grok-3-mini': 'grok-4.1-fast',
      'grok-4': 'grok-4.20',
      'grok-4-0709': 'grok-4.20',
      'grok-4-fast': 'grok-4.1-fast',
      'grok-4-fast-reasoning': 'grok-4.20',
      'grok-4-fast-non-reasoning': 'grok-4.20-non-reasoning',
      'grok-4-1-fast-reasoning': 'grok-4.20',
      'grok-4-1-fast-non-reasoning': 'grok-4.20-non-reasoning',
      'grok-code-fast-1': 'grok-4.1-fast',

      // SambaNova's and Cerebras' removals live in PROVIDER_MODEL_ALIASES
      // below: those ids (`Meta-Llama-3.1-8B-Instruct`, `llama-3.3-70b`,
      // `Qwen2.5-72B-Instruct`, …) are hosted under the same name by other
      // providers where they are perfectly alive, so retiring them globally
      // would "repair" a working config into a broken one.

      // ---- Z.ai (the original glm-4 free line is gone) ----------------------
      'glm-4-flash': 'glm-4.7-flash',
      'glm-4-flash-250414': 'glm-4.7-flash',
      'glm-4-plus': 'glm-4.7',
      'glm-4.5-air': 'glm-4.7',

      // ---- OpenAI (GPT-4 generation retired from the default path) ----------
      'gpt-3.5-turbo': 'gpt-5.5',
      'gpt-4': 'gpt-5.5',
      'gpt-4-turbo': 'gpt-5.5',
      'gpt-4o': 'gpt-5.6-terra',
      'gpt-4o-mini': 'gpt-5.6-luna',
      'gpt-4.1': 'gpt-5.6-terra',
      'gpt-4.1-mini': 'gpt-5.6-luna',
      'gpt-4.1-nano': 'gpt-5.6-luna',
      'o4-mini': 'gpt-5.6-terra',
      'chatgpt-4o-latest': 'gpt-5.6-terra',

      // ---- Anthropic (4.5 generation superseded) ---------------------------
      'claude-3-5-sonnet-20241022': 'claude-sonnet-5',
      'claude-3-7-sonnet-20250219': 'claude-sonnet-5',
      'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
      'claude-sonnet-4-5': 'claude-sonnet-5',
      'claude-opus-4-5': 'claude-opus-5',
      'claude-opus-4-1': 'claude-opus-5',
      'claude-sonnet-4': 'claude-sonnet-5',
      'claude-3-opus-20240229': 'claude-sonnet-5',

      // ---- Hugging Face / Hyperbolic (3.1-70B endpoints delisted) ----------
      'meta-llama/Llama-3.1-70B-Instruct': 'meta-llama/Llama-3.3-70B-Instruct',
      'meta-llama/Meta-Llama-3-70B-Instruct': 'meta-llama/Llama-3.3-70B-Instruct',
      'HuggingFaceH4/zephyr-7b-beta': 'meta-llama/Llama-3.3-8B-Instruct',

      // ---- Together / older Llama-2 era ids --------------------------------
      'togethercomputer/llama-2-70b-chat': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'mistralai/Mistral-7B-Instruct-v0.1': 'mistralai/Mistral-7B-Instruct-v0.3',

    };

    /**
     * Provider-POLICY aliases — not retired everywhere, wrong on ONE host.
     *
     * `meta-llama/llama-3.3-70b-instruct` is a perfectly good model on Novita
     * and DeepInfra, but on OpenRouter the same id bills against credits: the
     * free route is a distinct id ending in `:free`. Putting those in the global
     * ledger would "repair" working configs on other providers, so they are
     * keyed by provider id and only applied there.
     */
    const PROVIDER_MODEL_ALIASES = {
      openrouter: {
        'meta-llama/llama-3.3-70b-instruct': 'meta-llama/llama-3.3-70b-instruct:free',
        'meta-llama/llama-3.1-8b-instruct': 'openai/gpt-oss-20b:free',
        'mistralai/mistral-7b-instruct': 'mistralai/mistral-7b-instruct:free',
        'deepseek/deepseek-chat': 'deepseek/deepseek-chat-v3-0324:free',
        'deepseek/deepseek-r1': 'deepseek/deepseek-r1:free',
        'qwen/qwen3-235b-a22b': 'qwen/qwen3-coder:free'
      },
      // DeepSeek's own host serves these two ids and nothing else.
      deepseek: {
        'deepseek-v3': 'deepseek-chat',
        'deepseek-r1': 'deepseek-reasoner'
      },
      // SambaNova removed Meta-Llama-3.1-8B-Instruct on 2026-04-14, Qwen3-32B
      // and DeepSeek-V3.1-Terminus on 2026-04-06, DeepSeek-V3-0324 /
      // DeepSeek-R1-0528 on 2026-04-14, and gemma-3-12b-it / Llama-4-Maverick
      // on 2026-06-09 (docs.sambanova.ai/models/deprecations).
      sambanova: {
        'Meta-Llama-3.1-8B-Instruct': 'Meta-Llama-3.3-70B-Instruct',
        'Meta-Llama-3.1-70B-Instruct': 'Meta-Llama-3.3-70B-Instruct',
        'Meta-Llama-3.2-3B-Instruct': 'Meta-Llama-3.3-70B-Instruct',
        'Meta-Llama-3.1-405B-Instruct': 'Meta-Llama-3.3-70B-Instruct',
        'Qwen2.5-72B-Instruct': 'Meta-Llama-3.3-70B-Instruct',
        'Qwen3-32B': 'gpt-oss-120b',
        'Qwen3-235B-A22B-Instruct-2507': 'MiniMax-M2.7',
        'DeepSeek-V3-0324': 'DeepSeek-V3.1',
        'DeepSeek-V3.1-Terminus': 'DeepSeek-V3.1',
        'DeepSeek-R1-0528': 'gpt-oss-120b',
        'DeepSeek-R1-Distill-Llama-70B': 'gpt-oss-120b',
        'Llama-4-Maverick-17B-128E-Instruct': 'Gemma-4-31B-it',
        'gemma-3-12b-it': 'Gemma-4-31B-it',
        'Llama-3.3-Swallow-70B-Instruct-v0.4': 'Meta-Llama-3.3-70B-Instruct'
      },
      // Cerebras narrowed its public rate card in 2026 Q2 and replaced the
      // standing free tier with a card-required $5 trial on 2026-07-21. Llama
      // and Qwen3 moved to reserved "Dedicated Endpoints"; the GLM preview
      // expired 2026-08-17. gpt-oss-120b is the stable public default.
      cerebras: {
        'llama-3.3-70b': 'gpt-oss-120b',
        'llama3.1-70b': 'gpt-oss-120b',
        'qwen-3-32b': 'gpt-oss-120b',
        'qwen-3-coder-480b': 'gpt-oss-120b',
        'zai-glm-4.7': 'gpt-oss-120b',
        'zai-glm-4.6': 'gpt-oss-120b',
        'qwen-3-235b-a22b-instruct-2507': 'gpt-oss-120b'
      },
      // NVIDIA's hosted NIM catalog prunes aggressively; these two were listed
      // by GemAir for a long time and are still the common defaults there.
      nvidia: {
        'meta/llama-3.1-8b-instruct': 'meta/llama-3.3-70b-instruct',
        'nvidia/llama-3.1-nemotron-70b-instruct': 'meta/llama-3.3-70b-instruct'
      },
      // Fireworks' account-scoped ids: the bare legacy form was renamed.
      fireworks: {
        'llama-v3p3-70b-instruct': 'accounts/fireworks/models/llama-v3p3-70b-instruct'
      }
    };

    /**
     * Free-tier model names per provider used when a chain entry needs a
     * replacement guess. Ordered: newest/most capable first so a repaired
     * request still lands on a good model.
     */
    const FREE_FIRST_MODEL = {
      groq: 'openai/gpt-oss-120b',
      gemini: 'gemini-3.5-flash',
      cerebras: 'gpt-oss-120b',
      sambanova: 'Meta-Llama-3.3-70B-Instruct',
      nvidia: 'meta/llama-3.3-70b-instruct',
      together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      xai: 'grok-4.1-fast',
      zai: 'glm-4.7-flash',
      cohere: 'command-r',
      hf: 'meta-llama/Llama-3.3-70B-Instruct',
      deepseek: 'deepseek-chat',
      deepinfra: 'meta-llama/Llama-3.3-70B-Instruct',
      hyperbolic: 'meta-llama/Llama-3.3-70B-Instruct',
      siliconflow: 'Qwen/Qwen2.5-72B-Instruct',
      novita: 'meta-llama/llama-3.3-70b-instruct',
      openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
      mistral: 'mistral-small-latest',
      openai: 'gpt-5.6-luna',
      claude: 'claude-sonnet-5',
      ollama: 'llama3.2',
      custom: 'gpt-oss-20b'
    };

    // Capability tokens that mean "this endpoint is not a chat model" (embedding,
    // TTS, image, Live voice…). Anchored to id separators on purpose: an
    // unanchored `live` also matched harmless names like `only-live-model` and
    // silently dropped them from the chain, which looks identical to a
    // provider-side outage. Match the SEGMENT, not a substring.
    const NON_CHAT_TOKENS = ['embedding', 'embeddings', 'embed', 'whisper', 'tts', 'image', 'images', 'imagen', 'rerank', 'guard', 'moderation', 'transcribe', 'transcription', 'dall', 'speech', 'audio', 'live', 'realtime', 'ocr', 'clip', 'vision-ocr'];
    const NON_CHAT_MODEL = new RegExp('(?:^|[-_./:])(' + NON_CHAT_TOKENS.join('|') + ')(?:$|[-_./:0-9])', 'i');

    function normalizeKey(id) {
      return String(id || '').trim();
    }

    /** True when this exact id is on the retired ledger. */
    function isKnownRetired(modelId) {
      return Object.prototype.hasOwnProperty.call(RETIRED_MODELS, normalizeKey(modelId));
    }

    /**
     * Migrate a possibly-stale model id.
     * @returns {{model:string, repaired:boolean, from:string, reason:string}}
     */
    function repairModelId(modelId, providerId) {
      const raw = normalizeKey(modelId);
      if (!raw) return { model: raw, repaired: false, from: raw, reason: '' };
      // A provider-specific policy alias wins over the global ledger: it is the
      // narrower, better-informed rule (e.g. OpenRouter's `:free` routing).
      const scoped = providerId && PROVIDER_MODEL_ALIASES[providerId] && PROVIDER_MODEL_ALIASES[providerId][raw];
      if (scoped) {
        return { model: scoped, repaired: true, from: raw, reason: `${providerId}: ${raw} is not routed the way GemAir needs; now using ${scoped}.` };
      }
      const replacement = RETIRED_MODELS[raw];
      if (replacement) {
        return {
          model: replacement,
          repaired: true,
          from: raw,
          reason: providerId
            ? `${providerId}: ${raw} was retired upstream; now using ${replacement}.`
            : `${raw} was retired upstream; now using ${replacement}.`
        };
      }
      // Deliberately NO fuzzy suffix matching. Rewriting the tail of an unknown
      // slug looks helpful and is not: `Qwen/Qwen2.5-72B-Instruct` shares its
      // suffix with a retired SambaNova id but is a live Hugging Face model,
      // and a prefix-aware rewrite turns a working config into a broken one.
      // Exact ids (what this app writes) plus the scoped table above is the
      // whole contract.
      return { model: raw, repaired: false, from: raw, reason: '' };
    }

    /**
     * "Which provider is this base URL?" — asked independently by the desktop
     * main process, the serverless proxy and the browser settings UI, which each
     * kept their own copy and drifted (the desktop copy is where a retired
     * default slipped through). One table, one answer.
     */
    const HOST_HINTS = [
      ['ollama', /localhost|127\.0\.0\.1|192\.168\.|10\.\d/],
      ['gemini', 'generativelanguage.googleapis.com'],
      ['groq', 'api.groq.com'],
      ['openai', 'api.openai.com'],
      ['claude', 'api.anthropic.com'],
      ['openrouter', 'openrouter.ai'],
      ['cerebras', 'api.cerebras.ai'],
      ['sambanova', 'api.sambanova.ai'],
      ['zai', 'api.z.ai'],
      ['nvidia', 'integrate.api.nvidia.com'],
      ['together', 'api.together.xyz'],
      ['xai', 'api.x.ai'],
      ['mistral', 'api.mistral.ai'],
      ['hf', 'router.huggingface.co'],
      ['deepseek', 'api.deepseek.com'],
      ['deepinfra', 'api.deepinfra.com'],
      ['fireworks', 'api.fireworks.ai'],
      ['hyperbolic', 'api.hyperbolic.xyz'],
      ['siliconflow', 'api.siliconflow'],
      ['novita', 'api.novita.ai'],
      ['cohere', 'api.cohere.ai']
    ];

    /**
     * @param {string} base   provider base URL (may be empty)
     * @param {Array}  catalog optional [{ id, baseURL }] list; consulted first so
     *                          a catalog entry always wins over the hint table.
     */
    function providerForBase(base, catalog) {
      const b = String(base || '').toLowerCase();
      if (!b) return 'free';
      if (Array.isArray(catalog)) {
        for (const entry of catalog) {
          const host = String((entry && entry.baseURL) || '').replace(/^https?:\/\//, '').split('/')[0];
          if (host && b.includes(host)) return entry.id;
        }
      }
      for (const [id, hint] of HOST_HINTS) {
        if (hint instanceof RegExp ? hint.test(b) : b.includes(hint)) return id;
      }
      return 'custom';
    }

    /** Best replacement for a provider when nothing usable is configured. */
    function firstFreeModel(providerId) {
      return FREE_FIRST_MODEL[providerId] || '';
    }

    /** Drop ids that can never answer a chat/completions request. */
    function isChatCapable(modelId) {
      return !NON_CHAT_MODEL.test(String(modelId || ''));
    }

    return {
      CATALOG_REVISION,
      RETIRED_MODELS,
      PROVIDER_MODEL_ALIASES,
      FREE_FIRST_MODEL,
      NON_CHAT_MODEL,
      providerForBase,
      isKnownRetired,
      isRetiredEverywhere: (id) => Object.prototype.hasOwnProperty.call(RETIRED_MODELS, String(id || '')),
      isChatCapable,
      repairModelId,
      firstFreeModel
    };
  }
));
