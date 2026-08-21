/* ============================================================
   GemAir 2.4 — MODES: one sentence arranges everything
   Mode = named bundle of: apps to launch, websites (+browser),
   volume level, HUD theme, do-not-disturb, optional playlist URL.
   Built-in starters: WORK, GAMING, CHILL, STUDY.
   Modes sync into profile.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let userDataDir = null;
try {
  const electron = require('electron');
  userDataDir = electron.app ? electron.app.getPath('userData') : path.join(os.homedir(), '.gemair');
} catch (e) {
  userDataDir = path.join(os.homedir(), '.gemair');
}

const MODES_FILE = path.join(userDataDir, 'gemair-modes.json');

function ensureDir() {
  try { fs.mkdirSync(path.dirname(MODES_FILE), { recursive: true }); } catch (e) {}
}

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
  try {
    const data = JSON.parse(fs.readFileSync(MODES_FILE, 'utf8'));
    // merge builtins
    const merged = { ...BUILTIN_MODES };
    if (data && typeof data === 'object') {
      for (const k of Object.keys(data)) {
        if (data[k] && data[k].name) merged[data[k].name.toUpperCase()] = data[k];
      }
    }
    return merged;
  } catch (e) {
    return JSON.parse(JSON.stringify(BUILTIN_MODES));
  }
}

function writeModesRaw(modes) {
  try {
    ensureDir();
    // Only write custom modes, keep builtins as fallback but also persist all for simplicity
    fs.writeFileSync(MODES_FILE, JSON.stringify(modes, null, 2));
    return true;
  } catch (e) { return false; }
}

function getModes() {
  return readModesRaw();
}

function getMode(name) {
  const all = readModesRaw();
  const key = String(name||'').toUpperCase().trim();
  return all[key] || null;
}

function saveMode(mode) {
  if (!mode || !mode.name) return { error: 'Mode must have name' };
  const all = readModesRaw();
  const key = String(mode.name).toUpperCase().trim();
  if (!key) return { error: 'Invalid name' };
  all[key] = {
    name: key,
    label: mode.label || key,
    icon: mode.icon || '◍',
    apps: Array.isArray(mode.apps) ? mode.apps : [],
    sites: Array.isArray(mode.sites) ? mode.sites : [],
    volume: typeof mode.volume === 'number' ? mode.volume : 50,
    theme: mode.theme || 'crimson',
    dnd: !!mode.dnd,
    playlist: mode.playlist || '',
    description: mode.description || '',
    optimizeGaming: !!mode.optimizeGaming
  };
  writeModesRaw(all);
  return { ok: true, mode: all[key] };
}

function deleteMode(name) {
  const all = readModesRaw();
  const key = String(name||'').toUpperCase().trim();
  if (!key) return { error: 'Invalid name' };
  if (BUILTIN_MODES[key] && !all[key].custom) {
    // Allow deleting builtins? Keep but mark as deleted? For now allow but will restore on next read if file missing.
    // Actually delete
  }
  delete all[key];
  writeModesRaw(all);
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
