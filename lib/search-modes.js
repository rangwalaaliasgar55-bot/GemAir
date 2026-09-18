/* GemAir — multi-mode web search routing (pure).
   Concept from Mark-LIV's news/research/price/compare/search modes.
   Honesty contract: modes change HOW GemAir asks and presents — they never
   synthesize prices or facts; price/compare modes must still cite what the
   fetched sources actually say. */
'use strict';

const MODES = ['search', 'news', 'research', 'price', 'compare'];

const MODE_META = {
  search:   { maxResults: 8,  query: (q) => q,
              hint: 'Answer briefly from the sources; name the source when the fact matters.' },
  news:     { maxResults: 10, query: (q) => q + ' latest news',
              hint: 'News mode: lead with what CHANGED, most recent first, with the outlet and date from each snippet. If snippets carry no date, say the items are undated.' },
  research: { maxResults: 10, query: (q) => q,
              hint: 'Research mode: compare several sources, note where they disagree, and end with the strongest-cited conclusion. Prefer primary sources over aggregators.' },
  price:    { maxResults: 9,  query: (q) => q + ' price',
              hint: 'Price mode: report ONLY prices that appear in the fetched snippets/pages, each with its source and currency. Never estimate a price that no source states; if the snippets have no prices, say so.' },
  compare:  { maxResults: 10, query: (q) => q,
              hint: 'Compare mode: structure the answer as item-by-item rows (price / key spec / verdict) filled ONLY from fetched sources. Unknown cells are "not in sources", never guesses.' }
};

function normalizeMode(mode) {
  const m = String(mode || 'search').toLowerCase().trim();
  return MODES.includes(m) ? m : null;
}

function shape(mode, query) {
  const m = normalizeMode(mode) || 'search';
  const meta = MODE_META[m];
  return {
    mode: m,
    query: meta.query(String(query || '').slice(0, 240)),
    maxResults: meta.maxResults,
    hint: meta.hint
  };
}

module.exports = { MODES, MODE_META, normalizeMode, shape };
