#!/usr/bin/env node
/* GemAir — icon pipeline (S10)
 *
 * Regenerates every raster icon from the single SVG source of truth
 * (renderer/assets/logo-mark.svg) with zero npm dependencies:
 *   build/icon.ico              PNG-in-ICO (256px, Windows Vista+/Electron)
 *   build/icon.png              1024 master
 *   build/icons/{16..1024}      Electron linux icon set
 *   renderer/assets/gemair-512.png   PWA manifest icon
 *
 * The mark is simple geometry (ring + hexagon + facet lines + shine), so a
 * small supersampling rasterizer covers it exactly. Node's built-in zlib
 * handles the PNG compression. Run:  node scripts/generate-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'renderer', 'assets', 'logo-mark.svg');
const svg = fs.readFileSync(SVG_PATH, 'utf8');

/* ---------- minimal SVG parsing (our own controlled file) ---------- */
function attr(tag, name) {
  const m = svg.match(new RegExp('<' + tag + '[^>]*\\b' + name + '="([^"]+)"', 'i'));
  if (!m) throw new Error('missing attribute ' + tag + '.' + name);
  return m[1];
}
function tagBody(tag) {
  const m = svg.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? m[1] : '';
}
const VIEW = attr('svg', 'viewBox').split(/\s+/).map(Number);
const VW = VIEW[2], VH = VIEW[3];

function stops(defId) {
  const body = tagBody('defs');
  const def = body.match(new RegExp('<linearGradient[^>]*id="' + defId + '"[\\s\\S]*?</linearGradient>', 'i'));
  if (!def) throw new Error('missing gradient ' + defId);
  const out = [];
  const re = /<stop\s+offset="([\d.]+)%"\s+stop-color="([^"]+)"(?:\s+stop-opacity="([\d.]+)")?/g;
  let m;
  while ((m = re.exec(def[0]))) out.push({ at: Number(m[1]) / 100, c: hex(m[2]), a: m[3] === undefined ? 1 : Number(m[3]) });
  return out;
}
function hex(h) {
  h = h.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function gradAxis(defId) {
  const body = tagBody('defs');
  const def = body.match(new RegExp('<linearGradient[^>]*id="' + defId + '"[^>]*>', 'i'))[0];
  const nums = ['x1', 'y1', 'x2', 'y2'].map((k) => {
    const m = def.match(new RegExp('\\b' + k + '="([\\d.]+)"'));
    return m ? Number(m[1]) : null;
  });
  return nums; // [x1, y1, x2, y2] in userSpaceOnUse units
}
const FACET = stops('ga-facet');
const SHINE = stops('ga-shine');
const FACET_AXIS = gradAxis('ga-facet');
const SHINE_AXIS = gradAxis('ga-shine');

function sampleGrad(stops, axis, x, y) {
  const [x1, y1, x2, y2] = axis;
  const dx = x2 - x1, dy = y2 - y1;
  let t = (dx * dx + dy * dy) === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].at && t <= stops[i + 1].at) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const span = hi.at - lo.at || 1;
  const f = (t - lo.at) / span;
  return [
    lo.c[0] + (hi.c[0] - lo.c[0]) * f,
    lo.c[1] + (hi.c[1] - lo.c[1]) * f,
    lo.c[2] + (hi.c[2] - lo.c[2]) * f,
    lo.a + (hi.a - lo.a) * f,
  ];
}

/* ring */
const ring = { cx: Number(attr('circle', 'cx')), cy: Number(attr('circle', 'cy')), r: Number(attr('circle', 'r')), sw: Number(attr('circle', 'stroke-width')), op: Number(attr('circle', 'opacity')) };

/* first <path> = gem body, second = facet lines, third = shine */
const paths = [];
const pre = /<path\b([^>]*)\/>/g;
let pm;
while ((pm = pre.exec(svg))) {
  if (!/\/>\s*<!--/.test(svg.slice(pm.index + pm[0].length, pm.index + pm[0].length + 8)) && pm[1].includes('d=')) {
    const g = pm[1].match(/\bd="([^"]+)"/);
    if (g) {
      const fill = pm[1].match(/\bfill="([^"]+)"/);
      const stroke = pm[1].match(/\bstroke="([^"]+)"/);
      const sw = pm[1].match(/\bstroke-width="([\d.]+)"/);
      const so = pm[1].match(/\bstroke-opacity="([\d.]+)"/);
      const nums = g[1].match(/-?[\d.]+/g).map(Number);
      paths.push({ nums, fill: fill && fill[1], stroke: stroke && stroke[1], sw: sw ? Number(sw[1]) : 0, so: so ? Number(so[1]) : 1 });
    }
  }
}
const gem = paths[0], facets = paths[1], shine = paths[2];
if (!gem || !facets || !shine) throw new Error('logo-mark.svg structure changed — update generate-icons.js');

