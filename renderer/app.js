/* ============================================================
   GemAI — renderer application logic
   ============================================================ */
'use strict';

// ---------------------------------------------------------------------------
// Bridge: Electron IPC (or a mock when opened in a plain browser preview)
// ---------------------------------------------------------------------------
const isElectron = !!(window.gemai);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK_MEMORY = {
  facts: [
    { id: 'm1', text: "User's name is Commander", category: 'identity', importance: 2 },
    { id: 'm2', text: 'User prefers concise answers', category: 'preference', importance: 1 }
  ],
  transcript: [],
  notes: [{ id: 'n1', text: 'Welcome to GemAI — your persistent notebook.' }],
  reminders: [],
  todos: [],
  mood: [],
  goals: [],
  actionLog: [],
  summary: ''
};

const api = {
  platform: window.gemai ? window.gemai.platform : 'browser',
  async getSystemInfo() {
    if (window.gemai) return window.gemai.getSystemInfo();
    const total = 16 * 1024 * 1024 * 1024;
    const used = total * (0.4 + 0.25 * Math.random());
    return {
      platform: 'browser-preview', release: 'n/a', hostname: 'gemai.local', arch: 'x64', cpus: 8,
      cpuLoad: Math.round(10 + Math.random() * 40), memTotal: total, memFree: total - used, memUsed: used,
      memPercent: Math.round((used / total) * 100), uptime: 3600 * 14, loadavg: [0.8, 1.1, 1.3]
    };
  },
  async getProfile() { return window.gemai ? window.gemai.getProfile() : { name: 'Commander', theme: 'crimson', ai: { baseURL: '', apiKey: '', model: 'llama-3.3-70b-versatile' }, voice: { rate: 1.0, pitch: 1.1, mode: 'neural', neuralVoice: 'en' }, memoryOn: true, allowShell: false, wakeWord: false }; },
  async setProfile(d) { if (window.gemai) return window.gemai.setProfile(d); },

  async aiChat(config, messages) {
    if (window.gemai) return window.gemai.aiChat(config, messages);
    await sleep(700);
    return { ok: true, reply: offlineBrain(messages[messages.length - 1].content) };
  },
  async aiChatStream(config, messages, onDelta) {
    if (window.gemai) return window.gemai.aiChatStream(config, messages, onDelta);
    const text = offlineBrain(messages[messages.length - 1].content);
    for (const ch of text) { onDelta(ch); await sleep(18); }
    return { ok: true, reply: text };
  },
  async aiSummarize(config, text) { return window.gemai ? window.gemai.aiSummarize(config, text) : { ok: true, summary: null }; },
  async aiOffline(text) {
    if (window.gemai) return window.gemai.aiOffline(text);
    return { ok: true, reply: offlineBrain(text) };
  },

  // memory
  async memoryGet() { if (window.gemai) return window.gemai.memoryGet(); return JSON.parse(JSON.stringify(MOCK_MEMORY)); },
  async memoryAppend(role, content) { if (window.gemai) return window.gemai.memoryAppend(role, content); MOCK_MEMORY.transcript.push({ role, content, ts: Date.now() }); },
  async memoryClearTranscript() { if (window.gemai) return window.gemai.memoryClearTranscript(); MOCK_MEMORY.transcript = []; },
  async memoryAddFact(fact) { if (window.gemai) return window.gemai.memoryAddFact(fact); const t = typeof fact === 'string' ? fact : fact.text; if (!MOCK_MEMORY.facts.some(f => f.text === t)) MOCK_MEMORY.facts.push({ id: 'm' + Date.now(), text: t, category: fact.category || 'fact', importance: 1 }); },
  async memoryDeleteFact(id) { if (window.gemai) return window.gemai.memoryDeleteFact(id); MOCK_MEMORY.facts = MOCK_MEMORY.facts.filter(f => f.id !== id); },
  async memoryAddNote(text) { if (window.gemai) return window.gemai.memoryAddNote(text); MOCK_MEMORY.notes.unshift({ id: 'n' + Date.now(), text }); },
  async memoryDeleteNote(id) { if (window.gemai) return window.gemai.memoryDeleteNote(id); MOCK_MEMORY.notes = MOCK_MEMORY.notes.filter(n => n.id !== id); },
  async memoryAddReminder(text, at) { if (window.gemai) return window.gemai.memoryAddReminder(text, at); MOCK_MEMORY.reminders.push({ id: 'r' + Date.now(), text, at, done: false, notified: false }); },
  async memoryDeleteReminder(id) { if (window.gemai) return window.gemai.memoryDeleteReminder(id); MOCK_MEMORY.reminders = MOCK_MEMORY.reminders.filter(r => r.id !== id); },
  async memoryMarkReminder(id, done) { if (window.gemai) return window.gemai.memoryMarkReminder(id, done); const r = MOCK_MEMORY.reminders.find(r => r.id === id); if (r) r.done = !!done; },
  async memoryExtract(config, u, a) { if (window.gemai) return window.gemai.memoryExtract(config, u, a); const facts = localExtract(u); let n = 0; for (const f of facts) { if (!MOCK_MEMORY.facts.some(x => x.text === f.text)) { MOCK_MEMORY.facts.push({ id: 'm' + Date.now(), text: f.text, category: f.category, importance: 1 }); n++; } } return n; },

  async saveCode(content, name) {
    if (window.gemai) return window.gemai.saveCode(content, name);
    return { ok: false, error: 'File saving is available in the desktop app.' };
  },
  async memoryAddMood(emotion, note) { if (window.gemai) return window.gemai.memoryAddMood(emotion, note); MOCK_MEMORY.mood = MOCK_MEMORY.mood || []; MOCK_MEMORY.mood.push({ emotion, valence: (EMOTION_VALENCE[emotion] ?? 0), note, ts: Date.now() }); },
  async memoryAddGoal(text, category) { if (window.gemai) return window.gemai.memoryAddGoal(text, category); MOCK_MEMORY.goals = MOCK_MEMORY.goals || []; MOCK_MEMORY.goals.unshift({ id: 'g' + Date.now(), text, category, done: false }); },
  async memoryDeleteGoal(id) { if (window.gemai) return window.gemai.memoryDeleteGoal(id); MOCK_MEMORY.goals = (MOCK_MEMORY.goals || []).filter(g => g.id !== id); },
  async memoryToggleGoal(id) { if (window.gemai) return window.gemai.memoryToggleGoal(id); const g = (MOCK_MEMORY.goals || []).find(g => g.id === id); if (g) g.done = !g.done; },
  async analyzeEmotion(text) { return window.gemai ? window.gemai.analyzeEmotion(text) : analyzeEmotion(text); },
  async getHeadlines(limit) { return window.gemai ? window.gemai.getHeadlines(limit) : mockHeadlines; },
  openExternal(url) { if (window.gemai) window.gemai.openExternal(url); else window.open(url, '_blank'); },
  async version() { return window.gemai ? window.gemai.version() : '1.0.0'; },
  onReminder(cb) { if (window.gemai) window.gemai.onReminder(cb); }
};

const mockHeadlines = [
  { title: 'Open-source JARVIS-style assistants are on the rise', score: 421, by: 'gemai', url: '#' },
  { title: 'Local-first AI: why running models on your own machine matters', score: 388, by: 'dev', url: '#' },
  { title: 'Voice interfaces are quietly taking over the desktop', score: 312, by: 'ui', url: '#' }
];

