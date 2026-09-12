/* Gem Air island — renderer.
   compact -> contextual info -> user decision -> system remembers -> state changes. */
'use strict';

const api = window.air;
const el = (id) => document.getElementById(id);
const island = el('island');

let snapshot = null;
let expanded = false;
let categories = [];
let pickedColor = '#7c5cff';
let localTimerBase = { ms: 0, at: Date.now() };

const COLORS = ['#6f8cff', '#38d39f', '#ff7ac6', '#ffb454', '#ff6b6b', '#a78bfa'];

function setExpanded(next) {
  if (expanded === next) return;
  expanded = next;
  island.classList.toggle('expanded', expanded);
  island.classList.toggle('compact', !expanded);
  api.islandResize(expanded ? 'expanded' : 'compact');
  // In the preview harness the island runs in an iframe; tell the host to resize it.
  if (window.parent !== window) {
    try { window.parent.postMessage({ type: 'gemair:islandResize', mode: expanded ? 'expanded' : 'compact' }, '*'); } catch {}
  }
}

el('capsule').addEventListener('click', (e) => {
  if (e.target.id === 'grip') return;
  setExpanded(!expanded);
});
el('btn-collapse').addEventListener('click', () => setExpanded(false));
el('btn-dashboard').addEventListener('click', () => api.openMain('dashboard'));
document.querySelectorAll('[data-nav]').forEach((b) => {
  b.addEventListener('click', () => api.openMain(b.dataset.nav));
});

function fmt(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function render(snap) {
  if (!snap) return;
  snapshot = snap;
  const is = snap.island;
  island.dataset.mode = is.mode;
  localTimerBase = { ms: is.elapsedMs || 0, at: Date.now() };

  el('subject').textContent = is.primary;
  el('meta').textContent = is.secondary || '';
  el('timer').textContent = is.mode === 'working' || is.mode === 'distraction' ? fmt(is.elapsedMs) : '';

  el('ctx-subject').textContent = is.primary;
  const chip = el('ctx-chip');
  chip.textContent = is.secondary || '—';
  chip.style.background = hexA(is.color, 0.18);
  chip.style.color = is.color;
  el('ctx-sub').textContent = subline(snap);
  el('ctx-timer').textContent = fmt(is.elapsedMs);

  const plan = is.focusBlock;
  setRow('row-plan', 'v-plan', plan ? `${plan.planName} · ${plan.label} until ${plan.end}` : 'None active', !!plan);
  setRow('row-block', 'v-block', is.blocked ? `${is.protectedBlock ? 'Protected · ' : ''}${is.blockReason}` : 'Nothing blocked right now', false, is.blocked);
  setRow('row-sleep', 'v-sleep', is.sleep && is.sleep.active ? `Active until ${is.sleep.end}` : (is.sleep && is.sleep.start ? `Off · ${is.sleep.start}–${is.sleep.end}` : 'Off'), !!(is.sleep && is.sleep.active));
  setRow('row-next', 'v-next', is.next ? `${is.next.label} in ${humanMinutes(is.next.in)}` : '—', false);

  renderQuestion(is.question);
}

function subline(snap) {
  const is = snap.island;
  const c = snap.context;
  if (is.mode === 'sleep') return `Nothing opens until ${is.sleep.end}`;
  if (is.blocked) return is.blockReason || 'Blocked';
  if (!c) return '';
  if (c.kind === 'site') return is.urlSource === 'extension' ? 'Live tab from browser extension' : 'Site inferred from window title';
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

function hexA(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return `rgba(255,255,255,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/* ---------- the question: what is this for? ---------- */
function renderQuestion(q) {
  const panel = el('question');
  if (!q) { panel.hidden = true; return; }
  panel.hidden = false;
  if (!expanded) setExpanded(true);
  el('q-prompt').textContent = q.prompt;
  el('q-subject').textContent = `${q.label} · ${q.kind === 'site' ? 'website' : 'application'}`;

  const actions = el('q-actions');
  actions.innerHTML = '';
  const quick = [
    { id: 'work', label: 'Work' },
    { id: 'distraction', label: 'Distraction' }
  ];
  for (const item of quick) {
    const b = document.createElement('button');
    b.textContent = item.label;
    b.addEventListener('click', () => answer(q, item.id));
    actions.appendChild(b);
  }
  const other = document.createElement('button');
  other.textContent = 'Other';
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
    b.textContent = c.label;
    b.style.color = c.color;
    b.addEventListener('click', () => answer(q, c.id));
    actions.appendChild(b);
  }
  const sw = el('q-swatches');
  sw.innerHTML = '';
  COLORS.forEach((color, i) => {
    const s = document.createElement('button');
    s.className = 'swatch';
    s.style.background = color;
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
    const cat = await api.createCategory({ label, color: pickedColor, relevance: 'neutral' });
    categories = (await api.state()).categories;
    await answer(q, cat.id, `${q.label} → ${cat.label}`);
    el('q-label').value = '';
    box.hidden = true;
  };
  el('q-cancel').onclick = () => { box.hidden = true; renderQuestion(q); };
}

async function answer(q, categoryId, message) {
  await api.answer(q.id, categoryId);
  el('q-new').hidden = true;
  const cat = categories.find((c) => c.id === categoryId);
  confirm(message || `${q.label} → ${cat ? cat.label : categoryId}. Remembered.`);
  render(await api.snapshot());
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
  el('timer').textContent = fmt(ms);
  el('ctx-timer').textContent = fmt(ms);
}, 1000);

api.onUpdate(render);
api.onQuestion(() => api.snapshot().then(render));
api.snapshot().then(render);
api.state().then((s) => { categories = s.categories; });
