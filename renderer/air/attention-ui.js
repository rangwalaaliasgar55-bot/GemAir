/* Gem Air — attention surfaces (Dashboard, Activity, Plans, Blocking, Browser, Sleep, Settings).
   Reads and writes only through window.air (the guarded IPC bridge). */
(function () {
  'use strict';

  const air = window.air;
  const root = document.getElementById('view-attention');
  if (!root) return;

  const panels = {};
  document.querySelectorAll('[data-air-panel]').forEach((p) => { panels[p.dataset.airPanel] = p; });
  const tabs = Array.from(document.querySelectorAll('.air-tab'));
  const indicator = document.getElementById('airTabIndicator');

  let cache = { snapshot: null, state: null, caps: null };
  let active = 'dashboard';
  const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  /* ---------- helpers ---------- */
  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return n;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  function dur(ms) {
    const m = Math.round((ms || 0) / 60000);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  function clock(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function categoryOf(id) {
    return (cache.state && cache.state.categories.find((c) => c.id === id)) || { id, label: id, color: '#8ea0b5' };
  }

  async function reload() {
    const [snapshot, state, caps] = await Promise.all([air.snapshot(), air.state(), air.capabilities()]);
    cache = { snapshot, state, caps };
    return cache;
  }

  /* ---------- tabs ---------- */
  function moveIndicator() {
    const btn = tabs.find((t) => t.dataset.airTab === active);
    if (!btn || !indicator) return;
    indicator.style.width = btn.offsetWidth + 'px';
    indicator.style.transform = `translateX(${btn.offsetLeft - 4}px)`;
  }

  function show(name) {
    if (!panels[name]) name = 'dashboard';
    active = name;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.airTab === name));
    Object.entries(panels).forEach(([k, p]) => p.classList.toggle('active', k === name));
    moveIndicator();
    render(name);
  }

  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.airTab)));
  window.addEventListener('resize', moveIndicator);

  /* ---------- renderers ---------- */
  async function render(name) {
    await reload();
    const panel = panels[name];
    clear(panel);
    ({
      dashboard: renderDashboard,
      activity: renderActivity,
      plans: renderPlans,
      blocking: renderBlocking,
      browser: renderBrowser,
      sleep: renderSleep,
      settings: renderSettings
    })[name](panel);
  }

  /* ===== Dashboard ===== */
  async function renderDashboard(panel) {
    const s = cache.snapshot.summary;
    const lastHour = cache.snapshot.lastHour;
    const timeline = await air.timeline();
    const trend = await air.trend(7);

    panel.appendChild(h('div', { class: 'air-grid' },
      statCard('Focused today', dur(s.totals.focus), `${s.percentages.focus}% of tracked time`, 'focus'),
      statCard('Distraction', dur(s.totals.distraction), `${s.percentages.distraction}% of tracked time`, 'distraction'),
      statCard('Other', dur(s.totals.other), `${s.percentages.other}%`),
      statCard('Idle', dur(s.totals.idle), `${s.percentages.idle}%`)
    ));

    panel.appendChild(section('Today', timelineBar(timeline), [
      h('div', { class: 'air-legend' },
        legend('focus', 'Work'), legend('distraction', 'Distraction'), legend('other', 'Other'), legend('idle', 'Idle'))
    ]));

    panel.appendChild(section('Last hour',
      h('div', { class: 'air-grid' },
        statCard('Focus', dur(lastHour.focus), '', 'focus'),
        statCard('Distraction', dur(lastHour.distraction), '', 'distraction'),
        statCard('Other', dur(lastHour.other), ''),
        statCard('Idle', dur(lastHour.idle), ''))));

    panel.appendChild(section('Last 7 days', trendChart(trend)));

    const top = s.top.length
      ? h('div', { class: 'air-list' }, s.top.map((t) => h('div', { class: 'air-row' },
          h('span', { class: 'grow', text: t.label }),
          h('span', { class: 'num', text: dur(t.ms) }))))
      : h('div', { class: 'air-empty', text: 'Nothing tracked yet today.' });
    panel.appendChild(section('Where the time went', top));
  }

  function statCard(title, value, sub, tone) {
    return h('div', { class: 'air-card' },
      h('h3', { text: title }),
      h('div', { class: 'air-stat ' + (tone || ''), text: value }),
      sub ? h('div', { class: 'air-sub', text: sub }) : null);
  }
  function legend(lane, label) {
    return h('span', {},
      h('i', { class: 'air-key', style: `background:var(--air-${lane})` }),
      label);
  }
  function section(title, body, extras) {
    const wrap = h('div', { class: 'air-section' }, h('div', { class: 'air-section-head' }, h('h3', { text: title })), body);
    (extras || []).forEach((e) => wrap.appendChild(e));
    return wrap;
  }

  function timelineBar(segments) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const dayMs = 86400000;
    const bar = h('div', { class: 'air-timeline' });
    if (!segments.length) {
      bar.appendChild(h('div', { class: 'air-seg idle', style: 'width:100%' }));
    } else {
      let cursor = start.getTime();
      const push = (lane, ms, label) => {
        if (ms <= 0) return;
        bar.appendChild(h('div', { class: 'air-seg ' + lane, style: `width:${(ms / dayMs) * 100}%`, title: label }));
      };
      for (const seg of segments) {
        push('idle', seg.start - cursor, 'Untracked');
        push(seg.lane, seg.duration, `${seg.label} · ${dur(seg.duration)} · ${clock(seg.start)}`);
        cursor = Math.max(cursor, seg.start + seg.duration);
      }
      push('idle', Date.now() - cursor, 'Untracked');
    }
    return h('div', {}, bar, h('div', { class: 'air-axis' },
      h('span', { text: '00:00' }), h('span', { text: '06:00' }), h('span', { text: '12:00' }),
      h('span', { text: '18:00' }), h('span', { text: '24:00' })));
  }

  function trendChart(trend) {
    const max = Math.max(1, ...trend.map((d) => d.focus + d.distraction + d.other));
    return h('div', { class: 'air-trend' }, trend.map((d) => {
      const pc = (v) => `height:${(v / max) * 100}%`;
      return h('div', { class: 'air-trend-day', title: `${d.day} · focus ${dur(d.focus)}` },
        h('div', { class: 'air-bar' },
          h('i', { class: 'f', style: pc(d.focus) }),
          h('i', { class: 'd', style: pc(d.distraction) }),
          h('i', { class: 'o', style: pc(d.other) })),
        h('span', { class: 'air-trend-label', text: DAYS[new Date(d.day + 'T12:00').getDay()] }));
    }));
  }

  /* ===== Activity ===== */
  async function renderActivity(panel) {
    const recent = await air.recent(60);
    const s = cache.snapshot.summary;
    panel.appendChild(h('div', { class: 'air-note ok' },
      h('span', {}, h('b', {}, 'Private. '), 'This history is stored only on this machine. Nothing is uploaded, shared or ranked.')));
    panel.appendChild(section('Totals', h('div', { class: 'air-grid' },
      statCard('Tracked', dur(s.tracked), s.day),
      statCard('Focus', dur(s.totals.focus), `${s.percentages.focus}%`, 'focus'),
      statCard('Distraction', dur(s.totals.distraction), `${s.percentages.distraction}%`, 'distraction'),
      statCard('Idle', dur(s.totals.idle), `${s.percentages.idle}%`))));

    const rows = recent.length
      ? h('div', { class: 'air-list' }, recent.map((r) => {
          const cat = categoryOf(r.categoryId);
          return h('div', { class: 'air-row' },
            h('span', { class: 'num', text: clock(r.start) }),
            h('span', { class: 'grow', text: r.label || r.subject },
              r.kind === 'site' ? h('span', { class: 'muted', text: '  site' }) : null),
            h('span', { class: 'air-tag', style: `color:${cat.color};background:${cat.color}22`, text: cat.label }),
            h('span', { class: 'num', text: dur(r.duration) }));
        }))
      : h('div', { class: 'air-empty', text: 'No activity recorded yet. Gem Air records while it runs.' });
    panel.appendChild(section('Recent activity', rows));

    panel.appendChild(h('div', { class: 'air-form', style: 'margin-top:16px' },
      h('button', { class: 'air-btn subtle', onclick: async () => { const d = await air.exportData(); downloadJson(d); } }, 'Export my data'),
      h('button', { class: 'air-btn danger', onclick: async () => { if (window.confirm('Erase all activity history and blocked attempts?')) { await air.resetActivity(); render('activity'); } } }, 'Erase history')));
  }

  function downloadJson(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'gem-air-activity.json' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ===== Plans ===== */
  function renderPlans(panel) {
    const plans = cache.state.plans;
    panel.appendChild(h('div', { class: 'air-note ok' },
      h('span', {}, h('b', {}, 'Implemented. '), 'Active plan blocks apply their rules to the blocking engine in real time — allowed apps and sites stay open, everything else in the blocked lists or categories is stopped.')));

    const list = plans.length
      ? h('div', { class: 'air-list' }, plans.map(planRow))
      : h('div', { class: 'air-empty', text: 'No plans yet. Create one below — for example Study, weekdays 09:00–10:00.' });
    panel.appendChild(section('Your plans', list));
    panel.appendChild(section('New plan', planEditor()));
  }

  function planRow(plan) {
    const blocks = (plan.blocks || []).map((b) => `${b.start}–${b.end} ${b.label}`).join(' · ');
    const days = (plan.days || []).map((d) => DAYS[d]).join('') || 'Every day';
    return h('div', { class: 'air-row' },
      h('span', { class: 'grow' },
        h('b', { text: plan.name }),
        h('div', { class: 'muted', text: `${days} · ${blocks || 'no blocks'}` })),
      h('span', { class: 'air-tag', text: plan.rules && plan.rules.strict ? 'Strict' : 'Standard' }),
      h('button', {
        class: 'air-btn subtle',
        onclick: async () => { await air.togglePlan(plan.id, plan.enabled === false); render('plans'); }
      }, plan.enabled === false ? 'Enable' : 'Disable'),
      h('button', { class: 'air-btn danger', onclick: async () => { await air.deletePlan(plan.id); render('plans'); } }, 'Delete'));
  }

  function planEditor() {
    const name = h('input', { class: 'air-input wide', placeholder: 'Plan name, e.g. Study' });
    const start = h('input', { class: 'air-input', type: 'time', value: '09:00' });
    const end = h('input', { class: 'air-input', type: 'time', value: '10:00' });
    const label = h('input', { class: 'air-input', placeholder: 'Focus block label', value: 'Focus' });
    const allowedApps = h('input', { class: 'air-input wide', placeholder: 'Allowed apps (code, chrome)' });
    const blockedApps = h('input', { class: 'air-input wide', placeholder: 'Blocked apps (discord, steam)' });
    const allowedSites = h('input', { class: 'air-input wide', placeholder: 'Allowed sites (github.com, developer.mozilla.org)' });
    const blockedSites = h('input', { class: 'air-input wide', placeholder: 'Blocked sites (youtube.com, instagram.com, x.com)' });
    const strict = h('input', { type: 'checkbox' });
    const selectedDays = new Set([1, 2, 3, 4, 5]);
    const dayBtns = DAYS.map((d, i) => h('button', {
      class: 'air-day', 'aria-pressed': selectedDays.has(i), text: d,
      onclick: (e) => {
        selectedDays.has(i) ? selectedDays.delete(i) : selectedDays.add(i);
        e.currentTarget.setAttribute('aria-pressed', selectedDays.has(i));
      }
    }));
    const csv = (input) => input.value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);

    return h('div', { class: 'air-card' },
      h('div', { class: 'air-form' }, name, h('div', { class: 'air-days' }, dayBtns)),
      h('div', { class: 'air-form' }, label, start, h('span', { class: 'muted', text: 'to' }), end),
      h('div', { class: 'air-form' }, allowedApps, blockedApps),
      h('div', { class: 'air-form' }, allowedSites, blockedSites),
      h('div', { class: 'air-form' },
        h('label', { class: 'air-check' }, strict, 'Strict — during this block only allowed items and focus categories are permitted'),
        h('button', {
          class: 'air-btn',
          onclick: async () => {
            if (!name.value.trim()) { name.focus(); return; }
            await air.savePlan({
              name: name.value.trim(),
              days: Array.from(selectedDays),
              blocks: [{ start: start.value, end: end.value, kind: 'focus', label: label.value || 'Focus' }],
              rules: {
                strict: strict.checked,
                protected: true,
                allowedApps: csv(allowedApps), blockedApps: csv(blockedApps),
                allowedSites: csv(allowedSites), blockedSites: csv(blockedSites),
                blockedCategories: []
              }
            });
            render('plans');
          }
        }, 'Create plan')));
  }

  /* ===== Blocking ===== */
  function renderBlocking(panel) {
    const caps = cache.caps;
    const blocks = cache.state.blocks;

    panel.appendChild(h('div', { class: 'air-note ok' },
      h('span', {}, h('b', {}, 'Implemented — applications. '),
        `When a blocked app is in the foreground Gem Air closes the process on ${caps.platform === 'win32' ? 'Windows' : caps.platform}. Every attempt is recorded below.`)));
    panel.appendChild(h('div', { class: 'air-note warn' },
      h('span', {}, h('b', {}, 'Requires native integration — system-wide site blocking. '),
        'Website blocking works today through the Gem Air browser extension (Browser tab). Blocking a site for every program on the machine edits the hosts file and needs an elevated helper, which is not installed.')));

    panel.appendChild(section('Blocked applications', blockList('app', blocks.apps), [blockForm('app')]));
    panel.appendChild(section('Blocked websites', blockList('site', blocks.sites), [blockForm('site')]));
    panel.appendChild(section('Exceptions you allowed', exceptionList(), [exceptionForm()]));
    panel.appendChild(section('Blocked attempts', attemptList()));
  }

  function blockList(kind, rules) {
    if (!rules.length) return h('div', { class: 'air-empty', text: kind === 'app' ? 'No applications blocked.' : 'No websites blocked.' });
    return h('div', { class: 'air-list' }, rules.map((r) => h('div', { class: 'air-row' },
      h('span', { class: 'grow' }, h('b', { text: r.target }), r.reason ? h('div', { class: 'muted', text: r.reason }) : null),
      r.protected ? h('span', { class: 'air-tag', style: 'color:#ff9a9a;background:rgba(255,107,107,.14)', text: 'Protected' }) : null,
      h('button', {
        class: 'air-btn subtle',
        disabled: r.protected && r.enabled !== false,
        title: r.protected ? 'A protected block cannot be switched off' : '',
        onclick: async () => { await air.toggleBlock(kind, r.id, r.enabled === false); render('blocking'); }
      }, r.enabled === false ? 'Enable' : 'Disable'),
      h('button', { class: 'air-btn danger', onclick: async () => { await air.removeBlock(kind, r.id); render('blocking'); } }, 'Remove'))));
  }

  function blockForm(kind) {
    const target = h('input', { class: 'air-input wide', placeholder: kind === 'app' ? 'Process name, e.g. discord' : 'Website, e.g. youtube.com' });
    const reason = h('input', { class: 'air-input wide', placeholder: 'Why (shown when blocked)' });
    const prot = h('input', { type: 'checkbox' });
    return h('div', { class: 'air-form' }, target, reason,
      h('label', { class: 'air-check' }, prot, 'Protected'),
      h('button', {
        class: 'air-btn',
        onclick: async () => {
          if (!target.value.trim()) return;
          await air.addBlock({ kind, target: target.value, reason: reason.value, protected: prot.checked });
          render('blocking');
        }
      }, 'Add block'));
  }

  function exceptionList() {
    const list = cache.state.blocks.exceptions;
    if (!list.length) return h('div', { class: 'air-empty', text: 'No exceptions. Protected blocks ignore exceptions by design.' });
    return h('div', { class: 'air-list' }, list.map((e) => h('div', { class: 'air-row' },
      h('span', { class: 'grow' }, h('b', { text: e.target }),
        h('div', { class: 'muted', text: `${e.kind} · ${e.until ? 'until ' + clock(e.until) : 'no expiry'}${e.reason ? ' · ' + e.reason : ''}` })),
      h('button', { class: 'air-btn danger', onclick: async () => { await air.removeException(e.id); render('blocking'); } }, 'Remove'))));
  }

  function exceptionForm() {
    const target = h('input', { class: 'air-input wide', placeholder: 'Allow this app or site' });
    const kind = h('select', { class: 'air-select' }, h('option', { value: 'site', text: 'Website' }), h('option', { value: 'app', text: 'Application' }));
    const mins = h('input', { class: 'air-input', type: 'number', min: '0', max: '720', value: '30', style: 'width:90px' });
    const reason = h('input', { class: 'air-input wide', placeholder: 'Reason' });
    return h('div', { class: 'air-form' }, kind, target, mins, h('span', { class: 'muted', text: 'minutes (0 = no expiry)' }), reason,
      h('button', {
        class: 'air-btn',
        onclick: async () => {
          if (!target.value.trim()) return;
          await air.addException({ kind: kind.value, target: target.value, minutes: Number(mins.value) || 0, reason: reason.value });
          render('blocking');
        }
      }, 'Allow'));
  }

  function attemptList() {
    const list = (cache.state.attempts || []).slice(0, 30);
    if (!list.length) return h('div', { class: 'air-empty', text: 'No blocked attempts recorded.' });
    return h('div', { class: 'air-list' }, list.map((a) => h('div', { class: 'air-row' },
      h('span', { class: 'num', text: clock(a.at) }),
      h('span', { class: 'grow' }, h('b', { text: a.label || a.subject }), h('div', { class: 'muted', text: a.reason || '' })),
      h('span', { class: 'air-tag', text: a.source || 'block' }))));
  }

  /* ===== Browser ===== */
  function renderBrowser(panel) {
    const bridge = cache.snapshot.bridge;
    const ctx = cache.snapshot.context;

    panel.appendChild(h('div', { class: bridge.connected ? 'air-note ok' : 'air-note warn' },
      h('span', {}, h('b', {}, bridge.connected ? 'Extension connected. ' : 'Extension not connected. '),
        bridge.connected
          ? 'Gem Air sees the active tab URL and the extension enforces website blocks inside the browser.'
          : 'Without the extension, Gem Air falls back to guessing the site from the window title and cannot stop a navigation. Pair it below.')));

    panel.appendChild(section('Current browser context', h('div', { class: 'air-card' },
      h('div', { class: 'air-stat', text: ctx && ctx.kind === 'site' ? ctx.site : (ctx ? ctx.appLabel : '—') }),
      h('div', { class: 'air-sub', text: ctx ? `${ctx.categoryLabel} · source: ${ctx.urlSource === 'extension' ? 'browser extension (exact)' : ctx.urlSource === 'title' ? 'window title (inferred)' : 'not a browser'}` : '' }))));

    const pairBox = h('div', { class: 'air-card' },
      h('p', { class: 'air-sub', text: `GemAir reads the exact website you're on through a tiny Chrome/Edge extension talking to a loopback bridge on 127.0.0.1:${bridge.port}. Pair it once and the island always knows the site — no guessing from window titles.` }),
      h('div', { class: 'air-form', style: 'margin-top:10px;flex-direction:column;align-items:stretch;gap:8px' },
        h('button', {
          class: 'air-btn',
          onclick: async (e) => {
            const { code } = await air.bridgePair();
            const box = e.currentTarget.parentElement;
            const old = box.querySelector('.air-code');
            if (old) old.remove();
            box.appendChild(h('span', { class: 'air-code', text: code }));
          }
        }, 'Generate pairing code'),
        h('button', {
          class: 'air-btn',
          onclick: async () => {
            try {
              if (window.gemair && window.gemair.openExtensionFolder) await window.gemair.openExtensionFolder();
            } catch (e) { try { window.alert && window.alert('Could not open the folder: ' + (e && e.message ? e.message : e)); } catch {} }
          }
        }, 'Open extension folder'),
        h('button', {
          class: 'air-btn',
          onclick: async () => {
            try {
              let path = null;
              if (window.gemair && window.gemair.extensionFolderPath) path = await window.gemair.extensionFolderPath();
              if (!path) return;
              let copied = false;
              try { if (window.gemair && window.gemair.copyText) copied = await window.gemair.copyText(path); } catch {}
              if (!copied) { try { await navigator.clipboard.writeText(path); copied = true; } catch {} }
              try { window.alert && window.alert((copied ? 'Copied to clipboard:\n' : 'Extension folder path:\n') + path); } catch {}
            } catch (e) { try { window.alert && window.alert('Could not read the folder path.'); } catch {} }
          }
        }, 'Copy folder path')));
    const steps = [
      'Click "Open extension folder" above (or copy the path).',
      'In Chrome/Edge open chrome://extensions and turn on Developer mode.',
      'Click "Load unpacked" and select that folder.',
      'Pin GemAir, click its icon, then press "Generate pairing code" here and type the code in the extension popup.',
      'Done — the island shows the exact site you are on, and Focus mode can whitelist it.'
    ];
    panel.appendChild(section('Browser link', pairBox));
    panel.appendChild(section('Pair the extension — 5 steps', h('ol', { class: 'air-list', style: 'padding-left:18px;margin:0;display:flex;flex-direction:column;gap:6px' },
      steps.map((s) => h('li', { class: 'air-sub', style: 'list-style:decimal' }, s)))));

    panel.appendChild(section('Website rules', siteRuleList(), [siteRuleForm()]));
  }

  function siteRuleList() {
    const rules = cache.state.siteRules.slice().sort((a, b) => a.match.localeCompare(b.match));
    return h('div', { class: 'air-list' }, rules.map((r) => {
      const cat = categoryOf(r.category);
      return h('div', { class: 'air-row' },
        h('span', { class: 'grow', text: r.match }),
        h('span', { class: 'air-tag', style: `color:${cat.color};background:${cat.color}22`, text: cat.label }),
        h('span', { class: 'muted', text: r.source === 'user' ? 'yours' : 'built in' }),
        h('button', { class: 'air-btn danger', onclick: async () => { await air.deleteRule('site', r.match); render('browser'); } }, 'Remove'));
    }));
  }

  function siteRuleForm() {
    const site = h('input', { class: 'air-input wide', placeholder: 'Website, e.g. notion.so' });
    const cat = categorySelect();
    return h('div', { class: 'air-form' }, site, cat,
      h('button', {
        class: 'air-btn',
        onclick: async () => {
          if (!site.value.trim()) return;
          await air.classify({ kind: 'site', subject: site.value.trim(), categoryId: cat.value });
          render('browser');
        }
      }, 'Save rule'));
  }

  function categorySelect(selected) {
    return h('select', { class: 'air-select' }, cache.state.categories.map((c) =>
      h('option', { value: c.id, text: c.label, selected: c.id === selected })));
  }

  /* ===== Sleep ===== */
  function renderSleep(panel) {
    const sleep = cache.state.sleep;
    const status = cache.snapshot.island.sleep;
    const enabled = h('input', { type: 'checkbox', checked: sleep.enabled });
    const start = h('input', { class: 'air-input', type: 'time', value: sleep.start });
    const end = h('input', { class: 'air-input', type: 'time', value: sleep.end });
    const sites = h('input', { class: 'air-input wide', placeholder: 'Extra sites to close down', value: (sleep.blockSites || []).join(', ') });
    const apps = h('input', { class: 'air-input wide', placeholder: 'Extra apps to close down', value: (sleep.blockApps || []).join(', ') });
    const selected = new Set(sleep.days || []);
    const catSelected = new Set(sleep.blockCategories || []);

    panel.appendChild(h('div', { class: status.active ? 'air-note warn' : 'air-note ok' },
      h('span', {}, h('b', {}, status.active ? 'Sleep is active. ' : 'Sleep is scheduled. '),
        status.active
          ? `Restrictions lift at ${status.end} — about ${Math.round(status.endsInMinutes / 60 * 10) / 10} hours from now.`
          : sleep.enabled ? `Runs ${sleep.start} → ${sleep.end}.` : 'Turn it on to set a nightly cutoff.')));

    const dayBtns = DAYS.map((d, i) => h('button', {
      class: 'air-day', 'aria-pressed': selected.has(i), text: d,
      onclick: (e) => { selected.has(i) ? selected.delete(i) : selected.add(i); e.currentTarget.setAttribute('aria-pressed', selected.has(i)); }
    }));
    const catBtns = cache.state.categories.map((c) => h('button', {
      class: 'air-day', style: 'width:auto;padding:0 11px', 'aria-pressed': catSelected.has(c.id), text: c.label,
      onclick: (e) => { catSelected.has(c.id) ? catSelected.delete(c.id) : catSelected.add(c.id); e.currentTarget.setAttribute('aria-pressed', catSelected.has(c.id)); }
    }));

    panel.appendChild(section('Schedule', h('div', { class: 'air-card' },
      h('div', { class: 'air-form' }, h('label', { class: 'air-check' }, enabled, 'Enable Sleep'), start, h('span', { class: 'muted', text: 'to' }), end),
      h('div', { class: 'air-form' }, h('div', { class: 'air-days' }, dayBtns)),
      h('h3', { style: 'margin:14px 0 8px;font-size:12px;opacity:.55;text-transform:uppercase', text: 'Categories held shut' }),
      h('div', { class: 'air-form' }, catBtns),
      h('div', { class: 'air-form' }, apps, sites),
      h('div', { class: 'air-form' }, h('button', {
        class: 'air-btn',
        onclick: async () => {
          await air.setSleep({
            enabled: enabled.checked, start: start.value, end: end.value,
            days: Array.from(selected),
            blockCategories: Array.from(catSelected),
            blockApps: apps.value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean),
            blockSites: sites.value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
          });
          render('sleep');
        }
      }, 'Save sleep schedule')))));
  }

  /* ===== Settings ===== */
  function renderSettings(panel) {
    const st = cache.state.settings;
    const caps = cache.caps;

    panel.appendChild(section('Detection', h('div', { class: 'air-card' },
      h('div', { class: 'air-sub', text: `Foreground detection: ${caps.detector ? 'active on ' + caps.platform : 'unavailable on this platform'}` }),
      h('div', { class: 'air-form', style: 'margin-top:12px' },
        h('label', { class: 'air-check' },
          h('input', { type: 'checkbox', checked: st.askUnknownApps, onchange: (e) => air.setSettings({ askUnknownApps: e.target.checked }) }),
          'Ask what an unfamiliar application or site is for'),
        h('label', { class: 'air-check' },
          h('input', { type: 'checkbox', checked: st.notifications, onchange: (e) => air.setSettings({ notifications: e.target.checked }) }),
          'Notify when something is blocked')),
      h('div', { class: 'air-form' },
        h('span', { class: 'muted', text: 'Idle after' }),
        h('input', {
          class: 'air-input', type: 'number', min: '30', max: '3600', value: st.idleAfterSeconds, style: 'width:100px',
          onchange: (e) => air.setSettings({ idleAfterSeconds: Number(e.target.value) || 180 })
        }),
        h('span', { class: 'muted', text: 'seconds' })))));

    panel.appendChild(section('Windows integration', h('div', { class: 'air-card' },
      capRow('Foreground app + window detection', caps.detector),
      capRow('Close blocked applications', caps.closeApp),
      capRow('Prevent relaunch of blocked apps', caps.preventRelaunch === 'partial' ? 'partial' : caps.preventRelaunch),
      capRow('Website blocking inside the browser', 'extension'),
      capRow('System-wide website blocking', 'elevation'),
      capRow('Tray, background running, notifications', true),
      h('div', { class: 'air-form', style: 'margin-top:12px' },
        h('label', { class: 'air-check' },
          h('input', {
            type: 'checkbox', checked: st.launchAtStartup,
            onchange: async (e) => {
              const r = await air.setStartup(e.target.checked);
              if (!r.ok) { e.target.checked = false; window.alert(r.reason || 'Could not change startup registration.'); }
            }
          }), 'Start Gem Air with Windows'),
        h('button', { class: 'air-btn subtle', onclick: () => air.island('show') }, 'Show floating island'),
        h('button', { class: 'air-btn subtle', onclick: () => air.island('hide') }, 'Hide island')))));

    panel.appendChild(section('Categories', h('div', {},
      h('div', { class: 'air-list' }, cache.state.categories.map((c) => h('div', { class: 'air-row' },
        h('i', { class: 'air-key', style: `background:${c.color}` }),
        h('span', { class: 'grow', text: c.label }),
        h('span', { class: 'air-tag', text: c.relevance }),
        c.builtin ? h('span', { class: 'muted', text: 'built in' })
          : h('button', { class: 'air-btn danger', onclick: async () => { await air.deleteCategory(c.id); render('settings'); } }, 'Remove')))),
      categoryForm())));

    panel.appendChild(section('Application rules', h('div', { class: 'air-list' },
      cache.state.appRules.slice().sort((a, b) => a.match.localeCompare(b.match)).map((r) => {
        const cat = categoryOf(r.category);
        return h('div', { class: 'air-row' },
          h('span', { class: 'grow', text: r.match }),
          h('span', { class: 'air-tag', style: `color:${cat.color};background:${cat.color}22`, text: cat.label }),
          h('span', { class: 'muted', text: r.source === 'user' ? 'yours' : 'built in' }),
          h('button', { class: 'air-btn danger', onclick: async () => { await air.deleteRule('app', r.match); render('settings'); } }, 'Remove'));
      }))));

    panel.appendChild(section('Focus ecosystem', h('div', { class: 'air-card' },
      h('p', { class: 'air-sub', text: 'Gem Air is the desktop half of your attention setup. focusarx.site holds the account, attention resources and the web Focus experience — your activity data stays on this machine either way.' }),
      h('div', { class: 'air-form', style: 'margin-top:12px' },
        h('button', { class: 'air-btn subtle', onclick: () => air.openFocusx('') }, 'Open focusarx.site'),
        h('button', { class: 'air-btn subtle', onclick: () => air.openFocusx('resources') }, 'Attention resources'),
        h('button', { class: 'air-btn subtle', onclick: () => air.openFocusx('account') }, 'Connect account')))));
  }

  function capRow(label, value) {
    const map = {
      true: ['Implemented', '#38d39f'],
      false: ['Not available', '#ff6b6b'],
      partial: ['Partial', '#ffb454'],
      extension: ['Via browser extension', '#6f8cff'],
      elevation: ['Requires elevated helper', '#ffb454']
    };
    const [text, color] = map[String(value)] || map.false;
    return h('div', { class: 'air-row' },
      h('span', { class: 'grow', text: label }),
      h('span', { class: 'air-tag', style: `color:${color};background:${color}22`, text }));
  }

  function categoryForm() {
    const label = h('input', { class: 'air-input', placeholder: 'New category' });
    const color = h('input', { class: 'air-input', type: 'color', value: '#7c5cff', style: 'width:54px;padding:4px' });
    const rel = h('select', { class: 'air-select' },
      h('option', { value: 'focus', text: 'Counts as focus' }),
      h('option', { value: 'neutral', text: 'Neutral' }),
      h('option', { value: 'distraction', text: 'Counts as distraction' }));
    return h('div', { class: 'air-form', style: 'margin-top:12px' }, label, color, rel,
      h('button', {
        class: 'air-btn',
        onclick: async () => {
          if (!label.value.trim()) return;
          await air.createCategory({ label: label.value.trim(), color: color.value, relevance: rel.value });
          render('settings');
        }
      }, 'Add category'));
  }

  /* ---------- wiring ---------- */
  document.getElementById('airIslandToggle').addEventListener('click', async (e) => {
    const showing = e.currentTarget.dataset.on !== '1';
    await air.island(showing ? 'show' : 'hide');
    e.currentTarget.dataset.on = showing ? '1' : '0';
    e.currentTarget.textContent = showing ? 'Hide island' : 'Show island';
  });
  document.getElementById('airFocusx').addEventListener('click', (e) => { e.preventDefault(); air.openFocusx(''); });

  air.onUpdate((snap) => {
    cache.snapshot = snap;
    const headline = document.getElementById('airHeadline');
    const is = snap.island;
    headline.textContent = is.mode === 'blocked' ? `${is.primary} blocked — ${is.blockReason}`
      : is.mode === 'sleep' ? `Sleep active until ${is.sleep.end}`
      : is.mode === 'idle' ? 'Idle'
      : `${is.primary} · ${is.secondary || ''}`;
    if (active === 'dashboard' && root.classList.contains('active')) {
      // cheap refresh: only the stat cards, every update
      clearTimeout(render._t);
      render._t = setTimeout(() => { if (active === 'dashboard') render('dashboard'); }, 4000);
    }
  });

  const navBtn = document.querySelector('.nav-btn[data-view="attention"]');

  air.onNavigate((tab) => {
    if (navBtn) navBtn.click();
    show(tab);
  });

  // first paint when the view is opened (main window) or immediately (preview host)
  if (navBtn) navBtn.addEventListener('click', () => setTimeout(() => show(active), 30));
  if (root.classList.contains('active')) show('dashboard');
})();