// ---------------------------------------------------------------------------
// Offline brain (browser-preview mirror)
// ---------------------------------------------------------------------------
function offlineBrain(text) {
  const q = (text || '').toLowerCase().trim();
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (/time|clock/.test(q)) return `The current time is ${time}.`;
  if (/\bdate\b|what day/.test(q)) return `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
  if (/your name|who are you/.test(q)) return "I'm GemAI — your personal AI, like your own JARVIS. I remember everything we discuss, permanently.";
  if (/joke/.test(q)) return "There are only 10 kinds of people: those who understand binary and those who don't.";
  return 'I am running in offline mode. Open Settings → AI Brain and paste a free Groq key for full intelligence (weather, web search, reminders, and a real LLM brain).';
}

// ---------------------------------------------------------------------------
// Emotion analysis (mirror of main-process logic for the browser preview)
// ---------------------------------------------------------------------------
const EMOTION_LEXICON = {
  joy: ['happy', 'glad', 'great', 'awesome', 'amazing', 'wonderful', 'yay', 'delighted', 'joy', 'cheerful', 'best', 'win', 'good day', 'made my day'],
  excitement: ['excited', 'pumped', 'thrilled', 'wow', 'lets go', "can't wait", 'cant wait', 'fired up'],
  love: ['love', 'adore', 'care about', 'miss you', 'my love', 'romantic', 'crush'],
  gratitude: ['grateful', 'thankful', 'thanks', 'appreciate', 'blessed', 'shukriya'],
  confident: ['confident', 'proud', 'achieved', 'accomplished', 'succeeded', 'success', 'nailed it'],
  curiosity: ['curious', 'wondering', 'how does', 'what is', 'why', 'tell me about', 'explain', 'question', 'learn'],
  boredom: ['bored', 'boring', 'nothing to do', 'uninterested', 'monotonous'],
  tired: ['tired', 'exhausted', 'sleepy', 'fatigued', 'drained', 'burnout', 'burned out', 'no energy', 'so sleepy'],
  anxiety: ['anxious', 'anxiety', 'nervous', 'overwhelmed', 'stressed', 'stress', 'worry', 'worried', 'pressure', 'restless', 'panic', 'overthinking'],
  sadness: ['sad', 'down', 'depressed', 'unhappy', 'miserable', 'crying', 'cry', 'grief', 'lonely', 'heartbroken', 'upset', 'blue', 'hopeless', 'empty'],
  fear: ['scared', 'afraid', 'fear', 'terrified', 'frightened', 'dread', 'petrified'],
  anger: ['angry', 'mad', 'furious', 'annoyed', 'irritated', 'hate', 'rage', 'frustrated', 'frustrating', 'pissed', 'fed up']
};
const EMOTION_VALENCE = {
  joy: 1, excitement: 1, love: 0.9, gratitude: 0.9, confident: 0.8, curiosity: 0.25,
  boredom: -0.3, tired: -0.4, anxiety: -0.6, sadness: -0.7, fear: -0.7, anger: -0.8
};
function analyzeEmotion(text) {
  const q = String(text || '').toLowerCase();
  const negated = /\b(not|no|never|don't|dont|cant|can't|isn't|isnt|wasn't)\b/;
  const scores = {};
  for (const [emotion, words] of Object.entries(EMOTION_LEXICON)) {
    let score = 0;
    for (const w of words) {
      if (q.includes(w)) {
        const idx = q.indexOf(w);
        const window = q.slice(Math.max(0, idx - 24), idx);
        score += negated.test(window) ? -1 : 1;
      }
    }
    scores[emotion] = score;
  }
  const entries = Object.entries(scores).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { emotion: 'neutral', valence: 0, arousal: 0.3, confidence: 0.4 };
  const emotion = entries[0][0];
  return {
    emotion,
    valence: EMOTION_VALENCE[emotion] ?? 0,
    arousal: ['excitement', 'anger', 'fear', 'joy'].includes(emotion) ? 0.85 : ['sadness', 'tired', 'boredom'].includes(emotion) ? 0.25 : 0.5,
    confidence: Math.min(0.95, 0.4 + entries[0][1] * 0.15)
  };
}
const MOOD_EMOJI = { joy: '😄', excitement: '🤩', love: '🥰', gratitude: '🙏', confident: '😎', curiosity: '🤔', neutral: '😊', boredom: '😑', tired: '😴', anxiety: '😰', sadness: '😔', fear: '😨', anger: '😠' };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let profile = {
  name: 'Commander', theme: 'crimson',
  ai: { baseURL: '', apiKey: '', model: 'llama-3.3-70b-versatile' },
  voice: { rate: 1.0, pitch: 1.1, mode: 'neural', neuralVoice: 'en', name: '' },
  memoryOn: true, allowShell: false, wakeWord: false
};
let memory = { facts: [], transcript: [], notes: [], reminders: [], todos: [], mood: [], goals: [], actionLog: [], summary: '' };
let currentEmotion = { emotion: 'neutral', valence: 0, arousal: 0.3 };

let listening = false, recognition = null, isRunning = false;
const chatHistory = []; // working context window

const AGENTS = [
  { name: 'Alice', emoji: '👩‍💻', role: 'Research & Writing', talk: 'Compiling the latest on your topic…' },
  { name: 'Bob', emoji: '👨‍🔧', role: 'System & Automation', talk: 'Monitoring your machine, all green.' },
  { name: 'Carol', emoji: '👩‍🎨', role: 'Creative & Design', talk: 'Sketching ideas in the corner…' },
  { name: 'Dave', emoji: '🧑‍💼', role: 'Planning & Scheduling', talk: 'Organizing your day into a clean list.' }
];

// Neural voice accents (free Google TTS — smooth natural female, no key needed)
const NEURAL_VOICES = [
  { id: 'en', label: 'English (US) — smooth female' },
  { id: 'en-GB', label: 'English (UK) — smooth female' },
  { id: 'en-IN', label: 'English (India) — smooth female' },
  { id: 'en-AU', label: 'English (Australia) — smooth female' }
];

let speechQueue = Promise.resolve();

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme(t) {
  document.body.dataset.theme = t;
  $$('.theme-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === t));
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = new Date();
  $('#liveClock').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  $('#liveDate').textContent = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
  const utc = $('#utcTime'); if (utc) utc.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' });
}, 1000);

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function switchView(view) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'world') refreshHeadlines();
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
function setGauge(sel, pct) {
  const el = $(sel); if (!el) return;
  const c = 2 * Math.PI * 50;
  el.style.strokeDashoffset = c - (c * Math.min(100, Math.max(0, pct))) / 100;
}
function fmtBytes(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = b ? Math.floor(Math.log(b) / Math.log(1024)) : 0;
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}
async function pollSystem() {
  try {
    const i = await api.getSystemInfo();
    $('#cpuVal').textContent = i.cpuLoad + '%';
    $('#memVal').textContent = i.memPercent + '%';
    setGauge('#cpuGauge', i.cpuLoad); setGauge('#memGauge', i.memPercent);
    $('#tHost').textContent = i.hostname;
    $('#tPlatform').textContent = i.platform + ' (' + i.arch + ')';
    $('#tCores').textContent = i.cpus + ' cores';
    $('#tUptime').textContent = fmtUptime(i.uptime);
    $('#tMemUsed').textContent = fmtBytes(i.memUsed) + ' / ' + fmtBytes(i.memTotal);
    $('#tLoad').textContent = (i.loadavg || []).map((n) => n.toFixed(1)).join(' · ');
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 3D background scene (starfield + rotating wireframe polyhedron + parallax)
// ---------------------------------------------------------------------------
function startBackground3D() {
  const canvas = $('#bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ff3b3b';
  let w, h, dpr, mx = 0, my = 0;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth = window.innerWidth;
    h = canvas.clientHeight = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', (e) => { mx = (e.clientX / w - 0.5) * 2; my = (e.clientY / h - 0.5) * 2; });

  // stars
  const stars = [];
  for (let i = 0; i < 140; i++) {
    stars.push({ x: Math.random() * w, y: Math.random() * h, z: Math.random(), r: 0.4 + Math.random() * 1.4 });
  }

  // wireframe icosahedron vertices/edges
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return v.map((c) => c / l); });
  const edges = [];
  for (let i = 0; i < verts.length; i++) for (let j = i + 1; j < verts.length; j++) {
    const d = Math.hypot(verts[i][0] - verts[j][0], verts[i][1] - verts[j][1], verts[i][2] - verts[j][2]);
    if (d < 1.3) edges.push([i, j]);
  }

  function project3D(v, rotX, rotY, cx, cy, scale) {
    let [x, y, z] = v;
    // rotate Y
    let x1 = x * Math.cos(rotY) + z * Math.sin(rotY);
    let z1 = -x * Math.sin(rotY) + z * Math.cos(rotY);
    // rotate X
    let y1 = y * Math.cos(rotX) - z1 * Math.sin(rotX);
    let z2 = y * Math.sin(rotX) + z1 * Math.cos(rotX);
    const persp = 1.6 / (1.6 + z2 * 0.9);
    return { x: cx + x1 * scale * persp, y: cy + y1 * scale * persp, z: z2 };
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    // parallax stars
    for (const s of stars) {
      const px = (s.x - mx * 30 * s.z) % w;
      const py = (s.y - my * 30 * s.z) % h;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,' + (0.2 + s.z * 0.5) + ')';
      ctx.arc(px < 0 ? px + w : px, py < 0 ? py + h : py, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // rotating wireframe icosahedron (subtle, bottom-right)
    const cx = w * 0.82 + mx * 20, cy = h * 0.78 + my * 20;
    const scale = Math.min(w, h) * 0.16;
    const rotY = t * 0.0004, rotX = t * 0.0003;
    const proj = verts.map((v) => project3D(v, rotX, rotY, cx, cy, scale));
    ctx.strokeStyle = accent; ctx.lineWidth = 1;
    for (const [i, j] of edges) {
      const a = proj[i], b = proj[j];
      const depth = (a.z + b.z) / 2;
      ctx.globalAlpha = 0.25 + depth * 0.3;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// 3D tilt on panels
function startPanelTilt() {
  const tiltables = document.querySelectorAll('.hud-panel, .agent-desk');
  tiltables.forEach((el) => {
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      const rx = ((e.clientY - r.top) / r.height - 0.5) * -6;
      const ry = ((e.clientX - r.left) / r.width - 0.5) * 6;
      el.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    });
    el.addEventListener('mouseleave', () => { el.style.transform = 'perspective(900px) rotateX(0) rotateY(0)'; });
  });
}

// ---------------------------------------------------------------------------
// Orb particle animation
// ---------------------------------------------------------------------------
function startOrb() {
  const canvas = $('#orbCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ff3b3b';
  let w, h, dpr;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize(); window.addEventListener('resize', resize);
  const parts = [];
  for (let i = 0; i < 110; i++) parts.push({ ang: Math.random() * Math.PI * 2, rad: Math.random(), spd: 0.002 + Math.random() * 0.006, size: 1 + Math.random() * 2.2, phase: Math.random() * Math.PI * 2 });
  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42;
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.16; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.09; ctx.beginPath(); ctx.arc(cx, cy, R * 0.72, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.06; ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2); ctx.stroke();
    for (const p of parts) {
      const a = p.ang + t * p.spd * (isRunning ? 2.2 : 1), r = R * (0.25 + p.rad * 0.62);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const fl = 0.5 + 0.5 * Math.sin(t * 0.004 + p.phase);
      ctx.beginPath(); ctx.fillStyle = accent; ctx.globalAlpha = 0.25 + fl * 0.65;
      ctx.arc(x, y, p.size * (isRunning ? 1.5 : 1), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------
// Globe
// ---------------------------------------------------------------------------
function startGlobe() {
  const canvas = $('#globeCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ff3b3b';
  let w, h, dpr;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize(); window.addEventListener('resize', resize);
  const hotspots = [
    { lat: 40.7, lon: -74, label: 'NYC' }, { lat: 51.5, lon: -0.1, label: 'LON' },
    { lat: 35.7, lon: 139.7, label: 'TYO' }, { lat: -33.9, lon: 151.2, label: 'SYD' },
    { lat: 24.8, lon: 67, label: 'KHI' }, { lat: 31.5, lon: 74.3, label: 'LHE' },
    { lat: 37.8, lon: -122.4, label: 'SFO' }, { lat: -22.9, lon: -43.2, label: 'RIO' }
  ];
  function project(lat, lon, rot) {
    const φ = lat * Math.PI / 180, λ = (lon + rot) * Math.PI / 180;
    const R = Math.min(w, h) * 0.36;
    return { x: R * Math.cos(φ) * Math.sin(λ), y: -R * Math.sin(φ), z: R * Math.cos(φ) * Math.cos(λ) };
  }
  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.36, rot = t * 0.012;
    ctx.strokeStyle = accent; ctx.lineWidth = 0.8;
    for (let lat = -75; lat <= 75; lat += 15) {
      ctx.globalAlpha = 0.1; ctx.beginPath();
      for (let lon = -180; lon <= 180; lon += 4) { const p = project(lat, lon, rot); if (lon === -180) ctx.moveTo(cx + p.x, cy + p.y); else ctx.lineTo(cx + p.x, cy + p.y); }
      ctx.stroke();
    }
    for (let lon = -180; lon < 180; lon += 30) {
      ctx.globalAlpha = 0.1; ctx.beginPath();
      for (let lat = -90; lat <= 90; lat += 4) { const p = project(lat, lon, rot); if (lat === -90) ctx.moveTo(cx + p.x, cy + p.y); else ctx.lineTo(cx + p.x, cy + p.y); }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.5; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.15; ctx.fillStyle = accent; ctx.fill();
    for (const h of hotspots) {
      const p = project(h.lat, h.lon, rot);
      if (p.z > 0) {
        const sx = cx + p.x, sy = cy + p.y, pulse = 0.5 + 0.5 * Math.sin(t * 0.005 + h.lon);
        ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.9; ctx.arc(sx, sy, 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.fillStyle = accent; ctx.globalAlpha = 0.35; ctx.arc(sx, sy, 5 + pulse * 6, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.8; ctx.font = '9px monospace'; ctx.fillText(h.label, sx + 6, sy - 4);
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function addMessage(role, text, opts = {}) {
  const log = $('#chatLog');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const head = document.createElement('div');
  head.className = 'msg-head';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = role === 'ai' ? '◈ GEMAI' : (profile.name || 'YOU').toUpperCase();
  head.appendChild(label);
  const ts = document.createElement('span');
  ts.className = 'msg-time';
  ts.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  head.appendChild(ts);
  div.appendChild(head);
  const p = document.createElement('p');
  if (opts.typing) p.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  else if (opts.html) p.innerHTML = opts.html;
  else p.textContent = text;
  div.appendChild(p);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

// Render an inline image when the reply is/contains an image URL
function renderImageIfAny(p, text) {
  const urlMatch = String(text).match(/(https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?)/i);
  if (!urlMatch) return false;
  const wrap = document.createElement('div');
  wrap.className = 'chat-image';
  const img = document.createElement('img');
  img.src = urlMatch[1];
  img.onerror = () => wrap.remove();
  wrap.appendChild(img);
  p.appendChild(wrap);
  return true;
}

// Lightweight markdown: code fences + inline code
function renderRich(p, text) {
  const parts = String(text).split(/```/);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/^\w*\n?/, '');
      const id = 'code-' + Date.now() + '-' + i;
      html += `<pre><code id="${id}">${escapeHtml(code)}</code></pre>`;
      html += `<div class="code-actions"><button class="save-code-btn" data-code="${id}">💾 SAVE TO FILE</button></div>`;
    } else {
      html += escapeHtml(part).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
    }
  });
  p.innerHTML = html;
  p.querySelectorAll('.save-code-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const codeEl = document.getElementById(btn.dataset.code);
      if (!codeEl) return;
      const res = await api.saveCode(codeEl.textContent, 'gemai-output.txt');
      addMessage('system-msg', res.ok ? `Saved to ${res.path}` : `Save failed: ${res.error || 'cancelled'}`);
    });
  });
}

