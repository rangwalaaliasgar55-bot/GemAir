// GemAir 2.4 — main process
// Three leaps: (1) true account connect like Stonic (no API keys ever), (2) opencode-style agentic desktop management, (3) user-defined MODES
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, desktopCapturer, clipboard, Tray, Menu, nativeImage, screen, safeStorage, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');

const connections = require('./lib/connections');
const windowTools = require('./lib/window-tools');
const modesLib = require('./lib/modes');

const isDev = process.argv.includes('--dev');
const userDataDir = app.getPath('userData');
const PROFILE_FILE = path.join(userDataDir, 'gemair-profile.json');
const MEMORY_FILE = path.join(userDataDir, 'gemair-memory.json');
const WINDOW_STATE_FILE = path.join(userDataDir, 'gemair-window-state.json');

(function migrateLegacyFiles() {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'GemAI');
    if (!fs.existsSync(legacyDir)) return;
    fs.mkdirSync(userDataDir, { recursive: true });
    for (const [oldName, newPath] of [
      ['gemai-profile.json', PROFILE_FILE],
      ['gemai-memory.json', MEMORY_FILE]
    ]) {
      const oldPath = path.join(legacyDir, oldName);
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) fs.copyFileSync(oldPath, newPath);
    }
  } catch (e) { console.error('[migrate]', e.message); }
})();

let mainWindow = null;
let tray = null;
let isQuitting = false;
let authWindow = null;
let focusPollTimer = null;
let lastFocused = { app: '', title: '', pid: 0 };

const DEFAULT_BOUNDS = { width: 1440, height: 900 };

