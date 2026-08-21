// GemAir serverless — health check (for uptime monitors & Vercel dashboard)
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const keyNames = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'AI_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY'];
  res.json({
    status: 'ok',
    name: 'GemAir',
    version: '2.0.0',
    aiConfigured: !!(keyNames.map((n) => process.env[n]).find((v) => v && String(v).trim())),
    supabaseConfigured: !!process.env.SUPABASE_URL,
    time: new Date().toISOString()
  });
};
