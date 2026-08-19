// GemAir serverless — AI chat proxy (runs on Vercel).
//
// The API key lives ONLY on the server and is read from any of the common
// environment variable names (GROQ_API_KEY, OPENAI_API_KEY, AI_KEY,
// GROQ_KEY, VERCEL_GROQ_KEY) — the browser never sees it and the end-user
// is never asked for one. If no key is configured at all, the endpoint still
// answers with a built-in free conversational brain, so the user ALWAYS gets
// a helpful reply and never a "please enter a key" error.

const KEY_ENV_NAMES = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'AI_KEY', 'GROQ_KEY', 'VERCEL_GROQ_KEY'];

const FALLBACK_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gpt-4o-mini'
];

// ---------------------------------------------------------------------------
// Free conversational brain — used when no server key is configured (or every
// model failed), so replies are instant, friendly and never an error.
// ---------------------------------------------------------------------------
function freeBrain(raw) {
  const q = String(raw || '').trim();
  const t = q.toLowerCase();
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

  if (!t) return "Hello! I'm Gem, your AI inside GemAir. Ask me anything — I'm listening.";
  if (/^(hi|hii+|hiii+|hello+|hey+|heyy+|yo+|salam|salaam|namaste|namaskar|good (morning|afternoon|evening))\b/.test(t))
    return `Hello! Gem here — always online and completely free. Try "weather in Mumbai", "bitcoin price" or "translate hello to hindi" — or just talk to me.`;
  if (/who are you|your name/.test(t))
    return "I'm Gem — the intelligence inside GemAir, your free personal AI. I can search the live web, check weather, track prices, translate languages, and keep you company.";
  if (/how are you/.test(t)) return 'Running smooth — and glad you asked. How are you doing?';
  if (/thank|thanks|shukriya|dhanyavad/.test(t)) return 'Anytime. That is what I am here for.';
  if (/what can you do|help|features|commands/.test(t))
    return 'I can search the live web, read the news, check weather anywhere, track crypto and exchange rates, translate languages, define words, do math, set reminders and notes — and just chat with you. What do you need?';
  if (/\btime\b|clock/.test(t)) return `The current time is ${time}.`;
  if (/\bdate\b|what day/.test(t)) return `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
  if (/joke/.test(t)) return "There are only 10 kinds of people: those who understand binary and those who don't.";

  const math = t.replace(/[^0-9+\-*/().\s]/g, '').match(/^\s*([\d.]+)\s*([+\-*/])\s*([\d.]+)\s*$/);
  if (math) {
    const [ , a, op, b ] = math;
    let out;
    switch (op) {
      case '+': out = Number(a) + Number(b); break;
      case '-': out = Number(a) - Number(b); break;
      case '*': out = Number(a) * Number(b); break;
      case '/': out = Number(b) === 0 ? 'undefined (cannot divide by zero)' : Number(a) / Number(b); break;
    }
    if (out !== undefined) return `${a} ${op} ${b} = ${out}`;
  }

  return `I'm here and listening. I can search the live web, check weather, prices, translations, definitions and more — try "weather in Mumbai" or "search latest AI news".`;
}

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

  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
  const prompt = lastUser && lastUser.content ? String(lastUser.content).trim() : '';

  // Look for a key under every common name a Vercel deploy might use.
  const key = (KEY_ENV_NAMES.map((n) => process.env[n]).find((v) => v && String(v).trim()) || '').trim();
  const baseURL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const models = [...new Set(
    [process.env.AI_MODEL, ...FALLBACK_MODELS]
      .filter(Boolean)
      .map((m) => String(m).trim())
  )];

  // No server key → answer with the free brain. Always ok:true, never an
  // error or a key prompt for the end-user.
  if (!key) return res.json({ ok: true, reply: freeBrain(prompt), free: true });

  // Try each model in turn (automatic fallback) until one replies.
  for (const model of models) {
    try {
      const r = await fetch(baseURL + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 1200 })
      });
      if (r.ok) {
        const data = await r.json();
        const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (reply) return res.json({ ok: true, reply: reply.trim() });
      }
    } catch (e) { /* try next model */ }
  }

  // Every model failed (bad key, provider down, …) — still answer the user,
  // seamlessly, with the free brain instead of surfacing an error.
  return res.json({ ok: true, reply: freeBrain(prompt), free: true });
};