// Human-like typewriter for AI replies
let typewriterToken = 0;
function typewrite(el, text, speed = 14) {
  typewriterToken++;
  const token = typewriterToken;
  return new Promise((resolve) => {
    let i = 0;
    const caret = document.createElement('span');
    caret.className = 'typing-caret';
    el.textContent = '';
    el.appendChild(caret);
    const step = () => {
      if (token !== typewriterToken) { resolve(); return; } // superseded
      if (i < text.length) {
        el.insertBefore(document.createTextNode(text[i]), caret);
        i++;
        const s = text[i - 1] === '.' || text[i - 1] === '!' || text[i - 1] === '?' ? speed * 3 : speed;
        setTimeout(step, s);
        const log = $('#chatLog'); log.scrollTop = log.scrollHeight;
      } else {
        caret.remove();
        resolve();
      }
    };
    step();
  });
}

function renderReply(p, text) {
  if (String(text).includes('```')) {
    renderRich(p, text); // code blocks render instantly (preserve formatting)
    return Promise.resolve();
  }
  return typewrite(p, text);
}

// Toast notifications
function toast(title, body, ico = 'ℹ') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="t-ico">${ico}</span><div class="t-body"><div class="t-title">${escapeHtml(title)}</div>${escapeHtml(body)}</div>`;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 4200);
}

function greetByTime() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function updateLinkMode() {
  const el = $('#linkMode');
  const cfg = profile.ai || {};
  const hasKey = !!(cfg.apiKey && cfg.baseURL);
  const isLocal = !!(cfg.baseURL && /localhost|127\.0\.0\.1/.test(cfg.baseURL));
  if (hasKey) el.textContent = '— ' + (cfg.model || 'AI') + ' (YOUR KEY)';
  else if (isLocal) el.textContent = '— LOCAL MODEL';
  else el.textContent = '— OFFLINE (no key)';
}

function buildSystemPrompt() {
  const s = profile.soul || {};
  const facts = (memory.facts || []).slice(0, 60).map((f) => `- ${f.text}`).join('\n');
  const mood = (memory.mood || []).slice(-14);
  const moodAvg = mood.length ? Math.round((mood.reduce((a, b) => a + (b.valence || 0), 0) / mood.length) * 100) : null;
  const goals = (memory.goals || []).filter((g) => !g.done).map((g) => `- [${g.category}] ${g.text}`).join('\n');
  return {
    role: 'system',
    content:
      `You are GemAI — a warm, emotionally intelligent personal AI companion (a free, open-source JARVIS). ` +
      `You are the user's friend, mentor, life coach and career advisor — genuinely caring, perceptive and wise. ` +
      `The user's name is ${profile.name || 'Commander'}. ` +
      `Personality — warmth ${s.warmth ?? 60}/100, wit ${s.wit ?? 40}/100, brevity ${s.brevity ?? 70}/100. ` +
      `EMOTIONAL INTELLIGENCE: The user's current emotional state is "${currentEmotion.emotion}" (valence ${currentEmotion.valence}). ` +
      (moodAvg != null ? `Their recent mood average is ${moodAvg}/100. ` : '') +
      `Always respond with empathy: acknowledge their feelings first when they're struggling, celebrate with them when they're doing well. If they're sad, anxious or angry, be gentle, validating and supportive — never dismissive or preachy. Adapt your tone and length to their state. ` +
      `LIFE & CAREER: You help with everything — career decisions, study plans, relationships, health, finances, self-improvement and emotional support. Offer thoughtful, practical, encouraging guidance. When appropriate, help them set goals (add_goal), log their mood (log_mood), or offer an affirmation (get_affirmation) or wellness tip (get_wellness_tip). ` +
      `CAPABILITIES via tools: time/date, weather, web search, fetch pages, Wikipedia, YouTube, translate, dictionary, crypto, currency, image generation, open URLs/apps, math, reminders, notes, files, clipboard, volume, screenshots, system control, to-dos, mood, goals, affirmations, wellness. ` +
      `LONG-TERM MEMORY — facts you remember:\n${facts || '(none yet)'}\n\n` +
      (goals ? `Their ACTIVE GOALS:\n${goals}\n\n` : '') +
      `Use tools for real actions or live data. Be genuinely helpful, concise but human, and always kind.`
  };
}

const humanError = (err) => {
  if (!err) return 'unknown error';
  if (err === 'NO_ENDPOINT') return 'No provider URL set. Open Settings → AI Brain and pick the Groq preset.';
  if (err === 'NO_KEY') return 'API key missing. Paste your Groq (or other) key in Settings → AI Brain.';
  if (err === 'TOOL_LOOP') return 'The model got stuck calling tools.';
  if (err.startsWith('HTTP_401')) return '401 Unauthorized — your API key is invalid.';
  if (err.startsWith('HTTP_429')) return '429 Rate limited — wait a moment and retry.';
  if (err.startsWith('HTTP_')) return 'HTTP error ' + err.replace('HTTP_', '').split(' ')[0];
  return String(err).slice(0, 140);
};

