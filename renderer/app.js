/* ============================================================
   GemAir — renderer application logic
   ============================================================ */
'use strict';

// ---------------------------------------------------------------------------
// Bridge: Electron IPC (or a mock when opened in a plain browser preview)
// ---------------------------------------------------------------------------
const isElectron = !!(window.gemair);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK_MEMORY = {
  facts: [
    { id: 'm1', text: "User's name is Commander", category: 'identity', importance: 2 },
    { id: 'm2', text: 'User prefers concise answers', category: 'preference', importance: 1 }
  ],
  transcript: [],
  notes: [{ id: 'n1', text: 'Welcome to GemAir — your persistent notebook.' }],
  reminders: [],
  todos: [],
  mood: [],
  goals: [],
  skills: [],
  instructions: [],
  actionLog: [],
  summary: ''
};

const api = {
  platform: window.gemair ? window.gemair.platform : 'browser',
  async getSystemInfo() {
    if (window.gemair) return window.gemair.getSystemInfo();
    const total = 16 * 1024 * 1024 * 1024;
    const used = total * (0.4 + 0.25 * Math.random());
    return {
      platform: 'browser-preview', release: 'n/a', hostname: 'gemair.local', arch: 'x64', cpus: 8,
      cpuLoad: Math.round(10 + Math.random() * 40), memTotal: total, memFree: total - used, memUsed: used,
      memPercent: Math.round((used / total) * 100), uptime: 3600 * 14, loadavg: [0.8, 1.1, 1.3]
    };
  },
  async getProfile() { if (window.gemair) return window.gemair.getProfile(); return window.webStore ? window.webStore.getProfile() : {}; },
  async setProfile(d) { if (window.gemair) return window.gemair.setProfile(d); if (window.webStore) await window.webStore.setProfile(d); },

  async _webChat(messages) {
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
      return await r.json();
    } catch (e) { return { ok: false, error: e.message }; }
  },
  async aiChat(config, messages) {
    if (window.gemair) return window.gemair.aiChat(config, messages);
    return await this._webChat(messages);
  },
  async aiChatStream(config, messages, onDelta) {
    if (window.gemair) return window.gemair.aiChatStream(config, messages, onDelta);
    const res = await this._webChat(messages);
    if (!res.ok) return res;
    const text = res.reply;
    for (const ch of text) { onDelta(ch); await sleep(12); } // simulate streaming locally
    return { ok: true, reply: text };
  },
  async aiSummarize(config, text) { if (window.gemair) return window.gemair.aiSummarize(config, text); return { ok: true, summary: null }; },
  async aiOffline(text) {
    if (window.gemair) return window.gemair.aiOffline(text);
    return { ok: true, reply: await offlineBrain(text) };
  },

  // memory (Electron IPC | browser localStorage + optional Supabase)
  async memoryGet() { if (window.gemair) return window.gemair.memoryGet(); return window.webStore ? window.webStore.get() : JSON.parse(JSON.stringify(MOCK_MEMORY)); },
  async memoryAppend(role, content) { if (window.gemair) return window.gemair.memoryAppend(role, content); if (window.webStore) await window.webStore.append(role, content); },
  async memoryClearTranscript() { if (window.gemair) return window.gemair.memoryClearTranscript(); if (window.webStore) await window.webStore.clearTranscript(); },
  async memoryAddFact(fact) { if (window.gemair) return window.gemair.memoryAddFact(fact); if (window.webStore) await window.webStore.addFact(fact); },
  async memoryDeleteFact(id) { if (window.gemair) return window.gemair.memoryDeleteFact(id); if (window.webStore) await window.webStore.deleteFact(id); },
  async memoryAddNote(text) { if (window.gemair) return window.gemair.memoryAddNote(text); if (window.webStore) await window.webStore.addNote(text); },
  async memoryDeleteNote(id) { if (window.gemair) return window.gemair.memoryDeleteNote(id); if (window.webStore) await window.webStore.deleteNote(id); },
  async memoryAddReminder(text, at) { if (window.gemair) return window.gemair.memoryAddReminder(text, at); if (window.webStore) await window.webStore.addReminder(text, at); },
  async memoryDeleteReminder(id) { if (window.gemair) return window.gemair.memoryDeleteReminder(id); if (window.webStore) await window.webStore.deleteReminder(id); },
  async memoryMarkReminder(id, done) { if (window.gemair) return window.gemair.memoryMarkReminder(id, done); if (window.webStore) await window.webStore.markReminder(id, done); },
  async memoryExtract(config, u, a) {
    if (window.gemair) return window.gemair.memoryExtract(config, u, a);
    const facts = localExtract(u); let n = 0;
    const mem = window.webStore ? await window.webStore.get() : MOCK_MEMORY;
    for (const f of facts) { if (!mem.facts.some(x => x.text === f.text)) { await this.memoryAddFact(f); n++; } }
    return n;
  },
  async memoryAddMood(emotion, note) { if (window.gemair) return window.gemair.memoryAddMood(emotion, note); if (window.webStore) await window.webStore.addMood(emotion, note); },
  async memoryAddGoal(text, category) { if (window.gemair) return window.gemair.memoryAddGoal(text, category); if (window.webStore) await window.webStore.addGoal(text, category); },
  async memoryDeleteGoal(id) { if (window.gemair) return window.gemair.memoryDeleteGoal(id); if (window.webStore) await window.webStore.deleteGoal(id); },
  async memoryToggleGoal(id) { if (window.gemair) return window.gemair.memoryToggleGoal(id); if (window.webStore) await window.webStore.toggleGoal(id); },
  async memoryAddSkill(text, name) { if (window.gemair) return window.gemair.memoryAddSkill(text, name); if (window.webStore) await window.webStore.addSkill(text, name); },
  async memoryDeleteSkill(id) { if (window.gemair) return window.gemair.memoryDeleteSkill(id); if (window.webStore) await window.webStore.deleteSkill(id); },
  async memoryAddInstruction(text) { if (window.gemair) return window.gemair.memoryAddInstruction(text); if (window.webStore) await window.webStore.addInstruction(text); },
  async memoryDeleteInstruction(id) { if (window.gemair) return window.gemair.memoryDeleteInstruction(id); if (window.webStore) await window.webStore.deleteInstruction(id); },
  async analyzeEmotion(text) { return window.gemair ? window.gemair.analyzeEmotion(text) : analyzeEmotion(text); },

  async saveCode(content, name) {
    if (window.gemair) return window.gemair.saveCode(content, name);
    downloadText(content, name || 'gemair-output.txt');
    return { ok: true, path: name || 'gemair-output.txt' };
  },
  async getHeadlines(limit) {
    if (window.gemair) return window.gemair.getHeadlines(limit);
    try { const r = await fetch('/api/headlines?limit=' + (limit || 14)); return await r.json(); } catch { return []; }
  },
  openExternal(url) { if (window.gemair) window.gemair.openExternal(url); else window.open(url, '_blank'); },
  async version() { return window.gemair ? window.gemair.version() : '1.0.0'; },
  onReminder(cb) { if (window.gemair) window.gemair.onReminder(cb); },
  onWakeToggle(cb) { if (window.gemair) window.gemair.onWakeToggle(cb); },

  // report & backup
  async generateReport() {
    if (window.gemair) return window.gemair.generateReport();
    return buildReportOffline();
  },
  async needsCheckIn() {
    if (window.gemair) return window.gemair.needsCheckIn();
    const mood = (memory.mood || []).slice(-7);
    if (mood.length < 3) return false;
    const vals = mood.map((x) => x.valence || 0);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return avg < 0.2 && vals[vals.length - 1] < 0;
  },
  async exportMemory() {
    if (window.gemair) return window.gemair.exportMemory();
    return { memory, profile };
  },
  async importMemory(data) {
    if (window.gemair) return window.gemair.importMemory(data);
    if (data && data.memory) { memory = { ...memory, ...data.memory }; if (window.webStore) await window.webStore.setMemoryLocal(data.memory); }
    if (data && data.profile) { profile = { ...profile, ...data.profile }; await persistProfile(); }
    return { ok: true };
  }
};

// trigger a browser download (web-mode "save to file")
function downloadText(content, name) {
  try {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  } catch (e) {}
}

const mockHeadlines = [
  { title: 'Open-source JARVIS-style assistants are on the rise', score: 421, by: 'gemair', url: '#' },
  { title: 'Local-first AI: why running models on your own machine matters', score: 388, by: 'dev', url: '#' },
  { title: 'Voice interfaces are quietly taking over the desktop', score: 312, by: 'ui', url: '#' }
];

