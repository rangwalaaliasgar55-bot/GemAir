// GemAI — main process
// A free, open-source JARVIS-style desktop assistant.
// More advanced than the typical Stonic clone: persistent long-term memory,
// real tool-calling (weather, web search, reminders, notes, volume, system
// control, screenshots), and it runs on YOUR AI key (Groq / OpenAI / any
// OpenAI-compatible endpoint) — or fully offline with the built-in brain.
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, desktopCapturer, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');

const isDev = process.argv.includes('--dev');
const userDataDir = app.getPath('userData');
const PROFILE_FILE = path.join(userDataDir, 'gemai-profile.json');
const MEMORY_FILE = path.join(userDataDir, 'gemai-memory.json');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#04060c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Minimize / close to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  let icon;
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  try { icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }); }
  catch { icon = nativeImage.createEmpty(); }
  tray = new Tray(icon);
  tray.setToolTip('GemAI — your personal AI');
  const menu = Menu.buildFromTemplate([
    { label: 'Open GemAI', click: () => { mainWindow.show(); mainWindow.focus(); if (process.platform === 'darwin') app.dock.show(); } },
    { label: 'Start listening', click: () => mainWindow.webContents.send('wake:toggle', true) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  startReminderScheduler();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Persistent stores
// ---------------------------------------------------------------------------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch { return false; }
}

const readProfile = () => readJSON(PROFILE_FILE, {});
const writeProfile = (d) => writeJSON(PROFILE_FILE, d);

const EMPTY_MEMORY = { facts: [], transcript: [], notes: [], reminders: [], todos: [], summary: '' };
const readMemory = () => {
  const m = readJSON(MEMORY_FILE, EMPTY_MEMORY);
  // ensure shape
  for (const k of Object.keys(EMPTY_MEMORY)) if (!Array.isArray(m[k])) m[k] = [];
  return m;
};
const writeMemory = (m) => writeJSON(MEMORY_FILE, m);

function uid() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

// ---------------------------------------------------------------------------
// System info
// ---------------------------------------------------------------------------
function cpuUsage() {
  return new Promise((resolve) => {
    const start = os.cpus().map((c) => c.times);
    setTimeout(() => {
      const end = os.cpus().map((c) => c.times);
      let idle = 0, total = 0;
      for (let i = 0; i < start.length; i++) {
        const s = start[i], e = end[i];
        const sIdle = s.idle, sTotal = s.user + s.nice + s.sys + s.idle + s.irq;
        const eIdle = e.idle, eTotal = e.user + e.nice + e.sys + e.idle + e.irq;
        idle += eIdle - sIdle; total += eTotal - sTotal;
      }
      resolve(total === 0 ? 0 : Math.round((1 - idle / total) * 100));
    }, 250);
  });
}

async function getSystemInfo() {
  const cpu = await cpuUsage();
  const total = os.totalmem(), free = os.freemem();
  return {
    platform: os.platform(), release: os.release(), hostname: os.hostname(),
    arch: os.arch(), cpus: os.cpus().length, cpuLoad: cpu,
    memTotal: total, memFree: free, memUsed: total - free,
    memPercent: Math.round(((total - free) / total) * 100),
    uptime: os.uptime(), loadavg: os.loadavg()
  };
}

// ---------------------------------------------------------------------------
// AI — OpenAI-compatible chat WITH function/tool calling
// (Groq, OpenAI, OpenRouter, Together, Ollama, LM Studio, …)
// ---------------------------------------------------------------------------
function normalizeBaseURL(base) {
  let b = (base || '').trim();
  if (!b) return null;
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
  return b.replace(/\/+$/, '');
}

async function callChat(base, key, model, messages, tools) {
  const url = base + (base.endsWith('/chat/completions') ? '' : '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = 'Bearer ' + key;
  const body = { model, messages, temperature: 0.6, max_tokens: 1200 };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('HTTP_' + res.status + (text ? ' ' + text.slice(0, 300) : ''));
  }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error('EMPTY_REPLY');
  return data.choices[0].message;
}

// ---------------------------------------------------------------------------
// Tool definitions & execution
// ---------------------------------------------------------------------------
const TOOLS = [
  { type: 'function', function: { name: 'get_current_time', description: 'Get the current local time.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_current_date', description: "Get today's date.", parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_weather', description: 'Get current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web and return concise results.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'open_application', description: 'Open an application or file location (calculator, notepad, browser, terminal, files, settings…).', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'calculate', description: 'Evaluate a math expression.', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } } },
  { type: 'function', function: { name: 'set_reminder', description: 'Create a reminder that will notify the user later. `when` can be ISO datetime or like "in 10 minutes".', parameters: { type: 'object', properties: { text: { type: 'string' }, when: { type: 'string' } }, required: ['text', 'when'] } } },
  { type: 'function', function: { name: 'list_reminders', description: 'List the user\'s pending reminders.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'save_note', description: 'Save a note to the user\'s persistent notebook.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'list_notes', description: 'List the user\'s saved notes.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'remember_fact', description: 'Permanently remember a fact about the user (long-term memory).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'get_system_status', description: 'Read live system status (CPU, memory, uptime).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'control_volume', description: 'Change system volume.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['up', 'down', 'mute', 'unmute'] }, level: { type: 'number' } } } } },
  { type: 'function', function: { name: 'take_screenshot', description: 'Capture a screenshot of the screen.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'control_system', description: 'Lock, sleep, shutdown or restart the computer.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['lock', 'sleep', 'shutdown', 'restart'] } }, required: ['action'] } } },
  { type: 'function', function: { name: 'open_url', description: 'Open a URL in the default browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'fetch_webpage', description: 'Fetch a web page and return its readable text content (full web access).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'search_wikipedia', description: 'Search Wikipedia for a topic.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'search_youtube', description: 'Search YouTube for videos.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'list_directory', description: 'List files and folders in a directory (defaults to the user home folder).', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file from the computer.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a text file to the computer.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'search_files', description: 'Search the computer for files by name.', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'get_clipboard', description: 'Read the current clipboard text.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'set_clipboard', description: 'Write text to the clipboard.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a shell command on the computer (requires permission in Settings).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'get_world_time', description: 'Get the current time in another city/country.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
  { type: 'function', function: { name: 'translate', description: 'Translate text between languages (e.g. "hello" from en to hi).', parameters: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string', description: 'Target language code, e.g. hi, es, fr, en' }, from: { type: 'string', description: 'Source language code (optional, auto-detect)' } }, required: ['text', 'to'] } } },
  { type: 'function', function: { name: 'get_crypto_price', description: 'Get the current price of a cryptocurrency in USD/INR.', parameters: { type: 'object', properties: { coin: { type: 'string', description: 'e.g. bitcoin, ethereum, solana' } }, required: ['coin'] } } },
  { type: 'function', function: { name: 'define_word', description: 'Get the dictionary definition of an English word.', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } } },
  { type: 'function', function: { name: 'generate_image', description: 'Generate an AI image from a text prompt (free). Returns an image URL to display.', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } } },
  { type: 'function', function: { name: 'convert_currency', description: 'Convert an amount between currencies (e.g. 100 USD to INR).', parameters: { type: 'object', properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['amount', 'from', 'to'] } } },
  { type: 'function', function: { name: 'send_email', description: 'Open a pre-filled email draft in the user\'s mail app.', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to'] } } },
  { type: 'function', function: { name: 'open_whatsapp', description: 'Open a WhatsApp chat with a phone number and pre-filled message.', parameters: { type: 'object', properties: { phone: { type: 'string', description: 'Phone number with country code, digits only' }, text: { type: 'string' } }, required: ['phone'] } } },
  { type: 'function', function: { name: 'search_memory', description: 'Search the user\'s long-term memory for facts matching a query.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'list_todos', description: 'List the user\'s to-do items.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'add_todo', description: 'Add a to-do item.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'complete_todo', description: 'Mark a to-do item as done by its text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }
];

function safeEval(expr) {
  const clean = String(expr).replace(/[^0-9+\-*/().%\s]/g, '');
  if (!/[0-9]/.test(clean)) throw new Error('Not a math expression');
  // eslint-disable-next-line no-new-func
  const val = Function('"use strict";return (' + clean + ')')();
  if (typeof val !== 'number' || !isFinite(val)) throw new Error('Bad expression');
  return Math.round(val * 1e6) / 1e6;
}

function launchApp(query) {
  const q = (query || '').toLowerCase();
  const map = {
    calculator: { win: 'calc', mac: 'open -a Calculator', linux: 'gnome-calculator' },
    notepad: { win: 'notepad', mac: 'open -a TextEdit', linux: 'gedit' },
    browser: { win: 'start https://www.google.com', mac: 'open https://www.google.com', linux: 'xdg-open https://www.google.com' },
    chrome: { win: 'start chrome', mac: 'open -a "Google Chrome"', linux: 'google-chrome' },
    terminal: { win: 'start cmd', mac: 'open -a Terminal', linux: 'gnome-terminal' },
    explorer: { win: 'explorer', mac: 'open .', linux: 'xdg-open .' },
    files: { win: 'explorer', mac: 'open .', linux: 'xdg-open .' },
    settings: { win: 'start ms-settings:', mac: 'open -a "System Settings"', linux: 'gnome-control-center' }
  };
  for (const key of Object.keys(map)) {
    if (q.includes(key)) { exec(map[key][process.platform] || map[key].win, () => {}); return key; }
  }
  return null;
}

const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Showers', 81: 'Rain showers', 82: 'Heavy showers', 95: 'Thunderstorm', 96: 'Storm + hail', 99: 'Storm + hail'
};

async function getWeather(city) {
  const geo = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=en&format=json').then(r => r.json());
  const loc = geo.results && geo.results[0];
  if (!loc) return { error: 'City not found: ' + city };
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true`).then(r => r.json());
  const cw = w.current_weather || {};
  return {
    city: loc.name + (loc.country ? ', ' + loc.country : ''),
    temperature: cw.temperature,
    windspeed: cw.windspeed,
    condition: WEATHER_CODES[cw.weathercode] || 'Unknown',
    units: '°C / km/h'
  };
}

async function webSearch(query) {
  const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
  const d = await fetch(url).then(r => r.json());
  const results = [];
  const flatten = (topics) => {
    for (const t of topics || []) {
      if (t.Topics) flatten(t.Topics);
      else if (t.Text) results.push({ title: String(t.Text).split(' - ')[0], url: t.FirstURL });
    }
  };
  flatten(d.RelatedTopics);
  return {
    answer: d.AbstractText || d.Answer || null,
    source: d.AbstractSource || null,
    url: d.AbstractURL || null,
    results: results.slice(0, 5)
  };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function fetchWebpage(url) {
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const res = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GemAI/1.0)' } });
  if (!res.ok) return { error: 'HTTP ' + res.status };
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  return { title: title.trim(), url: res.url, excerpt: stripHtml(html).slice(0, 4000) };
}

async function searchWikipedia(query) {
  const res = await fetch('https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=6&search=' + encodeURIComponent(query)).then(r => r.json());
  return { titles: res[1] || [], descriptions: res[2] || [], urls: res[3] || [] };
}

function searchYouTube(query) {
  return { url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query), note: 'Open this URL to see video results.' };
}

function listDirectory(dir) {
  const base = dir || os.homedir();
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    return entries.slice(0, 100).map((e) => ({ name: e.name, type: e.isDirectory() ? 'folder' : 'file' }));
  } catch (e) { return { error: e.message }; }
}

function readFile(path_) {
  try {
    const stat = fs.statSync(path_);
    if (stat.size > 200 * 1024) return { error: 'File too large to read (' + Math.round(stat.size / 1024) + ' KB).' };
    const content = fs.readFileSync(path_, 'utf8');
    return { path: path_, content: content.slice(0, 20000) };
  } catch (e) { return { error: e.message }; }
}

function writeFile(path_, content) {
  try {
    fs.mkdirSync(path.dirname(path_), { recursive: true });
    fs.writeFileSync(path_, String(content));
    return { ok: true, path: path_ };
  } catch (e) { return { error: e.message }; }
}

function searchFiles(root, query) {
  const base = root || os.homedir();
  const q = (query || '').toLowerCase();
  if (!q) return { error: 'Provide a search query.' };
  const results = [];
  const walk = (dir, depth) => {
    if (depth > 4 || results.length >= 30) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      try {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(q)) results.push(full);
        if (e.isDirectory()) walk(full, depth + 1);
      } catch {}
    }
  };
  walk(base, 0);
  return results.slice(0, 30);
}

function runCommand(command) {
  const p = readProfile();
  if (!p.allowShell) return { error: 'Shell commands are disabled. Enable "Advanced: allow shell commands" in Settings.' };
  const cmd = String(command || '').trim();
  if (!cmd) return { error: 'Empty command.' };
  if (/rm\s+(-rf|fr)\s*\//.test(cmd) || /format\s+[a-z]:/i.test(cmd) || />\s*\/dev\//.test(cmd)) return { error: 'Command blocked for safety.' };
  return dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['Run', 'Cancel'], defaultId: 1, cancelId: 1,
    title: 'GemAI shell command', message: 'Run this command?', detail: cmd
  }).then((r) => {
    if (r.response !== 0) return { error: 'Cancelled by user.' };
    return new Promise((resolve) => {
      exec(cmd, { timeout: 20000 }, (err, stdout, stderr) => {
        resolve({ stdout: (stdout || '').slice(0, 4000), stderr: (stderr || '').slice(0, 1000), code: err ? err.code : 0 });
      });
    });
  });
}

const CITY_TZ = {
  london: 'Europe/London', newyork: 'America/New_York', nyc: 'America/New_York', losangeles: 'America/Los_Angeles',
  sanfrancisco: 'America/Los_Angeles', chicago: 'America/Chicago', toronto: 'America/Toronto', tokyo: 'Asia/Tokyo',
  sydney: 'Australia/Sydney', paris: 'Europe/Paris', berlin: 'Europe/Berlin', dubai: 'Asia/Dubai',
  singapore: 'Asia/Singapore', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', karachi: 'Asia/Karachi',
  lahoren: 'Asia/Karachi', dhaka: 'Asia/Dhaka', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai',
  moscow: 'Europe/Moscow', istanbul: 'Europe/Istanbul', cairo: 'Africa/Cairo', lagos: 'Africa/Lagos'
};

function getWorldTime(city) {
  const q = String(city || '').toLowerCase().trim().replace(/[^a-z]/g, '');
  let tz = CITY_TZ[q];
  if (!tz) {
    for (const k of Object.keys(CITY_TZ)) if (k.startsWith(q) || q.startsWith(k)) { tz = CITY_TZ[k]; break; }
  }
  if (!tz) return { error: 'Unknown city. Try: London, New York, Tokyo, Dubai, Mumbai, Karachi, Sydney…' };
  try {
    const s = new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
    return { city, time: s, timezone: tz };
  } catch { return { error: 'Could not determine time for ' + city }; }
}

async function translateText(text, to, from) {
  const pair = (from ? from + '|' : '') + to;
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + encodeURIComponent(pair);
  const d = await fetch(url).then((r) => r.json());
  if (d.responseStatus === 200 && d.responseData && d.responseData.translatedText) {
    return { translation: d.responseData.translatedText, to, from: from || 'auto' };
  }
  return { error: 'Translation failed.' };
}

async function getCryptoPrice(coin) {
  const id = String(coin || '').toLowerCase().trim();
  const d = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd,inr`).then((r) => r.json());
  if (!d[id]) return { error: 'Coin not found: ' + coin };
  return { coin: id, usd: d[id].usd, inr: d[id].inr };
}

async function defineWord(word) {
  const w = String(word || '').trim();
  const d = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w)).then((r) => r.json());
  if (!Array.isArray(d) || !d[0]) return { error: 'No definition found for "' + w + '".' };
  const m = d[0].meanings && d[0].meanings[0];
  const def = m && m.definitions && m.definitions[0];
  return {
    word: d[0].word,
    phonetic: d[0].phonetic || '',
    partOfSpeech: m ? m.partOfSpeech : '',
    definition: def ? def.definition : '',
    example: def && def.example ? def.example : ''
  };
}

function generateImage(prompt) {
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(String(prompt || '').trim()) + '?width=768&height=768&nologo=true';
  return { imageUrl: url, prompt: String(prompt).trim() };
}

async function convertCurrency(amount, from, to) {
  const f = String(from).toUpperCase(), t = String(to).toUpperCase();
  const d = await fetch(`https://api.frankfurter.app/latest?from=${f}&to=${t}`).then((r) => r.json());
  if (!d.rates || d.rates[t] === undefined) return { error: 'Currency conversion failed (unsupported currency?).' };
  return { amount, from: f, to: t, result: Math.round(amount * d.rates[t] * 100) / 100, rate: d.rates[t] };
}

function sendEmail(to, subject, body) {
  const url = 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(body || '');
  shell.openExternal(url);
  return { ok: true, to };
}

function openWhatsApp(phone, text) {
  const p = String(phone || '').replace(/[^\d]/g, '');
  const url = 'https://wa.me/' + p + (text ? '?text=' + encodeURIComponent(text) : '');
  shell.openExternal(url);
  return { ok: true, phone: p };
}

function searchMemory(query) {
  const m = readMemory();
  const q = String(query || '').toLowerCase();
  const scored = m.facts.map((f) => {
    const t = f.text.toLowerCase();
    let score = 0;
    const words = q.split(/\s+/);
    for (const w of words) if (w && t.includes(w)) score += 1;
    score += (f.importance || 0) * 0.1;
    return { f, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
  return scored.length ? { matches: scored.map((x) => x.f.text) } : { matches: [], note: 'No matching memories.' };
}

function listTodos() {
  const m = readMemory();
  return m.todos.map((t, i) => ({ index: i, text: t.text, done: !!t.done }));
}
function addTodo(text) { const m = readMemory(); m.todos.unshift({ text, done: false, created: Date.now() }); writeMemory(m); return { ok: true }; }
function completeTodo(text) {
  const m = readMemory();
  const q = String(text).toLowerCase();
  const t = m.todos.find((x) => x.text.toLowerCase().includes(q) || q.includes(x.text.toLowerCase()));
  if (t) t.done = true;
  writeMemory(m);
  return t ? { ok: true, todo: t.text } : { error: 'Todo not found: ' + text };
}

function parseWhen(text) {
  const t = String(text || '').trim();
  const rel = t.match(/in\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const u = rel[2].toLowerCase();
    const ms = n * (u.startsWith('sec') || u === 's' ? 1000 : u.startsWith('min') || u === 'm' ? 60000 : u.startsWith('hour') || u === 'h' ? 3600000 : 86400000);
    return Date.now() + ms;
  }
  const parsed = Date.parse(t);
  if (!isNaN(parsed)) return parsed;
  return Date.now() + 3600000; // default: 1 hour
}

function controlVolume(args) {
  const { action, level } = args || {};
  const p = process.platform;
  let cmd = null;
  if (p === 'win32') {
    if (action === 'up') cmd = 'powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell;$s.SendKeys([char]175)"';
    else if (action === 'down') cmd = 'powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell;$s.SendKeys([char]174)"';
    else if (action === 'mute' || action === 'unmute') cmd = 'powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell;$s.SendKeys([char]173)"';
  } else if (p === 'darwin') {
    if (action === 'up') cmd = 'osascript -e "set volume output volume (output volume of (get volume settings) + 15)"';
    else if (action === 'down') cmd = 'osascript -e "set volume output volume (output volume of (get volume settings) - 15)"';
    else if (action === 'mute') cmd = 'osascript -e "set volume with output muted"';
    else if (action === 'unmute') cmd = 'osascript -e "set volume without output muted"';
    else if (typeof level === 'number') cmd = `osascript -e "set volume output volume ${Math.max(0, Math.min(100, level))}"`;
  } else {
    if (action === 'up') cmd = 'pactl set-sink-volume @DEFAULT_SINK@ +10%';
    else if (action === 'down') cmd = 'pactl set-sink-volume @DEFAULT_SINK@ -10%';
    else if (action === 'mute') cmd = 'pactl set-sink-mute @DEFAULT_SINK@ 1';
    else if (action === 'unmute') cmd = 'pactl set-sink-mute @DEFAULT_SINK@ 0';
  }
  if (cmd) exec(cmd, () => {});
  return { ok: true, action: action || level };
}

function controlSystem(action) {
  const p = process.platform;
  const map = {
    lock: { win32: 'rundll32.exe user32.dll,LockWorkStation', darwin: '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession -suspend', linux: 'loginctl lock-session' },
    sleep: { win32: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0', darwin: 'pmset sleepnow', linux: 'systemctl suspend' },
    shutdown: { win32: 'shutdown /s /t 10', darwin: 'osascript -e \'tell app "System Events" to shut down\'', linux: 'systemctl poweroff' },
    restart: { win32: 'shutdown /r /t 10', darwin: 'osascript -e \'tell app "System Events" to restart\'', linux: 'systemctl reboot' }
  };
  const cmd = (map[action] && map[action][p]) || (map[action] && map[action].win32);
  if (cmd) exec(cmd, () => {});
  return { ok: true, action };
}

async function takeScreenshot() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const source = sources[0];
  if (!source || !source.thumbnail) return { error: 'No screen available' };
  const file = path.join(app.getPath('pictures'), `gemai-screenshot-${Date.now()}.png`);
  fs.writeFileSync(file, source.thumbnail.toPNG());
  return { ok: true, file };
}

async function executeTool(name, args) {
  try {
    switch (name) {
      case 'get_current_time':
        return { time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) };
      case 'get_current_date':
        return { date: new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) };
      case 'get_weather':
        return await getWeather(args.city);
      case 'web_search':
        return await webSearch(args.query);
      case 'open_application': {
        const name = String(args.name || '');
        const opened = launchApp(name);
        if (opened) return { ok: true, app: opened };
        const p = process.platform;
        const generic = p === 'darwin' ? `open -a "${name}"` : p === 'win32' ? `start "" "${name}"` : `xdg-open "${name}"`;
        exec(generic, () => {});
        return { ok: true, app: name, note: 'Attempted generic launch.' };
      }
      case 'open_url':
        shell.openExternal(String(args.url));
        return { ok: true };
      case 'fetch_webpage':
        return await fetchWebpage(args.url);
      case 'search_wikipedia':
        return await searchWikipedia(args.query);
      case 'search_youtube':
        return searchYouTube(args.query);
      case 'list_directory':
        return listDirectory(args.path);
      case 'read_file':
        return readFile(args.path);
      case 'write_file':
        return writeFile(args.path, args.content);
      case 'search_files':
        return searchFiles(args.path, args.query);
      case 'get_clipboard':
        return { text: clipboard.readText() };
      case 'set_clipboard':
        clipboard.writeText(String(args.text || ''));
        return { ok: true };
      case 'run_command':
        return await runCommand(args.command);
      case 'get_world_time':
        return getWorldTime(args.city);
      case 'translate':
        return await translateText(args.text, args.to, args.from);
      case 'get_crypto_price':
        return await getCryptoPrice(args.coin);
      case 'define_word':
        return await defineWord(args.word);
      case 'generate_image':
        return generateImage(args.prompt);
      case 'convert_currency':
        return await convertCurrency(args.amount, args.from, args.to);
      case 'send_email':
        return sendEmail(args.to, args.subject, args.body);
      case 'open_whatsapp':
        return openWhatsApp(args.phone, args.text);
      case 'search_memory':
        return searchMemory(args.query);
      case 'list_todos':
        return listTodos();
      case 'add_todo':
        return addTodo(args.text);
      case 'complete_todo':
        return completeTodo(args.text);
      case 'calculate':
        return { result: safeEval(args.expression) };
      case 'set_reminder': {
        const at = parseWhen(args.when);
        const m = readMemory();
        m.reminders.push({ id: uid(), text: args.text, at, done: false, notified: false, created: Date.now() });
        writeMemory(m);
        return { ok: true, at: new Date(at).toLocaleString() };
      }
      case 'list_reminders': {
        const m = readMemory();
        const list = m.reminders.filter(r => !r.done).map(r => ({ id: r.id, text: r.text, at: new Date(r.at).toLocaleString() }));
        return { reminders: list };
      }
      case 'save_note': {
        const m = readMemory();
        m.notes.unshift({ id: uid(), text: args.text, created: Date.now() });
        writeMemory(m);
        return { ok: true };
      }
      case 'list_notes': {
        const m = readMemory();
        return { notes: m.notes.map(n => ({ id: n.id, text: n.text })) };
      }
      case 'remember_fact': {
        upsertFact({ text: args.text, category: 'fact', source: 'explicit' });
        return { ok: true, fact: args.text };
      }
      case 'get_system_status': {
        const i = await getSystemInfo();
        return { cpu: i.cpuLoad + '%', memory: i.memPercent + '%', uptime: Math.floor(i.uptime) + 's', cores: i.cpus };
      }
      case 'control_volume':
        return controlVolume(args);
      case 'take_screenshot':
        return await takeScreenshot();
      case 'control_system':
        return controlSystem(args.action);
      default:
        return { error: 'Unknown tool: ' + name };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Long-term memory (facts)
// ---------------------------------------------------------------------------
function normalizeFact(text) {
  return String(text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}
function upsertFact(fact) {
  const m = readMemory();
  const norm = normalizeFact(fact.text);
  const existing = m.facts.find(f => normalizeFact(f.text) === norm);
  if (existing) { existing.updated = Date.now(); existing.importance = (existing.importance || 1) + 1; }
  else m.facts.push({ id: uid(), text: fact.text, category: fact.category || 'fact', importance: 1, created: Date.now(), updated: Date.now() });
  // cap at 300, keep most important
  if (m.facts.length > 300) m.facts = m.facts.sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 300);
  writeMemory(m);
}

function factsForPrompt() {
  const m = readMemory();
  const now = Date.now();
  const scored = m.facts.map((f) => {
    const age = now - (f.updated || f.created || now);
    const recency = 1 / (1 + age / (7 * 86400000)); // fade over a week
    return { f, score: (f.importance || 1) * 0.7 + recency * 3 };
  }).sort((a, b) => b.score - a.score).slice(0, 80);
  return scored.map((x) => `- ${x.f.text}`).join('\n');
}

// Extract durable facts from a conversation turn using the user's own model.
async function extractFacts(config, userText, assistantText) {
  try {
    const base = normalizeBaseURL(config.baseURL);
    if (!base) return 0;
    const key = (config.apiKey || '').trim();
    const isLocal = /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(base);
    if (!key && !isLocal) return 0;
    const model = (config.model || 'llama-3.3-70b-versatile').trim();
    const sys = {
      role: 'system',
      content: 'You are a long-term memory extractor. Given a conversation turn between the user and the assistant, output ONLY a JSON array of NEW durable facts about the user worth remembering permanently (name, identity, preferences, projects, goals, relationships, important decisions, dislikes). Each item: {"text":"...","category":"identity|preference|project|fact|goal"}. If nothing new and durable, output []. Do not repeat facts already known. No prose, no markdown.'
    };
    const msgs = [sys, { role: 'user', content: 'User said: ' + userText + '\n\nAssistant replied: ' + (assistantText || '').slice(0, 800) }];
    const msg = await callChat(base, key, model, msgs, null);
    let text = (msg.content || '').trim();
    text = text.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) {
      let added = 0;
      for (const item of arr) {
        if (item && item.text) { upsertFact(item); added++; }
      }
      return added;
    }
    return 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// AI chat entry point (with tools)
// ---------------------------------------------------------------------------
async function aiChat(config, messages) {
  const base = normalizeBaseURL(config.baseURL);
  const key = (config.apiKey || '').trim();
  const model = (config.model || 'llama-3.3-70b-versatile').trim();
  const isLocal = base && /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(base);

  if (!base) throw new Error('NO_ENDPOINT');
  if (!key && !isLocal) throw new Error('NO_KEY');

  const msgs = [...messages];
  const supportsTools = true; // all OpenAI-compatible endpoints here support it

  for (let i = 0; i < 6; i++) {
    const msg = await callChat(base, key, model, msgs, supportsTools ? TOOLS : null);
    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length) {
      msgs.push(msg);
      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        const result = await executeTool(tc.function.name, args);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    const reply = msg.content;
    if (!reply || !reply.trim()) throw new Error('EMPTY_REPLY');
    return reply.trim();
  }
  throw new Error('TOOL_LOOP');
}

// ---------------------------------------------------------------------------
// Streaming chat (Groq / OpenAI-compatible). Streams deltas for a live JARVIS feel.
// ---------------------------------------------------------------------------
async function streamRequest(base, key, model, messages, onDelta) {
  const url = base + (base.endsWith('/chat/completions') ? '' : '/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = 'Bearer ' + key;
  const body = { model, messages, temperature: 0.6, max_tokens: 1200, stream: true, tools: TOOLS, tool_choice: 'auto' };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('HTTP_' + res.status + (text ? ' ' + text.slice(0, 200) : ''));
  }

  let content = '';
  const toolCalls = []; // [{id, name, args}]
  const toolArgs = {};  // index -> accumulated args string

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; onDelta(delta.content); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || ('call_' + idx), name: '', args: '' };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function && tc.function.name) toolCalls[idx].name += tc.function.name;
          if (tc.function && tc.function.arguments) toolCalls[idx].args += tc.function.arguments;
        }
      }
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean) };
}