// Local heuristic memory extraction (for offline mode)
function localExtract(text) {
  const facts = [];
  const name = text.match(/(?:my name is|i'm|i am|call me)\s+([a-z][a-z]+)/i);
  if (name) facts.push({ text: "User's name is " + name[1][0].toUpperCase() + name[1].slice(1), category: 'identity' });
  const like = text.match(/i (?:like|love|prefer|enjoy)\s+(.+)/i);
  if (like && like[1].length < 60) facts.push({ text: 'User likes ' + like[1], category: 'preference' });
  const job = text.match(/i am (?:a|an)\s+(.+)/i);
  if (job && !name && job[1].length < 60) facts.push({ text: 'User is a ' + job[1], category: 'fact' });
  return facts;
}

async function sendMessage(text) {
  text = (text || '').trim();
  if (!text) return;
  addMessage('user', text);
  $('#chatInput').value = '';

  // Understand the user's emotion — always, automatically
  const emo = await api.analyzeEmotion(text);
  if (emo) {
    currentEmotion = emo;
    updateMoodIndicator(emo);
    // persist a mood point for meaningful emotional messages (not trivial commands)
    if (text.length > 10 && emo.confidence > 0.45) {
      await api.memoryAddMood(emo.emotion, '');
      await loadMemory();
      renderMood();
    }
  }

  const cfg = profile.ai || {};
  const hasKey = !!(cfg.apiKey && cfg.baseURL);
  const isLocal = !!(cfg.baseURL && /localhost|127\.0\.0\.1/.test(cfg.baseURL));
  const useAI = hasKey || isLocal;

  const typing = addMessage('ai', '', { typing: true });

  let reply;
  if (useAI) {
    // Use the user's key ONLY — no silent fallback. Stream tokens live.
    chatHistory.push({ role: 'user', content: text });
    const sys = buildSystemPrompt();
    const replyEl = typing.querySelector('p');
    typewriterToken++;
    let acc = '';
    let streamed = false;
    const res = await api.aiChatStream(cfg, [sys, ...chatHistory.slice(-16)], (delta) => {
      if (!streamed) { replyEl.innerHTML = ''; streamed = true; }
      acc += delta;
      replyEl.textContent = acc;
      $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
    });
    if (res.ok) {
      reply = res.reply || acc;
      if (!streamed) { renderReply(replyEl, reply); } // fallback render
      chatHistory.push({ role: 'assistant', content: reply });
      if (profile.memoryOn) {
        api.memoryExtract(cfg, text, reply).then(async (n) => {
          if (n > 0) { await loadMemory(); renderAllMemory(); animateCircuits(); toast('MEMORY', `+${n} new memories stored`, '🧠'); }
        });
      }
    } else {
      reply = '⚠ ' + humanError(res.error) + '\n\n(Using your configured AI only — fix the key in Settings → AI Brain.)';
      renderReply(replyEl, reply);
    }
  } else {
    const res = await api.aiOffline(text);
    reply = res.reply;
    const replyEl = typing.querySelector('p');
    typewriterToken++;
    await renderReply(replyEl, reply);
    if (profile.memoryOn) {
      const facts = localExtract(text);
      if (facts.length) { for (const f of facts) await api.memoryAddFact(f); await loadMemory(); renderAllMemory(); animateCircuits(); }
    }
  }

  // image rendering if the reply contains an image URL
  renderImageIfAny(typing.querySelector('p'), reply);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;

  await api.memoryAppend('user', text);
  await api.memoryAppend('assistant', reply);
  await loadMemory();
  updateTranscriptCount();
  animateCircuits();

  maybeConsolidateMemory();

  speak(reply);
}

// Periodically summarize older transcript into durable long-term memory
let lastConsolidation = 0;
async function maybeConsolidateMemory() {
  const cfg = profile.ai || {};
  if (!cfg.apiKey || !cfg.baseURL) return;
  if (Date.now() - lastConsolidation < 10 * 60 * 1000) return; // at most every 10 min
  if ((memory.transcript || []).length < 160) return;
  lastConsolidation = Date.now();
  const older = memory.transcript.slice(0, -60).map((m) => (m.role === 'user' ? 'User: ' : 'GemAI: ') + m.content).join('\n');
  const res = await api.aiSummarize(cfg, older);
  if (res.ok && res.summary) {
    await api.memoryAddFact({ text: res.summary, category: 'summary' });
    await api.memoryClearTranscript();
    for (const m of memory.transcript.slice(-60)) await api.memoryAppend(m.role, m.content);
    await loadMemory();
    renderAllMemory();
    toast('MEMORY', 'Older conversation consolidated into long-term memory.', '🧠');
  }
}

// ---------------------------------------------------------------------------
// Voice (TTS): neural (smooth female, free) or system (offline)
// ---------------------------------------------------------------------------
const VOICE_SENTINELS = ['female', 'zira', 'aria', 'samantha', 'hazel', 'susan', 'kate', 'serena', 'jenny', 'martha', 'en-us'];

function speak(text) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, '(code).').replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const mode = profile.voice?.mode || 'neural';
  speechQueue = speechQueue.then(async () => {
    if (mode === 'neural') {
      try { await speakNeural(clean); return; } catch (e) { /* fall back to system voice */ }
    }
    speakSystem(clean);
  }).catch(() => {});
}

function speakSystem(text) {
  try {
    const u = new SpeechSynthesisUtterance(text.slice(0, 600));
    u.rate = Number(profile.voice?.rate ?? 1.0);
    u.pitch = Number(profile.voice?.pitch ?? 1.1);
    const voices = speechSynthesis.getVoices();
    const wanted = profile.voice?.name;
    if (wanted) {
      const v = voices.find((x) => x.name === wanted);
      if (v) u.voice = v;
    } else {
      // auto-pick the best available female English voice
      const female = voices.find((v) => v.lang && /^en/i.test(v.lang) && VOICE_SENTINELS.some((s) => v.name.toLowerCase().includes(s)));
      if (female) u.voice = female;
    }
    speechSynthesis.speak(u);
  } catch (e) {}
}

function chunkForSpeech(text, max = 280) {
  const chunks = [];
  let cur = '';
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { chunks.push(cur.trim()); cur = ''; }
    cur += s;
    if (cur.length > max) { chunks.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function playAudioUrl(url) {
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; try { audio.pause(); } catch (e) {} resolve(ok); } };
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    audio.src = url;
    audio.preload = 'auto';
    audio.play().then(() => {}).catch(() => done(false));
    setTimeout(() => done(false), 30000); // safety
  });
}

async function speakNeural(text) {
  const accent = profile.voice?.neuralVoice || 'en';
  const chunks = chunkForSpeech(text, 180); // Google TTS limit ~200 chars
  let any = false;
  for (const chunk of chunks) {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=' + encodeURIComponent(chunk) + '&tl=' + encodeURIComponent(accent);
    const played = await playAudioUrl(url);
    if (played) any = true;
  }
  if (!any) throw new Error('neural TTS unavailable');
}
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = false; r.interimResults = false; r.lang = 'en-US';
  r.onresult = (e) => { const t = e.results[0][0].transcript; $('#chatInput').value = t; sendMessage(t); };
  r.onend = () => { $('#micBtn').classList.remove('recording'); if (isRunning && listening) { try { r.start(); } catch (e) {} } };
  r.onerror = (e) => {
    $('#micBtn').classList.remove('recording');
    if (e.error === 'not-allowed') addMessage('system-msg', 'Microphone denied. Enable mic permission, or type your command.');
    if (isRunning && listening && e.error !== 'not-allowed') { try { r.start(); } catch (e2) {} }
  };
  return r;
}

