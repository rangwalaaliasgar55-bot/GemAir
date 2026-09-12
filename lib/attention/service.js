'use strict';
/* Gem Air — attention service. The spine that wires every engine together.
   detection -> classification -> blocking -> tracking -> island state. */

const { EventEmitter } = require('events');
const { createStore } = require('./store');
const { Detector } = require('./native/detector');
const enforcer = require('./native/enforcer');
const { BrowserBridge } = require('./bridge');
const classify = require('./core/classify');
const blocking = require('./core/blocking');
const schedule = require('./core/schedule');
const tracking = require('./core/tracking');

const IDLE_CONTEXT = {
  app: 'idle', appLabel: 'Idle', title: '', kind: 'app', site: '', subject: 'idle',
  categoryId: 'other', categoryLabel: 'Idle', categoryColor: '#5b6675', relevance: 'idle', known: true
};

class AttentionService extends EventEmitter {
  constructor({ userDataDir, notify } = {}) {
    super();
    this.store = createStore(userDataDir);
    this.notify = notify || (() => {});
    this.detector = new Detector({ intervalMs: this.state.settings.pollIntervalMs });
    this.bridge = new BrowserBridge({
      onTab: (tab) => this.onBrowserTab(tab),
      onAttempt: (a) => this.recordAttempt({ ...a, kind: 'site', source: 'extension' }),
      getPolicy: () => blocking.browserPolicy(this.state, new Date())
    });
    this.activeTab = null;          // { url, title, browser, at }
    this.context = null;            // last classified context
    this.lastSampleAt = 0;
    this.currentSince = Date.now();
    this.timerStart = null;
    this.island = { mode: 'compact', status: 'idle' };
    this.question = null;           // pending "what is this for?"
    this.askedThisSession = new Set();
    this.enforceInFlight = new Set();
  }

  get state() { return this.store.get(); }

  // ---------- lifecycle ----------
  async start() {
    this.detector.onSample((s) => this.onSample(s));
    this.detector.start();
    await this.bridge.start();
    this.scheduleTimer = setInterval(() => this.emitState(), 15000);
    if (this.scheduleTimer.unref) this.scheduleTimer.unref();
    return this.snapshot();
  }

  stop() {
    this.detector.stop();
    this.bridge.stop();
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.store.flush();
  }

  // ---------- detection -> context ----------
  onBrowserTab(tab) {
    if (!tab || !tab.url) return;
    this.activeTab = { url: tab.url, title: tab.title || '', browser: tab.browser || 'chrome', at: Date.now() };
    if (this.detector.last) this.onSample({ ...this.detector.last, at: Date.now() });
  }

  onSample(sample) {
    const now = sample.at || Date.now();
    const idleAfter = this.state.settings.idleAfterSeconds;
    const isIdle = (sample.idleSeconds || 0) >= idleAfter;

    // Only trust the extension tab if it is fresh and the foreground app is a browser.
    const browserFg = classify.isBrowserProcess(sample.app);
    const freshTab = this.activeTab && now - this.activeTab.at < 60_000;
    const enriched = {
      app: sample.app,
      title: sample.title,
      pid: sample.pid,
      url: browserFg && freshTab ? this.activeTab.url : ''
    };

    const context = isIdle ? { ...IDLE_CONTEXT } : classify.classify(this.state, enriched);
    const decision = isIdle ? { blocked: false } : blocking.evaluate(this.state, context, new Date(now));
    context.blocked = !!decision.blocked;
    context.blockReason = decision.reason || null;
    context.blockSource = decision.source || null;
    context.protectedBlock = !!decision.protectedBlock;

    // Account time against the PREVIOUS context.
    if (this.context && this.lastSampleAt) {
      const delta = Math.min(now - this.lastSampleAt, 5 * 60_000);
      if (delta > 0) this.store.update((s) => tracking.record(s, this.context, now, delta));
    }
    const changed = !this.context || this.context.subject !== context.subject || this.context.blocked !== context.blocked || this.context.relevance !== context.relevance;
    if (changed) this.currentSince = now;
    this.context = context;
    this.lastSampleAt = now;

    if (decision.blocked) this.handleBlocked(context, decision);
    else if (changed) this.maybeAsk(context);

    this.emitState();
  }

