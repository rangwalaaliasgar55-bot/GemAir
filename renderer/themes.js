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
      accent: '#d25c66', lightAccent: '#b94854', hue: 0,
      bg: '#101114', bg2: '#17191e',
      text: '#f3f4f6', dim: '#969ca7',
      good: '#63c392', warn: '#d5a85a',
      error: '#dc858b', info: '#6fa4df',
      panel: 'rgba(30, 34, 42, 0.84)', panelBorder: 'rgba(160, 170, 188, 0.16)',
      sweep: 'rgba(210, 92, 102, 0.2)'
    },
    emerald: {
      label: 'Emerald',
      tagline: 'Fresh green — focused work',
      accent: '#58b88d', lightAccent: '#23805d', hue: 152,
      bg: '#0f1412', bg2: '#171e1a',
      text: '#edf6f0', dim: '#9aada1',
      good: '#63c392', warn: '#d5a85a',
      error: '#dc858b', info: '#6fa4df',
      panel: 'rgba(27, 39, 33, 0.84)', panelBorder: 'rgba(126, 178, 149, 0.18)',
      sweep: 'rgba(88, 184, 141, 0.2)'
    },
    cyan: {
      label: 'Cyan',
      tagline: 'Clear blue — calm focus',
      // Keep the long-standing cyan tokens for saved profiles and migration
      // compatibility. The workspace shell maps them to a softer UI accent
      // in reference.css, so this does not bring the neon HUD back.
      accent: '#3bc9ff', lightAccent: '#066a9c', hue: 198,
      bg: '#04080d', bg2: '#071019',
      text: '#e6f6ff', dim: '#7fa3b8',
      good: '#63ffb0', warn: '#d5a85a',
      error: '#dc858b', info: '#6fa4df',
      panel: 'rgba(27, 35, 47, 0.84)', panelBorder: 'rgba(126, 165, 208, 0.18)',
      sweep: 'rgba(90, 149, 216, 0.2)'
    },
    violet: {
      label: 'Violet',
      tagline: 'Soft violet — evening mode',
      accent: '#9585d0', lightAccent: '#675ba0', hue: 275,
      bg: '#121119', bg2: '#1b1826',
      text: '#f3effb', dim: '#aaa1bc',
      good: '#63c392', warn: '#d5a85a',
      error: '#dc858b', info: '#6fa4df',
      panel: 'rgba(35, 31, 48, 0.84)', panelBorder: 'rgba(159, 145, 202, 0.18)',
      sweep: 'rgba(149, 133, 208, 0.2)'
    },
    amber: {
      label: 'Amber',
      tagline: 'Warm amber — evening light',
      accent: '#c99858', lightAccent: '#946a32', hue: 38,
      bg: '#15120e', bg2: '#211b14',
      text: '#f8f1e7', dim: '#b7a58e',
      good: '#63c392', warn: '#d5a85a',
      error: '#dc858b', info: '#6fa4df',
      panel: 'rgba(40, 33, 24, 0.84)', panelBorder: 'rgba(196, 160, 106, 0.18)',
      sweep: 'rgba(201, 152, 88, 0.2)'
    },
    graphite: {
      label: 'Graphite',
      tagline: 'Quiet studio — focused and minimal',
      accent: '#b8c0cb', lightAccent: '#667486', hue: 218,
      bg: '#101216', bg2: '#191c22',
      text: '#f1f3f6', dim: '#9da5b2',
      good: '#77c69e', warn: '#d5b274',
      error: '#dc9292', info: '#8eb3df',
      panel: 'rgba(31, 35, 43, 0.88)', panelBorder: 'rgba(220, 228, 240, 0.14)',
      sweep: 'rgba(184, 192, 203, 0.16)'
    },
    ocean: {
      label: 'Ocean',
      tagline: 'Deep blue — calm focus',
      accent: '#6b9ed4', lightAccent: '#3d6f9f', hue: 210,
      bg: '#0e141d', bg2: '#172231',
      text: '#edf3fa', dim: '#9aaec3',
      good: '#79c9aa', warn: '#d6b675',
      error: '#db929b', info: '#76a6d7',
      panel: 'rgba(27, 38, 52, 0.86)', panelBorder: 'rgba(131, 174, 218, 0.16)',
      sweep: 'rgba(107, 158, 212, 0.18)'
    },
    porcelain: {
      label: 'Porcelain',
      tagline: 'Apple-clean neutrals — calm and minimal',
      accent: '#0a84ff', lightAccent: '#0071e3', hue: 211,
      bg: '#f5f5f7', bg2: '#e8e8ed',
      text: '#1d1d1f', dim: '#6e6e73',
      good: '#1d8127', warn: '#9a6700',
      error: '#c92a2a', info: '#0071e3',
      panel: 'rgba(255, 255, 255, 0.72)', panelBorder: 'rgba(60, 60, 67, 0.14)',
      sweep: 'rgba(10, 132, 255, 0.18)'
    },
    midnight: {
      label: 'Midnight',
      tagline: 'Apple-dark neutrals — quiet studio',
      accent: '#0a84ff', lightAccent: '#0071e3', hue: 211,
      bg: '#000000', bg2: '#161617',
      text: '#f5f5f7', dim: '#98989d',
      good: '#30d158', warn: '#ffd60a',
      error: '#ff6961', info: '#64d2ff',
      panel: 'rgba(28, 28, 30, 0.72)', panelBorder: 'rgba(255, 255, 255, 0.09)',
      sweep: 'rgba(10, 132, 255, 0.22)'
    },
    rgb: {
      label: 'RGB',
      tagline: 'Dynamic spectrum — playful accent',
      accent: '#b68bd2', lightAccent: '#7e5e9b', hue: 300,
      dynamic: true,
      bg: '#101114', bg2: '#17191e',
      text: '#f3f4f6', dim: '#969ca7',
      good: '#63c392', warn: '#d5a85a',
      error: '#dc858b', info: '#6fa4df',
      panel: 'rgba(30, 34, 42, 0.84)', panelBorder: 'rgba(160, 170, 188, 0.16)',
      sweep: 'rgba(182, 139, 210, 0.2)'
    }
  };

  const ORDER = ['porcelain', 'midnight', 'crimson', 'emerald', 'cyan', 'violet', 'amber', 'graphite', 'ocean', 'rgb'];
  const DEFAULT = 'cyan';

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
