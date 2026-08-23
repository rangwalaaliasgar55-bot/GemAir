/* ============================================================
   GemAir 2.4 — MODES: one sentence arranges everything
   Mode = named bundle of: apps to launch, websites (+browser),
   volume level, HUD theme, do-not-disturb, optional playlist URL.
   Built-in starters: WORK, GAMING, CHILL, STUDY.
   Modes sync into profile.
   ============================================================ */
'use strict';
const path = require('path');
const os = require('os');
const { readJsonRecovering, writeJsonAtomic } = require('./atomic-store');

let userDataDir = null;
try {
  const electron = require('electron');
  userDataDir = electron.app ? electron.app.getPath('userData') : path.join(os.homedir(), '.gemair');
} catch (e) {
  userDataDir = path.join(os.homedir(), '.gemair');
}

const MODES_FILE = path.join(userDataDir, 'gemair-modes.json');
const MODES_STORE_LIMIT = 1024 * 1024;

const BUILTIN_MODES = {
  WORK: {
    name: 'WORK',
    label: 'Work',
    icon: '💼',
    apps: ['chrome', 'vscode', 'slack'],
    sites: [
      { url: 'https://gmail.com', browser: 'chrome' },
      { url: 'https://calendar.google.com', browser: 'chrome' },
      { url: 'https://github.com', browser: 'chrome' }
    ],
    volume: 30,
    theme: 'cyan',
    dnd: true,
    playlist: '',
    description: 'Browser + code + comms, low volume, cyan HUD, DND on'
  },
  GAMING: {
    name: 'GAMING',
    label: 'Gaming',
    icon: '🎮',
    apps: ['steam', 'discord'],
    sites: [
      { url: 'https://youtube.com', browser: 'chrome' }
    ],
    volume: 70,
    theme: 'crimson',
    dnd: true,
    playlist: '',
    description: 'Optimized for gaming + comms, crimson HUD, DND',
    optimizeGaming: true
  },
  CHILL: {
    name: 'CHILL',
    label: 'Chill',
    icon: '🌙',
    apps: ['spotify'],
    sites: [
      { url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', browser: 'chrome' } // lofi
    ],
    volume: 40,
    theme: 'violet',
    dnd: false,
    playlist: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
    description: 'Soft music, low volume, violet HUD'
  },
  STUDY: {
    name: 'STUDY',
    label: 'Study',
    icon: '📚',
    apps: ['notepad'],
    sites: [
      { url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', browser: 'chrome' }
    ],
    volume: 20,
    theme: 'emerald',
    dnd: true,
    playlist: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
    description: 'Focus: minimal apps, lofi, emerald HUD, DND on'
  }
};

function readModesRaw() {
  const data = readJsonRecovering(MODES_FILE, {}, { maxBytes: MODES_STORE_LIMIT });
  const merged = { ...BUILTIN_MODES };
  for (const key of Object.keys(data).slice(0, 100)) {
    const normalized = normalizeModeRecord(data[key]);
    if (normalized.mode) merged[normalized.mode.name] = normalized.mode;
  }
  return merged;
}
function writeModesRaw(modes) {
  return writeJsonAtomic(MODES_FILE, modes, { maxBytes: MODES_STORE_LIMIT });
}

function getModes() {
  return readModesRaw();
}

function getMode(name) {
  const all = readModesRaw();
  const key = String(name||'').toUpperCase().trim();
  return all[key] || null;
}

function isValidModeName(name) {
  return typeof name === 'string' && /^[A-Z0-9_\- ]{1,50}$/.test(name.trim().toUpperCase());
}
function cleanShortText(value, fallback, max = 100) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, max).replace(/[\0\r\n]/g, ' ');
}
function isValidAppName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 80 && /^[\p{L}\p{N} ._+#()-]+$/u.test(name.trim());
}
function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}
function normalizeSite(site) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) return null;
  const url = normalizeHttpUrl(site.url);
  if (!url) return null;
  const browser = site.browser == null || site.browser === '' ? '' : cleanShortText(site.browser, '', 40).toLowerCase();
  if (browser && !/^[a-z0-9 ._-]+$/.test(browser)) return null;
  return { url, ...(browser ? { browser } : {}) };
}

function normalizeModeRecord(mode) {
  if (!mode || typeof mode !== 'object' || Array.isArray(mode) || !isValidModeName(mode.name)) return { error: 'Mode name must be 1-50 letters, numbers, spaces, hyphens, or underscores.' };
  const key = mode.name.trim().toUpperCase();
  const apps = Array.isArray(mode.apps) ? mode.apps : [];
  const sites = Array.isArray(mode.sites) ? mode.sites : [];
  if (apps.length > 20 || !apps.every(isValidAppName)) return { error: 'Apps must contain at most 20 valid app names.' };
  if (sites.length > 20) return { error: 'Sites must contain at most 20 entries.' };
  const normalizedSites = sites.map(normalizeSite);
  if (normalizedSites.some((site) => !site)) return { error: 'Every site must use a valid http(s) URL and optional safe browser name.' };
  const playlist = mode.playlist ? normalizeHttpUrl(mode.playlist) : '';
  if (mode.playlist && !playlist) return { error: 'Playlist must be a valid http(s) URL.' };
  const volume = mode.volume == null ? 50 : Number(mode.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) return { error: 'Volume must be between 0 and 100.' };
  return { mode: {
    name: key,
    label: cleanShortText(mode.label, key, 50),
    icon: cleanShortText(mode.icon, '◍', 8),
    apps: apps.map((app) => app.trim()),
    sites: normalizedSites,
    volume: Math.round(volume),
    theme: cleanShortText(mode.theme, 'crimson', 30).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'crimson',
    dnd: !!mode.dnd,
    playlist,
    description: cleanShortText(mode.description, '', 500),
    optimizeGaming: !!mode.optimizeGaming,
    custom: !BUILTIN_MODES[key]
  } };
}

function saveMode(mode) {
  const normalized = normalizeModeRecord(mode);
  if (normalized.error) return normalized;
  const all = readModesRaw();
  all[normalized.mode.name] = normalized.mode;
  if (!writeModesRaw(all)) return { error: 'Could not save mode.' };
  return { ok: true, mode: normalized.mode };
}

function deleteMode(name) {
  const all = readModesRaw();
  const key = String(name || '').toUpperCase().trim();
  if (!isValidModeName(key)) return { error: 'Invalid name' };
  if (BUILTIN_MODES[key]) return { error: 'Built-in modes cannot be deleted.' };
  if (!all[key]) return { error: 'Mode not found.' };
  delete all[key];
  if (!writeModesRaw(all)) return { error: 'Could not delete mode.' };
  return { ok: true };
}

function listModes() {
  const all = readModesRaw();
  return Object.values(all);
}

module.exports = {
  MODES_FILE,
  BUILTIN_MODES,
  getModes,
  getMode,
  saveMode,
  deleteMode,
  listModes
};