  // ---------- blocking ----------
  async handleBlocked(context, decision) {
    this.recordAttempt({
      kind: context.kind,
      subject: context.subject,
      label: context.kind === 'site' ? context.site : context.appLabel,
      reason: decision.reason,
      source: decision.source,
      at: Date.now()
    });
    if (context.kind === 'app' && context.app && !this.enforceInFlight.has(context.app)) {
      this.enforceInFlight.add(context.app);
      const result = await enforcer.closeApp(context.app, { force: false });
      setTimeout(() => this.enforceInFlight.delete(context.app), 8000);
      this.emit('enforced', { target: context.app, result });
    }
    // Site enforcement is performed by the extension, which polls /policy.
    if (this.state.settings.notifications) {
      this.notify({ title: 'Blocked', body: `${context.kind === 'site' ? context.site : context.appLabel} — ${decision.reason}` });
    }
  }

  recordAttempt(attempt) {
    const entry = { id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ...attempt };
    this.store.update((s) => {
      s.attempts.push(entry);
      if (s.attempts.length > 500) s.attempts.splice(0, s.attempts.length - 500);
      return s;
    });
    this.emit('attempt', entry);
    return entry;
  }

  // ---------- learning ("what is this for?") ----------
  maybeAsk(context) {
    if (!this.state.settings.askUnknownApps) return;
    if (context.known || context.relevance === 'idle') return;
    if (!context.subject || context.subject === 'unknown') return;
    const key = context.kind + ':' + context.subject;
    if (this.askedThisSession.has(key)) return;
    this.askedThisSession.add(key);
    this.question = {
      id: 'q' + Date.now().toString(36),
      kind: context.kind,
      subject: context.subject,
      label: context.kind === 'site' ? context.site : context.appLabel,
      prompt: 'What is this for?',
      at: Date.now()
    };
    this.emit('question', this.question);
  }

  answerQuestion(questionId, categoryId) {
    const q = this.question;
    if (!q || (questionId && q.id !== questionId)) return { ok: false, error: 'no pending question' };
    this.store.update((s) => classify.learn(s, { kind: q.kind, subject: q.subject, categoryId }));
    this.question = null;
    if (this.detector.last) this.onSample({ ...this.detector.last, at: Date.now() });
    return { ok: true, learned: { subject: q.subject, categoryId } };
  }

  dismissQuestion() { this.question = null; this.emitState(); return { ok: true }; }

  createCategory({ label, color, relevance }) {
    const id = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('cat' + Date.now().toString(36));
    this.store.update((s) => {
      if (!s.categories.find((c) => c.id === id)) {
        s.categories.push({ id, label: String(label || id), color: color || '#7c5cff', relevance: relevance || 'neutral', builtin: false });
      }
      return s;
    });
    return this.state.categories.find((c) => c.id === id);
  }

  // ---------- island state ----------
  islandState(now = new Date()) {
    const ctx = this.context;
    const sleep = schedule.sleepStatus(this.state.sleep, now);
    const activeBlocks = schedule.activePlanBlocks(this.state.plans, now);
    const focusBlock = activeBlocks.find((b) => b.kind === 'focus') || null;
    const elapsed = ctx ? Date.now() - this.currentSince : 0;

    let mode = 'working';
    if (this.question) mode = 'question';
    else if (ctx && ctx.blocked) mode = 'blocked';
    else if (sleep.active) mode = 'sleep';
    else if (ctx && ctx.relevance === 'idle') mode = 'idle';
    else if (ctx && ctx.relevance === 'distraction') mode = 'distraction';

    return {
      mode,
      primary: this.question ? this.question.prompt : ctx ? (ctx.kind === 'site' ? ctx.site : ctx.appLabel) : 'Gem Air',
      secondary: this.question ? null
        : mode === 'blocked' ? 'Blocked'
        : mode === 'sleep' ? `Sleep until ${sleep.end}`
        : ctx ? ctx.categoryLabel : 'Ready',
      relevance: ctx ? ctx.relevance : 'neutral',
      color: ctx ? ctx.categoryColor : '#8ea0b5',
      elapsedMs: elapsed,
      timerLabel: formatDuration(elapsed),
      question: this.question,
      blocked: ctx ? !!ctx.blocked : false,
      blockReason: ctx ? ctx.blockReason : null,
      protectedBlock: ctx ? !!ctx.protectedBlock : false,
      sleep,
      focusBlock,
      next: schedule.nextEvent(this.state, now),
      browser: this.bridge.status(),
      urlSource: ctx ? ctx.urlSource : 'none'
    };
  }

  snapshot() {
    const now = new Date();
    const today = tracking.dayKey(Date.now());
    return {
      island: this.islandState(now),
      context: this.context,
      summary: tracking.summarize(this.state, today),
      lastHour: tracking.lastHour(this.state),
      capabilities: { ...enforcer.capabilities, detector: this.detector.supported, platform: process.platform },
      bridge: this.bridge.status()
    };
  }

  emitState() {
    const snap = this.snapshot();
    this.emit('state', snap);
    return snap;
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

module.exports = { AttentionService, formatDuration };