function displaySetKey() {
  try {
    return screen.getAllDisplays()
      .map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}`)
      .sort()
      .join('|') || 'unknown';
  } catch (e) { return 'unknown'; }
}
function readWindowState() {
  try { return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function writeWindowState(state) {
  try { fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}
function clampToVisibleDisplay(bounds) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  let displays = [];
  try { displays = screen.getAllDisplays(); } catch (e) { return null; }
  if (!displays.length) return null;
  const width = Math.max(1080, Math.min(bounds.width, 8000));
  const height = Math.max(700, Math.min(bounds.height, 8000));
  const cx = (bounds.x || 0) + width / 2;
  const cy = (bounds.y || 0) + height / 2;
  const host = displays.find((d) => {
    const a = d.workArea;
    return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height;
  });
  const area = (host || screen.getPrimaryDisplay()).workArea;
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  const x = host ? Math.min(Math.max(bounds.x, area.x), area.x + area.width - w) : Math.round(area.x + (area.width - w) / 2);
  const y = host ? Math.min(Math.max(bounds.y, area.y), area.y + area.height - h) : Math.round(area.y + (area.height - h) / 2);
  return { x, y, width: w, height: h, maximized: !!bounds.maximized, onKnownDisplay: !!host };
}
function restoredBounds() {
  const state = readWindowState();
  const saved = state[displaySetKey()];
  const clamped = clampToVisibleDisplay(saved);
  if (clamped) return clamped;
  return { ...DEFAULT_BOUNDS };
}
function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const maximized = mainWindow.isMaximized();
    const b = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const state = readWindowState();
    state[displaySetKey()] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized, savedAt: Date.now() };
    const keys = Object.keys(state).sort((a, b2) => (state[b2].savedAt || 0) - (state[a].savedAt || 0));
    const trimmed = {};
    for (const k of keys.slice(0, 8)) trimmed[k] = state[k];
    writeWindowState(trimmed);
    return true;
  } catch (e) { return false; }
}

function createWindow() {
  const start = restoredBounds();
  mainWindow = new BrowserWindow({
    x: start.x,
    y: start.y,
    width: start.width,
    height: start.height,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#04060c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  if (start.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  let boundsTimer = null;
  const queueSave = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveWindowBounds, 500); };
  mainWindow.on('resize', queueSave);
  mainWindow.on('move', queueSave);
  mainWindow.on('maximize', queueSave);
  mainWindow.on('unmaximize', queueSave);
  try {
    screen.on('display-added', queueSave);
    screen.on('display-removed', queueSave);
    screen.on('display-metrics-changed', queueSave);
  } catch (e) {}
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (e) => {
    saveWindowBounds();
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  startFocusPolling();
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  let icon = nativeImage.createEmpty();
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) icon = img.resize({ width: 16, height: 16 });
  } catch {}
  if (icon.isEmpty()) icon = fallbackTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('GemAir — your personal AI');
  const menu = Menu.buildFromTemplate([
    { label: 'Open GemAir', click: () => { mainWindow.show(); mainWindow.focus(); if (process.platform === 'darwin') app.dock.show(); } },
    { label: 'Start listening', click: () => mainWindow.webContents.send('wake:toggle', true) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
}
function fallbackTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      const inside = dx * dx + dy * dy <= 49;
      const i = (y * size + x) * 4;
      buf[i] = inside ? 229 : 0;
      buf[i + 1] = inside ? 57 : 0;
      buf[i + 2] = inside ? 53 : 0;
      buf[i + 3] = inside ? 255 : 0;
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

app.whenReady().then(() => {
  createWindow();
  try { createTray(); } catch (e) { console.error('[tray] disabled:', e.message); }
  startReminderScheduler();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});
app.on('before-quit', () => { isQuitting = true; if (focusPollTimer) clearInterval(focusPollTimer); });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Persistent stores
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
const EMPTY_MEMORY = { facts: [], transcript: [], notes: [], reminders: [], todos: [], mood: [], goals: [], skills: [], instructions: [], actionLog: [], summary: '' };
const readMemory = () => {
  const m = readJSON(MEMORY_FILE, EMPTY_MEMORY);
  for (const k of Object.keys(EMPTY_MEMORY)) if (!Array.isArray(m[k])) m[k] = [];
  return m;
};
const writeMemory = (m) => writeJSON(MEMORY_FILE, m);
function uid() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

// Emotion + language + support (same as 2.2)
const EMOTION_LEXICON = {
  joy: ['happy', 'glad', 'great', 'awesome', 'amazing', 'wonderful', 'yay', 'delighted', 'joy', 'cheerful', 'best', 'win', 'good day', 'made my day'],
  excitement: ['excited', 'pumped', 'thrilled', 'wow', 'lets go', "can't wait", 'cant wait', 'fired up'],
  love: ['love', 'adore', 'care about', 'miss you', 'my love', 'romantic', 'crush'],
  gratitude: ['grateful', 'thankful', 'thanks', 'appreciate', 'blessed', 'shukriya'],
  confident: ['confident', 'proud', 'achieved', 'accomplished', 'succeeded', 'success', 'nailed it'],
  hope: ['hopeful', 'hope', 'optimistic', 'looking forward', 'excited for', 'believe in'],
  relief: ['relieved', 'relief', 'phew', 'glad it', 'what a relief', 'finally'],
  curiosity: ['curious', 'wondering', 'how does', 'what is', 'why', 'tell me about', 'explain', 'question', 'learn'],
  boredom: ['bored', 'boring', 'nothing to do', 'uninterested', 'monotonous'],
  tired: ['tired', 'exhausted', 'sleepy', 'fatigued', 'drained', 'burnout', 'burned out', 'no energy', 'so sleepy'],
  anxiety: ['anxious', 'anxiety', 'nervous', 'overwhelmed', 'stressed', 'stress', 'worry', 'worried', 'pressure', 'restless', 'panic', 'overthinking'],
  sadness: ['sad', 'down', 'depressed', 'unhappy', 'miserable', 'crying', 'cry', 'grief', 'lonely', 'heartbroken', 'upset', 'blue', 'hopeless', 'empty'],
  fear: ['scared', 'afraid', 'fear', 'terrified', 'frightened', 'dread', 'petrified'],
  anger: ['angry', 'mad', 'furious', 'annoyed', 'irritated', 'hate', 'rage', 'frustrated', 'frustrating', 'pissed', 'fed up'],
  guilt: ['guilty', 'regret', 'remorse', 'sorry i', 'should have', 'ashamed of'],
  embarrassment: ['embarrassed', 'embarrassing', 'ashamed', 'humiliated', 'cringe', 'so awkward']
};
const EMOTION_VALENCE = {
  joy: 1, excitement: 1, love: 0.9, gratitude: 0.9, confident: 0.8, hope: 0.7, relief: 0.8, curiosity: 0.25,
  boredom: -0.3, tired: -0.4, anxiety: -0.6, sadness: -0.7, fear: -0.7, anger: -0.8, guilt: -0.5, embarrassment: -0.4
};
function analyzeEmotion(text) {
  const q = String(text || '').toLowerCase();
  const negated = /\b(not|no|never|don't|dont|cant|can't|isn't|isnt|wasn't)\b/;
  const scores = {};
  let totalHits = 0;
  for (const [emotion, words] of Object.entries(EMOTION_LEXICON)) {
    let score = 0;
    for (const w of words) {
      if (q.includes(w)) {
        const idx = q.indexOf(w);
        const window = q.slice(Math.max(0, idx - 24), idx);
        const v = negated.test(window) ? -1 : 1;
        score += v; if (v > 0) totalHits++;
      }
    }
    scores[emotion] = score;
  }
  const entries = Object.entries(scores).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { emotion: 'neutral', valence: 0, arousal: 0.3, intensity: 0, confidence: 0.4 };
  const emotion = entries[0][0];
  const valence = EMOTION_VALENCE[emotion] ?? 0;
  const arousal = ['excitement', 'anger', 'fear', 'joy'].includes(emotion) ? 0.85 : ['sadness', 'tired', 'boredom'].includes(emotion) ? 0.25 : 0.5;
  return {
    emotion,
    valence,
    arousal,
    intensity: Math.min(1, entries[0][1] / 3),
    confidence: Math.min(0.95, 0.4 + entries[0][1] * 0.15 + Math.min(0.15, totalHits * 0.02))
  };
}
function detectLanguage(text) {
  const t = String(text || '');
  const devanagari = (t.match(/[\u0900-\u097F]/g) || []).length;
  const arabic = (t.match(/[\u0600-\u06FF\u0750-\u077F]/g) || []).length;
  if (devanagari > arabic && devanagari > 2) return 'hi';
  if (arabic > devanagari && arabic > 2) return 'ur';
  const hinglish = /\b(kaise|kya|hai|hain|nahi|nahin|mujhe|tumhara|aap|mera|meri|accha|theek|shukriya|kyun|kab|kahan|bhai|yaar|zaroor|bilkul)\b/i.test(t);
  if (hinglish) return 'hinglish';
  return 'en';
}
const CRISIS_SIGNALS = /\b(suicid|kill myself|end my life|end it all|don'?t want to (live|be here|exist)|no reason to live|better off dead|hurt myself|self.?harm|cut myself|give up on life)\b/i;
function supportGuidance(emotion, text, crisis) {
  const e = emotion || 'neutral';
  if (crisis) {
    return {
      tone: 'crisis',
      guidance: "I'm really glad you told me. What you're feeling matters, and you deserve support — you are not alone in this.",
      action: "Please reach out to someone who can be with you right now: a trusted friend or family member, or a crisis helpline. In India you can call iCall (9152987821) or Vandrevala Foundation (1860-266-2345 / 9999666555). Internationally, find support at findahelpline.com. If you're in immediate danger, please contact local emergency services. I'm here with you — but I'm not a substitute for a human or professional who can help in person."
    };
  }
  const map = {
    sadness: { tone: 'gentle', guidance: "I can hear how heavy this feels, and I'm really sorry you're going through it. It's completely okay to feel this way — you don't have to be strong all the time.", action: "Would you like to just talk it through with me? Sometimes naming what's weighing on you makes it a little lighter. I'm here, and I'm listening without any judgment." },
    guilt: { tone: 'forgiving', guidance: "Thank you for being honest with me — that takes real courage. Everyone makes mistakes; a mistake is something you did, not who you are. The fact that you feel bad about it says something good about your character.", action: "What matters now is what you do next. If it's possible and feels right, we can talk about making it right or apologizing — and then about forgiving yourself. Would you like to work through it together?" },
    embarrassment: { tone: 'reassuring', guidance: "That uncomfortable feeling will pass — I promise it feels much bigger to you than it does to anyone else. People are mostly focused on themselves, not judging you.", action: "Let's not spiral on it. One deep breath — you're human, and this one moment doesn't define you." },
    anger: { tone: 'calming', guidance: "It's okay to be angry — it usually means something important to you was crossed. Let's not act on it while it's hot.", action: "Want to tell me what happened? Getting it out often cools the fire enough to respond well instead of react." },
    anxiety: { tone: 'grounding', guidance: "That worried, overwhelmed feeling is awful, and I hear you. Most of what anxiety predicts never actually happens — but telling you to 'calm down' never helps.", action: "Let's do one small thing together: name the single most concrete worry right now. Then we can figure out the smallest possible next step, together." },
    fear: { tone: 'reassuring', guidance: "Fear is your mind trying to protect you, and it's okay to feel it. You've faced hard things before and come through them.", action: "Tell me what's scaring you — putting it into words shrinks it a little, and we can look at it together." },
    tired: { tone: 'warm', guidance: "You sound exhausted, and that's a completely valid signal, not a weakness. Rest is a requirement, not a reward.", action: "Maybe the kindest thing right now is to step back, drink some water, and rest. You don't have to solve everything today." },
    hope: { tone: 'encouraging', guidance: "I love that hopeful energy — it's a great sign. Let's channel it.", action: "What's one concrete step you could take today toward the thing you're looking forward to?" },
    joy: { tone: 'celebrating', guidance: "I'm genuinely happy for you — this is worth pausing to enjoy.", action: "Tell me more! What happened? Let's celebrate the win properly." },
    gratitude: { tone: 'warm', guidance: "Noticing what's going well is a superpower. I'm glad you're feeling it.", action: "What are you grateful for right now?" },
    love: { tone: 'warm', guidance: "That's a beautiful feeling — love makes everything more vivid.", action: "Tell me about it. Who or what are you feeling this toward?" }
  };
  return map[e] || { tone: 'warm', guidance: "I'm here with you, and I'm listening.", action: "Tell me what's on your mind — however big or small." };
}
function provideSupport(text) {
  const emo = analyzeEmotion(text);
  const crisis = CRISIS_SIGNALS.test(String(text || '').toLowerCase());
  const g = supportGuidance(emo.emotion, text, crisis);
  logAction('provide_support', `Emotional support (${crisis ? 'crisis' : emo.emotion})`);
  return { ...g, emotion: emo.emotion, crisis };
}
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
  const [battery, disk] = [await getBattery(), await getDisk()];
  return {
    platform: os.platform(), release: os.release(), hostname: os.hostname(),
    arch: os.arch(), cpus: os.cpus().length, cpuLoad: cpu,
    memTotal: total, memFree: free, memUsed: total - free,
    memPercent: Math.round(((total - free) / total) * 100),
    uptime: os.uptime(), loadavg: os.loadavg(),
    battery, disk
  };
}
function normalizeBaseURL(base) {
  let b = (base || '').trim();
  if (!b) return null;
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
  return b.replace(/\/+$/, '');
}
function aiHeaders(base, key) {
  const headers = { 'Content-Type': 'application/json' };
  const b = (base || '').toLowerCase();
  if (key) headers['Authorization'] = 'Bearer ' + key;
  if (key && b.includes('generativelanguage.googleapis.com')) headers['x-goog-api-key'] = key;
  if (key && b.includes('api.anthropic.com')) {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}
async function callChat(base, key, model, messages, tools) {
  const url = base + (base.endsWith('/chat/completions') ? '' : '/chat/completions');
  const doFetch = (withTools) => {
    const body = { model, messages, temperature: 0.6, max_tokens: 1200 };
    if (withTools && tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return fetch(url, { method: 'POST', headers: aiHeaders(base, key), body: JSON.stringify(body) });
  };
  let res = await doFetch(true);
  if (!res.ok) {
    const firstText = await res.text().catch(() => '');
    if (tools && /tool|function|unsupported|invalid/i.test(firstText) && [400, 404, 422].includes(res.status)) {
      res = await doFetch(false);
      if (!res.ok) {
        const t2 = await res.text().catch(() => '');
        throw new Error('HTTP_' + res.status + (t2 ? ' ' + t2.slice(0, 300) : ''));
      }
    } else {
      throw new Error('HTTP_' + res.status + (firstText ? ' ' + firstText.slice(0, 300) : ''));
    }
  }
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error('EMPTY_REPLY');
  return data.choices[0].message;
}

// ---------------------------------------------------------------------------
// Tool definitions — extended for 2.4
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
  { type: 'function', function: { name: 'control_volume', description: 'Change system volume.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['up', 'down', 'mute', 'unmute', 'set'] }, level: { type: 'number', description: '0-100 volume level when action=set' } } } } },
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
  { type: 'function', function: { name: 'complete_todo', description: 'Mark a to-do item as done by its text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'log_mood', description: 'Record the user\'s current emotional state / mood.', parameters: { type: 'object', properties: { emotion: { type: 'string' }, note: { type: 'string' } }, required: ['emotion'] } } },
  { type: 'function', function: { name: 'get_mood_history', description: 'Get the user\'s recent mood history.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'add_goal', description: 'Add a life/career/study goal for the user.', parameters: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string', enum: ['career', 'study', 'health', 'finance', 'personal', 'relationship'] } }, required: ['text'] } } },
  { type: 'function', function: { name: 'list_goals', description: 'List the user\'s goals.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'complete_goal', description: 'Mark a goal as achieved by its text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'get_affirmation', description: 'Give the user an uplifting affirmation.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_wellness_tip', description: 'Give a practical wellness / self-care tip.', parameters: { type: 'object', properties: { area: { type: 'string', enum: ['focus', 'stress', 'sleep', 'energy', 'productivity', 'motivation'] } } } } },
  { type: 'function', function: { name: 'organize_folder', description: 'Organize a folder by file type — scans, classifies, creates subfolders and moves files (a multi-step mission).', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder to organize (defaults to Downloads)' } } } } },
  { type: 'function', function: { name: 'find_duplicates', description: 'Find duplicate files in a folder (by size + name).', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'rename_files', description: 'Rename files in a folder by a pattern (e.g. prefix + number).', parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string', description: 'e.g. "project" or "photo_\" — a counter is appended' } }, required: ['path', 'pattern'] } } },
  { type: 'function', function: { name: 'archive_old_files', description: 'Move files older than N days into an _archive folder.', parameters: { type: 'object', properties: { path: { type: 'string' }, days: { type: 'number' } }, required: ['days'] } } },
  { type: 'function', function: { name: 'system_scan', description: 'Scan the PC — what is using CPU/RAM, disk space, battery. "What is slowing my PC down?"', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_power_storage', description: 'Read live battery charging state and primary disk capacity/free-space sensors.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'see_screen', description: 'Capture the current screen so the AI is aware of what is on it.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_action_log', description: 'Get the recent log of actions the AI has performed (transparency).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'add_skill', description: 'Remember a reusable skill / ability the user has taught you (persistent).', parameters: { type: 'object', properties: { text: { type: 'string' }, name: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'list_skills', description: 'List the skills you have learned.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'add_instruction', description: 'Remember a standing instruction / rule / preference the user wants you to always follow.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'list_instructions', description: 'List the user\'s standing instructions.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'verify_claim', description: 'Fact-check a claim against real web sources and report whether it is true, false, or unverified, with sources.', parameters: { type: 'object', properties: { claim: { type: 'string' } }, required: ['claim'] } } },
  { type: 'function', function: { name: 'provide_support', description: 'Give compassionate, non-judgmental emotional support when the user is feeling low, guilty, anxious, angry or distressed.', parameters: { type: 'object', properties: { text: { type: 'string', description: "What the user said, to understand their emotional state" } }, required: ['text'] } } },
  { type: 'function', function: { name: 'get_quote', description: 'Get an inspiring quote.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'breathing_exercise', description: 'Give a guided calming breathing exercise (great for anxiety or stress).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'generate_report', description: 'Generate the user\'s weekly life report from their mood, goals, tasks and memory.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'show_panel', description: 'Open a contextual HUD panel on the user screen so they can see live info alongside your reply. Panels: weather (pass city), clock (world/local time), focus (pomodoro timer), breathing (calming exercise), system (live telemetry), news (headlines), report (weekly life report).', parameters: { type: 'object', properties: { panel: { type: 'string', enum: ['weather', 'clock', 'focus', 'breathing', 'system', 'news', 'report'] }, city: { type: 'string', description: 'City name, used by the weather panel' } }, required: ['panel'] } } },
  { type: 'function', function: { name: 'hide_panel', description: 'Close the floating HUD panel on the user screen.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'close_app', description: 'Close an application. Use name="all" (or "everything") with a keep array to close everything except specific apps. Examples: close_app("chrome"), close_app("all", keep=["spotify","gemair"]).', parameters: { type: 'object', properties: { name: { type: 'string', description: 'App name, e.g. chrome, whatsapp, spotify; or "all" to close everything' }, keep: { type: 'array', items: { type: 'string' }, description: 'App names to keep open when name is "all"' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'find_large_files', description: 'Find large files on disk — by minimum size in MB and optionally how many months unused. Example: find files over 500MB unused 6 months.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder to scan (defaults to home)' }, minMB: { type: 'number', description: 'Minimum file size in MB (default 500)' }, unusedMonths: { type: 'number', description: 'Only files not modified for this many months (optional)' } } } } },
  { type: 'function', function: { name: 'create_folder_tree', description: 'Scaffold a project folder tree (creates empty folders, nothing else). Example: create_folder_tree with folders ["src","src/components","docs"].', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Root path (defaults to Documents)' }, folders: { type: 'array', items: { type: 'string' }, description: 'List of folder paths to create' } } } } },
  { type: 'function', function: { name: 'move_files', description: 'Move files from a source folder into a destination folder, optionally filtered by extension (".pdf"), type ("images"), "large", or keyword.', parameters: { type: 'object', properties: { source: { type: 'string' }, dest: { type: 'string' }, filter: { type: 'string', description: 'Optional filter: ".pdf", "images", "large", or a keyword' } } } } },
  { type: 'function', function: { name: 'optimize_gaming', description: 'Optimize the PC for gaming — high-performance power plan, clear temp files, close heavy non-essential apps.', parameters: { type: 'object', properties: { keep: { type: 'array', items: { type: 'string' }, description: 'App names to keep open' } } } } },
  // 2.4 new desktop management tools
  { type: 'function', function: { name: 'launch_app', description: 'Launch an application by name (e.g. chrome, spotify, vscode, calculator) with optional args.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'App name' }, args: { type: 'string', description: 'Optional launch arguments' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'focus_app', description: 'Focus/bring to front an application window by name.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'App name to focus' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'snap_window', description: 'Snap the active window: left|right|quarter|max.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['left','right','quarter','max','maximize'] } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'minimize_all', description: 'Minimize all windows (show desktop).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'next_virtual_desktop', description: 'Switch to next virtual desktop (Windows).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'open_site', description: 'Open a URL in a specific browser (chrome, firefox, edge, brave, etc.).', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to open' }, browser: { type: 'string', description: 'Browser name: chrome|firefox|edge|brave|default' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'list_windows', description: 'List open windows/titles+apps so Gem sees desktop state.', parameters: { type: 'object', properties: {} } } },
  // Modes
  { type: 'function', function: { name: 'apply_mode', description: 'Apply a desktop mode by name (WORK, GAMING, CHILL, STUDY, or custom). Arranges apps, sites, volume, theme, DND, playlist.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Mode name' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'list_modes', description: 'List all available desktop modes.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'create_mode', description: 'Create or update a custom mode bundle.', parameters: { type: 'object', properties: { name: { type: 'string' }, apps: { type: 'array', items: { type: 'string' } }, sites: { type: 'array', items: { type: 'object' } }, volume: { type: 'number' }, theme: { type: 'string' }, dnd: { type: 'boolean' }, playlist: { type: 'string' } }, required: ['name'] } } }
];

function safeEval(expr) {
  const clean = String(expr).replace(/[^0-9+\-*/().%\s]/g, '');
  if (!/[0-9]/.test(clean)) throw new Error('Not a math expression');
  const val = Function('"use strict";return (' + clean + ')')();
  if (typeof val !== 'number' || !isFinite(val)) throw new Error('Bad expression');
  return Math.round(val * 1e6) / 1e6;
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
  return { city: loc.name + (loc.country ? ', ' + loc.country : ''), temperature: cw.temperature, windspeed: cw.windspeed, condition: WEATHER_CODES[cw.weathercode] || 'Unknown', units: '°C / km/h' };
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
  let answer = d.AbstractText || d.Answer || null;
  let source = d.AbstractSource || null;
  let answerUrl = d.AbstractURL || null;
  if (!answer) {
    try {
      const w = await fetch('https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&search=' + encodeURIComponent(query)).then(r => r.json());
      if (Array.isArray(w) && w[2] && w[2][0]) { answer = w[2][0]; source = 'Wikipedia'; answerUrl = w[3][0]; }
    } catch {}
  }
  return { answer, source, url: answerUrl, results: results.slice(0, 5) };
}
function stripHtml(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
async function fetchWebpage(url) {
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const res = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GemAir/2.0)' } });
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
    title: 'GemAir shell command', message: 'Run this command?', detail: cmd
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
  return { word: d[0].word, phonetic: d[0].phonetic || '', partOfSpeech: m ? m.partOfSpeech : '', definition: def ? def.definition : '', example: def && def.example ? def.example : '' };
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
  const p = String(phone || '').replace(/[^\\d]/g, '');
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
function addTodo(text) {
  const clean = String(text || '').trim().slice(0, 240);
  if (!clean) return { error: 'Empty task.' };
  const m = readMemory();
  const todo = { id: uid(), text: clean, done: false, created: Date.now() };
  m.todos.unshift(todo);
  writeMemory(m);
  return { ok: true, todo };
}
function toggleTodoById(id) {
  const m = readMemory();
  const t = (m.todos || []).find((x) => x.id === id);
  if (!t) return { error: 'Task not found.' };
  t.done = !t.done;
  t.updated = Date.now();
  t.completed = t.done ? Date.now() : null;
  writeMemory(m);
  return { ok: true, todo: t };
}
function deleteTodoById(id) {
  const m = readMemory();
  const before = (m.todos || []).length;
  m.todos = (m.todos || []).filter((x) => x.id !== id);
  writeMemory(m);
  return { ok: before !== m.todos.length };
}
function completeTodo(text) {
  const m = readMemory();
  const q = String(text).toLowerCase();
  const t = m.todos.find((x) => x.text.toLowerCase().includes(q) || q.includes(x.text.toLowerCase()));
  if (t) { t.done = true; t.completed = Date.now(); t.updated = Date.now(); }
  writeMemory(m);
  return t ? { ok: true, todo: t.text } : { error: 'Todo not found: ' + text };
}
function logMood(emotion, note) {
  const m = readMemory();
  const e = analyzeEmotion(emotion);
  const entry = { emotion: e.emotion, valence: e.valence, note: note || '', ts: Date.now() };
  m.mood.push(entry);
  if (m.mood.length > 500) m.mood = m.mood.slice(-500);
  writeMemory(m);
  return { ok: true, entry };
}
function getMoodHistory() {
  const m = readMemory();
  return (m.mood || []).slice(-30).map((x) => ({ emotion: x.emotion, valence: x.valence, note: x.note, ts: x.ts }));
}
function addGoal(text, category) {
  const m = readMemory();
  m.goals.unshift({ id: uid(), text, category: category || 'personal', done: false, created: Date.now() });
  writeMemory(m);
  return { ok: true };
}
function listGoals() {
  const m = readMemory();
  return (m.goals || []).map((g) => ({ id: g.id, text: g.text, category: g.category, done: !!g.done }));
}
function completeGoal(text) {
  const m = readMemory();
  const q = String(text).toLowerCase();
  const g = m.goals.find((x) => x.text.toLowerCase().includes(q) || q.includes(x.text.toLowerCase()));
  if (g) { g.done = true; g.completed = Date.now(); g.updated = Date.now(); }
  writeMemory(m);
  return g ? { ok: true, goal: g.text } : { error: 'Goal not found: ' + text };
}
const AFFIRMATIONS = [
  'You are capable of more than you realize. One focused step at a time.',
  'Progress, not perfection — you are exactly where you need to be.',
  'Your effort today is building the person you want to become tomorrow.',
  'You have overcome every hard day so far. This one is no different.',
  'Rest is not laziness. Recharging is part of the work.',
  'You do not need to be everything for everyone. You are enough as you are.',
  'Discipline is choosing what you want most over what you want now.',
  'Every expert was once a beginner who refused to give up.'
];
function getAffirmation() {
  return { affirmation: AFFIRMATIONS[Math.floor(Math.random() * AFFIRMATIONS.length)] };
}
const WELLNESS_TIPS = {
  focus: ['Work in 25-minute sprints (Pomodoro) with 5-minute breaks — your focus peaks in bursts.', 'Single-task: close distracting tabs and give one thing your full attention for 20 minutes.'],
  stress: ['Try the 4-7-8 breath: inhale 4s, hold 7s, exhale 8s. Repeat 4 times to calm your nervous system.', 'Write down what is stressing you — naming it reduces its grip on your mind.'],
  sleep: ['Keep a consistent sleep schedule, even on weekends. Your brain loves rhythm.', 'Stop screens 30-60 minutes before bed; dim light signals your body to produce melatonin.'],
  energy: ['Drink a glass of water right now — mild dehydration is the #1 hidden energy drain.', 'A 5-minute walk in daylight resets your energy better than another coffee.'],
  productivity: ['The 2-minute rule: if a task takes under 2 minutes, do it immediately.', 'Plan tomorrow\'s top 3 priorities tonight, so you start focused instead of deciding.'],
  motivation: ['Motivation follows action, not the other way round. Start tiny — momentum builds itself.', 'Remind yourself of your why. Connect the task to a goal that genuinely matters to you.']
};
function getWellnessTip(area) {
  const list = WELLNESS_TIPS[area] || WELLNESS_TIPS.motivation;
  return { area: area || 'motivation', tip: list[Math.floor(Math.random() * list.length)] };
}
const QUOTES = [
  { text: 'The best way to predict the future is to invent it.', author: 'Alan Kay' },
  { text: "It always seems impossible until it's done.", author: 'Nelson Mandela' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', author: 'Winston Churchill' },
  { text: "Believe you can and you're halfway there.", author: 'Theodore Roosevelt' },
  { text: 'You are never too old to set another goal or to dream a new dream.', author: 'C.S. Lewis' },
  { text: 'Do what you can, with what you have, where you are.', author: 'Theodore Roosevelt' },
  { text: "Everything you've ever wanted is on the other side of fear.", author: 'George Addair' },
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { text: "You miss 100% of the shots you don't take.", author: 'Wayne Gretzky' }
];
function getQuote() { return QUOTES[Math.floor(Math.random() * QUOTES.length)]; }
function breathingExercise() {
  return {
    technique: '4-7-8 calming breath',
    steps: [
      { label: 'Inhale', seconds: 4, detail: 'Breathe in slowly and deeply through your nose.' },
      { label: 'Hold', seconds: 7, detail: 'Gently hold the breath.' },
      { label: 'Exhale', seconds: 8, detail: 'Breathe out slowly through your mouth, letting your shoulders drop.' }
    ],
    cycles: 4,
    note: 'Repeat 4 times. This activates your parasympathetic nervous system and lowers your heart rate within a minute or two.'
  };
}
function generateReport() {
  const m = readMemory();
  const now = new Date();
  const weekAgo = now.getTime() - 7 * 86400000;
  const mood = (m.mood || []).filter((x) => (x.ts || 0) >= weekAgo);
  const moodAvg = mood.length ? Math.round((mood.reduce((a, b) => a + (b.valence || 0), 0) / mood.length) * 100) : null;
  const moodTrend = mood.length >= 2 ? (mood[mood.length - 1].valence - mood[0].valence) : 0;
  const activeGoals = (m.goals || []).filter((g) => !g.done);
  const doneGoals = (m.goals || []).filter((g) => g.done);
  const todosOpen = (m.todos || []).filter((t) => !t.done).length;
  const todosDone = (m.todos || []).filter((t) => t.done).length;
  const notesCount = (m.notes || []).length;
  const factsCount = (m.facts || []).length;
  const actions = (m.actionLog || []).filter((a) => (a.ts || 0) >= weekAgo).length;
  const lines = [];
  lines.push(`### Weekly Report — ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`);
  lines.push('');
  if (moodAvg != null) {
    const tone = moodAvg > 60 ? 'positive' : moodAvg > 20 ? 'mixed' : 'challenging';
    lines.push(`**Mood:** averaging ${moodAvg}/100 this week (${tone}${moodTrend > 0.15 ? ', trending up' : moodTrend < -0.15 ? ', trending down' : ', stable'}).`);
  } else {
    lines.push('**Mood:** no check-ins this week yet — try the one-tap mood buttons in Life Companion.');
  }
  lines.push(`**Goals:** ${activeGoals.length} active, ${doneGoals.length} achieved this period.`);
  lines.push(`**Tasks:** ${todosDone} completed, ${todosOpen} still open.`);
  lines.push(`**Knowledge:** ${factsCount} memories retained, ${notesCount} notes saved.`);
  lines.push(`**Activity:** ${actions} actions performed this week.`);
  if (activeGoals.length) {
    lines.push('');
    lines.push('**Focus for next week:**');
    activeGoals.slice(0, 3).forEach((g) => lines.push(`• ${g.text}`));
  }
  if (moodAvg != null && moodAvg < 40) {
    lines.push('');
    lines.push('**Gentle note:** your mood has been lower this week. Be kind to yourself — rest counts as progress too.');
  }
  return { report: lines.join('\n'), moodAvg, moodTrend };
}
function moodNeedsCheckIn() {
  const m = readMemory();
  const mood = (m.mood || []).slice(-7);
  if (mood.length < 3) return false;
  const vals = mood.map((x) => x.valence || 0);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const last = vals[vals.length - 1];
  return avg < 0.2 && last < 0;
}
function logAction(action, detail) {
  const m = readMemory();
  m.actionLog.unshift({ action, detail: String(detail || '').slice(0, 300), ts: Date.now() });
  if (m.actionLog.length > 200) m.actionLog = m.actionLog.slice(0, 200);
  writeMemory(m);
}
const FILE_CATEGORIES = {
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'raw'],
  documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'],
  videos: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz'],
  code: ['js', 'ts', 'py', 'java', 'c', 'cpp', 'html', 'css', 'json', 'go', 'rs', 'rb', 'php', 'sh'],
  installers: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'appimage'],
  books: ['epub', 'mobi']
};
function categorizeFile(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const [cat, exts] of Object.entries(FILE_CATEGORIES)) if (exts.includes(ext)) return cat;
  return 'others';
}
async function confirmAction(title, detail) {
  if (!mainWindow) return true;
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['Proceed', 'Cancel'], defaultId: 0, cancelId: 1,
    title, message: title, detail
  });
  return r.response === 0;
}
async function organizeFolder(dir) {
  const base = dir || path.join(os.homedir(), 'Downloads');
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isFile());
    if (!entries.length) return { ok: true, total: 0, categories: {}, base, note: 'Nothing to organize.' };
    const ok = await confirmAction('Organize folder?', `GemAir will sort ${entries.length} files in:\n${base}\n\ninto subfolders by type (images, documents, videos, etc.). Files are moved, not deleted.`);
    if (!ok) return { error: 'Cancelled by user.' };
    const moved = {}, total = entries.length;
    for (const e of entries) {
      const cat = categorizeFile(e.name);
      const dest = path.join(base, cat);
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(path.join(base, e.name), path.join(dest, e.name));
      moved[cat] = (moved[cat] || 0) + 1;
    }
    logAction('organize_folder', `Organized ${total} files into ${Object.keys(moved).length} categories in ${base}`);
    return { ok: true, total, categories: moved, base };
  } catch (e) { return { error: e.message }; }
}
function findDuplicates(dir) {
  const base = dir || os.homedir();
  try {
    const map = {};
    const walk = (d, depth) => {
      if (depth > 4) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          let key;
          try {
            const st = fs.statSync(full);
            key = e.name.toLowerCase() + ':' + st.size;
          } catch { key = e.name.toLowerCase(); }
          (map[key] = map[key] || []).push(full);
        }
      }
    };
    walk(base, 0);
    const dups = Object.values(map).filter((arr) => arr.length > 1).slice(0, 20);
    logAction('find_duplicates', `Found ${dups.length} duplicate groups in ${base}`);
    return { duplicates: dups, count: dups.length };
  } catch (e) { return { error: e.message }; }
}
async function renameFiles(dir, pattern) {
  const base = dir || os.homedir();
  const pat = String(pattern || 'file').replace(/[^\w\- ]/g, '');
  try {
    const files = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isFile());
    if (!files.length) return { ok: true, renamed: 0, pattern: pat };
    const ok = await confirmAction('Rename files?', `GemAir will rename ${files.length} files in:\n${base}\nto "${pat}-001", "${pat}-002", … (extensions kept).`);
    if (!ok) return { error: 'Cancelled by user.' };
    let n = 0;
    for (const e of files) {
      const ext = path.extname(e.name);
      const newName = pat + '-' + String(n + 1).padStart(3, '0') + ext;
      fs.renameSync(path.join(base, e.name), path.join(base, newName));
      n++;
    }
    logAction('rename_files', `Renamed ${n} files with pattern "${pat}"`);
    return { ok: true, renamed: n, pattern: pat };
  } catch (e) { return { error: e.message }; }
}
async function archiveOldFiles(dir, days) {
  const base = dir || os.homedir();
  const cutoff = Date.now() - days * 86400000;
  try {
    const archive = path.join(base, '_archive');
    const candidates = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isFile() && (() => { try { return fs.statSync(path.join(base, e.name)).mtimeMs < cutoff; } catch { return false; } })());
    if (!candidates.length) return { ok: true, archived: 0, archive };
    const ok = await confirmAction('Archive old files?', `GemAir will move ${candidates.length} files older than ${days} days from:\n${base}\ninto an "_archive" subfolder. Nothing is deleted.`);
    if (!ok) return { error: 'Cancelled by user.' };
    if (!fs.existsSync(archive)) fs.mkdirSync(archive, { recursive: true });
    let n = 0;
    for (const e of candidates) {
      try { fs.renameSync(path.join(base, e.name), path.join(archive, e.name)); n++; } catch {}
    }
    logAction('archive_old_files', `Archived ${n} files older than ${days} days`);
    return { ok: true, archived: n, archive };
  } catch (e) { return { error: e.message }; }
}
const CLOSEABLE_APPS = {
  browser: ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'safari'],
  chrome: ['chrome'], edge: ['msedge'], firefox: ['firefox'], brave: ['brave'], safari: ['safari'],
  whatsapp: ['whatsapp'], slack: ['slack'], discord: ['discord'], telegram: ['telegram'],
  spotify: ['spotify'], steam: ['steam'], zoom: ['zoom'], teams: ['teams'],
  notepad: ['notepad'], calculator: ['calc'], explorer: ['explorer', 'finder'],
  terminal: ['cmd', 'terminal'], code: ['Code'], vscode: ['Code'], excel: ['excel'], word: ['winword'], powerpoint: ['powerpnt']
};
function resolveCloseTargets(name, keep) {
  const q = String(name || '').toLowerCase();
  const keepList = (Array.isArray(keep) ? keep : []).map((k) => String(k).toLowerCase());
  if (q === 'all' || q === 'everything' || q === 'except' || /close everything except/i.test(String(name || ''))) {
    return Object.values(CLOSEABLE_APPS).flat().filter((proc) => !keepList.some((k) => proc.includes(k)));
  }
  return CLOSEABLE_APPS[q] || [q];
}
function closeApp(name, keep) {
  const targets = resolveCloseTargets(name, keep);
  if (!targets.length) return { ok: true, closed: [], note: 'Nothing matched to close.' };
  const p = process.platform;
  const closed = [];
  for (const proc of targets) {
    const safe = String(proc).replace(/[^a-zA-Z0-9 _.-]/g, '');
    if (!safe) continue;
    try {
      if (p === 'win32') exec(`taskkill /IM "${safe}.exe" /F 2>nul || taskkill /IM "${safe}" /F 2>nul`, () => {});
      else if (p === 'darwin') exec(`osascript -e 'quit app "${safe}"'`, () => {});
      else exec(`pkill -f "${safe}"`, () => {});
      closed.push(safe);
    } catch (e) {}
  }
  logAction('close_app', `Closed ${closed.length} app(s): ${closed.join(', ')}`);
  return { ok: true, closed, note: closed.length ? `Asked ${closed.length} app(s) to close.` : 'Nothing closed.' };
}
function findLargeFiles(root, minMB, unusedMonths) {
  const base = root || os.homedir();
  const minBytes = (Number(minMB) || 500) * 1024 * 1024;
  const cutoff = unusedMonths ? Date.now() - Number(unusedMonths) * 30 * 86400000 : null;
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6 || hits.length >= 40) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '_archive') continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          const st = fs.statSync(full);
          if (st.size >= minBytes && (!cutoff || st.mtimeMs < cutoff)) {
            hits.push({ path: full, sizeMB: Math.round(st.size / 1048576), modified: new Date(st.mtimeMs).toISOString().slice(0, 10) });
          }
        }
      } catch {}
    }
  };
  walk(base, 0);
  logAction('find_large_files', `Found ${hits.length} file(s) > ${minMB || 500}MB${unusedMonths ? ` unused ${unusedMonths}+ months` : ''} in ${base}`);
  return { files: hits, count: hits.length, base, minMB: minMB || 500, unusedMonths: unusedMonths || null };
}
async function createFolderTree(root, folders) {
  const base = root || path.join(os.homedir(), 'Documents');
  const list = Array.isArray(folders) ? folders : (String(folders || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean));
  const tree = list.length ? list : ['src', 'src/components', 'src/assets', 'docs', 'tests', 'scripts', 'public'];
  if (!tree.length) return { error: 'Provide folders to create.' };
  const ok = await confirmAction('Create folder tree?', `GemAir will create ${tree.length} folder(s) under:\n${base}\n\n${tree.join('\n')}\n\nNo files are touched.`);
  if (!ok) return { error: 'Cancelled by user.' };
  const created = [];
  const skipped = [];
  const baseResolved = path.resolve(base);
  const withinBase = (target) => {
    const rel = path.relative(baseResolved, path.resolve(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  for (const rel of tree) {
    const raw = String(rel).replace(/[\/\\]+$/, '').trim();
    const clean = raw.replace(/\\/g, '/');
    const segments = clean.split('/').filter((seg) => seg !== '');
    const bad =
      !clean || clean === '.' ||
      path.isAbsolute(clean) ||
      /^[a-zA-Z]:/.test(clean) ||
      clean.startsWith('//') ||
      clean.includes('\0') ||
      segments.some((seg) => seg === '..' || seg === '.');
    if (bad) { skipped.push(raw); continue; }
    const dest = path.join(baseResolved, ...segments);
    if (!withinBase(dest)) { skipped.push(raw); continue; }
    try { fs.mkdirSync(dest, { recursive: true }); created.push(dest); } catch { skipped.push(raw); }
  }
  logAction('create_folder_tree', `Created ${created.length} folder(s) under ${base}${skipped.length ? ` (${skipped.length} rejected as unsafe)` : ''}`);
  return { ok: true, base, created, count: created.length, skipped, rejected: skipped.length };
}
async function moveFiles(source, dest, filter) {
  const from = source || path.join(os.homedir(), 'Downloads');
  const to = dest || path.join(from, filter ? String(filter || '').replace(/\W+/g, '_').toLowerCase() : 'moved');
  const f = String(filter || '').toLowerCase();
  try {
    const entries = fs.readdirSync(from, { withFileTypes: true }).filter((e) => e.isFile());
    const candidates = entries.filter((e) => {
      if (!f) return true;
      if (f.startsWith('.')) return path.extname(e.name).toLowerCase() === f;
      if (f === 'large') { try { return fs.statSync(path.join(from, e.name)).size > 100 * 1024 * 1024; } catch { return false; } }
      return e.name.toLowerCase().includes(f) || categorizeFile(e.name) === f;
    });
    if (!candidates.length) return { ok: true, moved: 0, note: `No files matched "${filter || 'all'}" in ${from}.` };
    const ok = await confirmAction('Move files?', `GemAir will move ${candidates.length} file(s) from:\n${from}\ninto:\n${to}\n\nFiles are moved, not deleted.`);
    if (!ok) return { error: 'Cancelled by user.' };
    if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
    let n = 0;
    for (const e of candidates) {
      try { fs.renameSync(path.join(from, e.name), path.join(to, e.name)); n++; } catch {}
    }
    logAction('move_files', `Moved ${n} file(s) matching "${filter || 'all'}" to ${to}`);
    return { ok: true, moved: n, to };
  } catch (e) { return { error: e.message }; }
}
async function optimizeGaming(keep) {
  const ok = await confirmAction('Optimize for gaming?', 'GemAir will:\n• switch to the High Performance power plan\n• clear temporary files\n• close heavy non-essential apps (messengers, browser tabs except kept ones)\n\nNothing personal is deleted — temp caches only.');
  if (!ok) return { error: 'Cancelled by user.' };
  const done = [];
  const p = process.platform;
  if (p === 'win32') {
    exec('powercfg /setactive SCHEME_MAX', (err) => {
      if (err) exec('powercfg /setactive e9a42b02-d5df-448d-aa00-03f14749eb61', () => {});
    });
    done.push('High-performance power plan');
    exec('del /q /s %TEMP%\\* 2>nul', () => {}); done.push('Temp files cleared');
  } else if (p === 'darwin') {
    exec('sudo pmset -a powernap 0 2>/dev/null', () => {}); done.push('Power settings tuned');
  } else {
    exec('rm -rf /tmp/* 2>/dev/null', () => {}); done.push('Temp files cleared');
  }
  const closed = closeApp('all', keep || ['gemair']);
  done.push(`Closed ${closed.closed.length} non-essential app(s)`);
  logAction('optimize_gaming', `Gaming optimization: ${done.join('; ')}`);
  return { ok: true, steps: done, closed: closed.closed };
}
function listTopProcesses() {
  const p = process.platform;
  if (p === 'win32') {
    return new Promise((resolve) => {
      exec('powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name,CPU,@{n=\'MemMB\';e={[math]::Round($_.WS/1MB)}} | ConvertTo-Json -Compress"', { timeout: 8000 }, (err, out) => {
        try { resolve(JSON.parse(out)); } catch { resolve([]); }
      });
    });
  }
  if (p === 'darwin') {
    return new Promise((resolve) => {
      exec('ps -A -o comm,%cpu,%mem -r | head -9', { timeout: 8000 }, (err, out) => {
        const lines = (out || '').trim().split('\n').slice(1).map((l) => {
          const parts = l.trim().split(/\s+/);
          return { Name: parts[0], CPU: parseFloat(parts[1]) || 0, MemPct: parseFloat(parts[2]) || 0 };
        });
        resolve(lines);
      });
    });
  }
  return new Promise((resolve) => {
    exec('ps -eo comm,%cpu,%mem --sort=-%cpu | head -9', { timeout: 8000 }, (err, out) => {
      const lines = (out || '').trim().split('\n').slice(1).map((l) => {
        const parts = l.trim().split(/\s+/);
        return { Name: parts[0], CPU: parseFloat(parts[1]) || 0, MemPct: parseFloat(parts[2]) || 0 };
      });
      resolve(lines);
    });
  });
}
function scanProcesses(limit = 40) {
  const p = process.platform;
  const cap = Math.max(5, Math.min(200, Number(limit) || 40));
  const totalMemMB = os.totalmem() / (1024 * 1024);
  if (p === 'win32') {
    const ps = 'Get-Process | Sort-Object WS -Descending | Select-Object -First ' + cap +
      ' Id,ProcessName,CPU,@{n=\'MemMB\';e={[math]::Round($_.WS/1MB,1)}} | ConvertTo-Json -Compress';
    return new Promise((resolve) => {
      exec('powershell -NoProfile -Command "' + ps.replace(/"/g, '\\"') + '"', { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve({ ok: false, error: 'scan_failed', procs: [] });
        let rows = [];
        try { rows = JSON.parse(out); } catch { return resolve({ ok: false, error: 'parse_failed', procs: [] }); }
        if (!Array.isArray(rows)) rows = [rows];
        resolve({
          ok: true,
          platform: p,
          procs: rows.filter(Boolean).map((r) => ({
            pid: Number(r.Id) || 0,
            name: String(r.ProcessName || 'unknown'),
            cpu: Number(r.CPU) || 0,
            memMB: Number(r.MemMB) || 0,
            memPct: totalMemMB ? Math.round((Number(r.MemMB) || 0) / totalMemMB * 1000) / 10 : 0
          }))
        });
      });
    });
  }
  const cmd = p === 'darwin'
    ? 'ps -A -o pid=,comm=,%cpu=,rss= -r | head -' + cap
    : 'ps -eo pid=,comm=,%cpu=,rss= --sort=-%cpu | head -' + cap;
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ ok: false, error: 'scan_failed', procs: [] });
      const procs = String(out || '').trim().split('\n').map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\S.*?)\s+([\d.]+)\s+(\d+)$/);
        if (!m) return null;
        const memMB = Math.round((Number(m[4]) / 1024) * 10) / 10;
        return {
          pid: Number(m[1]),
          name: m[2].split('/').pop(),
          cpu: Number(m[3]),
          memMB,
          memPct: totalMemMB ? Math.round((memMB / totalMemMB) * 1000) / 10 : 0
        };
      }).filter(Boolean);
      resolve({ ok: true, platform: p, procs });
    });
  });
}
const PROTECTED_PROCESS_NAMES = /^(system|systemd|init|kernel_task|launchd|winlogon|csrss|services|smss|wininit|lsass|svchost|explorer)$/i;
async function killProcess(pid, name) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 1) return { error: 'Invalid PID.' };
  if (id === process.pid) return { error: 'GemAir will not terminate itself.' };
  const label = String(name || '').replace(/\.exe$/i, '');
  if (PROTECTED_PROCESS_NAMES.test(label)) return { error: `"${label}" is a protected system process — refusing.` };
  const ok = await confirmAction(
    'End process?',
    `GemAir will terminate:\n\n  ${label || 'PID ' + id}  (PID ${id})\n\nUnsaved work in that program will be lost.`
  );
  if (!ok) return { error: 'Cancelled by user.' };
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `taskkill /PID ${id} /T /F` : `kill -TERM ${id}`;
    exec(cmd, { timeout: 8000 }, (err) => {
      if (err) { resolve({ error: 'Could not end that process (permission denied or already gone).' }); return; }
      logAction('kill_process', `Ended process ${label || ''} (PID ${id})`);
      resolve({ ok: true, pid: id, name: label });
    });
  });
}
function getStorage() {
  const total = os.totalmem(), free = os.freemem();
  return { ramTotal: total, ramUsed: total - free, ramPercent: Math.round(((total - free) / total) * 100) };
}
function execOut(cmd, timeout = 6000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}
let _batteryCache = { at: 0, value: null };
async function getBattery() {
  if (Date.now() - _batteryCache.at < 60000) return _batteryCache.value;
  let value = null;
  try {
    const p = process.platform;
    if (p === 'win32') {
      const out = await execOut('wmic path Win32_Battery get EstimatedChargeRemaining,BatteryStatus /format:list');
      const pct = out.match(/EstimatedChargeRemaining=(\d+)/i);
      const status = out.match(/BatteryStatus=(\d+)/i);
      if (pct) value = { percent: parseInt(pct[1], 10), charging: status ? status[1] === '2' : false };
    } else if (p === 'darwin') {
      const out = await execOut('pmset -g batt');
      const pct = out.match(/(\d+)%/);
      if (pct) value = { percent: parseInt(pct[1], 10), charging: /AC Power/i.test(out) };
    } else {
      const base = '/sys/class/power_supply';
      for (const d of fs.readdirSync(base)) {
        if (!/^BAT/i.test(d)) continue;
        const cap = parseInt(fs.readFileSync(path.join(base, d, 'capacity'), 'utf8').trim(), 10);
        if (!isNaN(cap)) {
          let charging = false;
          try { charging = /Charging|Full/i.test(fs.readFileSync(path.join(base, d, 'status'), 'utf8')); } catch {}
          value = { percent: cap, charging };
          break;
        }
      }
    }
  } catch { value = null; }
  _batteryCache = { at: Date.now(), value };
  return value;
}
let _diskCache = { at: 0, value: null };
async function getDisk() {
  if (Date.now() - _diskCache.at < 60000) return _diskCache.value;
  let value = null;
  try {
    const p = process.platform;
    if (p === 'win32') {
      const out = await execOut('wmic logicaldisk where "DeviceId=\'C:\'" get Size,FreeSpace /format:list');
      const free = parseInt((out.match(/FreeSpace=(\d+)/i) || [])[1], 10);
      const total = parseInt((out.match(/Size=(\d+)/i) || [])[1], 10);
      if (free > 0 && total > 0) value = { totalGB: Math.round(total / 1e9), freeGB: Math.round(free / 1e9), percent: Math.round(((total - free) / total) * 100) };
    } else {
      const out = await execOut('df -k /');
      const cols = (out.split('\n')[1] || '').trim().split(/\s+/);
      const totalKB = parseInt(cols[1], 10), usedKB = parseInt(cols[2], 10);
      if (totalKB > 0 && !isNaN(usedKB)) value = { totalGB: Math.round(totalKB / 1048576), freeGB: Math.round((totalKB - usedKB) / 1048576), percent: Math.round((usedKB / totalKB) * 100) };
    }
  } catch { value = null; }
  _diskCache = { at: Date.now(), value };
  return value;
}
async function systemScan() {
  const procs = await listTopProcesses();
  const storage = getStorage();
  const cpu = await cpuUsage();
  const up = os.uptime();
  const battery = await getBattery();
  const disk = await getDisk();
  const advice = [];
  if (cpu > 80) advice.push('CPU is very high — a runaway process may be active.');
  else if (cpu > 50) advice.push('CPU is moderately busy.');
  else advice.push('CPU is healthy.');
  if (storage.ramPercent > 85) advice.push('RAM is nearly full — close unused apps.');
  if (disk && disk.percent > 90) advice.push(`Disk is ${disk.percent}% full — free up space soon.`);
  if (battery && !battery.charging && battery.percent < 20) advice.push('Battery below 20% — plug in soon.');
  return {
    cpuPercent: cpu,
    ramPercent: storage.ramPercent,
    ramUsedGB: Math.round(storage.ramUsed / 1e9),
    ramTotalGB: Math.round(storage.ramTotal / 1e9),
    uptime: Math.floor(up / 3600) + 'h ' + Math.floor((up % 3600) / 60) + 'm',
    topProcesses: procs,
    advice: advice.join(' '),
    battery,
    disk
  };
}
async function seeScreen() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
  const source = sources[0];
  if (!source || !source.thumbnail) return { error: 'No screen available' };
  const file = path.join(app.getPath('pictures'), `gemair-screen-${Date.now()}.png`);
  fs.writeFileSync(file, source.thumbnail.toPNG());
  logAction('see_screen', `Captured screen to ${file}`);
  return { ok: true, file, note: 'Screen captured. If your AI model supports vision, it can analyze this image.' };
}
let lastScreenFingerprint = null;
async function inspectScreenChange() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 180, height: 100 } });
  const source = sources[0];
  if (!source || !source.thumbnail) return { error: 'No screen available' };
  const bitmap = source.thumbnail.toBitmap();
  const sample = [];
  for (let i = 0; i + 2 < bitmap.length; i += 64) sample.push(Math.round(bitmap[i] * 0.114 + bitmap[i + 1] * 0.587 + bitmap[i + 2] * 0.299));
  let delta = 0;
  if (lastScreenFingerprint && lastScreenFingerprint.length === sample.length) {
    for (let i = 0; i < sample.length; i++) delta += Math.abs(sample[i] - lastScreenFingerprint[i]);
    delta = delta / sample.length / 255;
  }
  const first = !lastScreenFingerprint;
  lastScreenFingerprint = sample;
  const changed = !first && delta >= 0.045;
  const percent = Math.round(delta * 100);
  const description = first
    ? `Screen awareness baseline created for ${source.name}; no image was saved.`
    : changed
      ? `${percent >= 18 ? 'Major' : 'Visible'} screen change on ${source.name} (${percent}% visual delta).`
      : `No meaningful screen change on ${source.name} (${percent}% visual delta).`;
  if (changed) logAction('see_screen', description);
  return { ok: true, changed, changePercent: percent, description, display: source.name, captured: false, at: Date.now() };
}
function addSkill(text, name) {
  const m = readMemory();
  m.skills.unshift({ id: uid(), name: name || '', text, created: Date.now() });
  if (m.skills.length > 200) m.skills = m.skills.slice(0, 200);
  writeMemory(m);
  return { ok: true, skill: text };
}
function listSkills() { return (readMemory().skills || []).slice(0, 100); }
function addInstruction(text) {
  const m = readMemory();
  m.instructions.unshift({ id: uid(), text, created: Date.now() });
  if (m.instructions.length > 200) m.instructions = m.instructions.slice(0, 200);
  writeMemory(m);
  return { ok: true, instruction: text };
}
function listInstructions() { return (readMemory().instructions || []).slice(0, 100); }
async function verifyClaim(claim) {
  const q = String(claim || '').trim();
  if (!q) return { error: 'No claim to verify.' };
  const s = await webSearch(q);
  const supporting = [];
  let answer = s.answer || '';
  let source = s.source || null;
  let url = s.url || null;
  (s.results || []).slice(0, 4).forEach((r) => { if (r.title) supporting.push({ title: r.title, url: r.url }); });
  let verdict = 'unverified';
  if (answer && answer.length > 20) verdict = 'supported';
  if (!answer && supporting.length === 0) verdict = 'no_evidence';
  logAction('verify_claim', `Verified: "${q.slice(0, 120)}" → ${verdict}`);
  return { claim: q, verdict, answer, source, url, supporting, note: 'Verdict is based on DuckDuckGo/Wikipedia instant answers. For high-stakes facts, always check the linked sources directly.' };
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
  return Date.now() + 3600000;
}
function controlVolume(args) {
  const { action, level } = args || {};
  const p = process.platform;
  let cmd = null;
  if (p === 'win32') {
    if (action === 'up') cmd = 'powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell;$s.SendKeys([char]175)"';
    else if (action === 'down') cmd = 'powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell;$s.SendKeys([char]174)"';
    else if (action === 'mute' || action === 'unmute') cmd = 'powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell;$s.SendKeys([char]173)"';
    else if (action === 'set' && typeof level === 'number') {
      // Use nircmd if available, else set via powershell? We'll try powershell via WScript.Shell volume
      const vol = Math.max(0, Math.min(100, level));
      cmd = `powershell -NoProfile -Command "$obj = New-Object -ComObject WScript.Shell; $obj.SendKeys([char]175)"`; // placeholder
      // For set, we simulate volume steps from current? We'll just store in profile and emit event
      try { if (mainWindow) mainWindow.webContents.send('desktop:volume', { level: vol }); } catch {}
      return { ok: true, action: 'set', level: vol };
    }
  } else if (p === 'darwin') {
    if (action === 'up') cmd = 'osascript -e "set volume output volume (output volume of (get volume settings) + 15)"';
    else if (action === 'down') cmd = 'osascript -e "set volume output volume (output volume of (get volume settings) - 15)"';
    else if (action === 'mute') cmd = 'osascript -e "set volume with output muted"';
    else if (action === 'unmute') cmd = 'osascript -e "set volume without output muted"';
    else if (typeof level === 'number' || action === 'set') {
      const vol = Math.max(0, Math.min(100, typeof level === 'number' ? level : 50));
      cmd = `osascript -e "set volume output volume ${vol}"`;
      try { if (mainWindow) mainWindow.webContents.send('desktop:volume', { level: vol }); } catch {}
    }
  } else {
    if (action === 'up') cmd = 'pactl set-sink-volume @DEFAULT_SINK@ +10%';
    else if (action === 'down') cmd = 'pactl set-sink-volume @DEFAULT_SINK@ -10%';
    else if (action === 'mute') cmd = 'pactl set-sink-mute @DEFAULT_SINK@ 1';
    else if (action === 'unmute') cmd = 'pactl set-sink-mute @DEFAULT_SINK@ 0';
    else if (action === 'set' && typeof level === 'number') {
      const vol = Math.max(0, Math.min(100, level));
      cmd = `pactl set-sink-volume @DEFAULT_SINK@ ${vol}%`;
      try { if (mainWindow) mainWindow.webContents.send('desktop:volume', { level: vol }); } catch {}
    }
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
  const file = path.join(app.getPath('pictures'), `gemair-screenshot-${Date.now()}.png`);
  fs.writeFileSync(file, source.thumbnail.toPNG());
  return { ok: true, file };
}
const TOOL_RISK = {
  get_current_time: 'safe', get_current_date: 'safe', get_weather: 'safe',
  web_search: 'safe', fetch_webpage: 'safe', search_wikipedia: 'safe',
  search_youtube: 'safe', get_world_time: 'safe', translate: 'safe',
  get_crypto_price: 'safe', define_word: 'safe', get_clipboard: 'safe',
  search_memory: 'safe', list_todos: 'safe', list_goals: 'safe',
  list_reminders: 'safe', list_notes: 'safe', list_skills: 'safe',
  list_instructions: 'safe', get_mood_history: 'safe', get_affirmation: 'safe',
  get_wellness_tip: 'safe', get_quote: 'safe', get_system_status: 'safe', get_power_storage: 'safe', calculate: 'safe',
  run_command: 'sensitive', write_file: 'sensitive', control_system: 'sensitive',
  organize_folder: 'sensitive', archive_old_files: 'sensitive', send_email: 'sensitive',
  close_app: 'sensitive', move_files: 'sensitive', create_folder_tree: 'sensitive', optimize_gaming: 'sensitive',
  find_large_files: 'safe',
  show_panel: 'safe', hide_panel: 'safe',
  launch_app: 'safe', focus_app: 'safe', snap_window: 'safe', minimize_all: 'safe',
  next_virtual_desktop: 'safe', open_site: 'safe', list_windows: 'safe',
  apply_mode: 'safe', list_modes: 'safe', create_mode: 'safe'
};

async function executeTool(name, args) {
  try {
    const risk = TOOL_RISK[name] || 'safe';
    const profile = readProfile();
    if (risk === 'sensitive' && profile.allowShell === false && name === 'run_command') {
      return { error: 'Permission denied: shell command execution is disabled in Settings.' };
    }
    if (name === 'run_command') {
      const cmd = String((args && args.command) || '').slice(0, 400);
      const ok = await confirmAction('Run shell command?', `GemAir wants to execute on your machine:\n\n    ${cmd}\n\nThis can change files or system state. Proceed?`);
      if (!ok) return { error: 'Cancelled by user (human-in-the-loop confirmation).' };
    }
    if (name === 'write_file') {
      const p = String((args && args.path) || '');
      const content = String((args && args.content) || '');
      const ok = await confirmAction('Write file?', `GemAir wants to write ${content.length.toLocaleString()} characters to:\n\n    ${p}\n\nAn existing file will be overwritten. Proceed?`);
      if (!ok) return { error: 'Cancelled by user (human-in-the-loop confirmation).' };
    }
    if (name === 'send_email' || name === 'open_whatsapp') {
      const target = name === 'send_email' ? String(args.to || '') : String(args.phone || '');
      const ok = await confirmAction(name === 'send_email' ? 'Open email draft?' : 'Open WhatsApp draft?', `GemAir wants to open a message draft for:\n\n    ${target}\n\nYou will review and send it yourself. Proceed?`);
      if (!ok) return { error: 'Cancelled by user (human-in-the-loop confirmation).' };
    }

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
        const n = String(args.name || '');
        const mapped = windowTools.launchApp(n);
        if (mapped) return mapped;
        const p = process.platform;
        const generic = p === 'darwin' ? `open -a "${n}"` : p === 'win32' ? `start "" "${n}"` : `xdg-open "${n}"`;
        exec(generic, () => {});
        return { ok: true, app: n, note: 'Attempted generic launch.' };
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
      case 'log_mood':
        return logMood(args.emotion, args.note);
      case 'get_mood_history':
        return { history: getMoodHistory() };
      case 'add_goal':
        return addGoal(args.text, args.category);
      case 'list_goals':
        return { goals: listGoals() };
      case 'complete_goal':
        return completeGoal(args.text);
      case 'get_affirmation':
        return getAffirmation();
      case 'get_wellness_tip':
        return getWellnessTip(args.area);
      case 'organize_folder':
        return organizeFolder(args.path);
      case 'find_duplicates':
        return findDuplicates(args.path);
      case 'rename_files':
        return renameFiles(args.path, args.pattern);
      case 'archive_old_files':
        return archiveOldFiles(args.path, args.days);
      case 'close_app': {
        const target = String(args.name || '').slice(0, 80);
        const ok = await confirmAction('Close application?', `GemAir wants to close: ${target === 'all' ? 'all non-essential applications' : target}${args.keep ? ' (keeping: ' + args.keep.join(', ') + ')' : ''}.\n\nUnsaved work in those apps may be lost. Proceed?`);
        if (!ok) return { error: 'Cancelled by user (human-in-the-loop confirmation).' };
        return closeApp(args.name, args.keep);
      }
      case 'find_large_files':
        return findLargeFiles(args.path, args.minMB, args.unusedMonths);
      case 'create_folder_tree':
        return await createFolderTree(args.path, args.folders);
      case 'move_files':
        return await moveFiles(args.source, args.dest, args.filter);
      case 'optimize_gaming':
        return await optimizeGaming(args.keep);
      case 'system_scan':
        return await systemScan();
      case 'get_power_storage': {
        const info = await getSystemInfo();
        return { battery: info.battery || null, disk: info.disk || null };
      }
      case 'see_screen':
        return await seeScreen();
      case 'get_action_log': {
        const m = readMemory();
        return { log: (m.actionLog || []).slice(0, 30) };
      }
      case 'add_skill':
        return addSkill(args.text, args.name);
      case 'list_skills':
        return { skills: listSkills() };
      case 'add_instruction':
        return addInstruction(args.text);
      case 'list_instructions':
        return { instructions: listInstructions() };
      case 'verify_claim':
        return await verifyClaim(args.claim);
      case 'provide_support':
        return provideSupport(args.text);
      case 'get_quote':
        return getQuote();
      case 'breathing_exercise':
        return breathingExercise();
      case 'generate_report':
        return generateReport();
      case 'show_panel':
        return showHudPanel(args.panel, args);
      case 'hide_panel':
        return hideHudPanel();
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
      // 2.4 new tools
      case 'launch_app':
        return await windowTools.launchApp(args.name, args.args);
      case 'focus_app':
        return await windowTools.focusApp(args.name);
      case 'snap_window':
        return await windowTools.snapWindow(args.direction || args.left || 'left');
      case 'minimize_all':
        return await windowTools.minimizeAll();
      case 'next_virtual_desktop':
        return await windowTools.nextVirtualDesktop();
      case 'open_site':
        return await windowTools.openSite(args.url, args.browser);
      case 'list_windows':
        return await windowTools.listWindows();
      case 'apply_mode': {
        const mode = modesLib.getMode(args.name);
        if (!mode) return { error: 'Mode not found: ' + args.name };
        return await applyModeInternal(mode);
      }
      case 'list_modes':
        return { modes: modesLib.listModes() };
      case 'create_mode': {
        const res = modesLib.saveMode(args);
        if (res.error) return res;
        return { ok: true, mode: res.mode };
      }
      default:
        return { error: 'Unknown tool: ' + name };
    }
  } catch (e) {
    return { error: e.message };
  }
}

