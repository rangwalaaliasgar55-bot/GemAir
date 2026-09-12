'use strict';
/* Gem Air — IPC surface for the attention layer.
   Every handler is namespaced `air:` and validates its input. */

const tracking = require('./core/tracking');
const schedule = require('./core/schedule');
const blocking = require('./core/blocking');
const enforcer = require('./native/enforcer');

function id(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function str(v, max = 200) { return String(v == null ? '' : v).slice(0, max); }
function arr(v) { return Array.isArray(v) ? v : []; }

function register(ipcMain, service, { broadcast, openIsland, setIslandVisible, openExternal } = {}) {
  const state = () => service.state;
  const save = (fn) => { service.store.update(fn); service.store.flush(); return { ok: true }; };

  ipcMain.handle('air:snapshot', () => service.snapshot());
  ipcMain.handle('air:state', () => ({
    categories: state().categories,
    appRules: state().appRules,
    siteRules: state().siteRules,
    blocks: state().blocks,
    plans: state().plans,
    sleep: state().sleep,
    settings: state().settings,
    attempts: state().attempts.slice(-100).reverse()
  }));

  // --- dashboard / activity ---
  ipcMain.handle('air:summary', (_e, day) => tracking.summarize(state(), day || tracking.dayKey(Date.now())));
  ipcMain.handle('air:timeline', (_e, day) => tracking.timeline(state(), day || tracking.dayKey(Date.now())));
  ipcMain.handle('air:trend', (_e, days) => tracking.trend(state(), Math.min(Math.max(Number(days) || 7, 1), 60)));
  ipcMain.handle('air:recent', (_e, limit) => tracking.recent(state(), Math.min(Math.max(Number(limit) || 20, 1), 200)));
  ipcMain.handle('air:lastHour', () => tracking.lastHour(state()));

  // --- classification ---
  ipcMain.handle('air:answer', (_e, questionId, categoryId) => {
    const result = service.answerQuestion(str(questionId, 64), str(categoryId, 64));
    service.store.flush();
    return result;
  });
  ipcMain.handle('air:dismissQuestion', () => service.dismissQuestion());
  ipcMain.handle('air:createCategory', (_e, payload) => {
    const cat = service.createCategory({
      label: str(payload && payload.label, 40),
      color: str(payload && payload.color, 20),
      relevance: ['focus', 'distraction', 'neutral'].includes(payload && payload.relevance) ? payload.relevance : 'neutral'
    });
    service.store.flush();
    return cat;
  });
  ipcMain.handle('air:deleteCategory', (_e, categoryId) => save((s) => {
    s.categories = s.categories.filter((c) => c.id !== categoryId || c.builtin);
    return s;
  }));
  ipcMain.handle('air:classify', (_e, payload) => {
    const kind = payload && payload.kind === 'site' ? 'site' : 'app';
    save((s) => require('./core/classify').learn(s, { kind, subject: str(payload && payload.subject, 120), categoryId: str(payload && payload.categoryId, 64) }));
    return service.emitState();
  });
  ipcMain.handle('air:deleteRule', (_e, kind, match) => save((s) => {
    const list = kind === 'site' ? 'siteRules' : 'appRules';
    s[list] = s[list].filter((r) => r.match !== match);
    return s;
  }));

  // --- blocking ---
  ipcMain.handle('air:addBlock', (_e, payload) => {
    const kind = payload && payload.kind === 'site' ? 'sites' : 'apps';
    const rule = {
      id: id('b'),
      target: str(payload && payload.target, 120).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      reason: str(payload && payload.reason, 200) || null,
      protected: !!(payload && payload.protected),
      enabled: true,
      schedule: payload && payload.schedule ? { start: str(payload.schedule.start, 5), end: str(payload.schedule.end, 5), days: arr(payload.schedule.days) } : null,
      createdAt: Date.now()
    };
    if (!rule.target) return { ok: false, error: 'target required' };
    save((s) => { s.blocks[kind].push(rule); return s; });
    return { ok: true, rule };
  });
  ipcMain.handle('air:removeBlock', (_e, kind, ruleId) => save((s) => {
    const key = kind === 'site' ? 'sites' : 'apps';
    s.blocks[key] = s.blocks[key].filter((r) => r.id !== ruleId);
    return s;
  }));
  ipcMain.handle('air:toggleBlock', (_e, kind, ruleId, enabled) => save((s) => {
    const key = kind === 'site' ? 'sites' : 'apps';
    const rule = s.blocks[key].find((r) => r.id === ruleId);
    // A protected block cannot be switched off while it is active.
    if (rule && !(rule.protected && enabled === false)) rule.enabled = !!enabled;
    return s;
  }));
  ipcMain.handle('air:addException', (_e, payload) => {
    const ex = {
      id: id('e'),
      kind: payload && payload.kind === 'site' ? 'site' : 'app',
      target: str(payload && payload.target, 120).toLowerCase(),
      reason: str(payload && payload.reason, 200) || null,
      until: payload && payload.minutes ? Date.now() + Math.min(Number(payload.minutes) || 0, 720) * 60000 : null,
      overridesProtected: false,
      createdAt: Date.now()
    };
    if (!ex.target) return { ok: false, error: 'target required' };
    save((s) => { s.blocks.exceptions.push(ex); return s; });
    return { ok: true, exception: ex };
  });
  ipcMain.handle('air:removeException', (_e, exId) => save((s) => {
    s.blocks.exceptions = s.blocks.exceptions.filter((e) => e.id !== exId);
    return s;
  }));
  ipcMain.handle('air:attempts', (_e, limit) => state().attempts.slice(-(Math.min(Number(limit) || 50, 500))).reverse());
  ipcMain.handle('air:capabilities', () => ({ ...enforcer.capabilities, platform: process.platform, detector: service.detector.supported }));
  ipcMain.handle('air:systemBlockRequest', async (_e, hosts) => enforcer.blockSiteSystemWide(arr(hosts).map((h) => str(h, 120))));

  // --- plans ---
  ipcMain.handle('air:savePlan', (_e, plan) => {
    const p = {
      id: str(plan && plan.id, 40) || id('p'),
      name: str(plan && plan.name, 60) || 'Plan',
      enabled: plan ? plan.enabled !== false : true,
      days: arr(plan && plan.days).map(Number).filter((d) => d >= 0 && d <= 6),
      blocks: arr(plan && plan.blocks).slice(0, 24).map((b) => ({
        start: str(b.start, 5), end: str(b.end, 5),
        kind: b.kind === 'break' ? 'break' : 'focus',
        label: str(b.label, 60) || 'Focus'
      })),
      rules: {
        strict: !!(plan && plan.rules && plan.rules.strict),
        protected: !(plan && plan.rules && plan.rules.protected === false),
        allowedApps: arr(plan && plan.rules && plan.rules.allowedApps).map((v) => str(v, 80)),
        blockedApps: arr(plan && plan.rules && plan.rules.blockedApps).map((v) => str(v, 80)),
        allowedSites: arr(plan && plan.rules && plan.rules.allowedSites).map((v) => str(v, 120)),
        blockedSites: arr(plan && plan.rules && plan.rules.blockedSites).map((v) => str(v, 120)),
        allowedCategories: arr(plan && plan.rules && plan.rules.allowedCategories).map((v) => str(v, 40)),
        blockedCategories: arr(plan && plan.rules && plan.rules.blockedCategories).map((v) => str(v, 40))
      }
    };
    save((s) => {
      const i = s.plans.findIndex((x) => x.id === p.id);
      if (i >= 0) s.plans[i] = p; else s.plans.push(p);
      return s;
    });
    service.emitState();
    return { ok: true, plan: p };
  });
  ipcMain.handle('air:deletePlan', (_e, planId) => { save((s) => { s.plans = s.plans.filter((p) => p.id !== planId); return s; }); service.emitState(); return { ok: true }; });
  ipcMain.handle('air:togglePlan', (_e, planId, enabled) => {
    save((s) => { const p = s.plans.find((x) => x.id === planId); if (p) p.enabled = !!enabled; return s; });
    return service.emitState();
  });
  ipcMain.handle('air:activeBlocks', () => schedule.activePlanBlocks(state().plans, new Date()));

  // --- sleep ---
  ipcMain.handle('air:setSleep', (_e, sleep) => {
    save((s) => {
      s.sleep = {
        ...s.sleep,
        enabled: !!(sleep && sleep.enabled),
        start: str(sleep && sleep.start, 5) || s.sleep.start,
        end: str(sleep && sleep.end, 5) || s.sleep.end,
        days: arr(sleep && sleep.days).map(Number).filter((d) => d >= 0 && d <= 6),
        blockCategories: arr(sleep && sleep.blockCategories).map((v) => str(v, 40)),
        blockApps: arr(sleep && sleep.blockApps).map((v) => str(v, 80)),
        blockSites: arr(sleep && sleep.blockSites).map((v) => str(v, 120))
      };
      return s;
    });
    return service.emitState();
  });
  ipcMain.handle('air:sleepStatus', () => schedule.sleepStatus(state().sleep, new Date()));

  // --- settings / browser bridge ---
  ipcMain.handle('air:setSettings', (_e, patch) => {
    save((s) => { s.settings = { ...s.settings, ...(patch && typeof patch === 'object' ? patch : {}) }; return s; });
    if (patch && typeof patch.pollIntervalMs === 'number') {
      service.detector.stop();
      service.detector.intervalMs = Math.min(Math.max(patch.pollIntervalMs, 1000), 15000);
      service.detector.start();
    }
    return state().settings;
  });
  ipcMain.handle('air:setStartup', async (_e, enabled) => {
    const r = await enforcer.setLaunchAtStartup(!!enabled);
    save((s) => { s.settings.launchAtStartup = !!enabled && r.ok; return s; });
    return r;
  });
  ipcMain.handle('air:bridgeStatus', () => service.bridge.status());
  ipcMain.handle('air:bridgePair', () => ({ code: service.bridge.newPairCode(), port: service.bridge.port }));
  ipcMain.handle('air:browserPolicy', () => blocking.browserPolicy(state(), new Date()));

  // --- island window ---
  ipcMain.handle('air:island', (_e, action, payload) => {
    if (action === 'show' && setIslandVisible) return setIslandVisible(true);
    if (action === 'hide' && setIslandVisible) return setIslandVisible(false);
    if (action === 'open' && openIsland) return openIsland(payload);
    if (action === 'position') {
      save((s) => { s.settings.islandPosition = payload || null; return s; });
      return { ok: true };
    }
    return { ok: false };
  });
  ipcMain.handle('air:openFocusx', (_e, path) => {
    const base = state().settings.focusxSite || 'https://focusx.site';
    const url = path && /^[a-z0-9/_-]*$/i.test(path) ? base.replace(/\/$/, '') + '/' + String(path).replace(/^\//, '') : base;
    if (openExternal) openExternal(url);
    return { ok: true, url };
  });
  ipcMain.handle('air:export', () => ({ exportedAt: Date.now(), state: state() }));
  ipcMain.handle('air:resetActivity', () => save((s) => { s.activity = { days: {} }; s.attempts = []; return s; }));

  service.on('state', (snap) => broadcast && broadcast('air:update', snap));
  service.on('question', (q) => broadcast && broadcast('air:question', q));
  service.on('attempt', (a) => broadcast && broadcast('air:attempt', a));
  service.on('enforced', (e) => broadcast && broadcast('air:enforced', e));
}

module.exports = { register };
