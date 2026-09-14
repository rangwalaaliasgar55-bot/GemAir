// GemAir serverless — health check (uptime monitors, Vercel dashboard, ops)
// Reports WHICH subsystems are configured — never any secret values.
const { guard, json, env, VERSION } = require('./_lib/http');

// Every provider the free chain can spend. A missing entry here means an
// operator sees "ok" while a configured key is silently unused, so this list is
// kept in sync with api/chat.js by scripts/connection-surface-test.js.
const PROVIDERS = {
  groq: ['GROQ_API_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY'],
  gemini: ['GEMINI_API_KEY', 'GEMINI_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
  cerebras: ['CEREBRAS_API_KEY', 'CEREBRAS_KEY'],
  sambanova: ['SAMBANOVA_API_KEY', 'SAMBANOVA_KEY'],
  zai: ['ZAI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
  together: ['TOGETHER_API_KEY', 'TOGETHER_KEY'],
  mistral: ['MISTRAL_API_KEY', 'MISTRAL_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY'],
  hf: ['HF_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  deepinfra: ['DEEPINFRA_API_KEY'],
  openai: ['OPENAI_API_KEY']
};

module.exports = (req, res) => {
  if (guard(req, res)) return;
  const has = (names) => names.some((n) => !!env(n));
  const kvUrl = env('KV_REST_API_URL') || env('KV_URL');
  return json(res, 200, {
    status: 'ok',
    name: 'GemAir',
    version: VERSION,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, names]) => [id, has(names)])),
    providersConfigured: Object.entries(PROVIDERS).map(([id, names]) => (has(names) ? id : null)).filter(Boolean),
    // Chat is only reachable when a key exists OR a gateway is configured. The
    // free tier is a proxy, not a keyless service — a fresh deployment answers
    // 503 NO_PROVIDERS_CONFIGURED, so report that up front instead of waiting
    // for the first user to notice.
    chatReady: Object.values(PROVIDERS).some(has) || !!env('AI_BASE_URL'),
    anyAiConfigured: Object.values(PROVIDERS).some(has) || !!env('AI_BASE_URL'),
    catalogRevision: (() => { try { return require('../lib/model-currency.js').CATALOG_REVISION; } catch { return 'unknown'; } })(),
    supabaseConfigured: !!env('SUPABASE_URL'),
    sharedLimiter: { enabled: !!(kvUrl && env('KV_REST_API_TOKEN')) },
    freeBrainFallback: false,
    liveTools: ['search', 'weather', 'headlines', 'crypto', 'currency', 'dictionary', 'translate'],
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString()
  });
};