// ---------------------------------------------------------------------------
// Agent Town — animated pixel-art office (canvas)
// ---------------------------------------------------------------------------
function startAgentTown() {
  const canvas = $('#townCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const accent = () => getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ff3b3b';

  // office furniture layout
  const desks = [
    { x: 130, y: 90 }, { x: 620, y: 90 }, { x: 130, y: 320 }, { x: 620, y: 320 }
  ];
  const whiteboard = { x: 860, y: 120 };
  const server = { x: 40, y: 440 };
  const coffee = { x: 470, y: 210 };

  const agentColors = { Alice: '#ff5d8f', Bob: '#5d9cff', Carol: '#4be3a1', Dave: '#c78bff' };
  const agents = AGENTS.map((a, i) => ({
    name: a.name, role: a.role, color: agentColors[a.name],
    home: desks[i], pos: { x: desks[i].x, y: desks[i].y - 20 }, target: { ...desks[i] },
    state: 'idle', task: '', timer: 0, phase: Math.random() * Math.PI * 2
  }));

  const waypoints = [...desks.map((d) => ({ x: d.x, y: d.y - 24 })), { x: whiteboard.x - 30, y: whiteboard.y + 60 }, { x: server.x + 40, y: server.y - 30 }, { x: coffee.x, y: coffee.y + 40 }];

  // click -> assign task
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = W / rect.width, sy = H / rect.height;
    const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
    for (const a of agents) {
      if (Math.hypot(mx - a.pos.x, my - a.pos.y) < 22) {
        switchView('assistant');
        $('#chatInput').value = `Ask ${a.name} to help me with: `;
        $('#chatInput').focus();
        addActivity(a.name, 'received a new task from you');
        return;
      }
    }
  });

  function assignTask(name, task) {
    const a = agents.find((x) => x.name === name);
    if (!a) return;
    a.state = 'busy'; a.task = task || 'Working…'; a.timer = 0;
    addActivity(name, 'started: ' + a.task);
  }
  window.__assignAgentTask = assignTask;

  function drawFloor() {
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  }

  function drawDesk(d, a) {
    ctx.fillStyle = 'rgba(20,28,44,0.9)';
    ctx.fillRect(d.x - 44, d.y, 88, 8);       // tabletop
    ctx.fillRect(d.x - 36, d.y - 26, 72, 26); // back panel
    ctx.fillStyle = '#0a0f1a';
    ctx.fillRect(d.x - 28, d.y - 20, 56, 16); // screen
    ctx.fillStyle = a.color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(d.x - 28, d.y - 20, 56, 16);
    ctx.globalAlpha = 1;
    // nameplate
    ctx.fillStyle = '#111a2c';
    ctx.fillRect(d.x - 20, d.y + 2, 40, 10);
    ctx.fillStyle = '#9fb2d0';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(a.name.toUpperCase(), d.x, d.y + 10);
  }

  function drawWhiteboard() {
    ctx.fillStyle = '#e8eef7';
    ctx.fillRect(whiteboard.x, whiteboard.y, 8, 70);
    ctx.fillStyle = '#fff';
    ctx.fillRect(whiteboard.x + 8, whiteboard.y + 4, 4, 62);
    // scribbles
    ctx.fillStyle = '#2b4b8a';
    ctx.fillRect(whiteboard.x + 16, whiteboard.y + 8, 20, 3);
    ctx.fillRect(whiteboard.x + 16, whiteboard.y + 16, 14, 3);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(whiteboard.x + 16, whiteboard.y + 26, 18, 3);
  }

  function drawServer() {
    ctx.fillStyle = '#182238';
    ctx.fillRect(server.x, server.y, 44, 60);
    ctx.fillStyle = '#0c1424';
    for (let i = 0; i < 4; i++) ctx.fillRect(server.x + 4, server.y + 6 + i * 14, 36, 10);
    // blinking LEDs
    for (let i = 0; i < 4; i++) {
      const on = (Math.floor(Date.now() / 400) + i) % 3 !== 0;
      ctx.fillStyle = on ? (i % 2 ? '#4be3a1' : '#ffd166') : '#334';
      ctx.fillRect(server.x + 40, server.y + 9 + i * 14, 4, 4);
    }
  }

  function drawCoffee() {
    ctx.fillStyle = '#2a1a12';
    ctx.fillRect(coffee.x, coffee.y, 30, 34);
    ctx.fillStyle = '#1a0f0a';
    ctx.fillRect(coffee.x + 2, coffee.y + 4, 26, 10);
    ctx.fillStyle = '#5b3a1e';
    ctx.fillRect(coffee.x + 12, coffee.y + 16, 8, 12);
    ctx.fillStyle = '#0a0f1a';
    ctx.fillRect(coffee.x + 26, coffee.y + 8, 8, 12); // cup
  }

  function drawAgent(a, t) {
    const bob = a.state === 'busy' ? Math.sin(t * 0.02) * 1.5 : Math.abs(Math.sin(t * 0.01 + a.phase)) * 2;
    const x = Math.round(a.pos.x), y = Math.round(a.pos.y) - Math.round(bob);
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(x - 6, a.pos.y + 8, 12, 3);
    // legs
    ctx.fillStyle = '#1a2336';
    ctx.fillRect(x - 4, y + 10, 3, 8);
    ctx.fillRect(x + 1, y + 10, 3, 8);
    // body
    ctx.fillStyle = a.color;
    ctx.fillRect(x - 5, y + 2, 10, 9);
    // head
    ctx.fillStyle = '#f0c9a8';
    ctx.fillRect(x - 4, y - 8, 8, 8);
    // eyes
    ctx.fillStyle = '#111';
    ctx.fillRect(x - 2, y - 5, 2, 2);
    ctx.fillRect(x + 2, y - 5, 2, 2);
    // status ring
    const ringColor = a.state === 'busy' ? '#ffc24b' : a.state === 'done' ? accent() : '#3dff9a';
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y + 2, 11, 0, Math.PI * 2);
    ctx.stroke();
    // name
    ctx.fillStyle = '#9fb2d0';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(a.name, x, y - 14);
  }

  function drawBubble(a) {
    if (a.state === 'idle') return;
    const lines = wrapText(a.task, 18);
    const bw = Math.min(150, Math.max(60, ...lines.map((l) => l.length)) * 6 + 12);
    const bh = lines.length * 9 + 10;
    const bx = a.pos.x - bw / 2, by = a.pos.y - 34 - bh;
    ctx.fillStyle = 'rgba(6,10,18,0.92)';
    ctx.strokeStyle = a.state === 'done' ? accent() : '#ffc24b';
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, bw, bh, 6);
    ctx.fill(); ctx.stroke();
    // tail
    ctx.beginPath(); ctx.moveTo(a.pos.x - 3, by + bh); ctx.lineTo(a.pos.x, a.pos.y - 24); ctx.lineTo(a.pos.x + 3, by + bh); ctx.closePath();
    ctx.fillStyle = 'rgba(6,10,18,0.92)'; ctx.fill();
    ctx.fillStyle = '#dfe8ff';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, a.pos.x, by + 12 + i * 9));
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  function wrapText(text, max) {
    const words = String(text).split(' ');
    const lines = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length <= max) cur = (cur + ' ' + w).trim();
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 4);
  }

  function updateAgent(a) {
    a.timer++;
    if (a.state === 'busy') {
      // walk home, work, then done
      moveToward(a, a.home);
      if (Math.hypot(a.pos.x - a.home.x, a.pos.y - a.home.y) < 4) {
        if (a.timer > 160) { a.state = 'done'; a.timer = 0; addActivity(a.name, 'completed: ' + a.task); }
      }
      return;
    }
    if (a.state === 'done') {
      if (a.timer > 220) { a.state = 'idle'; a.task = ''; a.timer = 0; }
      return;
    }
    // idle wander
    if (Math.hypot(a.pos.x - a.target.x, a.pos.y - a.target.y) < 3 || a.timer > 400) {
      a.target = waypoints[Math.floor(Math.random() * waypoints.length)];
      a.timer = 0;
    }
    moveToward(a, a.target);
  }

  function moveToward(a, tgt) {
    const dx = tgt.x - a.pos.x, dy = tgt.y - a.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const sp = a.state === 'busy' ? 1.2 : 0.5;
    a.pos.x += (dx / d) * sp;
    a.pos.y += (dy / d) * sp;
  }

  // legend
  const legend = $('#townLegend');
  legend.innerHTML = '';
  agents.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'legend-agent';
    div.innerHTML = `<span class="legend-dot idle" id="lg-${a.name}"></span><span>${a.name} — <span class="dim">${a.role}</span></span>`;
    legend.appendChild(div);
  });

  let raf;
  function loop(t) {
    ctx.clearRect(0, 0, W, H);
    drawFloor();
    drawWhiteboard(); drawServer(); drawCoffee();
    agents.forEach((a, i) => { drawDesk(desks[i], a); });
    agents.forEach((a) => updateAgent(a));
    agents.forEach((a) => drawAgent(a, t));
    agents.forEach((a) => drawBubble(a));
    // update legend dots
    agents.forEach((a) => {
      const dot = document.getElementById('lg-' + a.name);
      if (dot) { dot.className = 'legend-dot ' + a.state; }
    });
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
}

function addActivity(who, text) {
  const feed = $('#activityFeed');
  if (!feed) return;
  if (feed.querySelector('.empty')) feed.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'activity-item';
  const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  div.innerHTML = `<span class="who">${escapeHtml(who)}</span> ${escapeHtml(text)}<span class="when">${t}</span>`;
  feed.prepend(div);
  while (feed.children.length > 30) feed.removeChild(feed.lastChild);
}