// ---------------------------------------------------------------------------
// Free web tools (Vercel API — no key, no AI needed)
// ---------------------------------------------------------------------------
async function webGet(path, params) {
  try {
    const qs = new URLSearchParams(params || {}).toString();
    const r = await fetch('/api/' + path + (qs ? '?' + qs : ''));
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

// ---------------------------------------------------------------------------
// Offline brain (browser/web mirror) — genuinely searches the web for free
// ---------------------------------------------------------------------------
async function offlineBrain(text) {
  // route on the typo-repaired text; keep `text` for anything echoed back
  const q = normaliseInput(text);
  if (!q) return "I didn't catch that. Say it again?";
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

  if (/^(hi|hello|hey|salam|yo|good (morning|evening|afternoon))\b/.test(q) && q.length < 14)
    return 'Hello. GemAir online. I can search the web, check weather, prices, translate and more — all free, no API key needed.';
  if (/your name|who are you/.test(q)) return "I'm GemAir — your personal AI. I understand how you feel and I search the real web for free (no API key required).";
  if (/how are you/.test(q)) return 'All circuits nominal — and glad you asked. How are you doing?';
  if (/time|clock/.test(q)) return `The current time is ${time}.`;
  if (/\bdate\b|what day/.test(q)) return `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
  if (/joke/.test(q)) return "There are only 10 kinds of people: those who understand binary and those who don't.";
  if (/thank|thanks|shukriya/.test(q)) return 'You are most welcome.';

  // ---- free weather (no key) ----
  if (/weather|temperature|forecast|how hot|how cold/.test(q)) {
    const m = q.match(/weather (?:in|for|at)? ?([a-z ]+)/) || q.match(/(?:in|for|at) ([a-z ]+)/);
    const city = (m && m[1]) ? m[1].trim() : null;
    if (city) { const w = await webGet('weather', { city }); return w.error || `In ${w.city} it is ${w.temperature}°C with ${w.condition} (wind ${w.windspeed} km/h).`; }
    return 'Tell me a city — e.g. "weather in Mumbai".';
  }

  // ---- truth verification (free, no AI) ----
  if (/is it true|verify|fact check|fact-check|is .* real|is .* legit|did .* really/.test(q)) {
    const claim = q.replace(/^(is it true that|verify|fact check|fact-check)\s*/i, '').trim();
    if (claim) {
      const s = await webGet('search', { q: claim });
      if (s.answer) return `Checking: "${claim}"\n\n${s.answer}\n\nSource: ${s.source || 'the web'}${s.url ? ' — ' + s.url : ''}\n(For high-stakes facts, open the source to confirm.)`;
      if (s.results && s.results[0]) return `I couldn't find a direct confirmation for "${claim}", but here are relevant results:\n` + s.results.slice(0, 4).map((r, i) => `${i + 1}. ${r.title}${r.url ? ' — ' + r.url : ''}`).join('\n');
      return `I searched but found no evidence to confirm or refute "${claim}".`;
    }
  }

  // ---- real web search (free, no AI) ----
  if (/search|google|look up|find|who is|what is|tell me about|news about|current|latest/.test(q)) {
    const query = q.replace(/^(search|google|look up|find) (for )?/i, '').replace(/^(tell me about|what is|who is|news about)\s+/i, '').trim();
    if (query) {
      const s = await webGet('search', { q: query });
      if (s.answer) return `${s.answer}\n\nSource: ${s.source || 'the web'}${s.url ? ' (' + s.url + ')' : ''}`;
      if (s.results && s.results[0]) return `Top results for "${query}":\n` + s.results.slice(0, 4).map((r, i) => `${i + 1}. ${r.title}${r.url ? ' — ' + r.url : ''}`).join('\n');
      return `I searched but couldn't find a clear answer for "${query}".`;
    }
  }

  // ---- crypto (free) ----
  if (/bitcoin|ethereum|solana|dogecoin|crypto|btc|eth|price of/.test(q)) {
    const coins = ['bitcoin', 'ethereum', 'solana', 'dogecoin', 'ripple', 'cardano'];
    const coin = coins.find((c) => q.includes(c)) || 'bitcoin';
    const c = await webGet('crypto', { coin });
    return c.error || `${coin} is $${c.usd} (₹${c.inr}).`;
  }

  // ---- currency (free) ----
  if (/convert|currency|exchange rate|usd|inr|dollar|rupee/.test(q)) {
    const m = q.match(/([\d.]+)\s*([a-z]{3})\s*(?:to|in|into|->)?\s*([a-z]{3})/i);
    if (m) { const c = await webGet('currency', { amount: m[1], from: m[2], to: m[3] }); return c.error || `${c.amount} ${c.from} = ${c.result} ${c.to} (rate ${c.rate}).`; }
    return 'Tell me an amount, e.g. "convert 100 usd to inr".';
  }

  // ---- translate (free) ----
  if (/translate/.test(q)) {
    const m = q.match(/translate\s+["']?(.+?)["']?\s+(?:to|into)\s+([a-z]+)/i);
    if (m) { const t = await webGet('translate', { text: m[1], to: m[2] }); return t.error || `Translation: ${t.translation}`; }
    return 'Say e.g. "translate hello to hindi".';
  }

  // ---- dictionary (free) ----
  if (/define|meaning of|dictionary|what does .* mean/.test(q)) {
    const m = q.match(/(?:define|meaning of)\s+([a-z]+)/i) || q.match(/what does\s+([a-z]+)\s+mean/i);
    if (m) { const d = await webGet('dictionary', { word: m[1] }); return d.error || `${d.word} (${d.phonetic}) — ${d.partOfSpeech}: ${d.definition}${d.example ? '\nExample: ' + d.example : ''}`; }
    return 'Say e.g. "define serendipity".';
  }

  // ---- world time (free, client-side) ----
  if (/time in|time now in/.test(q)) {
    const m = q.match(/time (?:in|now in) ([a-z ]+)/i);
    if (m) {
      const city = m[1].trim();
      const tz = { london: 'Europe/London', 'new york': 'America/New_York', tokyo: 'Asia/Tokyo', sydney: 'Australia/Sydney', dubai: 'Asia/Dubai', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', karachi: 'Asia/Karachi', paris: 'Europe/Paris', berlin: 'Europe/Berlin', singapore: 'Asia/Singapore' }[city];
      if (tz) return `In ${city} it is ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz })}.`;
    }
  }

  return `I can help for free, no API key needed — try: "weather in Mumbai", "search latest AI news", "bitcoin price", "convert 100 usd to inr", "translate hello to hindi", "define serendipity", or just talk to me. ` +
    `To unlock a full conversational AI brain, set a Groq key (Settings → AI Brain).`;
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
  const intensity = Math.min(1, entries[0][1] / 3);
  return {
    emotion,
    valence: EMOTION_VALENCE[emotion] ?? 0,
    arousal: ['excitement', 'anger', 'fear', 'joy'].includes(emotion) ? 0.85 : ['sadness', 'tired', 'boredom'].includes(emotion) ? 0.25 : 0.5,
    intensity,
    confidence: Math.min(0.95, 0.4 + entries[0][1] * 0.15 + Math.min(0.15, totalHits * 0.02))
  };
}
const MOOD_EMOJI = { joy: '😄', excitement: '🤩', love: '🥰', gratitude: '🙏', confident: '😎', hope: '🌟', relief: '😮‍💨', curiosity: '🤔', neutral: '😊', boredom: '😑', tired: '😴', anxiety: '😰', sadness: '😔', fear: '😨', anger: '😠', guilt: '😞', embarrassment: '😳' };

// Language detection (Devanagari Hindi / Arabic Urdu / Hinglish / English)
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

// Empathetic support engine (mirror)
const CRISIS_SIGNALS = /\b(suicid|kill myself|end my life|end it all|don'?t want to (live|be here|exist)|no reason to live|better off dead|hurt myself|self.?harm|cut myself|give up on life)\b/i;

function supportGuidance(emotion, crisis) {
  if (crisis) {
    return "I'm really glad you told me. What you're feeling matters, and you deserve support — you are not alone in this.\n\n" +
      "Please reach out to someone who can be with you right now: a trusted friend or family member, or a crisis helpline. In India you can call iCall (9152987821) or Vandrevala Foundation (1860-266-2345 / 9999666555). Internationally, find support at findahelpline.com. If you're in immediate danger, please contact local emergency services.\n\nI'm here with you — but I'm not a substitute for a human or professional who can help in person.";
  }
  const map = {
    sadness: "I can hear how heavy this feels, and I'm really sorry you're going through it. It's completely okay to feel this way — you don't have to be strong all the time. I'm here, and I'm listening without any judgment. Would you like to just talk it through with me?",
    guilt: "Thank you for being honest with me — that takes real courage. Everyone makes mistakes; a mistake is something you did, not who you are. The fact that you feel bad about it says something good about your character. If it's possible, we can talk about making it right — and then about forgiving yourself. Would you like to work through it together?",
    embarrassment: "That uncomfortable feeling will pass — I promise it feels much bigger to you than it does to anyone else. People are mostly focused on themselves, not judging you. One deep breath — you're human, and this one moment doesn't define you.",
    anger: "It's okay to be angry — it usually means something important to you was crossed. Let's not act on it while it's hot. Want to tell me what happened? Getting it out often cools the fire enough to respond well instead of react.",
    anxiety: "That worried, overwhelmed feeling is awful, and I hear you. Most of what anxiety predicts never actually happens — but telling you to 'calm down' never helps. Let's name the single most concrete worry right now, then figure out the smallest possible next step together.",
    fear: "Fear is your mind trying to protect you, and it's okay to feel it. You've faced hard things before and come through them. Tell me what's scaring you — putting it into words shrinks it a little.",
    tired: "You sound exhausted, and that's a completely valid signal, not a weakness. Rest is a requirement, not a reward. Maybe the kindest thing right now is to step back, drink some water, and rest — you don't have to solve everything today."
  };
  return map[emotion] || "I'm here with you, and I'm listening. Tell me what's on your mind — however big or small.";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let profile = {
  name: 'Commander', theme: 'crimson',
  ai: { baseURL: '', apiKey: '', model: 'llama-3.3-70b-versatile' },
  voice: { rate: 1.0, pitch: 1.1, mode: 'neural', neuralVoice: 'en', name: '' },
  memoryOn: true, allowShell: false, wakeWord: false
};
let memory = { facts: [], transcript: [], notes: [], reminders: [], todos: [], mood: [], goals: [], skills: [], instructions: [], actionLog: [], summary: '' };
let currentEmotion = { emotion: 'neutral', valence: 0, arousal: 0.3 };
let currentLang = 'en';
let awaitingName = false;   // first-run: Gem is waiting to be told the user's name

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
  { id: 'en-AU', label: 'English (Australia) — smooth female' },
  { id: 'hi', label: 'Hindi — smooth female' },
  { id: 'ur', label: 'Urdu — smooth female' },
  { id: 'es', label: 'Spanish — smooth female' },
  { id: 'fr', label: 'French — smooth female' }
];

let speechQueue = Promise.resolve();
let currentNeuralAudio = null; // allows interrupting neural speech
let speechGen = 0;             // monotonic generation to cancel stale speech

function stopSpeaking() {
  speechGen++;
  try { speechSynthesis.cancel(); } catch (e) {}
  if (currentNeuralAudio) { try { currentNeuralAudio.pause(); currentNeuralAudio = null; } catch (e) {} }
  avatar({ speaking: false });
  hideCaption(200);
}

// ---------------------------------------------------------------------------
// Download — desktop installers
//
// Assets are published by .github/workflows/release.yml to GitHub Releases.
// We query the GitHub API for the newest release and match each platform to a
// real asset, so the buttons always point at the current version. If the API
// is unreachable (offline, rate-limited, no release yet) we fall back to the
// /releases/latest page, which always resolves.
// ---------------------------------------------------------------------------
const GH_REPO = 'rangwalaaliasgar55-bot/GemAir';
const GH_RELEASES = `https://github.com/${GH_REPO}/releases`;

/** Which installer belongs to which platform. */
const OS_MATCHERS = {
  win: (n) => /\.exe$/i.test(n),
  mac: (n) => /\.dmg$/i.test(n) || /mac.*\.zip$/i.test(n),
  linux: (n) => /\.appimage$/i.test(n) || /\.deb$/i.test(n)
};

function detectOS() {
  const p = (api.platform || '').toLowerCase();
  if (p === 'win32') return 'win';
  if (p === 'darwin') return 'mac';
  if (p === 'linux') return 'linux';
  const ua = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
  if (/win/i.test(ua)) return 'win';
  if (/mac|iphone|ipad/i.test(ua)) return 'mac';
  if (/linux|android|x11/i.test(ua)) return 'linux';
  return null;
}

function openDownload() {
  const modal = $('#downloadModal');
  if (!modal) return;
  modal.classList.add('open');
  highlightOS();
  loadReleaseAssets();
}
function closeDownload() { const m = $('#downloadModal'); if (m) m.classList.remove('open'); }

function highlightOS() {
  const os = detectOS();
  $$('#dlGrid .dl-card').forEach((c) => c.classList.toggle('recommended', c.dataset.os === os));
}

let releaseLoaded = false;
async function loadReleaseAssets() {
  const status = $('#dlStatus');
  const relLink = $('#dlReleases');
  if (relLink) relLink.href = GH_RELEASES;

  // sensible fallback before/if the API call fails
  $$('#dlGrid .dl-card').forEach((c) => { if (!c.href || c.href.endsWith('#')) c.href = GH_RELEASES + '/latest'; });
  if (releaseLoaded) return;

  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rel = await r.json();
    const assets = Array.isArray(rel.assets) ? rel.assets : [];

    let matched = 0;
    $$('#dlGrid .dl-card').forEach((card) => {
      const match = OS_MATCHERS[card.dataset.os];
      const asset = match && assets.find((a) => match(a.name || ''));
      if (asset) {
        card.href = asset.browser_download_url;
        matched++;
        const mb = asset.size ? ` · ${(asset.size / 1048576).toFixed(0)} MB` : '';
        const meta = card.querySelector('.dl-meta');
        if (meta) meta.textContent = meta.textContent.split(' · ')[0] + mb;
      } else {
        card.classList.add('unavailable');
        const cta = card.querySelector('.dl-cta');
        if (cta) cta.textContent = 'Build from source';
      }
    });

    if (status) {
      status.textContent = matched
        ? `Latest release ${rel.tag_name || ''} — published ${new Date(rel.published_at).toLocaleDateString()}.`
        : `Release ${rel.tag_name || ''} has no prebuilt installers yet — clone and run from source below.`;
    }
    releaseLoaded = true;
  } catch (e) {
    if (status) {
      status.innerHTML = 'Could not reach the GitHub API. ' +
        `<a class="accent-link" href="${GH_RELEASES}" target="_blank" rel="noopener">Open the releases page</a> ` +
        'or build from source below.';
    }
  }
}

// ---------------------------------------------------------------------------
// Failure isolation
//
// Hard-won rule: one broken init step must never be able to stop the rest of
// the app from wiring up. Anything optional goes through safe()/safeAsync(),
// which log loudly but always return control to the caller.
// ---------------------------------------------------------------------------
function safe(label, fn) {
  try {
    return fn();
  } catch (e) {
    console.error(`[GemAir] "${label}" failed:`, e);
    reportInitFailure(label, e);
    return undefined;
  }
}

async function safeAsync(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`[GemAir] "${label}" failed:`, e);
    reportInitFailure(label, e);
    return undefined;
  }
}

const _initFailures = [];
function reportInitFailure(label, err) {
  _initFailures.push({ label, message: err && err.message });
  // surface it once, quietly, instead of failing silently in the console
  if (_initFailures.length === 1) {
    setTimeout(() => {
      try {
        toast('DEGRADED', `${_initFailures.length} component(s) failed to start — the rest of GemAir still works.`, '⚠');
      } catch (e) {}
    }, 1200);
  }
}
window.__gemairInitFailures = _initFailures;

// Last-resort net: if anything at all throws during startup, make sure the
// controls are still wired so the user is never left with a dead interface.
window.addEventListener('error', (e) => {
  console.error('[GemAir] uncaught:', e && e.error ? e.error : e && e.message);
  ensureInteractive();
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[GemAir] unhandled rejection:', e && e.reason);
  ensureInteractive();
});

let _eventsBound = false;
function ensureInteractive() {
  if (_eventsBound) return;
  _eventsBound = true;
  try {
    bindEvents();
    console.warn('[GemAir] recovered: events bound by the safety net.');
  } catch (e) {
    console.error('[GemAir] safety net could not bind events:', e);
  }
}

// ---------------------------------------------------------------------------
// Live subtitles
//
// Shows what Gem is saying under the avatar, with the already-spoken words
// highlighted, plus what the user just said. Speech-synthesis boundary events
// give us a real word cursor; neural TTS has no boundaries, so we fall back to
// estimating from an average speaking rate.
// ---------------------------------------------------------------------------
let captionTimer = null;
let captionFullText = '';
let captionProgressTimer = null;

function setCaption(who, text, opts) {
  const bar = $('#captionBar'), whoEl = $('#captionWho'), textEl = $('#captionText');
  if (!bar || !textEl) return;
  clearTimeout(captionTimer);
  clearInterval(captionProgressTimer);
  captionFullText = String(text || '').trim();
  if (!captionFullText) { bar.classList.remove('show'); return; }

  bar.classList.toggle('user', who === 'user');
  if (whoEl) whoEl.textContent = who === 'user' ? (profile.name || 'YOU').toUpperCase() : 'GEM';
  textEl.innerHTML = `<span class="said"></span><span class="rest">${escapeHtml(captionFullText)}</span>`;
  bar.classList.add('show');

  if (opts && opts.autoHide) {
    captionTimer = setTimeout(() => bar.classList.remove('show'), opts.autoHide);
  }
}

/** Move the "already spoken" cursor to a character index. */
function captionProgress(charIndex) {
  const textEl = $('#captionText');
  if (!textEl || !captionFullText) return;
  const i = Math.max(0, Math.min(captionFullText.length, charIndex | 0));
  const said = captionFullText.slice(0, i);
  const rest = captionFullText.slice(i);
  textEl.innerHTML = `<span class="said">${escapeHtml(said)}</span>${rest ? escapeHtml(rest) : ''}` +
    (rest ? '<span class="cursor"></span>' : '');
}

/** No boundary events (neural TTS) — sweep at an average speaking rate. */
function captionAutoAdvance(text) {
  clearInterval(captionProgressTimer);
  const chars = text.length;
  const cps = 14.5;                          // ~870 characters per minute
  const step = 60;
  let elapsed = 0;
  captionProgressTimer = setInterval(() => {
    elapsed += step;
    const i = Math.round((elapsed / 1000) * cps);
    captionProgress(i);
    if (i >= chars) clearInterval(captionProgressTimer);
  }, step);
}

function hideCaption(delay) {
  const bar = $('#captionBar');
  if (!bar) return;
  clearInterval(captionProgressTimer);
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => bar.classList.remove('show'), delay || 900);
}

