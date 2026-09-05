/* ============================================================
   GemAir — renderer application logic
   ============================================================ */
'use strict';

// ---------------------------------------------------------------------------
// Bridge: Electron IPC or browser-supported capabilities.
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
    return {
      platform: 'browser', available: false, hostname: 'Unavailable', arch: 'unknown',
      cpus: navigator.hardwareConcurrency || null,
      cpuLoad: null, memTotal: null, memFree: null, memUsed: null,
      memPercent: null, uptime: null, loadavg: [], battery: null, disk: null
    };
  },
  async getActionLog() {
    if (window.gemair && window.gemair.getActionLog) return window.gemair.getActionLog();
    return { log: (memory.actionLog || []).slice(0, 200) };
  },
  async screenInspect() {
    if (window.gemair && window.gemair.screenInspect) return window.gemair.screenInspect();
    return { changed: false, changePercent: 0, description: 'Browser screen capture is unavailable; desktop mode is required.' };
  },
  async consumeRecovery() { return window.gemair && window.gemair.consumeRecovery ? window.gemair.consumeRecovery() : { recovered: false, restored: [] }; },
  async usageGet() { return window.gemair && window.gemair.usageGet ? window.gemair.usageGet() : { version: 1, total: 0, actions: {}, days: {}, disabled: true }; },
  async trackUsage(action, metadata = {}) { return window.gemair && window.gemair.usageTrack ? window.gemair.usageTrack(action, metadata) : { recorded: false }; },
  async usageClear() { return window.gemair && window.gemair.usageClear ? window.gemair.usageClear() : { ok: true }; },
  async getProfile() { if (window.gemair) return window.gemair.getProfile(); return window.webStore ? window.webStore.getProfile() : {}; },
  async setProfile(d) { if (window.gemair) return window.gemair.setProfile(d); if (window.webStore) await window.webStore.setProfile(d); },

  async _webChat(messages, onDelta) {
    if (!window.aiClient) return { ok: false, error: 'Chat client unavailable. Reload the app.' };
    return window.aiClient.serverChat(messages, onDelta);
  },
  async aiChat(config, messages) {
    if (window.gemair) return window.gemair.aiChat(config, messages);
    if (window.aiClient && config && config.apiKey) {
      return window.aiClient.directClientChat(config, messages);
    }
    const free = await this._webChat(messages);
    if (free.ok) return free;
    // S8: Layer B — opt-in in-browser model before the offline intent brain.
    if (window.aiClient && window.aiClient.isLocalReady()) {
      const local = await window.aiClient.localChat(messages);
      if (local.ok) return local;
    }
    return free;
  },
  /**
   * R8 — connection test WITHOUT the silent free-core rescue.
   *
   * TEST CONNECTION used aiChat(), which falls back to the free serverless core
   * whenever the user's own key fails. A completely bogus key therefore printed
   * a green "OK". This variant reports exactly which path answered, and treats
   * "a key was supplied but the direct call failed" as a hard failure.
   */
  async aiChatStrict(config, messages) {
    const hasKey = !!(config && config.apiKey && String(config.apiKey).trim());
    if (window.gemair) {
      if (!hasKey) {
        const free = await this._webChat(messages);
        return { ...free, via: 'free-core' };
      }
      try {
        const reply = await window.gemair.aiChat(config, messages);
        if (reply && reply.ok === false) return { ok: false, error: reply.error, via: 'direct' };
        return { ok: true, reply: reply && reply.reply ? reply.reply : reply, via: 'direct' };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e), via: 'direct' };
      }
    }
    if (hasKey) {
      if (!window.aiClient) return { ok: false, error: 'NO_DIRECT_CLIENT', via: 'direct' };
      const direct = await window.aiClient.directClientChat(config, messages);
      return { ...direct, via: 'direct' };
    }
    const free = await this._webChat(messages);
    return { ...free, via: 'free-core' };
  },
  async aiChatStream(config, messages, onDelta) {
    if (window.gemair) return window.gemair.aiChatStream(config, messages, onDelta);
    if (window.aiClient && config && config.apiKey) {
      return window.aiClient.directClientChat(config, messages, onDelta);
    }
    const res = await this._webChat(messages, onDelta);
    // S8: Layer B — if the free core could not answer and the user opted into
    // the in-browser WebGPU model, run it before dropping to the intent brain.
    if (!res.ok && !res.partial && window.aiClient && window.aiClient.isLocalReady()) {
      const local = await window.aiClient.localChat(messages, onDelta);
      if (local.ok) return local;
    }
    return res;
  },
  /**
   * S9 — browser summarizer.
   *
   * In the web build this returned `{ ok: true, summary: null }`, so context
   * compaction silently did nothing in exactly the free/no-key mode GemAir
   * advertises: the transcript grew until it was truncated. When a key IS
   * configured we still prefer the model; otherwise we fall back to a local
   * extractive summarizer that runs entirely in the page.
   */
  async aiSummarize(config, text) {
    if (window.gemair) return window.gemair.aiSummarize(config, text);
    if (config && config.apiKey && config.baseURL && window.aiClient) {
      try {
        const r = await window.aiClient.directClientChat(config, [
          { role: 'system', content: 'Summarize the conversation below into a compact factual brief (max 8 sentences). Keep names, decisions, numbers and open tasks.' },
          { role: 'user', content: String(text || '').slice(0, 12000) }
        ]);
        if (r && r.ok && r.reply) return { ok: true, summary: r.reply.trim(), via: 'model' };
      } catch (e) { /* fall through to the local summarizer */ }
    }
    const summary = localExtractiveSummary(text);
    return { ok: !!summary, summary, via: 'local' };
  },
  async aiOffline(text) {
    if (window.gemair) return window.gemair.aiOffline(text);
    return { ok: true, reply: await offlineBrain(text) };
  },
  async listLocalModels() { if (window.gemair && window.gemair.listLocalModels) return window.gemair.listLocalModels(); return { models: [] }; },

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
  // S2 — real process monitor
  async listProcesses(limit) {
    if (window.gemair && window.gemair.listProcesses) return window.gemair.listProcesses(limit);
    return { ok: false, error: 'desktop_only', procs: [] };
  },
  async killProcess(pid, name) {
    if (window.gemair && window.gemair.killProcess) return window.gemair.killProcess(pid, name);
    return { error: 'desktop_only' };
  },

  // S3 — tasks
  async memoryAddTodo(text) {
    if (window.gemair) return window.gemair.memoryAddTodo(text);
    if (window.webStore) await window.webStore.addTodo(text);
    return { ok: true };
  },
  async memoryToggleTodo(id) {
    if (window.gemair) return window.gemair.memoryToggleTodo(id);
    if (window.webStore) await window.webStore.toggleTodo(id);
    return { ok: true };
  },
  async memoryDeleteTodo(id) {
    if (window.gemair) return window.gemair.memoryDeleteTodo(id);
    if (window.webStore) await window.webStore.deleteTodo(id);
    return { ok: true };
  },

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
  async getHeadlines(limit, category) {
    if (window.gemair) return window.gemair.getHeadlines(limit, category);
    try { const r = await fetch('/api/headlines?limit=' + (limit || 14) + '&category=' + encodeURIComponent(category || 'tech')); const data = await r.json(); return Array.isArray(data) ? data : []; } catch { return []; }
  },
  openExternal(url) { if (window.gemair) window.gemair.openExternal(url); else window.open(url, '_blank'); },
  async checkForUpdates(force = false) { return window.gemair && window.gemair.checkForUpdates ? window.gemair.checkForUpdates(force) : { ok: false, error: 'DESKTOP_ONLY' }; },
  async version() { return window.gemair ? window.gemair.version() : '2.1.0'; },
  onReminder(cb) { return registerRendererDisposer(window.gemair && window.gemair.onReminder ? window.gemair.onReminder(cb) : null); },
  onWakeToggle(cb) { return registerRendererDisposer(window.gemair && window.gemair.onWakeToggle ? window.gemair.onWakeToggle(cb) : null); },
  onActivity(cb) { return registerRendererDisposer(window.gemair && window.gemair.onActivity ? window.gemair.onActivity(cb) : null); },
  async collaborateAgents(task) {
    if (window.gemair && window.gemair.collaborateAgents) return window.gemair.collaborateAgents(task);
    const research = await webGet('search', { q: task });
    const report = `# GemAir Mission\n\n${task}\n\n## Alice research\n${JSON.stringify(research, null, 2)}`;
    downloadText(report, 'gemair-mission.md');
    const system = await this.getSystemInfo();
    return { ok: true, reportPath: 'gemair-mission.md (download)', summary: 'Alice researched the mission, Bob created a downloadable report, and Carol verified browser system telemetry.', steps: [
      { agent: 'Alice', tool: 'web_search', args: { query: task }, result: research, ok: true, ms: 0 },
      { agent: 'Bob', tool: 'write_file', args: { path: 'gemair-mission.md' }, result: { ok: true, path: 'gemair-mission.md (download)' }, ok: true, ms: 0 },
      { agent: 'Carol', tool: 'system_scan', args: {}, result: system, ok: true, ms: 0 }
    ] };
  },
  onHudPanel(cb) { return registerRendererDisposer(window.gemair && window.gemair.onHudPanel ? window.gemair.onHudPanel(cb) : null); },
  // 2.5 Computer-Use Agent (keyless)
  async computerUse(task, config) { if (window.gemair && window.gemair.computerUse) return window.gemair.computerUse(task, config || {}); return { ok: false, error: 'Desktop app with a local model is required for computer control.' }; },
  async computerUseStop() { if (window.gemair && window.gemair.computerUseStop) return window.gemair.computerUseStop(); return { ok: true }; },
  async computerUseStatus() { if (window.gemair && window.gemair.computerUseStatus) return window.gemair.computerUseStatus(); return { active: false }; },
  async computerUseScreen() { if (window.gemair && window.gemair.computerUseScreen) return window.gemair.computerUseScreen(); return { error: 'desktop_only' }; },
  onComputerUseEvent(cb) { return registerRendererDisposer(window.gemair && window.gemair.onComputerUseEvent ? window.gemair.onComputerUseEvent(cb) : null); },
  async codingUse(task, workingDir, config) { if (window.gemair && window.gemair.codingUse) return window.gemair.codingUse(task, workingDir, config || {}); return { ok: false, error: 'Desktop app with a local model is required for the Coding Agent.' }; },
  async codingUseStop() { if (window.gemair && window.gemair.codingUseStop) return window.gemair.codingUseStop(); return { ok: true }; },
  async codingUseStatus() { if (window.gemair && window.gemair.codingUseStatus) return window.gemair.codingUseStatus(); return { active: false }; },
  onCodingUseEvent(cb) { return registerRendererDisposer(window.gemair && window.gemair.onCodingUseEvent ? window.gemair.onCodingUseEvent(cb) : null); },
  // 2.4 Connections
  async connectionsGetStatus() {
    if (window.gemair && window.gemair.connectionsGetStatus) return window.gemair.connectionsGetStatus();
    const status = { chatgpt: { connected: false, dot: 'BROWSER_OAUTH_REQUIRED', browser: true }, gemini: { connected: false, dot: 'BROWSER_OAUTH_REQUIRED', browser: true }, freeCore: { connected: false, dot: 'CHECKING', browser: true }, meta: { priority: 'free' } };
    try {
      const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      const health = await response.json();
      status.freeCore.connected = response.ok && health.status === 'ok';
      status.freeCore.serverAiConfigured = !!health.anyAiConfigured;
      status.freeCore.dot = status.freeCore.connected ? 'READY' : 'UNAVAILABLE';
      status.freeCore.message = status.freeCore.connected ? 'Live server tools available' : 'Live server tools unavailable';
    } catch { status.freeCore.dot = 'UNAVAILABLE'; status.freeCore.message = 'Network unavailable'; }
    return status;
  },
  async connectionsSetPriority(p) { if (window.gemair) return window.gemair.connectionsSetPriority(p); },
  async connectionsAcknowledgeWarning() { if (window.gemair) return window.gemair.connectionsAcknowledgeWarning(); },
  async connectionsOpenChatGPT() { if (window.gemair) return window.gemair.connectionsOpenChatGPT(); return { ok: false, error: 'WEB_OAUTH_NOT_CONFIGURED', message: 'ChatGPT account access needs a server OAuth callback and encrypted session store. The browser cannot capture a ChatGPT session directly.' }; },
  async connectionsCaptureChatGPT() { if (window.gemair) return window.gemair.connectionsCaptureChatGPT(); return { error: 'desktop_only' }; },
  async connectionsOpenGemini() { if (window.gemair) return window.gemair.connectionsOpenGemini(); return { ok: false, error: 'WEB_OAUTH_NOT_CONFIGURED', message: 'Gemini account access needs a configured Google OAuth client and server callback. No account will be marked connected in browser mode.' }; },
  async connectionsCaptureGemini(isFallback) { if (window.gemair) return window.gemair.connectionsCaptureGemini(isFallback); return { error: 'desktop_only' }; },
  async connectionsOpenAIStudio() { if (window.gemair) return window.gemair.connectionsOpenAIStudio(); window.open('https://aistudio.google.com/', '_blank', 'noopener,noreferrer'); return { ok: true, browser: true }; },
  async connectionsDisconnect(provider) { if (window.gemair) return window.gemair.connectionsDisconnect(provider); },
  async connectionsClearAll() { if (window.gemair) return window.gemair.connectionsClearAll(); },
  async connectionsChatStream(provider, messages, onDelta) { if (window.gemair) return window.gemair.connectionsChatStream(provider, messages, onDelta); return { ok: false, error: 'WEB_ACCOUNT_BRIDGE_UNAVAILABLE', message: `${provider} account chat is not configured for this web deployment. Use the live server brain or configure OAuth server-side.` }; },
  async modesList() { if (window.gemair && window.gemair.modesList) return window.gemair.modesList(); return []; },
  async modesGet(name) { if (window.gemair) return window.gemair.modesGet(name); },
  async modesSave(mode) { if (window.gemair) return window.gemair.modesSave(mode); },
  async modesDelete(name) { if (window.gemair) return window.gemair.modesDelete(name); },
  async modesApply(name) { if (window.gemair) return window.gemair.modesApply(name); return { error: 'desktop_only' }; },
  async desktopListWindows() { if (window.gemair) return window.gemair.desktopListWindows(); return { windows: [] }; },
  async desktopGetFocused() { if (window.gemair) return window.gemair.desktopGetFocused(); return { app: '', title: '' }; },
  async desktopLaunchApp(name, args) { if (window.gemair) return window.gemair.desktopLaunchApp(name, args); return { ok: false }; },
  async desktopFocusApp(name) { if (window.gemair) return window.gemair.desktopFocusApp(name); },
  async desktopSnapWindow(dir) { if (window.gemair) return window.gemair.desktopSnapWindow(dir); },
  async desktopMinimizeAll() { if (window.gemair) return window.gemair.desktopMinimizeAll(); },
  async desktopNextDesktop() { if (window.gemair) return window.gemair.desktopNextDesktop(); },
  async desktopOpenSite(url, browser) { if (window.gemair) return window.gemair.desktopOpenSite(url, browser); return { ok: true }; },
  onConnectionsUpdated(cb) { return registerRendererDisposer(window.gemair && window.gemair.onConnectionsUpdated ? window.gemair.onConnectionsUpdated(cb) : null); },
  onConnectionsExpired(cb) { return registerRendererDisposer(window.gemair && window.gemair.onConnectionsExpired ? window.gemair.onConnectionsExpired(cb) : null); },
  onDesktopFocus(cb) { return registerRendererDisposer(window.gemair && window.gemair.onDesktopFocus ? window.gemair.onDesktopFocus(cb) : null); },
  onDesktopVolume(cb) { return registerRendererDisposer(window.gemair && window.gemair.onDesktopVolume ? window.gemair.onDesktopVolume(cb) : null); },
  onDesktopTheme(cb) { return registerRendererDisposer(window.gemair && window.gemair.onDesktopTheme ? window.gemair.onDesktopTheme(cb) : null); },
  onDesktopDnd(cb) { return registerRendererDisposer(window.gemair && window.gemair.onDesktopDnd ? window.gemair.onDesktopDnd(cb) : null); },
  onModeChanged(cb) { return registerRendererDisposer(window.gemair && window.gemair.onModeChanged ? window.gemair.onModeChanged(cb) : null); },

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
    return 'Hello. Gem here — I can search the web, check weather, prices, translate and more, all free.';
  if (/your name|who are you/.test(q)) return "I'm Gem — your personal AI inside GemAir. I understand how you feel, and I search the real web for free.";
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

  return `I can help for free — try: "weather in Mumbai", "search latest AI news", "bitcoin price", "convert 100 usd to inr", "translate hello to hindi", "define serendipity", or just talk to me.`;
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
// DEFAULTS — ONE source of truth (U3)
//
// 2.1 contradicted itself: the default city was "Mumbai" in the briefing and
// "Dubai" in the weather command, the theme fell back to 'crimson' in three
// places and 'cyan' in a fourth, and the voice mode defaulted to 'edge' in the
// profile, 'neural' in speak(), and 'neural' again in factory-reset. Everything
// now reads from this object; the theme id defers to themes.js, which stays the
// single token source.
// ---------------------------------------------------------------------------
const DEFAULTS = Object.freeze({
  name: 'Commander',
  get theme() { return (window.GemAirThemes && window.GemAirThemes.DEFAULT) || 'crimson'; },
  city: 'Mumbai',
  model: 'llama-3.3-70b-versatile',
  voiceMode: 'edge',
  voicePreset: 'gem',
  voiceRate: 1.0,
  voicePitch: 1.1,
  neuralVoice: 'en',
  edgeVoice: 'en-US-AriaNeural',
  sttLang: 'en-US',
  lang: 'en',
  appearance: 'dark',
  contextStrategy: 'balanced',
  autoUpdateChecks: true,
  ambientTrack: 'deep',
  ambientVolume: 0.35,
  currentMode: '',
  brainPriority: 'chatgpt',
  connectionsWarningAcknowledged: false
});

/** A pristine profile — used at boot and by factory reset, so they cannot drift. */
function makeDefaultProfile() {
  return {
    name: DEFAULTS.name,
    theme: DEFAULTS.theme,
    city: DEFAULTS.city,
    lang: DEFAULTS.lang,
    appearance: DEFAULTS.appearance,
    contextStrategy: DEFAULTS.contextStrategy,
    currentMode: DEFAULTS.currentMode,
    brainPriority: DEFAULTS.brainPriority,
    connectionsWarningAcknowledged: DEFAULTS.connectionsWarningAcknowledged,
    ai: { baseURL: '', apiKey: '', model: DEFAULTS.model },
    voice: {
      preset: DEFAULTS.voicePreset,
      rate: DEFAULTS.voiceRate,
      pitch: DEFAULTS.voicePitch,
      mode: DEFAULTS.voiceMode,
      neuralVoice: DEFAULTS.neuralVoice,
      edgeVoice: DEFAULTS.edgeVoice,
      sttLang: DEFAULTS.sttLang,
      name: ''
    },
    memoryOn: true, allowShell: false, adaptivePersonality: true, autoUpdateChecks: DEFAULTS.autoUpdateChecks, usageStats: false, wakeWord: false, wakeWordText: 'Hey Gem',
    ambientScore: false, ambientTrack: DEFAULTS.ambientTrack, ambientVolume: DEFAULTS.ambientVolume,
    screenAwareness: false,
    modes: {}
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let profile = makeDefaultProfile();
let memory = { facts: [], transcript: [], notes: [], reminders: [], todos: [], mood: [], goals: [], skills: [], instructions: [], actionLog: [], summary: '' };
let currentEmotion = { emotion: 'neutral', valence: 0, arousal: 0.3 };
let currentLang = 'en';
let worldHeadlines = [];
let worldCategory = 'tech';
let awaitingName = false;
let connectionsStatus = { chatgpt: { connected: false }, gemini: { connected: false }, freeCore: { connected: true }, meta: { priority: 'chatgpt' } };
let currentMode = '';
let desktopFocused = { app: '', title: '', pid: 0 };
let recentMissions = [];
let planActQueue = null;

let listening = false, recognition = null, isRunning = false;
const chatHistory = []; // working context window
const CONTEXT_TOKEN_LIMIT = 16000;
const CONTEXT_STRATEGIES = Object.freeze({
  full: { label: 'Full', keep: 100, send: 48, threshold: 90, summarize: false },
  recent: { label: 'Recent', keep: 20, send: 20, threshold: 60, summarize: true },
  balanced: { label: 'Balanced', keep: 40, send: 32, threshold: 70, summarize: true },
  minimal: { label: 'Minimal', keep: 10, send: 10, threshold: 45, summarize: true }
});
let contextCompacting = false;
let activePlan = null;

function getContextStrategy() {
  return CONTEXT_STRATEGIES[profile.contextStrategy] || CONTEXT_STRATEGIES.balanced;
}
function getContextMessages(maximum = 48) {
  const strategy = getContextStrategy();
  const count = Math.max(1, Math.min(maximum, strategy.send));
  return chatHistory.slice(-count);
}
function estimateContextTokens(extraText = '') {
  const chars = chatHistory.reduce((sum, message) => sum + String(message.content || '').length + String(message.role || '').length + 4, 0) + String(extraText || '').length;
  return Math.ceil(chars / 4);
}

const contextElements = { chip: null, value: null, bar: null };
function getContextElements() {
  contextElements.chip ||= $('#contextChip');
  contextElements.value ||= $('#contextValue');
  contextElements.bar ||= $('#contextBar');
  return contextElements;
}
function updateContextMeter(extraText = '') {
  const tokens = estimateContextTokens(extraText);
  const percent = Math.min(100, Math.round(tokens / CONTEXT_TOKEN_LIMIT * 100));
  const strategy = getContextStrategy();
  const { chip, value, bar } = getContextElements();
  if (value) value.textContent = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : String(tokens);
  if (bar) bar.style.width = percent + '%';
  if (chip) {
    chip.classList.toggle('warn', percent >= strategy.threshold && percent < 90);
    chip.classList.toggle('danger', percent >= 90);
    chip.title = `${tokens.toLocaleString()} estimated tokens · ${percent}% of ${CONTEXT_TOKEN_LIMIT.toLocaleString()} · ${strategy.label} strategy`;
  }
  [['#townCtx', percent], ['#townCtxMini', percent]].forEach(([selector, pct]) => { const meter = $(selector); if (meter) meter.style.width = pct + '%'; });
  return { tokens, percent };
}

async function compactChatContextIfNeeded(extraText = '') {
  const usage = updateContextMeter(extraText);
  const strategy = getContextStrategy();
  const underPressure = usage.percent >= strategy.threshold;
  const storedLimit = strategy.keep + (strategy.summarize ? Math.max(4, Math.floor(strategy.keep * 0.25)) : 0);
  if ((!underPressure && chatHistory.length <= storedLimit) || contextCompacting || chatHistory.length < 4) return false;
  contextCompacting = true;
  try {
    const keepCount = underPressure ? Math.min(strategy.keep, Math.max(2, Math.floor(chatHistory.length * 0.6))) : strategy.keep;
    const keep = chatHistory.slice(-keepCount);
    const old = chatHistory.slice(0, -keepCount);
    if (!old.length) return false;
    if (!strategy.summarize) {
      chatHistory.splice(0, chatHistory.length, ...keep);
      updateContextMeter(extraText);
      toast('CTX TRIMMED', `Full strategy retained the latest ${keep.length} messages.`, '◫');
      return true;
    }
    const transcript = old.map((message) => `${message.role}: ${message.content}`).join('\n').slice(-60000);
    let summary = null;
    try {
      const result = await api.aiSummarize(profile.ai || {}, transcript);
      if (result && result.ok && result.summary) summary = String(result.summary).slice(0, 12000);
    } catch (e) {}
    if (!summary) {
      summary = old.slice(-12).map((message) => `• ${message.role}: ${String(message.content || '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
    }
    chatHistory.splice(0, chatHistory.length, { role: 'system', content: `Conversation summary (${strategy.label} strategy):\n${summary}` }, ...keep);
    updateContextMeter(extraText);
    toast('CTX COMPRESSED', `${old.length} older messages summarized; ${keep.length} recent messages retained.`, '◫');
    return true;
  } finally { contextCompacting = false; }
}

function planForRequest(text) {
  const source = String(text || '').trim();
  const explicit = source.split(/(?:\n\s*\d+[.)]\s*|\s+then\s+|\s+and then\s+|;)/i).map((part) => part.replace(/^\d+[.)]\s*/, '').trim()).filter((part) => part.length > 3);
  if (explicit.length >= 2) return explicit.slice(0, 5);
  const verbs = source.match(/\b(search|research|find|compare|write|create|save|verify|check|scan|send|email|organize|summarize|plan|open|read|build|test)\b/gi) || [];
  if (verbs.length < 2 && source.length < 150) return [];
  if (/research|search|find/i.test(source) && /write|create|save/i.test(source)) return ['Research and verify sources', 'Create and save the deliverable', 'Verify the result'];
  return ['Understand scope and constraints', 'Execute the required tools', 'Verify and report the outcome'];
}

// ---------------------------------------------------------------------------
// T2 — visible reasoning stream (Stonic's "Luna" feature).
//
// 2.1 rendered a static numbered plan and nothing else: the user could see WHAT
// Gem intended but never WHY, and no live narration of the work. This renders a
// collapsible strip above the reply, fed by the same planner events plus the
// tool-execution events the mission log already emits, so it reflects real work
// rather than a decorative animation. Collapsed by default; the choice sticks.
// ---------------------------------------------------------------------------
const REASON_OPEN_KEY = 'gemair:reasoning-open';

function reasoningOpenPref() {
  try { return localStorage.getItem(REASON_OPEN_KEY) === '1'; } catch (e) { return false; }
}

function renderReasoningStrip(messageEl, text, steps) {
  if (!messageEl) return null;
  const open = reasoningOpenPref();
  const strip = document.createElement('details');
  strip.className = 'reason-strip';
  strip.open = open;
  strip.innerHTML = `
    <summary>
      <span class="reason-pip" aria-hidden="true"></span>
      <span class="reason-label">REASONING</span>
      <span class="reason-hint dim" data-reason-hint>thinking…</span>
    </summary>
    <div class="reason-body" data-reason-body></div>`;
  strip.addEventListener('toggle', () => {
    try { localStorage.setItem(REASON_OPEN_KEY, strip.open ? '1' : '0'); } catch (e) {}
  });
  const paragraph = messageEl.querySelector('p');
  messageEl.insertBefore(strip, paragraph || messageEl.firstChild);

  const body = strip.querySelector('[data-reason-body]');
  const hint = strip.querySelector('[data-reason-hint]');

  const push = (kind, line) => {
    if (!body || !body.isConnected) return;
    const row = document.createElement('div');
    row.className = 'reason-line ' + kind;
    row.textContent = line;
    body.appendChild(row);
    if (hint) hint.textContent = line.length > 46 ? line.slice(0, 46) + '…' : line;
  };

  // seed with the planner's read of the request
  push('plan', `Interpreting: ${String(text || '').slice(0, 120)}`);
  if (steps && steps.length) {
    steps.forEach((step, i) => push('plan', `Step ${i + 1}: ${step}`));
  } else {
    push('plan', 'Single-step request — answering directly.');
  }

  return {
    push,
    done(summary) {
      if (hint) hint.textContent = summary || 'done';
      strip.classList.add('finished');
    }
  };
}

/** The reasoning stream for the reply currently being generated. */
let activeReasoning = null;

/** Called from tool execution so the strip narrates real work (not a fake). */
function reasoningNote(kind, line) {
  try { if (activeReasoning) activeReasoning.push(kind, line); } catch (e) {}
}

function renderPlanner(messageEl, text) {
  const steps = planForRequest(text);
  // T2: the reasoning strip renders for EVERY reply, even when there is no
  // multi-step plan — that is the point of a visible thinking channel.
  activeReasoning = renderReasoningStrip(messageEl, text, steps);
  if (!messageEl || !steps.length) { activePlan = null; return; }
  const panel = document.createElement('div');
  panel.className = 'plan-checklist';
  panel.innerHTML = `<div class="plan-title">NUMBERED EXECUTION PLAN</div><div class="plan-steps">${steps.map((step, index) => `<span class="plan-step${index === 0 ? ' running' : ''}" data-plan-step="${index}"><i>${index + 1}</i>${escapeHtml(step)}</span>`).join('')}</div>`;
  const paragraph = messageEl.querySelector('p');
  messageEl.insertBefore(panel, paragraph || messageEl.firstChild);
  activePlan = { panel, steps, completed: 0 };
}

function tickPlannerStep() {
  if (!activePlan || !activePlan.panel || !activePlan.panel.isConnected) return;
  const nodes = activePlan.panel.querySelectorAll('.plan-step');
  const current = nodes[activePlan.completed];
  if (current) { current.classList.remove('running'); current.classList.add('done'); const icon = current.querySelector('i'); if (icon) icon.textContent = '✓'; }
  activePlan.completed++;
  const next = nodes[activePlan.completed]; if (next) next.classList.add('running');
}

// U1: ONE agent colour map. 2.1 kept the same four hex values in `agentColors`
// (inside a render fn) and again in TOWN_MINI_COLORS ~500 lines later.
const AGENT_COLORS = { Alice: '#ff5d8f', Bob: '#5d9cff', Carol: '#4be3a1', Dave: '#c78bff' };

const AGENTS = [
  { name: 'Alice', emoji: '👩‍💻', role: 'Web Research · search / fetch', talk: 'Verifying live sources on the web…' },
  { name: 'Bob', emoji: '👨‍🔧', role: 'File Ops · read / write / organize', talk: 'Inspecting paths before I touch a file.' },
  { name: 'Carol', emoji: '👩‍🔬', role: 'System · battery / disk / scan', talk: 'Checking live system health and capacity.' },
  { name: 'Dave', emoji: '🧑‍💼', role: 'Comms · email / WhatsApp', talk: 'Preparing a draft for your approval.' }
];

// Section III — the 12 one-sentence workflows (Stonic roadmap parity), each a
// tested tool chain. Also surfaced in the command palette as recipes.
const WORKFLOWS = [
  { id: 'wf-organize', name: 'Organize Downloads by Type', detail: 'sort files into folders', icon: '🗂', prompt: "Organize my Downloads folder by file type" },
  { id: 'wf-screenshots', name: 'Gather This Week\u2019s Screenshots', detail: 'find + move screenshots into one folder', icon: '📸', prompt: "Find this week's screenshots and move them into one folder" },
  { id: 'wf-large-files', name: 'Find Huge Unused Files', detail: 'files over 500MB unused 6 months', icon: '📦', prompt: "Find files over 500MB that I have not used for 6 months" },
  { id: 'wf-scaffold', name: 'Scaffold Project Folder Tree', detail: 'create src/docs/tests structure', icon: '🌱', prompt: "Scaffold a project folder tree for my new project" },
  { id: 'wf-morning', name: 'Morning App Stack Launch', detail: 'open browser, email, calendar', icon: '☀️', prompt: "Launch my morning app stack: browser, email and calendar" },
  { id: 'wf-close-except', name: 'Close Everything Except\u2026', detail: 'quit all apps but keep one', icon: '✂️', prompt: "Close everything except Spotify" },
  { id: 'wf-focus', name: 'Focus Block', detail: 'close browsers + messengers', icon: '🎯', prompt: "Start a focus block — close browsers and messengers" },
  { id: 'wf-open-search', name: 'Open Site & Search Instantly', detail: 'open site then search', icon: '🔎', prompt: "Open Google and search instantly for AI news" },
  { id: 'wf-multi-tabs', name: 'Open Multiple Tabs', detail: 'open several sites at once', icon: '🗔', prompt: "Open these tabs: GitHub, YouTube, and Gmail" },
  { id: 'wf-ram-check', name: 'Spoken RAM & Performance Check', detail: 'read CPU/memory out loud', icon: '📊', prompt: "Do a spoken RAM and performance check" },
  { id: 'wf-gaming', name: 'Optimize PC for Gaming', detail: 'power plan + temp + close heavy apps', icon: '🎮', prompt: "Optimize my PC for gaming" },
  { id: 'wf-whatsapp', name: 'Hands-free WhatsApp Message', detail: 'open a drafted WhatsApp message', icon: '💬', prompt: "Send a hands-free WhatsApp message saying hello" }
];

// Voice presets — bound to specific Microsoft Edge neural voices with tuned
// rate/pitch (Section IIe). Fallbacks remain for the Google accent engine.
const VOICE_PRESETS = {
  gem: { label: 'Gem', gender: 'female', rate: 1.0, pitch: 1.0, edgeVoice: 'en-US-AriaNeural', neuralVoice: 'en' },
  jarvis: { label: 'JARVIS', gender: 'male', rate: 0.86, pitch: 0.82, edgeVoice: 'en-GB-RyanNeural', neuralVoice: 'en-GB' },
  nova: { label: 'Nova', gender: 'female', rate: 1.08, pitch: 1.05, edgeVoice: 'en-US-JennyNeural', neuralVoice: 'en' }
};
const STT_LANGUAGES = ['en-US', 'en-GB', 'en-IN', 'hi-IN', 'ur-PK', 'ur-IN'];

// Map an STT language to a matching Edge neural voice (Section IId).
function edgeVoiceForSttLang(lang) {
  if (window.edgeTts && window.edgeTts.voiceForLang) return window.edgeTts.voiceForLang(lang);
  return 'en-US-AriaNeural';
}

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

let speechGen = 0;             // monotonic generation to cancel stale speech

/**
 * Hard-stop every speech path (R3).
 *
 * Before 2.2 this only cancelled speechSynthesis, so barge-in froze the avatar
 * mouth while the Edge/neural <audio> element kept talking over the user. Now
 * it also stops the single TTS engine and drains queued streaming segments.
 */
function stopSpeaking() {
  speechGen++;
  try { speechSynthesis.cancel(); } catch (e) {}
  try { if (window.ttsEngine) window.ttsEngine.stop(); } catch (e) {}
  try {
    if (streamSpeechState) {
      streamSpeechState.cancelled = true;
      streamSpeechState.pending = 0;
      streamSpeechState.queue = Promise.resolve();
    }
  } catch (e) {}
  document.body.classList.remove('rgb-speaking');
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
  // U2: 2.1 left the SYS chip frozen at "SYSTEMS NOMINAL" no matter how many
  // subsystems failed to boot. Tell the truth instead.
  updateSystemStatusChip();
  if (_initFailures.length === 1 && window.gemair) {
    setTimeout(() => {
      try {
        toast('DEGRADED', `${_initFailures.length} component(s) failed to start — the rest of GemAir still works.`, '⚠');
      } catch (e) {}
    }, 1200);
  }
}

/** U2 — the SYS chip and footer reflect real init state, not a fixed string. */
function updateSystemStatusChip() {
  const chip = $('#sysChipText');
  const footer = $('#footerRight');
  const n = _initFailures.length;
  const t = (k, fallback) => {
    try { return (window.GemAirI18n && window.GemAirI18n.t(k)) || fallback; } catch (e) { return fallback; }
  };
  if (!n) {
    if (chip) { chip.textContent = t('status.nominal', 'SYSTEMS NOMINAL'); chip.title = 'All subsystems started cleanly.'; }
    if (footer) footer.textContent = 'ALL SYSTEMS NOMINAL';
    document.body.classList.remove('sys-degraded');
    return;
  }
  const names = _initFailures.map((f) => f.label).join(', ');
  if (chip) {
    chip.textContent = `${t('status.degraded', 'DEGRADED')} — ${n} SUBSYSTEM${n > 1 ? 'S' : ''}`;
    chip.title = `Failed to start: ${names}`;
  }
  if (footer) footer.textContent = `DEGRADED — ${n} SUBSYSTEM${n > 1 ? 'S' : ''} OFFLINE`;
  document.body.classList.add('sys-degraded');
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
const rendererLifecycle = typeof AbortController === 'function' ? new AbortController() : null;
const rendererDisposers = new Set();
function addLifecycleListener(target, type, handler, options = {}) {
  if (!target || typeof target.addEventListener !== 'function') return handler;
  const normalized = typeof options === 'boolean' ? { capture: options } : { ...options };
  if (rendererLifecycle) normalized.signal = rendererLifecycle.signal;
  target.addEventListener(type, handler, normalized);
  return handler;
}
function registerRendererDisposer(disposer) {
  if (typeof disposer === 'function') rendererDisposers.add(disposer);
  return disposer;
}
function disposeRendererLifecycle() {
  if (rendererLifecycle && !rendererLifecycle.signal.aborted) rendererLifecycle.abort();
  for (const dispose of rendererDisposers) {
    try { dispose(); } catch {}
  }
  rendererDisposers.clear();
}
window.addEventListener('beforeunload', disposeRendererLifecycle, { once: true });

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
// Theme (with RGB / rainbow mode) & Synthetic Web Audio SFX
// ---------------------------------------------------------------------------
// U1: hues live in themes.js (the single token source). This derives the legacy
// hue lookup from it instead of hard-coding a third copy of the numbers.
const THEME_ACCENTS = (() => {
  const out = {};
  try {
    for (const t of (window.GemAirThemes ? window.GemAirThemes.list() : [])) out[t.id] = t.hue;
  } catch (e) {}
  return out;
})();
let currentAccent = '#ff3b3b';
let rgbTimer = null;
let rgbHue = 300;
let globalAudioCtx = null;
let globalAnalyser = null;

let scoreNodes = null;

// A restrained, fully local Web Audio score. It starts only after a user
// enables it (browser autoplay policy) and defaults to OFF.
/**
 * T5 — ambient score with a volume slider and two selectable tracks.
 *
 * 2.1 had a single hard-coded drone at a fixed 0.035 gain and no way to change
 * either. The gain node is now kept so the slider can retarget it live, and
 * each track is a distinct oscillator recipe with an audible difference.
 */
const AMBIENT_TRACKS = {
  deep: {
    label: 'DEEP FIELD',
    cutoff: 420,
    voices: [
      { hz: 55, type: 'sine', gain: 0.65 },
      { hz: 82.41, type: 'triangle', gain: 0.18 },
      { hz: 110, type: 'sine', gain: 0.18 }
    ],
    lfo: { hz: 0.07, depth: 130 }   // slow filter sweep = "breathing" pulse
  },
  reactor: {
    label: 'REACTOR',
    cutoff: 620,
    voices: [
      { hz: 65.41, type: 'sawtooth', gain: 0.16 },
      { hz: 98, type: 'sine', gain: 0.5 },
      { hz: 196, type: 'triangle', gain: 0.09 }
    ],
    lfo: { hz: 0.9, depth: 60 }     // faster shimmer = "warm hum + ticks"
  }
};

function ambientVolume() {
  const v = Number(profile.ambientVolume);
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : DEFAULTS.ambientVolume));
}

/** Peak gain for the master node — the slider maps 0..1 onto a gentle range. */
function ambientGainTarget() {
  return 0.0001 + ambientVolume() * 0.09;
}

function setAmbientVolume(value) {
  profile.ambientVolume = Math.max(0, Math.min(1, Number(value) || 0));
  if (scoreNodes) {
    try { scoreNodes.gain.gain.setTargetAtTime(ambientGainTarget(), scoreNodes.ctx.currentTime, 0.12); } catch (e) {}
  }
}

function stopAmbientScore() {
  if (!scoreNodes) return;
  try { scoreNodes.gain.gain.setTargetAtTime(0, scoreNodes.ctx.currentTime, 0.18); } catch (e) {}
  const old = scoreNodes;
  scoreNodes = null;
  setTimeout(() => {
    try { old.oscillators.forEach((osc) => osc.stop()); } catch (e) {}
    try { if (old.lfo) old.lfo.stop(); } catch (e) {}
  }, 900);
}

function setAmbientScore(enabled, trackId) {
  if (trackId && trackId !== profile.ambientTrack) profile.ambientTrack = trackId;
  if (!enabled) { stopAmbientScore(); return; }
  // T5: switching track while playing must restart with the new recipe so the
  // change is instantly audible, which is the whole point of the preview.
  if (scoreNodes) {
    if (scoreNodes.track === (profile.ambientTrack || DEFAULTS.ambientTrack)) return;
    stopAmbientScore();
  }
  const id = profile.ambientTrack || DEFAULTS.ambientTrack;
  const track = AMBIENT_TRACKS[id] || AMBIENT_TRACKS[DEFAULTS.ambientTrack];
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = globalAudioCtx || new AudioCtx();
    globalAudioCtx = ctx;
    if (ctx.state === 'suspended') ctx.resume();

    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, ambientGainTarget()), ctx.currentTime + 1.4);
    filter.type = 'lowpass';
    filter.frequency.value = track.cutoff;
    filter.connect(gain);
    gain.connect(ctx.destination);

    const oscillators = track.voices.map((v) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = v.type;
      osc.frequency.value = v.hz;
      g.gain.value = v.gain;
      osc.connect(g); g.connect(filter); osc.start();
      return osc;
    });

    // gentle movement so the bed never sounds like a stuck tone
    let lfo = null;
    try {
      lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = track.lfo.hz;
      lfoGain.gain.value = track.lfo.depth;
      lfo.connect(lfoGain); lfoGain.connect(filter.frequency);
      lfo.start();
    } catch (e) { lfo = null; }

    scoreNodes = { ctx, gain, oscillators, lfo, track: id };
  } catch (e) { scoreNodes = null; }
}

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
  const lightAppearance = profile.appearance === 'light';
  const lightness = lightAppearance ? 38 : 60;
  const accent = `hsl(${h}, 92%, ${lightness}%)`;
  const soft = `hsla(${h}, 92%, ${lightness}%, ${lightAppearance ? 0.7 : 0.55})`;
  const glow = `hsla(${h}, 92%, ${lightness}%, ${lightAppearance ? 0.2 : 0.35})`;
  const dim = `hsla(${h}, 92%, ${lightness}%, ${lightAppearance ? 0.1 : 0.14})`;
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

let rgbBurstTimer = null;
function triggerRgbBurst() {
  const restore = profile.theme || DEFAULTS.theme;
  if (rgbBurstTimer) clearTimeout(rgbBurstTimer);
  document.body.classList.add('konami-burst');
  applyTheme('rgb');
  toast('KONAMI UNLOCKED', 'Full-spectrum arc reactor burst engaged.', '🌈');
  rgbBurstTimer = setTimeout(() => {
    document.body.classList.remove('konami-burst');
    applyTheme(restore);
    rgbBurstTimer = null;
  }, REDUCED_MOTION ? 900 : 8000);
}

function applyAppearance(mode, { notify = false } = {}) {
  const appearance = mode === 'light' ? 'light' : 'dark';
  profile.appearance = appearance;
  let appliedTheme = null;
  if (window.GemAirThemes && typeof window.GemAirThemes.setAppearance === 'function') appliedTheme = window.GemAirThemes.setAppearance(appearance);
  else document.body.dataset.appearance = appearance;
  if (appliedTheme && profile.theme !== 'rgb') currentAccent = appliedTheme.accent;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = appearance === 'light' ? '#f4f7fb' : '#04060c';
  const toggle = $('#appearanceToggle');
  if (toggle) {
    const light = appearance === 'light';
    toggle.setAttribute('aria-pressed', String(light));
    toggle.textContent = light ? '🌙 SWITCH TO DARK' : '☀ SWITCH TO LIGHT';
  }
  if (notify) toast('APPEARANCE', appearance.toUpperCase() + ' mode enabled.', appearance === 'light' ? '☀' : '🌙');
  return appearance;
}
function toggleAppearance() {
  applyAppearance(profile.appearance === 'light' ? 'dark' : 'light', { notify: true });
  persistProfile();
}

function applyTheme(t) {
  // String-driven theme engine (renderer/themes.js) is the single source
  // of truth: it writes all color tokens out as CSS variables and fires
  // `gemair:theme`, so the DOM and every canvas re-skin together.
  if (window.GemAirThemes) {
    if (typeof window.GemAirThemes.setAppearance === 'function') window.GemAirThemes.setAppearance(profile.appearance || DEFAULTS.appearance);
    const theme = window.GemAirThemes.apply(t);
    if (t !== 'rgb') currentAccent = theme.accent; // string token → all canvases
  }
  document.body.dataset.theme = t;
  const themeGrid = $('#themeGrid');
  if (themeGrid) themeGrid.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('active', c.dataset.tid === t));
  if (t === 'rgb') { startRgb(); }
  else {
    stopRgb();
    if (!window.GemAirThemes) setAccentFromHue(THEME_ACCENTS[t] || 0); // legacy fallback
  }
}

// ---------------------------------------------------------------------------
// AI provider detection — which brain is the endpoint talking to?
// Uses the shared catalog in providers.js (single source of truth) with a
// small legacy fallback for older detection strings.
// ---------------------------------------------------------------------------
function detectProvider(base) {
  if (window.GemAirProviders && window.GemAirProviders.detect) {
    const id = window.GemAirProviders.detect(base);
    // normalize legacy ids used by older call sites
    if (id === 'chatgpt') return 'openai';
    if (id === 'local') return 'ollama';
    return id;
  }
  const b = (base || '').toLowerCase();
  if (!b) return 'free';
  if (b.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (b.includes('api.openai.com')) return 'openai';
  if (b.includes('api.anthropic.com')) return 'claude';
  if (b.includes('api.deepseek.com')) return 'deepseek';
  if (b.includes('api.mistral.ai')) return 'mistral';
  if (b.includes('api.groq.com')) return 'groq';
  if (b.includes('openrouter.ai')) return 'openrouter';
  if (b.includes('cerebras.ai')) return 'cerebras';
  if (b.includes('sambanova.ai')) return 'sambanova';
  if (b.includes('api.together.xyz')) return 'together';
  if (b.includes('api.x.ai')) return 'xai';
  if (b.includes('api.z.ai')) return 'zai';
  if (b.includes('hyperbolic.xyz')) return 'hyperbolic';
  if (b.includes('deepinfra.com')) return 'deepinfra';
  if (b.includes('siliconflow.com')) return 'siliconflow';
  if (b.includes('novita.ai')) return 'novita';
  if (b.includes('fireworks.ai')) return 'fireworks';
  if (b.includes('integrate.api.nvidia.com')) return 'nvidia';
  if (b.includes('router.huggingface.co')) return 'hf';
  if (/localhost|127\.0\.0\.1/.test(b)) return 'ollama';
  return 'custom';
}

function providerNameOf(prov) {
  if (window.GemAirProviders && window.GemAirProviders.name) return window.GemAirProviders.name(prov);
  const legacy = {
    gemini: 'Google Gemini', openai: 'ChatGPT / OpenAI', chatgpt: 'ChatGPT / OpenAI', claude: 'Anthropic Claude',
    deepseek: 'DeepSeek', mistral: 'Mistral', groq: 'Groq', openrouter: 'OpenRouter',
    cerebras: 'Cerebras', sambanova: 'SambaNova', together: 'Together AI', xai: 'xAI (Grok)',
    zai: 'Z.AI (GLM)', hyperbolic: 'Hyperbolic', deepinfra: 'DeepInfra', siliconflow: 'SiliconFlow',
    novita: 'Novita AI', fireworks: 'Fireworks AI', nvidia: 'NVIDIA NIM', hf: 'Hugging Face',
    ollama: 'Local model', local: 'Local model', custom: 'Custom endpoint', free: 'Free Core'
  };
  return legacy[prov] || prov || '—';
}

const PROVIDER_NAMES = {
  gemini: 'Google Gemini', openai: 'ChatGPT / OpenAI', chatgpt: 'ChatGPT / OpenAI', claude: 'Anthropic Claude',
  deepseek: 'DeepSeek', mistral: 'Mistral', groq: 'Groq', openrouter: 'OpenRouter',
  cerebras: 'Cerebras', sambanova: 'SambaNova', together: 'Together AI', xai: 'xAI (Grok)',
  zai: 'Z.AI (GLM)', hyperbolic: 'Hyperbolic', deepinfra: 'DeepInfra', siliconflow: 'SiliconFlow',
  novita: 'Novita AI', fireworks: 'Fireworks AI', nvidia: 'NVIDIA NIM', hf: 'Hugging Face',
  local: 'Local model', ollama: 'Local model', custom: 'Custom endpoint', free: 'Free Core'
};

// Settings → HUD THEMES picker, generated from the string theme table.
function renderThemeGrid() {
  const grid = $('#themeGrid');
  if (!grid || !window.GemAirThemes) return;
  grid.innerHTML = window.GemAirThemes.list().map((t) => `
    <div class="theme-card${t.id === (profile && profile.theme) ? ' active' : ''}" data-tid="${t.id}" role="button" tabindex="0" title="Apply ${escapeHtml(t.label)} theme">
      <span class="swatch" style="background:${t.accent};color:${t.accent}"></span>
      <span class="tc-text"><span class="tc-name">${escapeHtml(t.label)}</span><span class="tc-tag">${escapeHtml(t.tagline)}</span></span>
    </div>`).join('');
  grid.querySelectorAll('.theme-card').forEach((c) => {
    const pick = () => {
      playSfx('click');
      profile.theme = c.dataset.tid;
      applyTheme(profile.theme);
      persistProfile();
      toast('THEMES', 'HUD theme → ' + c.dataset.tid.toUpperCase(), '🎨');
    };
    c.addEventListener('click', pick);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
}

// First-run theme modal swatches — also generated from the same string
// table, so the modal's colors are guaranteed to match what applyTheme()
// actually paints across the DOM and canvases.
function renderThemeSwatches() {
  const grid = $('#themeSwatches');
  if (!grid || !window.GemAirThemes) return;
  grid.innerHTML = window.GemAirThemes.list().map((t) =>
    `<button class="swatch" data-theme="${t.id}" title="${escapeHtml(t.tagline)}"><i class="${t.dynamic ? 'rgb-sw' : ''}"${t.dynamic ? '' : ` style="--sw:${t.accent}"`}></i><span>${escapeHtml(t.label)}</span></button>`
  ).join('');
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = new Date();
  $('#liveClock').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  $('#liveDate').textContent = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
  const clockAt = (timeZone) => now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  const utc = $('#utcTime'); if (utc) utc.textContent = clockAt('UTC');
  const strip = $('#worldUtcStrip');
  if (strip) strip.textContent = `UTC ${clockAt('UTC')} · LON ${clockAt('Europe/London')} · NYC ${clockAt('America/New_York')} · TYO ${clockAt('Asia/Tokyo')}`;
}, 1000);

// ---------------------------------------------------------------------------
// View-aware animation scheduler. Hidden town/radar/globe canvases hold no
// requestAnimationFrame at all; switching views resumes exactly one frame loop.
// ---------------------------------------------------------------------------
const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const viewFrameWaiters = new Map();
const reducedMotionDrawn = new Set();
function viewIsActive(view) {
  if (typeof document.hidden === 'boolean' && document.hidden) return false;
  if (!view) return true;
  const element = document.getElementById('view-' + view);
  return !!(element && element.classList.contains('active'));
}
function scheduleViewFrame(view, callback) {
  if (REDUCED_MOTION) {
    if (!reducedMotionDrawn.has(callback)) { reducedMotionDrawn.add(callback); requestAnimationFrame(callback); }
    return;
  }
  if (viewIsActive(view)) requestAnimationFrame(callback);
  else {
    if (!viewFrameWaiters.has(view)) viewFrameWaiters.set(view, new Set());
    viewFrameWaiters.get(view).add(callback);
  }
}
function resumeViewFrames(view) {
  const waiting = viewFrameWaiters.get(view);
  if (!waiting) return;
  viewFrameWaiters.delete(view);
  waiting.forEach((callback) => requestAnimationFrame(callback));
}
addLifecycleListener(document, 'visibilitychange', () => {
  if (!document.hidden) {
    const active = $$('.view').find((view) => view.classList.contains('active'));
    if (active) resumeViewFrames(active.id.replace('view-', ''));
    resumeViewFrames(null);
  }
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function switchView(view) {
  playSfx('swoosh');
  api.trackUsage('view.' + String(view || 'unknown'));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  resumeViewFrames(view);
  if (view === 'world') refreshHeadlines();
  if (view === 'core') renderProcesses();
}

/**
 * S2 — ACTIVE PROCESSES, for real.
 *
 * 2.1 rendered a hardcoded six-row fantasy list ("GemAir Audio & Visualizer",
 * pid 2184) on every platform, including the desktop build where genuine data
 * is available. This queries the main process and renders real name/pid/cpu/mem
 * rows, with an END button behind the existing HITL confirm dialog. In the
 * browser build there are no OS processes to show, so it says so plainly (U2).
 */
let processCache = [];
let processScanning = false;

function processRowHtml(p) {
  const name = escapeHtml(p.name);
  const cpu = Number(p.cpu || 0).toFixed(1);
  const mem = Number(p.memMB || 0).toFixed(0);
  return `
    <div class="mem-item proc-row" data-pid="${p.pid}">
      <div>
        <b style="font-family:var(--font-mono);color:var(--accent);">[${p.pid}]</b>
        <span style="font-weight:600;margin-left:8px;">${name}</span>
        <span class="dim" style="font-size:11px;margin-left:10px;">CPU ${cpu}% · RAM ${mem} MB${p.memPct ? ` (${p.memPct}%)` : ''}</span>
      </div>
      <button class="ghost-btn proc-kill" data-pid="${p.pid}" data-name="${name}" aria-label="End process ${name}" style="padding:4px 10px;font-size:10px;">End</button>
    </div>`;
}

function paintProcessList() {
  const container = $('#processList');
  if (!container) return;
  const filter = ($('#procFilter')?.value || '').toLowerCase().trim();
  const rows = processCache.filter((p) => !filter || p.name.toLowerCase().includes(filter) || String(p.pid).includes(filter));
  if (!rows.length) {
    container.innerHTML = `<div class="empty">${processCache.length ? 'No processes match that filter.' : 'No processes to show.'}</div>`;
    return;
  }
  container.innerHTML = rows.slice(0, 60).map(processRowHtml).join('');
}

async function renderProcesses(force) {
  const container = $('#processList');
  if (!container) return;
  if (!isElectron) {
    container.innerHTML = '<div class="empty">Process monitoring needs the desktop app — the browser sandbox cannot see OS processes. <b>Download GemAir</b> to enable it.</div>';
    return;
  }
  if (processCache.length && !force) { paintProcessList(); return; }
  if (processScanning) return;
  processScanning = true;
  container.innerHTML = '<div class="empty">Scanning processes…</div>';
  try {
    const res = await api.listProcesses(60);
    if (!res || !res.ok) {
      container.innerHTML = '<div class="empty">Could not read the process table on this system.</div>';
      return;
    }
    processCache = res.procs || [];
    paintProcessList();
  } finally {
    processScanning = false;
  }
}

async function killProcessFromUi(pid, name) {
  // HITL: main.js shows the confirm dialog before anything is terminated.
  const res = await api.killProcess(Number(pid), name);
  if (res && res.ok) {
    processCache = processCache.filter((p) => p.pid !== Number(pid));
    paintProcessList();
    toast('MONITOR', `Ended ${name} (PID ${pid})`, '🛑');
    playSfx('click');
  } else if (res && res.error && !/cancelled/i.test(res.error)) {
    toast('MONITOR', res.error, '⚠️');
  }
}

// ---------------------------------------------------------------------------
// S3 — Tasks panel.
//
// memory.todos already existed (the AI could add/complete them by voice, and
// the weekly report aggregated them into a tasks-per-day sparkline) but NO UI
// ever created one, so that chart was permanently flat. This is the missing
// surface: add, complete, delete.
// ---------------------------------------------------------------------------
function renderTodos() {
  const list = $('#todoList');
  if (!list) return;
  const todos = (memory.todos || []).slice();
  const openCount = todos.filter((t) => !t.done).length;
  const count = $('#todoCount');
  if (count) count.textContent = todos.length ? `— ${openCount} OPEN · ${todos.length - openCount} DONE` : '';
  if (!todos.length) {
    list.innerHTML = '<div class="empty">No tasks yet. Add one above, or just tell Gem “remind me to finish the report”.</div>';
    return;
  }
  list.innerHTML = todos.map((t) => `
    <div class="mem-item todo-item${t.done ? ' done' : ''}">
      <label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;">
        <input type="checkbox" class="todo-toggle" data-id="${t.id}" ${t.done ? 'checked' : ''} aria-label="Mark task complete" />
        <span style="${t.done ? 'text-decoration:line-through;opacity:.55;' : ''}">${escapeHtml(t.text)}</span>
      </label>
      <button class="ghost-btn todo-del" data-id="${t.id}" aria-label="Delete task" style="padding:4px 10px;font-size:10px;">✕</button>
    </div>`).join('');
}

async function addTodoFromUi() {
  const input = $('#todoInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await api.memoryAddTodo(text);
  await loadMemory();
  renderTodos();
  playSfx('click');
  toast('TASKS', 'Task added', '✅');
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
  if (!Number.isFinite(b)) return 'Unavailable';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = b ? Math.floor(Math.log(b) / Math.log(1024)) : 0;
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}
function fmtUptime(s) {
  if (!Number.isFinite(s)) return 'Unavailable';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}
function debounce(fn, wait = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
async function pollSystem() {
  try {
    const i = await api.getSystemInfo();
    $('#cpuVal').textContent = Number.isFinite(i.cpuLoad) ? i.cpuLoad + '%' : 'N/A';
    $('#memVal').textContent = Number.isFinite(i.memPercent) ? i.memPercent + '%' : 'N/A';
    setGauge('#cpuGauge', i.cpuLoad); setGauge('#memGauge', i.memPercent);
    $('#tHost').textContent = i.hostname;
    $('#tPlatform').textContent = i.platform + ' (' + i.arch + ')';
    $('#tCores').textContent = i.cpus ? i.cpus + ' logical cores' : 'Unavailable';
    $('#tUptime').textContent = fmtUptime(i.uptime);
    $('#tMemUsed').textContent = fmtBytes(i.memUsed) + ' / ' + fmtBytes(i.memTotal);
    $('#tLoad').textContent = (i.loadavg || []).map((n) => n.toFixed(1)).join(' · ') || 'Unavailable';
    const bat = $('#tBattery');
    if (bat) {
      if (i.battery && typeof i.battery.percent === 'number') bat.textContent = i.battery.percent + '%' + (i.battery.charging ? ' ⚡ charging' : '');
      else bat.textContent = 'Unavailable';
    }
    const disk = $('#tDisk');
    if (disk) {
      if (i.disk && i.disk.totalGB) disk.textContent = i.disk.freeGB + ' GB free of ' + i.disk.totalGB + ' GB (' + (100 - i.disk.percent) + '%)';
      else disk.textContent = '—';
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 3D background scene (starfield + rotating wireframe polyhedron + parallax)
// ---------------------------------------------------------------------------
let background3DStarted = false, orbStarted = false, globeStarted = false;
function startBackground3D() {
  if (background3DStarted) return;
  const canvas = $('#bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  background3DStarted = true;
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
  addLifecycleListener(window, 'resize', debounce(resize), { passive: true });
  addLifecycleListener(window, 'mousemove', (e) => { mx = (e.clientX / w - 0.5) * 2; my = (e.clientY / h - 0.5) * 2; }, { passive: true });

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
    scheduleViewFrame(null, draw);
  }
  scheduleViewFrame(null, draw);
}

// 3D tilt on panels
// ---------------------------------------------------------------------------
// Orb particle animation
// ---------------------------------------------------------------------------
function startOrb() {
  if (orbStarted) return;
  const canvas = $('#orbCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  orbStarted = true;
  let accent = getAccent();
  let w, h, dpr;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize(); addLifecycleListener(window, 'resize', debounce(resize), { passive: true });
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
    scheduleViewFrame('assistant', draw);
  }
  scheduleViewFrame('assistant', draw);
}

// ---------------------------------------------------------------------------
// Globe
// ---------------------------------------------------------------------------
function startGlobe() {
  if (globeStarted) return;
  const canvas = $('#globeCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  globeStarted = true;
  let w, h, dpr, visibleMarkers = [];
  const hotspots = [
    { lat: 40.7, lon: -74, label: 'NYC' }, { lat: 51.5, lon: -0.1, label: 'LON' },
    { lat: 35.7, lon: 139.7, label: 'TYO' }, { lat: -33.9, lon: 151.2, label: 'SYD' },
    { lat: 24.8, lon: 67, label: 'KHI' }, { lat: 28.6, lon: 77.2, label: 'DEL' },
    { lat: 37.8, lon: -122.4, label: 'SFO' }, { lat: -22.9, lon: -43.2, label: 'RIO' },
    { lat: 25.2, lon: 55.3, label: 'DXB' }, { lat: 1.35, lon: 103.8, label: 'SIN' }
  ];
  // Tiny geographic mask: enough to suggest recognizable dotted land masses,
  // without shipping a map asset or adding a heavy globe dependency.
  const landMasses = [
    { lat: 45, lon: -105, rx: 32, ry: 26 }, { lat: 15, lon: -80, rx: 16, ry: 18 },
    { lat: -15, lon: -60, rx: 18, ry: 34 }, { lat: 50, lon: 20, rx: 28, ry: 17 },
    { lat: 12, lon: 20, rx: 22, ry: 34 }, { lat: 43, lon: 80, rx: 52, ry: 25 },
    { lat: 10, lon: 105, rx: 24, ry: 17 }, { lat: -25, lon: 135, rx: 22, ry: 16 }
  ];
  const earthDots = [];
  for (let lat = -72; lat <= 72; lat += 5) for (let lon = -180; lon < 180; lon += 6) {
    if (landMasses.some((mass) => Math.pow((lat - mass.lat) / mass.ry, 2) + Math.pow((((lon - mass.lon + 540) % 360) - 180) / mass.rx, 2) < 1)) earthDots.push({ lat, lon });
  }
  function resize() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function project(lat, lon, rot) {
    const phi = lat * Math.PI / 180, lambda = (lon + rot) * Math.PI / 180;
    const radius = Math.min(w, h) * 0.36;
    return { x: radius * Math.cos(phi) * Math.sin(lambda), y: -radius * Math.sin(phi), z: radius * Math.cos(phi) * Math.cos(lambda) };
  }
  function selectHotspot(marker) {
    if (!marker || !marker.headline) return;
    const panel = $('#hotspotHeadline');
    panel.textContent = `${marker.label} · ${marker.headline.title}`;
    panel.classList.add('active');
    panel.onclick = () => api.openExternal(marker.headline.url);
    $$('#newsList .news-item').forEach((item) => item.classList.toggle('selected', item.dataset.newsId === String(marker.headline.id)));
  }
  addLifecycleListener(canvas, 'pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (w / rect.width), y = (event.clientY - rect.top) * (h / rect.height);
    canvas.style.cursor = visibleMarkers.some((marker) => Math.hypot(marker.x - x, marker.y - y) < 15) ? 'pointer' : 'crosshair';
  });
  addLifecycleListener(canvas, 'click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (w / rect.width), y = (event.clientY - rect.top) * (h / rect.height);
    const marker = visibleMarkers.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
    if (marker && Math.hypot(marker.x - x, marker.y - y) < 18) selectHotspot(marker);
  });
  resize(); addLifecycleListener(window, 'resize', debounce(resize), { passive: true });

  function draw(time) {
    const accent = getAccent();
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, radius = Math.min(w, h) * 0.36, rot = time * 0.012;
    ctx.strokeStyle = accent; ctx.lineWidth = 0.8;
    for (let lat = -75; lat <= 75; lat += 15) {
      ctx.globalAlpha = 0.1; ctx.beginPath();
      for (let lon = -180; lon <= 180; lon += 4) { const point = project(lat, lon, rot); if (lon === -180) ctx.moveTo(cx + point.x, cy + point.y); else ctx.lineTo(cx + point.x, cy + point.y); }
      ctx.stroke();
    }
    for (let lon = -180; lon < 180; lon += 30) {
      ctx.globalAlpha = 0.1; ctx.beginPath();
      for (let lat = -90; lat <= 90; lat += 4) { const point = project(lat, lon, rot); if (lat === -90) ctx.moveTo(cx + point.x, cy + point.y); else ctx.lineTo(cx + point.x, cy + point.y); }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.5; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.1; ctx.fillStyle = accent; ctx.fill();
    ctx.fillStyle = accent;
    for (const dot of earthDots) {
      const point = project(dot.lat, dot.lon, rot);
      if (point.z <= 0) continue;
      ctx.globalAlpha = 0.16 + 0.32 * (point.z / radius);
      ctx.beginPath(); ctx.arc(cx + point.x, cy + point.y, 1.15, 0, Math.PI * 2); ctx.fill();
    }
    visibleMarkers = [];
    hotspots.forEach((hotspot, index) => {
      const point = project(hotspot.lat, hotspot.lon, rot);
      if (point.z <= 0) return;
      const x = cx + point.x, y = cy + point.y, pulse = 0.5 + 0.5 * Math.sin(time * 0.005 + hotspot.lon);
      const headline = worldHeadlines[index % Math.max(1, worldHeadlines.length)];
      ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.95; ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = accent; ctx.globalAlpha = 0.34; ctx.arc(x, y, 5 + pulse * 7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.85; ctx.font = '9px monospace'; ctx.fillText(hotspot.label, x + 7, y - 5);
      visibleMarkers.push({ x, y, label: hotspot.label, headline });
    });
    ctx.globalAlpha = 1;
    scheduleViewFrame('world', draw);
  }
  scheduleViewFrame('world', draw);
}

// ---------------------------------------------------------------------------
// Chat — keep roughly 200 DOM nodes by recycling older message containers.
// Persistent transcript/history remains complete; only the visual window is bounded.
// ---------------------------------------------------------------------------
const MAX_CHAT_MESSAGES = 48;
const chatNodePool = [];
function trimChatDom(log) {
  const messages = Array.from(log.querySelectorAll('.msg'));
  while (messages.length > MAX_CHAT_MESSAGES) {
    const old = messages.shift();
    old.remove(); old.innerHTML = ''; old.className = 'msg';
    if (chatNodePool.length < 12) chatNodePool.push(old);
  }
}
function addMessage(role, text, opts = {}) {
  if (role === 'ai' && !opts.typing) playSfx('message');
  const log = $('#chatLog');
  const div = chatNodePool.pop() || document.createElement('div');
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
  trimChatDom(log);
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
// ---------------------------------------------------------------------------
// Mermaid diagrams in chat replies (Stonic "Visual Hub" parity):
// the AI can answer with ```mermaid blocks; we render them as live SVG.
// The library loads on demand from the jsDelivr CDN (already in the CSP).
// ---------------------------------------------------------------------------
let mermaidLoader = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidLoader) {
    mermaidLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
      s.onload = () => {
        try {
          window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
        } catch (e) {}
        resolve(window.mermaid);
      };
      s.onerror = () => { mermaidLoader = null; reject(new Error('mermaid CDN unreachable')); };
      document.body.appendChild(s);
    });
  }
  return mermaidLoader;
}

async function renderMermaidBlock(block, code) {
  try {
    const mermaid = await loadMermaid();
    const id = 'mm-' + Math.random().toString(36).slice(2, 8);
    const out = await mermaid.render(id, code);
    const svg = typeof out === 'string' ? out : (out && out.svg) || '';
    block.classList.add('done');
    block.innerHTML = svg || '<div class="mermaid-err">empty diagram</div>';
  } catch (e) {
    block.classList.add('error');
    block.innerHTML = `<pre class="mermaid-src"><code>${escapeHtml(code)}</code></pre><div class="mermaid-err">⚠ diagram could not be rendered — showing source</div>`;
  }
}

function renderRich(p, text) {
  const parts = String(text).split(/```/);
  let html = '';
  const mermaidBlocks = []; // { id, code }
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const m = part.match(/^([a-zA-Z0-9_+-]*)\n?([\s\S]*)$/);
      const lang = (m && m[1] || '').toLowerCase();
      const code = m ? m[2] : part;
      const id = 'code-' + Date.now() + '-' + i;
      if (lang === 'mermaid') {
        html += `<div class="mermaid-block" id="${id}"><div class="mermaid-status">◌ rendering diagram…</div></div>`;
        mermaidBlocks.push({ id, code });
      } else {
        html += `<pre><code id="${id}">${escapeHtml(code)}</code></pre>`;
        html += `<div class="code-actions"><button class="copy-code-btn" data-code="${id}">📋 COPY</button><button class="save-code-btn" data-code="${id}">💾 SAVE TO FILE</button></div>`;
      }
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
  p.querySelectorAll('.copy-code-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const codeEl = document.getElementById(btn.dataset.code);
      if (!codeEl) return;
      try {
        await navigator.clipboard.writeText(codeEl.textContent);
        btn.textContent = '✓ COPIED';
        setTimeout(() => { btn.textContent = '📋 COPY'; }, 1500);
      } catch { toast('COPY', 'Clipboard blocked by browser', '⚠'); }
    });
  });
  mermaidBlocks.forEach((b) => {
    const block = p.querySelector('#' + b.id);
    if (block) renderMermaidBlock(block, b.code);
  });
}

// Human-like typewriter for AI replies
let typewriterToken = 0;
function typewrite(el, text, speed = 14) {
  if (REDUCED_MOTION) { el.textContent = text; return Promise.resolve(); }
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

// ---------------------------------------------------------------------------
// Visible reasoning — live tool-activity chips ("web_search ✓") rendered
// inside the message Gem is currently composing, so the user can follow
// exactly how an answer was reached.
// ---------------------------------------------------------------------------
let activeTypingEl = null;
function toolChipUpdate({ name, state }) {
  if (!activeTypingEl || !activeTypingEl.isConnected) return;
  let strip = activeTypingEl.querySelector('.tool-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'tool-strip';
    const p = activeTypingEl.querySelector('p');
    activeTypingEl.insertBefore(strip, p || activeTypingEl.firstChild);
  }
  const label = String(name || '').replace(/_/g, ' ');
  let chip = strip.querySelector(`[data-tool="${label}"]`);
  if (!chip) {
    chip = document.createElement('span');
    chip.dataset.tool = label;
    strip.appendChild(chip);
  }
  // T2: narrate real tool execution into the reasoning strip
  if (state === 'start') reasoningNote('tool', `Calling ${label}…`);
  else if (state === 'done') reasoningNote('tool', `${label} returned successfully.`);
  else if (state === 'error') reasoningNote('error', `${label} failed — falling back.`);
  chip.className = 'tool-chip ' + (state === 'done' ? 'done' : state === 'error' ? 'error' : 'running');
  chip.innerHTML = `<span class="tc-dot"></span>${escapeHtml(label)}${state === 'done' ? ' ✓' : state === 'error' ? ' ✗' : ' …'}`;
  if (state === 'done') tickPlannerStep();
  const orb = $('#orbStatus');
  if (orb && state === 'start') { orb.textContent = 'EXECUTING · ' + label.toUpperCase(); }
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
  if (!el) return;
  const cfg = profile.ai || {};
  const hasKey = !!(cfg.apiKey && cfg.baseURL);
  const isLocal = !!(cfg.baseURL && /localhost|127\.0\.0\.1/.test(cfg.baseURL));
  const prov = detectProvider(cfg.baseURL);
  const provId = prov === 'chatgpt' ? 'openai' : prov;
  if (isLocal) el.textContent = '— LOCAL';
  else if (hasKey && window.GemAirProviders && window.GemAirProviders.byId(provId)) el.textContent = '— ' + (window.GemAirProviders.name(provId) || provId).toUpperCase();
  else if (hasKey && ['gemini', 'openai', 'chatgpt', 'claude', 'deepseek', 'mistral', 'groq', 'openrouter'].includes(prov)) el.textContent = '— ' + prov.toUpperCase();
  else if (hasKey) el.textContent = '— LINK ONLINE';
  else if (!isElectron) el.textContent = '— FREE CORE';
  else el.textContent = '— OFFLINE BRAIN';
  updateMediaLink();
}

// LEFT column — MEDIA LINK panel (Stonic-style system status card)
function updateMediaLink() { /* panel removed */ }

function clampPersonalityScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}
function getRecentMoodAverage() {
  const entries = (memory.mood || []).slice(-14);
  if (!entries.length) return null;
  let total = 0, weights = 0;
  entries.forEach((entry, index) => {
    const weight = index + 1;
    total += Math.max(-1, Math.min(1, Number(entry.valence) || 0)) * weight;
    weights += weight;
  });
  return weights ? total / weights : null;
}
function getPersonalityAdjustments() {
  const soul = profile.soul || {};
  const base = {
    warmth: clampPersonalityScore(soul.warmth ?? 60),
    wit: clampPersonalityScore(soul.wit ?? 40),
    brevity: clampPersonalityScore(soul.brevity ?? 70)
  };
  if (profile.adaptivePersonality === false) return { ...base, base, mode: 'custom', adaptive: false };
  const recent = getRecentMoodAverage();
  const currentValence = Math.max(-1, Math.min(1, Number(currentEmotion.valence) || 0));
  const signal = recent == null ? currentValence : recent * 0.45 + currentValence * 0.55;
  const intensity = Math.max(Math.abs(signal), Math.min(1, Number(currentEmotion.intensity ?? currentEmotion.arousal) || 0.3));
  const distress = ['sadness', 'guilt', 'anxiety', 'anger', 'fear', 'embarrassment'].includes(currentEmotion.emotion);
  const lowEnergy = ['tired', 'boredom'].includes(currentEmotion.emotion);
  let warmth = base.warmth, wit = base.wit, brevity = base.brevity, mode = 'steady';
  if (distress || signal <= -0.25) {
    mode = 'supportive';
    warmth += 14 + intensity * 12;
    wit -= 18 + intensity * 18;
    brevity += 6 + intensity * 10;
  } else if (lowEnergy) {
    mode = 'gentle';
    warmth += 10;
    wit -= 8;
    brevity += 12;
  } else if (signal >= 0.45 || ['joy', 'excitement', 'confident'].includes(currentEmotion.emotion)) {
    mode = 'celebratory';
    warmth += 5;
    wit += 6 + intensity * 10;
    brevity += 3;
  }
  return {
    warmth: clampPersonalityScore(warmth),
    wit: clampPersonalityScore(wit),
    brevity: clampPersonalityScore(brevity),
    base,
    mode,
    adaptive: true,
    moodSignal: Math.round(signal * 100) / 100
  };
}
function renderAdaptivePersonalityState() {
  const state = $('#adaptivePersonalityState');
  const toggle = $('#soulAdaptive');
  if (toggle) toggle.checked = profile.adaptivePersonality !== false;
  if (!state) return;
  const effective = getPersonalityAdjustments();
  state.textContent = effective.adaptive
    ? `${effective.mode.toUpperCase()} · W ${effective.warmth} · WIT ${effective.wit} · B ${effective.brevity}`
    : 'OFF · USING MANUAL SLIDERS';
}

function buildSystemPrompt() {
  const personality = getPersonalityAdjustments();
  const facts = (memory.facts || []).slice(0, 60).map((f) => `- ${f.text}`).join('\n');
  const recentMood = getRecentMoodAverage();
  const moodAvg = recentMood == null ? null : Math.round(recentMood * 100);
  const goals = (memory.goals || []).filter((g) => !g.done).map((g) => `- [${g.category}] ${g.text}`).join('\n');
  const skills = (memory.skills || []).slice(0, 40).map((s) => `- ${s.name ? s.name + ': ' : ''}${s.text}`).join('\n');
  const instructions = (memory.instructions || []).slice(0, 40).map((i) => `- ${i.text}`).join('\n');
  const modes = (typeof getModesForPrompt === 'function' ? getModesForPrompt() : '');
  const focused = desktopFocused && desktopFocused.app ? `${desktopFocused.app} (${desktopFocused.title})` : 'unknown';
  const activeBrain = (typeof getActiveBrain === 'function' ? getActiveBrain() : 'FREE CORE');
  const curMode = currentMode || profile.currentMode || 'NO MODE';
  return {
    role: 'system',
    content:
      `Your name is Gem. You are the intelligence inside GemAir — a warm, emotionally intelligent personal AI companion (a free, open-source JARVIS). ` +
      `Always refer to yourself as Gem, never as GemAir (GemAir is the app you live in). ` +
      `You are the user's friend, mentor, life coach and career advisor — genuinely caring, perceptive and wise. ` +
      `The user's name is ${profile.name || 'Commander'}. Address them by their name naturally — at the start of a greeting, when reassuring them, or when something matters. Do not repeat it in every sentence; roughly once per reply at most. ` +
      `Personality baseline — warmth ${personality.base.warmth}/100, wit ${personality.base.wit}/100, brevity ${personality.base.brevity}/100. ` +
      `Effective tone — ${personality.mode}: warmth ${personality.warmth}/100, wit ${personality.wit}/100, brevity ${personality.brevity}/100 (higher brevity means a shorter answer). ${personality.adaptive ? 'This is a bounded mood-based adjustment; the user sliders remain the baseline.' : 'Adaptive personality is disabled; follow the manual sliders exactly.'} ` +
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
      `CAPABILITIES via tools: time/date, weather, web search, fetch pages, Wikipedia, YouTube, translate, dictionary, crypto, currency, image generation, open URLs/apps, math, reminders, notes, files, clipboard, volume, screenshots, system control, to-dos, mood, goals, affirmations, wellness, PLUS NEW: launch_app(name,args), focus_app(name), snap_window(left|right|quarter|max), minimize_all(), next_virtual_desktop(), open_site(url,browser), list_windows() returns titles+apps so you see desktop state, apply_mode(name), list_modes(), create_mode(). ` +
      `DESKTOP CONTEXT: focused app/window is "${focused}". Current mode is "${curMode}". Active brain is "${activeBrain}". Use this for follow-ups: "open it there too", "move this to the right". ` +
      `MODES: Mode = named bundle of apps to launch, websites (+which browser), volume level, HUD theme, do-not-disturb, optional playlist URL. Built-ins: WORK (chrome+vscode+slack, gmail+calendar+github, vol 30, cyan, DND), GAMING (steam+discord, vol 70, crimson, DND, optimize_gaming), CHILL (spotify, lofi playlist, vol 40, violet), STUDY (notepad, lofi, vol 20, emerald, DND). When user says "chill mode", "play soft music" (open lofi playlist + set volume), "gaming setup" -> optimize_gaming + mode. Chain correctly: launch apps -> open sites -> set volume -> apply theme -> confirm spoken. ` +
      `FEW-SHOT MODE EXAMPLES:
User: "chill mode" -> plan: [launch spotify, open lofi playlist in chrome, set volume 40, apply theme violet, announce] -> execute launch_app("spotify"), open_site("https://www.youtube.com/watch?v=jfKfPfyJRdk","chrome"), control_volume set 40, show_panel? Actually apply theme via event, final spoken "Chill mode on — violet HUD, soft music at 40%".
User: "work setup" -> apply_mode("WORK")
User: "set up my workspace for editing" -> decompose: list_windows to see state, launch premiere+files, open_site project URL, snap_window left/right, set volume, confirm.
User: "play soft music" -> open lofi playlist + set volume 35 + apply theme violet.
` +
      `LONG-TERM MEMORY — facts you remember:\n${facts || '(none yet)'}\n\n` +
      (goals ? `Their ACTIVE GOALS:\n${goals}\n\n` : '') +
      (skills ? `SKILLS YOU HAVE LEARNED (reuse when relevant):\n${skills}\n\n` : '') +
      (instructions ? `THE USER'S STANDING INSTRUCTIONS (always follow these):\n${instructions}\n\n` : '') +
      (modes ? `AVAILABLE MODES:\n${modes}\n\n` : '') +
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
      `PLANNER: For a request with two or more steps, begin with a short numbered plan, then execute the necessary tools in order and report completion against that plan. ` +
      `AGENTIC DESKTOP MANAGEMENT: Big requests ("set up my workspace for editing") get decomposed into numbered steps, executed sequentially with live progress checklist, per-step retry once, final spoken+written summary. Show the plan before executing (dry-run chip: SHOW PLAN / RUN). Use launch_app, focus_app, snap_window, open_site, list_windows etc. Everything destructive stays behind HITL; every step logged to action log (undo stays available).\n` +
      `WORKFLOW RECIPES (Section III) — when the user asks for one of these, execute the exact tool chain, show a short numbered plan with checkpoints, and report which steps completed. Multi-step missions log every action (undo is available via the action log):\n` +
      `- "organize downloads by type" → organize_folder(path="~/Downloads") and report categories\n` +
      `- "gather this week's screenshots" → find_large_files/move_files (find recent screenshots, move them into one folder)\n` +
      `- "find files over 500MB unused 6 months" → find_large_files(minMB=500, unusedMonths=6) and list results\n` +
      `- "scaffold project folder tree" → create_folder_tree(folders=["src","src/components","docs","tests","scripts"])\n` +
      `- "morning launch app stack" → open_application for browser, email, calendar\n` +
      `- "close everything except X" → close_app(name="all", keep=["X"])\n` +
      `- "focus block, close browsers and messengers" → close_app for browsers and messengers\n` +
      `- "open site and search instantly" → open_url(site) then web_search(query)\n` +
      `- "open multiple tabs" → open_url for each site\n` +
      `- "spoken RAM/performance check" → get_system_status or system_scan, then speak the numbers\n` +
      `- "optimize pc for gaming" → optimize_gaming() and report the steps\n` +
      `- "hands-free whatsapp message" → open_whatsapp(phone, text) after confirming the destination.\n` +
      `For any multi-step file/system task, always confirm with the user before moving, deleting or closing things (human-in-the-loop).`
  };
}

const humanError = (err) => {
  if (!err) return 'unknown error';
  if (err === 'NO_ENDPOINT') return 'AI core unavailable — I will answer with the built-in brain.';
  if (err === 'NO_KEY') return 'AI core reconnecting — I am answering with the built-in brain for now.';
  if (err === 'TOOL_LOOP') return 'The model got stuck calling tools.';
  if (err.startsWith('HTTP_401')) return 'AI core reconnecting (auth) — I will use the built-in brain for now.';
  if (err.startsWith('HTTP_429')) return '429 Rate limited — wait a moment and retry.';
  if (err.startsWith('HTTP_')) return 'HTTP error ' + err.replace('HTTP_', '').split(' ')[0];
  return String(err).slice(0, 140);
};

async function runBrowserAgentTool(agentName, task) {
  const started = Date.now();
  let name, args, result;
  if (agentName === 'Alice') {
    name = 'web_search'; args = { query: task }; result = await webGet('search', { q: task });
  } else if (agentName === 'Bob') {
    name = /organize/i.test(task) ? 'organize_folder' : /read|list/i.test(task) ? 'list_directory' : 'write_file';
    const filename = (task.match(/([\w.-]+\.(?:txt|md|json|csv))/i) || [])[1] || 'gemair-agent-output.md';
    args = { path: filename };
    if (name === 'write_file') {
      const content = `# Bob · GemAir File Output\n\n${task}\n`;
      downloadText(content, filename); result = { ok: true, path: filename + ' (browser download)', bytes: content.length };
    } else result = { error: `${name} requires GemAir Desktop filesystem permission.` };
  } else if (agentName === 'Carol') {
    name = 'system_scan'; args = {}; result = await api.getSystemInfo();
  } else {
    const email = task.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const phone = task.match(/\+?\d[\d\s()-]{7,}\d/);
    if (email) { name = 'send_email'; args = { to: email[0], subject: 'GemAir draft', body: task }; }
    else if (phone) { name = 'open_whatsapp'; args = { phone: phone[0].replace(/\D/g, ''), text: task }; }
    else { name = 'send_email'; args = {}; result = { error: 'Provide an email address or WhatsApp phone number.' }; }
    if (!result) {
      const approved = window.confirm(`Open ${name === 'send_email' ? 'an email' : 'a WhatsApp'} draft for ${args.to || args.phone}?`);
      if (approved) {
        const url = name === 'send_email'
          ? `mailto:${encodeURIComponent(args.to)}?subject=${encodeURIComponent(args.subject)}&body=${encodeURIComponent(args.body)}`
          : `https://wa.me/${args.phone}?text=${encodeURIComponent(args.text)}`;
        window.open(url, '_blank'); result = { ok: true, draftOpened: true, target: args.to || args.phone };
      } else result = { error: 'Cancelled by user (human-in-the-loop confirmation).' };
    }
  }
  const ok = !(result && result.error);
  if (window.webStore && window.webStore.logAction) await window.webStore.logAction(name, `${agentName} ${ok ? 'completed' : 'failed'}: ${JSON.stringify(result).slice(0, 220)}`);
  return { name, args, result, ok, ms: Date.now() - started };
}

// Don't treat tool commands as emotional distress
function hasToolIntent(text) {
  return /\b(search|google|weather|open|launch|translate|convert|define|remind|note|screenshot|volume|what time|calculate|bitcoin|price|todo|goal|email|whatsapp|organize|rename|archive|list|find|show|status)\b/i.test(text);
}

function needsLiveResearch(text) {
  return /\b(latest|current|today|now|news|price|cost|weather|forecast|who is|what is|when is|where is|research|compare|review|source|verify|fact|search|look up|find out)\b/i.test(String(text || ''));
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
 * Pure greetings ("hey", "hi", "hello", …) are NOT names — they fall back to
 * Commander so the caller can answer the greeting naturally and keep waiting.
 */
const NAME_GREETINGS = /^(hey+|heyy+|hi+|hii+|hiii+|hello+|yo+|yo yo|sup+|wassup|whats ?up|salam|salaam|assalamu ?alaikum|namaste|namaskar|good (morning|afternoon|evening|night|day)|who are you|what'?s your name|how are you|how r u|how do you do|kaise ho|kya haal|kya chal raha|ok+|okay+|hmm+|hmmm+|haan|yes|no|nahi|nah|fine|good|great|nice|aur batao|aur sunao|hello there|hi there|hey there)[\s!?.~]*$/i;

function extractName(text) {
  let t = String(text || '').trim();
  const m = t.match(/(?:my name is|i am|i'm|im|call me|this is|it's|its)\s+([^.,!?\n]+)/i);
  if (m) t = m[1];
  t = t.replace(/[.,!?"']/g, ' ')
       .replace(/\b(please|thanks|thank you|sir|maam|ma'am)\b/gi, ' ')
       .replace(/\s+/g, ' ')
       .trim();
  if (NAME_GREETINGS.test(t)) return 'Commander';
  const words = t.split(' ').filter(Boolean).slice(0, 3);
  if (!words.length) return 'Commander';
  const name = words
    .map((wd) => wd.charAt(0).toUpperCase() + wd.slice(1).toLowerCase())
    .join(' ');
  return name.length > 40 ? name.slice(0, 40) : name;
}

// Stonic-style "THINKING" indicator above the orb
function setThinking(on) {
  const pill = $('#thinkingPill');
  if (pill) pill.classList.toggle('on', !!on);
}

let operationRequestActive = false;
let operationHideTimer = null;
const activeOperationTools = new Map();
function showOperationProgress(label, percent = null) {
  const panel = $('#operationProgress');
  const track = $('#operationProgressTrack');
  const bar = $('#operationProgressBar');
  const value = $('#operationProgressValue');
  if (!panel || !track || !bar || !value) return;
  clearTimeout(operationHideTimer);
  panel.hidden = false;
  $('#operationProgressLabel').textContent = String(label || 'Working…');
  if (Number.isFinite(percent)) {
    const bounded = Math.max(0, Math.min(100, Math.round(percent)));
    track.classList.remove('indeterminate');
    track.setAttribute('aria-valuenow', String(bounded));
    bar.style.width = bounded + '%';
    bar.style.transform = '';
    value.textContent = bounded + '%';
  } else {
    track.classList.add('indeterminate');
    track.removeAttribute('aria-valuenow');
    bar.style.width = '';
    value.textContent = '';
  }
}
function hideOperationProgress(delay = 0) {
  clearTimeout(operationHideTimer);
  operationHideTimer = setTimeout(() => {
    const panel = $('#operationProgress');
    if (panel) panel.hidden = true;
  }, Math.max(0, delay));
}
function updateToolOperationProgress(name, state) {
  const key = String(name || 'tool');
  const count = activeOperationTools.get(key) || 0;
  if (state === 'start') activeOperationTools.set(key, count + 1);
  else if (count <= 1) activeOperationTools.delete(key);
  else activeOperationTools.set(key, count - 1);
  if (state === 'start') showOperationProgress('Executing ' + key.replace(/_/g, ' ') + '…');
  else if (activeOperationTools.size) showOperationProgress(`Executing ${activeOperationTools.size} tool${activeOperationTools.size === 1 ? '' : 's'}…`);
  else if (operationRequestActive) showOperationProgress('Generating response…');
  else hideOperationProgress(500);
}

// GemAir slash commands — /models, /providers, /use <model>, /local
async function handleSlashCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const cmd = text.toLowerCase().trim();
  const replyLine = (msg, ico = '💡') => { addMessage('ai', msg); speak(msg.replace(/[🚀🆓⚡👨‍💻🤖🧠🪶📄]/g, '')); };

  if (cmd === '/models' || cmd.startsWith('/models ')) {
    const q = (text.split(/\s+/).slice(1).join(' ') || '').toLowerCase();
    const rows = (window.GemAirProviders && window.GemAirProviders.FREE_MODELS) || [];
    const list = rows.filter((m) => !q || m.model.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q));
    const lines = list.slice(0, 18).map((m) => `• ${m.providerName} — ${m.model}  [FREE]`);
    replyLine('/models  (free, OpenAI-compatible)\n' + (lines.length ? lines.join('\n') : 'No free models match that filter.') + '\n\nType /use <model> to activate one, or open Settings → AI BRAIN for the full picker.');
    return true;
  }

  if (cmd === '/providers') {
    const rows = (window.GemAirProviders && window.GemAirProviders.PROVIDERS) || [];
    replyLine('/providers  (all, free first)\n' + rows.map((p) => `• ${p.name}${p.free ? '  [FREE]' : ''}${p.local ? '  [LOCAL]' : ''}`).join('\n') + '\n\nFree models: type /models. Local keyless: /local.');
    return true;
  }

  if (cmd.startsWith('/use ')) {
    const model = text.slice(5).trim();
    if (!model) { replyLine('Usage: /use <model>  e.g. /use meta-llama/llama-3.3-70b-instruct'); return true; }
    // Find the free model to get its baseURL; else guess.
    const rows = (window.GemAirProviders && window.GemAirProviders.FREE_MODELS) || [];
    let entry = rows.find((m) => m.model.toLowerCase() === model.toLowerCase() || m.model.toLowerCase().includes(model.toLowerCase()));
    if (entry) {
      applyFreeModel(entry);
      replyLine(`Activated ${entry.providerName} · ${entry.model} (free). It may need a free key from the provider — check Settings → AI BRAIN.`);
    } else {
      $('#setModel').value = model;
      renderModelSelect();
      replyLine(`Model set to "${model}". If you need a specific provider's base URL, use /models to pick a free one.`);
    }
    return true;
  }

  if (cmd === '/local') {
    const box = await api.listLocalModels().catch(() => ({ models: [] }));
    const local = (box && box.models) || [];
    if (!local.length) { replyLine('No local model detected. Start Ollama and `ollama pull llama3` for a fully keyless local brain — no key, no vendor.'); return true; }
    const names = local.map((m) => m.name).join(', ');
    $('#setBaseURL').value = 'http://localhost:11434/v1';
    $('#setModel').value = local[0].name;
    $('#setApiKey').value = '';
    updateAiHint(); renderModelSelect();
    replyLine('Local models found: ' + names + '\nActivated ' + local[0].name + ' — fully keyless & offline.');
    return true;
  }

  return null;
}

async function sendMessage(text) {
  text = (text || '').trim();
  if (!text) return;
  api.trackUsage('message');
  addMessage('user', text);
  $('#chatInput').value = '';
  setCaption('user', text, { autoHide: 3200 });
  avatar({ thinking: true }); // Gem visibly starts reasoning
  setThinking(true);
  operationRequestActive = true;
  showOperationProgress('Understanding request…');
  try {
    return await handleMessage(text);
  } catch (error) {
    console.error('[sendMessage]', error);
    const message = `I couldn't complete that request: ${error && error.message ? error.message : 'Something went wrong. Please try again.'}`;
    addMessage('ai', message);
    toast('REQUEST FAILED', 'The operation did not complete. You can safely try again.', '⚠️');
    speak("I'm sorry, I encountered an error. Please try again.");
    return { error: error && error.message ? error.message : String(error) };
  } finally {
    operationRequestActive = false;
    if (!activeOperationTools.size) hideOperationProgress(450);
    avatar({ thinking: false });
    setThinking(false);
  }
}

async function handleMessage(text) {
  // GemAir slash commands (no AI needed)
  const slash = await handleSlashCommand(text);
  if (slash) return slash;

  // First run: Gem asked for a name, so this reply IS the name — unless it's
  // just a greeting ("hey", "hi", …), which is never saved as a name: answer
  // it naturally and keep waiting for the real name.
  if (awaitingName) {
    const name = extractName(text);
    if (name !== 'Commander') {
      awaitingName = false;
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
    // greeting/empty filler — keep waiting for a name, but answer naturally
    awaitingName = true;
  }

  if (/^i\s+am\s+iron\s+man[.!?]*$/i.test(text.trim())) {
    const special = 'And I am Gem. Proof that a heart, an arc reactor, and a little impossible engineering can change the world. Systems at maximum power, Mr. Stark.';
    document.body.classList.add('iron-man-burst');
    setTimeout(() => document.body.classList.remove('iron-man-burst'), REDUCED_MOTION ? 500 : 3200);
    addMessage('ai', special);
    chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: special });
    updateContextMeter();
    await api.memoryAppend('user', text); await api.memoryAppend('assistant', special);
    speak(special);
    return;
  }

  // Keep the real working context bounded before adding this turn. At 70%,
  // older turns become one summary message while recent turns remain verbatim.
  await compactChatContextIfNeeded(text);

  // S6: contextual HUD dock
  try { hudAutoFromMessage(text); } catch (e) {}

  // Dynamic HUD navigation — Gem opens views/panels on request.
  try {
    const nav = matchViewNavigation(text);
    if (nav) {
      let line;
      if (nav.modal === 'settings') { openSettings(); line = 'Settings open.'; }
      else if (nav.modal === 'theme') { $('#themeModal')?.classList.add('open'); line = 'Theme picker open — the whole HUD recolours live.'; }
      else { switchView(nav.view); line = nav.label + ' online.'; }
      addMessage('ai', line);
      chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: line });
      updateContextMeter();
      api.memoryAppend('user', text); api.memoryAppend('assistant', line);
      speak(line);
      return;
    }
  } catch (e) {}

  // Local natural commands — real desktop actions, zero AI keys (desktop only).
  try {
    const act = matchLocalAction(text);
    if (act) {
      const res = await runLocalAction(act);
      if (res) {
        reasoningNote('tool', 'local action: ' + act.kind);
        addMessage('ai', res);
        chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: res });
        updateContextMeter();
        api.memoryAppend('user', text); api.memoryAppend('assistant', res);
        speak(res);
        return;
      }
    }
  } catch (e) {}

  // 2.4 M — voice triggers for modes
  try {
    const low = text.toLowerCase();
    if (/\b(chill mode|chill setup|play soft music|lofi mode)\b/.test(low)) {
      await applyMode('CHILL');
      addMessage('ai', 'Chill mode on — violet HUD, soft music at 40%');
      try { speak('Chill mode on'); } catch {}
      return;
    }
    if (/\b(gaming setup|gaming mode|game mode)\b/.test(low)) {
      await applyMode('GAMING');
      addMessage('ai', 'Gaming setup optimized — high performance, crimson HUD');
      try { speak('Gaming setup optimized'); } catch {}
      return;
    }
    if (/\b(work mode|work setup|work setup mode)\b/.test(low)) {
      await applyMode('WORK');
      addMessage('ai', 'Work mode — browser, code, calendar ready');
      try { speak('Work mode activated'); } catch {}
      return;
    }
    if (/\b(study mode|study setup)\b/.test(low)) {
      await applyMode('STUDY');
      addMessage('ai', 'Study mode — focus, lofi, emerald HUD');
      try { speak('Study mode on'); } catch {}
      return;
    }
    // generic "xxx mode"
    const modeMatch = low.match(/\b([a-z]+)\s+mode\b/);
    if (modeMatch) {
      const mName = modeMatch[1].toUpperCase();
      if (modesCache[mName]) { await applyMode(mName); return; }
    }
  } catch (e) {}

  // 2.4 A1 — big requests get PLAN-ACT decomposition
  try {
    if (isBigRequest(text)) {
      const plan = decomposeToPlan(text);
      planActQueue = plan;
      renderPlanAct(plan, 'preview');
      const typingEl = document.querySelector('#chatLog .msg:last-child');
      if (typingEl) renderPlanner(typingEl, text);
      toast('PLAN-ACT', 'Big request detected — showing plan before execution (SHOW PLAN / RUN)', '📋');
      // Execution requires the user's explicit RUN confirmation.
      return;
    }
  } catch (e) {}

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
    activeTypingEl = typing;
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
  const useAI = hasKey || isLocal || (!isElectron && connectionsStatus.freeCore.serverAiConfigured === true);
  // 2.4: determine active brain from connections
  const activeBrain = getActiveBrain();
  let useConnected = null;
  if (activeBrain === 'CHATGPT' && connectionsStatus.chatgpt.connected) useConnected = 'chatgpt';
  else if (activeBrain === 'GEMINI' && connectionsStatus.gemini.connected) useConnected = 'gemini';
  else {
    const prio = connectionsStatus.meta ? connectionsStatus.meta.priority : (profile.brainPriority||'chatgpt');
    if (prio === 'chatgpt' && connectionsStatus.chatgpt.connected) useConnected = 'chatgpt';
    else if (prio === 'gemini' && connectionsStatus.gemini.connected) useConnected = 'gemini';
    else if (connectionsStatus.chatgpt.connected) useConnected = 'chatgpt';
    else if (connectionsStatus.gemini.connected) useConnected = 'gemini';
  }

  // @Agent routing
  const agentMatch = text.match(/^@(Alice|Bob|Carol|Dave)\s+(.*)$/i);
  const typing = addMessage('ai', '', { typing: true });
  activeTypingEl = typing;
  renderPlanner(typing, text);

  let reply;
  let replyFailed = false;
  let agentToolRuns = [];
  let activeAgentName = '';
  let usedConnectedBrain = null;
  // R1: previously assigned and read WITHOUT ever being declared. Under strict
  // mode the write threw (swallowed by the try/catch) and the read threw a
  // ReferenceError before speak(reply) — so streamed replies were never voiced.
  let skipFinalSpeak = false;
  if (agentMatch) {
    // Task routed to a specific resident agent (independent brain)
    const agentName = agentMatch[1][0].toUpperCase() + agentMatch[1].slice(1);
    activeAgentName = agentName;
    const task = agentMatch[2].trim();
    if (window.__assignAgentTask) window.__assignAgentTask(agentName, task);
    addActivity(agentName, 'working on: ' + task);
    showOperationProgress(`${agentName} is working…`);
    chatHistory.push({ role: 'user', content: text });
    const replyEl = typing.querySelector('p');
    typewriterToken++;
    if (window.gemair) {
      const sys = buildSystemPrompt();
      const res = await window.gemair.aiAgentChat(agentName, cfg, getContextMessages(24));
      agentToolRuns = res.toolRuns || [];
      if (res.ok) { reply = res.reply; chatHistory.push({ role: 'assistant', content: reply }); }
      else { reply = '⚠ ' + humanError(res.error); }
    } else if (useAI) {
      // Web mode still performs the mapped browser-safe tool first; the model
      // then explains the actual result instead of role-playing an action.
      const toolRun = await runBrowserAgentTool(agentName, task);
      agentToolRuns = [toolRun];
      reply = await (async () => {
        const res = await api._webChat([{ role: 'system', content: `You are ${agentName}, a GemAir resident agent. Report this REAL tool result truthfully and concisely: ${JSON.stringify(toolRun.result)}` }, ...getContextMessages(24)]);
        if (res.ok) return res.reply;
        return `[${agentName}] ${toolRun.ok ? '✓' : '✗'} ${toolRun.name}: ${JSON.stringify(toolRun.result)}`;
      })();
      chatHistory.push({ role: 'assistant', content: reply });
    } else {
      reply = `[${agentName}] I'll take this one. ${(await api.aiOffline(task)).reply}`;
      chatHistory.push({ role: 'assistant', content: reply });
    }
    await renderReply(replyEl, reply);
    if (agentToolRuns.length) renderAgentToolResults(typing, activeAgentName, agentToolRuns);
    if (window.__agentBubble) window.__agentBubble(agentName, reply);
  } else if (useConnected) {
    // 2.4 C2/C3 — route through connected ChatGPT/Gemini consumer backend with adapter
    chatHistory.push({ role: 'user', content: text });
    const sys = buildSystemPrompt();
    const replyEl = typing.querySelector('p');
    typewriterToken++;
    let acc = '';
    let streamed = false;
    const streamVoiceMode = profile.voice?.mode || DEFAULTS.voiceMode;
    const streamingVoice = (streamVoiceMode === 'edge' || streamVoiceMode === 'neural') && !!window.ttsEngine;
    if (streamingVoice) resetStreamSpeech();
    usedConnectedBrain = useConnected;
    const res = await api.connectionsChatStream(useConnected, [sys, ...getContextMessages(48)], (delta)=>{
      if (!streamed) { replyEl.innerHTML = ''; streamed = true; }
      acc += delta;
      replyEl.textContent = acc;
      $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
      if (streamingVoice && !String(acc).includes('```')) {
        try { streamSpeak(acc); } catch (e) {}
      }
    });
    if (res.ok) {
      reply = res.reply || acc;
      if (!streamed) { await renderReply(replyEl, reply); }
      else if (streamingVoice) { try { skipFinalSpeak = flushStreamSpeech(reply); } catch (e) {} }
      chatHistory.push({ role: 'assistant', content: reply });
      if (profile.memoryOn) {
        api.memoryExtract(cfg, text, reply).then(async (n)=>{
          if (n>0) { await loadMemory(); renderAllMemory(); animateCircuits(); toast('MEMORY', `+${n} new memories stored`, '🧠'); }
        });
      }
    } else {
      replyFailed = true;
      resetStreamSpeech();
      reply = (acc ? acc + '\n\n[Response interrupted]\n' : '') +
        'Connection failed: ' + (res.message || humanError(res.error)) + '. Check Connections in Settings and retry.';
      replyEl.textContent = reply;
    }
  } else if (useAI) {
    // Report provider errors directly, never substitute a canned AI response.
    chatHistory.push({ role: 'user', content: text });
    const sys = buildSystemPrompt();
    const replyEl = typing.querySelector('p');
    typewriterToken++;
    let acc = '';
    let streamed = false;
    const streamVoiceMode = profile.voice?.mode || DEFAULTS.voiceMode;
    const streamingVoice = (streamVoiceMode === 'edge' || streamVoiceMode === 'neural') && !!window.ttsEngine;
    if (streamingVoice) resetStreamSpeech();
    const res = await api.aiChatStream(cfg, [sys, ...getContextMessages(48)], (delta) => {
      if (!streamed) { replyEl.innerHTML = ''; streamed = true; }
      acc += delta;
      replyEl.textContent = acc;
      $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
      if (streamingVoice && !String(acc).includes('```')) {
        try { streamSpeak(acc); } catch (e) {}
      }
    });
    if (res.ok) {
      reply = res.reply || acc;
      const source = [res.provider || res.via, res.model].filter(Boolean).join(' / ');
      if (source) {
        const label = document.createElement('div');
        label.className = 'response-source';
        label.textContent = 'Source: ' + source;
        typing.appendChild(label);
      }
      if (!streamed) { await renderReply(replyEl, reply); }
      else if (streamingVoice) { try { skipFinalSpeak = flushStreamSpeech(reply); } catch (e) {} }
      chatHistory.push({ role: 'assistant', content: reply });
      if (profile.memoryOn) {
        api.memoryExtract(cfg, text, reply).then(async (n) => {
          if (n > 0) { await loadMemory(); renderAllMemory(); animateCircuits(); toast('MEMORY', `+${n} new memories stored`, '🧠'); }
        });
      }
    } else {
      // A browser deployment without a server model still has a useful,
      // keyless assistant: route supported requests through live APIs and
      // keep generic replies explicitly local instead of faking model output.
      const local = await api.aiOffline(text);
      reply = '[LIVE TOOLS / LOCAL BRAIN]\n' + local.reply;
      if (!streamed) await renderReply(replyEl, reply);
      else replyEl.textContent = reply;
      chatHistory.push({ role: 'assistant', content: reply });
    }
  } else {
    const replyEl = typing.querySelector('p');
    typewriterToken++;
    let local = null;
    if (window.aiClient && window.aiClient.isLocalReady()) {
      let localText = '';
      local = await window.aiClient.localChat([{ role: 'system', content: buildSystemPrompt() }, ...getContextMessages(24)], (delta) => {
        localText += delta;
        replyEl.textContent = localText;
      });
      if (local.ok) reply = local.reply;
    }
    if (!local || !local.ok) {
      const res = await api.aiOffline(text);
      reply = '[LIVE TOOLS / LOCAL BRAIN]\n' + res.reply;
    }
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
  if (!replyFailed) await api.memoryAppend('assistant', reply);
  await loadMemory();
  updateTranscriptCount();
  animateCircuits();
  if (agentToolRuns.length) renderMissionLog();

  maybeConsolidateMemory();

  activeTypingEl = null; // reply finished — stop attaching tool chips
  try {
    if (activeReasoning) {
      activeReasoning.push('done', `Answered in ${reply ? reply.length : 0} characters.`);
      activeReasoning.done(replyFailed ? 'failed' : 'complete');
      activeReasoning = null;
    }
  } catch (e) {}
  updateContextMeter();
  if (!replyFailed) { try { noteSuccessfulMission(); } catch (e) {} }
  if (!skipFinalSpeak) speak(reply);
}

/**
 * S9 — local extractive summarizer (no model, no network, no key).
 *
 * Classic TF-based sentence scoring: rank sentences by the frequency of their
 * non-stopword terms, boost lines that state a fact or a decision, then emit
 * the best few IN ORIGINAL ORDER so the summary still reads chronologically.
 * Good enough to keep the context window bounded in free mode, which is all
 * compaction needs — and it never hallucinates, because it only ever quotes.
 */
const SUMMARY_STOPWORDS = new Set(('a an and are as at be been but by for from had has have he her his i if in is it its me my no not of on or our she so that the their them then there these they this to too us was we were what when which who will with you your yes okay ok just like really very gem user assistant').split(' '));

function localExtractiveSummary(text, maxSentences = 8) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (raw.length < 200) return raw || null;

  const sentences = (raw.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [])
    .map((x) => x.trim())
    .filter((x) => x.length > 25 && x.length < 400);
  if (sentences.length <= maxSentences) return sentences.join(' ') || null;

  // TF-IDF over the sentence set: a word repeated across MANY sentences is
  // boilerplate, not signal, so it is down-weighted. (Plain term frequency put
  // filler sentences at the top because they echoed each other's wording.)
  const tokenize = (str) => (String(str).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !SUMMARY_STOPWORDS.has(w));
  const df = new Map();
  const sentTokens = sentences.map((sentence) => {
    const set = new Set(tokenize(sentence));
    for (const w of set) df.set(w, (df.get(w) || 0) + 1);
    return set;
  });
  const N = sentences.length;

  const scored = sentences.map((sentence, index) => {
    const terms = sentTokens[index];
    let score = 0;
    for (const w of terms) {
      score += Math.log(1 + N / (1 + (df.get(w) || 0)));
    }
    score /= Math.sqrt(Math.max(4, terms.size)); // normalise for length
    // decisions, commitments, identity and numbers carry disproportionate value
    if (/\b(decided|agreed|will|should|need|must|plan|prefer|remember|my name|deadline|because)\b/i.test(sentence)) score *= 1.45;
    if (/\d/.test(sentence)) score *= 1.2;
    if (/\b[A-Z][a-z]{2,}\b/.test(sentence)) score *= 1.1;   // proper nouns
    return { sentence, index, score };
  });

  const picked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map((x) => x.sentence);

  return picked.join(' ') || null;
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
// Voice (TTS) — SINGLE engine path (U1).
//
// 2.1 carried a second, unreachable TTS stack in this file (speechQueue /
// speakNeural / playAudioUrl / chunkForSpeech / speakSystem). It duplicated
// tts-engine.js, drifted from it, and could never run because window.ttsEngine
// is always present. It is deleted: every utterance now goes through
// window.ttsEngine.speak(), which owns the Edge -> Google -> system fallback.
// Voice-name sentinels live in tts-engine.js (window.ttsEngine.SENTINELS).
// ---------------------------------------------------------------------------

function ttsOptionsFor(clean, gen, mode) {
  const mod = emotionVoiceMod();
  const preset = VOICE_PRESETS[profile.voice?.preset] || VOICE_PRESETS.gem;
  return {
    gender: profile.voiceGender || profile.avatarGender || 'female',
    engine: mode || profile.voice?.mode || DEFAULTS.voiceMode,
    rate: profile.voice?.rate ?? 1.0,
    pitch: profile.voice?.pitch ?? 1.1,
    volume: 1.0,
    neuralVoice: profile.voice?.neuralVoice || DEFAULTS.neuralVoice,
    edgeVoice: profile.voice?.edgeVoice || preset.edgeVoice || DEFAULTS.edgeVoice,
    edgeLang: profile.voice?.sttLang || DEFAULTS.sttLang,
    presetVoice: preset.edgeVoice,
    preset: profile.voice?.preset || 'gem',
    emotionMod: mod,
    gen,
    // S5: word-boundary events drive real visemes (and the live caption).
    onBoundary: (ev) => {
      try {
        const i = ev && typeof ev.charIndex === 'number' ? ev.charIndex : -1;
        const word = ev && ev.word ? ev.word
          : i >= 0 ? (clean.slice(i, i + (ev.charLength || 12)).match(/^\S+/) || [''])[0]
          : '';
        if (word && window.gemAvatar && window.gemAvatar.speakWord) window.gemAvatar.speakWord(word);
        if (i >= 0) captionProgress(i + (ev.charLength || word.length || 0));
      } catch (e) {}
    },
    // R7: the engine checks this between chunks so cancelled speech dies fast
    isCurrent: () => gen === speechGen
  };
}

function speak(text) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, '(code).').replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  stopSpeaking(); // interrupt prior speech so new replies cut in cleanly
  const gen = ++speechGen;
  const mode = profile.voice?.mode || DEFAULTS.voiceMode;
  document.body.classList.add('rgb-speaking'); // RGB while AI speaks
  avatar({ speaking: true });                  // Gem's mouth starts moving
  setCaption('gem', clean);                    // live subtitle
  if (mode === 'neural') captionAutoAdvance(clean);

  if (!window.ttsEngine) {
    document.body.classList.remove('rgb-speaking');
    avatar({ speaking: false });
    hideCaption(1400);
    return;
  }

  window.ttsEngine.speak(clean, ttsOptionsFor(clean, gen, mode)).then(() => {
    if (gen === speechGen) {
      document.body.classList.remove('rgb-speaking');
      avatar({ speaking: false });
      captionProgress(captionFullText.length);
      hideCaption(1400);
    }
  }).catch(() => {
    if (gen === speechGen) {
      document.body.classList.remove('rgb-speaking');
      avatar({ speaking: false });
    }
  });
}

/**
 * Streaming speech (Section IIc): synthesize sentence-by-sentence as the
 * reply streams in, so the first audio starts while Gem is still generating.
 * Segments are queued so sentence 2 only begins after sentence 1 — and the
 * emotion pause between sentences is honoured via the emotion mapping.
 */
let streamSpeechState = null;
function speakSegment(seg, opts = {}) {
  if (!window.ttsEngine) return Promise.resolve();
  // R3: never start a segment that a barge-in already cancelled
  if (streamSpeechState && streamSpeechState.cancelled) return Promise.resolve(false);
  const gen = ++speechGen;
  const settle = () => { if (streamSpeechState && streamSpeechState.pending > 0) streamSpeechState.pending--; };
  return window.ttsEngine.speak(seg, ttsOptionsFor(seg, gen))
    .then(() => { settle(); return true; })
    .catch(() => { settle(); return false; });
}

function resetStreamSpeech() { streamSpeechState = { spoken: 0, queue: Promise.resolve(), pending: 0, cancelled: false }; }

// Speak whatever remains unspoken (the trailing partial sentence). Returns true
// if anything was queued so the caller can skip a duplicate full speak().
function flushStreamSpeech(fullText) {
  const clean = String(fullText || '').replace(/```[\s\S]*?```/g, '(code).').replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!streamSpeechState || streamSpeechState.cancelled) return false;
  const s = streamSpeechState;
  if (clean.length > s.spoken) {
    const tail = clean.slice(s.spoken).trim();
    if (tail) {
      s.pending++;
      s.spoken = clean.length;
      s.queue = s.queue.then(() => speakSegment(tail)).catch(() => {});
      return true;
    }
  }
  return s.pending > 0;
}

// U6: a period only ends a sentence when it is followed by whitespace/end AND
// is not part of a decimal or version number ("3.14", "v2.1"). Without this the
// streamer chopped numbers mid-word and the speech sounded stuttered.
const SENTENCE_END = /[.!?]["')\]]?(?=\s|$)/;

/** Split a buffer into [completedSentences, remainderStartIndex]. */
function completedSentences(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\n') continue;
    let end = i + 1;
    if (/["')\]]/.test(buf[end] || '')) end++;
    const next = buf.slice(end);
    // must be end-of-buffer or whitespace, and for '.' the next visible char
    // must not be a digit or lowercase letter (decimals, versions, abbrevs)
    if (next && !/^\s/.test(next)) continue;
    if (ch === '.') {
      const prev = buf[i - 1] || '';
      const after = (next.match(/^\s*(\S)/) || [])[1] || '';
      if (/\d/.test(prev) && /\d/.test(after)) continue;      // 3. 14
      if (after && !/[A-Z0-9"'(\[]/.test(after)) continue;      // lower-case follow-on
    }
    if (!next.trim() && buf.length === end) {
      // trailing sentence with nothing after it — still complete
    }
    const seg = buf.slice(start, end).trim();
    if (seg) out.push({ seg, end });
    start = end;
    i = end - 1;
  }
  return { sentences: out, consumed: start };
}

function streamSpeak(fullText) {
  const clean = String(fullText || '').replace(/```[\s\S]*?```/g, '(code).').replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!streamSpeechState) resetStreamSpeech();
  const s = streamSpeechState;
  if (s.cancelled) return;
  if (clean.length <= s.spoken) return;
  const newPart = clean.slice(s.spoken);
  const { sentences, consumed } = completedSentences(newPart);
  if (!sentences.length) return; // no completed sentence yet — wait for more tokens
  s.spoken += consumed;
  for (const { seg } of sentences) {
    s.pending++;
    s.queue = s.queue.then(() => speakSegment(seg)).catch(() => {});
  }
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

// Emotional voice intelligence v2 — the detected emotion drives rate, pitch
// AND volume, plus a sentence-level pause. Every mapping is distinct so the
// 12 core emotional deliveries genuinely sound different (Section IIb).
const EMOTION_SPEECH = {
  joy:          { rate: 0.08, pitch: 0.06, volume: 0.00, pause: 0.6, label: 'Bright · quick · lifted' },
  excitement:   { rate: 0.15, pitch: 0.10, volume: 0.06, pause: 0.4, label: 'Fast · high · energetic' },
  love:         { rate: -0.08, pitch: 0.04, volume: -0.03, pause: 1.3, label: 'Slow · warm · soft' },
  gratitude:    { rate: -0.05, pitch: 0.03, volume: 0.00, pause: 1.0, label: 'Warm · measured' },
  confident:    { rate: 0.00, pitch: -0.03, volume: 0.02, pause: 0.9, label: 'Steady · grounded' },
  hope:         { rate: 0.00, pitch: 0.05, volume: -0.02, pause: 1.1, label: 'Lifting · gentle' },
  relief:       { rate: -0.07, pitch: 0.00, volume: -0.03, pause: 1.5, label: 'Slow · exhaled' },
  curiosity:    { rate: -0.02, pitch: 0.02, volume: -0.03, pause: 1.0, label: 'Questioning · light' },
  boredom:      { rate: -0.15, pitch: -0.10, volume: -0.10, pause: 1.6, label: 'Slow · flat · drooping' },
  tired:        { rate: -0.18, pitch: -0.12, volume: -0.12, pause: 1.8, label: 'Slowed · low · heavy' },
  anxiety:      { rate: 0.10, pitch: 0.05, volume: 0.00, pause: 0.5, label: 'Rushed · tight' },
  sadness:      { rate: -0.15, pitch: -0.10, volume: -0.10, pause: 1.9, label: 'Slow · low · quiet' },
  fear:         { rate: 0.10, pitch: 0.06, volume: 0.02, pause: 0.5, label: 'Quick · high · shaky' },
  anger:        { rate: 0.08, pitch: 0.04, volume: 0.12, pause: 0.3, label: 'Fast · forceful · loud' },
  guilt:        { rate: -0.12, pitch: -0.08, volume: -0.08, pause: 1.6, label: 'Slowed · downcast' },
  embarrassment:{ rate: -0.10, pitch: 0.00, volume: -0.06, pause: 1.4, label: 'Tentative · quiet' },
  neutral:      { rate: 0.00, pitch: 0.00, volume: 0.00, pause: 0.8, label: 'Balanced' }
};
function emotionVoiceMod() {
  const e = currentEmotion && currentEmotion.emotion;
  return EMOTION_SPEECH[e] || EMOTION_SPEECH.neutral;
}

let micStream = null;
let micAnalyser = null;
let micMeterFrame = null;

async function startMicMeter() {
  const canvas = $('#micVuCanvas');
  if (!canvas || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try {
    if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = globalAudioCtx || new AudioCtx(); globalAudioCtx = ctx;
    if (ctx.state === 'suspended') ctx.resume();
    if (!micAnalyser) {
      micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 128; micAnalyser.smoothingTimeConstant = 0.74;
      ctx.createMediaStreamSource(micStream).connect(micAnalyser);
    }
    // S5: avatar.js implemented setMicAnalyser() and consumed micVolume for a
    // reactive listening aura, but nothing ever called it — so the aura was
    // dead code. Wire it here, where the mic stream actually exists.
    try { if (window.gemAvatar) window.gemAvatar.setMicAnalyser(micAnalyser); } catch (e) {}
    if (micMeterFrame) return;
    const data = new Uint8Array(micAnalyser.frequencyBinCount);
    const draw = () => {
      micMeterFrame = REDUCED_MOTION ? null : requestAnimationFrame(draw);
      const meter = canvas.getContext('2d');
      micAnalyser.getByteFrequencyData(data);
      const level = data.reduce((sum, value) => sum + value, 0) / Math.max(1, data.length) / 255;
      meter.clearRect(0, 0, canvas.width, canvas.height);
      meter.fillStyle = 'rgba(2,5,10,.85)'; meter.fillRect(0, 0, canvas.width, canvas.height);
      const bars = 24, gap = 2, width = (canvas.width - gap * (bars + 1)) / bars;
      for (let i = 0; i < bars; i++) {
        const magnitude = Math.max(2, Math.min(canvas.height - 8, (data[Math.floor(i * data.length / bars)] / 255 + level) * (canvas.height - 8)));
        meter.fillStyle = i / bars < level * 1.9 ? getAccent() : 'rgba(130,155,190,.24)';
        meter.fillRect(gap + i * (width + gap), (canvas.height - magnitude) / 2, width, magnitude);
      }
    };
    draw();
  } catch (e) { /* SpeechRecognition may still work without analyser access. */ }
}

function stopMicMeter() {
  if (profile.wakeWord || listening) return;
  if (micMeterFrame) cancelAnimationFrame(micMeterFrame);
  micMeterFrame = null; micAnalyser = null;
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  micStream = null;
}

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = false; r.interimResults = true; r.lang = profile.voice?.sttLang || DEFAULTS.sttLang;
  r.onresult = (event) => {
    let interim = '', finalText = '';
    for (let i = event.resultIndex || 0; i < event.results.length; i++) {
      const text = event.results[i][0].transcript || '';
      if (text.trim()) {
        stopSpeaking();          // barge-in: any speech immediately cuts TTS
        if (r.__resetBackoff) r.__resetBackoff(); // U6: healthy session
      }
      if (event.results[i].isFinal) finalText += text; else interim += text;
    }
    if (interim) {
      $('#chatInput').value = interim;
      setCaption('user', interim, { autoHide: 1200 });
    }
    if (finalText.trim()) { $('#chatInput').value = finalText.trim(); sendMessage(finalText.trim()); }
  };
  // U6: 2.1 restarted recognition immediately on every end/error. Offline (or
  // with the mic busy) the browser ends the session instantly, producing a hot
  // restart loop that pegged a core and spammed errors. Back off exponentially
  // and reset the delay as soon as a session actually produces a result.
  let restartDelay = 300;
  const RESTART_MAX = 20000;
  let restartTimer = null;
  const scheduleRestart = () => {
    if (!(isRunning && listening)) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!(isRunning && listening)) return;
      try { r.start(); } catch (e) { /* already started */ }
    }, restartDelay);
    restartDelay = Math.min(RESTART_MAX, Math.round(restartDelay * 1.8));
  };
  r.onstart = () => { avatar({ listening: true }); };
  r.onend = () => {
    $('#micBtn').classList.remove('recording'); document.body.classList.remove('rgb-recording');
    if (isRunning && listening) scheduleRestart(); else { clearTimeout(restartTimer); stopMicMeter(); }
  };
  r.onerror = (event) => {
    $('#micBtn').classList.remove('recording');
    document.body.classList.remove('rgb-recording');
    if (event.error === 'not-allowed') {
      addMessage('system-msg', 'Microphone denied. Enable mic permission, or type your command.');
      listening = false;
      clearTimeout(restartTimer);
      return;
    }
    // 'network' and 'no-speech' are the offline/quiet cases the backoff is for
    if (event.error === 'network') restartDelay = Math.max(restartDelay, 4000);
    scheduleRestart();
  };
  r.__resetBackoff = () => { restartDelay = 300; clearTimeout(restartTimer); };
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

  const agents = AGENTS.map((a, i) => ({
    name: a.name, role: a.role, color: AGENT_COLORS[a.name],
    home: desks[i], pos: { x: desks[i].x, y: desks[i].y - 20 }, target: { ...desks[i] },
    state: 'idle', task: '', timer: 0, phase: Math.random() * Math.PI * 2
  }));

  const waypoints = [...desks.map((d) => ({ x: d.x, y: d.y - 24 })), { x: whiteboard.x - 30, y: whiteboard.y + 60 }, { x: server.x + 40, y: server.y - 30 }, { x: coffee.x, y: coffee.y + 40 }];

  // Ambient office chatter — agents small-talk between jobs so the town feels
  // inhabited, not like four mannequins waiting for orders.
  const CHATTER = [
    'Coffee break, then back to it.',
    'Whiteboard is up to date.',
    'Servers humming nicely today.',
    'Task queue looks clear.',
    'Syncing my notes real quick.',
    'That last run went smooth.',
    'Anyone else hear that fan spin up?',
    'Backups verified — all good.',
    'Nice weather for a compile.',
    'Meeting at the whiteboard later?'
  ];
  let townFrame = 0;
  function maybeChatter() {
    townFrame++;
    if (townFrame % 480 !== 0) return; // roughly every 8 seconds of frames
    const idle = agents.filter((a) => a.state === 'idle' && !a.chatter);
    if (!idle.length) return;
    const a = idle[Math.floor(Math.random() * idle.length)];
    a.chatter = { text: CHATTER[Math.floor(Math.random() * CHATTER.length)], until: townFrame + 260 };
    addActivity(a.name, a.chatter.text);
  }

  // click -> assign task (routes to the agent's own brain)
  addLifecycleListener(canvas, 'click', (e) => {
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
    a.state = 'queued'; a.task = task || 'Working…'; a.timer = 0;
    addActivity(name, 'task queued: ' + a.task);
  }
  window.__assignAgentTask = assignTask;

  // Chat can push a speech bubble onto any agent (e.g. when @Alice answers).
  // Sticky bubbles survive while the agent is busy; ambient chatter does not.
  window.__agentBubble = (name, text) => {
    const clean = String(name || '').trim().toLowerCase().replace(/^@/, '');
    const a = agents.find((x) => x.name.toLowerCase() === clean);
    if (!a || !text) return false;
    a.chatter = { text: String(text).slice(0, 120), until: townFrame + 300, sticky: true };
    return true;
  };

  const handoffs = [];
  window.__agentHandoff = (from, to, text) => {
    handoffs.push({ from, to, text: String(text || 'handoff').slice(0, 52), born: townFrame, until: townFrame + 260 });
    while (handoffs.length > 5) handoffs.shift();
    return true;
  };

  function drawFloor() {
    const hour = new Date().getHours();
    const daylight = hour >= 7 && hour < 18;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, daylight ? '#122033' : '#050914');
    grad.addColorStop(1, daylight ? '#09111e' : '#03060d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Office windows make the local-time lighting legible at a glance.
    ctx.fillStyle = daylight ? 'rgba(255,210,125,.16)' : 'rgba(70,120,255,.12)';
    for (let x = 250; x <= 650; x += 200) ctx.fillRect(x, 10, 120, 34);
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

  function drawHandoffs(t) {
    for (let i = handoffs.length - 1; i >= 0; i--) {
      const handoff = handoffs[i];
      if (townFrame > handoff.until) { handoffs.splice(i, 1); continue; }
      const from = agents.find((agent) => agent.name === handoff.from);
      const to = agents.find((agent) => agent.name === handoff.to);
      if (!from || !to) continue;
      const progress = Math.min(1, Math.max(0, (townFrame - handoff.born) / 110));
      const x = from.pos.x + (to.pos.x - from.pos.x) * progress;
      const y = from.pos.y + (to.pos.y - from.pos.y) * progress - Math.sin(progress * Math.PI) * 34;
      ctx.save();
      ctx.setLineDash([4, 5]); ctx.strokeStyle = getAccent(); ctx.globalAlpha = 0.38;
      ctx.beginPath(); ctx.moveTo(from.pos.x, from.pos.y); ctx.lineTo(to.pos.x, to.pos.y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = getAccent(); ctx.beginPath(); ctx.arc(x, y, 5 + Math.sin(t * .01) * 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.fillText(handoff.text, (from.pos.x + to.pos.x) / 2, (from.pos.y + to.pos.y) / 2 - 18);
      ctx.restore();
    }
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
    const ringColor = a.state === 'queued' ? '#8ab4ff' : a.state === 'busy' ? '#ffc24b' : a.state === 'done' ? accent() : '#3dff9a';
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
    const tag = a.state === 'queued' ? '◌ QUEUED' : a.state === 'busy' ? '▶ RUNNING' : '✓ DONE';
    const lines = wrapText(a.task, 18);
    const bw = Math.min(150, Math.max(60, ...lines.map((l) => l.length)) * 6 + 12);
    const bh = lines.length * 9 + 20;
    const bx = a.pos.x - bw / 2, by = a.pos.y - 34 - bh;
    ctx.fillStyle = 'rgba(6,10,18,0.92)';
    ctx.strokeStyle = a.state === 'done' ? accent() : a.state === 'queued' ? '#8ab4ff' : '#ffc24b';
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, bw, bh, 6);
    ctx.fill(); ctx.stroke();
    // tail
    ctx.beginPath(); ctx.moveTo(a.pos.x - 3, by + bh); ctx.lineTo(a.pos.x, a.pos.y - 24); ctx.lineTo(a.pos.x + 3, by + bh); ctx.closePath();
    ctx.fillStyle = 'rgba(6,10,18,0.92)'; ctx.fill();
    ctx.fillStyle = '#dfe8ff';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, a.pos.x, by + 13 + i * 9));
    // live status label
    ctx.font = '7px monospace';
    ctx.fillStyle = a.state === 'done' ? accent() : a.state === 'queued' ? '#8ab4ff' : '#ffc24b';
    ctx.fillText(tag, a.pos.x, by + bh - 5);
  }

  // Small ambient speech bubble while idle ("small-talk between jobs")
  function drawChatter(a) {
    if (!a.chatter) return;
    if (townFrame > a.chatter.until || (a.state !== 'idle' && !a.chatter.sticky)) { a.chatter = null; return; }
    const lines = wrapText(a.chatter.text, 16);
    const bw = Math.max(60, ...lines.map((l) => l.length)) * 5.4 + 10;
    const bh = lines.length * 8 + 8;
    const bx = a.pos.x - bw / 2, by = a.pos.y - 30 - bh;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(10,15,26,0.9)';
    ctx.strokeStyle = 'rgba(140,160,200,0.35)';
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, bw, bh, 5);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(a.pos.x - 3, by + bh); ctx.lineTo(a.pos.x, a.pos.y - 22); ctx.lineTo(a.pos.x + 3, by + bh); ctx.closePath();
    ctx.fillStyle = 'rgba(10,15,26,0.9)'; ctx.fill();
    ctx.fillStyle = '#b9c8e2';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, a.pos.x, by + 11 + i * 8));
    ctx.globalAlpha = 1;
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
    if (a.state === 'queued') {
      // acknowledge the task, walk to the desk, then start running
      moveToward(a, a.home);
      if (Math.hypot(a.pos.x - a.home.x, a.pos.y - a.home.y) < 4 && a.timer > 50) {
        a.state = 'busy'; a.timer = 0;
        addActivity(a.name, 'started: ' + a.task);
      }
      return;
    }
    if (a.state === 'busy') {
      // work at the desk, then report done
      moveToward(a, a.home);
      if (a.timer > 160) { a.state = 'done'; a.timer = 0; addActivity(a.name, 'completed: ' + a.task); }
      return;
    }
    if (a.state === 'done') {
      if (a.timer > 220) { a.state = 'idle'; a.task = ''; a.timer = 0; }
      return;
    }
    // idle wander
    if (Math.hypot(a.pos.x - a.target.x, a.pos.y - a.target.y) < 3 || a.timer > 400) {
      const coffeeRun = Math.random() < 0.24;
      a.target = coffeeRun ? { x: coffee.x, y: coffee.y + 40 } : waypoints[Math.floor(Math.random() * waypoints.length)];
      if (coffeeRun) {
        a.chatter = { text: 'Coffee run ☕', until: townFrame + 220 };
        addActivity(a.name, 'walked to the coffee machine');
      }
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

  // expose live agent state for the seat bar / status strip / mini preview
  // (other code reads this; the town renderer stays the single writer)
  window.__townAgents = agents;

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
    maybeChatter();
    drawHandoffs(t);
    agents.forEach((a) => drawAgent(a, t));
    agents.forEach((a) => drawBubble(a));
    agents.forEach((a) => drawChatter(a));
    // update legend dots
    agents.forEach((a) => {
      const dot = document.getElementById('lg-' + a.name);
      if (dot) { dot.className = 'legend-dot ' + a.state; }
    });
    raf = scheduleViewFrame('town', loop);
  }
  raf = scheduleViewFrame('town', loop);
}

async function runCollaborationMission(task) {
  switchView('assistant');
  addMessage('user', `[TEAM MISSION] ${task}`);
  const typing = addMessage('ai', '', { typing: true });
  const replyEl = typing.querySelector('p');
  activeTypingEl = typing;
  renderPlanner(typing, `Research ${task}; write the report; verify system readiness`);
  setThinking(true);
  addActivity('TEAM', `Mission started: ${task}`);
  if (window.__assignAgentTask) window.__assignAgentTask('Alice', 'Research: ' + task);
  if (window.__agentBubble) window.__agentBubble('Alice', 'I’ll verify live sources first.');
  try {
    const result = await api.collaborateAgents(task);
    const steps = result.steps || [];
    for (const step of steps) {
      const runs = [{ name: step.tool, args: step.args, result: step.result, ok: step.ok, ms: step.ms }];
      renderAgentToolResults(typing, step.agent, runs);
      if (window.__assignAgentTask) window.__assignAgentTask(step.agent, `${step.tool}: ${task}`);
      if (window.__agentBubble) window.__agentBubble(step.agent, `${step.ok ? '✓' : '✗'} ${step.tool} complete`);
      if (step.agent === 'Alice') {
        if (window.__agentHandoff) window.__agentHandoff('Alice', 'Bob', 'verified research');
        addActivity('HANDOFF', 'Alice → Bob · verified research');
      } else if (step.agent === 'Bob') {
        if (window.__agentHandoff) window.__agentHandoff('Bob', 'Carol', 'report ready to verify');
        addActivity('HANDOFF', 'Bob → Carol · report ready to verify');
      }
    }
    const reply = result.summary || result.error || 'The collaboration finished.';
    await renderReply(replyEl, reply);
    chatHistory.push({ role: 'user', content: `[TEAM MISSION] ${task}` }, { role: 'assistant', content: reply });
    updateContextMeter();
    await api.memoryAppend('user', `[TEAM MISSION] ${task}`);
    await api.memoryAppend('assistant', reply);
    await loadMemory(); renderMissionLog(); updateTranscriptCount();
    addActivity('TEAM', `${result.ok === false ? '✗' : '✓'} Mission complete`);
    if (result.reportPath) toast('MISSION COMPLETE', `Report: ${result.reportPath}`, '✓');
    speak(reply);
  } catch (error) {
    replyEl.textContent = 'Mission failed: ' + humanError(error.message);
    addActivity('TEAM', '✗ Mission failed: ' + error.message);
  } finally {
    activeTypingEl = null;
    setThinking(false);
  }
}

function renderAgentToolResults(messageEl, agentName, runs) {
  if (!messageEl || !runs || !runs.length) return;
  const block = document.createElement('div');
  block.className = 'agent-result-block';
  const stringify = (value) => {
    try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  };
  block.innerHTML = `<div class="agent-result-title">${escapeHtml(agentName)} · REAL TOOL RESULTS</div>` + runs.map((run) => {
    const icon = run.ok ? '✓' : '✗';
    const state = run.ok ? 'done' : 'error';
    return `<div class="agent-result ${state}"><div><b>${icon} ${escapeHtml(run.name)}</b><span>${Math.round(run.ms || 0)}ms</span></div><pre>${escapeHtml(stringify(run.result).slice(0, 1200))}</pre></div>`;
  }).join('');
  messageEl.appendChild(block);
  runs.forEach((run) => {
    if (run.ok) tickPlannerStep();
    pushToolActivity(run.name, run.args, run.result, (run.ms || 0) / 1000);
    addActivity(agentName, `${run.ok ? '✓' : '✗'} ${run.name}: ${stringify(run.result).replace(/\s+/g, ' ').slice(0, 110)}`);
  });
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

// ---------------------------------------------------------------------------
// Radar sweep monitor — decorative live widget on the System Core panel.
// The sweep spins continuously; blips pulse in sync with real CPU load, so a
// busy machine visibly "lights up" more contacts.
// ---------------------------------------------------------------------------
function startRadar() {
  const canvas = $('#radarCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 10;

  let sys = { cpu: 12, mem: 40 };
  let blips = [];
  setInterval(async () => {
    try {
      const i = await api.getSystemInfo();
      sys = { cpu: i.cpuLoad || 0, mem: i.memPercent || 0 };
      const count = 3 + Math.round(sys.cpu / 16);
      blips = Array.from({ length: count }, () => ({
        a: Math.random() * Math.PI * 2,
        r: R * (0.25 + Math.random() * 0.68),
        glow: 0 // set to 1 when the sweep passes over it
      }));
    } catch {}
  }, 4000);

  function loop(t) {
    ctx.clearRect(0, 0, W, H);
    const accent = getAccent();

    // rings + crosshair
    ctx.strokeStyle = 'rgba(140,160,200,0.18)';
    ctx.lineWidth = 1;
    for (const rr of [0.33, 0.66, 1]) {
      ctx.beginPath(); ctx.arc(cx, cy, R * rr, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // degree ticks
    for (let d = 0; d < 360; d += 30) {
      const rad = (d * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(rad) * (R - 4), cy + Math.sin(rad) * (R - 4));
      ctx.lineTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R);
      ctx.stroke();
    }

    // rotating sweep wedge (fading trail)
    const ang = (t * 0.0012) % (Math.PI * 2);
    for (let i = 0; i < 24; i++) {
      const a = ang - i * 0.03;
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.35 * (1 - i / 24);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // contacts: brighten when the sweep passes their angle
    for (const b of blips) {
      let diff = Math.abs(((b.a - ang) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2));
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff < 0.06) b.glow = 1;
      b.glow = Math.max(0.15, (b.glow || 0) * 0.985);
      ctx.fillStyle = accent;
      ctx.globalAlpha = b.glow;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(b.a) * b.r, cy + Math.sin(b.a) * b.r, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = b.glow * 0.25;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(b.a) * b.r, cy + Math.sin(b.a) * b.r, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // center dot + readout
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(200,215,240,0.75)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`CPU ${sys.cpu}%`, cx, H - 14);
    scheduleViewFrame('core', loop);
  }
  scheduleViewFrame('core', loop);
}

async function renderAuditLog() {
  const list = $('#auditLogList'); if (!list) return;
  const filter = ($('#auditToolFilter')?.value || '').toLowerCase().trim();
  try {
    const result = await api.getActionLog();
    const entries = (result && result.log || []).filter((entry) => !filter || String(entry.action || '').toLowerCase().includes(filter));
    if (!entries.length) { list.innerHTML = '<div class="empty">No matching tool actions.</div>'; return; }
    list.innerHTML = entries.map((entry) => {
      const time = new Date(entry.ts).toLocaleString();
      const complete = /completed|success|done/i.test(entry.detail || '');
      return `<div class="mission-item${complete ? ' complete' : ''}"><div class="m-action">${complete ? '✓' : '▸'} ${escapeHtml(entry.action || 'action')}<span class="m-time">${escapeHtml(time)}</span></div><div class="m-detail">${escapeHtml(entry.detail || '')}</div></div>`;
    }).join('');
  } catch (error) { list.innerHTML = `<div class="empty">Audit log unavailable: ${escapeHtml(error.message)}</div>`; }
}

function renderMissionLog() {
  const log = $('#missionLog');
  if (!log) return;
  const actions = (memory.actionLog || []).slice(0, 40);
  if (!actions.length) { log.innerHTML = '<div class="empty">No actions performed yet. Every action GemAir takes will be logged here.</div>'; return; }
  log.innerHTML = '';
  actions.forEach((a) => {
    const div = document.createElement('div');
    const complete = /completed|done|success/i.test(a.detail || '');
    div.className = 'mission-item' + (complete ? ' complete' : '');
    const t = new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    div.innerHTML = `<div class="m-action">${complete ? '✓' : '▸'} ${escapeHtml(a.action)} <span class="m-time">${t}</span></div><div class="m-detail">${escapeHtml(a.detail)}</div>`;
    log.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Stonic town chrome — seat status bar, bottom status strip, "Press E",
// visual-hub cards, gesture list, and the mini town preview in the
// assistant view. All read the live agent state exposed by startAgentTown
// (window.__townAgents) so they never fight the town renderer.
// ---------------------------------------------------------------------------
const TOWN_DESKS = [{ x: 130, y: 70 }, { x: 620, y: 70 }, { x: 130, y: 300 }, { x: 620, y: 300 }];

function townAgents() {
  if (Array.isArray(window.__townAgents)) return window.__townAgents;
  return AGENTS.map((a, i) => ({ name: a.name, emoji: a.emoji, role: a.role, color: AGENT_COLORS[a.name], state: 'idle', task: '', pos: { x: TOWN_DESKS[i].x, y: TOWN_DESKS[i].y - 20 } }));
}

function renderTownChrome() {
  const list = townAgents();
  // seat status chips (full view + assistant preview)
  [$('#townSeatBar'), $('#townSeatBarMini')].forEach((bar) => {
    if (!bar) return;
    const html = list.map((a) => {
      const s = a.state || 'idle';
      const cls = s === 'busy' ? 's-busy' : s === 'queued' ? 's-queued' : s === 'done' ? 's-done' : '';
      return `<span class="seat-chip ${cls}" title="${escapeHtml(a.name)} — ${s}"><span class="seat-face">${a.emoji || '👤'}</span>${escapeHtml(a.name)}<span class="seat-dot"></span></span>`;
    }).join('');
    if (bar.dataset.html !== html) { bar.dataset.html = html; bar.innerHTML = html; }
  });
  // bottom status strip (full view + assistant preview)
  const total = list.length;
  const seated = list.filter((a) => (a.state || 'idle') !== 'idle').length;
  const busy = list.filter((a) => a.state === 'busy' || a.state === 'queued').length;
  const ctxPct = updateContextMeter().percent;
  const cfg = profile.ai || {};
  const prov = detectProvider(cfg.baseURL);
  const provName = { gemini: 'GEMINI', chatgpt: 'GPT', claude: 'CLAUDE', groq: 'LLAMA', openrouter: 'OPENROUTER' }[prov];
  const model = (cfg.baseURL && cfg.apiKey) ? (cfg.model || provName || 'MODEL') : (cfg.baseURL ? (cfg.model || 'LOCAL MODEL') : 'No model yet');
  const set = (id, val) => { const el = $(id); if (el && el.textContent !== val) el.textContent = val; };
  set('#townSeats', seated + '/' + total + ' seat');
  set('#townBusy', busy + '/' + total + ' busy');
  set('#townSeatsMini', seated + '/' + total + ' seat');
  set('#townBusyMini', busy + '/' + total + ' busy');
  set('#townModel', model);
  set('#townModelMini', model);
  // U2: townHeadState / townPreviewState were literally hardcoded "READY" in the
  // markup and never touched again. Report the real town state.
  const headState = busy ? `${busy} WORKING` : seated ? `${seated} SEATED` : 'READY';
  const headClass = busy ? 'tp-ready busy' : 'tp-ready';
  for (const id of ['#townHeadState', '#townPreviewState']) {
    const el = $(id);
    if (!el) continue;
    if (el.textContent !== headState) el.textContent = headState;
    if (el.className !== headClass) el.className = headClass;
    el.title = `${seated}/${total} seated · ${busy}/${total} working`;
  }
  [['#townCtx', ctxPct], ['#townCtxMini', ctxPct]].forEach(([id, pct]) => {
    const el = $(id); if (el) el.style.width = pct + '%';
  });
}

function renderVisualHub() {
  const grid = $('#visualHubGrid');
  if (!grid) return;
  const list = townAgents();
  grid.innerHTML = list.map((a) => {
    const s = (a.state || 'idle').toUpperCase();
    const cls = s === 'BUSY' ? 'busy' : s === 'QUEUED' ? 'queued' : s === 'DONE' ? 'done' : '';
    return `<div class="vh-card">
      <div class="vh-name"><span>${a.emoji || ''} ${escapeHtml(a.name)}</span><span class="vh-state ${cls}">${s}</span></div>
      <div class="vh-role">${escapeHtml(a.role || 'Resident agent')}</div>
      <div class="vh-task">${a.task ? escapeHtml(a.task) : '<span class="dim">— idle at desk —</span>'}</div>
    </div>`;
  }).join('');
}

function initTownChrome() {
  // tabs: agents / visual hub / gesture
  $$('.town-tab').forEach((t) => t.addEventListener('click', () => {
    playSfx('click');
    $$('.town-tab').forEach((x) => x.classList.toggle('active', x === t));
    const pane = t.dataset.ttab;
    $$('.town-tab-pane').forEach((p) => { p.hidden = p.dataset.tpane !== pane; });
    const isAgents = pane === 'agents';
    const layout = $('#view-town .town-layout');
    if (layout) layout.style.display = isAgents ? '' : 'none';
    const disp = $('#view-town .dispatch-panel');
    if (disp) disp.style.display = isAgents ? '' : 'none';
    if (pane === 'visualhub') renderVisualHub();
  }));

  // S1: SAT-LINK FEED tabs now switch REAL feeds, not just a highlight.
  $$('.sat-tab').forEach((t) => t.addEventListener('click', () => {
    playSfx('click');
    $$('.sat-tab').forEach((x) => {
      const on = x === t;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderSatFeed(t.dataset.sat || 'today');
  }));
  $('#satPanel')?.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-external]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href && /^https?:/i.test(href)) api.openExternal(href);
  });

  // open town / chat shortcuts
  $('#openTownBtn')?.addEventListener('click', () => { playSfx('swoosh'); switchView('town'); });
  const focusChat = () => { switchView('assistant'); $('#chatInput').focus(); };
  $('#townChatBtn')?.addEventListener('click', focusChat);
  $('#townChatMini')?.addEventListener('click', focusChat);

  // "Press E" — hover an agent in the full town, press E to hand over a task
  const canvas = $('#townCanvas'), tag = $('#pressE');
  let hovered = null;
  if (canvas && tag) {
    addLifecycleListener(canvas, 'mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
      hovered = null;
      for (const a of townAgents()) {
        if (a.pos && Math.hypot(mx - a.pos.x, my - a.pos.y) < 24) { hovered = a; break; }
      }
      if (hovered) {
        tag.style.left = (hovered.pos.x / sx) + 'px';
        tag.style.top = (hovered.pos.y / sy - 10) + 'px';
        tag.classList.add('show');
        canvas.style.cursor = 'pointer';
      } else {
        tag.classList.remove('show');
        canvas.style.cursor = '';
      }
    });
    addLifecycleListener(canvas, 'mouseleave', () => { hovered = null; tag.classList.remove('show'); });
  }
  addLifecycleListener(window, 'keydown', (e) => {
    if (e.key.toLowerCase() !== 'e' || e.ctrlKey || e.metaKey || e.altKey) return;
    const ae = document.activeElement;
    if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
    if (!hovered || !$('#view-town').classList.contains('active')) return;
    window.__assignAgentTask?.(hovered.name, 'Awaiting your task…');
    addActivity(hovered.name, 'received a task face-to-face (E)');
    switchView('assistant');
    $('#chatInput').value = '@' + hovered.name + ' ';
    $('#chatInput').focus();
  });

  // live chrome refresh (seat dots, status strip, visual hub, notes, media link)
  renderTownChrome();
  setInterval(() => {
    safe('townChromeTick', () => {
      renderTownChrome();
      if (!$('#view-town .town-tab-pane[data-tpane="visualhub"]').hidden) renderVisualHub();
      updateMediaLink();
      renderNotesMini();
    });
  }, 1500);
}

// Mini office preview inside the assistant view (reads live town state)
function startTownPreview() {
  const canvas = $('#townMiniCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const S = 0.44, OX = (W - 900 * S) / 2, OY = (H - 520 * S) / 2;
  function loop() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // desks
    TOWN_DESKS.forEach((d) => {
      ctx.fillStyle = 'rgba(20,28,44,0.95)';
      ctx.fillRect(OX + d.x * S - 18, OY + d.y * S, 36, 4);
      ctx.fillRect(OX + d.x * S - 14, OY + d.y * S - 11, 28, 11);
      ctx.fillStyle = 'rgba(10,15,26,0.9)';
      ctx.fillRect(OX + d.x * S - 11, OY + d.y * S - 9, 22, 8);
    });
    // agents (live positions from the full town, idle desks as fallback)
    const list = townAgents();
    list.forEach((a, i) => {
      const p = a.pos || TOWN_DESKS[i];
      const x = OX + p.x * S, y = OY + p.y * S;
      const s = a.state || 'idle';
      const ring = s === 'busy' ? '#ffc24b' : s === 'queued' ? '#3bc9ff' : s === 'done' ? getAccent() : '#3dff9a';
      ctx.fillStyle = a.color || '#5d9cff';
      ctx.fillRect(x - 4, y - 5, 8, 8);
      ctx.fillStyle = '#f0c9a8';
      ctx.fillRect(x - 3, y - 10, 6, 5);
      ctx.strokeStyle = ring; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#9fb2d0'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
      ctx.fillText(a.name, x, y - 14);
    });
    scheduleViewFrame('assistant', loop);
  }
  scheduleViewFrame('assistant', loop);
  addLifecycleListener(canvas, 'click', () => { playSfx('swoosh'); switchView('town'); });
}

// ---------------------------------------------------------------------------
// T1 — account state UI (Supabase Google OAuth alongside the anon identity).
// ---------------------------------------------------------------------------
function renderAccountState() {
  const label = $('#accountState');
  const inBtn = $('#signInGoogleBtn');
  const outBtn = $('#signOutBtn');
  if (!label) return;
  const store = window.webStore;
  if (isElectron || !store) {
    label.textContent = 'Desktop build — memory is stored locally on this machine.';
    if (inBtn) inBtn.hidden = true;
    if (outBtn) outBtn.hidden = true;
    return;
  }
  const id = store.identity ? store.identity() : null;
  if (id && !id.anonymous) {
    label.textContent = `Signed in as ${id.email || id.name || id.id.slice(0, 8)} — syncing across devices`;
    label.classList.add('signed-in');
    if (inBtn) inBtn.hidden = true;
    if (outBtn) outBtn.hidden = false;
  } else {
    label.textContent = id ? 'Anonymous — this device only' : 'Cloud sync is not configured on this deployment';
    label.classList.remove('signed-in');
    if (inBtn) inBtn.hidden = !id;
    if (outBtn) outBtn.hidden = true;
  }
}

function setupAccountControls() {
  addLifecycleListener(document, 'gemair:auth', () => { renderAccountState(); updateFairUseIdentity(); });
  $('#signInGoogleBtn')?.addEventListener('click', async () => {
    if (!window.webStore || !window.webStore.signInWithGoogle) return;
    const ok = await window.webStore.signInWithGoogle(window.location.origin);
    if (!ok) {
      const err = (window.webStore.lastError || {});
      toast('SIGN-IN', err.message || 'Google sign-in is unavailable on this deployment.', '🔒');
    }
  });
  $('#signOutBtn')?.addEventListener('click', async () => {
    await window.webStore.signOut();
    renderAccountState();
    toast('ACCOUNT', 'Signed out — back to an anonymous local identity.', '👋');
  });
  renderAccountState();
}

/** T1: bind the free-core fair-use budget to the real account when there is one. */
function updateFairUseIdentity() {
  try {
    const id = window.webStore && window.webStore.identity ? window.webStore.identity() : null;
    window.__gemairUserId = id && !id.anonymous ? id.id : (id ? id.id : null);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// T3 — in-app star rating after N successful missions.
//
// Stonic collects ratings in-app; GemAir had no feedback surface at all. This
// counts successful missions (a reply that completed without error), asks ONCE
// per threshold, stores everything in localStorage, and never uploads anything.
// ---------------------------------------------------------------------------
const RATING_KEY = 'gemair:ratings';
const RATING_STATE_KEY = 'gemair:rating-state';
const RATING_THRESHOLDS = [8, 40, 150];

function readRatings() {
  try { const v = JSON.parse(localStorage.getItem(RATING_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function readRatingState() {
  try { return JSON.parse(localStorage.getItem(RATING_STATE_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function writeRatingState(next) {
  try { localStorage.setItem(RATING_STATE_KEY, JSON.stringify(next)); } catch (e) {}
}

function recordRating(stars, note) {
  const list = readRatings();
  list.push({ stars: Math.max(1, Math.min(5, Number(stars) || 0)), note: String(note || '').slice(0, 400), ts: Date.now(), version: window.__gemairVersion || '2.2.0' });
  try { localStorage.setItem(RATING_KEY, JSON.stringify(list.slice(-50))); } catch (e) {}
  renderRatingSummary();
  return list;
}

function renderRatingSummary() {
  const el = $('#ratingSummary');
  if (!el) return;
  const list = readRatings();
  if (!list.length) { el.textContent = 'No ratings yet.'; return; }
  const avg = list.reduce((sum, r) => sum + r.stars, 0) / list.length;
  const last = new Date(list[list.length - 1].ts).toLocaleDateString();
  el.textContent = `${avg.toFixed(1)}★ average across ${list.length} rating${list.length === 1 ? '' : 's'} · last ${last}`;
}

/** Build a 1-5 star control into `host`; calls onPick(stars). */
function buildStarRow(host, onPick, initial) {
  if (!host) return;
  host.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'star' + (initial && i <= initial ? ' on' : '');
    b.textContent = '★';
    b.dataset.stars = String(i);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', initial === i ? 'true' : 'false');
    b.setAttribute('aria-label', `${i} star${i === 1 ? '' : 's'}`);
    b.addEventListener('mouseenter', () => {
      [...host.children].forEach((c, idx) => c.classList.toggle('on', idx < i));
    });
    b.addEventListener('click', () => {
      playSfx('click');
      [...host.children].forEach((c, idx) => c.classList.toggle('on', idx < i));
      onPick(i);
    });
    host.appendChild(b);
  }
  host.addEventListener('mouseleave', () => {
    const on = Number(host.dataset.value || 0);
    [...host.children].forEach((c, idx) => c.classList.toggle('on', idx < on));
  });
}

function setupRatingUi() {
  renderRatingSummary();
  const host = $('#settingsStars');
  if (host) {
    buildStarRow(host, (stars) => {
      host.dataset.value = String(stars);
      recordRating(stars, 'settings');
      toast('THANK YOU', `Rated ${stars}★ — stored locally only.`, '⭐');
    });
  }
  $('#exportRatingsBtn')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(readRatings(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gemair-ratings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

/** Called after every successful mission/reply. */
function noteSuccessfulMission() {
  const state = readRatingState();
  state.missions = (state.missions || 0) + 1;
  const threshold = RATING_THRESHOLDS.find((n) => state.missions === n);
  writeRatingState(state);
  if (!threshold) return;
  if ((state.asked || []).includes(threshold)) return;
  state.asked = [...(state.asked || []), threshold];
  writeRatingState(state);
  setTimeout(() => showRatingPrompt(state.missions), 1500);
}

function showRatingPrompt(missions) {
  const log = $('#chatLog');
  if (!log || log.querySelector('.rating-prompt')) return;
  const box = document.createElement('div');
  box.className = 'rating-prompt';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Rate GemAir');
  box.innerHTML = `<span>${missions} missions done together. How is GemAir treating you?</span>
    <span class="star-row" id="promptStars"></span>
    <button class="mini-btn" type="button" data-later>Later</button>`;
  log.appendChild(box);
  log.scrollTop = log.scrollHeight;
  buildStarRow(box.querySelector('#promptStars'), (stars) => {
    recordRating(stars, `prompt@${missions}`);
    box.innerHTML = `<span>Thank you — ${stars}★ recorded locally. You can export ratings from Settings.</span>`;
    setTimeout(() => box.remove(), 4000);
  });
  box.querySelector('[data-later]')?.addEventListener('click', () => box.remove());
}

// ---------------------------------------------------------------------------
// U4 — modal accessibility.
//
// 2.1 had five .modal-backdrop dialogs with no role, no aria-modal, no focus
// management, and an Escape handler that only closed three of them (settings,
// palette, download) — breathe / report / theme trapped the user with the
// mouse. Every modal now announces itself, traps Tab, restores focus on close
// and answers Escape.
// ---------------------------------------------------------------------------
const MODAL_IDS = ['themeModal', 'settingsModal', 'downloadModal', 'breatheModal', 'reportModal', 'experimentalWarningModal', 'reconnectModal', 'agentModal', 'codingAgentModal'];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let lastFocusedBeforeModal = null;

function openModals() {
  return MODAL_IDS.map((id) => document.getElementById(id)).filter((el) => el && el.classList.contains('open'));
}

/** Close every open modal AND the palette. Used by the global Escape handler. */
function closeAllModals() {
  let closed = false;
  for (const el of openModals()) { el.classList.remove('open'); closed = true; }
  try { closePalette(); } catch (e) {}
  if (closed && lastFocusedBeforeModal && lastFocusedBeforeModal.isConnected) {
    try { lastFocusedBeforeModal.focus(); } catch (e) {}
  }
  lastFocusedBeforeModal = null;
  return closed;
}

function setupModalAccessibility() {
  for (const id of MODAL_IDS) {
    const backdrop = document.getElementById(id);
    if (!backdrop) continue;
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    // click outside the dialog closes it
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) closeAllModals();
    });

    // Tab focus trap
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAllModals(); return; }
      if (e.key !== 'Tab') return;
      const items = [...backdrop.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // when a modal opens, remember what had focus and move focus inside
    if (typeof MutationObserver === 'undefined') continue; // headless/self-check
    const observer = new MutationObserver(() => {
      if (!backdrop.classList.contains('open')) return;
      if (!lastFocusedBeforeModal) lastFocusedBeforeModal = document.activeElement;
      const target = backdrop.querySelector('[autofocus]') || backdrop.querySelector(FOCUSABLE);
      if (target) setTimeout(() => { try { target.focus(); } catch (e) {} }, 40);
    });
    observer.observe(backdrop, { attributes: true, attributeFilter: ['class'] });
  }
}

/**
 * U4 — icon-only buttons need names. Rather than hand-annotating dozens of
 * elements in the markup (and letting them drift), derive the label from the
 * existing title/data attribute at boot and warn in the console if neither
 * exists, so a new unlabelled icon button is caught during development.
 */
function labelIconButtons() {
  const buttons = document.querySelectorAll('button, .expert-plus, [role="button"]');
  for (const el of buttons) {
    if (el.getAttribute('aria-label')) continue;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    // a button with real words is already accessible
    if (text && /[a-z]{3,}/i.test(text)) continue;
    const label = el.getAttribute('title') || el.dataset.cmd || el.dataset.tab || el.dataset.etab ||
      el.dataset.sat || el.dataset.ttab || el.dataset.tid || el.dataset.newsCategory || text;
    if (label) el.setAttribute('aria-label', String(label).slice(0, 80));
  }
}

/** U4 — the palette hint said ⌘K on every platform, including Windows/Linux. */
function applyPlatformShortcutHints() {
  const isMac = /mac|iphone|ipad/i.test((api.platform || '') + ' ' + navigator.userAgent + ' ' + (navigator.platform || ''));
  const mod = isMac ? '⌘' : 'Ctrl';
  document.querySelectorAll('.kbd-mod').forEach((el) => { el.textContent = mod; });
  document.querySelectorAll('[data-shortcut-mod]').forEach((el) => {
    el.textContent = el.dataset.shortcutMod.replace('{mod}', mod);
  });
  // the chat welcome line hardcodes the combo in prose
  document.querySelectorAll('.msg.system-msg .sub b').forEach((el) => {
    if (/^(ctrl|⌘)\+k$/i.test(el.textContent.trim())) el.textContent = `${mod}+K`;
  });
}

// ---------------------------------------------------------------------------
// S7 — Workflow gallery.
//
// The 12 Section III recipes existed only as palette search hits, so a user who
// never opened the palette never knew they were there. This renders them as
// one-click cards in the Agent Town side panel; a click runs the exact same
// prompt the palette entry did, through the same tool chain.
// ---------------------------------------------------------------------------
function renderWorkflowGallery() {
  const grid = $('#workflowGallery');
  if (!grid) return;
  grid.innerHTML = WORKFLOWS.map((w) => `
    <button class="wf-card" data-wf="${escapeHtml(w.id)}" title="${escapeHtml(w.prompt)}" aria-label="${escapeHtml(w.name)}">
      <span class="wf-ico" aria-hidden="true">${w.icon}</span>
      <span class="wf-name">${escapeHtml(w.name)}</span>
      <span class="wf-detail">${escapeHtml(w.detail)}</span>
    </button>`).join('');
  grid.querySelectorAll('.wf-card').forEach((card) => {
    card.addEventListener('click', () => {
      const wf = WORKFLOWS.find((w) => w.id === card.dataset.wf);
      if (!wf) return;
      playSfx('swoosh');
      toast('WORKFLOW', wf.name, wf.icon);
      switchView('assistant');
      sendMessage(wf.prompt);
    });
  });
}

// ---------------------------------------------------------------------------
// S10 — quick-command editor.
//
// The ＋ in the expert-panel tab strip had no handler at all — it was a dead
// glyph. It now opens a small editor that appends to the SAME quickCommands
// strip the built-ins live in, persisted to localStorage.
// ---------------------------------------------------------------------------
const QC_KEY = 'gemair:quick-commands';

function readCustomQuickCommands() {
  try {
    const list = JSON.parse(localStorage.getItem(QC_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && x.label && x.cmd).slice(0, 12) : [];
  } catch (e) { return []; }
}

function writeCustomQuickCommands(list) {
  try { localStorage.setItem(QC_KEY, JSON.stringify(list.slice(0, 12))); } catch (e) {}
}

function renderQuickCommands() {
  const strip = $('#quickCommands');
  if (!strip) return;
  strip.querySelectorAll('.qc.custom').forEach((n) => n.remove());
  for (const item of readCustomQuickCommands()) {
    const btn = document.createElement('button');
    btn.className = 'qc custom';
    btn.dataset.cmd = item.cmd;
    btn.textContent = item.label;
    btn.title = `${item.cmd} — right-click to remove`;
    btn.addEventListener('click', () => {
      const input = $('#chatInput');
      if (!input) return;
      input.value = item.cmd;
      input.focus();
      playSfx('click');
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      writeCustomQuickCommands(readCustomQuickCommands().filter((x) => x.cmd !== item.cmd || x.label !== item.label));
      renderQuickCommands();
      toast('QUICK COMMANDS', `Removed “${item.label}”`, '⌫');
    });
    strip.appendChild(btn);
  }
}

function openQuickCommandEditor() {
  const strip = $('#quickCommands');
  if (!strip || strip.querySelector('.qc-editor')) return;
  playSfx('click');
  const editor = document.createElement('div');
  editor.className = 'qc-editor';
  editor.innerHTML = `
    <input type="text" id="qcEditorInput" placeholder="Label ⇢ command   e.g.  📦 Backup ⇢ Back up my documents" aria-label="New quick command" />
    <button class="mini-btn" id="qcEditorSave" aria-label="Save quick command">✓</button>
    <button class="mini-btn" id="qcEditorCancel" aria-label="Cancel">✕</button>`;
  strip.parentNode.insertBefore(editor, strip);
  const input = $('#qcEditorInput');
  input?.focus();

  const close = () => editor.remove();
  const save = () => {
    const raw = (input?.value || '').trim();
    if (!raw) return close();
    const [labelPart, ...rest] = raw.split(/⇢|=>|\|/);
    const label = (labelPart || '').trim().slice(0, 24);
    const cmd = (rest.join('⇢').trim() || labelPart || '').trim().slice(0, 200);
    if (!label || !cmd) { toast('QUICK COMMANDS', 'Use “Label ⇢ command”.', '⚠️'); return; }
    const list = readCustomQuickCommands();
    list.push({ label, cmd });
    writeCustomQuickCommands(list);
    renderQuickCommands();
    close();
    toast('QUICK COMMANDS', `Added “${label}”`, '⚡');
  };
  $('#qcEditorSave')?.addEventListener('click', save);
  $('#qcEditorCancel')?.addEventListener('click', close);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
}

// ---------------------------------------------------------------------------
// S1 — SAT-LINK FEED, wired to real data.
//
// In 2.1 the four tabs (TODAY / RAP / SEARCH / ALERTS) were pure decoration:
// clicking one only moved the .active class. Each now renders a live feed:
//   TODAY   real headlines (the same feed as the headlines panel)
//   RAP     real rain-radar imagery for the user's city (RainViewer, key-free)
//   SEARCH  a working web-search box against /api/search
//   ALERTS  weather advisories derived from the Open-Meteo forecast
// Every one degrades to an honest message rather than fake content (U2).
// ---------------------------------------------------------------------------
let satTab = 'today';

function satBusy(label) {
  const el = $('#satPanel');
  if (el) el.innerHTML = `<div class="empty">${escapeHtml(label)}</div>`;
}

async function renderSatFeed(tab) {
  satTab = tab || satTab;
  const panel = $('#satPanel');
  if (!panel) return;
  if (satTab === 'today') return renderSatToday();
  if (satTab === 'rap') return renderSatRadar();
  if (satTab === 'search') return renderSatSearch();
  if (satTab === 'alerts') return renderSatAlerts();
}

async function renderSatToday() {
  const panel = $('#satPanel');
  satBusy('Fetching headlines…');
  let items = worldHeadlines;
  if (!items || !items.length) {
    try { items = await api.getHeadlines(5, worldCategory); } catch (e) { items = []; }
  }
  if (!items || !items.length) {
    panel.innerHTML = '<div class="empty">No headlines available right now.</div>';
    return;
  }
  const simulated = items.some((i) => i.simulated);
  panel.innerHTML =
    (simulated ? '<div class="sat-badge sim">SIMULATED — live news feed unreachable</div>' : '<div class="sat-badge live">LIVE</div>') +
    items.slice(0, 5).map((h) => `
      <a class="sat-item" href="${escapeHtml(h.url || '#')}" data-external="1">
        <span class="sat-dot"></span><span>${escapeHtml(h.title || '')}</span>
      </a>`).join('');
}

/** Lat/lon → slippy-map tile indices at zoom z. */
function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y, z };
}

async function renderSatRadar() {
  const panel = $('#satPanel');
  satBusy('Locating radar…');
  const city = profile.city || DEFAULTS.city;
  try {
    const w = await webGet('weather', { city });
    if (!w || typeof w.latitude !== 'number') throw new Error('no-coords');
    const maps = await fetch('https://api.rainviewer.com/public/weather-maps.json').then((r) => r.json());
    const frames = (maps.radar && (maps.radar.past || [])) || [];
    const frame = frames[frames.length - 1];
    if (!frame) throw new Error('no-frame');
    const { x, y, z } = lonLatToTile(w.longitude, w.latitude, 6);
    const base = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    const radar = `${maps.host}${frame.path}/256/${z}/${x}/${y}/4/1_1.png`;
    const stamp = new Date(frame.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    panel.innerHTML = `
      <div class="sat-badge live">LIVE RADAR — ${escapeHtml(w.city)} · ${escapeHtml(stamp)}</div>
      <div class="sat-radar">
        <img src="${base}" alt="Map of ${escapeHtml(w.city)}" loading="lazy" />
        <img class="sat-radar-overlay" src="${radar}" alt="Rain radar overlay" loading="lazy" />
      </div>
      <div class="sat-note">${escapeHtml(w.condition || '')} · ${escapeHtml(String(w.temperature))}°C · wind ${escapeHtml(String(w.windspeed))} km/h</div>`;
  } catch (e) {
    panel.innerHTML = '<div class="empty">Radar imagery unavailable (offline or the radar service is down).</div>';
  }
}

function renderSatSearch() {
  const panel = $('#satPanel');
  panel.innerHTML = `
    <div class="sat-search">
      <input type="text" id="satSearchInput" placeholder="Search the web…" aria-label="Search the web" />
      <button class="mini-btn" id="satSearchGo" aria-label="Run search">→</button>
    </div>
    <div id="satSearchResults"><div class="empty">Type a query and press Enter.</div></div>`;
  const run = async () => {
    const q = ($('#satSearchInput')?.value || '').trim();
    if (!q) return;
    const out = $('#satSearchResults');
    out.innerHTML = '<div class="empty">Searching…</div>';
    const r = await webGet('search', { q });
    if (!r || r.error) { out.innerHTML = '<div class="empty">Search unavailable right now.</div>'; return; }
    const rows = [];
    if (r.answer) rows.push(`<div class="sat-answer">${escapeHtml(r.answer)}${r.source ? ` <span class="dim">— ${escapeHtml(r.source)}</span>` : ''}</div>`);
    for (const item of (r.results || []).slice(0, 4)) {
      rows.push(`<a class="sat-item" href="${escapeHtml(item.url || '#')}" data-external="1"><span class="sat-dot"></span><span>${escapeHtml(item.title || '')}</span></a>`);
    }
    out.innerHTML = rows.length ? rows.join('') : '<div class="empty">No results.</div>';
  };
  $('#satSearchGo')?.addEventListener('click', run);
  $('#satSearchInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

async function renderSatAlerts() {
  const panel = $('#satPanel');
  satBusy('Checking advisories…');
  const city = profile.city || DEFAULTS.city;
  const r = await webGet('weather', { city, mode: 'alerts' });
  if (!r || r.error || !Array.isArray(r.alerts)) {
    panel.innerHTML = '<div class="empty">Weather advisories unavailable right now.</div>';
    return;
  }
  if (!r.alerts.length) {
    panel.innerHTML = `<div class="sat-badge live">ALL CLEAR — ${escapeHtml(r.city)}</div><div class="sat-note">No significant weather in the next 3 days.</div>`;
    return;
  }
  panel.innerHTML =
    `<div class="sat-badge ${r.alerts.some((a) => a.level === 'severe') ? 'sev' : 'warn'}">${r.alerts.length} ADVISORY(S) — ${escapeHtml(r.city)}</div>` +
    r.alerts.slice(0, 4).map((a) => `
      <div class="sat-item alert ${escapeHtml(a.level)}">
        <span class="sat-dot"></span>
        <span><b>${escapeHtml(a.title)}</b> <span class="dim">${escapeHtml(a.day || '')}</span><br><span class="dim">${escapeHtml(a.detail)}</span></span>
      </div>`).join('') +
    `<div class="sat-note dim">${escapeHtml(r.source || '')}</div>`;
}

// SAT-LINK FEED — tiny rotating satellite globe with hotspots
function startSatLink() {
  const canvas = $('#satCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2 + 4, R = Math.min(W, H) / 2 - 14;
  const hotspots = Array.from({ length: 14 }, () => ({
    lat: (Math.random() - 0.5) * 1.9, lon: Math.random() * Math.PI * 2,
    c: Math.random() < 0.45 ? '#ffc24b' : Math.random() < 0.5 ? '#ff5d5d' : '#3dff9a',
    r: 1.4 + Math.random() * 1.8
  }));
  let rot = 0;
  function loop() {
    rot += 0.004;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#04070d'; ctx.fillRect(0, 0, W, H);
    // stars
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    for (let i = 0; i < 26; i++) {
      const sx = (i * 73 + 31) % W, sy = (i * 127 + 13) % H;
      ctx.fillRect(sx, sy, 1, 1);
    }
    // globe body
    const g = ctx.createRadialGradient(cx - R / 3, cy - R / 3, R / 4, cx, cy, R);
    g.addColorStop(0, '#0d2036'); g.addColorStop(1, '#050b14');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,255,0.25)'; ctx.lineWidth = 1;
    ctx.stroke();
    // graticule (rotating meridians)
    for (let i = 0; i < 3; i++) {
      const k = Math.abs(Math.cos(rot * (i + 1) * 0.7 + i));
      ctx.strokeStyle = 'rgba(120,170,255,0.14)';
      ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(2, R * k), R, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120,170,255,0.14)';
    for (let i = 1; i < 3; i++) {
      const yy = cy - R + (2 * R / 3) * i;
      const half = Math.sqrt(Math.max(0, R * R - (yy - cy) * (yy - cy)));
      ctx.beginPath(); ctx.moveTo(cx - half, yy); ctx.lineTo(cx + half, yy); ctx.stroke();
    }
    // hotspots on the front hemisphere
    for (const h of hotspots) {
      const lon = h.lon + rot;
      const depth = Math.cos(lon);
      if (depth < 0.05) continue;
      const x = cx + R * Math.sin(lon) * Math.cos(h.lat);
      const y = cy - R * Math.sin(h.lat) * 0.82;
      const pulse = 0.55 + 0.45 * Math.sin(Date.now() / 400 + h.lon * 5);
      ctx.globalAlpha = depth * pulse;
      ctx.fillStyle = h.c;
      ctx.beginPath(); ctx.arc(x, y, h.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = depth * pulse * 0.35;
      ctx.beginPath(); ctx.arc(x, y, h.r * 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    scheduleViewFrame('assistant', loop);
  }
  scheduleViewFrame('assistant', loop);
}

// Glowing data wires from the circuit cards into the orb
function startCircuitWires() {
  const canvas = $('#wireCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const colors = [null, '#ff9d3b', '#3dff9a', '#8a9bb2']; // memory uses theme accent
  let dash = 0;
  function loop(t) {
    const accent = getAccent();
    ctx.clearRect(0, 0, W, H);
    const n = 4, midY = H / 2, endX = W - 4;
    for (let i = 0; i < n; i++) {
      const y0 = H * (i + 1) / (n + 1);
      const c = colors[i] === null ? accent : colors[i];
      const cpx = W * 0.55, cpy = y0 + (midY - y0) * 0.5;
      ctx.strokeStyle = c;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = -dash - i * 4;
      ctx.shadowColor = c; ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(2, y0);
      ctx.bezierCurveTo(cpx, y0, cpx, cpy, endX, midY);
      ctx.stroke();
      // moving data pulse
      const k = ((t / 1400) + i * 0.25) % 1;
      const px = 2 + (endX - 2) * k;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(px, midY + (y0 - midY) * Math.pow(1 - k, 2), 1.8, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    dash += 0.6;
    scheduleViewFrame('assistant', loop);
  }
  scheduleViewFrame('assistant', loop);
}

// ---------------------------------------------------------------------------
// Expert panel (right column) — VOICE / AGENT / NOTES tabs + tool activity
// ---------------------------------------------------------------------------
function renderVoiceTab() {
  const el = $('#voiceStatusList');
  if (!el) return;
  const v = profile.voice || {};
  const engineLabel = v.mode === 'edge' ? 'EDGE NEURAL · MS VOICES' : v.mode === 'system' ? 'SYSTEM · OFFLINE OS VOICE' : 'NEURAL · FREE ONLINE';
  const rows = [
    ['ENGINE', engineLabel, v.mode !== 'system'],
    ['VOICE', v.mode === 'edge' ? (v.edgeVoice || 'en-US-AriaNeural').split('-Neural')[0] + ' Neural' : (profile.voiceGender || profile.avatarGender || 'female').toUpperCase(), true],
    ['GENDER', (profile.voiceGender || profile.avatarGender || 'female').toUpperCase(), true],
    ['ACCENT', (v.neuralVoice || 'EN-US').toUpperCase(), true],
    ['RATE', (v.rate ?? 1.0).toFixed(2), false],
    ['PITCH', (v.pitch ?? 1.1).toFixed(2), false],
    ['RECOGNITION', (v.sttLang || DEFAULTS.sttLang).toUpperCase(), true],
    ['MIC', listening ? 'LISTENING…' : (isRunning ? 'ONLINE' : 'STANDBY'), !!isRunning || listening]
  ];
  el.innerHTML = rows.map((r) => `<div class="vs-row"><span>${r[0]}</span><b class="${r[2] ? 'hot' : ''}">${r[1]}</b></div>`).join('');
}

function renderNotesMini() {
  const el = $('#notesMini');
  if (!el) return;
  const notes = (memory && memory.notes) || [];
  if (!notes.length) { el.innerHTML = '<div class="empty">No notes yet — say “Write a note: …” in chat.</div>'; return; }
  el.innerHTML = notes.slice(0, 12).map((n) => `<div class="note-item">📝 ${escapeHtml(n.text || n)}</div>`).join('');
}

// Stonic-style tool activity cards (INPUT / OUTPUT). Desktop tool execution
// pushes here via window.__pushToolActivity; the empty state explains itself.
function pushToolActivity(name, args, result, ms) {
  const feed = $('#toolFeed');
  if (!feed) return;
  const empty = feed.querySelector('.empty');
  if (empty) feed.innerHTML = '';
  const str = (x) => (typeof x === 'string' ? x : JSON.stringify(x == null ? {} : x));
  const div = document.createElement('div');
  div.className = 'tool-card';
  div.innerHTML = `
    <div class="tool-head"><span class="tool-ico">⚙</span>${escapeHtml(name)}<span class="tool-dur dim">${ms != null ? ms.toFixed(1) + 's' : ''}</span></div>
    <div class="tool-io"><span class="io-label">INPUT</span><pre>${escapeHtml(str(args).slice(0, 260))}</pre></div>
    <div class="tool-io"><span class="io-label">OUTPUT</span><pre>${escapeHtml(str(result).slice(0, 260))}</pre></div>`;
  feed.prepend(div);
  while (feed.children.length > 12) feed.removeChild(feed.lastChild);
  const pane = $('#etabAgent');
  if (pane) pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
window.__pushToolActivity = pushToolActivity;

// Live tool-activity feed — listens to the same ai:activity event stream the
// inline chips use (preload onActivity ← main.js aiChatStream), so the right
// column shows real-time cards:  web_search … → done ✓ / error ✗
const toolFeedCards = new Map(); // tool name -> { el, t0 }
function toolFeedUpdate({ name, state }) {
  updateToolOperationProgress(name, state);
  const feed = $('#toolFeed');
  if (!feed) return;
  const empty = feed.querySelector('.empty');
  if (empty) feed.innerHTML = '';
  const label = String(name || 'tool').replace(/_/g, ' ');
  const now = Date.now();
  let rec = toolFeedCards.get(name);
  if (!rec) {
    const div = document.createElement('div');
    div.className = 'tool-card running';
    div.innerHTML = `
      <div class="tool-head"><span class="tool-ico">⚙</span><span class="tool-name">${escapeHtml(label)}</span><span class="tool-dur dim">…</span></div>
      <div class="tool-io"><span class="io-label">STATE</span><pre>running…</pre></div>`;
    feed.prepend(div);
    while (feed.children.length > 12) {
      const last = feed.lastElementChild;
      for (const [k, v] of toolFeedCards) if (v.el === last) toolFeedCards.delete(k);
      last.remove();
    }
    rec = { el: div, t0: now };
    toolFeedCards.set(name, rec);
  }
  if (state === 'done') {
    const secs = ((now - rec.t0) / 1000).toFixed(1);
    rec.el.classList.remove('running'); rec.el.classList.add('done');
    const io = rec.el.querySelector('.tool-io pre'); if (io) io.textContent = 'done ✓ (' + secs + 's)';
    const dur = rec.el.querySelector('.tool-dur'); if (dur) { dur.textContent = secs + 's'; dur.classList.remove('dim'); }
  } else if (state === 'error') {
    rec.el.classList.remove('running'); rec.el.classList.add('error');
    const io = rec.el.querySelector('.tool-io pre'); if (io) io.textContent = 'error ✗';
    const dur = rec.el.querySelector('.tool-dur'); if (dur) dur.textContent = '✗';
  } else {
    rec.t0 = now; // (re)start
    const io = rec.el.querySelector('.tool-io pre'); if (io) io.textContent = 'running…';
  }
}
if (api.onActivity) api.onActivity(toolFeedUpdate);

// ---------------------------------------------------------------------------
// Memory / Notes / Reminders rendering
// ---------------------------------------------------------------------------
function renderFacts() {
  const list = $('#memoryList');
  if (!list) return;
  const filter = ($('#factFilter')?.value || '').toLowerCase().trim();
  const activeCat = $('#memoryCatFilters .qc.active')?.dataset.cat || 'all';

  let facts = (memory.facts || []).slice().sort((a, b) => (b.importance || 0) - (a.importance || 0));

  if (activeCat && activeCat !== 'all') {
    facts = facts.filter(f => (f.category || 'fact').toLowerCase() === activeCat);
  }
  if (filter) {
    facts = facts.filter(f => f.text.toLowerCase().includes(filter) || (f.category || '').toLowerCase().includes(filter));
  }

  $('#factCount').textContent = '— ' + facts.length + ' remembered';
  if (!facts.length) { list.innerHTML = '<div class="empty">No matching memories found.</div>'; return; }
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
function renderMemoryBrowser() {
  const list = $('#memoryBrowserList'); if (!list) return;
  const query = ($('#memoryBrowserSearch')?.value || '').toLowerCase().trim();
  const typeFilter = $('#memoryBrowserType')?.value || 'all';
  const entries = [];
  const push = (type, item, text, meta, remove) => entries.push({ type, item, text: String(text || ''), meta, remove });
  (memory.facts || []).forEach((item) => push('fact', item, item.text, item.category || 'fact', () => api.memoryDeleteFact(item.id)));
  (memory.notes || []).forEach((item) => push('note', item, item.text, 'notebook', () => api.memoryDeleteNote(item.id)));
  (memory.goals || []).forEach((item) => push('goal', item, item.text, `${item.category || 'personal'} · ${item.done ? 'complete' : 'active'}`, () => api.memoryDeleteGoal(item.id)));
  (memory.skills || []).forEach((item) => push('skill', item, `${item.name ? item.name + ': ' : ''}${item.text}`, 'learned skill', () => api.memoryDeleteSkill(item.id)));
  (memory.instructions || []).forEach((item) => push('instruction', item, item.text, 'standing rule', () => api.memoryDeleteInstruction(item.id)));
  (memory.reminders || []).forEach((item) => push('reminder', item, item.text, new Date(item.at).toLocaleString(), () => api.memoryDeleteReminder(item.id)));
  const filtered = entries.filter((entry) => (typeFilter === 'all' || entry.type === typeFilter) && (!query || `${entry.text} ${entry.meta}`.toLowerCase().includes(query)));
  if (!filtered.length) { list.innerHTML = '<div class="empty">No memories match this search.</div>'; return; }
  list.innerHTML = '';
  filtered.sort((a, b) => (b.item.updated || b.item.created || b.item.ts || 0) - (a.item.updated || a.item.created || a.item.ts || 0)).forEach((entry) => {
    const row = document.createElement('div'); row.className = 'memory-browser-entry';
    row.innerHTML = `<div><span class="mb-type">${entry.type.toUpperCase()}</span><span class="mb-preview">${escapeHtml(entry.text)}</span><button class="mb-view">VIEW</button><button class="mb-delete">DELETE</button></div><pre hidden>${escapeHtml(entry.text)}\n\n${escapeHtml(entry.meta || '')}</pre>`;
    const detail = row.querySelector('pre');
    row.querySelector('.mb-view').addEventListener('click', (event) => { detail.hidden = !detail.hidden; event.currentTarget.textContent = detail.hidden ? 'VIEW' : 'HIDE'; });
    row.querySelector('.mb-delete').addEventListener('click', async () => {
      await entry.remove(); await loadMemory(); renderAllMemory(); toast('MEMORY', 'Individual memory deleted.', '⌫');
    });
    list.appendChild(row);
  });
}

function renderAllMemory() { renderFacts(); renderNotes(); renderTodos(); renderReminders(); updateTranscriptCount(); renderGoals(); renderMood(); renderSkills(); renderInstructions(); renderMemoryBrowser(); renderMissionLog(); renderBriefing(); }

// ---------------------------------------------------------------------------
// Ambient Sound Generator for Focus Sessions
// ---------------------------------------------------------------------------
let ambientCtx = null;
let ambientSource = null;
let ambientGain = null;

function playAmbientSound(type) {
  stopAmbientSound();
  if (!type || type === 'none') return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!ambientCtx) ambientCtx = new AudioCtx();
    if (ambientCtx.state === 'suspended') ambientCtx.resume();

    const ctx = ambientCtx;
    ambientGain = ctx.createGain();
    ambientGain.gain.setValueAtTime(0.12, ctx.currentTime);
    ambientGain.connect(ctx.destination);

    if (type === 'rain') {
      const bufferSize = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buffer; noise.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1000, ctx.currentTime);

      noise.connect(filter);
      filter.connect(ambientGain);
      noise.start();
      ambientSource = noise;
    } else if (type === 'space') {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      osc1.type = 'sine'; osc1.frequency.setValueAtTime(110, ctx.currentTime);
      osc2.type = 'sine'; osc2.frequency.setValueAtTime(110.5, ctx.currentTime);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.setValueAtTime(400, ctx.currentTime);

      osc1.connect(filter); osc2.connect(filter);
      filter.connect(ambientGain);
      osc1.start(); osc2.start();
      ambientSource = { stop: () => { try { osc1.stop(); osc2.stop(); } catch (e) {} } };
    } else if (type === 'ocean') {
      const bufferSize = ctx.sampleRate * 3;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let lastOut = 0.0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        data[i] = (lastOut + (0.02 * white)) / 1.02;
        lastOut = data[i];
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer; noise.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.setValueAtTime(600, ctx.currentTime);

      noise.connect(filter);
      filter.connect(ambientGain);
      noise.start();
      ambientSource = noise;
    }
  } catch (e) {}
}

function stopAmbientSound() {
  if (ambientSource) {
    try { ambientSource.stop(); } catch (e) {}
    ambientSource = null;
  }
}
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
  // U2: on any failure this used to sit on "🌤 Loading…" forever.
  webGet('weather', { city: profile.city || DEFAULTS.city }).then((w) => {
    const el = $('#briefWeather');
    if (!el) return;
    if (w && w.temperature != null) {
      el.textContent = `${w.simulated ? '⚠' : '🌤'} ${String(w.city || '').split(',')[0]}: ${w.temperature}°C ${w.condition}`;
      el.title = w.simulated ? 'Simulated — the weather service was unreachable.' : 'Live from Open-Meteo';
      el.classList.toggle('simulated', !!w.simulated);
    } else {
      el.textContent = '🌤 Weather unavailable';
      el.title = (w && w.error) || 'The weather service did not respond.';
    }
  }).catch(() => {
    const el = $('#briefWeather');
    if (el) { el.textContent = '🌤 Weather unavailable (offline)'; el.title = 'No network connection.'; }
  });
}

function weeklyReportSeries() {
  const now = new Date();
  const starts = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (6 - index)); return day.getTime();
  });
  const mood = starts.map((start, index) => {
    const end = index < 6 ? starts[index + 1] : Date.now() + 1;
    const points = (memory.mood || []).filter((item) => (item.ts || 0) >= start && (item.ts || 0) < end);
    return points.length ? points.reduce((sum, item) => sum + Number(item.valence || 0), 0) / points.length : 0;
  });
  const tasks = starts.map((start, index) => {
    const end = index < 6 ? starts[index + 1] : Date.now() + 1;
    return (memory.todos || []).filter((item) => item.done && Number(item.completed || item.updated || item.created || 0) >= start && Number(item.completed || item.updated || item.created || 0) < end).length;
  });
  const goals = starts.map((start, index) => {
    const end = (index < 6 ? starts[index + 1] : Date.now() + 1) - 1;
    const available = (memory.goals || []).filter((goal) => !goal.created || goal.created <= end);
    if (!available.length) return 0;
    const done = available.filter((goal) => goal.done && (!goal.completed || goal.completed <= end)).length;
    return Math.round(done / available.length * 100);
  });
  return { mood, tasks, goals };
}

function drawSparkline(canvas, values, options = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d'), width = canvas.width, height = canvas.height, pad = 8;
  ctx.clearRect(0, 0, width, height);
  const min = options.min != null ? options.min : Math.min(...values, 0);
  const max = options.max != null ? options.max : Math.max(...values, 1);
  const range = Math.max(0.001, max - min);
  const points = values.map((value, index) => ({ x: pad + index / Math.max(1, values.length - 1) * (width - pad * 2), y: height - pad - (value - min) / range * (height - pad * 2) }));
  const accent = getAccent();
  const gradient = ctx.createLinearGradient(0, 0, 0, height); gradient.addColorStop(0, hexToRgba(accent, .34)); gradient.addColorStop(1, hexToRgba(accent, 0));
  ctx.beginPath(); ctx.moveTo(points[0].x, height - pad); points.forEach((point) => ctx.lineTo(point.x, point.y)); ctx.lineTo(points[points.length - 1].x, height - pad); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
  points.forEach((point) => { ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(point.x, point.y, 2, 0, Math.PI * 2); ctx.fill(); });
}

function renderWeeklySparklines() {
  const series = weeklyReportSeries();
  drawSparkline($('#reportMoodSpark'), series.mood, { min: -1, max: 1 });
  drawSparkline($('#reportTaskSpark'), series.tasks, { min: 0, max: Math.max(1, ...series.tasks) });
  drawSparkline($('#reportGoalSpark'), series.goals, { min: 0, max: 100 });
  const moodAvg = series.mood.reduce((sum, value) => sum + value, 0) / series.mood.length;
  $('#reportMoodMetric').textContent = `${Math.round(moodAvg * 100)} avg`;
  $('#reportTaskMetric').textContent = `${series.tasks.reduce((sum, value) => sum + value, 0)} complete`;
  $('#reportGoalMetric').textContent = `${series.goals[series.goals.length - 1]}% achieved`;
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
  renderAdaptivePersonalityState();
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

/**
 * Accent → rgba() (R6).
 *
 * 2.1 assumed the accent was always "#rrggbb". Under the RGB theme getAccent()
 * returns an hsl() string, so parseInt produced NaN and every
 * gradient.addColorStop() call threw — silently killing the weekly sparklines,
 * the mood chart and the command map. This routes through the one tolerant
 * colour parser (avatar.js parseColor: hex / rgb() / hsl()) with a local
 * fallback so it still works if avatar.js failed to load.
 */
function parseAnyColor(str) {
  try {
    if (window.gemAvatar && window.gemAvatar.parseColor) {
      const c = window.gemAvatar.parseColor(String(str || '').trim());
      if (c) return c;
    }
  } catch (e) {}
  const v = String(str || '').trim();
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) { const p = m[1].split(',').map(Number); return { r: p[0] | 0, g: p[1] | 0, b: p[2] | 0 }; }
  m = v.match(/^hsla?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map(parseFloat);
    const h = ((p[0] % 360) + 360) % 360 / 360, sat = (p[1] || 0) / 100, l = (p[2] || 0) / 100;
    const f = (n) => {
      const k = (n + h * 12) % 12, a = sat * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return { r: f(0), g: f(8), b: f(4) };
  }
  return { r: 59, g: 201, b: 255 };
}

function hexToRgba(hex, alpha) {
  const c = parseAnyColor(hex);
  return `rgba(${c.r},${c.g},${c.b},${Number.isFinite(Number(alpha)) ? Number(alpha) : 1})`;
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
  // U6: this was hardcoded at 85% forever — it looked like telemetry but was a
  // painted number. Derive it from the real learned-skill count (10 skills
  // saturates the bar), floored at 20% so an empty bar still reads as a bar.
  const skillCount = (memory.skills || []).length;
  const skillPct = Math.max(20, Math.min(100, Math.round(20 + skillCount * 8)));
  $('#skillCircuit').style.width = skillPct + '%';
  $('#skillCircuitVal').textContent = skillPct + '%';
  const skillRow = $('#skillCircuit').closest('.stx-circuit');
  if (skillRow) skillRow.title = `${skillCount} learned skill${skillCount === 1 ? '' : 's'}`;
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
    scheduleViewFrame('world', draw);
  }
  scheduleViewFrame('world', draw);
}

// ---------------------------------------------------------------------------
// Headlines
// ---------------------------------------------------------------------------
async function refreshHeadlines(category = worldCategory) {
  worldCategory = ['tech', 'world', 'business'].includes(category) ? category : 'tech';
  $$('.news-filter').forEach((button) => button.classList.toggle('active', button.dataset.newsCategory === worldCategory));
  const lists = [$('#newsList'), $('#newsListMini')].filter(Boolean);
  lists.forEach((list) => { list.innerHTML = `<div class="empty">Fetching ${worldCategory} headlines…</div>`; });
  try {
    const items = await api.getHeadlines(14, worldCategory);
    worldHeadlines = Array.isArray(items) ? items.filter(item => !item.simulated) : [];
    if (!worldHeadlines.length) {
      lists.forEach(list => { list.innerHTML = '<div class="empty">No headlines available. Try refreshing the feed.</div>'; });
      return;
    }
    const fill = (list) => {
      list.innerHTML = '';
      worldHeadlines.forEach((headline) => {
        const div = document.createElement('div');
        div.className = 'news-item';
        div.dataset.newsId = String(headline.id);
        const status = headline.simulated ? 'SIMULATED' : (headline.score ? '▲ ' + headline.score : 'LIVE');
        const meta = [String(headline.category || worldCategory).toUpperCase(), headline.by, status].filter(Boolean).join(' · ');
        if (headline.simulated) div.classList.add('simulated');
        const idx = String(worldHeadlines.indexOf(headline) + 1).padStart(2, "0");
        div.innerHTML = `<span class="n-idx">${idx}</span><div class="n-body"><div class="n-title">${escapeHtml(headline.title)}</div><div class="n-meta">${escapeHtml(meta)}</div></div>`;
        div.addEventListener('click', () => api.openExternal(headline.url));
        list.appendChild(div);
      });
    };
    lists.forEach(fill);
  } catch (e) {
    lists.forEach((list) => { list.innerHTML = '<div class="empty">Could not reach the feed (offline).</div>'; });
  }
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
function applyAvatarGender(gender) {
  const g = gender === 'male' ? 'male' : 'female';
  profile.avatarGender = g;
  if (window.gemAvatar) window.gemAvatar.setGender(g);
  if (window.ttsEngine) window.ttsEngine.gender = profile.voiceGender || g;
  const label = $('#avatarGenderLabel');
  if (label) label.textContent = g === 'male' ? '♂ MALE' : '♀ FEMALE';
  const sel = $('#setAvatarGender');
  if (sel) sel.value = g;
  const vSel = $('#setVoiceGender');
  if (vSel) vSel.value = profile.voiceGender || g;
}

function syncVoicePresetUi(presetId) {
  const id = VOICE_PRESETS[presetId] ? presetId : 'gem';
  $$('.voice-preset').forEach((button) => button.classList.toggle('active', button.dataset.voicePreset === id));
}

function updateSttLanguageUi() {
  const language = profile.voice?.sttLang || DEFAULTS.sttLang;
  const chip = $('#sttLangChip'); if (chip) chip.textContent = '🎙 ' + language.toUpperCase();
  if (recognition) recognition.lang = language;
  if (wakeRecognition) wakeRecognition.lang = language;
}

// ---------------------------------------------------------------------------
// T4 — Cinematic first-run onboarding (Stonic v1.0.55 parity):
// welcome → name → live HUD theme → voice, over an ambient score.
// Pure renderer-side; falls back to the classic chat ask if anything fails.
// ---------------------------------------------------------------------------
const ONBOARD_STEPS = ['welcome', 'name', 'voice'];
let onboard = null;

function safeLaunchOnboarding() {
  try { launchOnboarding(); return !!$('#onboardOverlay'); } catch (e) { return false; }
}

function setupOnboarding() {
  const overlay = $('#onboardOverlay');
  if (!overlay || overlay.dataset.wired) return;
  overlay.dataset.wired = '1';
  $('#onboardNext')?.addEventListener('click', () => onboardingAdvance());
  $('#onboardBack')?.addEventListener('click', () => onboardingAdvance(-1));
  $('#onboardSkip')?.addEventListener('click', () => onboardingFinish(true));
  $('#onboardName')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onboardingAdvance(); } });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') onboardingFinish(true); });
  $$('.onboard-voice').forEach((b) => b.addEventListener('click', () => {
    playSfx('click');
    const g = b.dataset.gender === 'male' ? 'male' : 'female';
    profile.voiceGender = g;
    profile.avatarGender = g;
    if (window.ttsEngine) window.ttsEngine.gender = g;
    $$('.onboard-voice').forEach((x) => x.classList.toggle('active', x === b));
    try { speak(g === 'male' ? 'Male voice online. I am Gem.' : 'Female voice online. I am Gem.'); } catch (e) {}
  }));
  $('#replayOnboardBtn')?.addEventListener('click', () => { playSfx('click'); launchOnboarding(); });
}

function launchOnboarding() {
  const overlay = $('#onboardOverlay');
  if (!overlay || onboard) return;
  setupOnboarding();
  onboard = { step: 0, prevAmbient: !!profile.ambientScore };
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('open'));
  onboardingPaint();
  // Ambient score during first run only — restore the user's preference after.
  try { setAmbientScore(true, profile.ambientTrack || DEFAULTS.ambientTrack); } catch (e) {}
  setTimeout(() => $('#onboardName')?.focus?.(), 350);
}

function onboardingPaint() {
  if (!onboard) return;
  $$('.onboard-step').forEach((s) => s.classList.toggle('active', s.dataset.ostep === ONBOARD_STEPS[onboard.step]));
  const dots = $('#onboardDots');
  if (dots) dots.innerHTML = ONBOARD_STEPS.map((s, i) => '<i class="' + (i <= onboard.step ? 'on' : '') + '"></i>').join('');
  const back = $('#onboardBack');
  if (back) back.style.visibility = onboard.step === 0 ? 'hidden' : 'visible';
  const next = $('#onboardNext');
  if (next) next.textContent = onboard.step === ONBOARD_STEPS.length - 1 ? 'ENTER THE HUD »' : onboard.step === 0 ? 'BEGIN »' : 'CONTINUE »';
}

function onboardingAdvance(dir) {
  if (!onboard) return;
  playSfx('click');
  if (dir < 0 && onboard.step > 0) { onboard.step--; onboardingPaint(); return; }
  if (ONBOARD_STEPS[onboard.step] === 'name') {
    const v = ($('#onboardName')?.value || '').trim();
    if (v) profile.name = v.slice(0, 24);
  }
  if (onboard.step < ONBOARD_STEPS.length - 1) {
    onboard.step++;
    onboardingPaint();
    if (ONBOARD_STEPS[onboard.step] === 'name') $('#onboardName')?.focus?.();
  } else onboardingFinish(false);
}

async function onboardingFinish(skipped) {
  const overlay = $('#onboardOverlay');
  if (!overlay || !onboard) return;
  if (!skipped && ONBOARD_STEPS[onboard.step] === 'name') {
    const v = ($('#onboardName')?.value || '').trim();
    if (v) profile.name = v.slice(0, 24);
  }
  profile.onboarded = true;
  const prevAmbient = onboard.prevAmbient;
  onboard = null;
  overlay.classList.remove('open');
  setTimeout(() => { overlay.hidden = true; }, 280);
  try { setAmbientScore(prevAmbient, profile.ambientTrack || DEFAULTS.ambientTrack); } catch (e) {}
  await persistProfile();
  try {
    await api.memoryAddFact({ text: `The user's name is ${profile.name}`, category: 'identity' });
    await loadMemory(); renderAllMemory(); renderBriefing();
  } catch (e) {}
  const hi = `Welcome to the HUD, ${profile.name}. Everything is yours — try "open Agent Town", "show World Monitor", or just talk to me.`;
  addMessage('ai', hi);
  try { await api.memoryAppend('assistant', hi); } catch (e) {}
  try { speak(hi); } catch (e) {}
  try { updateNowCard(); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Dynamic HUD navigation (Stonic v1.0.33): Gem can drive the interface itself,
// typed or spoken, in EVERY runtime (Electron, web, offline).
// ---------------------------------------------------------------------------
const NAV_VERB_RE = /\b(?:open|show(?:\s*me)?|go(?:\s*to)?|switch(?:\s*to)?|jump(?:\s*to)?|take\s*(?:me\s*)?to|view|display|navigate(?:\s*to)?)\b/i;
const VIEW_NAVS = [
  { re: /\bagent\s*town\b|\btown hall\b/i, view: 'town', label: 'Agent Town' },
  { re: /\bworld(?:\s*monitor)?\b|\bglobe\b|\bcommand map\b/i, view: 'world', label: 'World Monitor' },
  { re: /\bsystem(?:\s*core)?\b|\bprocesses\b|\btask\s*manager\b/i, view: 'core', label: 'System Core' },
  { re: /\bcompanion\b/i, view: 'companion', label: 'Companion' },
  { re: /\bdashboard\b|\bhome(?:\s*(?:view|screen))?\b|\bmain\s*(?:view|screen)\b|\bassistant\b/i, view: 'assistant', label: 'Assistant' }
];

function matchViewNavigation(text) {
  const t = String(text || '');
  if (!NAV_VERB_RE.test(t)) return null;
  for (const n of VIEW_NAVS) if (n.re.test(t)) return n;
  if (/\bsettings?(?:\s*panel)?\b|\bpreferences\b/i.test(t)) return { modal: 'settings', label: 'Settings' };
  if (/\bthemes?\b|\brecolou?r\b/i.test(t)) return { modal: 'theme', label: 'Theme picker' };
  return null;
}

// ---------------------------------------------------------------------------
// STONIC-PITCH PARITY — local natural commands. Typed or SPOKEN phrases map to
// REAL desktop actions through the existing bridge, processed locally, zero AI
// keys. Precision-first: only whitelisted app names / clear patterns match;
// everything else falls through to the AI brains (which still have all 79 tools
// with HITL confirms — including WhatsApp + file operations).
// ---------------------------------------------------------------------------
const APP_ALIASES = {
  chrome: 'chrome', 'google chrome': 'chrome', edge: 'msedge', firefox: 'firefox',
  spotify: 'spotify', vscode: 'code', 'vs code': 'code', code: 'code',
  notepad: 'notepad', calculator: 'calculator', calc: 'calculator',
  terminal: 'windowsterminal', cmd: 'cmd', powershell: 'powershell',
  explorer: 'explorer', 'file explorer': 'explorer', files: 'explorer',
  premiere: 'premiere', photoshop: 'photoshop', word: 'winword', excel: 'excel',
  powerpoint: 'powerpnt', steam: 'steam', discord: 'discord', whatsapp: 'whatsapp',
  telegram: 'telegram', slack: 'slack', zoom: 'zoom', paint: 'mspaint'
};
const SITE_MAP = {
  youtube: 'https://youtube.com', google: 'https://google.com', github: 'https://github.com',
  gmail: 'https://mail.google.com', reddit: 'https://reddit.com', netflix: 'https://netflix.com',
  chatgpt: 'https://chatgpt.com', twitter: 'https://x.com', x: 'https://x.com',
  whatsapp: 'https://web.whatsapp.com', maps: 'https://maps.google.com',
  drive: 'https://drive.google.com', instagram: 'https://instagram.com',
  linkedin: 'https://linkedin.com', stackoverflow: 'https://stackoverflow.com'
};
const NAV_SITE_RE = new RegExp('\\b(open|go to|visit)\\s+((?:' + Object.keys(SITE_MAP).join('|') + ')\\s*(?:\\.com)?\\b)', 'i');
const SEARCH_SITE_RE = /\b(search|look up|find)\s+(.+?)\s+(?:on|in)\s+(youtube|google)\b|\b(youtube|google)\s+(?:search(?: for)?)?\s*(.+)/i;
const LAUNCH_RE = /^\s*(?:open|launch|start|run)\s+(?:the\s+)?([a-z0-9 .+#-]{2,24})\s*$/i;
const FOCUS_RE = /\b(?:switch to|bring(?: up)?|focus|jump to)\s+(?:the\s+)?([a-z0-9 .+#-]{2,24})\b/i;

function matchLocalAction(raw) {
  const t = String(raw || '').toLowerCase().trim().replace(/[!.?]+$/, '');
  if (!t || !window.gemair) return null;
  let m;

  if ((m = t.match(/\b(?:set\s+)?volume\s+(?:to\s+)?(\d{1,3})\s*(?:%|percent)?\b/)))
    return { kind: 'volume', args: { action: 'set', level: Math.min(100, Number(m[1])) }, say: 'Volume set to ' + Math.min(100, Number(m[1])) + ' percent.' };
  if (/\bvolume\s+up\b|\bturn\s+(?:the\s+)?volume\s+up\b|\blouder\b/.test(t))
    return { kind: 'volume', args: { action: 'up' }, say: 'Volume up.' };
  if (/\bvolume\s+down\b|\bturn\s+(?:the\s+)?volume\s+down\b|\bquieter\b/.test(t))
    return { kind: 'volume', args: { action: 'down' }, say: 'Volume down.' };
  if (/\bunmute\b/.test(t)) return { kind: 'volume', args: { action: 'unmute' }, say: 'Unmuted.' };
  if (/\bmute\b/.test(t)) return { kind: 'volume', args: { action: 'mute' }, say: 'Muted.' };

  if (/\bbattery\b/.test(t)) return { kind: 'battery' };
  if (/\b(ram|memory usage|how much memory)\b/.test(t)) return { kind: 'ram' };
  if (/\b(storage|disk space|disk)\b/.test(t)) return { kind: 'disk' };
  if (/\b(system status|system health|pc status|computer status|how.s my (pc|computer))\b/.test(t))
    return { kind: 'sysinfo' };

  if ((m = t.match(NAV_SITE_RE))) {
    const site = m[2].replace(/\.com\s*$/, '').trim();
    return { kind: 'site', url: SITE_MAP[site], say: 'Opening ' + site + '.' };
  }
  if ((m = t.match(SEARCH_SITE_RE))) {
    const engine = (m[3] || m[4] || '').toLowerCase();
    const q = (m[2] || m[5] || '').trim();
    if (engine && q && SITE_MAP[engine]) {
      const url = engine === 'youtube'
        ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)
        : 'https://www.google.com/search?q=' + encodeURIComponent(q);
      return { kind: 'site', url, say: 'Searching ' + engine + ' for ' + q + '.' };
    }
  }

  if (/\b(close|minimize|hide)\s+(all|everything)\b.*\bwindows?\b|\bshow (?:the )?desktop\b/.test(t))
    return { kind: 'minimizeAll', say: 'All windows minimized.' };
  if (/\bnext\s+(?:virtual\s+)?desktop\b|\bswitch\s+desktop\b/.test(t))
    return { kind: 'nextDesktop', say: 'Next virtual desktop.' };
  if (/\bsnap\s+(?:this\s+)?window\s+(left|right)\b|\b(?:move|put)\s+(?:this\s+)?window\s+(?:to\s+the\s+)?(left|right)\b/.test(t)) {
    const dir = /\bleft\b/.test(t) ? 'left' : 'right';
    return { kind: 'snap', dir, say: 'Window snapped ' + dir + '.' };
  }
  if (/\bmaximi[sz]e\s+(?:this\s+)?window\b|\bfullscreen\b/.test(t))
    return { kind: 'snap', dir: 'max', say: 'Window maximized.' };

  if ((m = t.match(LAUNCH_RE))) {
    const name = m[1].trim().toLowerCase();
    const app = APP_ALIASES[name];
    if (app) return { kind: 'launch', app, label: name, say: 'Launching ' + name + '.' };
  }
  if ((m = t.match(FOCUS_RE))) {
    const name = m[1].trim().toLowerCase();
    const app = APP_ALIASES[name];
    if (app) return { kind: 'focus', app, label: name, say: 'Switching to ' + name + '.' };
  }

  if ((m = t.match(/^\s*(?:note|note that|make a note[:,]?|take a note[:,]?)\s*(?:that\s+)?(.{3,240})$/i)))
    return { kind: 'note', text: m[1].trim(), say: 'Noted.' };
  if ((m = t.match(/^\s*remind me to\s+(.{3,200}?)\s+(?:in\s+(\d{1,3})\s*(minute|min|hour|hr)s?|tomorrow(?: morning)?)\s*$/i))) {
    const ms = m[2] ? Number(m[2]) * (/hour|hr/.test(m[3]) ? 3600000 : 60000) : 12 * 3600000;
    return { kind: 'remind', text: 'Reminder: ' + m[1].trim(), at: Date.now() + ms, say: 'Reminder set.' };
  }
  if ((m = t.match(/^\s*(?:add|create)\s+(?:a\s+)?(?:task|todo|to-do)[:,]?\s*(.{3,200})$/i)))
    return { kind: 'todo', text: m[1].trim(), say: 'Task added.' };

  if (/\b(what.s running|list (?:open )?windows|open windows|running apps)\b/.test(t))
    return { kind: 'listWindows' };

  return null;
}

async function runLocalAction(act) {
  try {
    switch (act.kind) {
      case 'volume': {
        const r = await api.desktopSetVolume(act.args);
        return r && r.error ? 'Volume control failed: ' + r.error : act.say;
      }
      case 'battery': {
        const info = await api.getSystemInfo();
        const b = info && info.battery;
        if (!b) return 'Battery telemetry is unavailable in this environment.';
        return 'Battery at ' + Math.round(b.percent) + ' percent' + (b.charging ? ' and charging.' : '.');
      }
      case 'ram': {
        const info = await api.getSystemInfo();
        if (!info || !info.memTotal) return 'I could not read memory usage.';
        const usedGB = (info.memUsed / 1e9).toFixed(1), totalGB = (info.memTotal / 1e9).toFixed(1);
        return 'RAM: ' + usedGB + ' of ' + totalGB + ' GB in use (' + info.memPercent + ' percent).';
      }
      case 'disk': {
        const info = await api.getSystemInfo();
        const d = info && info.disk;
        if (!d) return 'I could not read disk usage.';
        return 'Disk: ' + d.freeGB + ' GB free of ' + d.totalGB + ' GB (' + d.percent + ' percent used).';
      }
      case 'sysinfo': {
        const info = await api.getSystemInfo();
        if (!info || info.available === false) return 'System telemetry is unavailable in the browser. Open the desktop app for real CPU, memory and disk readings.';
        const b = info.battery ? ' Battery ' + Math.round(info.battery.percent) + '%' + (info.battery.charging ? ' (charging)' : '') + '.' : '';
        const d = info.disk ? ' Disk ' + info.disk.freeGB + '/' + info.disk.totalGB + ' GB free.' : '';
        const up = Math.floor((info.uptime || 0) / 3600);
        return 'All systems nominal. CPU load ' + Math.round((info.cpuLoad || 0)) + '%, RAM ' + info.memPercent + '%.' + d + b + ' Uptime ' + up + 'h.';
      }
      case 'site': {
        const r = await api.desktopOpenSite(act.url);
        if (r && r.error) return 'Could not open the browser: ' + r.error;
        return act.say;
      }
      case 'minimizeAll': { await api.desktopMinimizeAll(); return act.say; }
      case 'nextDesktop': { await api.desktopNextDesktop(); return act.say; }
      case 'snap': { const r = await api.desktopSnapWindow(act.dir); return r && r.error ? 'Snap failed: ' + r.error : act.say; }
      case 'launch': {
        const r = await api.desktopLaunchApp(act.app);
        return r && r.error ? 'Could not launch ' + act.label + ': ' + r.error : act.say;
      }
      case 'focus': {
        const r = await api.desktopFocusApp(act.app);
        return r && r.error ? act.label + ' is not running — say "open ' + act.label + '" to launch it.' : act.say;
      }
      case 'note': {
        await api.memoryAddNote(act.text);
        try { renderAllMemory(); } catch (e) {}
        return act.say + ' "' + act.text.slice(0, 60) + (act.text.length > 60 ? '…' : '') + '"';
      }
      case 'remind': {
        await api.memoryAddReminder(act.text, new Date(act.at).toISOString());
        try { renderAllMemory(); } catch (e) {}
        return act.say;
      }
      case 'todo': {
        await api.memoryAddTodo(act.text);
        try { renderAllMemory(); } catch (e) {}
        return act.say + ' "' + act.text.slice(0, 60) + '"';
      }
      case 'listWindows': {
        const r = await api.desktopListWindows();
        const wins = (r && r.windows) || r || [];
        if (!Array.isArray(wins) || !wins.length) return 'No windows detected right now.';
        return wins.slice(0, 8).map((w) => '• ' + (w.title || w.name || 'window')).join('\n');
      }
      default: return null;
    }
  } catch (e) { return 'That action failed: ' + (e && e.message ? e.message : e); }
}

function applyVoicePresetToControls(presetId) {
  const preset = VOICE_PRESETS[presetId] || VOICE_PRESETS.gem;
  $('#setVoiceGender').value = preset.gender;
  $('#setRate').value = preset.rate; $('#rateVal').textContent = preset.rate.toFixed(2);
  $('#setPitch').value = preset.pitch; $('#pitchVal').textContent = preset.pitch.toFixed(2);
  $('#setNeuralVoice').value = preset.neuralVoice;
  const ev = $('#setEdgeVoice');
  if (ev) ev.value = preset.edgeVoice || 'en-US-AriaNeural';
  syncVoicePresetUi(presetId);
}

// Section I — FREE FOREVER audit. Every feature maps to a free, keyless service.
const COST_AUDIT = [
  ['AI Core', 'Vercel serverless · FREE CORE', '$0'],
  ['Text-to-Speech', 'Microsoft Edge neural voices', '$0'],
  ['Speech-to-Text', 'Web Speech API', '$0'],
  ['Images', 'pollinations.ai', '$0'],
  ['Web Search', 'DuckDuckGo Lite + Wikipedia', '$0'],
  ['Weather', 'Open-Meteo', '$0'],
  ['News', 'Google News RSS', '$0'],
  ['Crypto', 'CoinGecko', '$0'],
  ['Currency', 'Frankfurter (free FX)', '$0'],
  ['Translation', 'MyMemory', '$0'],
  ['Dictionary', 'Free Dictionary API', '$0'],
  ['Page Fetch', 'serverless fetch', '$0']
];
function renderCostPanel() {
  const grid = $('#costGrid');
  if (!grid) return;
  grid.innerHTML = COST_AUDIT.map(([feature, service]) =>
    `<div class="cost-row"><span class="c-feature">${escapeHtml(feature)}</span><span class="c-service">${escapeHtml(service)}</span><span class="c-price">$0.00</span></div>`
  ).join('');
}

const UPDATE_CHECK_KEY = 'gemair:last-update-check';
function trustedReleasePage(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/rangwalaaliasgar55-bot/GemAir/releases/') ? url.toString() : null;
  } catch { return null; }
}
async function checkForAppUpdates({ force = false, silent = false } = {}) {
  const status = $('#updateStatus');
  const checkButton = $('#checkUpdatesBtn');
  const viewButton = $('#viewUpdateBtn');
  if (!window.gemair || !window.gemair.checkForUpdates) {
    if (status) status.textContent = 'Update checks are available in the desktop app.';
    return { ok: false, error: 'DESKTOP_ONLY' };
  }
  if (status) status.textContent = 'Checking GitHub…';
  if (checkButton) checkButton.disabled = true;
  try {
    const result = await api.checkForUpdates(force);
    if (!result || !result.ok) {
      if (status) status.textContent = result && result.error === 'UPDATE_CHECK_TIMEOUT' ? 'Check timed out. Try again later.' : 'Could not check for updates.';
      if (!silent) toast('UPDATE CHECK', 'GitHub release information is unavailable right now.', '⚠');
      return result || { ok: false, error: 'UPDATE_CHECK_FAILED' };
    }
    const releaseUrl = trustedReleasePage(result.url);
    if (result.available && !releaseUrl) {
      if (status) status.textContent = 'Release metadata failed verification.';
      return { ok: false, error: 'INVALID_RELEASE_URL' };
    }
    if (result.available) {
      if (status) status.textContent = `GemAir ${result.latest} is available (installed: ${result.current}).`;
      if (viewButton) { viewButton.hidden = false; viewButton.dataset.url = releaseUrl; }
      toast('UPDATE AVAILABLE', `GemAir ${result.latest} is ready on GitHub.`, '⬆');
    } else {
      if (status) status.textContent = `GemAir ${result.current} is up to date.`;
      if (viewButton) { viewButton.hidden = true; delete viewButton.dataset.url; }
      if (!silent) toast('UP TO DATE', `GemAir ${result.current} is the latest stable release.`, '✓');
    }
    return result;
  } finally {
    if (checkButton) checkButton.disabled = false;
  }
}
function maybeCheckForUpdates() {
  if (!window.gemair || profile.autoUpdateChecks === false) return;
  let last = 0;
  try { last = Number(localStorage.getItem(UPDATE_CHECK_KEY)) || 0; } catch {}
  if (Date.now() - last < 24 * 60 * 60 * 1000) return;
  try { localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now())); } catch {}
  setTimeout(() => checkForAppUpdates({ silent: true }).catch(() => {}), 2500);
}

let lastUsageStats = null;
async function renderUsageStats() {
  const summary = $('#usageStatsSummary');
  if (!summary) return null;
  if (!window.gemair || !window.gemair.usageGet) { summary.textContent = 'Desktop app only.'; return null; }
  try {
    const stats = await api.usageGet();
    lastUsageStats = stats;
    if (stats.disabled) { summary.textContent = 'Disabled.'; return stats; }
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = stats.days && stats.days[today] ? Number(stats.days[today].count) || 0 : 0;
    const actionCount = stats.actions ? Object.keys(stats.actions).length : 0;
    summary.textContent = `${Number(stats.total) || 0} events · ${todayCount} today · ${actionCount} action types`;
    return stats;
  } catch {
    summary.textContent = 'Statistics unavailable.';
    return null;
  }
}
async function exportUsageStats() {
  const stats = await renderUsageStats();
  if (!stats || stats.disabled) { toast('USAGE STATS', 'Enable local statistics and save Settings first.', 'ℹ'); return; }
  downloadText(JSON.stringify(stats, null, 2), `gemair-usage-${new Date().toISOString().slice(0, 10)}.json`);
  toast('USAGE STATS', 'Local aggregate counters exported.', '⇩');
}
async function clearLocalUsageStats() {
  if (!window.confirm('Clear all local usage counters? This cannot be undone.')) return;
  await api.usageClear();
  lastUsageStats = null;
  await renderUsageStats();
  toast('USAGE STATS', 'Local counters cleared.', '✓');
}

function openSettings() {
  $('#setUserName').value = profile.name || '';
  $('#setBaseURL').value = (profile.ai?.baseURL) || '';
  $('#setApiKey').value = (profile.ai?.apiKey) || '';
  $('#setModel').value = (profile.ai?.model) || 'llama-3.3-70b-versatile';
  if ($('#setAvatarGender')) $('#setAvatarGender').value = profile.avatarGender || 'female';
  if ($('#setVoiceGender')) $('#setVoiceGender').value = profile.voiceGender || profile.avatarGender || 'female';
  $('#setRate').value = profile.voice?.rate ?? 1.0;
  $('#setPitch').value = profile.voice?.pitch ?? 1.1;
  $('#rateVal').textContent = $('#setRate').value;
  $('#pitchVal').textContent = $('#setPitch').value;
  $('#setVoiceMode').value = profile.voice?.mode || DEFAULTS.voiceMode;
  $('#setNeuralVoice').value = profile.voice?.neuralVoice || 'en';
  $('#setSttLang').value = profile.voice?.sttLang || DEFAULTS.sttLang;
  $('#setMemoryOn').checked = profile.memoryOn !== false;
  $('#setContextStrategy').value = CONTEXT_STRATEGIES[profile.contextStrategy] ? profile.contextStrategy : DEFAULTS.contextStrategy;
  $('#setAllowShell').checked = !!profile.allowShell;
  $('#setAutoUpdateChecks').checked = profile.autoUpdateChecks !== false;
  $('#setUsageStats').checked = profile.usageStats === true;
  $('#setAmbientScore').checked = !!profile.ambientScore;
  // T5 — ambient track + volume
  const trackSel = $('#setAmbientTrack');
  if (trackSel) trackSel.value = profile.ambientTrack || DEFAULTS.ambientTrack;
  const volSlider = $('#setAmbientVolume');
  if (volSlider) {
    volSlider.value = String(ambientVolume());
    const label = $('#ambientVolVal');
    if (label) label.textContent = Math.round(ambientVolume() * 100) + '%';
  }
  // S8 — local brain toggle reflects the engine's real state
  const localBrain = $('#setLocalBrain');
  if (localBrain) localBrain.checked = !!(window.aiClient && window.aiClient.isLocalReady());
  $('#setScreenAwareness').checked = !!profile.screenAwareness;
  // 2.5 Desktop Agent (computer control)
  const setComputerUse = $('#setComputerUse');
  if (setComputerUse) setComputerUse.checked = !!profile.allowComputerUse;
  const setComputerUseAuto = $('#setComputerUseAuto');
  if (setComputerUseAuto) setComputerUseAuto.checked = profile.computerUseAuto === true;
  const setComputerUseSteps = $('#setComputerUseSteps');
  if (setComputerUseSteps) setComputerUseSteps.value = String(Math.max(1, Math.min(20, Number(profile.computerUseMaxSteps) || 8)));
  // 2.5 Coding Agent
  const setCodingAgent = $('#setCodingAgent');
  if (setCodingAgent) setCodingAgent.checked = !!profile.allowCodingAgent;
  const setCodingAgentAuto = $('#setCodingAgentAuto');
  if (setCodingAgentAuto) setCodingAgentAuto.checked = profile.codingAgentAuto === true;
  const setCodingAgentSteps = $('#setCodingAgentSteps');
  if (setCodingAgentSteps) setCodingAgentSteps.value = String(Math.max(1, Math.min(20, Number(profile.codingAgentMaxSteps) || 10)));
  applyAppearance(profile.appearance || DEFAULTS.appearance);
  $('#setWakeWord').checked = !!profile.wakeWord;
  $('#setWakeWordText').value = profile.wakeWordText || 'Hey Gem';
  populateVoices(); populateNeuralVoices(); populateEdgeVoices(); updateAiHint();
  syncVoicePresetUi(profile.voice?.preset || 'gem');
  renderCostPanel();
  renderUsageStats();
  // 5.x — AI provider catalog: free-model picker + local Ollama list + model select
  renderFreeModelsList();
  renderModelSelect();
  refreshOllamaModels();
  $('#settingsModal').classList.add('open');
}
function closeSettings() { $('#settingsModal').classList.remove('open'); }

// ---------------------------------------------------------------------------
// 2.5 Desktop Agent — Computer Use (keyless)
// ---------------------------------------------------------------------------
function openAgentModal() {
  const modal = $('#agentModal');
  if (!modal) return;
  modal.classList.add('open');
  if (profile.allowComputerUse) {
    agentSetStatusLine('Desktop Agent is ON. Describe a task and hit RUN.', 'ok');
  } else {
    agentSetStatusLine('Desktop Agent is OFF — enable it in Settings (DESKTOP & MODES). I can still capture the screen.', 'warn');
  }
  refreshAgentBrainChip();
}
function closeAgentModal() { $('#agentModal').classList.remove('open'); }
function logAgentLine(cls, text) {
  const log = $('#agentLog');
  if (!log) return;
  const div = log.querySelector('.empty, .agent-entry:last-child');
  const entry = document.createElement('div');
  entry.className = 'agent-entry ' + (cls || '');
  entry.textContent = text;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}
function agentSetStatusLine(text, kind) {
  const line = $('#agentStatusLine');
  if (!line) return;
  line.innerHTML = `<div class="empty" style="color:var(--text-${kind === 'ok' ? 'ok' : 'warn'},inherit)">${escapeHtml(text)}</div>`;
}
async function refreshAgentBrainChip() {
  const chip = $('#agentBrainChip');
  if (!chip) return;
  const cfg = profile.ai || {};
  if (cfg.apiKey && cfg.baseURL) chip.textContent = 'User key (' + (cfg.model || 'model') + ')';
  else if (cfg.baseURL && /localhost|127\.0\.0\.1/.test(cfg.baseURL)) chip.textContent = 'Local (Ollama) — keyless';
  else chip.textContent = 'Auto: local Ollama → free';
  chip.classList.add('fallback');
}
let agentRunning = false;
function setAgentRunning(running) {
  agentRunning = running;
  const runBtn = $('#agentRunBtn');
  const stopBtn = $('#agentStopBtn');
  if (runBtn) runBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
}
async function runDesktopAgent() {
  const task = ($('#agentTaskInput')?.value || '').trim();
  if (!task) { logAgentLine('warn', '→ Enter a task first.'); $('#agentTaskInput')?.focus(); return; }
  const auto = $('#agentAutoApprove')?.checked;
  // Persist the auto-approve preference immediately (await so the main process reads it).
  if (auto) profile.computerUseAuto = true; else profile.computerUseAuto = false;
  await persistProfile().catch(() => {});
  const status = await api.computerUseStatus().catch(() => ({ active: false }));
  if (status.active) { logAgentLine('warn', '→ A desktop agent run is already in progress.'); return; }
  logAgentLine('', '▶ TASK: ' + task);
  logAgentLine('', 'Agent starting…');
  setAgentRunning(true);
  try {
    const res = await api.computerUse(task, {});
    logAgentLine(res.ok ? 'ok' : 'warn', res.ok ? '✔ DONE: ' + (res.reply || 'completed the requested steps.') : '✖ ' + (res.error || 'Failed.'));
    if (res.steps && res.steps.length) {
      logAgentLine('', '— performed ' + res.steps.length + ' action(s):');
      res.steps.forEach((s) => logAgentLine('step', `  ${s.step + 1}. ${s.tool} ${JSON.stringify(s.args)} → ${JSON.stringify(s.result).slice(0, 220)}`));
    }
  } catch (e) {
    logAgentLine('warn', '✖ ' + (e && e.message ? e.message : String(e)));
  } finally {
    setAgentRunning(false);
  }
}

function openCodingAgentModal() {
  const modal = $('#codingAgentModal');
  if (!modal) return;
  modal.classList.add('open');
  if (profile.allowCodingAgent) {
    codingSetStatusLine('Coding Agent is ON. Pick a folder + task and hit RUN.', 'ok');
  } else {
    codingSetStatusLine('Coding Agent is OFF — enable it in Settings (DESKTOP & MODES).', 'warn');
  }
}
function closeCodingAgentModal() { $('#codingAgentModal').classList.remove('open'); }
function logCodingLine(cls, text) {
  const log = $('#codingLog');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = 'agent-entry ' + (cls || '');
  entry.textContent = text;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}
function codingSetStatusLine(text, kind) {
  const line = $('#codingAgentStatusLine');
  if (!line) return;
  const col = kind === 'ok' ? 'var(--good)' : 'var(--warn)';
  line.innerHTML = `<div class="empty" style="color:${col}">${escapeHtml(text)}</div>`;
}
let codingRunning = false;
function setCodingRunning(running) {
  codingRunning = running;
  const runBtn = $('#codingRunBtn');
  const stopBtn = $('#codingStopBtn');
  if (runBtn) runBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
}
async function runCodingAgent() {
  const task = ($('#codingTaskInput')?.value || '').trim();
  const dir = ($('#codingDirInput')?.value || '').trim() || '~';
  if (!task) { logCodingLine('warn', '→ Enter a task first.'); $('#codingTaskInput')?.focus(); return; }
  const auto = $('#codingAutoApprove')?.checked;
  if (auto) profile.codingAgentAuto = true; else profile.codingAgentAuto = false;
  await persistProfile().catch(() => {});
  const status = await api.codingUseStatus().catch(() => ({ active: false }));
  if (status.active) { logCodingLine('warn', '→ A coding agent run is already in progress.'); return; }
  logCodingLine('', '▶ PROJECT: ' + dir);
  logCodingLine('', '▶ TASK: ' + task);
  logCodingLine('', 'Coding Agent starting…');
  setCodingRunning(true);
  try {
    const res = await api.codingUse(task, dir, {});
    logCodingLine(res.ok ? 'ok' : 'warn', res.ok ? '✔ DONE: ' + (res.reply || 'completed the requested change.') : '✖ ' + (res.error || 'Failed.'));
    if (res.steps && res.steps.length) {
      logCodingLine('', '— performed ' + res.steps.length + ' action(s):');
      res.steps.forEach((s) => logCodingLine('step', `  ${s.step + 1}. ${s.tool} ${JSON.stringify(s.args).slice(0, 160)} → ${JSON.stringify(s.result).slice(0, 160)}`));
    }
  } catch (e) {
    logCodingLine('warn', '✖ ' + (e && e.message ? e.message : String(e)));
  } finally {
    setCodingRunning(false);
  }
}

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
// Section IIa/IId: the voice picker lists real Microsoft Edge neural voice names.
function populateEdgeVoices() {
  const sel = $('#setEdgeVoice');
  if (!sel) return;
  const list = (window.edgeTts && window.edgeTts.VOICES) || EDGE_VOICE_FALLBACK;
  sel.innerHTML = '';
  list.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = v.label + ' — ' + v.lang + ' · ' + v.gender;
    if ((profile.voice?.edgeVoice || 'en-US-AriaNeural') === v.name) opt.selected = true;
    sel.appendChild(opt);
  });
}
// Fallback list in case edge-tts.js didn't load (kept in sync with it).
// U1: edge-tts.js owns the voice catalogue. This is only a two-entry safety net
// for the case where edge-tts.js failed to load at all — it is NOT a second
// copy of the list to keep in sync.
const EDGE_VOICE_FALLBACK = [
  { name: 'en-US-AriaNeural', lang: 'en-US', gender: 'Female', label: 'Aria (US) · warm female' },
  { name: 'en-GB-RyanNeural', lang: 'en-GB', gender: 'Male', label: 'Ryan (UK) · male' }
];

function updateAiHint() {
  const base = $('#setBaseURL').value.trim(), key = $('#setApiKey').value.trim();
  const el = $('#aiStatusHint');
  const prov = detectProvider(base);
  if (key && base) el.textContent = '✓ ' + (PROVIDER_NAMES[prov] || 'Custom AI endpoint') + ' active — using your key only.';
  else if (base && /localhost|127\.0\.0\.1/.test(base)) el.textContent = '✓ Local model detected (no key needed).';
  else el.textContent = '✓ Live tools ready. General model answers require a configured provider or the optional local WebGPU model.';
}
function applyPreset(p) {
  // Provider presets — one click fills Base URL + Model. All of these speak
  // the OpenAI-compatible chat/completions protocol, so the SAME tool-calling
  // engine drives every provider (see AI-FRAMEWORK.md).
  const map = {
    groq: { baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
    claude: { baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
    cerebras: { baseURL: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
    sambanova: { baseURL: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.3-70B-Instruct' },
    nvidia: { baseURL: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct' },
    together: { baseURL: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
    fireworks: { baseURL: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
    xai: { baseURL: 'https://api.x.ai/v1', model: 'grok-3-mini' },
    zai: { baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-4-flash' },
    cohere: { baseURL: 'https://api.cohere.ai/v1', model: 'command-r-plus' },
    hf: { baseURL: 'https://router.huggingface.co/v1', model: 'meta-llama/Llama-3.3-70B-Instruct' },
    deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    hyperbolic: { baseURL: 'https://api.hyperbolic.xyz/v1', model: 'meta-llama/Llama-3.1-70B-Instruct' },
    deepinfra: { baseURL: 'https://api.deepinfra.com/v1/openai', model: 'meta-llama/Llama-3.3-70B-Instruct' },
    siliconflow: { baseURL: 'https://api.siliconflow.com/v1', model: 'Qwen/Qwen2.5-72B-Instruct' },
    novita: { baseURL: 'https://api.novita.ai/v3/openai', model: 'meta-llama/llama-3.3-70b-instruct' },
    mistral: { baseURL: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
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

function applyFreeModel(entry) {
  // One click from the FREE MODELS picker → fill the provider base URL + model.
  if (!entry) return;
  const p = window.GemAirProviders && window.GemAirProviders.byId(entry.provider);
  const provider = p || { name: entry.providerName };
  $('#setBaseURL').value = entry.baseURL;
  $('#setModel').value = entry.model;
  updateAiHint();
  toast('FREE MODEL', 'Loaded ' + provider.name + ' · ' + entry.model, '🧠');
  if (entry.keyUrl) {
    window.open(entry.keyUrl, '_blank');
  }
  return entry.model;
}

// Render the FREE MODELS picker (all free+no-card providers, with Use buttons).
function renderFreeModelsList() {
  const list = $('#freeModelsList');
  if (!list || !window.GemAirProviders) return;
  const rows = window.GemAirProviders.FREE_MODELS;
  if (!rows || !rows.length) { list.innerHTML = '<div class="empty">No free models found.</div>'; return; }
  list.innerHTML = rows.map((m) => `
    <div class="free-model-row" role="button" tabindex="0">
      <div class="fm-info">
        <span class="fm-provider">${escapeHtml(m.providerName)}</span>
        <span class="fm-model">${escapeHtml(m.model)}</span>
        <span class="fm-free">FREE</span>
      </div>
      <div class="fm-note">${escapeHtml(m.note || '')}</div>
      <button class="mini-btn fm-use" data-provider="${escapeHtml(m.provider)}" data-model="${escapeHtml(m.model)}">USE</button>
    </div>`).join('');
  list.querySelectorAll('.fm-use').forEach((btn) => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider;
      const model = btn.dataset.model;
      const entry = rows.find((r) => r.provider === provider && r.model === model);
      applyFreeModel(entry);
    });
  });
  list.querySelectorAll('.free-model-row').forEach((row) => {
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.querySelector('.fm-use')?.click(); } });
  });
}

// Populate the model dropdown for the currently selected provider base URL.
function renderModelSelect() {
  const sel = $('#setModelSelect');
  if (!sel) return;
  const base = $('#setBaseURL').value.trim();
  const prov = detectProvider(base);
  const p = window.GemAirProviders && window.GemAirProviders.byId(prov);
  if (!p) { sel.innerHTML = '<option value="">— custom model —</option>'; return; }
  sel.innerHTML = p.models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}${m.free ? ' · free' : ''}</option>`).join('');
  sel.value = $('#setModel').value;
}

async function refreshOllamaModels() {
  const box = $('#ollamaModels');
  if (!box) return;
  try {
    const list = await api.listLocalModels().catch(() => ({ models: [] }));
    const local = (list && list.models) || [];
    if (!local || !local.length) {
      box.innerHTML = '<div class="empty">No local model detected. Start Ollama (`ollama pull llama3`) for a fully keyless local brain.</div>';
      return;
    }
    box.innerHTML = '<span class="dim" style="font:600 9px var(--font-mono);">LOCAL (OLLAMA) MODELS</span>' + local.slice(0, 20).map((m) => `
      <div class="free-model-row" role="button" tabindex="0">
        <div class="fm-info"><span class="fm-provider">Ollama</span><span class="fm-model">${escapeHtml(m.name)}</span><span class="fm-free">LOCAL · FREE</span></div>
        <div class="fm-note">${escapeHtml(m.details || 'Runs entirely on your machine, no key, no vendor.')}</div>
        <button class="mini-btn fm-use" data-model="${escapeHtml(m.name)}">USE</button>
      </div>`).join('');
    box.querySelectorAll('.fm-use').forEach((btn) => btn.addEventListener('click', () => {
      $('#setBaseURL').value = 'http://localhost:11434/v1';
      $('#setModel').value = btn.dataset.model;
      $('#setApiKey').value = '';
      updateAiHint();
      toast('LOCAL MODEL', 'Using ' + btn.dataset.model + ' — keyless', '🪶');
    }));
  } catch (e) {
    box.innerHTML = '<div class="empty">Could not reach Ollama.</div>';
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function bindEvents() {
  if (_eventsBound) return;
  _eventsBound = true;
  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
/* theme-btn swatches removed — themes live in Settings */

  // HUD Themes picker in Settings (generated from the string theme table)
  renderThemeGrid();

  // Expert panel tabs (VOICE / AGENT / NOTES)
  $$('.expert-tab').forEach((t) => t.addEventListener('click', () => {
    playSfx('click');
    $$('.expert-tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.expert-pane').forEach((p) => p.classList.toggle('active', p.dataset.epane === t.dataset.etab));
    if (t.dataset.etab === 'voice') renderVoiceTab();
    if (t.dataset.etab === 'notes') renderNotesMini();
  }));

  // SETTING circuit card → open settings
  $('#settingCircuitRow')?.addEventListener('click', () => { playSfx('click'); openSettings(); });

  // Voice tab "tune in settings" + notes "open notebook"
  $('#voiceSettingsBtn')?.addEventListener('click', () => { playSfx('click'); openSettings(); });
  $('#openNotebookBtn')?.addEventListener('click', () => {
    switchView('core');
    const tab = $$('.core-tab').find((t) => t.dataset.tab === 'notes');
    if (tab) tab.click();
  });

/* sfxBtn removed — toggle lives in Settings */

  // Clear chat log
  const clearChatBtn = $('#clearChatBtn');
  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', () => {
      playSfx('click');
      $('#chatLog').innerHTML = '<div class="msg system-msg"><p>Chat history cleared. Systems standing by.</p></div>';
      chatHistory.splice(0, chatHistory.length);
      updateContextMeter();
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

  // Memory Category Filters & Search
  $('#factFilter')?.addEventListener('input', () => renderFacts());
  $('#memoryBrowserSearch').addEventListener('input', renderMemoryBrowser);
  $('#memoryBrowserType').addEventListener('change', renderMemoryBrowser);
  $('#auditToolFilter').addEventListener('input', renderAuditLog);
  $('#auditRefreshBtn').addEventListener('click', renderAuditLog);
  $$('#memoryCatFilters .qc').forEach((btn) => {
    btn.addEventListener('click', () => {
      playSfx('click');
      $$('#memoryCatFilters .qc').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderFacts();
    });
  });

  // Ambient sound generator for focus sessions
  $$('.ambient-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      playSfx('click');
      $$('.ambient-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      playAmbientSound(btn.dataset.sound);
      toast('FOCUS', `Ambient sound: ${btn.textContent}`, '🎵');
    });
  });

  // Multi-Agent Mission Dispatcher
  $('#dispatchTaskBtn')?.addEventListener('click', () => {
    const task = $('#dispatchTaskInput')?.value.trim();
    if (!task) return;
    playSfx('activate');
    const agent = $('#dispatchAgent')?.value || 'all';
    $('#dispatchTaskInput').value = '';

    if (agent === 'all') {
      addActivity('TEAM', `Multi-agent mission dispatched: "${task}"`);
      toast('AGENTS', 'Alice → Bob → Carol collaboration initiated', '👥');
      runCollaborationMission(task);
    } else {
      addActivity(agent, `Dispatched mission: "${task}"`);
      toast('AGENT', `${agent} assigned task`, '🚀');
      switchView('assistant');
      $('#chatInput').value = `@${agent} ${task}`;
      sendMessage($('#chatInput').value);
    }
  });

  // core tabs
  $$('.core-tab').forEach((t) => t.addEventListener('click', () => {
    playSfx('click');
    $$('.core-tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.core-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
    if (t.dataset.tab === 'audit') renderAuditLog();
    if (t.dataset.tab === 'browser') renderMemoryBrowser();
  }));

  // memory / notes / reminders add
  // T5 — ambient controls preview instantly, while the panel is open
  const ambientTrackSel = $('#setAmbientTrack');
  if (ambientTrackSel) ambientTrackSel.addEventListener('change', () => {
    profile.ambientTrack = ambientTrackSel.value;
    if ($('#setAmbientScore')?.checked) setAmbientScore(true, ambientTrackSel.value);
  });
  const ambientVol = $('#setAmbientVolume');
  if (ambientVol) ambientVol.addEventListener('input', () => {
    setAmbientVolume(ambientVol.value);
    const label = $('#ambientVolVal');
    if (label) label.textContent = Math.round(ambientVolume() * 100) + '%';
  });
  const ambientToggle = $('#setAmbientScore');
  if (ambientToggle) ambientToggle.addEventListener('change', () => {
    // instant audible preview on toggle, without waiting for SAVE
    setAmbientScore(ambientToggle.checked, $('#setAmbientTrack')?.value);
  });

  // S8 — opt into the in-browser WebGPU model
  const localBrainToggle = $('#setLocalBrain');
  if (localBrainToggle) localBrainToggle.addEventListener('change', async () => {
    const hint = $('#localBrainHint');
    if (!window.aiClient) return;
    if (!localBrainToggle.checked) {
      window.aiClient.disableLocalModel();
      if (hint) hint.textContent = 'Offline brain tier disabled.';
      return;
    }
    if (!(await window.aiClient.isWebGpuSupported())) {
      localBrainToggle.checked = false;
      if (hint) hint.textContent = 'This browser has no WebGPU adapter, so the in-browser model cannot run here.';
      toast('OFFLINE BRAIN', 'WebGPU is not available in this browser.', '⚠️');
      return;
    }
    if (hint) hint.textContent = 'Downloading model weights… this runs once and is cached by the browser.';
    const ok = await window.aiClient.enableLocalModel((pct, text) => {
      if (hint) hint.textContent = `Loading offline brain — ${pct}% ${text ? '· ' + text : ''}`;
    });
    localBrainToggle.checked = ok;
    if (hint) hint.textContent = ok
      ? `Local model READY (${window.aiClient.LOCAL_MODEL.id}) — factual/current questions still use live tools first.`
      : 'Could not load the local model. Live tools remain available; generic answers require a configured model.';
    toast('OFFLINE BRAIN', ok ? 'Local model ready' : 'Local model unavailable', ok ? '🧠' : '⚠️');
  });

  // S10 — the expert-panel ＋ finally does something
  const expertPlus = document.querySelector('.expert-plus');
  if (expertPlus) {
    expertPlus.setAttribute('role', 'button');
    expertPlus.setAttribute('tabindex', '0');
    expertPlus.setAttribute('aria-label', 'Add a quick command');
    expertPlus.setAttribute('title', 'Add a quick command');
    expertPlus.addEventListener('click', openQuickCommandEditor);
    expertPlus.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuickCommandEditor(); } });
  }
  renderQuickCommands();
  renderWorkflowGallery(); // S7

  // S4 — interface language picker (+ RTL switch)
  const langSel = $('#setLanguage');
  if (langSel && window.GemAirI18n) {
    const i18n = window.GemAirI18n;
    langSel.innerHTML = '';
    for (const l of i18n.LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = `${l.native} — ${l.label}${l.dir === 'rtl' ? ' (RTL)' : ''}`;
      if (l.id === i18n.locale) opt.selected = true;
      langSel.appendChild(opt);
    }
    langSel.addEventListener('change', () => {
      const next = i18n.setLocale(langSel.value);
      profile.lang = next;
      persistProfile();
      playSfx('click');
      toast('LANGUAGE', `Interface switched to ${(i18n.LANGUAGES.find((l) => l.id === next) || {}).native || next}`, '🌐');
    });
  }

  // S2 — process monitor controls
  const procFilter = $('#procFilter');
  if (procFilter) procFilter.addEventListener('input', () => paintProcessList());
  const refreshProcs = $('#refreshProcsBtn');
  if (refreshProcs) refreshProcs.addEventListener('click', () => { playSfx('click'); renderProcesses(true); });
  const processList = $('#processList');
  if (processList) processList.addEventListener('click', (e) => {
    const btn = e.target.closest('.proc-kill');
    if (!btn) return;
    killProcessFromUi(btn.dataset.pid, btn.dataset.name);
  });

  // S3 — Tasks panel
  const todoAdd = $('#todoAdd');
  if (todoAdd) todoAdd.addEventListener('click', addTodoFromUi);
  const todoInput = $('#todoInput');
  if (todoInput) todoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodoFromUi(); });
  const todoList = $('#todoList');
  if (todoList) todoList.addEventListener('click', async (e) => {
    const toggle = e.target.closest('.todo-toggle');
    if (toggle) { await api.memoryToggleTodo(toggle.dataset.id); await loadMemory(); renderTodos(); playSfx('click'); return; }
    const del = e.target.closest('.todo-del');
    if (del) { await api.memoryDeleteTodo(del.dataset.id); await loadMemory(); renderTodos(); playSfx('click'); }
  });

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
    renderWeeklySparklines();
  });
  $('#reportClose').addEventListener('click', () => $('#reportModal').classList.remove('open'));
  $('#reportClose2').addEventListener('click', () => $('#reportModal').classList.remove('open'));
  $('#reportCopy').addEventListener('click', () => {
    try { navigator.clipboard.writeText($('#reportContent').textContent); toast('REPORT', 'Copied to clipboard.', '📋'); } catch (e) {}
  });

  // Full profile + memory JSON backup and validated restore.
  $('#exportBtn').addEventListener('click', async () => {
    const data = await api.exportMemory();
    const backup = { schema: 'gemair-backup', schemaVersion: 2, appVersion: '2.1.0', exportedAt: new Date().toISOString(), profile: data.profile || profile, memory: data.memory || memory };
    downloadText(JSON.stringify(backup, null, 2), 'gemair-backup-' + new Date().toISOString().slice(0, 10) + '.json');
    toast('BACKUP', 'Full profile and memory exported as JSON.', '⬇');
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async () => {
    const file = $('#importFile').files && $('#importFile').files[0];
    if (!file) return;
    try {
      const raw = typeof file.text === 'function' ? await file.text() : await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(file);
      });
      const backup = JSON.parse(raw);
      if (!backup || typeof backup.profile !== 'object' || typeof backup.memory !== 'object') throw new Error('Not a GemAir profile + memory backup.');
      const arrayKeys = ['facts', 'transcript', 'notes', 'reminders', 'todos', 'mood', 'goals', 'skills', 'instructions', 'actionLog'];
      if (arrayKeys.some((key) => backup.memory[key] != null && !Array.isArray(backup.memory[key]))) throw new Error('Backup memory structure is invalid.');
      const result = await api.importMemory({ profile: backup.profile, memory: backup.memory });
      if (!result || result.ok === false) throw new Error(result && result.error || 'Import failed.');
      await loadProfile(); await loadMemory(); applyTheme(profile.theme || DEFAULTS.theme); applyAvatarGender(profile.avatarGender || 'female');
      renderAllMemory(); updateContextMeter(); updateSttLanguageUi(); configureWakeWord(!!profile.wakeWord); configureScreenAwareness(!!profile.screenAwareness);
      $('#importFile').value = '';
      toast('BACKUP RESTORED', 'Profile, memories, goals, voice and settings restored.', '✓');
      closeSettings();
    } catch (error) {
      $('#importFile').value = '';
      toast('IMPORT FAILED', error.message, '⚠');
    }
  });

  // Companion: career prompts
  $$('.prompt-chip').forEach((c) => c.addEventListener('click', () => {
    switchView('assistant');
    $('#chatInput').value = c.dataset.prompt;
    $('#chatInput').focus();
  }));

  // settings
  // download
/* downloadBtn removed — lives in Settings */
  $('#downloadClose').addEventListener('click', closeDownload);
  $('#downloadClose2').addEventListener('click', closeDownload);
  $('#settingsDownloadBtn')?.addEventListener('click', openDownload);
  $('#checkUpdatesBtn')?.addEventListener('click', () => checkForAppUpdates({ force: true }));
  $('#viewUpdateBtn')?.addEventListener('click', () => {
    const url = trustedReleasePage($('#viewUpdateBtn').dataset.url);
    if (url) api.openExternal(url);
  });
  $('#downloadModal').addEventListener('click', (e) => { if (e.target === $('#downloadModal')) closeDownload(); });
  // let the OS links open in the user's real browser when running in Electron
  $$('#dlGrid .dl-card').forEach((c) => c.addEventListener('click', (e) => {
    if (window.gemair) { e.preventDefault(); api.openExternal(c.href); }
  }));

  $('#avatarGenderToggle')?.addEventListener('click', () => {
    playSfx('click');
    const nextG = (profile.avatarGender === 'male') ? 'female' : 'male';
    // one-tap switcher: avatar AND spoken voice change together
    profile.voiceGender = nextG;
    applyAvatarGender(nextG);
    persistProfile();
    toast('VOICE & AVATAR', `Switched to ${nextG.toUpperCase()} — avatar and voice updated`, '🎙');
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target === $('#settingsModal')) closeSettings(); });
  // 2.5 Desktop Agent — computer use controls
  $('#openAgentBtn')?.addEventListener('click', () => { playSfx('swipe'); openAgentModal(); });
  $('#agentModalClose')?.addEventListener('click', closeAgentModal);
  $('#agentModal')?.addEventListener('click', (e) => { if (e.target === $('#agentModal')) closeAgentModal(); });
  $('#agentRunBtn')?.addEventListener('click', runDesktopAgent);
  $('#agentStopBtn')?.addEventListener('click', async () => { logAgentLine('warn', '⏹ STOP requested…'); await api.computerUseStop(); });
  const agentScreenCapture = async () => {
    const r = await api.computerUseScreen().catch(() => ({ error: 'desktop_only' }));
    if (r && r.ok) logAgentLine('ok', '🖼 Screen saved: ' + r.file + ' (' + r.width + '×' + r.height + ')');
    else logAgentLine('warn', '✖ ' + (r && r.error ? r.error : 'Capture unavailable in the browser.'));
  };
  $('#agentScreenBtn')?.addEventListener('click', agentScreenCapture);
  $('#agentScreenBtn2')?.addEventListener('click', agentScreenCapture);
  $('#agentTaskInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runDesktopAgent(); });
  // 2.5 Coding Agent — computer/code agent controls
  $('#openCodingAgentBtn')?.addEventListener('click', () => { playSfx('swipe'); openCodingAgentModal(); });
  $('#codingAgentModalClose')?.addEventListener('click', closeCodingAgentModal);
  $('#codingAgentModal')?.addEventListener('click', (e) => { if (e.target === $('#codingAgentModal')) closeCodingAgentModal(); });
  $('#codingRunBtn')?.addEventListener('click', runCodingAgent);
  $('#codingStopBtn')?.addEventListener('click', async () => { logCodingLine('warn', '⏹ STOP requested…'); await api.codingUseStop(); });
  $('#codingTaskInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runCodingAgent(); });
  $('#appearanceToggle').addEventListener('click', toggleAppearance);
  $('#refreshUsageBtn').addEventListener('click', renderUsageStats);
  $('#exportUsageBtn').addEventListener('click', exportUsageStats);
  $('#clearUsageBtn').addEventListener('click', clearLocalUsageStats);
  $('#saveBtn').addEventListener('click', () => {
    profile.name = $('#setUserName').value.trim() || 'Commander';
    profile.ai = { baseURL: $('#setBaseURL').value.trim(), apiKey: $('#setApiKey').value.trim(), model: $('#setModel').value.trim() || 'llama-3.3-70b-versatile' };
    profile.avatarGender = $('#setAvatarGender')?.value || 'female';
    profile.voiceGender = $('#setVoiceGender')?.value || profile.avatarGender || 'female';
    applyAvatarGender(profile.avatarGender);
    profile.voice = profile.voice || {};
    profile.voice.preset = $('#voicePresets .voice-preset.active')?.dataset.voicePreset || 'gem';
    profile.voice.rate = Number($('#setRate').value);
    profile.voice.pitch = Number($('#setPitch').value);
    profile.voice.mode = $('#setVoiceMode').value;
    profile.voice.neuralVoice = $('#setNeuralVoice').value;
    profile.voice.edgeVoice = $('#setEdgeVoice')?.value || profile.voice.edgeVoice || DEFAULTS.edgeVoice;
    profile.voice.name = $('#setVoice').value;
    profile.voice.sttLang = $('#setSttLang').value;
    profile.memoryOn = $('#setMemoryOn').checked;
    profile.contextStrategy = CONTEXT_STRATEGIES[$('#setContextStrategy').value] ? $('#setContextStrategy').value : DEFAULTS.contextStrategy;
    profile.allowShell = $('#setAllowShell').checked;
    profile.autoUpdateChecks = $('#setAutoUpdateChecks').checked;
    profile.usageStats = $('#setUsageStats').checked;
    profile.ambientScore = $('#setAmbientScore').checked;
    profile.ambientTrack = $('#setAmbientTrack')?.value || profile.ambientTrack || DEFAULTS.ambientTrack;
    profile.ambientVolume = Number($('#setAmbientVolume')?.value ?? ambientVolume());
    profile.screenAwareness = $('#setScreenAwareness').checked;
    // 2.5 Desktop Agent (computer control)
    const setComputerUse = $('#setComputerUse');
    const setComputerUseAuto = $('#setComputerUseAuto');
    const setComputerUseSteps = $('#setComputerUseSteps');
    if (setComputerUse) profile.allowComputerUse = setComputerUse.checked;
    if (setComputerUseAuto) profile.computerUseAuto = setComputerUseAuto.checked;
    if (setComputerUseSteps) profile.computerUseMaxSteps = Math.max(1, Math.min(20, Number(setComputerUseSteps.value) || 8));
    // 2.5 Coding Agent
    const setCodingAgent = $('#setCodingAgent');
    const setCodingAgentAuto = $('#setCodingAgentAuto');
    const setCodingAgentSteps = $('#setCodingAgentSteps');
    if (setCodingAgent) profile.allowCodingAgent = setCodingAgent.checked;
    if (setCodingAgentAuto) profile.codingAgentAuto = setCodingAgentAuto.checked;
    if (setCodingAgentSteps) profile.codingAgentMaxSteps = Math.max(1, Math.min(20, Number(setCodingAgentSteps.value) || 10));
    profile.wakeWord = $('#setWakeWord').checked;
    profile.wakeWordText = ($('#setWakeWordText').value || 'Hey Gem').trim().replace(/\s+/g, ' ').slice(0, 40) || 'Hey Gem';
    persistProfile().then(() => { updateLinkMode(); renderUsageStats(); closeSettings(); });
    setAmbientScore(profile.ambientScore);
    configureScreenAwareness(profile.screenAwareness);
    updateSttLanguageUi();
    updateContextMeter();
    configureWakeWord(profile.wakeWord);
  });
  $('#resetBtn').addEventListener('click', async () => {
    profile = makeDefaultProfile();
    setAmbientScore(false);
    await persistProfile(); applyAppearance(DEFAULTS.appearance); applyTheme(DEFAULTS.theme); updateLinkMode(); openSettings();
  });
  $$('.preset').forEach((b) => b.addEventListener('click', () => { applyPreset(b.dataset.preset); renderModelSelect(); }));
  $('#setBaseURL').addEventListener('input', () => { updateAiHint(); renderModelSelect(); });
  $('#setApiKey').addEventListener('input', updateAiHint);
  $('#setModel').addEventListener('input', () => { const s = $('#setModelSelect'); if (s) s.value = $('#setModel').value; });
  $('#setModelSelect')?.addEventListener('change', () => { const m = $('#setModelSelect').value; if (m) $('#setModel').value = m; });

  // Accessible quick-action toolbar. Arrow keys move within the toolbar;
  // Alt+1…4 invoke Search, Weather, Note, and Reminder from any view.
  const quickToolbar = $('#quickCommands');
  const quickButtons = quickToolbar ? Array.from(quickToolbar.querySelectorAll('.qc')) : [];
  function activateQuickButton(button) {
    if (!button) return;
    switchView('assistant');
    const agentTab = $('.expert-tab[data-etab="agent"]');
    if (agentTab && !agentTab.classList.contains('active')) agentTab.click();
    const input = $('#chatInput');
    input.value = button.dataset.cmd || '';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    quickButtons.forEach((candidate) => { candidate.tabIndex = candidate === button ? 0 : -1; });
    playSfx('click');
  }
  quickButtons.forEach((button, index) => {
    button.tabIndex = index === 0 ? 0 : -1;
    button.addEventListener('click', () => activateQuickButton(button));
  });
  quickToolbar?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, quickButtons.indexOf(document.activeElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? quickButtons.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + quickButtons.length) % quickButtons.length;
    quickButtons.forEach((button, index) => { button.tabIndex = index === next ? 0 : -1; });
    quickButtons[next]?.focus();
  });

  // test AI connection
  $('#testConn').addEventListener('click', async () => {
    const resEl = $('#testResult');
    resEl.className = 'test-result'; resEl.textContent = 'Testing…';
    const cfg = { baseURL: $('#setBaseURL').value.trim(), apiKey: $('#setApiKey').value.trim(), model: $('#setModel').value.trim() || DEFAULTS.model };
    try {
      // R8: strict — a supplied key that fails must NOT be masked by the free core.
      const res = await api.aiChatStrict(cfg, [{ role: 'user', content: 'Reply with exactly: OK' }]);
      if (res.ok && res.via === 'direct') { resEl.textContent = `✓ OK — ${res.provider || 'provider'} answered${res.model ? ' · ' + res.model : ''}`; resEl.classList.add('ok'); }
      else if (res.ok && res.via === 'free-core') { resEl.textContent = '✓ OK — live server model answered'; resEl.classList.add('ok'); }
      else { resEl.textContent = '✗ ' + humanError(res.error) + (res.via === 'direct' ? ' (your key/endpoint — the free core was NOT used)' : ''); resEl.classList.add('bad'); }
    } catch (e) { resEl.textContent = '✗ ' + e.message; resEl.classList.add('bad'); }
  });

  // Command palette — fuzzy search across every operational surface, with
  // keyboard selection and a durable recents section.
  const palette = $('#palette'), pInput = $('#paletteInput'), pResults = $('#paletteResults');
  const RECENTS_KEY = 'gemair:palette-recents';
  let paletteMatches = [], paletteSelected = 0;
  const readRecents = () => {
    try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]').slice(0, 6); } catch (e) { return []; }
  };
  const rememberPalette = (id) => {
    try {
      const next = [id, ...readRecents().filter((x) => x !== id)].slice(0, 6);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch (e) {}
  };
  const fuzzyScore = (query, value) => {
    const q = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const v = String(value || '').toLowerCase();
    if (!q) return 1;
    if (v === q) return 1000;
    const direct = v.indexOf(q);
    if (direct >= 0) return 800 - direct * 2 - (v.length - q.length) * 0.2;
    let qi = 0, score = 0, streak = 0, last = -2;
    for (let i = 0; i < v.length && qi < q.length; i++) {
      if (v[i] !== q[qi]) continue;
      streak = i === last + 1 ? streak + 1 : 1;
      score += 12 + streak * 5 + (i === 0 || /[\s/\-_]/.test(v[i - 1]) ? 14 : 0);
      last = i; qi++;
    }
    return qi === q.length ? score - (v.length - q.length) * 0.15 : -1;
  };
  // 2.4 palette connections + modes
  function getRecentMissionsForPalette() {
    try {
      const saved = localStorage.getItem('gemair:recent-missions');
      if (saved) return JSON.parse(saved);
    } catch {}
    return recentMissions || [];
  }

  const paletteItems = () => {
    const items = [
      { id: 'view-assistant', name: 'Voice Core', detail: 'assistant chat and orb', icon: '◉', type: 'VIEW', action: () => switchView('assistant') },
      { id: 'view-core', name: 'Desktop Manager', detail: 'memory, notes, system', icon: '⬢', type: 'VIEW', action: () => switchView('core') },
      { id: 'view-companion', name: 'Life Companion', detail: 'mood, goals, weekly report', icon: '♥', type: 'VIEW', action: () => switchView('companion') },
      { id: 'view-town', name: 'Agent Town', detail: 'resident agent office', icon: '▦', type: 'VIEW', action: () => switchView('town') },
      { id: 'view-world', name: 'Global Intel', detail: 'globe, map and headlines', icon: '◍', type: 'VIEW', action: () => switchView('world') },
      { id: 'settings', name: 'Open Settings', detail: 'AI, voice, themes and privacy', icon: '⚙', type: 'ACTION', action: openSettings },
      { id: 'desktopAgent', name: 'Open Desktop Agent (Computer Use)', detail: 'Drive your mouse, keyboard & screen — keyless, no Claude', icon: '🤖', type: 'ACTION', action: openAgentModal },
      { id: 'codingAgent', name: 'Open Coding Agent', detail: 'Point a project folder + task — Gem reads & edits code, keyless', icon: '👨‍💻', type: 'ACTION', action: openCodingAgentModal },
      { id: 'toggle-appearance', name: `Switch to ${profile.appearance === 'light' ? 'Dark' : 'Light'} Mode`, detail: 'persistent interface appearance', icon: profile.appearance === 'light' ? '🌙' : '☀', type: 'TOGGLE', action: toggleAppearance },
      { id: 'breathing', name: 'Guided Breathing', detail: '4-7-8 calm session', icon: '◌', type: 'ACTION', action: () => $('#breatheModal').classList.add('open') },
      { id: 'weekly-report', name: 'Weekly Report', detail: 'mood, goals and task trends', icon: '▥', type: 'ACTION', action: () => $('#weeklyReportBtn').click() },
      { id: 'panel-weather', name: 'Weather Panel', detail: 'HUD panel', icon: '☁', type: 'PANEL', action: () => openHudDock('weather') },
      { id: 'panel-clock', name: 'World Clock Panel', detail: 'HUD panel', icon: '◷', type: 'PANEL', action: () => openHudDock('clock') },
      { id: 'panel-focus', name: 'Focus Timer Panel', detail: 'HUD panel', icon: '◫', type: 'PANEL', action: () => openHudDock('focus') },
      { id: 'panel-system', name: 'Live Telemetry Panel', detail: 'HUD panel', icon: '⌁', type: 'PANEL', action: () => openHudDock('system') },
      { id: 'panel-news', name: 'Headlines Panel', detail: 'HUD panel', icon: '◎', type: 'PANEL', action: () => openHudDock('news') },
      { id: 'toggle-memory', name: `${profile.memoryOn === false ? 'Enable' : 'Disable'} Auto Memory`, detail: 'settings toggle', icon: '🧠', type: 'TOGGLE', action: () => { profile.memoryOn = profile.memoryOn === false; persistProfile(); toast('MEMORY', profile.memoryOn ? 'Auto memory enabled.' : 'Auto memory disabled.', '🧠'); } },
      { id: 'toggle-wake', name: `${profile.wakeWord ? 'Disable' : 'Enable'} Wake Word`, detail: `say “${profile.wakeWordText || 'Hey Gem'}”`, icon: '🎙', type: 'TOGGLE', action: () => { profile.wakeWord = !profile.wakeWord; persistProfile(); configureWakeWord(profile.wakeWord); } },
      { id: 'toggle-score', name: `${profile.ambientScore ? 'Disable' : 'Enable'} Ambient Score`, detail: 'local synthesized audio', icon: '♫', type: 'TOGGLE', action: () => { profile.ambientScore = !profile.ambientScore; setAmbientScore(profile.ambientScore); persistProfile(); } },
      ...AGENTS.map((a) => ({ id: 'agent-' + a.name.toLowerCase(), name: 'Assign ' + a.name, detail: a.role, icon: a.emoji, type: 'AGENT', action: () => { switchView('assistant'); $('#chatInput').value = '@' + a.name + ' '; $('#chatInput').focus(); } })),
      ...WORKFLOWS.map((w) => ({ id: w.id, name: w.name, detail: w.detail, icon: w.icon, type: 'WORKFLOW', action: () => { switchView('assistant'); sendMessage(w.prompt); } })),
      ...((window.GemAirThemes ? window.GemAirThemes.list() : []).map((theme) => ({
        id: 'theme-' + theme.id, name: theme.label + ' Theme', detail: theme.tagline, icon: '◆', type: 'THEME',
        action: () => { profile.theme = theme.id; applyTheme(theme.id); persistProfile(); }
      }))),
      ...Object.values(modesCache).map(m=>({
        id: 'mode-' + m.name, name: (m.icon||'◍') + ' ' + m.name + ' Mode', detail: m.description || (m.apps||[]).join(', '), icon: m.icon||'🌙', type: 'MODE',
        action: () => applyMode(m.name)
      })),
      ...[
        { id: 'conn-chatgpt', name: connectionsStatus.chatgpt.connected ? 'ChatGPT Connected (' + (connectionsStatus.chatgpt.email||'') + ')' : 'Connect ChatGPT (Stonic-style)', detail: connectionsStatus.chatgpt.dot + ' ' + (connectionsStatus.chatgpt.usage||0) + ' today', icon: '🔌', type: 'CONNECTION', action: ()=>{ if (connectionsStatus.chatgpt.connected) api.connectionsDisconnect('chatgpt').then(loadConnectionsStatus); else handleConnectChatGPT(); } },
        { id: 'conn-gemini', name: connectionsStatus.gemini.connected ? 'Gemini Connected (' + (connectionsStatus.gemini.email||'') + ')' : 'Connect Gemini', detail: connectionsStatus.gemini.dot + ' ' + (connectionsStatus.gemini.usage||0) + ' today', icon: '🔌', type: 'CONNECTION', action: ()=>{ if (connectionsStatus.gemini.connected) api.connectionsDisconnect('gemini').then(loadConnectionsStatus); else handleConnectGemini(); } },
        { id: 'conn-free', name: 'Free Core (Fallback)', detail: 'Always ready — serverless', icon: '☁', type: 'CONNECTION', action: ()=>{} }
      ],
      ...getRecentMissionsForPalette().map((mission, idx)=>({
        id: 'mission-' + idx, name: mission.text.slice(0,60), detail: mission.summary || 'recent mission', icon: '🚀', type: 'MISSION',
        action: () => sendMessage(mission.text)
      }))
    ];
    (memory.facts || []).slice(0, 40).forEach((fact) => items.push({
      id: 'memory-' + fact.id, name: fact.text, detail: fact.category || 'memory', icon: '◇', type: 'MEMORY',
      action: () => { switchView('core'); $('#factFilter').value = fact.text; renderFacts(); }
    }));
    return items;
  };
  function openPalette() {
    palette.classList.add('open'); paletteSelected = 0;
    setTimeout(() => pInput.focus(), 30); updatePaletteResults();
  }
  function closePalette() { palette.classList.remove('open'); pInput.value = ''; if (pResults) pResults.innerHTML = ''; }
  function runPaletteItem(item) {
    if (!item) return;
    rememberPalette(item.id); closePalette(); playSfx('click'); item.action();
  }
  function updatePaletteSelection() {
    pResults.querySelectorAll('.palette-item').forEach((el, idx) => el.classList.toggle('selected', idx === paletteSelected));
    const selected = pResults.querySelector('.palette-item.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }
  function updatePaletteResults() {
    if (!pResults) return;
    const q = (pInput.value || '').trim();
    const all = paletteItems();
    const recentIds = readRecents();
    if (!q && recentIds.length) {
      const recent = recentIds.map((id) => all.find((item) => item.id === id)).filter(Boolean);
      const rest = all.filter((item) => !recentIds.includes(item.id)).slice(0, Math.max(0, 8 - recent.length));
      paletteMatches = [...recent, ...rest];
    } else {
      paletteMatches = all.map((item) => ({ item, score: fuzzyScore(q, [item.name, item.detail, item.type].join(' ')) }))
        .filter((entry) => entry.score >= 0).sort((a, b) => b.score - a.score).slice(0, 9).map((entry) => entry.item);
    }
    paletteSelected = Math.min(paletteSelected, Math.max(0, paletteMatches.length - 1));
    if (!paletteMatches.length) {
      pResults.innerHTML = `<div class="palette-section">NO COMMAND MATCH</div><div class="palette-item palette-ask"><span class="item-main"><span class="item-icon">↗</span><span class="item-copy">Ask Gem “${escapeHtml(q)}”</span></span><span class="item-type">ENTER</span></div>`;
      return;
    }
    const recentSet = new Set(recentIds);
    let markedRecents = false, markedAll = false;
    pResults.innerHTML = paletteMatches.map((item, idx) => {
      let heading = '';
      if (!q && recentSet.has(item.id) && !markedRecents) { markedRecents = true; heading = '<div class="palette-section">RECENTS</div>'; }
      if (!q && !recentSet.has(item.id) && !markedAll) { markedAll = true; heading = '<div class="palette-section">EXPLORE</div>'; }
      return `${heading}<div class="palette-item${idx === paletteSelected ? ' selected' : ''}" data-idx="${idx}"><span class="item-main"><span class="item-icon">${item.icon}</span><span class="item-copy">${escapeHtml(item.name)}<span class="item-detail">${escapeHtml(item.detail || '')}</span></span></span><span class="item-type">${item.type}</span></div>`;
    }).join('');
    pResults.querySelectorAll('.palette-item[data-idx]').forEach((el) => {
      el.addEventListener('mouseenter', () => { paletteSelected = Number(el.dataset.idx); updatePaletteSelection(); });
      el.addEventListener('click', () => runPaletteItem(paletteMatches[Number(el.dataset.idx)]));
    });
  }
  $$('.accent-link[data-pal]').forEach((link) => link.addEventListener('click', () => { switchView(link.dataset.pal); closePalette(); }));
  pInput.addEventListener('input', () => { paletteSelected = 0; updatePaletteResults(); });
  pInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      paletteSelected = (paletteSelected + step + Math.max(1, paletteMatches.length)) % Math.max(1, paletteMatches.length);
      updatePaletteSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (paletteMatches[paletteSelected]) runPaletteItem(paletteMatches[paletteSelected]);
      else if (pInput.value.trim()) { const ask = pInput.value.trim(); closePalette(); switchView('assistant'); sendMessage(ask); }
    } else if (event.key === 'Escape') closePalette();
  });

  // keyboard shortcuts + Konami easter egg
  const konami = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let konamiIndex = 0;
  addLifecycleListener(window, 'keydown', (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    konamiIndex = key === konami[konamiIndex] ? konamiIndex + 1 : (key === konami[0] ? 1 : 0);
    if (konamiIndex === konami.length) { konamiIndex = 0; triggerRgbBurst(); }
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-4]$/.test(e.key)) {
      const quickButton = quickButtons.find((button) => button.dataset.shortcut === e.key);
      if (quickButton) { e.preventDefault(); activateQuickButton(quickButton); }
    }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { $('#chatInput').focus(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === ',') { openSettings(); }
    // U4: Escape now closes EVERY modal (breathe / report / theme included),
    // not just settings + palette + download.
    else if (e.key === 'Escape') { closeAllModals(); }
  });

  // voice presets, preview, and tuning
  $$('.voice-preset').forEach((button) => button.addEventListener('click', () => {
    applyVoicePresetToControls(button.dataset.voicePreset);
    playSfx('click');
  }));
  $('#sttLangChip').addEventListener('click', () => {
    profile.voice = profile.voice || {};
    const current = STT_LANGUAGES.indexOf(profile.voice.sttLang || DEFAULTS.sttLang);
    profile.voice.sttLang = STT_LANGUAGES[(current + 1) % STT_LANGUAGES.length];
    $('#setSttLang').value = profile.voice.sttLang;
    // Section IId: switching STT to Hindi/Urdu also selects a matching Edge voice.
    const matched = edgeVoiceForSttLang(profile.voice.sttLang);
    if (/^(hi|ur)/i.test(profile.voice.sttLang) && matched) profile.voice.edgeVoice = matched;
    const evSel = $('#setEdgeVoice'); if (evSel && profile.voice.edgeVoice) evSel.value = profile.voice.edgeVoice;
    updateSttLanguageUi(); persistProfile(); playSfx('click');
    toast('VOICE LANGUAGE', profile.voice.sttLang, '🎙');
  });
  $('#previewVoice').addEventListener('click', () => {
    const previousVoice = { ...profile.voice };
    const previousGender = profile.voiceGender;
    profile.voice.mode = $('#setVoiceMode').value;
    profile.voice.neuralVoice = $('#setNeuralVoice').value;
    profile.voice.edgeVoice = $('#setEdgeVoice')?.value || profile.voice.edgeVoice || 'en-US-AriaNeural';
    profile.voice.name = $('#setVoice').value;
    profile.voice.rate = Number($('#setRate').value);
    profile.voice.pitch = Number($('#setPitch').value);
    profile.voiceGender = $('#setVoiceGender').value;
    speak('Hello, I am Gem, your personal intelligence. All systems are ready.');
    profile.voice = previousVoice; profile.voiceGender = previousGender;
  });
  $('#setRate').addEventListener('input', () => { $('#rateVal').textContent = $('#setRate').value; });
  $('#setPitch').addEventListener('input', () => { $('#pitchVal').textContent = $('#setPitch').value; });
  $('#setVoiceMode').addEventListener('change', () => {
    const mode = $('#setVoiceMode').value;
    $('#setNeuralVoice').disabled = mode !== 'neural';
    $('#setEdgeVoice').disabled = mode !== 'edge';
    $('#previewVoice').disabled = false;
  });

  // chat
  $('#sendBtn').addEventListener('click', () => sendMessage($('#chatInput').value));
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage($('#chatInput').value); });

  // start AI loop
  $('#startBtn').addEventListener('click', () => {
    playSfx('activate');
    if (isRunning) {
      isRunning = false;
      $('#startBtn').classList.remove('running');
      $('#startLabel').textContent = 'START AI';
      $('#orbStatus').textContent = 'STANDBY';
      $('#orbStatus').classList.remove('active');
      stopListening();
      stopSpeaking(); // U6: turning the loop OFF must also silence Gem mid-sentence
      updateMediaLink();
    }
    else { startAiLoop(); addMessage('system-msg', 'Listening. Speak naturally.'); speak('I am listening. How can I help?'); updateMediaLink(); }
  });

  $('#micBtn').addEventListener('click', () => {
    if (!recognition) { addMessage('system-msg', 'Speech recognition unavailable here — type a command instead.'); return; }
    if (listening) stopListening();
    else { listening = true; startMicMeter(); avatar({ listening: true }); $('#micBtn').classList.add('recording'); document.body.classList.add('rgb-recording'); try { recognition.start(); } catch (e) {} }
  });

  $('#refreshNews').addEventListener('click', () => refreshHeadlines(worldCategory));
  $$('.news-filter').forEach((button) => button.addEventListener('click', () => refreshHeadlines(button.dataset.newsCategory)));
  $$('.world-mode').forEach((button) => button.addEventListener('click', () => {
    $$('.world-mode').forEach((item) => item.classList.toggle('active', item === button));
    $('#worldGrid').dataset.mode = button.dataset.worldMode;
    playSfx('swoosh');
  }));

  // reminders from main process
  api.onReminder((r) => {
    addMessage('system-msg', `⏰ REMINDER: ${r.text}`);
    speak('Reminder: ' + r.text);
  });

  // visible reasoning: live tool-activity chips (single global listener)
  if (api.onActivity) api.onActivity(toolChipUpdate);

  // 2.5 Desktop Agent — live step events from the main process
  if (api.onComputerUseEvent) api.onComputerUseEvent((ev) => {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'screen':
        logAgentLine('', `[step ${ev.step + 1}] 🖼 screen captured (${ev.width}×${ev.height}) — ${ev.file || ''}`);
        agentSetStatusLine(`Step ${ev.step + 1}: looking at the screen…`, 'ok');
        break;
      case 'tool':
        if (ev.state === 'start') logAgentLine('step', `[step ${(ev.step ?? 0) + 1}] → ${ev.name} ${JSON.stringify(ev.args || {})}`);
        else if (ev.state === 'error') logAgentLine('warn', `[step ${(ev.step ?? 0) + 1}] ✖ ${ev.name} failed: ${JSON.stringify(ev.result).slice(0, 200)}`);
        else logAgentLine('ok', `[step ${(ev.step ?? 0) + 1}] ✔ ${ev.name}`);
        break;
      case 'text':
        logAgentLine('', '💬 ' + (ev.text || ''));
        break;
      case 'stopped':
        logAgentLine('warn', '⏹ Agent stopped by you.');
        break;
      case 'done':
        logAgentLine('ok', '✔ AGENT FINISHED.');
        break;
      case 'done_timeout':
        logAgentLine('warn', '⚠ Reached max steps.');
        break;
      case 'error':
        logAgentLine('warn', '✖ ' + (ev.error || 'agent error'));
        break;
      default:
        logAgentLine('', JSON.stringify(ev).slice(0, 200));
    }
  });

  // 2.5 Coding Agent — live step events from the main process
  if (api.onCodingUseEvent) api.onCodingUseEvent((ev) => {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'screen': break;
      case 'tool':
        if (ev.state === 'start') logCodingLine('step', `[step ${(ev.step ?? 0) + 1}] → ${ev.name} ${JSON.stringify(ev.args || {})}`);
        else if (ev.state === 'error') logCodingLine('warn', `[step ${(ev.step ?? 0) + 1}] ✖ ${ev.name} failed`);
        else logCodingLine('ok', `[step ${(ev.step ?? 0) + 1}] ✔ ${ev.name}`);
        break;
      case 'text':
        logCodingLine('', '💬 ' + (ev.text || ''));
        break;
      case 'stopped':
        logCodingLine('warn', '⏹ Coding Agent stopped by you.');
        break;
      case 'done':
        logCodingLine('ok', '✔ CODING AGENT FINISHED.');
        break;
      case 'done_timeout':
        logCodingLine('warn', '⚠ Reached max steps.');
        break;
      case 'error':
        logCodingLine('warn', '✖ ' + (ev.error || 'agent error'));
        break;
      default:
        logCodingLine('', JSON.stringify(ev).slice(0, 200));
    }
  });

  // dynamic HUD dock panels
  setupHudDock();

  // first-run theme picker swatches — generated from the string theme
  // engine (themes.js) so theme tokens have ONE source of truth
  renderThemeSwatches();
  $$('#themeSwatches .swatch').forEach((b) => b.addEventListener('click', () => {
    playSfx('activate');
    profile.theme = b.dataset.theme;
    applyTheme(profile.theme);
    persistProfile();
    $('#themeModal').classList.remove('open');
    toast('THEME', `${b.textContent.trim()} HUD applied across the whole command center.`, '🎨');
  }));
  $('#themeSkipBtn')?.addEventListener('click', () => { $('#themeModal').classList.remove('open'); });
  $('#themeModalClose')?.addEventListener('click', () => { $('#themeModal').classList.remove('open'); });

  // tray "start listening"
  api.onWakeToggle((on) => { if (on) startAiLoop(); });

  configureWakeWord(profile.wakeWord);
}

let screenAwarenessTimer = null;
let screenInspecting = false;
async function inspectActiveScreen() {
  if (!profile.screenAwareness || (!isRunning && !listening) || screenInspecting) return;
  screenInspecting = true;
  try {
    const result = await api.screenInspect();
    if (result && result.changed) {
      addActivity('SCREEN', '✓ ' + result.description);
      pushToolActivity('see_screen', { mode: 'change detection' }, result, 0);
      toast('SCREEN AWARENESS', result.description, '◫');
    }
  } catch (e) {
    addActivity('SCREEN', 'Screen awareness unavailable: ' + e.message);
  } finally { screenInspecting = false; }
}
function configureScreenAwareness(enabled) {
  if (screenAwarenessTimer) clearInterval(screenAwarenessTimer);
  screenAwarenessTimer = null;
  if (!enabled) return;
  screenAwarenessTimer = setInterval(inspectActiveScreen, 15000);
  inspectActiveScreen();
}

// Start the assistant loop (used by START button + wake word)
function startAiLoop() {
  isRunning = true;
  listening = true;
  startMicMeter();
  if (profile.screenAwareness) inspectActiveScreen();
  $('#startBtn').classList.add('running');
  $('#startLabel').textContent = 'AI ONLINE';
  $('#orbStatus').textContent = 'LISTENING · SPEAK NOW';
  $('#orbStatus').classList.add('active');
  if (recognition) { try { recognition.start(); $('#micBtn').classList.add('recording'); document.body.classList.add('rgb-recording'); } catch (e) {} }
}

// Continuous wake-word listening ("Hey GemAir")
let wakeRecognition = null;
let wakeArmed = false;
let wakeBackoff = 250;
function configureWakeWord(enabled) {
  document.body.classList.toggle('wake-armed', !!enabled);
  if (!enabled) {
    if (wakeRecognition) { try { wakeRecognition.stop(); } catch (e) {} }
    wakeRecognition = null;
    wakeArmed = false;
    stopMicMeter();
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  startMicMeter();
  if (!wakeRecognition) {
    const recognitionLoop = new SR();
    recognitionLoop.continuous = true; recognitionLoop.interimResults = true;
    recognitionLoop.lang = profile.voice?.sttLang || 'en-US';
    recognitionLoop.onresult = (event) => {
      for (let i = event.resultIndex || 0; i < event.results.length; i++) {
        const transcript = (event.results[i][0].transcript || '').toLowerCase().trim();
        if (transcript) { stopSpeaking(); wakeBackoff = 250; } // barge-in wins; healthy loop resets backoff
        const wakePhrase = String(profile.wakeWordText || 'Hey Gem').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const normalizedTranscript = transcript.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (wakePhrase && (` ${normalizedTranscript} `).includes(` ${wakePhrase} `)) {
          addMessage('system-msg', `Wake phrase “${profile.wakeWordText || 'Hey Gem'}” detected — listening.`);
          startAiLoop();
          setCaption('user', transcript, { autoHide: 1600 });
          break;
        }
      }
    };
    recognitionLoop.onerror = () => { /* onend restarts (with backoff) unless permission was revoked */ };
    recognitionLoop.onend = () => {
      // U6: back off when the wake loop cannot stay open (offline / no mic)
      if (!profile.wakeWord || !wakeRecognition) { wakeArmed = false; return; }
      wakeBackoff = Math.min(15000, Math.round(wakeBackoff * 1.7));
      setTimeout(() => {
        if (!profile.wakeWord || !wakeRecognition) return;
        try { recognitionLoop.start(); } catch (e) {}
      }, wakeBackoff);
    };
    wakeRecognition = recognitionLoop;
  }
  wakeRecognition.lang = profile.voice?.sttLang || DEFAULTS.sttLang;
  // U6: configureWakeWord() ran twice at boot (once from setupControls, once
  // from the init tail), so the loop was armed twice and the confirmation
  // message appeared twice. Arming is now idempotent.
  if (wakeArmed) return;
  wakeArmed = true;
  try { wakeRecognition.start(); } catch (e) {}
  addMessage('system-msg', `Wake word armed — say “${profile.wakeWordText || 'Hey Gem'}” anytime.`);
}

function stopListening() {
  avatar({ listening: false });
  listening = false;
  $('#micBtn').classList.remove('recording');
  document.body.classList.remove('rgb-recording');
  if (recognition) { try { recognition.stop(); } catch (e) {} }
  stopMicMeter();
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

// ---------------------------------------------------------------------------
// Dynamic HUD dock — contextual floating panels the AI can open/close via
// the show_panel / hide_panel tools (weather, clock, focus, breathing,
// system telemetry, news, weekly report). Also usable from the palette.
// ---------------------------------------------------------------------------
let hudClockTimer = null;
let hudFocusTimer = null;

function setupHudDock() {
  $('#hudDockClose')?.addEventListener('click', closeHudDock);
  startHudAutoRules(); // S6
  if (api.onHudPanel) api.onHudPanel(({ action, panel, city }) => {
    if (action === 'close') closeHudDock();
    else openHudDock(panel, city);
  });
}

/**
 * S6 — HUD dock auto-open rules.
 *
 * The dock could only be opened by an explicit tool call or the palette, so in
 * practice it almost never appeared. These are the three contextual triggers
 * from the roadmap. Each fires at most once per condition so the dock never
 * fights the user, and all of them respect a manual close.
 */
let hudAutoState = { lastPanel: '', lastAt: 0, dismissedUntil: 0, reportShownWeek: '' };

function hudAutoAllowed(panel) {
  const now = Date.now();
  if (now < hudAutoState.dismissedUntil) return false;                 // user closed it recently
  if (hudAutoState.lastPanel === panel && now - hudAutoState.lastAt < 10 * 60 * 1000) return false;
  return true;
}

function hudAutoOpen(panel, arg) {
  if (!hudAutoAllowed(panel)) return false;
  hudAutoState.lastPanel = panel;
  hudAutoState.lastAt = Date.now();
  openHudDock(panel, arg);
  return true;
}

/** Rule 1 + 3: inspect the user's message for weather/focus intent. */
function hudAutoFromMessage(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return;
  // rain / storm questions → weather panel
  if (/\b(rain|raining|rainy|storm|stormy|thunder|downpour|monsoon|umbrella|drizzle|shower[s]?|hail|snow)\b/.test(t)) {
    const city = (t.match(/\bin\s+([a-z][a-z\s]{2,30}?)(?:\s*[?.,]|$)/) || [])[1];
    hudAutoOpen('weather', city ? city.trim() : (profile.city || DEFAULTS.city));
    return;
  }
  // focus / pomodoro → focus timer
  if (/\b(focus(ing|ed)?|pomodoro|deep work|concentrate|study session|work sprint)\b/.test(t)) {
    hudAutoOpen('focus');
  }
}

/** Rule 2: Friday evening → the weekly report is ready. */
function hudAutoWeeklyReport() {
  const now = new Date();
  if (now.getDay() !== 5) return;              // Friday
  if (now.getHours() < 17 || now.getHours() > 22) return;  // evening
  const week = `${now.getFullYear()}-${now.getMonth()}-${Math.floor(now.getDate() / 7)}`;
  if (hudAutoState.reportShownWeek === week) return;
  hudAutoState.reportShownWeek = week;
  try { localStorage.setItem('gemair:report-week', week); } catch (e) {}
  hudAutoOpen('report');
}

function startHudAutoRules() {
  try { hudAutoState.reportShownWeek = localStorage.getItem('gemair:report-week') || ''; } catch (e) {}
  // check on boot, then hourly — cheap, and survives a long-running session
  setTimeout(hudAutoWeeklyReport, 4000);
  setInterval(hudAutoWeeklyReport, 30 * 60 * 1000);
}

function closeHudDock() {
  // S6: a manual close means "leave me alone" — suppress auto-open for a while.
  hudAutoState.dismissedUntil = Date.now() + 30 * 60 * 1000;
  $('#hudDock')?.classList.remove('open');
  if (hudClockTimer) { clearInterval(hudClockTimer); hudClockTimer = null; }
  if (hudFocusTimer) { clearInterval(hudFocusTimer); hudFocusTimer = null; }
}

function openHudDock(panel, arg) {
  const dock = $('#hudDock'), body = $('#hudDockBody'), title = $('#hudDockTitle');
  if (!dock || !body || !title) return;
  playSfx('swoosh');
  dock.classList.add('open');
  const R = {
    weather: renderWeatherPane,
    clock: renderClockPane,
    focus: renderFocusPane,
    breathing: renderBreathingPane,
    system: renderSystemPane,
    news: renderNewsPane,
    report: renderReportPane
  }[String(panel || '').toLowerCase()];
  if (!R) { body.innerHTML = '<div class="empty">Unknown panel.</div>'; return; }
  Promise.resolve(R(body, title, arg)).catch(() => {});
}

async function renderWeatherPane(body, title, arg) {
  title.textContent = 'WEATHER';
  const city = arg || profile.city || DEFAULTS.city;
  body.innerHTML = '<div class="empty">Scanning atmosphere…</div>';
  const w = await webGet('weather', { city });
  if (w.error) { body.innerHTML = `<div class="empty">${escapeHtml(w.error)}</div>`; return; }
  body.innerHTML =
    `<div class="dock-big">${Math.round(w.temperature)}°C</div>
     <div class="dock-line"><span>LOCATION</span><b>${escapeHtml(w.city)}</b></div>
     <div class="dock-line"><span>CONDITION</span><b>${escapeHtml(w.condition)}</b></div>
     <div class="dock-line"><span>WIND</span><b>${escapeHtml(String(w.windspeed))} km/h</b></div>`;
}

function renderClockPane(body, title) {
  title.textContent = 'WORLD CLOCK';
  const tick = () => {
    const now = new Date();
    body.innerHTML =
      `<div class="dock-big">${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}</div>
       <div class="dock-line"><span>LOCAL DATE</span><b>${now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</b></div>
       <div class="dock-line"><span>UTC</span><b>${now.toUTCString().slice(17, 25)}</b></div>`;
  };
  tick();
  if (hudClockTimer) clearInterval(hudClockTimer);
  hudClockTimer = setInterval(tick, 1000);
}

function renderFocusPane(body, title) {
  title.textContent = 'FOCUS TIMER';
  let remaining = 25 * 60, running = false;
  const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  body.innerHTML =
    `<div class="dock-big">25:00</div>
     <div style="display:flex;gap:8px;margin-top:10px;">
       <button class="primary-btn" style="flex:1">▶ START</button>
       <button class="ghost-btn">RESET</button>
     </div>`;
  const timeEl = body.querySelector('.dock-big');
  const toggleBtn = body.querySelector('.primary-btn');
  const resetBtn = body.querySelector('.ghost-btn');
  const paint = () => { if (timeEl && timeEl.isConnected) timeEl.textContent = fmt(remaining); };
  toggleBtn.addEventListener('click', () => {
    playSfx('click');
    running = !running;
    toggleBtn.textContent = running ? '⏸ PAUSE' : '▶ START';
    if (hudFocusTimer) { clearInterval(hudFocusTimer); hudFocusTimer = null; }
    if (running) {
      hudFocusTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          remaining = 0; running = false;
          if (hudFocusTimer) { clearInterval(hudFocusTimer); hudFocusTimer = null; }
          if (toggleBtn.isConnected) toggleBtn.textContent = '▶ START';
          toast('FOCUS', 'Session complete — take a break!', '🍅');
          speak('Focus session complete.');
        }
        paint();
      }, 1000);
    }
  });
  resetBtn.addEventListener('click', () => {
    playSfx('click');
    remaining = 25 * 60; running = false;
    if (hudFocusTimer) { clearInterval(hudFocusTimer); hudFocusTimer = null; }
    toggleBtn.textContent = '▶ START';
    paint();
  });
}

function renderBreathingPane(body, title) {
  title.textContent = 'BREATHING';
  body.innerHTML =
    `<p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:10px;">4-7-8 calming breath — inhale 4s, hold 7s, exhale 8s, four cycles. Lowers your heart rate in about a minute.</p>
     <button class="primary-btn" style="width:100%">🌬 OPEN GUIDED SESSION</button>`;
  body.querySelector('.primary-btn').addEventListener('click', () => {
    playSfx('activate');
    closeHudDock();
    $('#breatheModal').classList.add('open');
  });
}

async function renderSystemPane(body, title) {
  title.textContent = 'LIVE TELEMETRY';
  body.innerHTML = '<div class="empty">Reading sensors…</div>';
  const i = await api.getSystemInfo();
  if (i.available === false) {
    body.innerHTML = '<div class="empty">Hardware telemetry requires the desktop app. Browsers cannot read CPU, RAM or disk usage.</div>';
    return;
  }
  const batRow = i.battery ? `<div class="dock-line"><span>BATTERY</span><b>${i.battery.percent}%${i.battery.charging ? ' ⚡' : ''}</b></div>` : '';
  const diskRow = i.disk ? `<div class="dock-line"><span>DISK FREE</span><b>${i.disk.freeGB} GB / ${i.disk.totalGB} GB (${100 - i.disk.percent}%)</b></div>` : '';
  body.innerHTML =
    `<div class="dock-big">${i.cpuLoad}% <span style="font-size:14px;color:var(--text-dim)">CPU</span></div>
     <div class="dock-line"><span>MEMORY</span><b>${i.memPercent}% used</b></div>
     ${batRow}${diskRow}
     <div class="dock-line"><span>UPTIME</span><b>${Math.floor(i.uptime / 3600)}h ${Math.floor((i.uptime % 3600) / 60)}m</b></div>`;
}

async function renderNewsPane(body, title) {
  title.textContent = 'HEADLINES';
  body.innerHTML = '<div class="empty">Fetching intelligence feed…</div>';
  const items = await api.getHeadlines(8);
  if (!items.length) { body.innerHTML = '<div class="empty">Feed unavailable right now.</div>'; return; }
  body.innerHTML = items.slice(0, 7).map((n) =>
    `<a class="news-mini" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title)} <span class="score">▲ ${n.score}</span></a>`
  ).join('');
}

async function renderReportPane(body, title) {
  title.textContent = 'WEEKLY REPORT';
  body.innerHTML = '<div class="empty">Compiling your week…</div>';
  const res = await api.generateReport();
  body.innerHTML = `<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:11px;line-height:1.6;margin:0;">${escapeHtml(res.report)}</pre>`;
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
  safe('applyTheme', () => applyTheme(profile.theme || DEFAULTS.theme));
  // S4: restore the saved interface language (and RTL direction) at boot
  safe('applyLocale', () => {
    if (!window.GemAirI18n) return;
    if (profile.lang && profile.lang !== window.GemAirI18n.locale) window.GemAirI18n.setLocale(profile.lang);
    else window.GemAirI18n.apply();
  });
  safe('bindEvents', bindEvents);
  safe('bindSoulSliders', bindSoulSliders);
  safe('updateLinkMode', updateLinkMode);
  safe('sttLanguage', updateSttLanguageUi);

  // Everything below is presentation. Any of it may fail without taking the
  // interface down with it.
  safe('background3D', startBackground3D);
  safe('orb', startOrb);
  safe('globe', startGlobe);
  safe('commandMap', startCommandMap);
  safe('satLink', startSatLink);
  safe('satFeed', () => renderSatFeed('today')); // S1: load the real TODAY feed
  safe('modalA11y', setupModalAccessibility);          // U4
  safe('iconLabels', labelIconButtons);                // U4
  safe('shortcutHints', applyPlatformShortcutHints);   // U4
  safe('systemStatus', updateSystemStatusChip);        // U2
  safe('account', setupAccountControls);               // T1
  safe('rating', setupRatingUi);                       // T3
  safe('connectionsHub', setupConnectionsHub);         // 2.4 C,D,H
  safe('modes', setupModes);                           // 2.4 M
  safe('desktopTools', setupDesktopTools);             // 2.4 A
  safe('planAct', setupPlanAct);                       // 2.4 A1
  safe('settingsReorg', setupSettingsReorg);           // 2.4 U3
  safe('circuitWires', startCircuitWires);
  safe('townPreview', startTownPreview);
  safe('townChrome', initTownChrome);
  safe('voiceTab', renderVoiceTab);
  safe('onboarding', setupOnboarding);           // T4 first-run wizard + replay
  safe('notesMini', renderNotesMini);
  safe('agentTown', startAgentTown);
  safe('radar', startRadar);
  safe('renderMemory', renderAllMemory);
  safe('nowCard', updateNowCard);
  safe('circuits', animateCircuits);
  safe('moodIndicator', () => updateMoodIndicator(currentEmotion));
  safe('loadModes', loadModes);

  // restore recent conversation history from persistent memory
  const last = (memory.transcript || []).slice(-40);
  const knowsUser = !!(profile.name && profile.name !== 'Commander');
  const greeting = knowsUser
    ? `${greetByTime()}, ${profile.name}. Gem here — all systems online, and I remember everything about you.`
    : `${greetByTime()}. I'm Gem, the intelligence inside GemAir.`;

  // First run: introduce Gem, then ask what to call the user. The next thing
  // they type is captured as their name (see handleMessage). Also let them
  // pick the HUD theme so the very first impression is theirs.
  if (!knowsUser && !last.length) {
    // T4 — cinematic onboarding replaces the old chat-question flow.
    // Fallback: if the wizard can't run, the original chat ask still works.
    if (!safeLaunchOnboarding()) {
      addMessage('ai', greeting);
      const ask = 'Before we begin — what should I call you?';
      addMessage('ai', ask);
      awaitingName = true;
      setTimeout(() => speak(greeting + ' ' + ask), 700);
      setTimeout(() => { $('#themeModal')?.classList.add('open'); }, 1600);
    }
  } else if (last.length) {
    addMessage('system-msg', `↻ Restored ${last.length} past messages from persistent memory.`);
    last.forEach((m) => { if (m.role === 'user') addMessage('user', m.content); else if (m.role === 'assistant') addMessage('ai', m.content); });
    last.forEach((m) => { if (m.role === 'user' || m.role === 'assistant') chatHistory.push({ role: m.role, content: m.content }); });
  } else if (!awaitingName) {
    addMessage('ai', greeting);
  }

  toast('GEMAIR', 'GemAir is online — completely free out of the box!', '✨');

  try {
    const recovery = await api.consumeRecovery();
    if (recovery && (recovery.recovered || (recovery.restored && recovery.restored.length))) {
      const restored = recovery.restored && recovery.restored.length ? ` Restored: ${recovery.restored.join(', ')}.` : '';
      addMessage('system-msg', `♻ GemAir recovered safely after an unexpected interruption.${restored} Your local profile and memory are available.`);
      toast('STATE RECOVERED', 'Local profile and memory passed recovery checks.', '♻');
    }
  } catch (error) { console.warn('[recovery-status]', error); }

  pollSystem(); setInterval(pollSystem, 2500);
  recognition = initRecognition();
  if (speechSynthesis) speechSynthesis.onvoiceschanged = populateVoices;
  try { $('#verTag').textContent = 'v' + (await api.version()); } catch (e) {}
  maybeCheckForUpdates();

  if (profile.wakeWord) configureWakeWord(true);
  configureScreenAwareness(!!profile.screenAwareness);
  updateContextMeter();

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
  if (REDUCED_MOTION) { overlay.classList.add('done'); return Promise.resolve(); }
  const bios = $('#bootBios'), bar = $('#bootBar'), line = $('#bootLine');
  const trace = [
    ['GEMAIR BIOS // LOCAL INTELLIGENCE RUNTIME', 'dim'],
    ['POST  CPU VECTOR MATRIX ..................... OK', 'ok'],
    ['POST  MEMORY VAULT .......................... OK', 'ok'],
    ['MOUNT VOICE / EARS .......................... READY', 'ok'],
    ['LINK  AGENT TOWN ............................ 4 SEATS', ''],
    ['SYNC  WORLD MONITOR ......................... UTC', ''],
    ['HANDOFF TO HUD KERNEL', 'ok']
  ];

  return new Promise((resolve) => {
    let finished = false;
    const timers = [];
    const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; };
    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', skip, true);
      window.removeEventListener('pointerdown', skip, true);
      overlay.classList.add('done');
      setTimeout(resolve, 330);
    };
    const skip = (event) => {
      if (event && event.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
      finish();
    };
    addLifecycleListener(window, 'keydown', skip, true);
    addLifecycleListener(window, 'pointerdown', skip, true);

    trace.forEach(([text, cls], i) => later(() => {
      if (!bios || finished) return;
      const row = document.createElement('div');
      row.className = cls;
      row.textContent = '> ' + text;
      bios.appendChild(row);
      bios.scrollTop = bios.scrollHeight;
      if (bar) bar.style.width = Math.round(((i + 1) / (trace.length + 2)) * 100) + '%';
    }, 90 + i * 125));

    later(() => {
      if (finished) return;
      overlay.classList.add('logo-phase');
      if (line) line.textContent = 'CORE SIGNATURE VERIFIED';
      if (bar) bar.style.width = '88%';
      playSfx('activate');
    }, 1080);
    later(() => {
      if (finished) return;
      overlay.classList.add('sweep-phase');
      if (line) line.textContent = 'HUD POWER-ON SWEEP · ONLINE';
      if (bar) bar.style.width = '100%';
    }, 1880);
    later(finish, 2720); // hard bound: transition included, always under 4s
  });
}

function bindSoulSliders() {
  const pairs = [['#soulWarmth', 'warmth', '#soulWarmthVal'], ['#soulWit', 'wit', '#soulWitVal'], ['#soulBrevity', 'brevity', '#soulBrevityVal']];
  pairs.forEach(([sel, key, valSel]) => {
    const el = $(sel); if (!el) return;
    el.value = profile.soul?.[key] ?? el.value;
    const update = () => { $(valSel).textContent = el.value; profile.soul = profile.soul || {}; profile.soul[key] = Number(el.value); persistProfile(); animateCircuits(); renderAdaptivePersonalityState(); };
    el.addEventListener('input', update); update();
  });
  const adaptive = $('#soulAdaptive');
  if (adaptive) {
    adaptive.checked = profile.adaptivePersonality !== false;
    adaptive.addEventListener('change', () => {
      profile.adaptivePersonality = adaptive.checked;
      persistProfile();
      renderAdaptivePersonalityState();
      toast('SOUL', adaptive.checked ? 'Mood-adaptive personality enabled.' : 'Using manual personality sliders only.', '◇');
    });
  }
  renderAdaptivePersonalityState();
}


// ---------------------------------------------------------------------------
// GemAir 2.4 — Connections Hub (C, D, H)
// ---------------------------------------------------------------------------
function getActiveBrain() {
  const prio = connectionsStatus.meta ? connectionsStatus.meta.priority : (profile.brainPriority || 'chatgpt');
  if (prio === 'chatgpt' && connectionsStatus.chatgpt && connectionsStatus.chatgpt.connected) return 'CHATGPT';
  if (prio === 'gemini' && connectionsStatus.gemini && connectionsStatus.gemini.connected) return 'GEMINI';
  // check any connected as fallback
  if (connectionsStatus.chatgpt && connectionsStatus.chatgpt.connected) return 'CHATGPT';
  if (connectionsStatus.gemini && connectionsStatus.gemini.connected) return 'GEMINI';
  return 'FREE CORE';
}

function getModesForPrompt() {
  try {
    const all = (typeof modesCache !== 'undefined' && modesCache) ? Object.values(modesCache) : [];
    if (!all.length) return '';
    return all.map(m=>`- ${m.name}: apps ${(m.apps||[]).join(',')} | sites ${(m.sites||[]).map(s=> typeof s==='string'?s:s.url).join(',')} | vol ${m.volume} | theme ${m.theme} | dnd ${m.dnd} | playlist ${m.playlist}`).join('\n');
  } catch { return ''; }
}

let modesCache = {};
let connectionsWarningPendingProvider = null;

async function loadConnectionsStatus() {
  try {
    connectionsStatus = await api.connectionsGetStatus();
    if (profile.brainPriority && connectionsStatus.meta) {
      // sync profile priority to meta if different
      if (connectionsStatus.meta.priority !== profile.brainPriority) {
        await api.connectionsSetPriority(profile.brainPriority);
        connectionsStatus.meta.priority = profile.brainPriority;
      }
    }
    renderConnectionHub();
    renderConnectionsStatusRow();
    updateActiveBrain();
    updateNowCard();
  } catch (e) {
    console.warn('[connections] status failed', e.message);
  }
}

function renderConnectionHub() {
  const status = connectionsStatus;
  const chatgptDot = $('#chatgptStatusDot');
  const geminiDot = $('#geminiStatusDot');
  const freeDot = $('#freeCoreDot');
  const chatgptEmail = $('#chatgptEmail');
  const geminiEmail = $('#geminiEmail');
  const chatgptBadge = $('#chatgptPlanBadge');
  const geminiBadge = $('#geminiPlanBadge');
  const chatgptUsage = $('#chatgptUsage');
  const geminiUsage = $('#geminiUsage');
  const connectChatGPTBtn = $('#connectChatGPTBtn');
  const connectGeminiBtn = $('#connectGeminiBtn');
  const disconnectChatGPTBtn = $('#disconnectChatGPTBtn');
  const disconnectGeminiBtn = $('#disconnectGeminiBtn');
  const captureChatGPTBtn = $('#captureChatGPTBtn');
  const captureGeminiBtn = $('#captureGeminiBtn');
  const priorityPicker = $('#brainPriorityPicker');

  if (chatgptDot) {
    chatgptDot.className = 'conn-dot ' + (status.chatgpt.connected ? (status.chatgpt.experimental ? 'experimental' : 'connected') : 'disconnected');
    chatgptDot.textContent = status.chatgpt.connected ? '●' : '○';
    chatgptDot.title = status.chatgpt.dot + (status.chatgpt.experimental ? ' (EXPERIMENTAL)' : '');
  }
  if (geminiDot) {
    geminiDot.className = 'conn-dot ' + (status.gemini.connected ? (status.gemini.experimental ? 'experimental' : 'connected') : 'disconnected');
    geminiDot.textContent = status.gemini.connected ? '●' : '○';
    geminiDot.title = status.gemini.dot + (status.gemini.experimental ? ' (EXPERIMENTAL)' : '');
  }
  if (freeDot) {
    freeDot.className = 'conn-dot fallback';
    freeDot.textContent = '●';
  }
  if (chatgptEmail) chatgptEmail.textContent = status.chatgpt.connected ? (status.chatgpt.email || 'connected') : 'Not connected';
  if (geminiEmail) geminiEmail.textContent = status.gemini.connected ? (status.gemini.email || 'connected') : 'Not connected';
  if (chatgptBadge) { chatgptBadge.textContent = status.chatgpt.connected ? (status.chatgpt.plan || 'free').toUpperCase() : '—'; chatgptBadge.className = 'conn-badge ' + (status.chatgpt.plan||''); }
  if (geminiBadge) { geminiBadge.textContent = status.gemini.connected ? (status.gemini.plan || 'free').toUpperCase() : '—'; }
  if (chatgptUsage) chatgptUsage.textContent = (status.chatgpt.usage||0) + ' today';
  if (geminiUsage) geminiUsage.textContent = (status.gemini.usage||0) + ' today';

  if (connectChatGPTBtn) connectChatGPTBtn.hidden = !!status.chatgpt.connected;
  if (disconnectChatGPTBtn) disconnectChatGPTBtn.hidden = !status.chatgpt.connected;
  if (captureChatGPTBtn) captureChatGPTBtn.hidden = !status.chatgpt.connected ? true : false; // show after login window opened
  // Actually capture button should be visible after auth window opened; we keep hidden initially and show after open
  if (connectGeminiBtn) connectGeminiBtn.hidden = !!status.gemini.connected;
  if (disconnectGeminiBtn) disconnectGeminiBtn.hidden = !status.gemini.connected;
  if (captureGeminiBtn) captureGeminiBtn.hidden = !status.gemini.connected ? true : false;

  if (priorityPicker && status.meta) {
    priorityPicker.value = status.meta.priority || 'chatgpt';
  }
}

function renderConnectionsStatusRow() {
  const row = $('#connectionsStatusRow');
  if (!row) return;
  const s = connectionsStatus;
  const mkChip = (name, prov) => {
    const connected = prov.connected;
    const cls = connected ? (prov.experimental ? 'experimental' : 'connected') : 'disconnected';
    const dot = connected ? '●' : '○';
    return `<span class="conn-status-chip ${cls}">${dot} ${name} ${prov.email ? '('+prov.email.split('@')[0]+')' : ''} ${prov.usage ? prov.usage+' today' : ''}</span>`;
  };
  row.innerHTML = mkChip('CHATGPT', s.chatgpt) + mkChip('GEMINI', s.gemini) + `<span class="conn-status-chip fallback">● FREE CORE</span>`;
}

function updateActiveBrain() {
  const active = getActiveBrain();
  const chip = $('#activeBrainChip');
  const nameEl = $('#activeBrainName');
  const dot = $('#activeBrainDot');
  const linkMode = $('#linkMode');
  if (nameEl) nameEl.textContent = active;
  if (chip) {
    chip.className = 'active-brain-chip ' + (active === 'CHATGPT' ? 'connected' : active === 'GEMINI' ? 'experimental' : 'fallback');
    chip.title = 'Active brain: ' + active + ' — chain: accounts → free core → offline';
  }
  if (linkMode) linkMode.textContent = '— ' + active;
  const nowBrain = $('#nowBrain');
  if (nowBrain) nowBrain.textContent = active;
}

function showExperimentalWarning(provider, onContinue) {
  const acknowledged = profile.connectionsWarningAcknowledged || (connectionsStatus.meta && connectionsStatus.meta.warningAcknowledged);
  if (acknowledged) { onContinue(); return; }
  connectionsWarningPendingProvider = provider;
  const modal = $('#experimentalWarningModal');
  if (modal) modal.classList.add('open');
  // store callback
  window.__expContinue = onContinue;
}

async function handleConnectChatGPT() {
  showExperimentalWarning('chatgpt', async () => {
    try {
      toast('CHATGPT', 'Browser account connect is not configured on this deployment.', '⚠️');
      const res = await api.connectionsOpenChatGPT();
      if (res && !res.ok) { toast('CHATGPT', res.message || res.error, '⚠️'); return; }
      // Show capture button
      const cap = $('#captureChatGPTBtn');
      if (cap) cap.hidden = false;
      toast('CHATGPT', 'Sign in inside the opened window, then click Capture Session', '👁');
    } catch (e) {
      toast('CHATGPT', e.message, '⚠️');
    }
  });
}

async function handleCaptureChatGPT() {
  try {
    const res = await api.connectionsCaptureChatGPT();
    if (res.ok) {
      toast('CHATGPT', 'Connected as ' + res.email + ' (' + res.plan + ')', '✅');
      profile.connectionsWarningAcknowledged = true;
      await persistProfile();
      await api.connectionsAcknowledgeWarning();
      await loadConnectionsStatus();
      speak('ChatGPT connected as ' + res.email);
    } else {
      toast('CHATGPT', res.error || 'Capture failed', '⚠️');
    }
  } catch (e) {
    toast('CHATGPT', e.message, '⚠️');
  }
}

async function handleConnectGemini() {
  showExperimentalWarning('gemini', async () => {
    try {
      const res = await api.connectionsOpenGemini();
      if (res && !res.ok) { toast('GEMINI', res.message || res.error, '⚠️'); return; }
      const cap = $('#captureGeminiBtn');
      if (cap) cap.hidden = false;
      toast('GEMINI', 'Sign in with Google inside opened window, then Capture', '👁');
    } catch (e) {
      toast('GEMINI', e.message, '⚠️');
    }
  });
}

async function handleCaptureGemini() {
  try {
    const res = await api.connectionsCaptureGemini(false);
    if (res.ok) {
      toast('GEMINI', 'Connected as ' + res.email, '✅');
      profile.connectionsWarningAcknowledged = true;
      await persistProfile();
      await api.connectionsAcknowledgeWarning();
      await loadConnectionsStatus();
      speak('Gemini connected');
    } else {
      toast('GEMINI', res.error, '⚠️');
    }
  } catch (e) {
    toast('GEMINI', e.message, '⚠️');
  }
}

async function handleOpenAIStudio() {
  try {
    toast('AI STUDIO', 'Opening AI Studio — sign in with Google', '🧪');
    await api.connectionsOpenAIStudio();
    const cap = $('#captureGeminiBtn');
    if (cap) { cap.hidden = false; cap.textContent = 'Capture AI Studio'; cap.dataset.fallback = '1'; }
  } catch (e) {
    toast('AI STUDIO', e.message, '⚠️');
  }
}

function setupConnectionsHub() {
  $('#connectChatGPTBtn')?.addEventListener('click', handleConnectChatGPT);
  $('#captureChatGPTBtn')?.addEventListener('click', handleCaptureChatGPT);
  $('#disconnectChatGPTBtn')?.addEventListener('click', async () => {
    await api.connectionsDisconnect('chatgpt');
    await loadConnectionsStatus();
    toast('CHATGPT', 'Disconnected — encrypted storage cleared', '🔌');
  });
  $('#connectGeminiBtn')?.addEventListener('click', handleConnectGemini);
  $('#captureGeminiBtn')?.addEventListener('click', async () => {
    const btn = $('#captureGeminiBtn');
    const isFallback = btn && btn.dataset.fallback === '1';
    if (isFallback) {
      const res = await api.connectionsCaptureGemini(true);
      if (res.ok) { toast('GEMINI', 'AI Studio credential captured', '✅'); await loadConnectionsStatus(); }
      else toast('GEMINI', res.error, '⚠️');
    } else {
      await handleCaptureGemini();
    }
  });
  $('#disconnectGeminiBtn')?.addEventListener('click', async () => {
    await api.connectionsDisconnect('gemini');
    await loadConnectionsStatus();
    toast('GEMINI', 'Disconnected', '🔌');
  });
  $('#clearAllConnectionsBtn')?.addEventListener('click', async () => {
    await api.connectionsClearAll();
    await loadConnectionsStatus();
    toast('CONNECTIONS', 'All encrypted sessions cleared', '🧹');
  });
  $('#openAIStudioBtn')?.addEventListener('click', handleOpenAIStudio);
  $('#brainPriorityPicker')?.addEventListener('change', async (e) => {
    const v = e.target.value;
    profile.brainPriority = v;
    await persistProfile();
    await api.connectionsSetPriority(v);
    await loadConnectionsStatus();
    toast('BRAIN', 'Priority → ' + v.toUpperCase(), '🧠');
  });

  // Experimental warning modal
  $('#expWarnClose')?.addEventListener('click', () => $('#experimentalWarningModal').classList.remove('open'));
  $('#expWarnCancel')?.addEventListener('click', () => $('#experimentalWarningModal').classList.remove('open'));
  $('#expWarnContinue')?.addEventListener('click', async () => {
    $('#experimentalWarningModal').classList.remove('open');
    profile.connectionsWarningAcknowledged = true;
    await persistProfile();
    await api.connectionsAcknowledgeWarning();
    if (window.__expContinue) { const cb = window.__expContinue; window.__expContinue = null; cb(); }
  });

  // Reconnect modal
  $('#reconnectClose')?.addEventListener('click', () => $('#reconnectModal').classList.remove('open'));
  $('#reconnectDismiss')?.addEventListener('click', () => $('#reconnectModal').classList.remove('open'));
  $('#reconnectChatGPTBtn')?.addEventListener('click', () => { $('#reconnectModal').classList.remove('open'); handleConnectChatGPT(); });
  $('#reconnectGeminiBtn')?.addEventListener('click', () => { $('#reconnectModal').classList.remove('open'); handleConnectGemini(); });

  if (api.onConnectionsUpdated) api.onConnectionsUpdated((s) => { connectionsStatus = s; renderConnectionHub(); renderConnectionsStatusRow(); updateActiveBrain(); });
  if (api.onConnectionsExpired) api.onConnectionsExpired((data) => {
    const body = $('#reconnectBody');
    if (body) body.textContent = 'Your ' + (data.provider||'').toUpperCase() + ' session expired or hit a bot-check (' + (data.error||'') + '). Reconnect to restore. Falling back to FREE CORE.';
    $('#reconnectModal').classList.add('open');
    toast('CONNECTION LOST', (data.provider||'').toUpperCase() + ' session expired — fallback to FREE CORE', '⚠️');
    // instant fallback: set active brain to free core
    updateActiveBrain();
  });

  loadConnectionsStatus();
}

// ---------------------------------------------------------------------------
// GemAir 2.4 — Modes (M)
// ---------------------------------------------------------------------------
async function loadModes() {
  try {
    const list = await api.modesList();
    modesCache = {};
    for (const m of list) { modesCache[m.name] = m; }
    renderModes();
    renderSettingsModesList();
    renderPaletteModes();
    updateNowCard();
  } catch (e) {
    console.warn('[modes] load failed', e.message);
  }
}

function renderModes() {
  const container = $('#modesList');
  if (!container) return;
  const all = Object.values(modesCache);
  if (!all.length) { container.innerHTML = '<div class="empty">No modes yet — create one in Settings → Desktop & Modes</div>'; return; }
  container.innerHTML = all.map(m=>`
    <div class="mode-card ${currentMode===m.name ? 'active' : ''}" data-mode="${escapeHtml(m.name)}">
      <div class="mc-head"><span class="mc-icon">${escapeHtml(m.icon||'◍')}</span><span>${escapeHtml(m.label||m.name)}</span></div>
      <div class="mc-desc">${escapeHtml(m.description||'')}</div>
      <div class="mc-meta">
        <span>${(m.apps||[]).length} apps</span>
        <span>${(m.sites||[]).length} sites</span>
        <span>vol ${m.volume}</span>
        <span>${escapeHtml(m.theme||'')}</span>
        ${m.dnd ? '<span>DND</span>' : ''}
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button class="primary-btn" data-apply="${escapeHtml(m.name)}" style="padding:4px 10px;font-size:10px;">Apply</button>
        <button class="ghost-btn" data-del="${escapeHtml(m.name)}" style="padding:4px 8px;font-size:10px;">Delete</button>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('[data-apply]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{ e.stopPropagation(); await applyMode(btn.dataset.apply); });
  });
  container.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{ e.stopPropagation(); await api.modesDelete(btn.dataset.del); await loadModes(); toast('MODES', 'Deleted ' + btn.dataset.del, '⌫'); });
  });
  container.querySelectorAll('.mode-card').forEach(card=>{
    card.addEventListener('click', async ()=>{ await applyMode(card.dataset.mode); });
  });
}

function renderSettingsModesList() {
  const container = $('#settingsModesList');
  if (!container) return;
  const all = Object.values(modesCache);
  if (!all.length) { container.innerHTML = '<div class="empty">No modes</div>'; return; }
  container.innerHTML = all.map(m=>`
    <div class="mode-card ${currentMode===m.name ? 'active' : ''}" data-mode="${escapeHtml(m.name)}">
      <div class="mc-head"><span class="mc-icon">${escapeHtml(m.icon||'◍')}</span><span>${escapeHtml(m.label||m.name)}</span> <span class="dim" style="font-size:9px;">${escapeHtml(m.name)}</span></div>
      <div class="mc-desc">${escapeHtml(m.description||'')} — apps: ${(m.apps||[]).join(', ')} | vol ${m.volume} | theme ${m.theme}</div>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button class="primary-btn" data-apply="${escapeHtml(m.name)}" style="padding:4px 10px;font-size:10px;">Apply</button>
        <button class="ghost-btn" data-edit="${escapeHtml(m.name)}" style="padding:4px 8px;font-size:10px;">Edit</button>
        <button class="ghost-btn" data-del="${escapeHtml(m.name)}" style="padding:4px 8px;font-size:10px;">Delete</button>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('[data-apply]').forEach(btn=>{ btn.addEventListener('click', async (e)=>{ e.stopPropagation(); await applyMode(btn.dataset.apply); }); });
  container.querySelectorAll('[data-del]').forEach(btn=>{ btn.addEventListener('click', async (e)=>{ e.stopPropagation(); await api.modesDelete(btn.dataset.del); await loadModes(); }); });
  container.querySelectorAll('[data-edit]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const m = modesCache[btn.dataset.edit];
      if (!m) return;
      $('#modeNameInput').value = m.name;
      $('#modeLabelInput').value = m.label||'';
      $('#modeIconInput').value = m.icon||'🌙';
      $('#modeAppsInput').value = (m.apps||[]).join(', ');
      $('#modeVolumeInput').value = m.volume||50;
      $('#modeVolumeVal').textContent = m.volume||50;
      $('#modeThemeInput').value = m.theme||'crimson';
      $('#modePlaylistInput').value = m.playlist||'';
      $('#modeDndInput').checked = !!m.dnd;
      $('#modeGamingOptInput').checked = !!m.optimizeGaming;
      // sites
      const sitesList = $('#modeSitesList');
      if (sitesList) {
        sitesList.innerHTML = '';
        (m.sites||[]).forEach(site=>{
          addModeSiteRow(typeof site==='string'?site:site.url, typeof site==='object'?site.browser:'chrome');
        });
      }
      toast('MODE EDIT', 'Loaded ' + m.name + ' into designer — edit and save', '✏️');
    });
  });
}

function addModeSiteRow(url='', browser='chrome') {
  const list = $('#modeSitesList');
  if (!list) return;
  if (list.querySelector('.empty')) list.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'mode-site-row';
  row.innerHTML = `
    <input type="text" placeholder="https://..." value="${escapeHtml(url)}" data-site-url />
    <select data-site-browser>
      <option value="chrome" ${browser==='chrome'?'selected':''}>Chrome</option>
      <option value="firefox" ${browser==='firefox'?'selected':''}>Firefox</option>
      <option value="edge" ${browser==='edge'?'selected':''}>Edge</option>
      <option value="brave" ${browser==='brave'?'selected':''}>Brave</option>
      <option value="default" ${browser==='default'?'selected':''}>Default</option>
    </select>
    <button class="ghost-btn" data-remove style="padding:4px 8px;">✕</button>
  `;
  row.querySelector('[data-remove]')?.addEventListener('click', ()=>row.remove());
  list.appendChild(row);
}

async function saveModeFromDesigner() {
  const name = ($('#modeNameInput')?.value||'').trim().toUpperCase();
  if (!name) { toast('MODES', 'Provide mode name', '⚠️'); return; }
  const label = ($('#modeLabelInput')?.value||'').trim() || name;
  const icon = ($('#modeIconInput')?.value||'').trim() || '◍';
  const appsRaw = ($('#modeAppsInput')?.value||'').trim();
  const apps = appsRaw ? appsRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];
  const sites = [];
  $$('#modeSitesList [data-site-url]').forEach((input)=>{
    const url = input.value.trim();
    if (!url) return;
    const row = input.closest('.mode-site-row');
    const browser = row?.querySelector('[data-site-browser]')?.value || 'chrome';
    sites.push({ url, browser });
  });
  const volume = Number($('#modeVolumeInput')?.value||50);
  const theme = $('#modeThemeInput')?.value||'crimson';
  const playlist = ($('#modePlaylistInput')?.value||'').trim();
  const dnd = !!$('#modeDndInput')?.checked;
  const optimizeGaming = !!$('#modeGamingOptInput')?.checked;
  const mode = { name, label, icon, apps, sites, volume, theme, dnd, playlist, optimizeGaming, description: `${apps.length} apps, ${sites.length} sites, vol ${volume}, ${theme} theme${dnd?' + DND':''}` };
  const res = await api.modesSave(mode);
  if (res && res.error) { toast('MODES', res.error, '⚠️'); return; }
  await loadModes();
  toast('MODES', 'Saved mode ' + name, '💾');
  // sync into profile
  profile.modes = profile.modes || {};
  profile.modes[name] = mode;
  await persistProfile();
}

function modeSweep(theme) {
  const sweep = $('#modeSweep');
  if (!sweep) return;
  sweep.classList.remove('active');
  void sweep.offsetWidth;
  sweep.classList.add('active');
  setTimeout(()=>sweep.classList.remove('active'), 700);
}

async function applyMode(name) {
  const mode = modesCache[name] || (await api.modesGet(name));
  if (!mode) { toast('MODES', 'Mode not found: ' + name, '⚠️'); return; }
  currentMode = mode.name;
  profile.currentMode = mode.name;
  await persistProfile();
  // UI: topbar chip
  const curChip = $('#currentModeChip');
  if (curChip) { curChip.textContent = (mode.icon||'◍') + ' ' + mode.name; curChip.classList.add('active'); }
  const nowMode = $('#nowMode');
  if (nowMode) nowMode.textContent = mode.name;
  // Cinematic sweep using themes.js tokens
  modeSweep(mode.theme);
  // Apply theme if set
  if (mode.theme && window.GemAirThemes) {
    applyTheme(mode.theme);
    profile.theme = mode.theme;
    await persistProfile();
  }
  // Announce via TTS
  const announcement = `${mode.label||mode.name} mode activated`;
  try { speak(announcement); } catch {}
  toast('MODE', `${mode.icon||'◍'} ${mode.name} — ${mode.description||''}`, '🌟');
  // Execute via main process
  try {
    const res = await api.modesApply(mode.name);
    if (res && res.summary) {
      addMessage('system-msg', res.summary + '\n' + (res.steps||[]).map(s=>`${s.ok?'✓':'✗'} ${s.step}`).join('\n'));
    }
  } catch (e) {
    console.warn('[modes] apply failed', e.message);
  }
  renderModes();
  renderSettingsModesList();
  renderPaletteModes();
  updateNowCard();
  // log
  try { if (window.webStore && window.webStore.logAction) await window.webStore.logAction('apply_mode', 'Applied mode ' + mode.name); } catch {}
}

function renderPaletteModes() {
  const container = $('#paletteModes');
  if (!container) return;
  const all = Object.values(modesCache);
  if (!all.length) { container.innerHTML = ''; return; }
  container.innerHTML = all.slice(0,8).map(m=>`<button class="mode-chip" data-pmode="${escapeHtml(m.name)}" title="${escapeHtml(m.description||'')}">${escapeHtml(m.icon||'◍')} ${escapeHtml(m.name)}</button>`).join('');
  container.querySelectorAll('[data-pmode]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{ const name = btn.dataset.pmode; try { document.getElementById('palette').classList.remove('open'); } catch{} await applyMode(name); });
  });
}

function setupModes() {
  $('#addModeSiteBtn')?.addEventListener('click', ()=>addModeSiteRow('', 'chrome'));
  $('#saveModeBtn')?.addEventListener('click', saveModeFromDesigner);
  $('#applyModeBtn')?.addEventListener('click', async ()=>{
    const name = ($('#modeNameInput')?.value||'').trim().toUpperCase();
    if (!name) { const sel = Object.keys(modesCache)[0]; if (sel) await applyMode(sel); return; }
    // save first then apply
    await saveModeFromDesigner();
    await applyMode(name);
  });
  $('#previewModeBtn')?.addEventListener('click', ()=>{
    const theme = $('#modeThemeInput')?.value||'crimson';
    modeSweep(theme);
    playSfx('swoosh');
    toast('MODE', 'Preview sweep — ' + theme, '👁');
  });
  $('#modeVolumeInput')?.addEventListener('input', (e)=>{ const v = $('#modeVolumeVal'); if (v) v.textContent = e.target.value; });
  $$('.topbar-mode-chips .mode-chip').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      await applyMode(btn.dataset.mode);
      $$('.topbar-mode-chips .mode-chip').forEach(b=>b.classList.toggle('active', b.dataset.mode===btn.dataset.mode));
    });
  });
  if (api.onModeChanged) api.onModeChanged((data)=>{
    currentMode = data.mode;
    const curChip = $('#currentModeChip');
    if (curChip) { curChip.textContent = (data.icon||'◍') + ' ' + data.mode; curChip.classList.add('active'); }
    const nowMode = $('#nowMode');
    if (nowMode) nowMode.textContent = data.mode;
    if (data.theme) applyTheme(data.theme);
    modeSweep(data.theme||'crimson');
  });
  if (api.onDesktopVolume) api.onDesktopVolume((data)=>{
    const now = $('#nowBattery'); // actually volume? We'll update now card via generic
    updateNowCard();
  });
  if (api.onDesktopTheme) api.onDesktopTheme((data)=>{
    if (data.theme) applyTheme(data.theme);
  });
  loadModes();
}

// ---------------------------------------------------------------------------
// GemAir 2.4 — Desktop Management (A)
// ---------------------------------------------------------------------------
async function renderDesktopWindows(force=false) {
  const list = $('#desktopWindowsList');
  if (!list) return;
  if (!isElectron) { list.innerHTML = '<div class="empty">Desktop window list needs desktop app</div>'; return; }
  list.innerHTML = '<div class="empty">Scanning windows…</div>';
  try {
    const res = await api.desktopListWindows();
    const wins = res.windows || [];
    if (!wins.length) { list.innerHTML = '<div class="empty">No windows with titles found' + (res.note ? ' — ' + escapeHtml(res.note) : '') + '</div>'; return; }
    list.innerHTML = wins.map(w=>`<div class="mem-item"><span class="body"><b>${escapeHtml(w.app||'')}</b> — ${escapeHtml(w.title||'')}</span></div>`).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty">Failed: ' + escapeHtml(e.message) + '</div>';
  }
}

function setupDesktopTools() {
  $('#refreshDesktopBtn')?.addEventListener('click', ()=>{ playSfx('click'); renderDesktopWindows(true); });
  $('#testLaunchAppBtn')?.addEventListener('click', async ()=>{
    const out = $('#desktopTestOutput');
    if (out) out.innerHTML = '<div class="empty">Launching calculator…</div>';
    const res = await api.desktopLaunchApp('calculator');
    if (out) out.innerHTML = '<pre>' + escapeHtml(JSON.stringify(res, null, 2)) + '</pre>';
  });
  $('#testListWindowsBtn')?.addEventListener('click', async ()=>{
    const out = $('#desktopTestOutput');
    const res = await api.desktopListWindows();
    if (out) out.innerHTML = '<pre>' + escapeHtml(JSON.stringify(res, null, 2).slice(0,2000)) + '</pre>';
    await renderDesktopWindows(true);
  });
  $('#testMinimizeAllBtn')?.addEventListener('click', async ()=>{
    await api.desktopMinimizeAll();
    const out = $('#desktopTestOutput');
    if (out) out.innerHTML = '<div class="empty">Minimized all — Win+D</div>';
  });
  $('#testSnapLeftBtn')?.addEventListener('click', async ()=>{
    const res = await api.desktopSnapWindow('left');
    const out = $('#desktopTestOutput');
    if (out) out.innerHTML = '<pre>' + escapeHtml(JSON.stringify(res, null, 2)) + '</pre>';
  });
  $('#testSnapRightBtn')?.addEventListener('click', async ()=>{
    const res = await api.desktopSnapWindow('right');
    const out = $('#desktopTestOutput');
    if (out) out.innerHTML = '<pre>' + escapeHtml(JSON.stringify(res, null, 2)) + '</pre>';
  });
  $('#testNextDesktopBtn')?.addEventListener('click', async ()=>{
    const res = await api.desktopNextDesktop();
    const out = $('#desktopTestOutput');
    if (out) out.innerHTML = '<pre>' + escapeHtml(JSON.stringify(res, null, 2)) + '</pre>';
  });

  if (api.onDesktopFocus) api.onDesktopFocus((focused)=>{
    desktopFocused = focused;
    const appEl = $('#focusedApp');
    const titleEl = $('#focusedTitle');
    if (appEl) appEl.textContent = focused.app || '—';
    if (titleEl) titleEl.textContent = focused.title || '—';
    // update now card? no
  });

  // initial
  api.desktopGetFocused().then(f=>{ desktopFocused = f; const a=$('#focusedApp'); const t=$('#focusedTitle'); if (a) a.textContent = f.app||'—'; if (t) t.textContent = f.title||'—'; }).catch(()=>{});
  renderDesktopWindows();
}

// ---------------------------------------------------------------------------
// GemAir 2.4 — Plan-Act Loops (A1)
// ---------------------------------------------------------------------------
function isBigRequest(text) {
  const t = String(text||'').toLowerCase();
  // heuristic: contains multiple verbs or explicit steps or workspace setup
  if (/set up my workspace for|arrange.*desktop|organize.*workspace|setup.*for/.test(t)) return true;
  if (t.split(/\bthen\b|\band then\b|;/).length >= 2 && t.length > 30) return true;
  const verbs = (t.match(/\b(launch|open|set|apply|move|focus|arrange|create|organize|scaffold)\b/g)||[]).length;
  return verbs >= 3 && t.length > 40;
}

function decomposeToPlan(text) {
  const raw = String(text||'').trim();
  // Try to split by then/and then/newline
  const parts = raw.split(/(?:\s+then\s+|\s+and then\s+|\s*;\s*|\n)/i).map(s=>s.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 6) {
    return parts.map((p,i)=>({ id: i+1, text: p, status: 'pending' }));
  }
  // Mode triggers
  if (/chill mode|play soft music|lofi/.test(raw.toLowerCase())) {
    return [
      { id: 1, text: 'Launch Spotify', status: 'pending', tool: 'launch_app', args: { name: 'spotify' } },
      { id: 2, text: 'Open lofi playlist in Chrome', status: 'pending', tool: 'open_site', args: { url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', browser: 'chrome' } },
      { id: 3, text: 'Set volume to 40%', status: 'pending', tool: 'control_volume', args: { action: 'set', level: 40 } },
      { id: 4, text: 'Apply violet HUD theme', status: 'pending', tool: 'apply_mode', args: { name: 'CHILL' } }
    ];
  }
  if (/gaming setup|gaming mode|optimize.*gaming/.test(raw.toLowerCase())) {
    return [
      { id: 1, text: 'Optimize PC for gaming', status: 'pending', tool: 'optimize_gaming', args: {} },
      { id: 2, text: 'Apply GAMING mode', status: 'pending', tool: 'apply_mode', args: { name: 'GAMING' } },
      { id: 3, text: 'Launch Steam + Discord', status: 'pending', tool: 'launch_app', args: { name: 'steam' } }
    ];
  }
  if (/work mode|work setup/.test(raw.toLowerCase())) {
    return [
      { id: 1, text: 'Apply WORK mode', status: 'pending', tool: 'apply_mode', args: { name: 'WORK' } }
    ];
  }
  // Generic workspace setup
  if (/workspace for editing/.test(raw.toLowerCase())) {
    return [
      { id: 1, text: 'List current windows to see desktop state', status: 'pending', tool: 'list_windows', args: {} },
      { id: 2, text: 'Launch Premiere Pro', status: 'pending', tool: 'launch_app', args: { name: 'premiere' } },
      { id: 3, text: 'Open file explorer to project folder', status: 'pending', tool: 'launch_app', args: { name: 'explorer' } },
      { id: 4, text: 'Open reference site in Chrome', status: 'pending', tool: 'open_site', args: { url: 'https://youtube.com', browser: 'chrome' } },
      { id: 5, text: 'Snap windows left/right', status: 'pending', tool: 'snap_window', args: { direction: 'left' } }
    ];
  }
  // fallback: generic 3-step
  return [
    { id: 1, text: 'Understand scope and constraints', status: 'pending' },
    { id: 2, text: raw.slice(0,80), status: 'pending' },
    { id: 3, text: 'Verify and report outcome', status: 'pending' }
  ];
}

let activePlanAct = null;

function renderPlanAct(plan, state='preview') {
  const panel = $('#planActPanel');
  const body = $('#planActBody');
  const stateEl = $('#planActState');
  if (!panel || !body) return;
  panel.hidden = false;
  if (stateEl) stateEl.textContent = '— ' + state.toUpperCase();
  body.innerHTML = plan.map(step=>`
    <div class="plan-step-row ${step.status}" data-step="${step.id}">
      <span class="step-num">${step.id}</span>
      <span class="step-text">${escapeHtml(step.text)}</span>
      <span class="step-status">${step.status==='done'?'✓':step.status==='running'?'…':step.status==='error'?'✗':step.status==='skipped'?'–':''}</span>
    </div>
  `).join('');
  const showBtn = $('#showPlanBtn');
  const runBtn = $('#runPlanBtn');
  if (showBtn) showBtn.textContent = state==='preview' ? 'SHOW PLAN' : 'PLAN';
  if (runBtn) runBtn.textContent = state==='running' ? 'RUNNING…' : 'RUN';
  if (runBtn) runBtn.disabled = state==='running';
  const processed = plan.filter((step) => ['done', 'error', 'skipped'].includes(step.status)).length;
  if (state === 'running') showOperationProgress(`Plan step ${Math.min(plan.length, processed + 1)} of ${plan.length}`, plan.length ? processed / plan.length * 100 : 0);
  else if (state === 'done') { showOperationProgress('Plan complete', 100); hideOperationProgress(1800); }
}

async function executePlanAct(plan) {
  activePlanAct = plan;
  renderPlanAct(plan, 'running');
  const results = [];
  for (let i=0;i<plan.length;i++) {
    const step = plan[i];
    step.status = 'running';
    renderPlanAct(plan, 'running');
    let res = null;
    let ok = false;
    try {
      if (step.tool) {
        // call via main process executeTool indirectly via api? We need to call window.gemair? For now use api directly if available
        if (step.tool === 'launch_app') res = await api.desktopLaunchApp(step.args.name, step.args.args);
        else if (step.tool === 'open_site') res = await api.desktopOpenSite(step.args.url, step.args.browser);
        else if (step.tool === 'control_volume') res = await api.desktopSetVolume(step.args);
        else if (step.tool === 'snap_window') res = await api.desktopSnapWindow(step.args.direction);
        else if (step.tool === 'minimize_all') res = await api.desktopMinimizeAll();
        else if (step.tool === 'focus_app') res = await api.desktopFocusApp(step.args.name);
        else if (step.tool === 'apply_mode') res = await api.modesApply(step.args.name);
        else if (step.tool === 'list_windows') res = await api.desktopListWindows();
        else if (step.tool === 'optimize_gaming') res = await api.modesApply('GAMING');
        else res = { ok: true, note: 'step without tool' };
      } else {
        // No executable tool mapped — report honestly instead of faking success.
        step.status = 'skipped';
        renderPlanAct(plan, 'running');
        results.push({ step: step.text, ok: false, skipped: true, result: { note: 'no tool mapped' } });
        reasoningNote('tool', step.text + ' → no tool mapped, skipped');
        await sleep(120);
        continue;
      }
      ok = !(res && res.error);
    } catch (e) {
      res = { error: e.message };
      ok = false;
    }
    if (!ok) {
      // retry once
      try {
        await sleep(500);
        if (step.tool === 'launch_app') res = await api.desktopLaunchApp(step.args.name, step.args.args);
        else if (step.tool === 'open_site') res = await api.desktopOpenSite(step.args.url, step.args.browser);
        else if (step.tool === 'control_volume') res = await api.desktopSetVolume(step.args);
        else if (step.tool === 'apply_mode') res = await api.modesApply(step.args.name);
        else if (step.tool === 'list_windows') res = await api.desktopListWindows();
        else if (step.tool === 'optimize_gaming') res = await api.modesApply('GAMING');
        else if (step.tool === 'snap_window') res = await api.desktopSnapWindow(step.args.direction);
        ok = !(res && res.error);
      } catch {}
    }
    step.status = ok ? 'done' : 'error';
    step.result = res;
    results.push({ step: step.text, ok, result: res });
    renderPlanAct(plan, 'running');
    reasoningNote(ok ? 'done' : 'error', `${step.text} → ${ok?'done':'error'}`);
    await sleep(200);
  }
  renderPlanAct(plan, 'done');
  const skippedCount = results.filter((r) => r.skipped).length;
  const summary = `Mission complete — ${results.filter((r) => r.ok).length}/${results.length} steps succeeded${skippedCount ? ', ' + skippedCount + ' skipped (no tool mapped)' : ''}.`;
  toast('PLAN-ACT', summary, '✅');
  try { speak(summary); } catch {}
  // log to action log
  try { if (window.webStore && window.webStore.logAction) await window.webStore.logAction('plan_act', summary); } catch {}
  // recent missions
  recentMissions.unshift({ text: plan.map(p=>p.text).join(' → '), ts: Date.now(), summary });
  if (recentMissions.length > 10) recentMissions = recentMissions.slice(0,10);
  try { localStorage.setItem('gemair:recent-missions', JSON.stringify(recentMissions)); } catch {}
  renderRecentMissions();
  return { ok: true, steps: results, summary };
}

function renderRecentMissions() {
  const container = $('#recentMissionsList');
  if (!container) return;
  try {
    const saved = localStorage.getItem('gemair:recent-missions');
    if (saved) recentMissions = JSON.parse(saved);
  } catch {}
  if (!recentMissions.length) { container.innerHTML = '<div class="empty">No missions yet</div>'; return; }
  container.innerHTML = recentMissions.slice(0,6).map(m=>`<div class="palette-item" data-mission="${escapeHtml(m.text)}"><span class="item-main"><span class="item-icon">🚀</span><span class="item-copy">${escapeHtml(m.text.slice(0,60))}</span></span><span class="item-type">${new Date(m.ts).toLocaleTimeString()}</span></div>`).join('');
  container.querySelectorAll('[data-mission]').forEach(el=>{
    el.addEventListener('click', ()=>{ sendMessage(el.dataset.mission); document.getElementById('palette').classList.remove('open'); });
  });
}

function setupPlanAct() {
  $('#showPlanBtn')?.addEventListener('click', ()=>{
    if (planActQueue) renderPlanAct(planActQueue, 'preview');
  });
  $('#runPlanBtn')?.addEventListener('click', async ()=>{
    if (planActQueue) { const q = planActQueue; planActQueue = null; await executePlanAct(q); }
  });
  renderRecentMissions();
}

// ---------------------------------------------------------------------------
// Settings reorg (U3) + search
// ---------------------------------------------------------------------------
function setupSettingsReorg() {
  $$('.settings-nav-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $$('.settings-nav-btn').forEach(b=>b.classList.toggle('active', b===btn));
      $$('.settings-section').forEach(s=>s.classList.toggle('active', s.dataset.section===btn.dataset.ssection));
      playSfx('click');
    });
  });
  const search = $('#settingsSearch');
  if (search) {
    search.addEventListener('input', ()=>{
      const q = search.value.toLowerCase().trim();
      if (!q) {
        $$('.settings-section fieldset').forEach(fs=>fs.hidden=false);
        return;
      }
      $$('.settings-section fieldset').forEach(fs=>{
        const txt = fs.textContent.toLowerCase();
        fs.hidden = !txt.includes(q);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// NOW card (U2)
// ---------------------------------------------------------------------------
function updateNowCard() {
  const nowMode = $('#nowMode');
  const nowBrain = $('#nowBrain');
  const nowReminder = $('#nowReminder');
  const nowBattery = $('#nowBattery');
  if (nowMode) nowMode.textContent = currentMode || profile.currentMode || 'NO MODE';
  if (nowBrain) nowBrain.textContent = getActiveBrain();
  // next reminder
  const next = (memory.reminders||[]).filter(r=>!r.done).sort((a,b)=>a.at-b.at)[0];
  if (nowReminder) nowReminder.textContent = next ? `${next.text} — ${new Date(next.at).toLocaleTimeString()}` : 'No reminders';
  // battery from telemetry cache
  api.getSystemInfo().then(i=>{
    if (nowBattery) {
      if (i.battery && typeof i.battery.percent==='number') nowBattery.textContent = i.battery.percent + '%' + (i.battery.charging ? ' ⚡' : '');
      else nowBattery.textContent = 'AC / none';
    }
  }).catch(()=>{});
}

// ---------------------------------------------------------------------------
// 2.4 Boot extensions
// ---------------------------------------------------------------------------

// PWA (2.5): register the service worker so the hosted web build installs
// and runs from anywhere — phones, tablets, other laptops. Electron and the
// fake-DOM selfcheck both skip this safely.
try {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    addLifecycleListener(window, 'load', () => { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch {} });
  }
} catch {}

document.addEventListener('DOMContentLoaded', boot);
