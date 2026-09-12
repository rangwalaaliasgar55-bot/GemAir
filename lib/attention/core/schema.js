'use strict';
/* Gem Air — attention state schema + defaults.
   Pure data. No Electron, no fs. Everything downstream validates against this. */

const SCHEMA_VERSION = 1;

const DEFAULT_CATEGORIES = [
  { id: 'work', label: 'Work', color: '#4f8cff', relevance: 'focus', builtin: true },
  { id: 'study', label: 'Study', color: '#7c5cff', relevance: 'focus', builtin: true },
  { id: 'design', label: 'Design', color: '#ff7ac6', relevance: 'focus', builtin: true },
  { id: 'development', label: 'Development', color: '#38d39f', relevance: 'focus', builtin: true },
  { id: 'communication', label: 'Communication', color: '#ffb454', relevance: 'neutral', builtin: true },
  { id: 'browser', label: 'Browser', color: '#8ea0b5', relevance: 'neutral', builtin: true },
  { id: 'entertainment', label: 'Entertainment', color: '#ff8f6b', relevance: 'distraction', builtin: true },
  { id: 'distraction', label: 'Distraction', color: '#ff5c5c', relevance: 'distraction', builtin: true },
  { id: 'other', label: 'Other', color: '#9aa4b2', relevance: 'neutral', builtin: true }
];

// Seed knowledge. The classifier still asks about anything it has not seen.
const DEFAULT_APP_RULES = [
  { match: 'code', category: 'development' },
  { match: 'devenv', category: 'development' },
  { match: 'webstorm', category: 'development' },
  { match: 'idea64', category: 'development' },
  { match: 'pycharm64', category: 'development' },
  { match: 'windowsterminal', category: 'development' },
  { match: 'powershell', category: 'development' },
  { match: 'figma', category: 'design' },
  { match: 'photoshop', category: 'design' },
  { match: 'illustrator', category: 'design' },
  { match: 'blender', category: 'design' },
  { match: 'winword', category: 'work' },
  { match: 'excel', category: 'work' },
  { match: 'powerpnt', category: 'work' },
  { match: 'onenote', category: 'work' },
  { match: 'notion', category: 'work' },
  { match: 'obsidian', category: 'study' },
  { match: 'slack', category: 'communication' },
  { match: 'teams', category: 'communication' },
  { match: 'ms-teams', category: 'communication' },
  { match: 'zoom', category: 'communication' },
  { match: 'outlook', category: 'communication' },
  { match: 'discord', category: 'distraction' },
  { match: 'steam', category: 'entertainment' },
  { match: 'spotify', category: 'entertainment' },
  { match: 'vlc', category: 'entertainment' },
  { match: 'chrome', category: 'browser', browser: true },
  { match: 'msedge', category: 'browser', browser: true },
  { match: 'firefox', category: 'browser', browser: true },
  { match: 'brave', category: 'browser', browser: true },
  { match: 'opera', category: 'browser', browser: true },
  { match: 'arc', category: 'browser', browser: true },
  { match: 'vivaldi', category: 'browser', browser: true }
];

const DEFAULT_SITE_RULES = [
  { match: 'youtube.com', category: 'distraction' },
  { match: 'instagram.com', category: 'distraction' },
  { match: 'tiktok.com', category: 'distraction' },
  { match: 'x.com', category: 'distraction' },
  { match: 'twitter.com', category: 'distraction' },
  { match: 'reddit.com', category: 'distraction' },
  { match: 'netflix.com', category: 'entertainment' },
  { match: 'twitch.tv', category: 'entertainment' },
  { match: 'github.com', category: 'development' },
  { match: 'developer.chrome.com', category: 'development' },
  { match: 'developer.mozilla.org', category: 'development' },
  { match: 'stackoverflow.com', category: 'development' },
  { match: 'figma.com', category: 'design' },
  { match: 'docs.google.com', category: 'work' },
  { match: 'mail.google.com', category: 'communication' },
  { match: 'focusx.site', category: 'work' }
];

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    appRules: DEFAULT_APP_RULES.map((r) => ({ ...r, source: 'seed' })),
    siteRules: DEFAULT_SITE_RULES.map((r) => ({ ...r, source: 'seed' })),
    blocks: { apps: [], sites: [], exceptions: [] },
    plans: [],
    sleep: { enabled: false, start: '23:30', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6], blockCategories: ['distraction', 'entertainment'], blockApps: [], blockSites: [] },
    activity: { days: {} },
    attempts: [],
    pending: [],
    settings: {
      idleAfterSeconds: 180,
      pollIntervalMs: 2000,
      askUnknownApps: true,
      askMinSeconds: 20,
      islandPosition: null,
      launchAtStartup: false,
      notifications: true,
      focusxAccount: null,
      focusxSite: 'https://focusx.site'
    }
  };
}

/** Merge persisted state over defaults without losing new default keys. */
function hydrate(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base, ...raw, schemaVersion: SCHEMA_VERSION };
  out.categories = Array.isArray(raw.categories) && raw.categories.length ? raw.categories : base.categories;
  out.appRules = Array.isArray(raw.appRules) ? raw.appRules : base.appRules;
  out.siteRules = Array.isArray(raw.siteRules) ? raw.siteRules : base.siteRules;
  out.blocks = { ...base.blocks, ...(raw.blocks || {}) };
  out.blocks.apps = Array.isArray(out.blocks.apps) ? out.blocks.apps : [];
  out.blocks.sites = Array.isArray(out.blocks.sites) ? out.blocks.sites : [];
  out.blocks.exceptions = Array.isArray(out.blocks.exceptions) ? out.blocks.exceptions : [];
  out.plans = Array.isArray(raw.plans) ? raw.plans : [];
  out.sleep = { ...base.sleep, ...(raw.sleep || {}) };
  out.activity = raw.activity && typeof raw.activity === 'object' ? { days: raw.activity.days || {} } : base.activity;
  out.attempts = Array.isArray(raw.attempts) ? raw.attempts.slice(-500) : [];
  out.pending = Array.isArray(raw.pending) ? raw.pending : [];
  out.settings = { ...base.settings, ...(raw.settings || {}) };
  return out;
}

module.exports = { SCHEMA_VERSION, DEFAULT_CATEGORIES, DEFAULT_APP_RULES, DEFAULT_SITE_RULES, defaultState, hydrate };
