/* Gem Air island — renderer.
   compact -> contextual info -> user decision -> system remembers -> state changes.
   Contract: window.air (preload) — islandResize/openMain/onUpdate/onQuestion/
   snapshot/state/answer/dismissQuestion/createCategory. */
'use strict';

const api = window.air;
const el = (id) => document.getElementById(id);
const island = el('island');

let snapshot = null;
let expanded = false;
let categories = [];
let pickedColor = '#0a84ff';
let localTimerBase = { ms: 0, at: Date.now() };
let currentQuestion = null;

const COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff453a', '#bf5af2', '#5ac8fa'];

// GemAir's own tabs, so the island can say which section the app is in.
const VIEW_LABEL = {
  assistant: 'Assistant', core: 'Workspace', companion: 'Tasks & Goals',
  town: 'Automations', attention: 'Gem Air', world: 'Discover',
  dashboard: 'Dashboard', settings: 'Settings'
};

const MODE_LABEL = {
  working: 'Focusing',
  distraction: 'Distracted',
  blocked: 'Blocked',
  idle: 'Idle',
  sleep: 'Sleeping',
  question: 'Check-in'
};

function setExpanded(next, opts = {}) {
  if (expanded === next) return;
  expanded = next;
  island.classList.toggle('expanded', expanded);
  island.classList.toggle('compact', !expanded);
  el('capsule').setAttribute('aria-expanded', String(expanded));
  try { api.islandResize(expanded ? 'expanded' : 'compact'); } catch {}
  // In the preview harness the island runs in an iframe; tell the host to resize it.
  if (window.parent !== window) {
    try { window.parent.postMessage({ type: 'gemair:islandResize', mode: expanded ? 'expanded' : 'compact' }, '*'); } catch {}
  }
  if (expanded && !opts.keepFocus) {
    try { el('btn-collapse').focus({ preventScroll: true }); } catch {}
  }
}

/* ---------- interactions ---------- */
el('capsule').addEventListener('click', (e) => {
  // Click (not drag) toggles. Electron only fires click when the pointer
  // didn't move, so dragging the pill never expands it.
  if (e.detail === 0) return; // keyboard activation is handled on keydown
  setExpanded(!expanded);
});
el('capsule').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    setExpanded(!expanded, { keepFocus: true });
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && expanded) {
    e.preventDefault();
    setExpanded(false, { keepFocus: true });
    try { el('capsule').focus({ preventScroll: true }); } catch {}
  }
});
el('btn-collapse').addEventListener('click', () => setExpanded(false, { keepFocus: true }));
el('tab-list')?.addEventListener('click', async (event) => {
  const row = event.target && event.target.closest ? event.target.closest('.tab-item') : null;
  if (!row) return;
  try {
    const result = await api.focusTab({ app: row.dataset.app, title: row.dataset.title, kind: row.dataset.kind });
    if (!result || result.ok === false) throw new Error((result && result.error) || 'Could not raise that window');
    confirm(`Back to ${row.dataset.app || 'that window'}.`);
    setExpanded(false, { keepFocus: true });
  } catch (error) {
    confirm(error.message || 'That window could not be raised.');
  }
});
el('btn-dashboard').addEventListener('click', () => api.openMain('dashboard'));
el('btn-focus').addEventListener('click', async () => {
  const active = snapshot && snapshot.island && snapshot.island.focusBlock;
  try {
    if (active && active.planId === 'gem-air-quick-focus') {
      await api.deletePlan('gem-air-quick-focus');
      confirm('Quick focus stopped.');
    } else {
      const result = await api.startFocus(25);
      if (!result || result.ok === false) throw new Error((result && result.error) || 'Could not start focus');
      confirm('25-minute focus started · distractions are being tracked.');
    }
    render(await api.snapshot());
  } catch (error) {
    confirm(error.message || 'Focus action unavailable.');
  }
});
document.querySelectorAll('[data-nav]').forEach((b) => {
  b.addEventListener('click', () => api.openMain(b.dataset.nav));
});
el('q-dismiss').addEventListener('click', async () => {
  el('question').hidden = true;
  currentQuestion = null;
  try { await api.dismissQuestion(); } catch {}
  try { render(await api.snapshot()); } catch {}
});

