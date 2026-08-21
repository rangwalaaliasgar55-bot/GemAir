// GemAir serverless — exposes PUBLIC config to the browser (never secret keys).
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    supabase: process.env.SUPABASE_URL
      ? { url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY || '' }
      : null,
    aiConfigured: !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY),
    version: '2.0.0'
  });
};
