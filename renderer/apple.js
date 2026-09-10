/* ============================================================
   GemAir — Apple-like functions (original work, no copied assets)
   - Control Center: connectivity (real), DND, brightness, volume
   - Spotlight trigger buttons (reuses existing #palette)
   - Focus/DND + battery/network widgets (real APIs only)
   - Settings Apple-ID mirror (reads existing #accountState)
   All guarded: never throws, never invents system state.
   ============================================================ */
(function () {
  'use strict';

  function $(id) {
    try { return document.getElementById(id); } catch { return null; }
  }

  function toast(msg) {
    try {
      const box = $('toasts');
      if (!box || document.body.dataset.dnd === 'on') return;
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = String(msg).slice(0, 220);
      box.appendChild(el);
      setTimeout(() => { try { el.remove(); } catch {} }, 4200);
    } catch {}
  }

  function openSpotlight() {
    try {
      const p = $('palette');
      const input = $('paletteInput');
      if (!p || !input) return;
      p.classList.add('open');
      input.focus();
      input.select();
    } catch {}
  }

  function setupSpotlightButtons() {
    ['appleSpotlightBtn', 'appleSpotlightBtn2'].forEach((id) => {
      const b = $(id);
      if (b && !b.dataset.appleBound) {
        b.dataset.appleBound = '1';
        b.addEventListener('click', openSpotlight);
      }
    });
    try {
      const input = $('paletteInput');
      if (input && !input.dataset.applePh) {
        input.dataset.applePh = '1';
        input.placeholder = 'Spotlight Search — commands, memory, actions…';
      }
    } catch {}
  }

  function setupControlCenter() {
    const btn = $('appleControlBtn');
    const panel = $('appleControlPanel');
    if (!btn || !panel || btn.dataset.appleBound) return;
    btn.dataset.appleBound = '1';
    const close = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => {
      try {
        e.stopPropagation();
        panel.hidden = !panel.hidden;
        btn.setAttribute('aria-expanded', String(!panel.hidden));
        if (!panel.hidden) refreshCcWidgets();
      } catch {}
    });
    document.addEventListener('click', (e) => {
      try {
        if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
      } catch {}
    });
    document.addEventListener('keydown', (e) => { try { if (e.key === 'Escape') close(); } catch {} });
  }

  function setToggle(id, on, sub) {
    try {
      const el = $(id);
      if (!el) return;
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      const s = el.querySelector('small');
      if (s && typeof sub === 'string') s.textContent = sub;
    } catch {}
  }

  function refreshCcWidgets() {
    try {
      setToggle('ccWifi', navigator.onLine !== false, navigator.onLine !== false ? 'Connected' : 'Offline');
      setToggle('ccDnd', document.body.dataset.dnd === 'on', document.body.dataset.dnd === 'on' ? 'Silenced' : 'Allowed');
      try { const d = $('appleDndCheck'); if (d) d.checked = document.body.dataset.dnd === 'on'; } catch {}
      updateNetBadge();
      updateBatteryBadge();
    } catch {}
  }

  function updateNetBadge() {
    try {
      const on = navigator.onLine !== false;
      ['appleNet', 'appleNet2'].forEach((id) => {
        const el = $(id);
        if (el) el.textContent = on ? '● ONLINE' : '○ OFFLINE';
      });
      setToggle('ccWifi', on, on ? 'Connected' : 'Offline');
    } catch {}
  }

  function updateBatteryBadge() {
    try {
      const els = [$('appleBattery'), $('appleBattery2')].filter(Boolean);
      if (!els.length) return;
      if (navigator.getBattery) {
        navigator.getBattery().then((b) => {
          const pct = Math.round((b.level || 0) * 100);
          const txt = '🔋 ' + pct + '%' + (b.charging ? ' ⚡' : '');
          els.forEach((el) => { try { el.textContent = txt; } catch {} });
        }).catch(() => { els.forEach((el) => { try { el.textContent = '🔋 —'; } catch {} }); });
      } else {
        els.forEach((el) => { try { el.textContent = '🔋 —'; } catch {} });
      }
    } catch {}
  }

  function setupCcControls() {
    try {
      const wifi = $('ccWifi');
      if (wifi && !wifi.dataset.appleBound) {
        wifi.dataset.appleBound = '1';
        wifi.addEventListener('click', () => {
          tick();
          toast(navigator.onLine !== false ? 'Wi-Fi: online (read-only — managed by OS).' : 'Offline — check your connection.');
          refreshCcWidgets();
        });
      }
      const dnd = $('ccDnd');
      if (dnd && !dnd.dataset.appleBound) {
        dnd.dataset.appleBound = '1';
        dnd.addEventListener('click', () => {
          tick();
          const on = document.body.dataset.dnd !== 'on';
          setDnd(on);
          if (!on) toast('Notifications resumed.');
        });
      }
      const focus = $('ccFocus');
      if (focus && !focus.dataset.appleBound) {
        focus.dataset.appleBound = '1';
        focus.addEventListener('click', () => {
          try {
            const chip = document.querySelector('.mode-chip[data-mode="WORK"]');
            if (chip) chip.click();
            else toast('Focus: Work — open Modes to customize.');
          } catch { toast('Focus: Work requested.'); }
        });
      }
      const theme = $('ccTheme');
      if (theme && !theme.dataset.appleBound) {
        theme.dataset.appleBound = '1';
        theme.addEventListener('click', () => {
          try {
            if (window.GemAirThemes) {
              const order = window.GemAirThemes.ORDER || ['crimson', 'cyan'];
              const cur = window.GemAirThemes.current ? window.GemAirThemes.current() : order[0];
              const next = order[(order.indexOf(cur) + 1) % order.length];
              window.GemAirThemes.apply(next);
              toast('Theme: ' + next);
            }
          } catch {}
        });
      }
    } catch {}
  }

  function mirrorAppleId() {
    try {
      const src = $('accountState');
      const dst = $('appleIdState');
      if (!src || !dst) return;
      const sync = () => { try { dst.textContent = src.textContent; } catch {} };
      sync();
      try {
        const obs = new MutationObserver(sync);
        obs.observe(src, { childList: true, characterData: true, subtree: true });
      } catch { setInterval(sync, 3000); }
    } catch {}
  }

  function setupAppleSettingsShortcuts() {
    try {
      const cc = $('appleCcOpenBtn');
      if (cc && !cc.dataset.appleBound) {
        cc.dataset.appleBound = '1';
        cc.addEventListener('click', () => {
          try {
            const panel = $('appleControlPanel');
            const btn = $('appleControlBtn');
            if (panel) { panel.hidden = false; refreshCcWidgets(); }
            if (btn) btn.setAttribute('aria-expanded', 'true');
          } catch {}
        });
      }
      const sp = $('appleSpotOpenBtn');
      if (sp && !sp.dataset.appleBound) {
        sp.dataset.appleBound = '1';
        sp.addEventListener('click', openSpotlight);
      }
      const dnd = $('appleDndCheck');
      if (dnd && !dnd.dataset.appleBound) {
        dnd.dataset.appleBound = '1';
        dnd.checked = document.body.dataset.dnd === 'on';
        dnd.addEventListener('change', () => {
          setDnd(dnd.checked);
        });
      }
      pairSliders('ccBrightness', 'appleBrightSet', 'gemair:apple-bright', 100, applyBrightness);
      pairSliders('ccVolume', 'appleVolSet', 'gemair:apple-volume', 80, applyVolume);
    } catch {}
  }

  function setDnd(on) {
    try {
      document.body.dataset.dnd = on ? 'on' : 'off';
      localStorage.setItem('gemair:apple-dnd', on ? 'on' : 'off');
    } catch {}
    refreshCcWidgets();
  }

  function applyBrightness(v) {
    try {
      const dim = $('appleDim');
      const n = Math.min(100, Math.max(40, Number(v) || 100));
      if (dim) dim.style.opacity = String(Math.min(0.55, Math.max(0, (100 - n) / 100 * 0.7)));
      localStorage.setItem('gemair:apple-bright', String(n));
    } catch {}
  }

  function applyVolume(v) {
    try {
      const n = Math.min(100, Math.max(0, Number(v) || 0));
      document.querySelectorAll('audio').forEach((a) => { try { a.volume = n / 100; } catch {} });
      localStorage.setItem('gemair:apple-volume', String(n));
      window.GemAirAppleVolume = n / 100;
    } catch {}
  }

  function pairSliders(idA, idB, storeKey, fallback, apply) {
    try {
      const a = $(idA), b = $(idB);
      if (!a && !b) return;
      let saved = fallback;
      try { saved = Number(localStorage.getItem(storeKey) || fallback) || fallback; } catch {}
      const sync = (src, dst) => {
        try {
          if (dst && dst !== src) dst.value = String(src.value);
          apply(src.value);
        } catch {}
      };
      [a, b].forEach((el) => {
        if (!el || el.dataset.applePair) return;
        el.dataset.applePair = '1';
        el.value = String(saved);
        el.addEventListener('input', () => sync(el, el === a ? b : a));
      });
      apply(saved);
    } catch {}
  }

  function restoreDnd() {
    try {
      const v = localStorage.getItem('gemair:apple-dnd');
      document.body.dataset.dnd = v === 'on' ? 'on' : 'off';
    } catch { document.body.dataset.dnd = 'off'; }
  }

  function tick() {
    try { if (navigator.vibrate) navigator.vibrate(5); } catch {}
  }

  /* ============================================================
     Reference-parity behaviors (all guarded, all functional —
     every control below performs its labeled action).
     ============================================================ */

  function setupSatMap() {
    try {
      const stage = $('satStage');
      const zoomWrap = $('satZoomWrap');
      const img = $('satGlobeImg');
      if (img && !img.dataset.appleBound) {
        img.dataset.appleBound = '1';
        // Missing art must never leave a broken-image box: canvas carries on.
        img.addEventListener('error', () => { try { img.remove(); } catch {} });
      }
      const townImg = $('townStageImg');
      if (townImg && !townImg.dataset.appleBound) {
        townImg.dataset.appleBound = '1';
        townImg.addEventListener('error', () => { try { townImg.remove(); } catch {} });
      }
      let zoom = 1;
      const applyZoom = () => { try { if (zoomWrap) zoomWrap.style.transform = 'scale(' + zoom + ')'; } catch {} };
      const zi = $('satZoomIn');
      if (zi && !zi.dataset.appleBound) {
        zi.dataset.appleBound = '1';
        zi.addEventListener('click', () => { zoom = Math.min(2.5, +(zoom + 0.25).toFixed(2)); applyZoom(); tick(); });
      }
      const zo = $('satZoomOut');
      if (zo && !zo.dataset.appleBound) {
        zo.dataset.appleBound = '1';
        zo.addEventListener('click', () => { zoom = Math.max(1, +(zoom - 0.25).toFixed(2)); applyZoom(); tick(); });
      }
      const zr = $('satZoomReset');
      if (zr && !zr.dataset.appleBound) {
        zr.dataset.appleBound = '1';
        zr.addEventListener('click', () => { zoom = 1; applyZoom(); tick(); });
      }
      const toggle = $('satMapToggle');
      const setMapOpen = (open) => {
        try {
          if (zoomWrap) zoomWrap.style.display = open ? '' : 'none';
          if (img) img.style.display = open ? '' : 'none';
          toggle.textContent = open ? 'Hide Map' : 'Show Map';
          toggle.setAttribute('aria-expanded', String(open));
        } catch {}
      };
      if (toggle && !toggle.dataset.appleBound) {
        toggle.dataset.appleBound = '1';
        toggle.addEventListener('click', () => {
          const open = zoomWrap ? zoomWrap.style.display === 'none' : true;
          setMapOpen(open); tick();
        });
      }
      const b2d = $('satMode2d'), b3d = $('satMode3d');
      const setMode = (flat) => {
        try {
          if (stage) stage.dataset.mode = flat ? '2d' : '3d';
          if (b2d) { b2d.classList.toggle('active', flat); b2d.setAttribute('aria-pressed', String(flat)); }
          if (b3d) { b3d.classList.toggle('active', !flat); b3d.setAttribute('aria-pressed', String(!flat)); }
        } catch {}
      };
      if (b2d && !b2d.dataset.appleBound) { b2d.dataset.appleBound = '1'; b2d.addEventListener('click', () => { setMode(true); tick(); }); }
      if (b3d && !b3d.dataset.appleBound) { b3d.dataset.appleBound = '1'; b3d.addEventListener('click', () => { setMode(false); tick(); }); }
      const fs = $('satFullscreen');
      if (fs && !fs.dataset.appleBound) {
        fs.dataset.appleBound = '1';
        fs.addEventListener('click', () => {
          try {
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
            else if (stage && stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
          } catch {}
        });
      }
      // Bottom nav drives the REAL sat tabs; More jumps to the world view.
      document.querySelectorAll('[data-goto-sat]').forEach((btn) => {
        if (btn.dataset.appleBound) return;
        btn.dataset.appleBound = '1';
        btn.addEventListener('click', () => {
          try {
            const tab = document.querySelector('.sat-tab[data-sat="' + btn.dataset.gotoSat + '"]');
            if (tab) tab.click();
            document.querySelectorAll('[data-goto-sat]').forEach((b) => b.classList.toggle('on', b === btn));
          } catch {}
        });
      });
      document.querySelectorAll('[data-goto-view]').forEach((btn) => {
        if (btn.dataset.appleBound) return;
        btn.dataset.appleBound = '1';
        btn.addEventListener('click', () => {
          try {
            const nav = document.querySelector('.nav-btn[data-view="' + btn.dataset.gotoView + '"]');
            if (nav) nav.click();
          } catch {}
        });
      });
    } catch {}
  }

  function setupSatUpdateCard() {
    try {
      const card = $('satUpdateCard');
      const pill = $('updatePill');
      if (!card) return;
      const sync = () => {
        try {
          const available = pill && !pill.hidden;
          const dismissed = sessionStorage.getItem('gemair:sat-update-dismissed') === '1';
          card.hidden = !(available && !dismissed);
        } catch { card.hidden = true; }
      };
      sync();
      try {
        if (pill) new MutationObserver(sync).observe(pill, { attributes: true, attributeFilter: ['hidden'] });
      } catch { setInterval(sync, 5000); }
      const reload = $('satUpdateReload');
      if (reload && !reload.dataset.appleBound) {
        reload.dataset.appleBound = '1';
        // Same flow as the topbar update pill — one code path, no duplicate.
        reload.addEventListener('click', () => { try { if (pill) pill.click(); } catch {} });
      }
      const dismiss = $('satUpdateDismiss');
      if (dismiss && !dismiss.dataset.appleBound) {
        dismiss.dataset.appleBound = '1';
        dismiss.addEventListener('click', () => {
          try { sessionStorage.setItem('gemair:sat-update-dismissed', '1'); } catch {}
          sync();
        });
      }
    } catch {}
  }

  function setupChatNewPill() {
    try {
      const log = $('chatLog');
      const pill = $('chatNewMsgPill');
      if (!log || !pill || pill.dataset.appleBound) return;
      pill.dataset.appleBound = '1';
      const nearBottom = () => {
        try { return log.scrollHeight - log.scrollTop - log.clientHeight < 90; } catch { return true; }
      };
      const onScroll = () => { try { if (nearBottom()) pill.hidden = true; } catch {} };
      log.addEventListener('scroll', onScroll);
      pill.addEventListener('click', () => {
        try { log.scrollTop = log.scrollHeight; pill.hidden = true; } catch {}
      });
      try {
        new MutationObserver(() => {
          try { if (!nearBottom()) pill.hidden = false; } catch {}
        }).observe(log, { childList: true, subtree: true });
      } catch {}
    } catch {}
  }

  function setupChatAttach() {
    try {
      const btn = $('chatAttachBtn');
      const file = $('chatAttachInput');
      const input = $('chatInput');
      if (!btn || !file || !input || btn.dataset.appleBound) return;
      btn.dataset.appleBound = '1';
      btn.addEventListener('click', () => { try { file.click(); } catch {} });
      file.addEventListener('change', () => {
        try {
          const f = file.files && file.files[0];
          if (!f) return;
          if (f.size > 256 * 1024) { toast('File too large — 256 KB max for chat attach.'); file.value = ''; return; }
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const text = String(reader.result || '').slice(0, 8000);
              input.value = (input.value ? input.value.replace(/\s+$/, '') + '\n\n' : '') +
                '--- attached: ' + f.name + ' ---\n' + text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.focus();
            } catch {}
          };
          reader.onerror = () => toast('Could not read that file.');
          reader.readAsText(f);
          file.value = '';
        } catch {}
      });
    } catch {}
  }

  function init() {
    try { document.body.dataset.apple = '1'; } catch {}
    restoreDnd();
    setupSpotlightButtons();
    setupControlCenter();
    setupCcControls();
    setupAppleSettingsShortcuts();
    setupSatMap();
    setupSatUpdateCard();
    setupChatNewPill();
    setupChatAttach();
    mirrorAppleId();
    updateNetBadge();
    updateBatteryBadge();
    try {
      window.addEventListener('online', updateNetBadge);
      window.addEventListener('offline', updateNetBadge);
    } catch {}
    window.GemAirApple = { openSpotlight, refreshCcWidgets };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