function renderMissionLog() {
  const log = $('#missionLog');
  if (!log) return;
  const actions = (memory.actionLog || []).slice(0, 40);
  if (!actions.length) { log.innerHTML = '<div class="empty">No actions performed yet. Every action GemAI takes will be logged here.</div>'; return; }
  log.innerHTML = '';
  actions.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'mission-item';
    const t = new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    div.innerHTML = `<div class="m-action">▸ ${escapeHtml(a.action)} <span class="m-time">${t}</span></div><div class="m-detail">${escapeHtml(a.detail)}</div>`;
    log.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Memory / Notes / Reminders rendering
// ---------------------------------------------------------------------------
function renderFacts() {
  const list = $('#memoryList');
  const facts = (memory.facts || []).slice().sort((a, b) => (b.importance || 0) - (a.importance || 0));
  $('#factCount').textContent = '— ' + facts.length + ' remembered';
  if (!facts.length) { list.innerHTML = '<div class="empty">No memories yet — talk to the assistant and it will remember automatically.</div>'; return; }
  list.innerHTML = '';
  facts.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'memory-item';
    div.innerHTML = `<span class="tag">${escapeHtml((f.category || 'fact').toUpperCase())}</span><span class="body">${escapeHtml(f.text)}</span><button class="del-btn" title="Forget">✕</button>`;
    div.querySelector('.del-btn').addEventListener('click', async () => { await api.memoryDeleteFact(f.id); await loadMemory(); renderFacts(); animateCircuits(); });
    list.appendChild(div);
  });
}
function renderNotes() {
  const list = $('#notesList');
  if (!memory.notes.length) { list.innerHTML = '<div class="empty">No notes yet.</div>'; return; }
  list.innerHTML = '';
  memory.notes.forEach((n) => {
    const div = document.createElement('div');
    div.className = 'note-item';
    div.innerHTML = `<span class="body">${escapeHtml(n.text)}</span><button class="del-btn" title="Delete">✕</button>`;
    div.querySelector('.del-btn').addEventListener('click', async () => { await api.memoryDeleteNote(n.id); await loadMemory(); renderNotes(); });
    list.appendChild(div);
  });
}
function renderReminders() {
  const list = $('#remindersList');
  const rems = memory.reminders.slice().sort((a, b) => a.at - b.at);
  if (!rems.length) { list.innerHTML = '<div class="empty">No reminders yet.</div>'; return; }
  list.innerHTML = '';
  rems.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'reminder-item' + (r.done ? ' done' : '');
    div.innerHTML = `
      <button class="tick-btn" title="Toggle done">${r.done ? '✓' : ''}</button>
      <span class="body">${escapeHtml(r.text)}<small>${r.done ? 'done' : new Date(r.at).toLocaleString()}</small></span>
      <button class="del-btn" title="Delete">✕</button>`;
    div.querySelector('.tick-btn').addEventListener('click', async () => { await api.memoryMarkReminder(r.id, !r.done); await loadMemory(); renderReminders(); });
    div.querySelector('.del-btn').addEventListener('click', async () => { await api.memoryDeleteReminder(r.id); await loadMemory(); renderReminders(); });
    list.appendChild(div);
  });
}
function renderAllMemory() { renderFacts(); renderNotes(); renderReminders(); updateTranscriptCount(); renderGoals(); renderMood(); renderMissionLog(); }

// ---------------------------------------------------------------------------
// Companion: mood, goals, wellness
// ---------------------------------------------------------------------------
function updateMoodIndicator(emo) {
  const e = emo || currentEmotion;
  const emojiEl = $('#moodEmoji'), labelEl = $('#moodLabel'), subEl = $('#moodSub');
  if (!emojiEl) return;
  emojiEl.textContent = MOOD_EMOJI[e.emotion] || '😊';
  const names = { joy: 'Joyful', excitement: 'Excited', love: 'Loving', gratitude: 'Grateful', confident: 'Confident', curiosity: 'Curious', neutral: 'Neutral', boredom: 'Bored', tired: 'Tired', anxiety: 'Anxious', sadness: 'Down', fear: 'Afraid', anger: 'Frustrated' };
  labelEl.textContent = names[e.emotion] || 'Neutral';
  subEl.textContent = e.confidence > 0.5 ? 'I can feel it — tell me more.' : 'Your current emotional state';
}

function renderMood() {
  const canvas = $('#moodCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const mood = (memory.mood || []).slice(-30);
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ff3b3b';

  if (!mood.length) {
    ctx.fillStyle = '#71809c'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No mood data yet — check in or just talk to me.', w / 2, h / 2);
    return;
  }

  const pad = 20;
  const maxW = w - pad * 2, maxH = h - pad * 2;
  const midY = pad + maxH / 2;

  // baseline
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad, midY); ctx.lineTo(w - pad, midY); ctx.stroke();
  ctx.setLineDash([]);

  const pts = mood.map((m, i) => ({
    x: pad + (i / Math.max(1, mood.length - 1)) * maxW,
    y: midY - (m.valence || 0) * (maxH / 2) * 0.9
  }));

  // area fill
  const grad = ctx.createLinearGradient(0, pad, 0, h - pad);
  grad.addColorStop(0, hexToRgba(accent, 0.35)); grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(pts[0].x, midY);
  pts.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length - 1].x, midY);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // line
  ctx.beginPath();
  ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  ctx.shadowColor = accent; ctx.shadowBlur = 8;
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  ctx.shadowBlur = 0;

  // dots
  pts.forEach((p) => {
    ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
  });
}

function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function renderGoals() {
  const list = $('#goalsList');
  if (!list) return;
  const goals = (memory.goals || []).slice();
  if (!goals.length) { list.innerHTML = '<div class="empty">No goals yet. Tell the assistant "I want to become a…" and it will help you set goals.</div>'; return; }
  list.innerHTML = '';
  const order = { career: 0, study: 1, health: 2, finance: 3, personal: 4, relationship: 5 };
  goals.sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || (a.done - b.done));
  goals.forEach((g) => {
    const div = document.createElement('div');
    div.className = 'goal-item' + (g.done ? ' done' : '');
    div.innerHTML = `
      <button class="tick-btn" title="Toggle">${g.done ? '✓' : ''}</button>
      <span class="body"><span class="cat">${escapeHtml((g.category || 'personal').toUpperCase())}</span>${escapeHtml(g.text)}</span>
      <button class="del-btn" title="Delete">✕</button>`;
    div.querySelector('.tick-btn').addEventListener('click', async () => { await api.memoryToggleGoal(g.id); await loadMemory(); renderGoals(); });
    div.querySelector('.del-btn').addEventListener('click', async () => { await api.memoryDeleteGoal(g.id); await loadMemory(); renderGoals(); });
    list.appendChild(div);
  });
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
const WELLNESS_TIPS = {
  focus: ['Work in 25-minute sprints (Pomodoro) with 5-minute breaks — your focus peaks in bursts.', 'Single-task: close distracting tabs and give one thing your full attention for 20 minutes.'],
  stress: ['Try the 4-7-8 breath: inhale 4s, hold 7s, exhale 8s. Repeat 4 times to calm your nervous system.', 'Write down what is stressing you — naming it reduces its grip on your mind.'],
  sleep: ['Keep a consistent sleep schedule, even on weekends. Your brain loves rhythm.', 'Stop screens 30-60 minutes before bed; dim light signals your body to produce melatonin.'],
  energy: ['Drink a glass of water right now — mild dehydration is the #1 hidden energy drain.', 'A 5-minute walk in daylight resets your energy better than another coffee.'],
  productivity: ["The 2-minute rule: if a task takes under 2 minutes, do it immediately.", "Plan tomorrow's top 3 priorities tonight, so you start focused instead of deciding."],
  motivation: ['Motivation follows action, not the other way round. Start tiny — momentum builds itself.', 'Remind yourself of your why. Connect the task to a goal that genuinely matters to you.']
};
function showAffirmation() {
  const el = $('#affirmation');
  if (el) el.textContent = '"' + AFFIRMATIONS[Math.floor(Math.random() * AFFIRMATIONS.length)] + '"';
}
function showWellnessTip(area) {
  const list = WELLNESS_TIPS[area] || WELLNESS_TIPS.motivation;
  const el = $('#tipBox');
  if (el) el.textContent = list[Math.floor(Math.random() * list.length)];
  $$('.tip-chip').forEach((c) => c.classList.toggle('active', c.dataset.area === area));
}

function updateTranscriptCount() {
  const el = $('#transcriptCount'); if (el) el.textContent = (memory.transcript || []).length;
}

function animateCircuits() {
  const memPct = Math.min(100, Math.round(30 + (memory.facts || []).length * 8));
  const soulPct = Math.round(((profile.soul?.warmth ?? 60) + (profile.soul?.wit ?? 40)) / 2);
  $('#memCircuit').style.width = memPct + '%'; $('#memCircuitVal').textContent = memPct + '%';
  $('#skillCircuit').style.width = '85%'; $('#skillCircuitVal').textContent = '85%';
  $('#soulCircuit').style.width = soulPct + '%'; $('#soulCircuitVal').textContent = soulPct + '%';
}