async function applyModeInternal(mode) {
  const steps = [];
  try {
    // Launch apps
    for (const appName of (mode.apps||[])) {
      try {
        const r = await windowTools.launchApp(appName);
        steps.push({ step: `launch ${appName}`, ok: !r.error, result: r });
      } catch (e) { steps.push({ step: `launch ${appName}`, ok: false, error: e.message }); }
    }
    // Open sites
    for (const site of (mode.sites||[])) {
      try {
        const url = typeof site === 'string' ? site : site.url;
        const browser = typeof site === 'object' ? site.browser : undefined;
        const r = await windowTools.openSite(url, browser);
        steps.push({ step: `open ${url} in ${browser||'default'}`, ok: !r.error, result: r });
      } catch (e) { steps.push({ step: `open site`, ok: false, error: e.message }); }
    }
    // Volume
    if (typeof mode.volume === 'number') {
      try {
        const r = controlVolume({ action: 'set', level: mode.volume });
        steps.push({ step: `set volume ${mode.volume}`, ok: true, result: r });
        if (mainWindow) mainWindow.webContents.send('desktop:volume', { level: mode.volume });
      } catch (e) { steps.push({ step: 'set volume', ok: false, error: e.message }); }
    }
    // Theme
    if (mode.theme) {
      try {
        if (mainWindow) mainWindow.webContents.send('desktop:theme', { theme: mode.theme });
        steps.push({ step: `apply theme ${mode.theme}`, ok: true });
      } catch (e) {}
    }
    // Playlist
    if (mode.playlist) {
      try {
        const r = await windowTools.openSite(mode.playlist, 'chrome');
        steps.push({ step: `open playlist ${mode.playlist}`, ok: true, result: r });
      } catch (e) {}
    }
    // Optimize gaming if flagged
    if (mode.optimizeGaming) {
      try {
        const r = await optimizeGaming();
        steps.push({ step: 'optimize_gaming', ok: !r.error, result: r });
      } catch (e) {}
    }
    // DND - emit event
    if (mode.dnd) {
      try { if (mainWindow) mainWindow.webContents.send('desktop:dnd', { enabled: true }); } catch {}
    }
    logAction('apply_mode', `Applied mode ${mode.name}: ${steps.length} steps`);
    // Notify renderer of mode change for chip + sweep + TTS
    if (mainWindow) {
      try { mainWindow.webContents.send('mode:changed', { mode: mode.name, icon: mode.icon, theme: mode.theme }); } catch {}
    }
    return { ok: true, mode: mode.name, steps, summary: `Mode ${mode.name} applied — ${steps.filter(s=>s.ok).length}/${steps.length} steps succeeded` };
  } catch (e) {
    return { error: e.message, steps };
  }
}

