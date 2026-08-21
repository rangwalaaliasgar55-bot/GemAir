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
      accent: '#ff3b3b', hue: 0,
      bg: '#04060c', bg2: '#070b15',
      text: '#e7f0ff', dim: '#8a9bb2',
      good: '#3dff9a', warn: '#ffc24b'
    },
    emerald: {
      label: 'Emerald',
      tagline: 'Hacker green — matrix terminal',
      accent: '#35ffb0', hue: 152,
      bg: '#040a08', bg2: '#071310',
      text: '#e9fff5', dim: '#7fae9c',
      good: '#3dff9a', warn: '#ffc24b'
    },
    cyan: {
      label: 'Cyan',
      tagline: 'Cyberpunk blue — neon city',
      accent: '#3bc9ff', hue: 198,
      bg: '#04080d', bg2: '#071019',
      text: '#e6f6ff', dim: '#7fa3b8',
      good: '#3dff9a', warn: '#ffc24b'
    },
    violet: {
      label: 'Violet',
      tagline: 'Nebula purple — deep space',
      accent: '#b05cff', hue: 275,
      bg: '#06040d', bg2: '#0b0716',
      text: '#f0e9ff', dim: '#a08bb8',
      good: '#3dff9a', warn: '#ffc24b'
    },
    amber: {
      label: 'Amber',
      tagline: 'Warm core — cockpit instruments',
      accent: '#ffb73b', hue: 38,
      bg: '#0a0604', bg2: '#120b06',
      text: '#fff3e2', dim: '#b39a7c',
      good: '#3dff9a', warn: '#ffc24b'
    },
    rgb: {
      label: 'RGB',
      tagline: 'Rainbow cycle — full spectrum',
      accent: '#ff3bff', hue: 300,
      dynamic: true, // accent hue animates continuously
      bg: '#04060c', bg2: '#070b15',
      text: '#e7f0ff', dim: '#8a9bb2',
      good: '#3dff9a', warn: '#ffc24b'
    }
  };

  const ORDER = ['crimson', 'emerald', 'cyan', 'violet', 'amber', 'rgb'];
  const DEFAULT = 'crimson';

  // "#rrggbb" → "rgba(r, g, b, a)" (string in, string out)
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'rgba(255,255,255,' + a + ')';
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
  }

  // Derive the full CSS custom-property set from a theme's string tokens.
  function derive(theme) {
    const a = theme.accent;
    return {
      accent: a,
      'accent-soft': rgba(a, 0.55),
      'accent-glow': rgba(a, 0.32),
      'accent-dim': rgba(a, 0.14),
      bg: theme.bg,
      'bg-2': theme.bg2,
      text: theme.text,
      'text-dim': theme.dim,
      good: theme.good,
      warn: theme.warn
    };
  }

  let current = DEFAULT;

  function getTheme(name) {
    const id = THEMES[name] ? name : DEFAULT;
    return { id, ...THEMES[id] };
  }

  function apply(name) {
    const id = THEMES[name] ? name : DEFAULT;
    const theme = THEMES[id];
    current = id;

    if (typeof document !== 'undefined') {
      const body = document.body;
      if (body) body.dataset.theme = id;
      // Write every token out as a CSS variable — this is what makes
      // the ENTIRE interface recolour, exactly like Stonic's HUD themes.
      const target = body ? body.style : document.documentElement.style;
      const vars = derive(theme);
      for (const k of Object.keys(vars)) target.setProperty('--' + k, vars[k]);
      document.dispatchEvent(new CustomEvent('gemair:theme', {
        detail: { theme: id, label: theme.label, accent: theme.accent, hue: theme.hue, dynamic: !!theme.dynamic }
      }));
    }
    return getTheme(id);
  }

  const api = {
    ORDER,
    DEFAULT,
    list() { return ORDER.map((k) => ({ id: k, ...THEMES[k] })); },
    get(name) { return getTheme(name); },
    current() { return current; },
    isDynamic(name) { return !!THEMES[name || current].dynamic; },
    apply
  };

  window.GemAirThemes = api;
})();