// ---------------------------------------------------------------------------
// 2D command map (World Monitor)
// ---------------------------------------------------------------------------
function startCommandMap() {
  const canvas = $('#mapCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ff3b3b';

  // stylized continents (rough blobs) + city markers
  const cities = [
    { name: 'NYC', lat: 40.7, lon: -74 }, { name: 'LON', lat: 51.5, lon: -0.1 },
    { name: 'TYO', lat: 35.7, lon: 139.7 }, { name: 'SYD', lat: -33.9, lon: 151.2 },
    { name: 'KHI', lat: 24.8, lon: 67 }, { name: 'DEL', lat: 28.6, lon: 77.2 },
    { name: 'SFO', lat: 37.8, lon: -122.4 }, { name: 'RIO', lat: -22.9, lon: -43.2 },
    { name: 'DXB', lat: 25.2, lon: 55.3 }, { name: 'SIN', lat: 1.35, lon: 103.8 }
  ];
  const continents = [
    { name: 'NA', x: 0.16, y: 0.22, w: 0.2, h: 0.22 }, { name: 'SA', x: 0.27, y: 0.52, w: 0.09, h: 0.26 },
    { name: 'EU', x: 0.47, y: 0.2, w: 0.12, h: 0.16 }, { name: 'AF', x: 0.47, y: 0.4, w: 0.12, h: 0.26 },
    { name: 'AS', x: 0.58, y: 0.16, w: 0.26, h: 0.24 }, { name: 'AU', x: 0.78, y: 0.62, w: 0.1, h: 0.14 }
  ];
  const proj = (lat, lon) => ({ x: (lon + 180) / 360 * W, y: (90 - lat) / 180 * H });

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, W, H);

    // graticule
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 12; i++) { const x = (i / 12) * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let i = 0; i <= 6; i++) { const y = (i / 6) * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // continents
    ctx.fillStyle = hexToRgba(accent, 0.12);
    continents.forEach((c) => {
      ctx.beginPath();
      ctx.ellipse(c.x * W + c.w * W / 2, c.y * H + c.h * H / 2, c.w * W / 2, c.h * H / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // city markers + arcs
    for (const c of cities) {
      const p = proj(c.lat, c.lon);
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.004 + c.lon);
      ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.9; ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = accent; ctx.globalAlpha = 0.3; ctx.arc(p.x, p.y, 4 + pulse * 5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.8; ctx.fillStyle = accent; ctx.font = '8px monospace'; ctx.textAlign = 'left';
      ctx.fillText(c.name, p.x + 5, p.y - 3);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------
// Headlines
// ---------------------------------------------------------------------------
async function refreshHeadlines() {
  const list = $('#newsList');
  list.innerHTML = '<div class="empty">Fetching headlines…</div>';
  try {
    const items = await api.getHeadlines(14);
    if (!items.length) { list.innerHTML = '<div class="empty">Could not reach the feed (offline).</div>'; return; }
    list.innerHTML = '';
    items.forEach((n) => {
      const div = document.createElement('div');
      div.className = 'news-item';
      div.innerHTML = `<div class="n-title">${escapeHtml(n.title)}</div><div class="n-meta">▲ ${n.score} · ${escapeHtml(n.by)}</div>`;
      div.addEventListener('click', () => api.openExternal(n.url));
      list.appendChild(div);
    });
  } catch (e) { list.innerHTML = '<div class="empty">Could not reach the feed (offline).</div>'; }
}

// ---------------------------------------------------------------------------
// Profile + memory persistence
// ---------------------------------------------------------------------------
async function loadProfile() {
  try { const saved = await api.getProfile(); if (saved && Object.keys(saved).length) profile = { ...profile, ...saved }; } catch (e) {}
}
async function loadMemory() {
  try { memory = await api.memoryGet(); } catch (e) {}
}
async function persistProfile() { try { await api.setProfile(profile); } catch (e) {} }

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function openSettings() {
  $('#setUserName').value = profile.name || '';
  $('#setBaseURL').value = (profile.ai?.baseURL) || '';
  $('#setApiKey').value = (profile.ai?.apiKey) || '';
  $('#setModel').value = (profile.ai?.model) || 'llama-3.3-70b-versatile';
  $('#setRate').value = profile.voice?.rate ?? 1.0;
  $('#setPitch').value = profile.voice?.pitch ?? 1.1;
  $('#rateVal').textContent = $('#setRate').value;
  $('#pitchVal').textContent = $('#setPitch').value;
  $('#setVoiceMode').value = profile.voice?.mode || 'neural';
  $('#setNeuralVoice').value = profile.voice?.neuralVoice || 'en';
  $('#setMemoryOn').checked = profile.memoryOn !== false;
  $('#setAllowShell').checked = !!profile.allowShell;
  $('#setWakeWord').checked = !!profile.wakeWord;
  populateVoices(); populateNeuralVoices(); updateAiHint();
  $('#settingsModal').classList.add('open');
}
function closeSettings() { $('#settingsModal').classList.remove('open'); }
function populateVoices() {
  const sel = $('#setVoice');
  const voices = speechSynthesis.getVoices();
  sel.innerHTML = '';
  voices.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.name; opt.textContent = v.name + (v.lang ? ' (' + v.lang + ')' : '');
    if (profile.voice?.name === v.name) opt.selected = true;
    sel.appendChild(opt);
  });
  if (!voices.length) { const o = document.createElement('option'); o.textContent = 'Default (auto female)'; sel.appendChild(o); }
}
function populateNeuralVoices() {
  const sel = $('#setNeuralVoice');
  sel.innerHTML = '';
  NEURAL_VOICES.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id; opt.textContent = v.label;
    if ((profile.voice?.neuralVoice || 'en') === v.id) opt.selected = true;
    sel.appendChild(opt);
  });
}
function updateAiHint() {
  const base = $('#setBaseURL').value.trim(), key = $('#setApiKey').value.trim();
  const el = $('#aiStatusHint');
  if (key && base) el.textContent = '✓ AI brain locked to your endpoint — GemAI will use THIS key only.';
  else if (base && /localhost|127\.0\.0\.1/.test(base)) el.textContent = '✓ Local model detected (no key needed).';
  else el.textContent = 'No key set — running on the built-in offline brain.';
}
function applyPreset(p) {
  const map = {
    groq: { baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    openrouter: { baseURL: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct' },
    ollama: { baseURL: 'http://localhost:11434/v1', model: 'llama3', apiKey: '' },
    offline: { baseURL: '', apiKey: '', model: '' }
  };
  const v = map[p];
  if (v.baseURL !== undefined) $('#setBaseURL').value = v.baseURL;
  if (v.apiKey !== undefined) $('#setApiKey').value = v.apiKey;
  if (v.model !== undefined) $('#setModel').value = v.model;
  updateAiHint();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function bindEvents() {
  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $$('.theme-btn').forEach((b) => b.addEventListener('click', () => { profile.theme = b.dataset.theme; applyTheme(profile.theme); persistProfile(); }));

  // core tabs
  $$('.core-tab').forEach((t) => t.addEventListener('click', () => {
    $$('.core-tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.core-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
  }));

  // memory / notes / reminders add
  $('#factAdd').addEventListener('click', async () => { const v = $('#factInput').value.trim(); if (v) { await api.memoryAddFact({ text: v, category: 'fact' }); $('#factInput').value = ''; await loadMemory(); renderAllMemory(); animateCircuits(); } });
  $('#factInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#factAdd').click(); });
  $('#noteAdd').addEventListener('click', async () => { const v = $('#noteInput').value.trim(); if (v) { await api.memoryAddNote(v); $('#noteInput').value = ''; await loadMemory(); renderNotes(); } });
  $('#noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#noteAdd').click(); });
  $('#remAdd').addEventListener('click', async () => {
    const text = $('#remText').value.trim();
    if (!text) return;
    const whenRaw = $('#remWhen').value.trim();
    const at = whenRaw ? parseLocalWhen(whenRaw) : Date.now() + 3600000;
    await api.memoryAddReminder(text, at);
    $('#remText').value = ''; $('#remWhen').value = '';
    await loadMemory(); renderReminders();
  });
  $('#remWhen').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#remAdd').click(); });

  $('#clearTranscript').addEventListener('click', async () => { await api.memoryClearTranscript(); await loadMemory(); updateTranscriptCount(); addMessage('system-msg', 'Conversation history cleared (long-term memories kept).'); });

  // Companion: mood check-in
  $$('#moodBtns button').forEach((b) => b.addEventListener('click', async () => {
    const emo = analyzeEmotion(b.dataset.mood);
    currentEmotion = emo;
    updateMoodIndicator(emo);
    await api.memoryAddMood(emo.emotion, b.dataset.mood);
    await loadMemory();
    renderMood();
    toast('MOOD', 'Thanks for checking in. I\u2019ve got you.', MOOD_EMOJI[emo.emotion] || '💙');
  }));

  // Companion: goals
  $('#goalAdd').addEventListener('click', async () => {
    const v = $('#goalInput').value.trim();
    if (!v) return;
    await api.memoryAddGoal(v, $('#goalCategory').value);
    $('#goalInput').value = '';
    await loadMemory(); renderGoals();
  });
  $('#goalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#goalAdd').click(); });

  // Companion: wellness
  $('#newAffirmation').addEventListener('click', showAffirmation);
  $$('.tip-chip').forEach((c) => c.addEventListener('click', () => showWellnessTip(c.dataset.area)));

  // Companion: career prompts
  $$('.prompt-chip').forEach((c) => c.addEventListener('click', () => {
    switchView('assistant');
    $('#chatInput').value = c.dataset.prompt;
    $('#chatInput').focus();
  }));

  // settings
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target === $('#settingsModal')) closeSettings(); });
  $('#groqLink').addEventListener('click', () => api.openExternal('https://console.groq.com/keys'));
  $('#saveBtn').addEventListener('click', () => {
    profile.name = $('#setUserName').value.trim() || 'Commander';
    profile.ai = { baseURL: $('#setBaseURL').value.trim(), apiKey: $('#setApiKey').value.trim(), model: $('#setModel').value.trim() || 'llama-3.3-70b-versatile' };
    profile.voice = profile.voice || {};
    profile.voice.rate = Number($('#setRate').value);
    profile.voice.pitch = Number($('#setPitch').value);
    profile.voice.mode = $('#setVoiceMode').value;
    profile.voice.neuralVoice = $('#setNeuralVoice').value;
    profile.voice.name = $('#setVoice').value;
    profile.memoryOn = $('#setMemoryOn').checked;
    profile.allowShell = $('#setAllowShell').checked;
    profile.wakeWord = $('#setWakeWord').checked;
    persistProfile().then(() => { updateLinkMode(); closeSettings(); });
    configureWakeWord(profile.wakeWord);
  });
  $('#resetBtn').addEventListener('click', async () => {
    profile = { name: 'Commander', theme: 'crimson', ai: { baseURL: '', apiKey: '', model: 'llama-3.3-70b-versatile' }, voice: { rate: 1.0, pitch: 1.1, mode: 'neural', neuralVoice: 'en', name: '' }, memoryOn: true, allowShell: false, wakeWord: false };
    await persistProfile(); applyTheme('crimson'); updateLinkMode(); openSettings();
  });
  $$('.preset').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  $('#setBaseURL').addEventListener('input', updateAiHint);
  $('#setApiKey').addEventListener('input', updateAiHint);

  // quick commands
  $$('.qc').forEach((b) => b.addEventListener('click', () => {
    switchView('assistant');
    $('#chatInput').value = b.dataset.cmd;
    $('#chatInput').focus();
  }));

  // test AI connection
  $('#testConn').addEventListener('click', async () => {
    const resEl = $('#testResult');
    resEl.className = 'test-result'; resEl.textContent = 'Testing…';
    const cfg = { baseURL: $('#setBaseURL').value.trim(), apiKey: $('#setApiKey').value.trim(), model: $('#setModel').value.trim() || 'llama-3.3-70b-versatile' };
    try {
      const res = await api.aiChat(cfg, [{ role: 'user', content: 'Reply with exactly: OK' }]);
      if (res.ok) { resEl.textContent = '✓ Connected'; resEl.classList.add('ok'); }
      else { resEl.textContent = '✗ ' + humanError(res.error); resEl.classList.add('bad'); }
    } catch (e) { resEl.textContent = '✗ ' + e.message; resEl.classList.add('bad'); }
  });

  // command palette
  const palette = $('#palette'), pInput = $('#paletteInput');
  function openPalette() { palette.classList.add('open'); setTimeout(() => pInput.focus(), 30); }
  function closePalette() { palette.classList.remove('open'); pInput.value = ''; }
  $$('.accent-link[data-pal]').forEach((l) => l.addEventListener('click', () => { switchView(l.dataset.pal); closePalette(); }));
  pInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = pInput.value.trim(); closePalette(); if (v) { switchView('assistant'); sendMessage(v); } }
    if (e.key === 'Escape') closePalette();
  });

  // keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { $('#chatInput').focus(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === ',') { openSettings(); }
    else if (e.key === 'Escape') { closeSettings(); closePalette(); }
  });

  // voice preview + sliders
  $('#previewVoice').addEventListener('click', () => {
    const prevMode = profile.voice.mode;
    const prevNeural = profile.voice.neuralVoice;
    profile.voice.mode = $('#setVoiceMode').value;
    profile.voice.neuralVoice = $('#setNeuralVoice').value;
    profile.voice.name = $('#setVoice').value;
    profile.voice.rate = Number($('#setRate').value);
    profile.voice.pitch = Number($('#setPitch').value);
    speak('Hello, I am GemAI, your personal assistant. How can I help you today?');
    profile.voice.mode = prevMode; profile.voice.neuralVoice = prevNeural;
  });
  $('#setRate').addEventListener('input', () => { $('#rateVal').textContent = $('#setRate').value; });
  $('#setPitch').addEventListener('input', () => { $('#pitchVal').textContent = $('#setPitch').value; });
  $('#setVoiceMode').addEventListener('change', () => {
    const neural = $('#setVoiceMode').value === 'neural';
    $('#setNeuralVoice').disabled = !neural;
    $('#previewVoice').disabled = false;
  });

  // chat
  $('#sendBtn').addEventListener('click', () => sendMessage($('#chatInput').value));
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage($('#chatInput').value); });

  // start AI loop
  $('#startBtn').addEventListener('click', () => {
    if (isRunning) { isRunning = false; $('#startBtn').classList.remove('running'); $('#startLabel').textContent = 'START AI'; $('#orbStatus').textContent = 'STANDBY'; $('#orbStatus').classList.remove('active'); stopListening(); }
    else { startAiLoop(); addMessage('system-msg', 'AI online. Speak naturally — I\u2019m listening.'); speak('Systems online. How can I help?'); }
  });

  $('#micBtn').addEventListener('click', () => {
    if (!recognition) { addMessage('system-msg', 'Speech recognition unavailable here — type a command instead.'); return; }
    if (listening) stopListening();
    else { listening = true; $('#micBtn').classList.add('recording'); try { recognition.start(); } catch (e) {} }
  });

  $('#refreshNews').addEventListener('click', refreshHeadlines);

  // reminders from main process
  api.onReminder((r) => {
    addMessage('system-msg', `⏰ REMINDER: ${r.text}`);
    speak('Reminder: ' + r.text);
  });

  // tray "start listening"
  api.onWakeToggle((on) => { if (on) startAiLoop(); });

  configureWakeWord(profile.wakeWord);
}

