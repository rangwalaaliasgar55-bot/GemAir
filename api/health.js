// GemAI serverless — health check (for uptime monitors & Vercel dashboard)
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    name: 'GemAI',
    version: '1.0.0',
    aiConfigured: !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY),
    supabaseConfigured: !!process.env.SUPABASE_URL,
    time: new Date().toISOString()
  });
};
