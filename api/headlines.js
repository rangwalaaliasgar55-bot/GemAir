// GemAir serverless — live category headlines (Google News RSS, HN fallback)
const { guard, fetchText, VERSION } = require('./_lib/http');
const TOPICS = { tech: 'TECHNOLOGY', world: 'WORLD', business: 'BUSINESS' };

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
  if (guard(req, res)) return;
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const category = TOPICS[req.query.category] ? req.query.category : 'tech';
  try {
    const topic = TOPICS[category];
    const xml = await fetchText(`https://news.google.com/rss/headlines/section/topic/${topic}?hl=en-US&gl=US&ceid=US:en`, {
      headers: { 'User-Agent': 'GemAir/' + VERSION },
      timeoutMs: 9000
    });
    const items = parseRss(xml, category, limit);
    if (items.length) return res.json(items);
  } catch (error) {
    return res.status(503).json({ ok: false, error: 'headlines_unavailable', message: 'Live headlines are temporarily unavailable. Please retry.' });
  }
  return res.status(503).json({ ok: false, error: 'headlines_empty', message: 'No live headlines were returned.' });
};
