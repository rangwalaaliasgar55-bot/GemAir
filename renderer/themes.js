/* ============================================================
   GemAir — HUD Theme Engine (string-driven)
   ------------------------------------------------------------
   Every HUD theme is a plain object of STRING color tokens.
   This file is the single source of truth for the look of the
   whole interface (Stonic-style "recolour the entire interface"):

     • DOM  — the engine writes the tokens out as CSS custom
              properties (--accent, --accent-glow, …) on <body>,
              so every panel, button, bar and glow re-skins.
     • Canvas — app.js listens for the `gemair:theme` event and
              feeds the accent string into getAccent(), which the
              orb, background, Agent Town, globe, map and mood
              canvases all draw from.
     • UI   — the top-bar swatches, the Settings → HUD THEMES
              picker and the command palette are all generated
              from this same table.

   Add a new theme = add one object of strings below. Nothing
   else changes.
   ============================================================ */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // The theme table — every value is a plain string token.
  // `hue` is the HSL hue of the accent (used by the RGB cycler and
  // any canvas code that needs a numeric hue).
  // ------------------------------------------------------------------
  const THEMES = {
    crimson: {
      label: 'Crimson',
      tagline: 'JARVIS red — classic Iron Man',
      accent: '#ff3b3b', lightAccent: '#c92a2a', hue: 0,
      bg: '#04060c', bg2: '#070b15',
      text: '#e7f0ff', dim: '#8a9bb2',
      good: '#3dff9a', warn: '#ffc24b',
      error: '#ff6b6b', info: '#3bc9ff',
      panel: 'rgba(12, 18, 32, 0.76)', panelBorder: 'rgba(120, 140, 180, 0.18)',
      sweep: 'rgba(255, 59, 59, 0.32)'
    },
    emerald: {
      label: 'Emerald',
      tagline: 'Hacker green — matrix terminal',
      accent: '#35ffb0', lightAccent: '#087f5b', hue: 152,
      bg: '#040a08', bg2: '#071310',
      text: '#e9fff5', dim: '#7fae9c',
      good: '#3dff9a', warn: '#ffc24b',
      error: '#ff6b6b', info: '#3bc9ff',
      panel: 'rgba(12, 22, 20, 0.76)', panelBorder: 'rgba(100, 180, 150, 0.18)',
      sweep: 'rgba(53, 255, 176, 0.32)'
    },
    cyan: {
      label: 'Cyan',
      tagline: 'Cyberpunk blue — neon city',
      accent: '#3bc9ff', lightAccent: '#066a9c', hue: 198,
      bg: '#04080d', bg2: '#071019',
      text: '#e6f6ff', dim: '#7fa3b8',
      good: '#3dff9a', warn: '#ffc24b',
      error: '#ff6b6b', info: '#3bc9ff',
      panel: 'rgba(10, 18, 32, 0.76)', panelBorder: 'rgba(90, 160, 200, 0.18)',
      sweep: 'rgba(59, 201, 255, 0.32)'
    },
    violet: {
      label: 'Violet',
      tagline: 'Nebula purple — deep space',
      accent: '#b05cff', lightAccent: '#7048a8', hue: 275,
      bg: '#06040d', bg2: '#0b0716',
      text: '#f0e9ff', dim: '#a08bb8',
      good: '#3dff9a', warn: '#ffc24b',
      error: '#ff6b6b', info: '#3bc9ff',
      panel: 'rgba(16, 12, 32, 0.76)', panelBorder: 'rgba(140, 120, 200, 0.18)',
      sweep: 'rgba(176, 92, 255, 0.32)'
    },
    amber: {
      label: 'Amber',
      tagline: 'Warm core — cockpit instruments',
      accent: '#ffb73b', lightAccent: '#9a5b00', hue: 38,
      bg: '#0a0604', bg2: '#120b06',
      text: '#fff3e2', dim: '#b39a7c',
      good: '#3dff9a', warn: '#ffc24b',
      error: '#ff6b6b', info: '#3bc9ff',
      panel: 'rgba(24, 18, 12, 0.76)', panelBorder: 'rgba(200, 160, 100, 0.18)',
      sweep: 'rgba(255, 183, 59, 0.32)'
    },
    graphite: {
      label: 'Graphite',
      tagline: 'Quiet studio — focused and minimal',
      accent: '#d9dee8', lightAccent: '#596579', hue: 218,
      bg: '#08090c', bg2: '#11141a',
      text: '#f1f3f6', dim: '#8d96a5',
      good: '#73d9a4', warn: '#e4b86a',
      error: '#ef8888', info: '#8db7e8',
      panel: 'rgba(23, 26, 32, 0.86)', panelBorder: 'rgba(220, 228, 240, 0.14)',
      sweep: 'rgba(220, 228, 240, 0.2)'
    },
    ocean: {
      label: 'Ocean',
      tagline: 'Deep blue — calm focus',
      accent: '#75b9ff', lightAccent: '#24649b', hue: 210,
      bg: '#060a11', bg2: '#0a1523',
      text: '#edf6ff', dim: '#88a2bd',
      good: '#7de0bb', warn: '#efc879',
      error: '#ef8e9a', info: '#75b9ff',
      panel: 'rgba(12, 24, 40, 0.82)', panelBorder: 'rgba(120, 180, 230, 0.16)',
      sweep: 'rgba(117, 185, 255, 0.24)'
    },
    rgb: {
      label: 'RGB',
      tagline: 'Rainbow cycle — full spectrum',
      accent: '#ff3bff', lightAccent: '#9c2c9c', hue: 300,
      dynamic: true,
      bg: '#04060c', bg2: '#070b15',
      text: '#e7f0ff', dim: '#8a9bb2',
      good: '#3dff9a', warn: '#ffc24b',
      error: '#ff6b6b', info: '#3bc9ff',
      panel: 'rgba(12, 18, 32, 0.76)', panelBorder: 'rgba(120, 140, 180, 0.18)',
      sweep: 'rgba(255, 59, 255, 0.32)'
    }
  };

  const ORDER = ['crimson', 'emerald', 'cyan', 'violet', 'amber', 'graphite', 'ocean', 'rgb'];
  const DEFAULT = 'crimson';

  // "#rrggbb" → "rgba(r, g, b, a)" (string in, string out)
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'rgba(255,255,255,' + a + ')';
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
  }

  // Derive the full CSS custom-property set from a theme's string tokens.
  // U5: glass depth strictly via tokens — panel, border, error, info, sweep all via themes.js
  function derive(theme, appearance) {
    const light = appearance === 'light';
    const a = light ? (theme.lightAccent || theme.accent) : theme.accent;
    return {
      accent: a,
      'accent-soft': rgba(a, light ? 0.7 : 0.55),
      'accent-glow': rgba(a, light ? 0.2 : 0.32),
      'accent-dim': rgba(a, light ? 0.1 : 0.14),
      bg: light ? '#f4f7fb' : theme.bg,
      'bg-2': light ? '#e5ebf3' : theme.bg2,
      text: light ? '#111827' : theme.text,
      'text-dim': light ? '#526077' : theme.dim,
      good: light ? '#087f5b' : theme.good,
      warn: light ? '#8a5700' : theme.warn,
      error: light ? '#c92a2a' : (theme.error || '#ff6b6b'),
      info: light ? '#066a9c' : (theme.info || '#3bc9ff'),
      panel: light ? 'rgba(255, 255, 255, 0.78)' : (theme.panel || 'rgba(12, 18, 32, 0.76)'),
      'panel-border': light ? 'rgba(45, 60, 85, 0.2)' : (theme.panelBorder || 'rgba(120, 140, 180, 0.18)'),
      sweep: rgba(a, light ? 0.2 : 0.32)
    };
  }

  let current = DEFAULT;
  let currentAppearance = 'dark';

  function getTheme(name) {
    const id = THEMES[name] ? name : DEFAULT;
    return { id, ...THEMES[id] };
  }

  function apply(name) {
    const id = THEMES[name] ? name : DEFAULT;
    const theme = THEMES[id];
    const vars = derive(theme, currentAppearance);
    current = id;

    if (typeof document !== 'undefined') {
      const body = document.body;
      if (body) { body.dataset.theme = id; body.dataset.appearance = currentAppearance; }
      // Write every token out as a CSS variable — this is what makes
      // the ENTIRE interface recolour, exactly like Stonic's HUD themes.
      const target = body ? body.style : document.documentElement.style;
      for (const k of Object.keys(vars)) target.setProperty('--' + k, vars[k]);
      document.dispatchEvent(new CustomEvent('gemair:theme', {
        detail: { theme: id, label: theme.label, accent: vars.accent, hue: theme.hue, dynamic: !!theme.dynamic, appearance: currentAppearance }
      }));
    }
    return { ...getTheme(id), accent: vars.accent, appearance: currentAppearance };
  }

  function setAppearance(mode) {
    currentAppearance = mode === 'light' ? 'light' : 'dark';
    return apply(current);
  }

  const api = {
    ORDER,
    DEFAULT,
    list() { return ORDER.map((k) => ({ id: k, ...THEMES[k] })); },
    get(name) { return getTheme(name); },
    current() { return current; },
    isDynamic(name) { return !!THEMES[name || current].dynamic; },
    appearance() { return currentAppearance; },
    setAppearance,
    apply
  };

  window.GemAirThemes = api;
})();
