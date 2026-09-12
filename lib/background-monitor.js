/* ============================================================
   GemAir — Background Monitor (ported concept from Mark-LIII's
   actions/background_monitor.py, adapted to GemAir's memory store).

   User picks a topic ("iPhone 17", "F1 news", "my city's weather
   warnings"...). Once a day per topic, GemAir checks the latest
   headline for that topic and — only when it's a NEW headline —
   surfaces a proactive alert. No crypto/finance topics (kept out
   of scope on purpose, same as upstream).

   This module is pure/testable: it operates on a plain memory
   object (`memory.monitors`) and takes an injected `fetchHeadline`
   function so it never talks to the network itself.
   ============================================================ */
'use strict';

const crypto = require('crypto');

const BLOCKED_WORDS = [
  'bitcoin', 'ethereum', 'dogecoin', 'solana', 'binance', 'nft', 'blockchain',
  'defi', 'altcoin', 'memecoin', 'crypto', 'cryptocurrency', 'stock price',
  'share price', 'day trading', 'forex'
];

function isBlockedTopic(topic) {
  const t = String(topic || '').toLowerCase();
  return BLOCKED_WORDS.some((word) => t.includes(word));
}

function slugify(topic) {
  return String(topic || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'topic';
}

function titleHash(title) {
  return crypto.createHash('md5').update(String(title || ''), 'utf8').digest('hex').slice(0, 12);
}

function ensureMonitors(memory) {
  if (!Array.isArray(memory.monitors)) memory.monitors = [];
  return memory.monitors;
}

function addMonitor(memory, topic) {
  const clean = String(topic || '').trim();
  if (!clean) return { error: 'Please specify a topic to monitor.' };
  if (clean.length > 120) return { error: 'Topic is too long (120 characters max).' };
  if (isBlockedTopic(clean)) return { error: "I don't monitor crypto, stocks, or trading topics." };
  const monitors = ensureMonitors(memory);
  const slug = slugify(clean);
  if (monitors.some((m) => m.slug === slug)) return { ok: true, alreadyMonitoring: true, topic: clean };
  monitors.unshift({ slug, topic: clean, added: Date.now(), lastCheck: 0, lastHash: '' });
  return { ok: true, topic: clean };
}

function removeMonitor(memory, topic) {
  const query = String(topic || '').trim().toLowerCase();
  const monitors = ensureMonitors(memory);
  if (!query) return { error: 'Please specify which topic to stop monitoring.' };
  const slug = slugify(query);
  let idx = monitors.findIndex((m) => m.slug === slug);
  if (idx === -1) idx = monitors.findIndex((m) => m.topic.toLowerCase().includes(query));
  if (idx === -1) return { error: `Not found in monitored topics: ${topic}` };
  const [removed] = monitors.splice(idx, 1);
  return { ok: true, topic: removed.topic };
}

function listMonitors(memory) {
  return ensureMonitors(memory).map((m) => ({ topic: m.topic, added: new Date(m.added).toISOString() }));
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// fetchHeadline(topic) -> Promise<{ title, url, source } | null>
async function checkMonitors(memory, fetchHeadline, { force = false } = {}) {
  const monitors = ensureMonitors(memory);
  const alerts = [];
  const now = Date.now();
  for (const entry of monitors) {
    if (!force && now - (entry.lastCheck || 0) < ONE_DAY_MS) continue;
    try {
      const headline = await fetchHeadline(entry.topic);
      entry.lastCheck = now;
      if (!headline || !headline.title) continue;
      const hash = titleHash(headline.title);
      if (hash === entry.lastHash) continue;
      entry.lastHash = hash;
      alerts.push({ topic: entry.topic, title: headline.title, url: headline.url || null, source: headline.source || null });
    } catch {
      // Leave lastCheck untouched so a transient network failure gets retried sooner.
    }
  }
  return alerts;
}

module.exports = { isBlockedTopic, slugify, titleHash, addMonitor, removeMonitor, listMonitors, checkMonitors, ONE_DAY_MS };