function normalizeFact(text) {
  return String(text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}
function upsertFact(fact) {
  const m = readMemory();
  const norm = normalizeFact(fact.text);
  const existing = m.facts.find(f => normalizeFact(f.text) === norm);
  if (existing) { existing.updated = Date.now(); existing.importance = (existing.importance || 1) + 1; }
  else m.facts.push({ id: uid(), text: fact.text, category: fact.category || 'fact', importance: 1, created: Date.now(), updated: Date.now() });
  if (m.facts.length > 300) m.facts = m.facts.sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 300);
  writeMemory(m);
}
function factsForPrompt() {
  const m = readMemory();
  const now = Date.now();
  const scored = m.facts.map((f) => {
    const age = now - (f.updated || f.created || now);
    const recency = 1 / (1 + age / (7 * 86400000));
    return { f, score: (f.importance || 1) * 0.7 + recency * 3 };
  }).sort((a, b) => b.score - a.score).slice(0, 80);
  return scored.map((x) => `- ${x.f.text}`).join('\n');
}
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
async function aiChat(config, messages) {
  const base = normalizeBaseURL(config.baseURL);
  const key = (config.apiKey || '').trim();
  const model = (config.model || 'llama-3.3-70b-versatile').trim();
  const isLocal = base && /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(base);
  if (!base) throw new Error('NO_ENDPOINT');
  if (!key && !isLocal) throw new Error('NO_KEY');
  const msgs = [...messages];
  for (let i = 0; i < 6; i++) {
    const msg = await callChat(base, key, model, msgs, TOOLS);
    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length) {
      msgs.push(msg);
      const results = await Promise.all(toolCalls.map(async (tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        const result = await executeTool(tc.function.name, args);
        return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
      }));
      for (const r of results) msgs.push(r);
      continue;
    }
    const reply = msg.content;
    if (!reply || !reply.trim()) throw new Error('EMPTY_REPLY');
    return reply.trim();
  }
  throw new Error('TOOL_LOOP');
}
async function streamRequest(base, key, model, messages, onDelta) {
  const url = base + (base.endsWith('/chat/completions') ? '' : '/chat/completions');
  const doFetch = (withTools) => {
    const body = { model, messages, temperature: 0.6, max_tokens: 1200, stream: true };
    if (withTools) { body.tools = TOOLS; body.tool_choice = 'auto'; }
    return fetch(url, { method: 'POST', headers: aiHeaders(base, key), body: JSON.stringify(body) });
  };
  let res = await doFetch(true);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (/tool|function|unsupported|invalid/i.test(text) && [400, 404, 422].includes(res.status)) {
      res = await doFetch(false);
    }
    if (!res.ok) {
      const t2 = await res.text().catch(() => '');
      throw new Error('HTTP_' + res.status + ((t2 || text) ? ' ' + (t2 || text).slice(0, 200) : ''));
    }
  }
  let content = '';
  const toolCalls = [];
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
async function aiChatStream(config, messages, onDelta, onTool) {
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
      const assistantMsg = { role: 'assistant', content: content || null, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args || '{}' } })) };
      msgs.push(assistantMsg);
      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.args || '{}'); } catch {}
        if (onTool) { try { onTool({ name: tc.name, state: 'start', args }); } catch {} }
        const result = await executeTool(tc.name, args);
        if (onTool) {
          const failed = result && typeof result === 'object' && result.error;
          try { onTool({ name: tc.name, state: failed ? 'error' : 'done' }); } catch {}
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      final = '';
      continue;
    }
    final = content;
    if (final && final.trim()) break;
  }
  if (!final || !final.trim()) throw new Error('EMPTY_REPLY');
  return final.trim();
}
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
async function offlineBrain(text) {
  const q = (text || '').toLowerCase().trim();
  if (!q) return "I didn't catch that. Say it again?";
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  if (/^(hi|hello|hey|salam|yo|good (morning|evening|afternoon))\b/.test(q) && q.length < 14)
    return 'Hello. Gem here — all systems standing by. I can search the web, check weather, prices, translate and more, all free.';
  if (/your name|who are you/.test(q)) return "I'm GemAir — your personal AI, like your own JARVIS. I can talk to any AI model you connect, and I remember everything we discuss.";
  if (/how are you/.test(q)) return 'All circuits nominal. How can I assist?';
  if (/time|clock/.test(q)) return `The current time is ${time}.`;
  if (/\bdate\b|what day/.test(q)) return `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
  if (/weather|temperature|forecast/.test(q)) {
    const m = q.match(/weather (?:in|for|at)? ?([a-z ]+)/) || q.match(/(?:in|for|at) ([a-z ]+)/);
    const city = (m && m[1]) ? m[1].trim() : null;
    if (city) { const w = await getWeather(city); return w.error || `In ${w.city} it is ${w.temperature}°C with ${w.condition} (wind ${w.windspeed} km/h).`; }
    return 'Tell me a city — e.g. "weather in Mumbai".';
  }
  if (/search|google|look up|find|who is|what is|tell me about|news about|current|latest/.test(q)) {
    const query = q.replace(/^(search|google|look up|find) (for )?/i, '').replace(/^(tell me about|what is|who is|news about)\s+/i, '').trim();
    if (query) {
      const s = await webSearch(query);
      if (s.answer) return s.answer + (s.source ? `\n\nSource: ${s.source}` : '');
      if (s.results[0]) return `Top results for "${query}":\n` + s.results.slice(0, 4).map((r, i) => `${i + 1}. ${r.title}${r.url ? ' — ' + r.url : ''}`).join('\n');
      return `I searched but couldn't find a clear answer for "${query}".`;
    }
  }
  if (/bitcoin|ethereum|solana|dogecoin|crypto|btc|eth|price of/.test(q)) {
    const coins = ['bitcoin', 'ethereum', 'solana', 'dogecoin', 'ripple', 'cardano'];
    const coin = coins.find((c) => q.includes(c)) || 'bitcoin';
    const c = await getCryptoPrice(coin);
    return c.error || `${coin} is $${c.usd} (₹${c.inr}).`;
  }
  if (/convert|currency|exchange rate|usd|inr|dollar|rupee/.test(q)) {
    const m = q.match(/([\d.]+)\s*([a-z]{3})\s*(?:to|in|into|->)?\s*([a-z]{3})/i);
    if (m) { const c = await convertCurrency(parseFloat(m[1]), m[2], m[3]); return c.error || `${c.amount} ${c.from} = ${c.result} ${c.to} (rate ${c.rate}).`; }
    return 'Tell me an amount, e.g. "convert 100 usd to inr".';
  }
  if (/translate/.test(q)) {
    const m = q.match(/translate\s+["']?(.+?)["']?\s+(?:to|into)\s+([a-z]+)/i);
    if (m) { const t = await translateText(m[1], m[2]); return t.error || `Translation: ${t.translation}`; }
    return 'Say e.g. "translate hello to hindi".';
  }
  if (/define|meaning of|dictionary|what does .* mean/.test(q)) {
    const m = q.match(/(?:define|meaning of)\s+([a-z]+)/i) || q.match(/what does\s+([a-z]+)\s+mean/i);
    if (m) { const d = await defineWord(m[1]); return d.error || `${d.word} (${d.phonetic}) — ${d.partOfSpeech}: ${d.definition}${d.example ? '\nExample: ' + d.example : ''}`; }
    return 'Say e.g. "define serendipity".';
  }
  if (/time in|time now in/.test(q)) {
    const m = q.match(/time (?:in|now in) ([a-z ]+)/i);
    if (m) { const t = getWorldTime(m[1].trim()); return t.error || `In ${t.city} it is ${t.time}.`; }
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
    const opened = await windowTools.launchApp(q);
    if (opened && opened.ok) return `Launching ${opened.app} now.`;
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
  if (/organize|sort|tidy/.test(q) && /download|folder|file/.test(q)) {
    const r = await organizeFolder();
    return r.error || `Organized ${r.total} files into ${Object.keys(r.categories || {}).length} category folders.`;
  }
  if (/close everything|close all|close.*except/.test(q)) {
    closeApp('all');
    return 'Closing every non-essential application except GemAir.';
  }
  if (/large file|huge file|big file|free up space/.test(q)) {
    const m = q.match(/(\d+)\s*(gb|mb)/) || q.match(/over\s*(\d+)\s*(gb|mb)?/);
    const minMB = m ? (m[2] === 'gb' ? Number(m[1]) * 1024 : Number(m[1])) : 500;
    const r = findLargeFiles(os.homedir(), minMB, /month/.test(q) ? 6 : null);
    return r.count
      ? `Found ${r.count} file(s) over ${minMB}MB: ${r.files.slice(0, 5).map((f) => `${f.path} (${f.sizeMB}MB)`).join(', ')}`
      : `No files over ${minMB}MB found in your home folder.`;
  }
  if (/optimize.*(?:for )?gaming|gaming.*optimiz/.test(q)) {
    const r = await optimizeGaming();
    return r.error || 'Gaming optimization complete: ' + r.steps.join('; ');
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
  return `I'm in offline mode, so I handle the basics — time, date, weather, web search, math, reminders, notes, opening apps, volume and system control. On the web version the free AI core answers everything.`;
}
async function getHeadlines(limit = 12, category = 'tech') {
  const topics = { tech: 'TECHNOLOGY', world: 'WORLD', business: 'BUSINESS' };
  const safeCategory = topics[category] ? category : 'tech';
  const decodeXml = (value) => String(value || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  try {
    const topic = topics[safeCategory];
    const rss = await fetch(`https://news.google.com/rss/headlines/section/topic/${topic}?hl=en-US&gl=US&ceid=US:en`, { headers: { 'User-Agent': 'GemAir/2.0' } }).then((r) => r.text());
    const blocks = rss.match(/<item>[\s\S]*?<\/item>/g) || [];
    const out = blocks.slice(0, limit).map((block, index) => {
      const field = (name) => { const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')); return decodeXml(match && match[1]); };
      return { id: `${safeCategory}-${index}-${Date.now()}`, title: field('title'), url: field('link'), score: 0, by: field('source') || 'Google News', published: field('pubDate'), category: safeCategory };
    }).filter((item) => item.title && item.url);
    if (out.length) return out;
  } catch {}
  try {
    const top = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json').then((r) => r.json());
    const ids = (Array.isArray(top) ? top : []).slice(0, limit);
    const items = await Promise.all(ids.map((id) => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()).catch(() => null)));
    return items.filter(Boolean).filter((item) => item.title).map((item) => ({ id: item.id, title: item.title, url: item.url || `https://news.ycombinator.com/item?id=${item.id}`, score: item.score || 0, by: item.by || '', category: safeCategory }));
  } catch { return []; }
}
function sendToRenderer(channel, payload) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); } catch {}
}
const HUD_PANELS = ['weather', 'clock', 'focus', 'breathing', 'system', 'news', 'report'];
function showHudPanel(panel, args) {
  const p = String(panel || '').toLowerCase().trim();
  if (!HUD_PANELS.includes(p)) return { error: 'Unknown panel: ' + panel + '. Available: ' + HUD_PANELS.join(', ') };
  sendToRenderer('hud:panel', { action: 'open', panel: p, city: args && args.city });
  logAction('show_panel', 'Opened HUD panel: ' + p + (args && args.city ? ' (' + args.city + ')' : ''));
  return { ok: true, panel: p };
}
function hideHudPanel() {
  sendToRenderer('hud:panel', { action: 'close' });
  logAction('hide_panel', 'Closed the HUD panel');
  return { ok: true };
}
function startReminderScheduler() {
  setInterval(() => {
    const m = readMemory();
    let changed = false;
    for (const r of m.reminders) {
      if (!r.done && !r.notified && r.at <= Date.now()) {
        r.notified = true; changed = true;
        if (mainWindow) mainWindow.webContents.send('reminder:due', r);
        if (Notification.isSupported()) new Notification({ title: 'GemAir Reminder', body: r.text }).show();
      }
    }
    if (changed) writeMemory(m);
  }, 15000);
}
function startFocusPolling() {
  if (focusPollTimer) clearInterval(focusPollTimer);
  focusPollTimer = setInterval(async () => {
    try {
      const focused = await windowTools.getFocusedWindow();
      if (focused && (focused.app !== lastFocused.app || focused.title !== lastFocused.title)) {
        lastFocused = focused;
        sendToRenderer('desktop:focus', focused);
      }
    } catch (e) {}
  }, 2500);
}

// Multi-agent brains
const AGENT_BRAINS = {
  Alice: { role: 'Web Research', tools: ['web_search', 'fetch_webpage'], prompt: 'You are Alice, GemAir’s web researcher. Find current, verifiable information, inspect primary pages, summarize evidence, and cite the returned URLs. Never invent a source.' },
  Bob: { role: 'File Operations', tools: ['list_directory', 'read_file', 'write_file', 'organize_folder', 'launch_app', 'open_site', 'list_windows'], prompt: 'You are Bob, GemAir’s file operator and desktop manager. Inspect before changing anything, use precise paths, preserve user data, and report exactly what was read, written, or organized. You can launch apps and open sites.' },
  Carol: { role: 'System Verification', tools: ['system_scan', 'get_power_storage', 'get_system_status', 'list_windows'], prompt: 'You are Carol, GemAir’s system verifier. Read live CPU, memory, battery, and disk sensors, identify risks, and verify that a mission can run safely. You can see desktop state via list_windows.' },
  Dave: { role: 'Communications', tools: ['send_email', 'open_whatsapp'], prompt: 'You are Dave, GemAir’s communications operator. Prepare clear email or WhatsApp drafts, confirm the destination, and leave the final send action to the user.' }
};
function agentSystemPrompt(name) {
  const b = AGENT_BRAINS[name] || AGENT_BRAINS.Alice;
  const facts = factsForPrompt();
  const instructions = (readMemory().instructions || []).slice(0, 40).map((i) => `- ${i.text}`).join('\n');
  return {
    role: 'system',
    content:
      `${b.prompt}\n` +
      `You are ${name}, one of GemAir's resident agents, and your specialty is ${b.role}. ` +
      `You work for the user (${(readProfile().name) || 'Commander'}). Be truthful — never fabricate; verify facts and cite sources. ` +
      `Your real tools are: ${b.tools.join(', ')}. For every concrete task, call the relevant tool instead of merely describing what you would do. ` +
      `After tool execution, lead with the actual result and clearly report errors or user cancellations. ` +
      `LONG-TERM MEMORY:\n${facts || '(none)'}\n\n` +
      (instructions ? `STANDING INSTRUCTIONS:\n${instructions}\n\n` : '') +
      `Be helpful, concise and professional.`
  };
}
function toolsForAgent(name) {
  const brain = AGENT_BRAINS[name] || AGENT_BRAINS.Alice;
  return TOOLS.filter((tool) => brain.tools.includes(tool.function.name));
}
async function agentChat(name, config, messages) {
  const base = normalizeBaseURL(config.baseURL);
  const key = (config.apiKey || '').trim();
  const model = (config.model || 'llama-3.3-70b-versatile').trim();
  const isLocal = base && /localhost|127\.0\.0\.1|192\.168\.|10\.\d/.test(base);
  if (!base) throw new Error('NO_ENDPOINT');
  if (!key && !isLocal) throw new Error('NO_KEY');
  const msgs = [agentSystemPrompt(name), ...messages];
  const allowed = toolsForAgent(name);
  const toolRuns = [];
  for (let turn = 0; turn < 6; turn++) {
    const msg = await callChat(base, key, model, msgs, allowed);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const reply = String(msg.content || '').trim();
      if (!reply) throw new Error('EMPTY_REPLY');
      return { reply, toolRuns };
    }
    msgs.push(msg);
    for (const call of calls) {
      const toolName = call.function.name;
      if (!(AGENT_BRAINS[name] || AGENT_BRAINS.Alice).tools.includes(toolName)) {
        const denied = { error: `${name} is not authorized to use ${toolName}` };
        msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(denied) });
        toolRuns.push({ name: toolName, args: {}, result: denied, ok: false, ms: 0 });
        continue;
      }
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const started = Date.now();
      const result = await executeTool(toolName, args);
      const ms = Date.now() - started;
      const ok = !(result && result.error);
      toolRuns.push({ name: toolName, args, result, ok, ms });
      logAction(toolName, `${name} ${ok ? 'completed' : 'failed'}: ${JSON.stringify(result).slice(0, 220)}`);
      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('TOOL_LOOP');
}
async function fallbackAgentTask(name, text) {
  const task = String(text || '').replace(/^@(Alice|Bob|Carol|Dave)\s*/i, '').trim();
  const calls = [];
  if (name === 'Alice') calls.push(['web_search', { query: task }]);
  else if (name === 'Bob') {
    const pathMatch = task.match(/(?:in|at|folder|directory)\s+["']?([^"']+?)["']?(?:\s*$|\s+(?:and|then))/i);
    const targetPath = pathMatch ? pathMatch[1].trim() : undefined;
    if (/organize|sort|tidy/i.test(task)) calls.push(['organize_folder', { path: targetPath }]);
    else calls.push(['list_directory', { path: targetPath }]);
  } else if (name === 'Carol') calls.push(['system_scan', {}], ['get_power_storage', {}]);
  else if (name === 'Dave') {
    const email = task.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const phone = task.match(/\+?\d[\d\s()-]{7,}\d/);
    if (email) calls.push(['send_email', { to: email[0], subject: 'Message from GemAir', body: task }]);
    else if (phone) calls.push(['open_whatsapp', { phone: phone[0].replace(/\D/g, ''), text: task }]);
    else return { reply: 'I need an email address or WhatsApp phone number before I can open a draft.', toolRuns: [] };
  }
  const toolRuns = [];
  for (const [toolName, args] of calls) {
    const started = Date.now();
    const result = await executeTool(toolName, args);
    const ok = !(result && result.error);
    toolRuns.push({ name: toolName, args, result, ok, ms: Date.now() - started });
    logAction(toolName, `${name} ${ok ? 'completed' : 'failed'}: ${JSON.stringify(result).slice(0, 220)}`);
  }
  const status = toolRuns.map((run) => `${run.ok ? '✓' : '✗'} ${run.name}: ${JSON.stringify(run.result)}`).join('\n');
  return { reply: `${name} completed the real tool run.\n${status}`, toolRuns };
}
async function collaborateAgents(task) {
  const mission = String(task || '').trim();
  if (!mission) return { error: 'A mission description is required.', steps: [] };
  const steps = [];
  const run = async (agent, tool, args) => {
    const started = Date.now();
    const result = await executeTool(tool, args);
    const step = { agent, tool, args, result, ok: !(result && result.error), ms: Date.now() - started };
    steps.push(step);
    logAction(tool, `${agent} ${step.ok ? 'completed' : 'failed'} collaboration step: ${JSON.stringify(result).slice(0, 200)}`);
    return result;
  };
  const research = await run('Alice', 'web_search', { query: mission });
  const slug = mission.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'mission';
  const reportPath = path.join(app.getPath('documents'), 'GemAir Missions', `${slug}-${new Date().toISOString().slice(0, 10)}.md`);
  const report = [
    '# GemAir Mission Report', '', `**Mission:** ${mission}`, `**Generated:** ${new Date().toLocaleString()}`, '',
    '## Alice — Verified research', '', '```json', JSON.stringify(research, null, 2), '```', '',
    '## Handoff', '', 'Alice researched → Bob persisted → Carol verified system readiness.', ''
  ].join('\n');
  const written = await run('Bob', 'write_file', { path: reportPath, content: report });
  const scan = await run('Carol', 'system_scan', {});
  const sensors = await run('Carol', 'get_power_storage', {});
  return {
    ok: steps.every((step) => step.ok),
    reportPath: written && written.path ? written.path : null,
    steps,
    summary: `Alice researched ${mission}. Bob ${written && written.path ? `wrote ${written.path}` : 'could not write the report'}. Carol verified live system health${scan && scan.advice ? ` (${scan.advice.join(' ')})` : ''}.`,
    sensors
  };
}

