/* ============================================================
   GemAir — Game Updater (ported concept from Mark-LIII's
   actions/game_updater.py).

   Cross-platform, keyless: no Steam/Epic API keys involved, just
   OS-standard deep-link URIs and (for Epic) reading the local
   install manifests GemAir already has filesystem access to.
   Pure/testable helpers here; the actual "open this URI" call
   happens in main.js through a small allow-listed launcher.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// A small curated map of common Steam App IDs so "update GTA V" or
// "update CS2" resolves without needing to scan the whole Steam library.
const STEAM_APP_IDS = {
  'pubg': '578080', 'pubg battlegrounds': '578080', 'battlegrounds': '578080',
  'gta5': '271590', 'gta v': '271590', 'grand theft auto v': '271590',
  'cs2': '730', 'csgo': '730', 'counter-strike 2': '730', 'counter strike 2': '730',
  'dota2': '570', 'dota 2': '570',
  'rust': '252490', 'valheim': '892970',
  'cyberpunk': '1091500', 'cyberpunk 2077': '1091500',
  'elden ring': '1245620', 'minecraft': '1672970',
  'apex legends': '1172470', 'apex': '1172470',
  'fortnite': '1517990',
  'among us': '945360', 'fall guys': '1097150',
  'rocket league': '252950', 'warframe': '230410', 'destiny 2': '1085660',
  'team fortress 2': '440', 'tf2': '440',
  'left 4 dead 2': '550', 'l4d2': '550',
  'war thunder': '236390', 'path of exile': '238960', 'poe': '238960',
  'lost ark': '1599340', 'new world': '1063730'
};

function resolveSteamAppId(name) {
  const q = String(name || '').toLowerCase().trim();
  if (!q) return null;
  if (STEAM_APP_IDS[q]) return { appId: STEAM_APP_IDS[q], label: name.trim() };
  for (const [key, appId] of Object.entries(STEAM_APP_IDS)) {
    if (q.includes(key) || key.includes(q)) return { appId, label: key };
  }
  return null;
}

// steam://run/<appid> launches the app through Steam, which updates it
// first if a newer build is available — the standard, documented way to
// trigger a per-game update check without scraping or private APIs.
function buildSteamUri(appId) { return `steam://run/${appId}`; }
const STEAM_OPEN_LIBRARY_URI = 'steam://open/main';

function epicManifestsDir() {
  if (process.platform === 'win32') {
    const base = process.env.PROGRAMDATA || 'C:/ProgramData';
    return path.join(base, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  }
  return null; // Epic has no native Linux client; Heroic users manage updates there directly.
}

function listInstalledEpicGames() {
  const dir = epicManifestsDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const games = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.item')); } catch { return []; }
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const name = data.DisplayName || data.AppName;
      const appName = data.AppName;
      if (name && appName) games.push({ name, appName });
    } catch { /* skip unreadable/corrupt manifest */ }
  }
  return games;
}

function resolveEpicGame(name) {
  const q = String(name || '').toLowerCase().trim();
  if (!q) return null;
  const games = listInstalledEpicGames();
  return games.find((g) => g.name.toLowerCase().includes(q)) || null;
}

function buildEpicUri(appName) {
  return `com.epicgames.launcher://apps/${encodeURIComponent(appName)}?action=launch&silent=true`;
}
const EPIC_OPEN_URI = 'com.epicgames.launcher://apps';

function updateGame(args) {
  const launcher = String((args && args.launcher) || '').toLowerCase().trim();
  const name = args && args.name;
  if (launcher === 'steam') {
    if (name) {
      const match = resolveSteamAppId(name);
      if (match) return { ok: true, launcher: 'steam', uri: buildSteamUri(match.appId), matched: match.label, note: `Launching "${match.label}" via Steam — Steam updates it first if a newer build is available.` };
      return { ok: true, launcher: 'steam', uri: STEAM_OPEN_LIBRARY_URI, matched: null, note: `Couldn't match "${name}" to a known Steam App ID — opening your Steam library instead.` };
    }
    return { ok: true, launcher: 'steam', uri: STEAM_OPEN_LIBRARY_URI, matched: null, note: 'Opening Steam — it checks all installed games for updates automatically.' };
  }
  if (launcher === 'epic') {
    if (process.platform === 'linux') return { error: 'Epic Games has no native Linux client. Install Heroic Launcher to manage updates there.' };
    if (name) {
      const match = resolveEpicGame(name);
      if (match) return { ok: true, launcher: 'epic', uri: buildEpicUri(match.appName), matched: match.name, note: `Launching "${match.name}" via Epic Games — it updates first if needed.` };
      return { ok: true, launcher: 'epic', uri: EPIC_OPEN_URI, matched: null, note: `Couldn't find an installed Epic game matching "${name}" — opening the Epic Games launcher instead.` };
    }
    return { ok: true, launcher: 'epic', uri: EPIC_OPEN_URI, matched: null, note: 'Opening Epic Games Launcher — check for updates from its Library tab.' };
  }
  return { error: 'Specify launcher as "steam" or "epic".' };
}

module.exports = { STEAM_APP_IDS, resolveSteamAppId, buildSteamUri, STEAM_OPEN_LIBRARY_URI, epicManifestsDir, listInstalledEpicGames, resolveEpicGame, buildEpicUri, EPIC_OPEN_URI, updateGame };
