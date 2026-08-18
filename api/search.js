// GemAI serverless — REAL free web search (no key, no AI required)
// Aggregates DuckDuckGo Instant Answers + Wikipedia for genuinely useful results.
module.exports = async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    // 1) DuckDuckGo Instant Answer API (free, no key)
    const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`)
      .then(r => r.json());

    const results = [];
    const flatten = (topics) => {
      for (const t of topics || []) {
        if (t.Topics) flatten(t.Topics);
        else if (t.Text) results.push({ title: String(t.Text).split(' - ')[0], url: t.FirstURL });
      }
    };
    flatten(ddg.RelatedTopics);

    let answer = ddg.AbstractText || ddg.Answer || null;
    let source = ddg.AbstractSource || null;
    let url = ddg.AbstractURL || null;

    // 2) Wikipedia fallback when DDG has no abstract (still free, no key)
    let wiki = null;
    if (!answer) {
      const w = await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&search=${encodeURIComponent(q)}`)
        .then(r => r.json());
      if (Array.isArray(w) && w[2] && w[2][0]) {
        wiki = { title: w[1][0], excerpt: w[2][0], url: w[3][0] };
        answer = w[2][0];
        source = 'Wikipedia';
        url = w[3][0];
      }
    }

    return res.json({
      query: q,
      answer,
      source,
      url,
      results: results.slice(0, 6),
      wiki,
      searched: true
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
