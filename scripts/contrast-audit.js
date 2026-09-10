#!/usr/bin/env node
/* GemAir — WCAG AA contrast audit (S11).
 *
 * Computes contrast ratios for the semantic token pairs that matter in
 * both appearances, blending alpha tokens over their real base surfaces.
 * Run: node scripts/contrast-audit.js   (exit 1 if any checked pair fails)
 *
 * Checked pairs (normal text needs 4.5:1, large text / non-text 3:1):
 *   label-primary / secondary / tertiary  vs  card surface + page bg
 *   link vs bg · white vs filled blue · label vs theme panel (dark themes)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'design-tokens.css'), 'utf8');
const themes = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'themes.js'), 'utf8');

/* ---- color math ---- */
function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum([r, g, b]) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
function ratio(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
function hex(h) { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function rgba(h, a, base) { const c = hex(h); return c.map((v, i) => Math.round(v * a + base[i] * (1 - a))); }

/* ---- parse the two token blocks ---- */
function block(marker) {
  const start = css.indexOf(marker);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}
function token(blockStr, name) {
  const m = blockStr.match(new RegExp('--' + name + ':\\s*([^;]+);'));
  if (!m) throw new Error('token missing: ' + name);
  return m[1].trim();
}
function parseColor(value, base) {
  value = value.trim();
  const rgb = value.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
  if (rgb) {
    const [r, g, b, a = 1] = rgb.slice(1).map(Number);
    return [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)));
  }
  return hex(value);
}

const DARK = block(":root {");
const LIGHT = block("body[data-appearance='light']");

const results = [];
function check(label, fg, bg, min) {
  const r = ratio(fg, bg);
  results.push({ label, r, min, pass: r >= min });
}

for (const [name, blk] of [['dark', DARK], ['light', LIGHT]]) {
  const bgPage = parseColor(token(blk, 'color-bg-primary'), [0, 0, 0]);
  const card = parseColor(token(blk, 'color-surface-opaque'), bgPage);
  for (const tier of ['primary', 'secondary', 'tertiary']) {
    const fg = parseColor(token(blk, 'color-label-' + tier), card);
    check(`${name} label-${tier} on card`, fg, card, 4.5);
    check(`${name} label-${tier} on page bg`, fg, bgPage, 4.5);
  }
  const link = parseColor(token(blk, 'color-link'), bgPage);
  check(`${name} link on page bg`, link, bgPage, 4.5);
  const filled = parseColor(token(blk, 'color-system-blue-filled'), bgPage);
  check(`${name} white on filled blue (buttons/bubbles)`, [255, 255, 255], filled, 4.5);
  const blue = parseColor(token(blk, 'color-system-blue'), bgPage);
  check(`${name} blue accent vs card (non-text)`, blue, card, 3);
}

/* ---- theme text/dim on theme panels (dark appearance) ---- */
{
  const re = /text:\s*'([^']+)',\s*dim:\s*'([^']+)',/g;
  const bgRe = /bg:\s*'([^']+)'/g;
  const bgs = [];
  let m;
  while ((m = bgRe.exec(themes))) bgs.push(hex(m[1]));
  let i = 0;
  while ((m = re.exec(themes))) {
    const bg = bgs[i % bgs.length] || hex('#0b0c0f');
    check(`theme ${i + 1} text on theme bg`, hex(m[1]), bg, 4.5);
    check(`theme ${i + 1} dim on theme bg`, hex(m[2]), bg, 4.5);
    i++;
  }
  // light appearance (derive() fixed values)
  check('light theme text on light bg', hex('#111827'), hex('#f4f7fb'), 4.5);
  check('light theme dim on light bg', hex('#526077'), hex('#f4f7fb'), 4.5);
}

let fail = 0;
for (const r of results) {
  const mark = r.pass ? 'ok  ' : 'FAIL';
  if (!r.pass) fail++;
  console.log(`  ${mark} ${r.label.padEnd(42)} ${r.r.toFixed(2)}:1  (min ${r.min}:1)`);
}
console.log(fail ? `\n${fail} pair(s) below AA` : '\nAll checked pairs pass WCAG AA');
process.exit(fail ? 1 : 0);