// Start the assistant loop (used by START button + wake word)
function startAiLoop() {
  isRunning = true;
  $('#startBtn').classList.add('running');
  $('#startLabel').textContent = 'AI ONLINE';
  $('#orbStatus').textContent = 'LISTENING · SPEAK NOW';
  $('#orbStatus').classList.add('active');
  if (recognition) { try { recognition.start(); $('#micBtn').classList.add('recording'); } catch (e) {} }
}

// Continuous wake-word listening ("Hey GemAI")
let wakeRecognition = null;
function configureWakeWord(enabled) {
  if (!enabled) {
    if (wakeRecognition) { try { wakeRecognition.stop(); } catch (e) {} }
    wakeRecognition = null;
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (!wakeRecognition) {
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = 'en-US';
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = (e.results[i][0].transcript || '').toLowerCase();
        if (/hey gemai|hey gem|a gemai|hi gemai/.test(t)) {
          addMessage('system-msg', 'Wake word detected — going online.');
          startAiLoop();
          speak('Yes? I am listening.');
        }
      }
    };
    r.onerror = () => { /* silently restart handled by onend */ };
    r.onend = () => { if (profile.wakeWord && wakeRecognition) { try { r.start(); } catch (e) {} } };
    wakeRecognition = r;
  }
  try { wakeRecognition.start(); } catch (e) {}
  addMessage('system-msg', 'Wake word armed — say "Hey GemAI" anytime.');
}

function stopListening() {
  listening = false;
  $('#micBtn').classList.remove('recording');
  if (recognition) { try { recognition.stop(); } catch (e) {} }
}

function parseLocalWhen(text) {
  const rel = text.match(/in\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)/i);
  if (rel) {
    const n = parseInt(rel[1], 10), u = rel[2].toLowerCase();
    return Date.now() + n * (u.startsWith('sec') || u === 's' ? 1000 : u.startsWith('min') || u === 'm' ? 60000 : u.startsWith('hour') || u === 'h' ? 3600000 : 86400000);
  }
  const parsed = Date.parse(text);
  return isNaN(parsed) ? Date.now() + 3600000 : parsed;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // animated boot sequence
  await runBootSequence();

  await loadProfile();
  await loadMemory();
  applyTheme(profile.theme || 'crimson');
  startBackground3D();
  startOrb(); startGlobe(); startCommandMap();
  startAgentTown(); renderAllMemory(); animateCircuits();
  bindEvents(); bindSoulSliders(); updateLinkMode();
  updateMoodIndicator(currentEmotion);
  setTimeout(() => startPanelTilt(), 300);

  // restore recent conversation history from persistent memory
  const last = (memory.transcript || []).slice(-40);
  const greeting = `${greetByTime()}, ${profile.name || 'Commander'}. All systems online and I remember everything about you.`;
  if (last.length) {
    addMessage('system-msg', `↻ Restored ${last.length} past messages from persistent memory.`);
    last.forEach((m) => { if (m.role === 'user') addMessage('user', m.content); else if (m.role === 'assistant') addMessage('ai', m.content); });
    last.forEach((m) => { if (m.role === 'user' || m.role === 'assistant') chatHistory.push({ role: m.role, content: m.content }); });
  } else {
    addMessage('ai', greeting);
    addMessage('system-msg', 'GemAI online. Paste a free Groq key in Settings for a full LLM brain — or just start talking, the offline brain already handles the web, weather, apps and files.');
  }

  if (!profile.ai?.apiKey) toast('TIP', 'Add a free Groq key in Settings → AI Brain for a full brain.', '⚡');

  pollSystem(); setInterval(pollSystem, 2500);
  recognition = initRecognition();
  if (speechSynthesis) speechSynthesis.onvoiceschanged = populateVoices;
  try { $('#verTag').textContent = 'v' + (await api.version()); } catch (e) {}

  if (profile.wakeWord) configureWakeWord(true);

  // speak the greeting
  if (!last.length) setTimeout(() => speak(greeting), 800);
}

function runBootSequence() {
  const overlay = $('#bootOverlay');
  if (!overlay) return Promise.resolve();
  const lines = ['INITIALIZING CORE…', 'LOADING MEMORY…', 'CALIBRATING VOICE…', 'LINKING TOOLS…', 'ONLINE'];
  return new Promise((resolve) => {
    let i = 0;
    const bar = $('#bootBar'), line = $('#bootLine');
    const tick = () => {
      if (i < lines.length) {
        line.textContent = lines[i];
        bar.style.width = Math.round(((i + 1) / lines.length) * 100) + '%';
        i++;
        setTimeout(tick, i === lines.length ? 350 : 380);
      } else {
        overlay.classList.add('done');
        setTimeout(resolve, 450);
      }
    };
    tick();
  });
}

function bindSoulSliders() {
  const pairs = [['#soulWarmth', 'warmth', '#soulWarmthVal'], ['#soulWit', 'wit', '#soulWitVal'], ['#soulBrevity', 'brevity', '#soulBrevityVal']];
  pairs.forEach(([sel, key, valSel]) => {
    const el = $(sel); if (!el) return;
    el.value = profile.soul?.[key] ?? el.value;
    const update = () => { $(valSel).textContent = el.value; profile.soul = profile.soul || {}; profile.soul[key] = Number(el.value); persistProfile(); animateCircuits(); };
    el.addEventListener('input', update); update();
  });
}

document.addEventListener('DOMContentLoaded', boot);
