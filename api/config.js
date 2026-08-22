// GemAir serverless — exposes PUBLIC config to the browser (never secret keys).
const { guard, json, VERSION, env } = require('./_lib/http');

const AI_KEY_ENVS = ['GROQ_API_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY', 'OPENAI_API_KEY', 'AI_KEY', 'GEMINI_API_KEY', 'GEMINI_KEY', 'GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_KEY'];

module.exports = (req, res) => {
  if (guard(req, res)) return;
  const supabaseUrl = env('SUPABASE_URL');
  return json(res, 200, {
    supabase: supabaseUrl
      ? { url: supabaseUrl, anonKey: env('SUPABASE_ANON_KEY') }
      : null,
    aiConfigured: AI_KEY_ENVS.some((k) => env(k)),
    version: VERSION
  });
};
