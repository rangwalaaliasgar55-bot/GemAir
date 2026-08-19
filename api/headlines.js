// GemAir serverless — free headlines (Hacker News API, with fallback)
const FALLBACK_HEADLINES = [
  { id: 101, title: 'GemAir v1.0 Released — Next-Gen JARVIS Style Desktop AI Command Center', url: 'https://github.com/rangwalaaliasgar55-bot/GemAir', score: 342, by: 'gemair' },
  { id: 102, title: 'Open-Source AI Models Reach New Benchmarks in Agentic Tool Use', url: 'https://news.ycombinator.com', score: 215, by: 'tech_insider' },
  { id: 103, title: 'Web Audio API & Real-Time Lip Sync Animation in Modern Web Assistants', url: 'https://news.ycombinator.com', score: 188, by: 'audio_dev' },
  { id: 104, title: 'Local LLM Inference Speed Increases 3x with Quantized Kernels', url: 'https://news.ycombinator.com', score: 145, by: 'ai_research' },
  { id: 105, title: 'Building Autonomous Agent Teams for Software Architecture & Writing', url: 'https://news.ycombinator.com', score: 120, by: 'agent_dev' }
];

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
    return res.json(out.length ? out : FALLBACK_HEADLINES);
  } catch (e) {
    return res.json(FALLBACK_HEADLINES);
  }
};