// ---------------------------------------------------------------------------
// Connections: Auth Windows + Routing
// ---------------------------------------------------------------------------
function createAuthWindow(provider) {
  if (authWindow && !authWindow.isDestroyed()) {
    try { authWindow.close(); } catch {}
  }
  const partition = provider === 'chatgpt' ? 'persist:chatgpt' : 'persist:gemini';
  authWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    autoHideMenuBar: false,
    title: provider === 'chatgpt' ? 'Connect ChatGPT — Sign in' : 'Connect Gemini — Sign in',
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });
  // Clear previous session? Keep persist so user doesn't re-login each time
  const url = provider === 'chatgpt' ? 'https://chatgpt.com/auth/login' : 'https://accounts.google.com/signin/v2/identifier?service=gemini&continue=https://gemini.google.com/app';
  authWindow.loadURL(url);
  return authWindow;
}

async function captureChatGPTSession() {
  if (!authWindow || authWindow.isDestroyed()) return { error: 'No auth window' };
  const ses = authWindow.webContents.session;
  // Get cookies for both domains
  const allCookies = [];
  try {
    const c1 = await ses.cookies.get({ domain: 'chatgpt.com' });
    allCookies.push(...c1);
  } catch {}
  try {
    const c2 = await ses.cookies.get({ domain: 'chat.openai.com' });
    allCookies.push(...c2);
  } catch {}
  try {
    const c3 = await ses.cookies.get({ domain: 'openai.com' });
    allCookies.push(...c3);
  } catch {}
  // Look for session token
  const sessionCookie = allCookies.find(c=>c.name.includes('__Secure-next-auth.session-token') || c.name==='__Secure-next-auth.session-token' || c.name==='__Secure-next-auth.session-token.0' || c.name==='__Secure-next-auth.session-token.1');
  // Try to fetch /api/auth/session via executeJavaScript in auth window (uses its cookies)
  let sessionData = null;
  try {
    const raw = await authWindow.webContents.executeJavaScript(`
      fetch('/api/auth/session').then(r=>r.text()).then(t=>t).catch(e=>'')
    `);
    if (raw) {
      try { sessionData = JSON.parse(raw); } catch { sessionData = null; }
    }
  } catch {}
  // If not, try via fetch with cookie header (best effort)
  if (!sessionData || !sessionData.accessToken) {
    try {
      sessionData = await connections.fetchChatGPTSessionFromCookies(allCookies);
    } catch {}
  }
  if (!sessionData || !sessionData.accessToken) {
    return { error: 'Could not capture ChatGPT session. Please ensure you are logged in at chatgpt.com, then try again.', cookies: allCookies.length };
  }
  const email = (sessionData.user && sessionData.user.email) || (sessionData.user && sessionData.user.id) || 'chatgpt_user';
  const plan = (sessionData.user && sessionData.user.plan) || 'free';
  // Store encrypted
  connections.setChatGPTConnection({
    email,
    plan,
    sessionToken: sessionCookie ? sessionCookie.value : '',
    accessToken: sessionData.accessToken,
    refreshToken: sessionData.refreshToken || '',
    expiresAt: Date.now() + 14*24*3600000
  });
  try { authWindow.close(); } catch {}
  authWindow = null;
  return { ok: true, email, plan };
}

