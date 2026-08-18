// GemAir serverless — free headlines (Hacker News API, no key)
module.exports = async (req, res) => {
  const limit = Math.min(30, parseInt(req.query.limit) || 12);
  try {
    const top = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json').then(r => r.json());
    const ids = (Array.isArray(top) ? top : []).slice(0, limit);
    const items = await Promise.all(ids.map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()).catch(() => null)
    ));
    const out = items.filter(Boolean).filter(i => i.title).map(i => ({
      id: i.id,
      title: i.title,
      url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
      score: i.score || 0,
      by: i.by || ''
    }));
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
