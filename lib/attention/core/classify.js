'use strict';
/* Gem Air — classification engine.
   Application -> activity/category -> focus relevance.
   Understands browsers: a browser window is classified by its SITE, not by "Chrome is open". */

const BROWSER_PROCESSES = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'opera_gx', 'vivaldi', 'arc', 'chromium', 'safari'];

function norm(value) {
  return String(value || '').trim().toLowerCase().replace(/\.exe$/, '');
}

function isBrowserProcess(appName) {
  const a = norm(appName);
  return BROWSER_PROCESSES.some((b) => a === b || a.startsWith(b));
}

/** Extract a hostname from a URL, a bare host, or a browser window title. */
function hostFrom(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const urlMatch = raw.match(/https?:\/\/([^/\s]+)/i);
  if (urlMatch) return stripWww(urlMatch[1]);
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(raw)) return stripWww(raw.split('/')[0]);
  const inTitle = raw.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  return inTitle ? stripWww(inTitle[1]) : '';
}

function stripWww(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
}

function hostMatches(host, pattern) {
  const h = stripWww(host);
  const p = stripWww(pattern);
  if (!h || !p) return false;
  return h === p || h.endsWith('.' + p);
}

/** Guess a site from a browser window title when no extension is connected. */
function siteFromWindowTitle(title) {
  const t = String(title || '');
  const host = hostFrom(t);
  if (host) return host;
  const known = [
    [/youtube/i, 'youtube.com'],
    [/gmail/i, 'mail.google.com'],
    [/github/i, 'github.com'],
    [/stack overflow/i, 'stackoverflow.com'],
    [/instagram/i, 'instagram.com'],
    [/reddit/i, 'reddit.com'],
    [/\bfigma\b/i, 'figma.com'],
    [/netflix/i, 'netflix.com'],
    [/twitch/i, 'twitch.tv'],
    [/\(@?\w+\) \/ X$|\bon X\b/i, 'x.com']
  ];
  for (const [re, site] of known) if (re.test(t)) return site;
  return '';
}

function findAppRule(rules, appName) {
  const a = norm(appName);
  if (!a) return null;
  let best = null;
  for (const rule of rules || []) {
    const m = norm(rule.match);
    if (!m) continue;
    if (a === m) return rule;
    if (a.includes(m) && (!best || m.length > norm(best.match).length)) best = rule;
  }
  return best;
}

function findSiteRule(rules, host) {
  if (!host) return null;
  let best = null;
  for (const rule of rules || []) {
    if (!hostMatches(host, rule.match)) continue;
    if (!best || String(rule.match).length > String(best.match).length) best = rule;
  }
  return best;
}

function categoryById(categories, id) {
  return (categories || []).find((c) => c.id === id) || null;
}

/**
 * Classify a raw context sample.
 * @param {object} state  hydrated attention state
 * @param {object} sample { app, title, pid, url?, browserTab? }
 * @returns {object} context { app, title, kind, site, categoryId, category, relevance, known, subject }
 */
function classify(state, sample) {
  const app = norm(sample && sample.app);
  const title = String((sample && sample.title) || '');
  const browser = isBrowserProcess(app);
  // Prefer a real URL from the browser extension; fall back to title inference.
  const url = (sample && sample.url) || (sample && sample.browserTab && sample.browserTab.url) || '';
  const site = browser ? stripWww(hostFrom(url) || siteFromWindowTitle(title)) : '';
  const source = url ? 'extension' : site ? 'title' : 'none';

  let rule = null;
  let known = false;
  let subject = app;
  let kind = 'app';

  if (browser && site) {
    kind = 'site';
    subject = site;
    rule = findSiteRule(state.siteRules, site);
    known = !!rule;
    if (!rule) rule = findAppRule(state.appRules, app); // fall back to "Browser"
  } else {
    rule = findAppRule(state.appRules, app);
    known = !!rule;
  }

  const categoryId = (rule && rule.category) || 'other';
  const category = categoryById(state.categories, categoryId) || { id: 'other', label: 'Other', color: '#9aa4b2', relevance: 'neutral' };
  return {
    app,
    appLabel: prettyApp(sample && sample.app),
    title,
    kind,
    site,
    urlSource: source,
    url: url || '',
    browser,
    subject,
    categoryId: category.id,
    categoryLabel: category.label,
    categoryColor: category.color,
    relevance: category.relevance || 'neutral',
    known
  };
}

const APP_LABELS = {
  code: 'VS Code', msedge: 'Edge', chrome: 'Chrome', devenv: 'Visual Studio', powerpnt: 'PowerPoint',
  winword: 'Word', explorer: 'File Explorer', windowsterminal: 'Terminal', 'ms-teams': 'Teams', idea64: 'IntelliJ',
  pycharm64: 'PyCharm', photoshop: 'Photoshop', illustrator: 'Illustrator'
};

function prettyApp(name) {
  const n = norm(name);
  if (!n) return 'Unknown';
  if (APP_LABELS[n]) return APP_LABELS[n];
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Persist a user decision: app or site -> category. */
function learn(state, { kind, subject, categoryId }) {
  const list = kind === 'site' ? state.siteRules : state.appRules;
  const key = kind === 'site' ? stripWww(subject) : norm(subject);
  if (!key || !categoryId) return state;
  const existing = list.find((r) => (kind === 'site' ? stripWww(r.match) === key : norm(r.match) === key));
  if (existing) {
    existing.category = categoryId;
    existing.source = 'user';
    existing.updatedAt = Date.now();
  } else {
    list.push({ match: key, category: categoryId, source: 'user', updatedAt: Date.now() });
  }
  return state;
}

module.exports = {
  BROWSER_PROCESSES, norm, isBrowserProcess, hostFrom, stripWww, hostMatches,
  siteFromWindowTitle, findAppRule, findSiteRule, classify, learn, prettyApp
};
