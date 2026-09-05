// GemAir serverless — health check (uptime monitors, Vercel dashboard, ops)
// Reports WHICH subsystems are configured — never any secret values.
const { guard, json, env, VERSION } = require('./_lib/http');

const PROVIDERS = {
  groq: ['GROQ_API_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY'],
  gemini: ['GEMINI_API_KEY', 'GEMINI_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
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
    providers: {
      groq: has(PROVIDERS.groq),
      gemini: has(PROVIDERS.gemini),
      openrouter: has(PROVIDERS.openrouter),
      openai: has(PROVIDERS.openai),
      override: !!(env('AI_BASE_URL') && PROVIDERS && Object.values(PROVIDERS).some(has))
    },
    anyAiConfigured: Object.values(PROVIDERS).some(has) || (!!env('AI_BASE_URL') && !!env('GROQ_API_KEY')),
    supabaseConfigured: !!env('SUPABASE_URL'),
    sharedLimiter: { enabled: !!(kvUrl && env('KV_REST_API_TOKEN')) },
    freeBrainFallback: false,
    liveTools: ['search', 'weather', 'headlines', 'crypto', 'currency', 'dictionary', 'translate'],
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString()
  });
};
