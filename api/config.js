// GemAir serverless — exposes PUBLIC config to the browser (never secret keys).
const { guard, json, VERSION, env } = require('./_lib/http');

const AI_KEY_ENVS = ['GROQ_API_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY', 'OPENAI_API_KEY', 'AI_KEY', 'GEMINI_API_KEY', 'GEMINI_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_KEY'];

// Which provider names the operator actually wired up. Kept in sync with
// api/chat.js by the connection-surface test.
const PROVIDER_ENVS = {
  groq: ['GROQ_API_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY'],
  gemini: ['GEMINI_API_KEY', 'GEMINI_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
  cerebras: ['CEREBRAS_API_KEY', 'CEREBRAS_KEY'],
  sambanova: ['SAMBANOVA_API_KEY', 'SAMBANOVA_KEY'],
  zai: ['ZAI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
  together: ['TOGETHER_API_KEY', 'TOGETHER_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY'],
  hf: ['HF_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  deepinfra: ['DEEPINFRA_API_KEY'],
  openai: ['OPENAI_API_KEY']
};

function catalogRevision() {
  try { return require('../lib/model-currency.js').CATALOG_REVISION; } catch { return 'unknown'; }
}

module.exports = (req, res) => {
  if (guard(req, res)) return;
  const supabaseUrl = env('SUPABASE_URL');
  return json(res, 200, {
    supabase: supabaseUrl
      ? { url: supabaseUrl, anonKey: env('SUPABASE_ANON_KEY') }
      : null,
    aiConfigured: AI_KEY_ENVS.some((k) => env(k)),
    // The diagnosis the renderer used to have to guess at. `freeCore` tells
    // the app whether the shared proxy can answer at all, so the status chip
    // can say "this deployment has no keys — add yours in Settings" BEFORE a
    // message fails, instead of a bare 503 in the transcript.
    freeCore: {
      configured: AI_KEY_ENVS.some((k) => env(k)) || !!env('AI_BASE_URL'),
      providers: Object.keys(PROVIDER_ENVS).filter((id) => PROVIDER_ENVS[id].some((k) => env(k))),
      gatewayOverride: !!env('AI_BASE_URL'),
      model: env('AI_MODEL') || '',
      dailyLimit: (() => { const n = parseInt(env('FAIR_USE_DAILY'), 10); return Number.isFinite(n) && n > 0 ? n : 200; })()
    },
    catalogRevision: catalogRevision(),
    version: VERSION
  });
};
