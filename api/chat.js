// GemAir serverless — AI chat proxy.
// Uses a server-side GROQ_API_KEY (or OPENAI_API_KEY) so the key never touches
// the browser. If no key is configured, returns ok:false so the client falls
// back to the free offline brain (search / weather / tools all work without it).
module.exports = async (req, res) => {
  // CORS preflight (browsers send this before a JSON POST from another origin)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // never let a CDN cache an AI reply
  res.setHeader('Cache-Control', 'no-store');

  let body = {};
  try { body = req.body || {}; } catch {}

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  const key = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || '';
  const baseURL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const model = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

  if (!key) {
    return res.json({ ok: false, error: 'NO_KEY', note: 'Set GROQ_API_KEY server-side for AI chat. Web search and all tools are free without it.' });
  }

  try {
    const url = baseURL + '/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 1200 })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.json({ ok: false, error: 'HTTP_' + r.status + (t ? ' ' + t.slice(0, 200) : '') });
    }
    const data = await r.json();
    const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!reply) return res.json({ ok: false, error: 'EMPTY_REPLY' });
    return res.json({ ok: true, reply: reply.trim() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