// ---------------------------------------------------------------------------
// Typo tolerance
//
// People type fast and misspell. The LLM path handles that on its own, but the
// free offline brain routes on keywords, so "wats teh wether in mumbi" used to
// match nothing. normaliseInput() repairs the text before intent matching. The
// user's ORIGINAL wording is always what gets displayed and remembered — this
// is only used for routing.
// ---------------------------------------------------------------------------

// Chat shorthand and the typos that are too irregular for edit distance.
const TYPO_MAP = {
  u: 'you', ur: 'your', urs: 'yours', r: 'are', y: 'why', k: 'ok', kk: 'ok',
  plz: 'please', pls: 'please', pl: 'please', pleease: 'please', plese: 'please', thx: 'thanks', ty: 'thanks',
  teh: 'the', hte: 'the', adn: 'and', nad: 'and', taht: 'that', thta: 'that',
  wat: 'what', wht: 'what', whats: 'what is', wats: 'what is', wt: 'what',
  hw: 'how', hwo: 'how', hou: 'how', wen: 'when', wher: 'where', whr: 'where',
  y2: 'why', bcz: 'because', bcoz: 'because', coz: 'because', cuz: 'because',
  wanna: 'want to', gonna: 'going to', gimme: 'give me', lemme: 'let me',
  dont: "don't", cant: "can't", wont: "won't", im: "i'm", ive: "i've",
  tmrw: 'tomorrow', tmr: 'tomorrow', tdy: 'today', yest: 'yesterday',
  msg: 'message', msgs: 'messages', pic: 'picture', pics: 'pictures',
  info: 'information', tell: 'tell', abt: 'about', bout: 'about',
  wrk: 'work', wrking: 'working', srch: 'search', srchr: 'search',
  temp: 'temperature', wthr: 'weather', calc: 'calculate', conv: 'convert'
};

