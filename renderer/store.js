/* ============================================================
   GemAI — browser memory store.
   Local-first (localStorage, works free & offline) with an OPTIONAL
   Supabase mirror for cross-device persistence on the Vercel deploy.
   ============================================================ */
(function () {
  'use strict';

  const LS_MEMORY = 'gemai:memory';
  const LS_PROFILE = 'gemai:profile';

  const EMPTY = { facts: [], transcript: [], notes: [], reminders: [], todos: [], mood: [], goals: [], skills: [], instructions: [], actionLog: [], summary: '' };

  function read(key, fb) {
    try { return JSON.parse(localStorage.getItem(key)) || fb; } catch { return fb; }
  }
  function write(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
  }
  function uid() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
  function getMemory() {
    const m = read(LS_MEMORY, EMPTY);
    for (const k of Object.keys(EMPTY)) if (!Array.isArray(m[k])) m[k] = EMPTY[k].slice();
    return m;
  }

  let sb = null; // Supabase client (optional)

  function mirror(m) {
    if (!sb) return;
    (async () => {
      try {
        await sb.from('facts').upsert(m.facts.map(f => ({ id: f.id, text: f.text, category: f.category || 'fact', importance: f.importance || 1 })), { onConflict: 'id' });
        await sb.from('notes').upsert(m.notes.map(n => ({ id: n.id, text: n.text })), { onConflict: 'id' });
        await sb.from('reminders').upsert(m.reminders.map(r => ({ id: r.id, text: r.text, at: r.at, done: r.done })), { onConflict: 'id' });
        await sb.from('todos').upsert(m.todos.map(t => ({ id: t.id || uid(), text: t.text, done: t.done })), { onConflict: 'id' });
        await sb.from('mood').upsert(m.mood.map((x, i) => ({ id: x.id || ('mood-' + x.ts + '-' + i), emotion: x.emotion, valence: x.valence, note: x.note || '', ts: x.ts })), { onConflict: 'id' });
        await sb.from('goals').upsert(m.goals.map(g => ({ id: g.id, text: g.text, category: g.category || 'personal', done: g.done })), { onConflict: 'id' });
        await sb.from('action_log').upsert(m.actionLog.map(a => ({ id: a.id || uid(), action: a.action, detail: a.detail || '', ts: a.ts })), { onConflict: 'id' });
        await sb.from('skills').upsert(m.skills.map(s => ({ id: s.id || uid(), name: s.name || '', text: s.text })), { onConflict: 'id' });
        await sb.from('instructions').upsert(m.instructions.map(i => ({ id: i.id || uid(), text: i.text })), { onConflict: 'id' });
      } catch (e) { /* mirroring is best-effort */ }
    })();
  }

  function setMemory(m) {
    write(LS_MEMORY, m);
    mirror(m);
  }

  const store = {
    async get() { return getMemory(); },
    async append(role, content) {
      const m = getMemory();
      m.transcript.push({ role, content, ts: Date.now() });
      if (m.transcript.length > 2000) m.transcript = m.transcript.slice(-2000);
      setMemory(m); return true;
    },
    async clearTranscript() { const m = getMemory(); m.transcript = []; setMemory(m); return true; },
    async addFact(fact) {
      const m = getMemory();
      const text = typeof fact === 'string' ? fact : fact.text;
      const norm = String(text).toLowerCase().replace(/[^\w\s]/g, '');
      const ex = m.facts.find(f => f.text.toLowerCase().replace(/[^\w\s]/g, '') === norm);
      if (ex) { ex.importance = (ex.importance || 1) + 1; ex.updated = Date.now(); }
      else m.facts.push({ id: uid(), text, category: (typeof fact === 'string' ? 'fact' : fact.category) || 'fact', importance: 1, created: Date.now(), updated: Date.now() });
      setMemory(m); return true;
    },
    async deleteFact(id) { const m = getMemory(); m.facts = m.facts.filter(f => f.id !== id); setMemory(m); return true; },
    async addNote(text) { const m = getMemory(); m.notes.unshift({ id: uid(), text, created: Date.now() }); setMemory(m); return true; },
    async deleteNote(id) { const m = getMemory(); m.notes = m.notes.filter(n => n.id !== id); setMemory(m); return true; },
    async addReminder(text, at) { const m = getMemory(); m.reminders.push({ id: uid(), text, at, done: false, notified: false, created: Date.now() }); setMemory(m); return true; },
    async deleteReminder(id) { const m = getMemory(); m.reminders = m.reminders.filter(r => r.id !== id); setMemory(m); return true; },
    async markReminder(id, done) { const m = getMemory(); const r = m.reminders.find(x => x.id === id); if (r) { r.done = !!done; r.notified = false; } setMemory(m); return true; },
    async addTodo(text) { const m = getMemory(); m.todos.unshift({ id: uid(), text, done: false }); setMemory(m); return true; },
    async addMood(emotion, note) {
      const m = getMemory();
      const valence = ({ joy: 1, excitement: 1, love: 0.9, gratitude: 0.9, confident: 0.8, curiosity: 0.25, boredom: -0.3, tired: -0.4, anxiety: -0.6, sadness: -0.7, fear: -0.7, anger: -0.8, hope: 0.7, relief: 0.8, embarrassed: -0.4, guilty: -0.5, neutral: 0 }[emotion]) || 0;
      m.mood.push({ id: uid(), emotion, valence, note: note || '', ts: Date.now() });
      if (m.mood.length > 500) m.mood = m.mood.slice(-500);
      setMemory(m); return true;
    },
    async addGoal(text, category) { const m = getMemory(); m.goals.unshift({ id: uid(), text, category: category || 'personal', done: false, created: Date.now() }); setMemory(m); return true; },
    async deleteGoal(id) { const m = getMemory(); m.goals = m.goals.filter(g => g.id !== id); setMemory(m); return true; },
    async toggleGoal(id) { const m = getMemory(); const g = m.goals.find(x => x.id === id); if (g) g.done = !g.done; setMemory(m); return true; },
    async logAction(action, detail) {
      const m = getMemory();
      m.actionLog.unshift({ id: uid(), action, detail: String(detail || '').slice(0, 300), ts: Date.now() });
      if (m.actionLog.length > 200) m.actionLog = m.actionLog.slice(0, 200);
      setMemory(m); return true;
    },
    async addSkill(text, name) { const m = getMemory(); m.skills.unshift({ id: uid(), name: name || '', text, created: Date.now() }); setMemory(m); return true; },
    async deleteSkill(id) { const m = getMemory(); m.skills = m.skills.filter(s => s.id !== id); setMemory(m); return true; },
    async addInstruction(text) { const m = getMemory(); m.instructions.unshift({ id: uid(), text, created: Date.now() }); setMemory(m); return true; },
    async deleteInstruction(id) { const m = getMemory(); m.instructions = m.instructions.filter(i => i.id !== id); setMemory(m); return true; },
    async getProfile() { return read(LS_PROFILE, {}); },
    async setProfile(d) { write(LS_PROFILE, d); return true; },

    // optional Supabase: cloud mirror for cross-device persistence
    async initSupabase(config) {
      if (!config || !config.url || !config.anonKey) return false;
      try {
        if (!window.supabase || !window.supabase.createClient) return false;
        sb = window.supabase.createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
        const { error } = await sb.auth.signInAnonymously();
        if (error) { sb = null; return false; }
        // seed local from cloud on first load (best-effort)
        const m = getMemory();
        try {
          if (!m.facts.length) {
            const { data } = await sb.from('facts').select('*').order('importance', { ascending: false }).limit(300);
            if (data && data.length) {
              m.facts = data.map(r => ({ id: r.id, text: r.text, category: r.category, importance: r.importance || 1, created: Date.parse(r.created_at) || Date.now(), updated: Date.now() }));
              write(LS_MEMORY, m);
            }
          }
          if (!m.notes.length) {
            const { data } = await sb.from('notes').select('*').limit(200);
            if (data && data.length) { m.notes = data.map(r => ({ id: r.id, text: r.text, created: Date.parse(r.created_at) || Date.now() })); write(LS_MEMORY, m); }
          }
          if (!m.goals.length) {
            const { data } = await sb.from('goals').select('*').limit(200);
            if (data && data.length) { m.goals = data.map(r => ({ id: r.id, text: r.text, category: r.category, done: r.done })); write(LS_MEMORY, m); }
          }
          if (!m.mood.length) {
            const { data } = await sb.from('mood').select('*').order('ts', { ascending: false }).limit(200);
            if (data && data.length) { m.mood = data.map(r => ({ id: r.id, emotion: r.emotion, valence: r.valence, note: r.note || '', ts: r.ts })); write(LS_MEMORY, m); }
          }
        } catch (e) {}
        return true;
      } catch { sb = null; return false; }
    }
  };

  window.webStore = store;
})();