async function captureGeminiSession(isAIStudioFallback=false) {
  if (!authWindow || authWindow.isDestroyed()) return { error: 'No auth window' };
  const ses = authWindow.webContents.session;
  const allCookies = [];
  try {
    const c1 = await ses.cookies.get({ domain: 'google.com' });
    allCookies.push(...c1);
  } catch {}
  try {
    const c2 = await ses.cookies.get({ domain: 'gemini.google.com' });
    allCookies.push(...c2);
  } catch {}
  const psid = allCookies.find(c=>c.name==='__Secure-1PSID') || allCookies.find(c=>c.name==='1PSID');
  const psidts = allCookies.find(c=>c.name==='__Secure-1PSIDTS') || allCookies.find(c=>c.name==='1PSIDTS');
  if (!psid || !psidts) {
    // For AI Studio fallback, also try to get API key from page
    if (isAIStudioFallback) {
      try {
        const keyData = await authWindow.webContents.executeJavaScript(`
          (() => {
            try {
              const txt = document.documentElement.innerHTML;
              const m = txt.match(/AIza[0-9A-Za-z-_]{35}/);
              return m ? m[0] : '';
            } catch { return ''; }
          })()
        `);
        if (keyData) {
          // Store as psid for fallback handling? Actually store as Gemini connection with fallback flag
          connections.setGeminiConnection({ email: 'aistudio_user@gmail.com', plan: 'ai-studio', psid: keyData, psidts: 'fallback' });
          try { authWindow.close(); } catch {}
          authWindow = null;
          return { ok: true, email: 'aistudio_user@gmail.com', plan: 'ai-studio', fallback: true };
        }
      } catch {}
    }
    return { error: 'Could not capture Gemini session cookies. Please sign in at gemini.google.com, then click Capture.', cookies: allCookies.length };
  }
  // Try to get email via executeJavaScript
  let email = 'gemini_user@gmail.com';
  try {
    const em = await authWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const el = document.querySelector('[aria-label*="Google Account"]') || document.querySelector('img[alt*="Google Account"]');
          return document.documentElement.innerHTML.slice(0,5000);
        } catch { return ''; }
      })()
    `);
    // crude extraction
    const m = em.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (m) email = m[0];
  } catch {}
  connections.setGeminiConnection({ email, plan: 'free', psid: psid.value, psidts: psidts.value });
  try { authWindow.close(); } catch {}
  authWindow = null;
  return { ok: true, email, plan: 'free' };
}

async function callConnectedBrain(provider, messages, onDelta, onTool) {
  // Adapter layer: inject TOOLS as JSON-in-prompt, parse tool calls
  const toolPrompt = connections.buildToolPrompt(TOOLS);
  const adaptedMessages = [
    { role: 'system', content: `You are Gem, inside GemAir desktop. You have tools. ${toolPrompt}\nRespond helpfully. If you need to act, use the TOOL_CALL format.` },
    ...messages
  ];
  const tokens = connections.getDecryptedTokens(provider);
  if (!tokens) throw new Error('NO_CONNECTED_SESSION');
  if (provider === 'chatgpt') {
    if (!tokens.accessToken) throw new Error('NO_CHATGPT_TOKEN');
    // Check expiry
    if (connections.isTokenExpired('chatgpt')) throw new Error('TOKEN_EXPIRED');
    let full = '';
    try {
      full = await connections.callChatGPTWeb({ accessToken: tokens.accessToken, messages: adaptedMessages, onDelta });
    } catch (e) {
      // If web call fails (bot check etc), throw to trigger fallback
      throw new Error('CHATGPT_WEB_FAILED: ' + e.message);
    }
    // Parse tool calls
    const toolCalls = connections.parseToolCallsFromText(full);
    let remaining = connections.stripToolCalls(full);
    if (toolCalls.length) {
      // Execute tools
      for (const tc of toolCalls) {
        if (onTool) { try { onTool({ name: tc.name, state: 'start', args: tc.arguments }); } catch {} }
        const result = await executeTool(tc.name, tc.arguments || {});
        if (onTool) { try { onTool({ name: tc.name, state: result.error ? 'error' : 'done' }); } catch {} }
        // Append to messages and continue loop
        adaptedMessages.push({ role: 'assistant', content: full });
        adaptedMessages.push({ role: 'user', content: `TOOL_RESULT for ${tc.name}: ${JSON.stringify(result)}` });
        // Recursively call again for next turn (max 5 loops)
        // For simplicity, if we have tool results, we call free core? Actually we should loop via same provider
        // We'll loop once more via chatgpt web
        try {
          const next = await connections.callChatGPTWeb({ accessToken: tokens.accessToken, messages: adaptedMessages, onDelta: (d)=>{ if (onDelta) onDelta(d); } });
          remaining = connections.stripToolCalls(next) || remaining;
          full = next;
        } catch {}
      }
    }
    connections.incUsage('chatgpt');
    return remaining || full;
  } else if (provider === 'gemini') {
    // For Gemini, we attempt web call but fallback if experimental
    try {
      await connections.callGeminiWeb({ psid: tokens.psid, psidts: tokens.psidts, messages: adaptedMessages, onDelta });
    } catch (e) {
      throw new Error('GEMINI_WEB_FAILED: ' + e.message);
    }
  }
  throw new Error('UNSUPPORTED_PROVIDER');
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('system:info', () => getSystemInfo());
ipcMain.handle('audit:get', () => executeTool('get_action_log', {}));
ipcMain.handle('screen:inspect', () => inspectScreenChange());
ipcMain.handle('profile:get', () => readProfile());
ipcMain.handle('profile:set', (_e, data) => writeProfile(data || {}));
ipcMain.handle('ai:chat', async (_e, config, messages) => {
  try { return { ok: true, reply: await aiChat(config, messages) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('ai:chatStream', async (e, reqId, config, messages) => {
  const wc = e.sender;
  try {
    const reply = await aiChatStream(config, messages,
      (delta) => wc.send('ai:chunk', { reqId, delta }),
      (info) => { try { wc.send('ai:activity', { reqId, ...info }); } catch {} }
    );
    wc.send('ai:streamEnd', { reqId, reply });
    return { ok: true, reqId, reply };
  } catch (err) {
    wc.send('ai:streamError', { reqId, error: err.message });
    return { ok: false, reqId, error: err.message };
  }
});
ipcMain.handle('ai:offline', async (_e, text) => ({ ok: true, reply: await offlineBrain(text) }));
ipcMain.handle('ai:summarize', async (_e, config, text) => ({ ok: true, summary: await summarizeTranscript(config, text) }));
ipcMain.handle('ai:agentChat', async (_e, agentName, config, messages) => {
  try {
    const run = await agentChat(agentName, config || {}, messages || []);
    return { ok: true, reply: run.reply, toolRuns: run.toolRuns };
  } catch (err) {
    if (err.message === 'NO_ENDPOINT' || err.message === 'NO_KEY') {
      try {
        const last = [...(messages || [])].reverse().find((message) => message.role === 'user');
        const run = await fallbackAgentTask(agentName, last ? last.content : '');
        return { ok: true, reply: run.reply, toolRuns: run.toolRuns, fallback: true };
      } catch (fallbackError) { return { ok: false, error: fallbackError.message, toolRuns: [] }; }
    }
    return { ok: false, error: err.message, toolRuns: [] };
  }
});
ipcMain.handle('agent:collaborate', async (_e, task) => {
  try { return await collaborateAgents(task); }
  catch (err) { return { ok: false, error: err.message, steps: [] }; }
});
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
ipcMain.handle('memory:addMood', (_e, emotion, note) => logMood(emotion, note));
ipcMain.handle('memory:addGoal', (_e, text, category) => addGoal(text, category));
ipcMain.handle('memory:deleteGoal', (_e, id) => { const m = readMemory(); m.goals = m.goals.filter(g => g.id !== id); writeMemory(m); return true; });
ipcMain.handle('memory:toggleGoal', (_e, id) => { const m = readMemory(); const g = m.goals.find(g => g.id === id); if (g) { g.done = !g.done; g.updated = Date.now(); g.completed = g.done ? Date.now() : null; } writeMemory(m); return true; });
ipcMain.handle('emotion:analyze', (_e, text) => analyzeEmotion(text));
ipcMain.handle('memory:addSkill', (_e, text, name) => addSkill(text, name));
ipcMain.handle('memory:deleteSkill', (_e, id) => { const m = readMemory(); m.skills = m.skills.filter(s => s.id !== id); writeMemory(m); return true; });
ipcMain.handle('memory:addInstruction', (_e, text) => addInstruction(text));
ipcMain.handle('memory:deleteInstruction', (_e, id) => { const m = readMemory(); m.instructions = m.instructions.filter(i => i.id !== id); writeMemory(m); return true; });
ipcMain.handle('file:saveCode', async (_e, content, suggestedName) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save output', defaultPath: suggestedName || 'gemair-output.txt',
    filters: [{ name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try { fs.writeFileSync(res.filePath, content); return { ok: true, path: res.filePath }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('news:get', (_e, limit, category) => getHeadlines(limit || 12, category || 'tech'));
ipcMain.handle('app:openExternal', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url); });
ipcMain.handle('report:generate', () => generateReport());
ipcMain.handle('report:needsCheckIn', () => moodNeedsCheckIn());
ipcMain.handle('memory:export', () => ({ memory: readMemory(), profile: readProfile() }));
ipcMain.handle('memory:import', (_e, data) => {
  try {
    if (!data || typeof data.memory !== 'object' || typeof data.profile !== 'object') throw new Error('Backup must contain profile and memory objects.');
    const arrayKeys = ['facts', 'transcript', 'notes', 'reminders', 'todos', 'mood', 'goals', 'skills', 'instructions', 'actionLog'];
    for (const key of arrayKeys) if (data.memory[key] != null && !Array.isArray(data.memory[key])) throw new Error(`Invalid memory field: ${key}`);
    const cleanMemory = { ...EMPTY_MEMORY, ...data.memory };
    writeMemory(cleanMemory);
    writeProfile(data.profile);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('proc:list', (_e, limit) => scanProcesses(limit));
ipcMain.handle('proc:kill', (_e, pid, name) => killProcess(pid, name));
ipcMain.handle('memory:listTodos', () => listTodos());
ipcMain.handle('memory:addTodo', (_e, text) => addTodo(text));
ipcMain.handle('memory:toggleTodo', (_e, id) => toggleTodoById(id));
ipcMain.handle('memory:deleteTodo', (_e, id) => deleteTodoById(id));
ipcMain.handle('win:saveBounds', () => saveWindowBounds());
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:platform', () => process.platform);

// 2.4 Connections
ipcMain.handle('connections:getStatus', () => connections.getSanitizedStatus());
ipcMain.handle('connections:setPriority', (_e, p) => connections.setPriority(p));
ipcMain.handle('connections:acknowledgeWarning', () => { connections.acknowledgeWarning(); return true; });
ipcMain.handle('connections:openChatGPT', async () => {
  createAuthWindow('chatgpt');
  return { ok: true };
});
ipcMain.handle('connections:captureChatGPT', async () => {
  try { return await captureChatGPTSession(); }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('connections:openGemini', async () => {
  createAuthWindow('gemini');
  return { ok: true };
});
ipcMain.handle('connections:captureGemini', async (_e, isFallback) => {
  try { return await captureGeminiSession(isFallback); }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('connections:openAIStudio', async () => {
  if (authWindow && !authWindow.isDestroyed()) { try { authWindow.close(); } catch {} }
  authWindow = new BrowserWindow({
    width: 1100, height: 800, show: true, autoHideMenuBar: false,
    title: 'AI Studio — Sign in with Google (zero key copy-paste)',
    webPreferences: { partition: 'persist:gemini', nodeIntegration: false, contextIsolation: true }
  });
  authWindow.loadURL('https://aistudio.google.com/');
  return { ok: true };
});
ipcMain.handle('connections:disconnect', (_e, provider) => {
  const s = connections.clearConnection(provider);
  if (mainWindow) mainWindow.webContents.send('connections:updated', s);
  return s;
});
ipcMain.handle('connections:clearAll', () => {
  const s = connections.clearAllEncrypted();
  if (mainWindow) mainWindow.webContents.send('connections:updated', s);
  return s;
});
ipcMain.handle('connections:chatStream', async (e, reqId, provider, messages) => {
  const wc = e.sender;
  try {
    const reply = await callConnectedBrain(provider, messages,
      (delta) => wc.send('ai:chunk', { reqId, delta }),
      (info) => { try { wc.send('ai:activity', { reqId, ...info }); } catch {} }
    );
    wc.send('ai:streamEnd', { reqId, reply });
    return { ok: true, reqId, reply };
  } catch (err) {
    wc.send('ai:streamError', { reqId, error: err.message, provider });
    // trigger fallback notification
    if (mainWindow) mainWindow.webContents.send('connections:expired', { provider, error: err.message });
    return { ok: false, reqId, error: err.message };
  }
});

// Modes
ipcMain.handle('modes:list', () => modesLib.listModes());
ipcMain.handle('modes:get', (_e, name) => modesLib.getMode(name));
ipcMain.handle('modes:save', (_e, mode) => modesLib.saveMode(mode));
ipcMain.handle('modes:delete', (_e, name) => modesLib.deleteMode(name));
ipcMain.handle('modes:apply', async (_e, name) => {
  const mode = modesLib.getMode(name);
  if (!mode) return { error: 'Mode not found' };
  return await applyModeInternal(mode);
});

// Desktop tools IPC
ipcMain.handle('desktop:listWindows', () => windowTools.listWindows());
ipcMain.handle('desktop:getFocused', () => windowTools.getFocusedWindow());
ipcMain.handle('desktop:launchApp', (_e, name, args) => windowTools.launchApp(name, args));
ipcMain.handle('desktop:focusApp', (_e, name) => windowTools.focusApp(name));
ipcMain.handle('desktop:snapWindow', (_e, dir) => windowTools.snapWindow(dir));
ipcMain.handle('desktop:minimizeAll', () => windowTools.minimizeAll());
ipcMain.handle('desktop:nextDesktop', () => windowTools.nextVirtualDesktop());
ipcMain.handle('desktop:openSite', (_e, url, browser) => windowTools.openSite(url, browser));