// The words the offline router actually keys on. Edit distance is measured
// against this list only, so ordinary English is left alone.
const INTENT_VOCAB = [
  'weather', 'temperature', 'forecast', 'rain', 'search', 'google', 'find',
  'translate', 'translation', 'define', 'definition', 'meaning', 'dictionary',
  'crypto', 'bitcoin', 'ethereum', 'price', 'currency', 'convert', 'exchange',
  'news', 'headlines', 'remind', 'reminder', 'note', 'notes', 'goal', 'goals',
  'todo', 'task', 'time', 'date', 'clock', 'calculate', 'calculator', 'math',
  'open', 'launch', 'play', 'youtube', 'wikipedia', 'summarise', 'summarize',
  'email', 'screenshot', 'volume', 'file', 'folder', 'download', 'settings',
  'hello', 'thanks', 'music', 'song', 'help', 'breathe', 'mood', 'focus',
  'report', 'memory', 'remember', 'forget', 'delete', 'update', 'story',
  'joke', 'quote', 'affirmation', 'wellness', 'exercise', 'sleep', 'water'
];
const INTENT_SET = new Set(INTENT_VOCAB);

// Ordinary English that happens to sit within edit distance of an intent word
// ("today" is one edit from "todo"). These are never rewritten.
const PROTECTED = new Set(`today tomorrow tonight yesterday morning evening night
  week month year hour minute second daily weekly monthly
  this that these those there their them then than they
  what when where which while whose whom
  about above after again against along among around
  could would should might must shall will can may
  other others another every each some many much more most
  first last next previous final
  thing think thought through though
  right left front back down over under into onto from with without
  good great small large long short high low best better worse
  name work home life love need want know like make take come give
  tell feel look show hear read write speak start stop
  also just only even well very really quite still
  people person friend family
  not now new old own same still such sure than too use used
  water sleep exercise money`.split(/\s+/).filter(Boolean));

/**
 * Damerau-Levenshtein distance, capped for speed.
 * A true transposition needs the row from TWO steps back — with only one
 * previous row, "tiem" -> "time" scores 2 instead of 1 and never matches.
 */
function editDistance(a, b, max) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  let prev2 = null;
  let prev = new Array(bl + 1);
  let cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1); // transposition
      }
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur; cur = prev2 === cur ? new Array(bl + 1) : (prev2 && new Array(bl + 1));
    if (!cur) cur = new Array(bl + 1);
  }
  return prev[bl];
}

/** Repair one token: shorthand map first, then nearest intent keyword. */
function correctWord(word) {
  const w = word.toLowerCase();
  if (TYPO_MAP[w]) return TYPO_MAP[w];
  if (w.length < 3 || INTENT_SET.has(w) || PROTECTED.has(w)) return w;
  // collapse silly repetition: "pleeeease" -> "pleease" -> "please"
  let squashed = w.replace(/(.)\1{2,}/g, '$1$1');
  if (TYPO_MAP[squashed]) return TYPO_MAP[squashed];
  if (INTENT_SET.has(squashed)) return squashed;
  const single = squashed.replace(/(.)\1+/g, '$1');
  if (TYPO_MAP[single]) return TYPO_MAP[single];
  if (INTENT_SET.has(single)) return single;
  const tolerance = squashed.length <= 4 ? 1 : squashed.length <= 7 ? 2 : 3;
  let best = null, bestD = tolerance + 1;
  for (const v of INTENT_VOCAB) {
    if (Math.abs(v.length - squashed.length) > tolerance) continue;
    const d = editDistance(squashed, v, tolerance);
    if (d < bestD) { bestD = d; best = v; }
  }
  return bestD <= tolerance && best ? best : squashed;
}

/**
 * Normalise free text for intent matching. Returns the repaired string;
 * never mutates what the user sees.
 */
function normaliseInput(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[""'']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((tok) => {
      const m = tok.match(/^([^\w]*)([\w']+)([^\w]*)$/);
      if (!m) return tok;
      return m[1] + correctWord(m[2]) + m[3];
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Theme (with RGB / rainbow mode) & Synthetic Web Audio SFX
// ---------------------------------------------------------------------------
const THEME_ACCENTS = { crimson: 0, emerald: 152, cyan: 198, violet: 275, amber: 38, rgb: 300 };
let currentAccent = '#ff3b3b';
let rgbTimer = null;
let rgbHue = 300;
let globalAudioCtx = null;
let globalAnalyser = null;

function playSfx(type) {
  if (profile && profile.sfx === false) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!globalAudioCtx) globalAudioCtx = new AudioCtx();
    if (globalAudioCtx.state === 'suspended') globalAudioCtx.resume();
    const ctx = globalAudioCtx;
    const now = ctx.currentTime;

    if (type === 'click') {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(400, now + 0.04);
      gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.04);
    } else if (type === 'activate') {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.18);
      gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.2);
    } else if (type === 'message') {
      const osc1 = ctx.createOscillator(); const osc2 = ctx.createOscillator(); const gain = ctx.createGain();
      osc1.type = 'triangle'; osc2.type = 'sine';
      osc1.frequency.setValueAtTime(523.25, now);
      osc2.frequency.setValueAtTime(659.25, now + 0.08);
      gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination);
      osc1.start(now); osc1.stop(now + 0.1);
      osc2.start(now + 0.08); osc2.stop(now + 0.25);
    } else if (type === 'swoosh') {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.08);
      gain.gain.setValueAtTime(0.05, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.08);
    }
  } catch (e) {}
}

function getAccent() { return currentAccent; }

function setAccentFromHue(hue) {
  const h = ((hue % 360) + 360) % 360;
  const accent = `hsl(${h}, 92%, 60%)`;
  const soft = `hsla(${h}, 92%, 60%, 0.55)`;
  const glow = `hsla(${h}, 92%, 60%, 0.35)`;
  const dim = `hsla(${h}, 92%, 60%, 0.14)`;
  currentAccent = accent;
  const root = document.body.style;
  root.setProperty('--accent', accent);
  root.setProperty('--accent-soft', soft);
  root.setProperty('--accent-glow', glow);
  root.setProperty('--accent-dim', dim);
}

function stopRgb() {
  if (rgbTimer) { clearInterval(rgbTimer); rgbTimer = null; }
}

function startRgb() {
  stopRgb();
  rgbTimer = setInterval(() => {
    rgbHue = (rgbHue + 2) % 360;
    setAccentFromHue(rgbHue);
  }, 40);
}

function applyTheme(t) {
  document.body.dataset.theme = t;
  $$('.theme-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === t));
  if (t === 'rgb') { startRgb(); }
  else {
    stopRgb();
    setAccentFromHue(THEME_ACCENTS[t] || 0);
  }
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
  playSfx('swoosh');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'world') refreshHeadlines();
  if (view === 'core') renderProcesses();
}