/* ---------- formatting ---------- */
function fmt(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtCompact(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/* ---------- render ---------- */
function render(snap) {
  if (!snap) return;
  snapshot = snap;
  const is = snap.island;
  island.dataset.mode = is.mode;
  island.classList.remove('loading');
  localTimerBase = { ms: is.elapsedMs || 0, at: Date.now() };
  const ticking = is.mode === 'working' || is.mode === 'distraction';

  // The pill used to answer "Work" — a category. People asked for the tab, so
  // the title wins when we have one and the category moves to the meta line.
  const tabLabel = is.tab && is.tab.label && is.tab.label.trim() ? is.tab.label.trim() : '';
  const pillSubject = tabLabel ? (tabLabel.length > 38 ? `${tabLabel.slice(0, 37)}…` : tabLabel) : (is.primary || 'Gem Air');
  el('subject').textContent = pillSubject;
  el('meta').textContent = [is.secondary || MODE_LABEL[is.mode] || '', tabLabel && is.primary && is.primary !== tabLabel ? is.primary : ''].filter(Boolean).join(' · ');
  el('timer').textContent = ticking ? fmtCompact(is.elapsedMs) : '';
  el('capsule').setAttribute('aria-label',
    `Gem Air status: ${is.primary}. ${is.secondary || MODE_LABEL[is.mode] || ''}. Activate to ${expanded ? 'collapse' : 'expand'} details.`);

  // Site chip: the real host (e.g. youtube.com) in the compact pill. Only
  // shown when we actually know a site — with the extension paired it is the
  // exact tab; without it we fall back to the window-title guess.
  const siteChip = el('site-chip');
  if (siteChip) {
    const site = is.tab && is.tab.site ? String(is.tab.site).replace(/^www\./, '') : '';
    const live = !!(is.tab && is.tab.source === 'extension');
    if (site) {
      siteChip.hidden = false;
      siteChip.textContent = site;
      siteChip.title = live ? 'Exact tab from the browser extension' : 'Inferred from the window title — pair the extension for the exact tab';
      siteChip.style.setProperty('--chip-fg', is.color || '');
      siteChip.style.setProperty('--chip-bg', hexA(is.color || '#ffffff', 0.14));
      siteChip.style.setProperty('--chip-line', hexA(is.color || '#ffffff', 0.35));
    } else {
      siteChip.hidden = true;
    }
  }

  el('status-pill').textContent = is.blocked ? 'Blocked' : (MODE_LABEL[is.mode] || 'Idle');
  el('ctx-subject').textContent = is.primary;
  const chip = el('ctx-chip');
  chip.textContent = is.secondary || MODE_LABEL[is.mode] || '—';
  chip.style.background = hexA(is.color, 0.16);
  chip.style.color = is.color || '';
  el('ctx-sub').textContent = subline(snap);
  el('ctx-timer').textContent = fmt(is.elapsedMs);

  renderProgress(is.focusBlock);
  renderTabs(is);

  const plan = is.focusBlock;
  const focusButton = el('btn-focus');
  const focusLabel = el('focus-label');
  const quickFocus = plan && plan.planId === 'gem-air-quick-focus';
  if (focusButton) focusButton.classList.toggle('active', !!quickFocus);
  if (focusLabel) focusLabel.textContent = quickFocus ? `Stop · ${remainingMinutes(plan)}m` : 'Focus 25';
  if (focusButton) focusButton.setAttribute('aria-label', quickFocus ? 'Stop quick focus' : 'Start a 25 minute focus session');
  setRow('row-plan', 'v-plan', plan ? `${plan.planName} · ${plan.label} until ${plan.end}` : 'None active', !!plan);
  setRow('row-block', 'v-block',
    is.blocked ? `${is.protectedBlock ? 'Protected · ' : ''}${is.blockReason}` : 'Nothing blocked right now',
    false, is.blocked);
  const sleeping = !!(is.sleep && is.sleep.active);
  setRow('row-sleep', 'v-sleep',
    sleeping ? `Active until ${is.sleep.end}` : (is.sleep && is.sleep.start ? `Off · ${is.sleep.start}–${is.sleep.end}` : 'Off'),
    sleeping);
  setRow('row-next', 'v-next', is.next ? `${is.next.label} in ${humanMinutes(is.next.in)}` : '—', false);
  {
    const live = !!(is.tab && is.tab.source === 'extension');
    const browserFocused = !!(is.tab && (is.tab.kind === 'site' || is.tab.site));
    setRow('row-ext', 'v-ext',
      live ? 'Live · extension paired' : (browserFocused ? 'Not paired · titles only' : 'No browser in focus'),
      live, !live && browserFocused);
    const extRow = el('row-ext');
    if (extRow) extRow.title = live
      ? 'The browser extension reports the exact active tab.'
      : 'Pair the Chrome/Edge extension (Gem Air tab → Browser link) so the island knows the exact website instead of guessing from window titles.';
  }

  renderQuestion(is.question);
}

/**
 * Tab strip: the current tab, the ones just left, and how long each held focus.
 * Rows are buttons — activating one raises that window through the same
 * focusApp path the desktop tools use, so "go back to what I was doing" is one
 * keypress from the island instead of an Alt-Tab hunt.
 */
function renderTabs(is) {
  const panel = el('tabs-panel');
  if (!panel) return;
  const tabs = Array.isArray(is.tabs) ? is.tabs : [];
  const current = is.tab;
  panel.hidden = false;

  const source = el('tabs-source');
  if (source) {
    const live = !!(current && current.source === 'extension');
    source.textContent = live ? 'live tab' : (current ? 'from window title' : 'no focus');
    source.classList.toggle('live', live);
    source.title = live
      ? 'Read directly from the browser extension, so this is the real tab title.'
      : 'The browser extension is not paired, so the tab is inferred from the window title and can be less precise.';
  }

  const nowLabel = el('tab-now-label');
  const nowMeta = el('tab-now-meta');
  if (nowLabel) {
    nowLabel.textContent = (current && current.label) || 'Nothing focused';
    nowLabel.classList.toggle('empty', !current);
  }
  if (nowMeta) {
    const bits = [];
    if (current && current.app) bits.push(current.app);
    if (tabs.length && tabs[0] && tabs[0].current) bits.push(fmtCompact(tabs[0].ms || 0));
    nowMeta.textContent = bits.join(' · ');
  }

  const list = el('tab-list');
  if (list) {
    list.innerHTML = '';
    // The first row is the current tab, already shown large above.
    for (const tab of tabs.slice(1, 6)) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab-item';
      button.dataset.app = tab.app || '';
      button.dataset.title = tab.title || '';
      button.dataset.kind = tab.kind || 'app';
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      dot.style.background = tab.categoryColor || '#8ea0b5';
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.label || tab.appLabel || 'Unknown';
      const time = document.createElement('span');
      time.className = 'tab-time';
      time.textContent = fmtCompact(tab.ms || 0);
      button.title = `${tab.categoryLabel || 'Other'} · ${Math.max(1, Math.round((tab.ms || 0) / 60000))} min`;
      button.append(dot, label, time);
      li.append(button);
      list.append(li);
    }
    list.hidden = list.children.length === 0;
  }

  const appRow = el('tab-app');
  const appValue = el('tab-app-v');
  if (appRow && appValue) {
    const view = is.appView && VIEW_LABEL[is.appView] ? VIEW_LABEL[is.appView] : (is.appView || '');
    appRow.hidden = !view;
    appValue.textContent = view || '';
  }
}

function renderProgress(focusBlock) {
  const wrap = el('ctx-progress');
  const bar = el('ctx-progress-bar');
  if (!focusBlock || !focusBlock.startMs || !focusBlock.endMs || focusBlock.endMs <= focusBlock.startMs) {
    wrap.hidden = true;
    clearFocusRing();
    return;
  }
  const now = Date.now();
  const pct = Math.max(0, Math.min(100, ((now - focusBlock.startMs) / (focusBlock.endMs - focusBlock.startMs)) * 100));
  wrap.hidden = false;
  bar.style.width = pct.toFixed(1) + '%';
  // Same progress as an arc around the orb so the compact pill shows how far
  // through the focus block you are without expanding.
  island.classList.add('focus-active');
  island.style.setProperty('--ring', (pct / 100).toFixed(4));
}

function clearFocusRing() {
  island.classList.remove('focus-active');
  island.style.removeProperty('--ring');
}

function subline(snap) {
  const is = snap.island;
  const c = snap.context;
  if (is.mode === 'sleep') return `Nothing opens until ${is.sleep.end}`;
  if (is.blocked) return is.blockReason || 'Blocked';
  if (!c) return '';
  if (c.kind === 'site') return is.urlSource === 'extension' ? '● Live tab from browser extension' : 'Site inferred from window title';
  return c.title ? c.title.slice(0, 60) : '';
}

function setRow(rowId, valId, text, on, alert) {
  const row = el(rowId);
  row.classList.toggle('on', !!on);
  row.classList.toggle('alert', !!alert);
  el(valId).textContent = text;
}

function humanMinutes(m) {
  if (m == null) return '—';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function remainingMinutes(block) {
  if (!block) return 0;
  if (Number.isFinite(Number(block.endMs))) return Math.max(0, Math.ceil((Number(block.endMs) - Date.now()) / 60000));
  return Math.max(0, Number(block.endsInMinutes) || 0);
}

function hexA(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return `rgba(255,255,255,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/* ---------- the question: what is this for? ---------- */
function renderQuestion(q) {
  const panel = el('question');
  if (!q) {
    panel.hidden = true;
    el('q-new').hidden = true;
    currentQuestion = null;
    return;
  }
  currentQuestion = q;
  panel.hidden = false;
  if (!expanded) setExpanded(true);
  el('q-prompt').textContent = q.prompt;
  el('q-subject').textContent = `${q.label} · ${q.kind === 'site' ? 'website' : 'application'}`;

  const actions = el('q-actions');
  actions.innerHTML = '';
  const quick = [
    { id: 'work', label: '✓ Work' },
    { id: 'distraction', label: '✕ Distraction' }
  ];
  for (const item of quick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.label;
    b.addEventListener('click', () => answer(q, item.id));
    actions.appendChild(b);
  }
  const other = document.createElement('button');
  other.type = 'button';
  other.textContent = 'Other…';
  other.addEventListener('click', () => showOther(q));
  actions.appendChild(other);
}

function showOther(q) {
  const box = el('q-new');
  box.hidden = false;
  const actions = el('q-actions');
  actions.innerHTML = '';
  // Existing non-default categories become one-tap choices.
  for (const c of categories.filter((x) => !['work', 'distraction'].includes(x.id))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.label;
    b.style.color = c.color;
    b.addEventListener('click', () => answer(q, c.id));
    actions.appendChild(b);
  }
  const sw = el('q-swatches');
  sw.innerHTML = '';
  COLORS.forEach((color, i) => {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch';
    s.style.background = color;
    s.title = color;
    s.setAttribute('aria-label', 'Color ' + color);
    s.setAttribute('aria-pressed', String(i === 0));
    s.addEventListener('click', () => {
      pickedColor = color;
      sw.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      s.setAttribute('aria-pressed', 'true');
    });
    sw.appendChild(s);
  });
  pickedColor = COLORS[0];
  el('q-label').focus();
  el('q-create').onclick = async () => {
    const label = el('q-label').value.trim();
    if (!label) return;
    try {
      const cat = await api.createCategory({ label, color: pickedColor, relevance: 'neutral' });
      categories = (await api.state()).categories;
      await answer(q, cat.id, `${q.label} → ${cat.label}`);
    } catch {
      confirm('Could not create that category — try again.');
      return;
    }
    el('q-label').value = '';
    box.hidden = true;
  };
  el('q-cancel').onclick = () => { box.hidden = true; renderQuestion(q); };
}

async function answer(q, categoryId, message) {
  try {
    await api.answer(q.id, categoryId);
  } catch {
    confirm('Could not save that answer — try again.');
    return;
  }
  el('q-new').hidden = true;
  el('question').hidden = true;
  currentQuestion = null;
  const cat = categories.find((c) => c.id === categoryId);
  confirm((message || `${q.label} → ${cat ? cat.label : categoryId}`) + ' · Remembered ✓');
  try { render(await api.snapshot()); } catch {}
}

let confirmTimer = null;
function confirm(text) {
  const box = el('confirm');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => { box.hidden = true; }, 2600);
}

/* ---------- live timer ticking between polls ---------- */
setInterval(() => {
  if (!snapshot) return;
  const mode = snapshot.island.mode;
  if (mode !== 'working' && mode !== 'distraction') return;
  const ms = localTimerBase.ms + (Date.now() - localTimerBase.at);
  el('timer').textContent = fmtCompact(ms);
  el('ctx-timer').textContent = fmt(ms);
  renderProgress(snapshot.island.focusBlock);
  const quick = snapshot.island.focusBlock && snapshot.island.focusBlock.planId === 'gem-air-quick-focus';
  if (quick && el('focus-label')) el('focus-label').textContent = `Stop · ${remainingMinutes(snapshot.island.focusBlock)}m`;
}, 1000);

/* ---------- boot ---------- */
island.classList.add('loading');
try {
  api.onUpdate(render);
  api.onQuestion(() => api.snapshot().then(render).catch(() => {}));
  api.snapshot().then(render).catch(() => island.classList.remove('loading'));
  api.state().then((s) => { categories = (s && s.categories) || []; }).catch(() => {});
} catch {
  island.classList.remove('loading');
}