/* path d="M x y L x y ..." -> polygon vertices for fills; the facet d uses
 * M x y then V y (vertical) and L x y (absolute lineto) commands. */
function polyFromNums(nums) {
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}
const gemPts = polyFromNums(gem.nums);
const shinePts = polyFromNums(shine.nums);
const facetSegs = [];
{
  const d = svg.match(/<path stroke="#0B0C0F"[^>]*\bd="([^"]+)"/)[1];
  for (const part of d.split('M').filter((x) => x.trim())) {
    const toks = part.trim().split(/\s+/);
    let x = Number(toks[0]), y = Number(toks[1]);
    let i = 2;
    while (i < toks.length) {
      const cmd = toks[i++];
      if (cmd === 'V') { const v = Number(toks[i++]); facetSegs.push([[x, y], [x, v]]); y = v; }
      else if (cmd === 'L') { const nx = Number(toks[i++]), ny = Number(toks[i++]); facetSegs.push([[x, y], [nx, ny]]); x = nx; y = ny; }
    }
  }
}

/* ---------- geometry helpers ---------- */
function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/* ---------- render one size (supersampled) ---------- */
function render(size, ss) {
  const scale = size / VW;
  const data = Buffer.alloc(size * size * 4);
  const src = (x, y) => {
    // paint layers back-to-front over transparent
    let r = 0, g = 0, b = 0, a = 0;
    const over = (cr, cg, cb, ca) => {
      r = cr * ca + r * (1 - ca);
      g = cg * ca + g * (1 - ca);
      b = cb * ca + b * (1 - ca);
      a = ca + a * (1 - ca);
    };
    // 1. ring stroke
    const dRing = Math.abs(Math.hypot(x - ring.cx, y - ring.cy) - ring.r);
    if (dRing <= ring.sw / 2) {
      const c = sampleGrad(FACET, FACET_AXIS, x, y);
      over(c[0], c[1], c[2], c[3] * ring.op);
    }
    // 2. gem body
    if (inPoly(gemPts, x, y)) {
      const c = sampleGrad(FACET, FACET_AXIS, x, y);
      over(c[0], c[1], c[2], c[3]);
    }
    // 3. facet dividers
    for (const [[ax, ay], [bx, by]] of facetSegs) {
      if (distToSeg(x, y, ax, ay, bx, by) <= facets.sw / 2) over(11, 12, 15, facets.so);
    }
    // 4. top shine
    if (inPoly(shinePts, x, y)) {
      const c = sampleGrad(SHINE, SHINE_AXIS, x, y);
      over(c[0], c[1], c[2], c[3]);
    }
    return [r, g, b, a];
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (px + (sx + 0.5) / ss) / scale;
          const uy = (py + (sy + 0.5) / ss) / scale;
          const s = src(ux, uy);
          r += s[0]; g += s[1]; b += s[2]; a += s[3];
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      data[i] = Math.round(r / n);
      data[i + 1] = Math.round(g / n);
      data[i + 2] = Math.round(b / n);
      data[i + 3] = Math.round((a / n) * 255);
    }
  }
  return data;
}

/* ---------- PNG encode (RGBA, filter 0) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO (PNG-compressed 256) ---------- */
function encodeICO(png256) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(1, 4);      // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0;                    // 256 → 0
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);       // planes
  entry.writeUInt16LE(32, 6);      // bpp
  entry.writeUInt32LE(png256.length, 8);
  entry.writeUInt32LE(22, 12);     // data offset (6 + 16)
  return Buffer.concat([header, entry, png256]);
}

/* ---------- run ---------- */
const sizes = [16, 32, 48, 64, 128, 192, 256, 512, 1024];
const renders = {};
for (const s of sizes) {
  const ss = s <= 64 ? 4 : 3;
  renders[s] = encodePNG(s, render(s, ss));
}
const out = [
  ['build/icon.png', renders[1024]],
  ['build/icons/16x16.png', renders[16]],
  ['build/icons/32x32.png', renders[32]],
  ['build/icons/48x48.png', renders[48]],
  ['build/icons/64x64.png', renders[64]],
  ['build/icons/128x128.png', renders[128]],
  ['build/icons/256x256.png', renders[256]],
  ['build/icons/512x512.png', renders[512]],
  ['build/icons/1024x1024.png', renders[1024]],
  ['build/icon.ico', encodeICO(renders[256])],
  ['renderer/assets/gemair-512.png', renders[512]],
  ['renderer/assets/gemair-logo.png', renders[192]],
];
for (const [rel, buf] of out) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  console.log('  ✓', rel, buf.length, 'bytes');
}
console.log('Icons regenerated from renderer/assets/logo-mark.svg');
