// GemAir serverless — live category headlines (Google News RSS, HN fallback)
const TOPICS = { tech: 'TECHNOLOGY', world: 'WORLD', business: 'BUSINESS' };
const FALLBACK_HEADLINES = [
  { id: 101, title: 'GemAir 2.0 — local-first agentic mission control', url: 'https://github.com/rangwalaaliasgar55-bot/GemAir', score: 342, by: 'GemAir', category: 'tech' },
  { id: 102, title: 'Open-source AI models advance real tool use', url: 'https://news.ycombinator.com', score: 215, by: 'technology desk', category: 'tech' },
  { id: 103, title: 'Global teams adopt local-first software', url: 'https://news.google.com', score: 0, by: 'world desk', category: 'world' },
  { id: 104, title: 'Businesses increase investment in automation', url: 'https://news.google.com', score: 0, by: 'business desk', category: 'business' }
];

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseRss(xml, category, limit) {
  const blocks = String(xml || '').match(/<item>[\s\S]*?<\/item>/g) || [];
  return blocks.slice(0, limit).map((block, index) => {
    const field = (name) => {
      const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
      return decodeXml(match && match[1]);
    };
    return {
      id: `${category}-${index}-${Date.now()}`,
      title: field('title'),
      url: field('link'),
      score: 0,
      by: field('source') || 'Google News',
      published: field('pubDate'),
      category
    };
  }).filter((item) => item.title && item.url);
}

module.exports = async (req, res) => {
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const category = TOPICS[req.query.category] ? req.query.category : 'tech';
  try {
    const topic = TOPICS[category];
    const response = await fetch(`https://news.google.com/rss/headlines/section/topic/${topic}?hl=en-US&gl=US&ceid=US:en`, {
      headers: { 'User-Agent': 'GemAir/2.0' }
    });
    const items = parseRss(await response.text(), category, limit);
    if (items.length) return res.json(items);
  } catch (error) { /* use local fallback below */ }
  // U2: flag the offline fallback so the UI can badge it SIMULATED instead of
  // presenting stale sample copy under a LIVE label.
  return res.json(FALLBACK_HEADLINES
    .filter((item) => item.category === category)
    .slice(0, limit)
    .map((item) => ({ ...item, simulated: true })));
};
