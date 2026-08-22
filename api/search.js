// GemAir serverless — REAL free web search (no key, no AI required)
//
// 2.5 FIX: this used to rely on DuckDuckGo's *Instant Answers* API, which is
// not a general search engine — it returns EMPTY RelatedTopics for most
// queries, so "web search is broken" was literally true. The primary source is
// now the DuckDuckGo HTML results page (free, keyless), parsed for organic
// results with ads filtered out. Chain:
//
//   1. DDG HTML organic results   (real web results)
//   2. Wikipedia opensearch       (reference answer + link)
//   3. DDG Instant Answers        (kept last — occasionally useful abstracts)
//   4. Hacker News Algolia        (tech queries — real discussion links)
//
// Everything here is free and keyless, forever.
const { guard, json, fetchText, fetchJson } = require('./_lib/http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the real destination from a DDG redirect href; null for ads/junk. */
function unwrapDdg(href) {
  const m = String(href || '').match(/[?&]uddg=([^&]+)/);
  if (!m) return null;
  let url;
  try { url = decodeURIComponent(m[1]); } catch { return null; }
  if (!/^https?:\/\//i.test(url)) return null;
  if (/duckduckgo\.com\/y\.js/i.test(url)) return null; // sponsored / ad redirect
  return url;
}

/** Scrape organic results from the DDG HTML page. */
async function ddgHtmlResults(query, limit = 8) {
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    timeoutMs: 9000
  });
  const titles = [];
  const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const url = unwrapDdg(m[1]);
    const title = stripTags(m[2]);
    if (url && title) titles.push({ title, url });
  }
  const snippets = {};
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snippetRe.exec(html))) {
    const url = unwrapDdg(m[1]);
    if (url && !snippets[url]) snippets[url] = stripTags(m[2]).slice(0, 300);
  }
  return titles.slice(0, limit).map((r) => ({ ...r, snippet: snippets[r.url] || '' }));
}

async function wikipediaAnswer(query) {
  try {
    const w = await fetchJson('https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&search=' + encodeURIComponent(query));
    if (Array.isArray(w) && w[2] && w[2][0]) {
      return { answer: w[2][0], source: 'Wikipedia', url: w[3] && w[3][0] };
    }
  } catch { /* fall through */ }
  return null;
}

async function ddgInstantAnswer(query) {
  try {
    const d = await fetchJson('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1');
    const results = [];
    const flatten = (topics) => {
      for (const t of topics || []) {
        if (t.Topics) flatten(t.Topics);
        else if (t.Text && t.FirstURL) results.push({ title: String(t.Text).split(' - ')[0], url: t.FirstURL });
      }
    };
    flatten(d.RelatedTopics);
    if (d.AbstractText || d.Answer) {
      return { answer: d.AbstractText || d.Answer, source: d.AbstractSource || 'DuckDuckGo', url: d.AbstractURL || null, results: results.slice(0, 6) };
    }
    if (results.length) return { answer: null, source: null, url: null, results: results.slice(0, 6) };
  } catch { /* fall through */ }
  return null;
}

async function hnDiscussion(query) {
  try {
    const d = await fetchJson('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(query) + '&tags=story&hitsPerPage=4');
    const hits = (d.hits || []).filter((h) => h.title && h.url).map((h) => ({
      title: h.title,
      url: h.url,
      snippet: `${h.points || 0} points · ${h.num_comments || 0} comments on Hacker News`,
      discussion: 'https://news.ycombinator.com/item?id=' + h.objectID
    }));
    return hits;
  } catch { return []; }
}

module.exports = async (req, res) => {
  if (guard(req, res)) return;
  const q = (req.query.q || '').trim().slice(0, 300);
  if (!q) return json(res, 400, { error: 'q is required' });

  const sourcesUsed = [];
  let answer = null, source = null, url = null;
  let results = [];

  // 1) Real organic results (the actual fix).
  try {
    const organic = await ddgHtmlResults(q);
    if (organic.length) {
      results = organic;
      sourcesUsed.push('duckduckgo');
      // Top organic result doubles as the headline answer when it has a snippet.
      if (organic[0].snippet) {
        answer = organic[0].title + ' — ' + organic[0].snippet;
        source = new URL(organic[0].url).hostname.replace(/^www\./, '');
        url = organic[0].url;
      }
    }
  } catch { /* DDG HTML blocked/unreachable → fallbacks below */ }

  // 2) Wikipedia reference answer.
  if (!answer) {
    const wiki = await wikipediaAnswer(q);
    if (wiki) {
      answer = wiki.answer; source = wiki.source; url = wiki.url;
      if (!results.length) results = [{ title: wiki.answer, url: wiki.url, snippet: 'Wikipedia' }];
      sourcesUsed.push('wikipedia');
    }
  }

  // 3) DDG Instant Answers (abstracts/instant answers only).
  if (!results.length) {
    const ia = await ddgInstantAnswer(q);
    if (ia && (ia.results.length || ia.answer)) {
      answer = answer || ia.answer;
      source = source || ia.source;
      url = url || ia.url;
      results = results.length ? results : ia.results;
      sourcesUsed.push('duckduckgo-ia');
    }
  }

  // 4) Hacker News for tech discussions (supplements any sparse result set).
  if (results.length < 3) {
    const hn = await hnDiscussion(q);
    if (hn.length) {
      results = results.concat(hn.map((h) => ({ ...h, hn: true })));
      sourcesUsed.push('hackernews');
    }
  }

  return json(res, 200, {
    query: q,
    answer,
    source,
    url,
    results: results.slice(0, 10),
    searched: true,
    sourcesUsed,
    free: true
  });
};