function renderProcesses() {
  const container = $('#processList');
  if (!container) return;
  const filter = ($('#procFilter')?.value || '').toLowerCase().trim();

  const sampleProcs = [
    { pid: 1420, name: 'GemAir Core Engine', cpu: '1.4%', mem: '142 MB' },
    { pid: 2184, name: 'GemAir Audio & Visualizer', cpu: '2.1%', mem: '98 MB' },
    { pid: 3042, name: 'Web Speech Synthesis', cpu: '0.8%', mem: '64 MB' },
    { pid: 4890, name: 'Agent Town Virtual Office', cpu: '1.9%', mem: '112 MB' },
    { pid: 5120, name: 'Groq / LLM Pipeline', cpu: '0.2%', mem: '45 MB' },
    { pid: 6310, name: 'Local Persistence Store', cpu: '0.1%', mem: '28 MB' }
  ];

  const filtered = sampleProcs.filter(p => !filter || p.name.toLowerCase().includes(filter) || String(p.pid).includes(filter));

  if (!filtered.length) {
    container.innerHTML = '<div class="empty">No matching processes found.</div>';
    return;
  }

  container.innerHTML = filtered.map(p => `
    <div class="mem-item">
      <div>
        <b style="font-family:var(--font-mono);color:var(--accent);">[${p.pid}]</b>
        <span style="font-weight:600;margin-left:8px;">${p.name}</span>
        <span class="dim" style="font-size:11px;margin-left:10px;">CPU: ${p.cpu} | RAM: ${p.mem}</span>
      </div>
      <button class="ghost-btn" style="padding:4px 10px;font-size:10px;" onclick="playSfx('click'); toast('MONITOR', 'Process [${p.pid}] active', '⚙️')">Info</button>
    </div>
  `).join('');
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
  let accent = getAccent();
  let w, h, dpr, mx = 0, my = 0;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    // NB: clientWidth/clientHeight are READ-ONLY getters on Element. Assigning
    // to them throws a TypeError under 'use strict', which used to kill boot()
    // before bindEvents() ran — i.e. the whole UI became unclickable.
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
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
    accent = getAccent();
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
  let accent = getAccent();
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
    accent = getAccent();
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
  let accent = getAccent();
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
    accent = getAccent();
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
  if (role === 'ai' && !opts.typing) playSfx('message');
  const log = $('#chatLog');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const head = document.createElement('div');
  head.className = 'msg-head';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = role === 'ai' ? '◈ GEM' : (profile.name || 'YOU').toUpperCase();
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

// Render a "Sources" footer with clickable links for any URLs cited in a reply
function renderSources(msgDiv, text) {
  const urls = [...new Set(String(text || '').match(/https?:\/\/[^\s"'<>()]+/g) || [])].filter(u => !/\.(png|jpe?g|webp|gif)$/i.test(u)).slice(0, 5);
  if (!urls.length) return;
  const foot = document.createElement('div');
  foot.className = 'msg-sources';
  foot.innerHTML = '<span class="src-label">SOURCES</span> ';
  urls.forEach((u) => {
    const a = document.createElement('a');
    a.className = 'src-link';
    a.textContent = (() => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } })();
    a.title = u;
    a.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(u); });
    foot.appendChild(a);
  });
  msgDiv.appendChild(foot);
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
      const res = await api.saveCode(codeEl.textContent, 'gemair-output.txt');
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
  const skills = (memory.skills || []).slice(0, 40).map((s) => `- ${s.name ? s.name + ': ' : ''}${s.text}`).join('\n');
  const instructions = (memory.instructions || []).slice(0, 40).map((i) => `- ${i.text}`).join('\n');
  return {
    role: 'system',
    content:
      `Your name is Gem. You are the intelligence inside GemAir — a warm, emotionally intelligent personal AI companion (a free, open-source JARVIS). ` +
      `Always refer to yourself as Gem, never as GemAir (GemAir is the app you live in). ` +
      `You are the user's friend, mentor, life coach and career advisor — genuinely caring, perceptive and wise. ` +
      `The user's name is ${profile.name || 'Commander'}. Address them by their name naturally — at the start of a greeting, when reassuring them, or when something matters. Do not repeat it in every sentence; roughly once per reply at most. ` +
      `Personality — warmth ${s.warmth ?? 60}/100, wit ${s.wit ?? 40}/100, brevity ${s.brevity ?? 70}/100. ` +
      `LANGUAGE: Respond in the user's language. They are currently writing in ${currentLang === 'hi' ? 'Hindi' : currentLang === 'ur' ? 'Urdu' : currentLang === 'hinglish' ? 'Hinglish (Roman Hindi/Urdu)' : 'English'} — mirror it, including for Hindi/Urdu speakers. ` +
      `TRUTH & ACCURACY (non-negotiable): Always be truthful. Never fabricate facts, citations, quotes, statistics or events. ` +
      `For anything factual, current or uncertain, verify with web_search / verify_claim / fetch_webpage and CITE your sources inline. ` +
      `If you do not know or cannot verify something, say so plainly rather than guessing. Distinguish clearly between verified facts, opinions and estimates. ` +
      `When the user asks "is it true that…" or "verify…", call verify_claim and report the verdict + sources. ` +
      `EMOTIONAL INTELLIGENCE: The user's current emotional state is "${currentEmotion.emotion}" (valence ${currentEmotion.valence}, intensity ${currentEmotion.intensity || 0}). ` +
      (moodAvg != null ? `Their recent mood average is ${moodAvg}/100. ` : '') +
      `Always respond with empathy: acknowledge their feelings first when they're struggling, celebrate with them when they're doing well. If they're sad, anxious, angry or guilty, be gentle, validating and supportive — never dismissive or preachy. Adapt your tone and length to their state (more warmth and fewer words when intensity is high). ` +
      `SEARCH-FIRST: For anything factual, current, or time-sensitive (news, prices, weather, people, "who is", "what is", "latest"), you MUST call web_search / fetch_webpage to get real, up-to-date answers rather than relying on memory. The user wants genuine results, not guesses. ` +
      `LIFE & CAREER: You help with everything — career decisions, study plans, relationships, health, finances, self-improvement and emotional support. Offer thoughtful, practical, encouraging guidance. When appropriate, help them set goals (add_goal), log their mood (log_mood), or offer an affirmation (get_affirmation) or wellness tip (get_wellness_tip). ` +
      `CAPABILITIES via tools: time/date, weather, web search, fetch pages, Wikipedia, YouTube, translate, dictionary, crypto, currency, image generation, open URLs/apps, math, reminders, notes, files, clipboard, volume, screenshots, system control, to-dos, mood, goals, affirmations, wellness. ` +
      `LONG-TERM MEMORY — facts you remember:\n${facts || '(none yet)'}\n\n` +
      (goals ? `Their ACTIVE GOALS:\n${goals}\n\n` : '') +
      (skills ? `SKILLS YOU HAVE LEARNED (reuse when relevant):\n${skills}\n\n` : '') +
      (instructions ? `THE USER'S STANDING INSTRUCTIONS (always follow these):\n${instructions}\n\n` : '') +
      `INPUT HANDLING: The user often types fast with misspellings, missing letters, no punctuation, or mixed Hindi/Urdu romanisation. Silently infer what they meant and answer that. Never correct their spelling, never comment on it, and never ask "did you mean" unless the intent is genuinely ambiguous between two real options.\n` +
      `ANSWER STYLE (follow strictly):\n` +
      `- Lead with the answer. No preamble, no "Great question", no restating what was asked.\n` +
      `- Default to 1-3 sentences. Expand only when the user asks for detail, or the task genuinely needs steps.\n` +
      `- Use a short bulleted list for 3+ parallel items; never bullet a single idea.\n` +
      `- Cut filler: "I think", "it seems", "as an AI", "let me help you with that", closing offers of further help.\n` +
      `- One follow-up question at most, and only when you genuinely cannot proceed without it.\n` +
      `- Spoken replies are read aloud, so prefer plain sentences over markdown scaffolding.\n` +
      `VERIFICATION CONTRACT:\n` +
      `- Anything factual, current, numeric, or about a real person/product MUST come from a tool call this turn.\n` +
      `- Cite inline as [source](url) immediately after the claim it supports.\n` +
      `- If a search returns nothing usable, say "I could not verify that" — never fill the gap from memory.\n` +
      `- Separate what you verified from what you are inferring, in plain words.\n` +
      `- If the user's premise is wrong, correct it first, briefly.\n` +
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

// Don't treat tool commands as emotional distress
function hasToolIntent(text) {
  return /\b(search|google|weather|open|launch|translate|convert|define|remind|note|screenshot|volume|what time|calculate|bitcoin|price|todo|goal|email|whatsapp|organize|rename|archive|list|find|show|status)\b/i.test(text);
}

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

/**
 * Pull a usable name out of a free-form reply: "I'm Ali", "call me Ali",
 * "my name is Ali", or just "Ali". Falls back to Commander.
 */
function extractName(text) {
  let t = String(text || '').trim();
  const m = t.match(/(?:my name is|i am|i'm|im|call me|this is|it's|its)\s+([^.,!?\n]+)/i);
  if (m) t = m[1];
  t = t.replace(/[.,!?"']/g, ' ')
       .replace(/\b(please|thanks|thank you|sir|maam|ma'am)\b/gi, ' ')
       .replace(/\s+/g, ' ')
       .trim();
  const words = t.split(' ').filter(Boolean).slice(0, 3);
  if (!words.length) return 'Commander';
  const name = words
    .map((wd) => wd.charAt(0).toUpperCase() + wd.slice(1).toLowerCase())
    .join(' ');
  return name.length > 40 ? name.slice(0, 40) : name;
}

async function sendMessage(text) {
  text = (text || '').trim();
  if (!text) return;
  addMessage('user', text);
  $('#chatInput').value = '';
  setCaption('user', text, { autoHide: 3200 });
  avatar({ thinking: true }); // Gem visibly starts reasoning
  try {
    return await handleMessage(text);
  } finally {
    avatar({ thinking: false });
  }
}

async function handleMessage(text) {
  // First run: Gem asked for a name, so this reply IS the name.
  if (awaitingName) {
    awaitingName = false;
    const name = extractName(text);
    profile.name = name;
    await persistProfile();
    await api.memoryAddFact({ text: `The user's name is ${name}`, category: 'identity' });
    await loadMemory();
    renderAllMemory();
    renderBriefing();
    const welcome = `Lovely to meet you, ${name}. I'm Gem. I'll remember that — along with anything else you tell me. What would you like to do first?`;
    addMessage('ai', welcome);
    await api.memoryAppend('assistant', welcome);
    speak(welcome);
    return;
  }

  // Understand the user's emotion — always, automatically
  const emo = await api.analyzeEmotion(text);
  const lang = detectLanguage(text);
  currentLang = lang;
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

  // Empathetic support: if the user is in distress or expresses regret/guilt,
  // respond compassionately first (and always stay available).
  const crisis = CRISIS_SIGNALS.test(text.toLowerCase());
  const needsSupport = crisis || ['sadness', 'guilt', 'anxiety', 'anger', 'fear', 'embarrassment', 'tired'].includes(emo.emotion);
  if (needsSupport && !hasToolIntent(text)) {
    const support = supportGuidance(emo.emotion, crisis);
    const typing = addMessage('ai', '', { typing: true });
    const replyEl = typing.querySelector('p');
    typewriterToken++;
    await renderReply(replyEl, support);
    await api.memoryAppend('user', text);
    await api.memoryAppend('assistant', support);
    await api.memoryAddMood(emo.emotion, text.slice(0, 120));
    await loadMemory();
    renderMood();
    speak(support);
    return;
  }

  const cfg = profile.ai || {};
  const hasKey = !!(cfg.apiKey && cfg.baseURL);
  const isLocal = !!(cfg.baseURL && /localhost|127\.0\.0\.1/.test(cfg.baseURL));
  const useAI = hasKey || isLocal;

  // @Agent routing — hand the task to that agent's own brain (Stonic-style)
  const agentMatch = text.match(/^@(Alice|Bob|Carol|Dave)\s+(.*)$/i);
  const typing = addMessage('ai', '', { typing: true });

  let reply;
  if (agentMatch) {
    // Task routed to a specific resident agent (independent brain)
    const agentName = agentMatch[1][0].toUpperCase() + agentMatch[1].slice(1);
    const task = agentMatch[2].trim();
    if (window.__assignAgentTask) window.__assignAgentTask(agentName, task);
    addActivity(agentName, 'working on: ' + task);
    chatHistory.push({ role: 'user', content: text });
    const replyEl = typing.querySelector('p');
    typewriterToken++;
    if (useAI && window.gemair) {
      const sys = buildSystemPrompt();
      const res = await window.gemair.aiAgentChat(agentName, cfg, chatHistory.slice(-16));
      if (res.ok) { reply = res.reply; chatHistory.push({ role: 'assistant', content: reply }); }
      else { reply = '⚠ ' + humanError(res.error); }
    } else if (useAI) {
      // web mode: no per-agent backend — use main brain but tag the agent role
      reply = await (async () => {
        const res = await api._webChat([{ role: 'system', content: `You are ${agentName}, a resident agent of GemAir. Help with: ${task}. Be truthful and concise.` }, ...chatHistory.slice(-14)]);
        return res.ok ? res.reply : '⚠ ' + humanError(res.error);
      })();
      chatHistory.push({ role: 'assistant', content: reply });
    } else {
      reply = `[${agentName}] I'll take this one. ${(await api.aiOffline(task)).reply}`;
      chatHistory.push({ role: 'assistant', content: reply });
    }
    await renderReply(replyEl, reply);
  } else if (useAI) {
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

  // image rendering + sources footer if the reply contains URLs
  renderImageIfAny(typing.querySelector('p'), reply);
  renderSources(typing, reply);
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
  const older = memory.transcript.slice(0, -60).map((m) => (m.role === 'user' ? 'User: ' : 'GemAir: ') + m.content).join('\n');
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
  stopSpeaking(); // interrupt prior speech so new replies cut in cleanly
  const gen = ++speechGen;
  const mode = profile.voice?.mode || 'neural';
  document.body.classList.add('rgb-speaking'); // RGB while AI speaks
  avatar({ speaking: true });                  // Gem's mouth starts moving
  setCaption('gem', clean);                    // live subtitle
  if (mode === 'neural') captionAutoAdvance(clean);
  speechQueue = speechQueue.then(async () => {
    if (gen !== speechGen) return; // superseded
    if (mode === 'neural') {
      try { await speakNeural(clean, gen); return; } catch (e) { /* fall back to system voice */ }
    }
    if (gen === speechGen) speakSystem(clean);
  }).catch(() => {}).finally(() => {
    if (gen === speechGen) {
      document.body.classList.remove('rgb-speaking');
      avatar({ speaking: false });
      captionProgress(captionFullText.length);
      hideCaption(1400);
    }
  });
}

/**
 * Push state to Gem's avatar. Every call is optional and guarded, so the app
 * keeps working if avatar.js fails to load.
 */
function avatar(state) {
  try { if (window.gemAvatar) window.gemAvatar.setState(state); } catch (e) {}
}
function avatarEmotion(e) {
  try { if (window.gemAvatar) window.gemAvatar.setEmotion(e); } catch (err) {}
}

// Adjust speaking style to the current emotion (emotional voice intelligence)
function emotionVoiceMod() {
  const e = currentEmotion && currentEmotion.emotion;
  switch (e) {
    case 'sadness': case 'tired': case 'guilt': return { rate: -0.08, pitch: -0.1 };
    case 'excitement': case 'joy': case 'hope': return { rate: 0.06, pitch: 0.06 };
    case 'anger': case 'fear': case 'anxiety': return { rate: 0.02, pitch: 0.0 };
    case 'love': case 'gratitude': case 'relief': return { rate: -0.04, pitch: 0.02 };
    default: return { rate: 0, pitch: 0 };
  }
}

function speakSystem(text) {
  try {
    const mod = emotionVoiceMod();
    const u = new SpeechSynthesisUtterance(text.slice(0, 600));
    u.rate = Math.max(0.5, Math.min(1.5, Number(profile.voice?.rate ?? 1.0) + mod.rate));
    u.pitch = Math.max(0.5, Math.min(2, Number(profile.voice?.pitch ?? 1.1) + mod.pitch));
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
    // Drive the avatar's mouth from the real speech timeline: every word
    // boundary re-triggers a syllable so the lip-sync tracks the audio.
    u.onboundary = (ev) => {
      try { window.gemAvatar && window.gemAvatar.syllable(); } catch (e) {}
      if (ev && typeof ev.charIndex === 'number') captionProgress(ev.charIndex + (ev.charLength || 0));
    };
    u.onstart = () => avatar({ speaking: true });
    u.onend = () => avatar({ speaking: false });
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

function playAudioUrl(url, gen) {
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; try { audio.pause(); } catch (e) {} if (currentNeuralAudio === audio) currentNeuralAudio = null; resolve(ok); } };
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    audio.src = url;
    audio.preload = 'auto';
    if (gen !== speechGen) { done(false); return; }
    currentNeuralAudio = audio;

    try {
      if (!globalAudioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) globalAudioCtx = new AudioCtx();
      }
      if (globalAudioCtx && globalAudioCtx.state === 'suspended') {
        globalAudioCtx.resume();
      }
      if (globalAudioCtx) {
        if (!globalAnalyser) {
          globalAnalyser = globalAudioCtx.createAnalyser();
          globalAnalyser.fftSize = 128;
        }
        audio.crossOrigin = "anonymous";
        const source = globalAudioCtx.createMediaElementSource(audio);
        source.connect(globalAnalyser);
        globalAnalyser.connect(globalAudioCtx.destination);
        if (window.gemAvatar) window.gemAvatar.setAudioAnalyser(globalAnalyser);
      }
    } catch (e) {}

    audio.play().then(() => {}).catch(() => done(false));
    setTimeout(() => done(false), 30000); // safety
  });
}

async function speakNeural(text, gen) {
  const accent = profile.voice?.neuralVoice || 'en';
  const chunks = chunkForSpeech(text, 180); // Google TTS limit ~200 chars
  let any = false;
  for (const chunk of chunks) {
    if (gen !== speechGen) return; // interrupted
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=' + encodeURIComponent(chunk) + '&tl=' + encodeURIComponent(accent);
    const played = await playAudioUrl(url, gen);
    if (played) any = true;
  }
  if (!any) throw new Error('neural TTS unavailable');
}
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = false; r.interimResults = false; r.lang = profile.voice?.sttLang || 'en-US';
  r.onresult = (e) => { const t = e.results[0][0].transcript; $('#chatInput').value = t; sendMessage(t); };
  r.onend = () => { $('#micBtn').classList.remove('recording'); document.body.classList.remove('rgb-recording'); if (isRunning && listening) { try { r.start(); } catch (e) {} } };
  r.onerror = (e) => {
    $('#micBtn').classList.remove('recording');
    document.body.classList.remove('rgb-recording');
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
  const accent = () => getAccent();

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

  // click -> assign task (routes to the agent's own brain)
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = W / rect.width, sy = H / rect.height;
    const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
    for (const a of agents) {
      if (Math.hypot(mx - a.pos.x, my - a.pos.y) < 22) {
        assignTask(a.name, 'Awaiting your task…');
        switchView('assistant');
        $('#chatInput').value = `@${a.name} `;
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
  if (!actions.length) { log.innerHTML = '<div class="empty">No actions performed yet. Every action GemAir takes will be logged here.</div>'; return; }
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
function renderSkills() {
  const list = $('#skillsList');
  if (!list) return;
  const skills = (memory.skills || []).slice();
  if (!skills.length) { list.innerHTML = '<div class="empty">No skills yet. Say "teach me to…" or add one below — GemAir will remember and reuse it.</div>'; return; }
  list.innerHTML = '';
  skills.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'memory-item';
    div.innerHTML = `<span class="tag">SKILL</span><span class="body">${escapeHtml(s.name ? s.name + ': ' + s.text : s.text)}</span><button class="del-btn" title="Forget">✕</button>`;
    div.querySelector('.del-btn').addEventListener('click', async () => { await api.memoryDeleteSkill(s.id); await loadMemory(); renderSkills(); });
    list.appendChild(div);
  });
}
function renderInstructions() {
  const list = $('#instructionsList');
  if (!list) return;
  const instr = (memory.instructions || []).slice();
  if (!instr.length) { list.innerHTML = '<div class="empty">No standing instructions. Add a rule like "always be concise" or "call me Boss" — GemAir will follow it forever.</div>'; return; }
  list.innerHTML = '';
  instr.forEach((i) => {
    const div = document.createElement('div');
    div.className = 'memory-item';
    div.innerHTML = `<span class="tag">RULE</span><span class="body">${escapeHtml(i.text)}</span><button class="del-btn" title="Delete">✕</button>`;
    div.querySelector('.del-btn').addEventListener('click', async () => { await api.memoryDeleteInstruction(i.id); await loadMemory(); renderInstructions(); });
    list.appendChild(div);
  });
}
function renderAllMemory() { renderFacts(); renderNotes(); renderReminders(); updateTranscriptCount(); renderGoals(); renderMood(); renderSkills(); renderInstructions(); renderMissionLog(); renderBriefing(); }

// ---------------------------------------------------------------------------
// Daily briefing
// ---------------------------------------------------------------------------
const QUOTES_OFFLINE = [
  'The best way to predict the future is to invent it. — Alan Kay',
  "It always seems impossible until it's done. — Nelson Mandela",
  'The secret of getting ahead is getting started. — Mark Twain',
  "Believe you can and you're halfway there. — Theodore Roosevelt",
  'Do what you can, with what you have, where you are. — Theodore Roosevelt'
];
const BRIEFING_GREET = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' };
function renderBriefing() {
  const greetEl = $('#briefingGreet');
  if (!greetEl) return;
  const h = new Date().getHours();
  const period = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  greetEl.textContent = `${BRIEFING_GREET[period]}, ${profile.name || 'Commander'}.`;
  $('#briefingDate').textContent = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  $('#briefQuote').textContent = '“' + QUOTES_OFFLINE[Math.floor(Math.random() * QUOTES_OFFLINE.length)] + '”';
  const topGoal = (memory.goals || []).find((g) => !g.done);
  $('#briefGoal').textContent = topGoal ? '🎯 ' + topGoal.text.slice(0, 40) : '🎯 No active goal — add one!';
  // weather (free)
  webGet('weather', { city: profile.city || 'Mumbai' }).then((w) => {
    const el = $('#briefWeather');
    if (w && w.temperature != null) el.textContent = `🌤 ${w.city.split(',')[0]}: ${w.temperature}°C ${w.condition}`;
  }).catch(() => {});
}

function buildReportOffline() {
  const now = new Date();
  const weekAgo = now.getTime() - 7 * 86400000;
  const mood = (memory.mood || []).filter((x) => (x.ts || 0) >= weekAgo);
  const moodAvg = mood.length ? Math.round((mood.reduce((a, b) => a + (b.valence || 0), 0) / mood.length) * 100) : null;
  const moodTrend = mood.length >= 2 ? (mood[mood.length - 1].valence - mood[0].valence) : 0;
  const activeGoals = (memory.goals || []).filter((g) => !g.done);
  const doneGoals = (memory.goals || []).filter((g) => g.done);
  const lines = [];
  lines.push(`### Weekly Report — ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`);
  lines.push('');
  if (moodAvg != null) lines.push(`Mood: averaging ${moodAvg}/100 this week (${moodTrend > 0.15 ? 'trending up' : moodTrend < -0.15 ? 'trending down' : 'stable'}).`);
  else lines.push('Mood: no check-ins yet this week.');
  lines.push(`Goals: ${activeGoals.length} active, ${doneGoals.length} achieved.`);
  lines.push(`Tasks: ${(memory.todos || []).filter((t) => t.done).length} done, ${(memory.todos || []).filter((t) => !t.done).length} open.`);
  lines.push(`Knowledge: ${(memory.facts || []).length} memories, ${(memory.notes || []).length} notes.`);
  if (activeGoals.length) { lines.push(''); lines.push('Focus for next week:'); activeGoals.slice(0, 3).forEach((g) => lines.push('• ' + g.text)); }
  if (moodAvg != null && moodAvg < 40) { lines.push(''); lines.push('Gentle note: your mood has been lower this week. Be kind to yourself.'); }
  return { report: lines.join('\n'), moodAvg, moodTrend };
}

// ---------------------------------------------------------------------------
// Companion: mood, goals, wellness
// ---------------------------------------------------------------------------
function updateMoodIndicator(emo) {
  avatarEmotion(emo);
  const e = emo || currentEmotion;
  const emojiEl = $('#moodEmoji'), labelEl = $('#moodLabel'), subEl = $('#moodSub');
  if (!emojiEl) return;
  emojiEl.textContent = MOOD_EMOJI[e.emotion] || '😊';
  const names = { joy: 'Joyful', excitement: 'Excited', love: 'Loving', gratitude: 'Grateful', confident: 'Confident', hope: 'Hopeful', relief: 'Relieved', curiosity: 'Curious', neutral: 'Neutral', boredom: 'Bored', tired: 'Tired', anxiety: 'Anxious', sadness: 'Down', fear: 'Afraid', anger: 'Frustrated', guilt: 'Regretful', embarrassment: 'Embarrassed' };
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
  const accent = getAccent();

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
  let accent = getAccent();

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
    accent = getAccent();
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
  $('#setSttLang').value = profile.voice?.sttLang || 'en-US';
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
  if (key && base) el.textContent = '✓ AI brain locked to your endpoint — GemAir will use THIS key only.';
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
  if (_eventsBound) return;
  _eventsBound = true;
  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $$('.theme-btn').forEach((b) => b.addEventListener('click', () => {
    playSfx('click');
    profile.theme = b.dataset.theme;
    applyTheme(profile.theme);
    persistProfile();
  }));

  // SFX button toggle
  const sfxBtn = $('#sfxBtn');
  if (sfxBtn) {
    sfxBtn.addEventListener('click', () => {
      profile.sfx = !(profile.sfx !== false);
      sfxBtn.classList.toggle('active', profile.sfx !== false);
      $('#sfxIcon').textContent = profile.sfx !== false ? '🔊' : '🔇';
      $('#sfxText').textContent = profile.sfx !== false ? 'SFX ON' : 'SFX OFF';
      if (profile.sfx !== false) playSfx('click');
      persistProfile();
    });
  }

  // Clear chat log
  const clearChatBtn = $('#clearChatBtn');
  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', () => {
      playSfx('click');
      $('#chatLog').innerHTML = '<div class="msg system-msg"><p>Chat history cleared. Systems standing by.</p></div>';
      chatHistory = [];
      toast('CHAT', 'Chat history log cleared.', '🧹');
    });
  }

  // Circuit row clicks
  $('#memCircuitRow')?.addEventListener('click', () => {
    switchView('core');
    const tab = $$('.core-tab').find(t => t.dataset.tab === 'memory');
    if (tab) tab.click();
  });
  $('#skillCircuitRow')?.addEventListener('click', () => {
    switchView('core');
    const tab = $$('.core-tab').find(t => t.dataset.tab === 'skills');
    if (tab) tab.click();
  });
  $('#soulCircuitRow')?.addEventListener('click', () => {
    switchView('core');
    const tab = $$('.core-tab').find(t => t.dataset.tab === 'soul');
    if (tab) tab.click();
  });

  // Process monitor controls
  $('#refreshProcsBtn')?.addEventListener('click', () => { playSfx('click'); renderProcesses(); });
  $('#procFilter')?.addEventListener('input', () => renderProcesses());

  // core tabs
  $$('.core-tab').forEach((t) => t.addEventListener('click', () => {
    playSfx('click');
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

  // skills + instructions
  $('#skillAdd').addEventListener('click', async () => {
    const text = $('#skillInput').value.trim();
    if (!text) return;
    await api.memoryAddSkill(text, $('#skillName').value.trim());
    $('#skillInput').value = ''; $('#skillName').value = '';
    await loadMemory(); renderSkills();
    toast('SKILL', 'Skill remembered — I\u2019ll reuse it from now on.', '🧠');
  });
  $('#skillInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#skillAdd').click(); });
  $('#instructionAdd').addEventListener('click', async () => {
    const text = $('#instructionInput').value.trim();
    if (!text) return;
    await api.memoryAddInstruction(text);
    $('#instructionInput').value = '';
    await loadMemory(); renderInstructions();
    toast('RULE', 'Standing instruction saved.', '📌');
  });
  $('#instructionInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#instructionAdd').click(); });

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

  // Guided breathing
  $('#breatheBtn').addEventListener('click', () => $('#breatheModal').classList.add('open'));
  $('#breatheClose').addEventListener('click', () => { stopBreathing(); $('#breatheModal').classList.remove('open'); });
  $('#breatheStart').addEventListener('click', startBreathing);
  $('#breatheStop').addEventListener('click', stopBreathing);

  // Focus timer
  let focusInterval = null, focusRemaining = 25 * 60, focusRunning = false;
  $('#focusBtn').addEventListener('click', () => { $('#focusTimer').hidden = false; });
  $('#focusToggle').addEventListener('click', () => {
    focusRunning = !focusRunning;
    $('#focusToggle').textContent = focusRunning ? '⏸' : '▶';
    if (focusRunning) {
      focusInterval = setInterval(() => {
        focusRemaining--;
        if (focusRemaining <= 0) { focusRemaining = 0; clearInterval(focusInterval); focusRunning = false; $('#focusToggle').textContent = '▶'; toast('FOCUS', 'Session complete — take a 5-minute break!', '🍅'); speak('Great work. Time for a short break.'); }
        const m = Math.floor(focusRemaining / 60), s = focusRemaining % 60;
        $('#focusTime').textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }, 1000);
    } else clearInterval(focusInterval);
  });
  $('#focusReset').addEventListener('click', () => { clearInterval(focusInterval); focusRemaining = 25 * 60; focusRunning = false; $('#focusToggle').textContent = '▶'; $('#focusTime').textContent = '25:00'; });

  // Weekly report
  $('#weeklyReportBtn').addEventListener('click', async () => {
    $('#reportModal').classList.add('open');
    $('#reportContent').textContent = 'Generating…';
    const res = await api.generateReport();
    $('#reportContent').textContent = res.report;
  });
  $('#reportClose').addEventListener('click', () => $('#reportModal').classList.remove('open'));
  $('#reportClose2').addEventListener('click', () => $('#reportModal').classList.remove('open'));
  $('#reportCopy').addEventListener('click', () => {
    try { navigator.clipboard.writeText($('#reportContent').textContent); toast('REPORT', 'Copied to clipboard.', '📋'); } catch (e) {}
  });

  // Export memory
  $('#exportBtn').addEventListener('click', async () => {
    const data = await api.exportMemory();
    downloadText(JSON.stringify(data, null, 2), 'gemair-backup-' + Date.now() + '.json');
    toast('BACKUP', 'Memory exported as JSON.', '⬇');
  });

  // Companion: career prompts
  $$('.prompt-chip').forEach((c) => c.addEventListener('click', () => {
    switchView('assistant');
    $('#chatInput').value = c.dataset.prompt;
    $('#chatInput').focus();
  }));

  // settings
  // download
  const dlBtn = $('#downloadBtn');
  if (dlBtn) {
    // inside the packaged desktop app there is nothing to download
    if (window.gemair) dlBtn.hidden = true;
    else dlBtn.addEventListener('click', openDownload);
  }
  $('#downloadClose').addEventListener('click', closeDownload);
  $('#downloadClose2').addEventListener('click', closeDownload);
  $('#downloadModal').addEventListener('click', (e) => { if (e.target === $('#downloadModal')) closeDownload(); });
  // let the OS links open in the user's real browser when running in Electron
  $$('#dlGrid .dl-card').forEach((c) => c.addEventListener('click', (e) => {
    if (window.gemair) { e.preventDefault(); api.openExternal(c.href); }
  }));

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
    profile.voice.sttLang = $('#setSttLang').value;
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
    else if (e.key === 'Escape') { closeSettings(); closePalette(); closeDownload(); }
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
    speak('Hello, I am GemAir, your personal assistant. How can I help you today?');
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
    playSfx('activate');
    if (isRunning) { isRunning = false; $('#startBtn').classList.remove('running'); $('#startLabel').textContent = 'START AI'; $('#orbStatus').textContent = 'STANDBY'; $('#orbStatus').classList.remove('active'); stopListening(); }
    else { startAiLoop(); addMessage('system-msg', 'AI online. Speak naturally — I\u2019m listening.'); speak('Systems online. How can I help?'); }
  });

  $('#micBtn').addEventListener('click', () => {
    if (!recognition) { addMessage('system-msg', 'Speech recognition unavailable here — type a command instead.'); return; }
    if (listening) stopListening();
    else { listening = true; avatar({ listening: true }); $('#micBtn').classList.add('recording'); document.body.classList.add('rgb-recording'); try { recognition.start(); } catch (e) {} }
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
  if (recognition) { try { recognition.start(); $('#micBtn').classList.add('recording'); document.body.classList.add('rgb-recording'); } catch (e) {} }
}

// Continuous wake-word listening ("Hey GemAir")
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
        if (/hey gemair|hey gem|a gemair|hi gemair/.test(t)) {
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
  addMessage('system-msg', 'Wake word armed — say "Hey GemAir" anytime.');
}

function stopListening() {
  avatar({ listening: false });
  listening = false;
  $('#micBtn').classList.remove('recording');
  document.body.classList.remove('rgb-recording');
  if (recognition) { try { recognition.stop(); } catch (e) {} }
}

// ---------------------------------------------------------------------------
// Guided breathing (4-7-8)
// ---------------------------------------------------------------------------
let breatheTimer = null;
const BREATHE_PHASES = [
  { label: 'INHALE', seconds: 4, cls: 'inhale' },
  { label: 'HOLD', seconds: 7, cls: 'hold' },
  { label: 'EXHALE', seconds: 8, cls: 'exhale' }
];
function startBreathing() {
  const circle = $('#breatheCircle'), label = $('#breatheLabel'), count = $('#breatheCount');
  let phase = 0, remaining = BREATHE_PHASES[0].seconds, cycles = 0;
  stopBreathing();
  function tick() {
    count.textContent = remaining;
    if (remaining <= 0) {
      phase = (phase + 1) % 3;
      if (phase === 0) { cycles++; if (cycles >= 4) { stopBreathing(); toast('BREATHING', 'Great job. Notice how much calmer you feel.', '🌬'); return; } }
      remaining = BREATHE_PHASES[phase].seconds;
    }
    const p = BREATHE_PHASES[phase];
    label.textContent = p.label;
    circle.className = 'breathe-circle ' + p.cls;
    remaining--;
    breatheTimer = setTimeout(tick, 1000);
  }
  tick();
}
function stopBreathing() {
  if (breatheTimer) { clearTimeout(breatheTimer); breatheTimer = null; }
  const circle = $('#breatheCircle'), label = $('#breatheLabel'), count = $('#breatheCount');
  if (circle) circle.className = 'breathe-circle';
  if (label) label.textContent = 'READY';
  if (count) count.textContent = '';
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

  // web mode: load public config (Supabase / AI) from the Vercel API
  if (!window.gemair) {
    try {
      const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => null);
      if (cfg && cfg.supabase && window.webStore) {
        const ok = await window.webStore.initSupabase(cfg.supabase);
        if (ok) {
          toast('CLOUD', 'Supabase connected — your memory syncs across devices.', '🗄');
        } else {
          // Explain *why* rather than failing silently. Memory still works
          // locally, so this is a downgrade, not an error.
          const err = window.webStore.lastError || {};
          if (err.code === 'ANON_DISABLED') {
            toast('CLOUD OFF', 'Enable Authentication → Providers → Anonymous in Supabase to sync across devices. Memory is saved on this device meanwhile.', '🔒');
          } else if (err.code && err.code !== 'NO_CONFIG') {
            toast('CLOUD OFF', (err.message || 'Supabase unavailable') + ' Memory is saved on this device.', '🔒');
          }
          console.warn('[GemAir] cloud sync unavailable:', err.code, err.message);
        }
      }
      window.__gemairAiConfigured = !!(cfg && cfg.aiConfigured);
    } catch (e) {}
  }

  await safeAsync('loadProfile', loadProfile);
  await safeAsync('loadMemory', loadMemory);

  // ---------------------------------------------------------------------
  // BARRIER: wire the UI *first*, and isolate every other init step.
  //
  // These three lines are what make the app usable. They used to run near the
  // end of boot(), so a single throw in any decorative step above them (a
  // canvas resize, a 3D scene, a renderer) left every button dead. Now the
  // controls are live before anything that can fail, and each remaining step
  // runs inside safe() so one failure can never cascade.
  // ---------------------------------------------------------------------
  safe('applyTheme', () => applyTheme(profile.theme || 'cyan'));
  safe('bindEvents', bindEvents);
  safe('bindSoulSliders', bindSoulSliders);
  safe('updateLinkMode', updateLinkMode);

  // Everything below is presentation. Any of it may fail without taking the
  // interface down with it.
  safe('background3D', startBackground3D);
  safe('orb', startOrb);
  safe('globe', startGlobe);
  safe('commandMap', startCommandMap);
  safe('avatar', () => { if (window.gemAvatar) window.gemAvatar.mount('#avatarCanvas'); });
  safe('agentTown', startAgentTown);
  safe('renderMemory', renderAllMemory);
  safe('circuits', animateCircuits);
  safe('moodIndicator', () => updateMoodIndicator(currentEmotion));
  setTimeout(() => safe('panelTilt', startPanelTilt), 300);

  // restore recent conversation history from persistent memory
  const last = (memory.transcript || []).slice(-40);
  const knowsUser = !!(profile.name && profile.name !== 'Commander');
  const greeting = knowsUser
    ? `${greetByTime()}, ${profile.name}. Gem here — all systems online, and I remember everything about you.`
    : `${greetByTime()}. I'm Gem, the intelligence inside GemAir.`;

  // First run: introduce Gem, then ask what to call the user. The next thing
  // they type is captured as their name (see handleMessage).
  if (!knowsUser && !last.length) {
    addMessage('ai', greeting);
    const ask = 'Before we begin — what should I call you?';
    addMessage('ai', ask);
    awaitingName = true;
    setTimeout(() => speak(greeting + ' ' + ask), 700);
  } else if (last.length) {
    addMessage('system-msg', `↻ Restored ${last.length} past messages from persistent memory.`);
    last.forEach((m) => { if (m.role === 'user') addMessage('user', m.content); else if (m.role === 'assistant') addMessage('ai', m.content); });
    last.forEach((m) => { if (m.role === 'user' || m.role === 'assistant') chatHistory.push({ role: m.role, content: m.content }); });
  } else if (!awaitingName) {
    addMessage('ai', greeting);
    addMessage('system-msg', 'Gem is online. Paste a free Groq key in Settings for a full LLM brain — or just start talking, the offline brain already handles the web, weather, apps and files.');
  }

  if (!profile.ai?.apiKey) toast('TIP', 'Add a free Groq key in Settings → AI Brain for a full brain.', '⚡');

  pollSystem(); setInterval(pollSystem, 2500);
  recognition = initRecognition();
  if (speechSynthesis) speechSynthesis.onvoiceschanged = populateVoices;
  try { $('#verTag').textContent = 'v' + (await api.version()); } catch (e) {}

  if (profile.wakeWord) configureWakeWord(true);

  // Proactive check-in: if mood has been low & declining, reach out gently
  try {
    if (await api.needsCheckIn()) {
      setTimeout(() => {
        addMessage('system-msg', '💙 I noticed things have felt heavy lately. I\u2019m here — no pressure, but I\u2019m listening if you want to talk.');
        toast('CHECK-IN', 'Been a rough few days? I\u2019m here for you.', '💙');
      }, 2500);
    }
  } catch (e) {}

  // speak the greeting
  if (!last.length && !awaitingName) setTimeout(() => speak(greeting), 800);
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