async function aiChatStream(config, messages, onDelta) {
  const base = normalizeBaseURL(config.baseURL);
  const key = (config.apiKey || '').trim();
  const model = (config.model || 'llama-3.3-70b-versatile').trim();
  const isLocal = base && /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(base);
  if (!base) throw new Error('NO_ENDPOINT');
  if (!key && !isLocal) throw new Error('NO_KEY');

  let msgs = [...messages];
  let final = '';

  for (let i = 0; i < 6; i++) {
    const { content, toolCalls } = await streamRequest(base, key, model, msgs, onDelta);
    if (toolCalls.length) {
      // A tool call was requested mid-stream; execute and continue.
      const assistantMsg = { role: 'assistant', content: content || null, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args || '{}' } })) };
      msgs.push(assistantMsg);
      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.args || '{}'); } catch {}
        const result = await executeTool(tc.name, args);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      final = ''; // the real answer comes after tools
      continue;
    }
    final = content;
    if (final && final.trim()) break;
  }
  if (!final || !final.trim()) throw new Error('EMPTY_REPLY');
  return final.trim();
}

// ---------------------------------------------------------------------------
// Memory summarization (auto-consolidate old transcript)
// ---------------------------------------------------------------------------
async function summarizeTranscript(config, text) {
  try {
    const base = normalizeBaseURL(config.baseURL);
    if (!base) return null;
    const key = (config.apiKey || '').trim();
    const isLocal = /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(base);
    if (!key && !isLocal) return null;
    const model = (config.model || 'llama-3.3-70b-versatile').trim();
    const msgs = [
      { role: 'system', content: 'Summarize this conversation into 2-4 concise bullet points of durable facts about the user (preferences, projects, goals, context). Keep under 150 words. Plain text, no preamble.' },
      { role: 'user', content: text.slice(0, 6000) }
    ];
    const msg = await callChat(base, key, model, msgs, null);
    return (msg.content || '').trim();
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Offline brain (used ONLY when no key is configured)
// ---------------------------------------------------------------------------
async function offlineBrain(text) {
  const q = (text || '').toLowerCase().trim();
  if (!q) return "I didn't catch that. Say it again?";

  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

  if (/^(hi|hello|hey|salam|yo|good (morning|evening|afternoon))\b/.test(q) && q.length < 14)
    return 'Hello. GemAI online. All systems standing by. (I am running on the built-in offline brain — add a free Groq key in Settings for full intelligence.)';

  if (/your name|who are you/.test(q)) return "I'm GemAI — your personal AI, like your own JARVIS. I can talk to any AI model you connect, and I remember everything we discuss.";

  if (/how are you/.test(q)) return 'All circuits nominal. How can I assist?';
  if (/time|clock/.test(q)) return `The current time is ${time}.`;
  if (/\bdate\b|what day/.test(q)) return `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;

  if (/weather|temperature|forecast/.test(q)) {
    const m = q.match(/weather (?:in|for|at)? ?([a-z ]+)/) || q.match(/(?:in|for|at) ([a-z ]+)/);
    const city = (m && m[1]) ? m[1].trim() : null;
    if (city) { const w = await getWeather(city); return w.error || `In ${w.city} it is ${w.temperature}°C with ${w.condition} (wind ${w.windspeed} km/h).`; }
    return 'Tell me a city — e.g. "weather in Mumbai".';
  }

  if (/search|google|look up|find|who is|what is/.test(q)) {
    const query = q.replace(/^(search|google|look up|find) (for )?/i, '').trim();
    if (query) { const s = await webSearch(query); return s.answer || (s.results[0] ? `Top result: ${s.results[0].title}` : `No results found for "${query}".`); }
  }

  if (/remind|reminder/.test(q)) {
    const m = q.match(/remind(?: me)?(?: to)? (.+?)(?: in (.+)| at (.+))$/);
    if (m) {
      const text = m[1].trim(); const when = (m[2] || m[3] || '1 hour').trim();
      const at = parseWhen(when);
      const mem = readMemory(); mem.reminders.push({ id: uid(), text, at, done: false, notified: false, created: Date.now() }); writeMemory(mem);
      return `Reminder set: "${text}" for ${new Date(at).toLocaleString()}.`;
    }
  }

  if (/note|remember to|write down|save this/.test(q)) {
    const text = q.replace(/^(make a note|note|remember to|write down|save this)[:,]?\s*/i, '').trim();
    if (text) { const mem = readMemory(); mem.notes.unshift({ id: uid(), text, created: Date.now() }); writeMemory(mem); return `Saved to your notebook: "${text}".`; }
  }

  if (/open|launch|start/.test(q)) {
    const opened = launchApp(q);
    if (opened) return `Launching ${opened} now.`;
    return 'I can open the calculator, notepad, browser, terminal, files and settings.';
  }

  if (/volume|mute|unmute|louder|quieter/.test(q)) {
    if (/up|louder/.test(q)) controlVolume({ action: 'up' });
    else if (/down|quieter/.test(q)) controlVolume({ action: 'down' });
    else controlVolume({ action: 'mute' });
    return 'Volume adjusted.';
  }

  if (/screenshot|screen shot/.test(q)) { const r = await takeScreenshot(); return r.error || `Screenshot saved to ${r.file}.`; }
  if (/lock/.test(q) && /computer|screen|pc/.test(q)) { controlSystem('lock'); return 'Locking the screen.'; }
  if (/shutdown|power off/.test(q)) { controlSystem('shutdown'); return 'Shutting down in 10 seconds.'; }
  if (/restart|reboot/.test(q)) { controlSystem('restart'); return 'Restarting in 10 seconds.'; }

  if (/system|status|cpu|memory|ram|health|stats/.test(q)) {
    const i = await getSystemInfo();
    return `CPU ${i.cpuLoad}%, memory ${i.memPercent}% used, up ${Math.floor(i.uptime / 3600)}h ${Math.floor((i.uptime % 3600) / 60)}m. Full readout is on the System Core panel.`;
  }

  if (/joke/.test(q)) return "There are only 10 kinds of people: those who understand binary and those who don't.";
  if (/calculate|calc|math|what is|whats|what's|=/.test(q)) {
    const expr = q.replace(/[^0-9+\-*/().%\s]/g, ' ').trim();
    if (/[0-9]/.test(expr) && /[+\-*/]/.test(expr)) {
      try { return `That computes to ${safeEval(expr)}.`; } catch {}
    }
  }
  if (/my memories|what do you remember|what do you know about me/.test(q)) {
    const f = factsForPrompt();
    return f ? `Here is what I remember about you:\n${f}` : "I don't have any memories yet — we'll build them as we talk.";
  }
  if (/thank|thanks|shukriya/.test(q)) return 'You are most welcome.';
  if (/bye|goodbye|good night|exit|quit/.test(q)) return 'Going to standby. Goodbye.';

  return `I'm in offline mode, so I handle the basics — time, date, weather, web search, math, reminders, notes, opening apps, volume and system control. ` +
    `For a full AI brain, add a free Groq API key in Settings → AI Brain (groq.com/console, free tier available).`;
}

// ---------------------------------------------------------------------------
// Headlines feed (free, keyless) — Hacker News
// ---------------------------------------------------------------------------
async function getHeadlines(limit = 12) {
  try {
    const top = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json').then((r) => r.json());
    const ids = (Array.isArray(top) ? top : []).slice(0, limit);
    const items = await Promise.all(ids.map((id) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()).catch(() => null)
    ));
    return items.filter(Boolean).filter((i) => i.title).map((i) => ({
      id: i.id, title: i.title, url: i.url || `https://news.ycombinator.com/item?id=${i.id}`, score: i.score || 0, by: i.by || ''
    }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Reminder scheduler
// ---------------------------------------------------------------------------
function startReminderScheduler() {
  setInterval(() => {
    const m = readMemory();
    let changed = false;
    for (const r of m.reminders) {
      if (!r.done && !r.notified && r.at <= Date.now()) {
        r.notified = true; changed = true;
        if (mainWindow) mainWindow.webContents.send('reminder:due', r);
        if (Notification.isSupported()) new Notification({ title: 'GemAI Reminder', body: r.text }).show();
      }
    }
    if (changed) writeMemory(m);
  }, 15000);
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('system:info', () => getSystemInfo());
ipcMain.handle('profile:get', () => readProfile());
ipcMain.handle('profile:set', (_e, data) => writeProfile(data || {}));

ipcMain.handle('ai:chat', async (_e, config, messages) => {
  try { return { ok: true, reply: await aiChat(config, messages) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('ai:chatStream', async (e, reqId, config, messages) => {
  const wc = e.sender;
  try {
    const reply = await aiChatStream(config, messages, (delta) => wc.send('ai:chunk', { reqId, delta }));
    wc.send('ai:streamEnd', { reqId, reply });
    return { ok: true, reqId, reply };
  } catch (err) {
    wc.send('ai:streamError', { reqId, error: err.message });
    return { ok: false, reqId, error: err.message };
  }
});
ipcMain.handle('ai:offline', async (_e, text) => ({ ok: true, reply: await offlineBrain(text) }));
ipcMain.handle('ai:summarize', async (_e, config, text) => ({ ok: true, summary: await summarizeTranscript(config, text) }));

ipcMain.handle('memory:get', () => readMemory());
ipcMain.handle('memory:append', (_e, role, content) => {
  const m = readMemory();
  m.transcript.push({ role, content, ts: Date.now() });
  if (m.transcript.length > 2000) m.transcript = m.transcript.slice(-2000);
  writeMemory(m); return true;
});
ipcMain.handle('memory:clearTranscript', () => { const m = readMemory(); m.transcript = []; writeMemory(m); return true; });
ipcMain.handle('memory:addFact', (_e, fact) => { upsertFact(fact); return true; });
ipcMain.handle('memory:deleteFact', (_e, id) => { const m = readMemory(); m.facts = m.facts.filter(f => f.id !== id); writeMemory(m); return true; });
ipcMain.handle('memory:addNote', (_e, text) => { const m = readMemory(); m.notes.unshift({ id: uid(), text, created: Date.now() }); writeMemory(m); return true; });
ipcMain.handle('memory:deleteNote', (_e, id) => { const m = readMemory(); m.notes = m.notes.filter(n => n.id !== id); writeMemory(m); return true; });
ipcMain.handle('memory:addReminder', (_e, text, at) => { const m = readMemory(); m.reminders.push({ id: uid(), text, at, done: false, notified: false, created: Date.now() }); writeMemory(m); return true; });
ipcMain.handle('memory:deleteReminder', (_e, id) => { const m = readMemory(); m.reminders = m.reminders.filter(r => r.id !== id); writeMemory(m); return true; });
ipcMain.handle('memory:markReminder', (_e, id, done) => { const m = readMemory(); const r = m.reminders.find(r => r.id === id); if (r) { r.done = !!done; r.notified = false; } writeMemory(m); return true; });
ipcMain.handle('memory:extract', (_e, config, userText, assistantText) => extractFacts(config, userText, assistantText));

ipcMain.handle('file:saveCode', async (_e, content, suggestedName) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save output', defaultPath: suggestedName || 'gemai-output.txt',
    filters: [{ name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try { fs.writeFileSync(res.filePath, content); return { ok: true, path: res.filePath }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('news:get', (_e, limit) => getHeadlines(limit || 12));
ipcMain.handle('app:openExternal', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url); });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:platform', () => process.platform);
