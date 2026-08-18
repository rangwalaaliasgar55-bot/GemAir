/* ============================================================
   GemAir — Gem's avatar.
   A self-contained software 3D renderer (no WebGL, no libraries) that
   draws a holographic head and makes it feel alive:

     • real perspective projection with depth-sorted, depth-faded geometry
     • idle motion  — breathing, micro-sway, saccades, blinking
     • lip-sync     — a syllable envelope driven by the speech pipeline
     • emotion      — brow angle, eye openness, mouth curve, hue shift
     • states       — standby / listening / thinking / speaking

   The head is NOT a deformed sphere (that reads as an egg). It is built
   from an explicit anatomical profile: a width curve and a depth curve
   sampled down the skull, so the silhouette has a real cranium, temples,
   cheekbones, a jaw and a rounded chin.

   Public API (window.gemAvatar):
     mount(selector)          attach to a <canvas>
     setState({ ... })        { speaking, listening, thinking }
     setEmotion(emotion)      { emotion: 'joy', valence: 0.8 }
     syllable()               nudge the mouth (called on word boundaries)
     destroy()
   ============================================================ */
'use strict';

(function () {
  // ---------------------------------------------------------------------
  // Small maths helpers
  // ---------------------------------------------------------------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  /** Ease a value towards a target — frame-rate independent. */
  function approach(cur, target, rate, dt) {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }

  /** Read the live theme accent so the avatar recolours with the UI. */
  function readAccent() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return parseColor(raw) || { r: 255, g: 59, b: 59 };
  }

  function parseColor(str) {
    if (!str) return null;
    let m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    m = str.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { r: p[0] | 0, g: p[1] | 0, b: p[2] | 0 };
    }
    m = str.match(/^hsla?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return hslToRgb(p[0], (p[1] || 0) / 100, (p[2] || 0) / 100);
    }
    return null;
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return { r: f(0), g: f(8), b: f(4) };
  }

  const rgba = (c, a) => `rgba(${c.r},${c.g},${c.b},${a})`;
  const mix = (a, b, t) => ({
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t))
  });

  // ---------------------------------------------------------------------
  // Head anatomy
  //
  // y = +1 crown … -1 chin. Sampled from a control table with smooth
  // interpolation, which is what gives the silhouette a real skull shape.
  // ---------------------------------------------------------------------

  // [y, half-width]
  const WIDTH = [
    [1.00, 0.20], [0.94, 0.54], [0.86, 0.74], [0.74, 0.88], [0.58, 0.96],
    [0.40, 1.00], [0.22, 1.02], [0.05, 1.02], [-0.12, 1.00], [-0.28, 0.95],
    [-0.44, 0.88], [-0.58, 0.78], [-0.72, 0.64], [-0.84, 0.47], [-0.93, 0.31],
    [-1.00, 0.15]
  ];

  // [y, half-depth] — the skull is deeper than it is wide
  const DEPTH = [
    [1.00, 0.24], [0.94, 0.58], [0.86, 0.80], [0.74, 0.98], [0.58, 1.09],
    [0.40, 1.15], [0.22, 1.18], [0.05, 1.18], [-0.12, 1.15], [-0.28, 1.08],
    [-0.44, 0.98], [-0.58, 0.86], [-0.72, 0.71], [-0.84, 0.55], [-0.93, 0.39],
    [-1.00, 0.20]
  ];

  /** Smooth lookup through a [y, value] table (y descends). */
  function sample(table, y) {
    y = clamp(y, -1, 1);
    for (let i = 0; i < table.length - 1; i++) {
      const [y0, v0] = table[i];
      const [y1, v1] = table[i + 1];
      if (y <= y0 && y >= y1) {
        const t = (y0 - y) / (y0 - y1 || 1);
        const s = t * t * (3 - 2 * t); // smoothstep
        return lerp(v0, v1, s);
      }
    }
    return table[table.length - 1][1];
  }

  const HEAD_W = 0.82;  // overall scale of the head in world units
  const HEAD_H = 0.96;

  const widthAt = (y) => sample(WIDTH, y) * HEAD_W;
  const depthAt = (y) => sample(DEPTH, y) * HEAD_W * 0.92;

  /**
   * A point on the head surface.
   * @param y  -1 chin … +1 crown
   * @param phi 0 = straight ahead (face), PI = back of skull
   */
  function surface(y, phi) {
    const w = widthAt(y);
    const d = depthAt(y);
    let x = w * Math.sin(phi);
    let z = d * Math.cos(phi);

    const front = Math.max(0, Math.cos(phi)); // 1 at the face, 0 at the sides

    // flatten the face plane slightly — a real face is not a half-ellipse
    z -= 0.06 * front * d;

    // brow ridge
    z += 0.05 * front * Math.exp(-Math.pow((y - 0.24) / 0.13, 2));

    // nose: a ridge running from the brow down to the nose base (y ~ -0.44)
    const central = Math.exp(-Math.pow(x / 0.16, 2));
    z += 0.17 * front * central * Math.exp(-Math.pow((y + 0.15) / 0.30, 2));

    // upper lip / muzzle
    z += 0.035 * front * Math.exp(-Math.pow((y + 0.56) / 0.16, 2));

    // chin comes forward
    z += 0.05 * front * Math.exp(-Math.pow((y + 0.74) / 0.16, 2));

    // back of the skull is slightly flattened
    if (z < 0) z *= 0.94;

    return { x, y: y * HEAD_H, z };
  }

  /** Where a facial feature sits on the front surface, lifted off it a touch. */
  function facePoint(x, y, lift) {
    const w = widthAt(y) || 1e-6;
    const t = clamp(x / w, -1, 1);
    const phi = Math.asin(t);
    const p = surface(y, phi);
    return { x, y: y * HEAD_H, z: p.z + (lift || 0) };
  }

  function buildHead() {
    const rings = [];
    const LAT = 26;
    const LON = 52;
    for (let i = 0; i <= LAT; i++) {
      const y = 1 - (i / LAT) * 2;
      const ring = [];
      for (let j = 0; j <= LON; j++) {
        ring.push(surface(y, (j / LON) * TAU));
      }
      rings.push({ y, pts: ring });
    }

    const meridians = [];
    const M = 16;
    for (let j = 0; j < M; j++) {
      const phi = (j / M) * TAU;
      const line = [];
      for (let i = 0; i <= 40; i++) line.push(surface(1 - (i / 40) * 2, phi));
      meridians.push(line);
    }
    return { rings, meridians };
  }

  const HEAD = buildHead();

  /**
   * A coarser quad mesh used for the shaded skin surface. Kept separate from
   * the contour rings so the wireframe can stay fine while the fill stays
   * cheap (about 500 quads a frame).
   */
  function buildSkin() {
    const LAT_S = 26, LON_S = 38;
    const grid = [];
    for (let i = 0; i <= LAT_S; i++) {
      const y = 1 - (i / LAT_S) * 2;
      const row = [];
      for (let j = 0; j <= LON_S; j++) row.push(surface(y, (j / LON_S) * TAU));
      grid.push(row);
    }
    const quads = [];
    for (let i = 0; i < LAT_S; i++) {
      for (let j = 0; j < LON_S; j++) {
        quads.push([grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]]);
      }
    }
    return quads;
  }
  const SKIN = buildSkin();

  /** Neck + shoulders, so Gem reads as a person rather than a floating head. */
  function buildTorso() {
    const lines = [];

    // neck
    for (let k = 0; k < 3; k++) {
      const r = 0.30 - k * 0.015;
      const line = [];
      for (let j = 0; j <= 28; j++) {
        const a = (j / 28) * TAU;
        line.push({ x: Math.cos(a) * r, y: -1.06 - k * 0.11, z: Math.sin(a) * r * 0.85 });
      }
      lines.push(line);
    }

    // neck side seams — connect the hoops so they read as a neck
    for (const sx of [-0.29, 0.29]) {
      const seam = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        seam.push({ x: sx * (1 + t * 0.12), y: lerp(-1.02, -1.34, t), z: 0.02 });
      }
      lines.push(seam);
    }

    // shoulders — a trapezoid silhouette that falls away steeply, so it reads
    // as a torso rather than a flat disc under the head
    for (let k = 0; k < 4; k++) {
      const t = k / 3;
      const y = -1.40 - t * 0.26;
      const halfW = 0.50 + t * 0.20;
      const line = [];
      for (let j = 0; j <= 44; j++) {
        const u = j / 44;
        const x = lerp(-halfW, halfW, u);
        const n = x / halfW;
        const slope = Math.pow(Math.abs(n), 1.7) * 0.52;   // shoulders fall away
        const z = Math.cos(n * Math.PI * 0.5) * 0.26;
        line.push({ x, y: y - slope, z });
      }
      lines.push(line);
    }

    // two vertical seams down the chest to give the torso volume
    for (const sx of [-0.26, 0.26]) {
      const seam = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        seam.push({ x: sx * (1 + t * 0.5), y: lerp(-1.34, -1.72, t), z: 0.2 - t * 0.06 });
      }
      lines.push(seam);
    }

    return lines;
  }

  const TORSO = buildTorso();

  // ---------------------------------------------------------------------
  // Renderer
  // ---------------------------------------------------------------------
  function createAvatar() {
    let canvas = null, ctx = null, raf = 0;
    let w = 0, h = 0, dpr = 1;
    let last = 0;
    let time = 0;

    const S = {
      speaking: false, listening: false, thinking: false,
      mouth: 0, mouthTarget: 0,
      smile: 0, browRaise: 0, eyeOpen: 1,
      glow: 0.4,
      rotY: 0, rotX: 0, targetRotY: 0, targetRotX: 0,
      gazeX: 0, gazeY: 0,
      breath: 0,
      nextBlink: 1.6, blinkT: -1,
      nextSaccade: 2,
      syllableT: 0, syllablePhase: 0,
      // viseme drivers
      mouthW: 1, mouthWTarget: 1,
      mouthR: 0, mouthRTarget: 0,
      viseme: 'MM'
    };

    let emotion = { emotion: 'neutral', valence: 0 };
    const pointer = { x: 0, y: 0 };

    /**
     * Visemes — the mouth shapes speech is actually made of. Cycling through
     * these instead of just opening and closing the jaw is the difference
     * between "talking" and "chewing".
     *   w = horizontal stretch, h = vertical opening, r = lip rounding
     */
    const VISEMES = [
      { k: 'AA', w: 1.06, h: 1.00, r: 0.00, p: 0.16 },  // father
      { k: 'EH', w: 1.18, h: 0.55, r: 0.00, p: 0.14 },  // bed
      { k: 'EE', w: 1.30, h: 0.30, r: 0.00, p: 0.13 },  // see
      { k: 'IH', w: 1.10, h: 0.34, r: 0.00, p: 0.12 },  // sit
      { k: 'OH', w: 0.76, h: 0.80, r: 0.75, p: 0.12 },  // go
      { k: 'OO', w: 0.60, h: 0.44, r: 1.00, p: 0.09 },  // food
      { k: 'L',  w: 1.06, h: 0.52, r: 0.00, p: 0.08 },  // let
      { k: 'FV', w: 1.02, h: 0.16, r: 0.10, p: 0.08 },  // five
      { k: 'MM', w: 0.96, h: 0.03, r: 0.20, p: 0.08 }   // closed consonant
    ];
    function pickViseme(prev) {
      for (let attempt = 0; attempt < 6; attempt++) {
        let r = Math.random();
        for (const v of VISEMES) { r -= v.p; if (r <= 0) { if (v.k !== prev) return v; break; } }
      }
      return VISEMES[0];
    }

    const EXPRESSION = {
      joy:         { smile: 0.95, brow: 0.45, open: 1.02, tint: { r: 255, g: 210, b: 90 } },
      excitement:  { smile: 0.90, brow: 0.70, open: 1.10, tint: { r: 255, g: 170, b: 60 } },
      love:        { smile: 0.80, brow: 0.25, open: 0.94, tint: { r: 255, g: 110, b: 170 } },
      gratitude:   { smile: 0.70, brow: 0.20, open: 1.00, tint: { r: 255, g: 190, b: 120 } },
      hope:        { smile: 0.50, brow: 0.35, open: 1.02, tint: { r: 160, g: 230, b: 255 } },
      relief:      { smile: 0.45, brow: -0.10, open: 0.90, tint: { r: 150, g: 240, b: 200 } },
      confident:   { smile: 0.35, brow: 0.10, open: 1.00, tint: { r: 200, g: 220, b: 255 } },
      curiosity:   { smile: 0.20, brow: 0.75, open: 1.06, tint: { r: 150, g: 200, b: 255 } },
      neutral:     { smile: 0.06, brow: 0.00, open: 1.00, tint: null },
      boredom:     { smile: -0.10, brow: -0.30, open: 0.78, tint: { r: 150, g: 150, b: 170 } },
      tired:       { smile: -0.15, brow: -0.35, open: 0.62, tint: { r: 140, g: 150, b: 190 } },
      anxiety:     { smile: -0.40, brow: 0.55, open: 1.08, tint: { r: 190, g: 150, b: 255 } },
      fear:        { smile: -0.50, brow: 0.85, open: 1.16, tint: { r: 170, g: 140, b: 255 } },
      sadness:     { smile: -0.70, brow: 0.30, open: 0.74, tint: { r: 110, g: 160, b: 255 } },
      anger:       { smile: -0.60, brow: -0.90, open: 1.02, tint: { r: 255, g: 80, b: 60 } },
      guilty:      { smile: -0.45, brow: -0.20, open: 0.76, tint: { r: 160, g: 160, b: 210 } },
      embarrassed: { smile: -0.20, brow: 0.30, open: 0.82, tint: { r: 255, g: 140, b: 170 } }
    };

    // ---- projection ------------------------------------------------------
    let scale = 100, cx = 0, cy = 0;
    const CAM = 6.0;

    /** Object space -> view space (rotation only). */
    function rotate(p) {
      const cyr = Math.cos(S.rotY), syr = Math.sin(S.rotY);
      const x = p.x * cyr + p.z * syr;
      let z = -p.x * syr + p.z * cyr;
      const cxr = Math.cos(S.rotX), sxr = Math.sin(S.rotX);
      const y = p.y * cxr - z * sxr;
      z = p.y * sxr + z * cxr;
      return { x, y, z };
    }

    /** View space -> screen space (perspective divide). */
    function toScreen(v) {
      const f = CAM / (CAM - v.z);
      return { x: cx + v.x * f * scale, y: cy - v.y * f * scale, z: v.z, f };
    }

    function project(p) { return toScreen(rotate(p)); }

    const depthAlpha = (z) => clamp(0.08 + (z + 1.0) / 2.0 * 0.92, 0.05, 1);

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth || 520;
      h = canvas.clientHeight || 520;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scale = Math.min(w, h) * 0.27;
      cx = w / 2;
      cy = h / 2 - Math.min(w, h) * 0.03;
    }

    // ---- drawing helpers -------------------------------------------------
    function strokePath(pts, colour, alphaScale, width) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const al = ((depthAlpha(a.z) + depthAlpha(b.z)) / 2) * alphaScale;
        if (al <= 0.015) continue;
        ctx.beginPath();
        ctx.strokeStyle = rgba(colour, al);
        ctx.lineWidth = width * ((a.f + b.f) / 2) * 0.5;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    /** Almond eye: an upper and a lower lid arc meeting at the corners. */
    function eyeOutline(sx, sy, openness) {
      const wEye = 0.135, hUp = 0.062 * openness, hLo = 0.038 * openness;
      const pts = [];
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        pts.push(facePoint(sx + lerp(-wEye, wEye, t), sy + Math.sin(t * Math.PI) * hUp, 0.03));
      }
      for (let i = 14; i >= 0; i--) {
        const t = i / 14;
        pts.push(facePoint(sx + lerp(-wEye, wEye, t), sy - Math.sin(t * Math.PI) * hLo, 0.03));
      }
      return pts;
    }

    function drawEye(sx, sy, openness, colour, glow) {
      const outline = eyeOutline(sx, sy, Math.max(openness, 0.04));
      const pts = outline.map(project);
      const trace = () => {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
      };

      // sclera — without an eye white the socket reads as a hole
      if (openness > 0.06) {
        trace();
        ctx.fillStyle = `rgba(238,242,248,${0.82 * (0.55 + glow * 0.45)})`;
        ctx.fill();
      }

      if (openness > 0.12) {
        const gx = sx + S.gazeX * 0.035;
        const gy = sy + S.gazeY * 0.02;
        const c = project(facePoint(gx, gy, 0.05));
        const r = 0.042 * scale * c.f;

        ctx.save();
        trace();
        ctx.clip();

        // shadow cast by the upper lid onto the eyeball
        const lid = project(facePoint(sx, sy + 0.06, 0.03));
        const sg = ctx.createLinearGradient(lid.x, lid.y - r, lid.x, lid.y + r * 1.6);
        sg.addColorStop(0, 'rgba(20,26,40,0.45)');
        sg.addColorStop(1, 'rgba(20,26,40,0)');
        ctx.fillStyle = sg;
        ctx.fill();

        // iris
        const ig = ctx.createRadialGradient(c.x, c.y, r * 0.2, c.x, c.y, r);
        ig.addColorStop(0, rgba(mix(colour, { r: 255, g: 255, b: 255 }, 0.45), 0.95));
        ig.addColorStop(0.65, rgba(colour, 0.95));
        ig.addColorStop(1, rgba(mix(colour, { r: 0, g: 0, b: 0 }, 0.55), 0.95));
        ctx.fillStyle = ig;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, TAU);
        ctx.fill();

        // limbal ring — the dark edge that makes an iris look real
        ctx.beginPath();
        ctx.strokeStyle = `rgba(10,14,26,${0.55 * glow})`;
        ctx.lineWidth = Math.max(1, r * 0.16);
        ctx.arc(c.x, c.y, r, 0, TAU);
        ctx.stroke();

        // pupil, dilating slightly with energy
        ctx.beginPath();
        ctx.fillStyle = 'rgba(6,8,16,0.95)';
        ctx.arc(c.x, c.y, r * (0.36 + 0.12 * S.glow), 0, TAU);
        ctx.fill();

        // catchlight
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${0.9 * glow})`;
        ctx.arc(c.x - r * 0.3, c.y - r * 0.32, r * 0.22, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${0.4 * glow})`;
        ctx.arc(c.x + r * 0.26, c.y + r * 0.24, r * 0.1, 0, TAU);
        ctx.fill();

        ctx.restore();
      }

      // lash line — heavier on top, like real lashes
      ctx.beginPath();
      pts.slice(0, Math.ceil(pts.length / 2)).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.strokeStyle = rgba(mix(colour, { r: 0, g: 0, b: 0 }, 0.35), 0.9);
      ctx.lineWidth = 2.3;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.lineCap = 'butt';

      // lower lid, lighter
      ctx.beginPath();
      pts.slice(Math.ceil(pts.length / 2)).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.strokeStyle = rgba(colour, 0.5);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    /** Upper-lid crease — subtle, but eyes look flat without it. */
    function drawLidCrease(sx, sy, colour) {
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        pts.push(project(facePoint(sx + lerp(-0.15, 0.15, t), sy + 0.075 + Math.sin(t * Math.PI) * 0.022, 0.028)));
      }
      strokePath(pts, colour, 0.3, 1.1);
    }

    function drawBrow(sx, sy, dir, colour) {
      const inner = S.browRaise * 0.05;
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        // t = 0 at the inner end (towards the nose)
        const px = sx + dir * lerp(0.02, 0.30, t);
        const arch = Math.sin(t * Math.PI) * 0.022;
        const tilt = lerp(inner, -inner * 0.4, t);
        pts.push(project(facePoint(px, sy + arch + tilt, 0.035)));
      }
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.strokeStyle = rgba(colour, 0.75);
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    function drawNose(colour) {
      // bridge
      const bridge = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        bridge.push(project(facePoint(-0.012, lerp(0.10, -0.40, t), 0.02 + t * 0.06)));
      }
      strokePath(bridge, colour, 0.5, 1.4);

      // tip + base
      const base = [];
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        const x = lerp(-0.085, 0.085, t);
        base.push(project(facePoint(x, -0.44 - Math.sin(t * Math.PI) * 0.03, 0.06)));
      }
      strokePath(base, colour, 0.55, 1.4);

      // nostrils
      for (const side of [-1, 1]) {
        const n = [];
        for (let i = 0; i <= 8; i++) {
          const a = Math.PI * (0.15 + (i / 8) * 0.8);
          n.push(project(facePoint(side * (0.052 + Math.cos(a) * 0.022), -0.435 + Math.sin(a) * 0.016, 0.052)));
        }
        strokePath(n, colour, 0.45, 1.1);
      }

      // philtrum — the groove from the nose to the upper lip
      const ph = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        ph.push(project(facePoint(-0.010, lerp(-0.47, -0.575, t), 0.03)));
      }
      strokePath(ph, colour, 0.22, 1);
    }

    /**
     * Lips, not a slot. Upper lip carries a cupid's bow; the lower lip is
     * fuller and drops on a bow curve when the mouth opens.
     */
    function drawMouth(colour, glow) {
      const open = S.mouth;
      const curve = S.smile * 0.05;
      const halfW = lerp(0.135, 0.168, open * 0.5) * S.mouthW * (1 - S.mouthR * 0.16);
      const yC = -0.62;
      const N = 26;

      const upper = [], lower = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const px = lerp(-halfW, halfW, t);
        const n = (t - 0.5) * 2;                        // -1 .. 1
        const bow = Math.cos(n * Math.PI * 0.5);        // 1 centre, 0 corners
        const cupid = Math.cos(n * Math.PI * 1.6) * 0.007 * (1 - Math.abs(n));
        const mid = yC - curve * bow;
        upper.push(facePoint(px, mid + 0.014 * bow + cupid + open * 0.012, 0.035));
        lower.push(facePoint(px, mid - 0.018 * bow - open * 0.135 * bow, 0.035));
      }
      const up = upper.map(project), lo = lower.map(project);

      // mouth cavity + teeth
      if (open > 0.03) {
        ctx.save();
        ctx.beginPath();
        up.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        for (let i = lo.length - 1; i >= 0; i--) ctx.lineTo(lo[i].x, lo[i].y);
        ctx.closePath();
        // dark cavity
        ctx.fillStyle = `rgba(${Math.round(colour.r * 0.13)},${Math.round(colour.g * 0.10)},${Math.round(colour.b * 0.14)},${0.55 + 0.35 * open})`;
        ctx.fill();
        ctx.clip();

        // upper teeth — a bright band tucked under the top lip
        if (open > 0.12) {
          const teeth = [];
          for (let i = 0; i <= N; i++) {
            const t = i / N;
            const px = lerp(-halfW * 0.92, halfW * 0.92, t);
            const n2 = (t - 0.5) * 2;
            const bow = Math.cos(n2 * Math.PI * 0.5);
            teeth.push(facePoint(px, yC - curve * bow + 0.012 * bow, 0.036));
          }
          const tp = teeth.map(project);
          const band = Math.min(0.055, 0.02 + open * 0.05) * scale;
          ctx.beginPath();
          tp.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          for (let i = tp.length - 1; i >= 0; i--) ctx.lineTo(tp[i].x, tp[i].y + band);
          ctx.closePath();
          ctx.fillStyle = `rgba(252,250,248,${0.72 * glow})`;
          ctx.fill();

          // tooth separations
          ctx.strokeStyle = 'rgba(120,130,150,0.35)';
          ctx.lineWidth = 1;
          for (let k = 1; k < 6; k++) {
            const idx = Math.round((k / 6) * N);
            const p = tp[idx];
            if (!p) continue;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x, p.y + band);
            ctx.stroke();
          }

          // lower teeth hint when wide open
          if (open > 0.55) {
            const lb = band * 0.55;
            ctx.beginPath();
            lo.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            for (let i = lo.length - 1; i >= 0; i--) ctx.lineTo(lo[i].x, lo[i].y - lb);
            ctx.closePath();
            ctx.fillStyle = `rgba(240,238,236,${0.4 * glow})`;
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // lip edges
      for (const line of [up, lo]) {
        ctx.beginPath();
        line.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.strokeStyle = rgba(colour, 0.85);
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      // the seam between the lips, and a soft shadow under the lower lip
      const seam = [];
      const shade = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const px = lerp(-halfW * 0.94, halfW * 0.94, t);
        const n = (t - 0.5) * 2;
        const bow = Math.cos(n * Math.PI * 0.5);
        seam.push(project(facePoint(px, yC - curve * bow, 0.036)));
        shade.push(project(facePoint(px * 0.9, yC - curve * bow - 0.05 - open * 0.14 * bow, 0.03)));
      }
      if (open < 0.35) strokePath(seam, colour, 0.5 * (1 - open / 0.35), 1.2);
      strokePath(shade, colour, 0.18, 1);
    }

    // Key light sits up and to the viewer's left, like a portrait softbox.
    const LIGHT = (() => {
      const v = { x: -0.42, y: 0.5, z: 0.78 };
      const m = Math.hypot(v.x, v.y, v.z);
      return { x: v.x / m, y: v.y / m, z: v.z / m };
    })();

    /**
     * Shaded skin. Each quad is rotated into view space, back-face culled,
     * lit with a Lambert term plus a rim light, then painted back-to-front.
     * This is what turns the wireframe cage into an actual face.
     */
    function drawSkin(colour) {
      const base = mix(colour, { r: 252, g: 226, b: 214 }, 0.76); // warm skin tone
      const rim = mix(colour, { r: 255, g: 255, b: 255 }, 0.25);
      const drawList = [];

      for (const quad of SKIN) {
        const v = [rotate(quad[0]), rotate(quad[1]), rotate(quad[2]), rotate(quad[3])];
        // face normal (wound so that it points at the camera when visible)
        const ax = v[1].x - v[0].x, ay = v[1].y - v[0].y, az = v[1].z - v[0].z;
        const bx = v[3].x - v[0].x, by = v[3].y - v[0].y, bz = v[3].z - v[0].z;
        let nx = by * az - bz * ay;
        let ny = bz * ax - bx * az;
        let nz = bx * ay - by * ax;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        if (nz <= 0.02) continue;                       // back-facing

        const lambert = Math.max(0, nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z);
        const fresnel = Math.pow(1 - nz, 2.6);          // glow at the edges
        const depth = (v[0].z + v[1].z + v[2].z + v[3].z) / 4;
        drawList.push({ v, lambert, fresnel, depth });
      }

      drawList.sort((a, b) => a.depth - b.depth);       // painter's algorithm

      for (const f of drawList) {
        const p = f.v.map(toScreen);
        const shade = 0.34 + 0.66 * Math.pow(f.lambert, 0.85);
        const a = (0.55 + 0.33 * shade) * (0.6 + S.glow * 0.4);
        const col = f.fresnel > 0.45 ? mix(base, rim, f.fresnel * 0.7) : base;
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
        ctx.closePath();
        ctx.fillStyle = `rgba(${Math.round(col.r * shade)},${Math.round(col.g * shade)},${Math.round(col.b * shade)},${a})`;
        ctx.fill();
      }
    }

    /** Ears — small but they do a lot of work for "this is a person". */
    function drawEars(colour) {
      for (const side of [-1, 1]) {
        const outer = [], inner = [];
        for (let i = 0; i <= 14; i++) {
          const t = i / 14;
          const y = lerp(0.12, -0.32, t);
          const wY = widthAt(y);
          const bulge = Math.sin(t * Math.PI) * 0.055;
          outer.push(project({ x: side * (wY + bulge), y: y * HEAD_H, z: -0.08 - Math.sin(t * Math.PI) * 0.12 }));
          inner.push(project({ x: side * (wY + bulge * 0.35), y: y * HEAD_H, z: -0.05 - Math.sin(t * Math.PI) * 0.05 }));
        }
        strokePath(outer, colour, 0.5, 1.5);
        strokePath(inner, colour, 0.28, 1.1);
      }
    }

    /** Cheekbone + jaw contours — the lines a portrait artist would draw. */
    function drawContours(colour) {
      for (const side of [-1, 1]) {
        // cheekbone sweeping from the outer eye corner toward the mouth
        const cheek = [];
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const x = side * lerp(0.36, 0.20, t);
          const y = lerp(-0.06, -0.52, t);
          cheek.push(project(facePoint(x, y, 0.012)));
        }
        strokePath(cheek, colour, 0.2, 1);

        // jawline from below the ear to the chin
        const jaw = [];
        for (let i = 0; i <= 14; i++) {
          const t = i / 14;
          const y = lerp(-0.34, -0.94, t);
          const wY = widthAt(y);
          jaw.push(project({ x: side * wY * 0.96, y: y * HEAD_H, z: -0.02 + t * 0.18 }));
        }
        strokePath(jaw, colour, 0.3, 1.2);
      }
    }

    function drawHalo(colour, t) {
      const rings = [
        { r: 1.30, tilt: 0.40, spd: 0.25, a: 0.26 },
        { r: 1.48, tilt: -0.28, spd: -0.17, a: 0.16 },
        { r: 1.15, tilt: 1.10, spd: 0.34, a: 0.12 }
      ];
      for (const ring of rings) {
        const pts = [];
        for (let i = 0; i <= 72; i++) {
          const a = (i / 72) * TAU + t * ring.spd;
          pts.push(project({
            x: Math.cos(a) * ring.r,
            y: Math.sin(a) * Math.sin(ring.tilt) * ring.r * 0.5 - 0.1,
            z: Math.sin(a) * ring.r * Math.cos(ring.tilt)
          }));
        }
        strokePath(pts, colour, ring.a * (0.6 + S.glow), 1);
      }
    }

    function drawParticles(colour, t) {
      const n = 44;
      const energy = S.thinking ? 2.4 : S.speaking ? 1.7 : S.listening ? 1.3 : 1;
      for (let i = 0; i < n; i++) {
        const seed = i * 12.9898;
        const a = (i / n) * TAU + t * (0.12 + (i % 5) * 0.03) * energy;
        const rad = 1.1 + Math.sin(seed + t * 0.6) * 0.4;
        const y = Math.sin(seed * 1.7 + t * 0.5 * energy) * 1.0;
        const p = project({ x: Math.cos(a) * rad, y, z: Math.sin(a) * rad });
        const al = depthAlpha(p.z) * (0.22 + 0.5 * Math.abs(Math.sin(seed + t * 2)));
        ctx.beginPath();
        ctx.fillStyle = rgba(colour, al * 0.65);
        ctx.arc(p.x, p.y, (0.8 + (i % 3) * 0.45) * p.f, 0, TAU);
        ctx.fill();
      }
    }

    function drawScan(colour, t) {
      const y = ((t * 0.32) % 2.7) - 1.35;
      const p0 = project({ x: -1.05, y, z: 0 });
      const p1 = project({ x: 1.05, y, z: 0 });
      const g = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
      g.addColorStop(0, rgba(colour, 0));
      g.addColorStop(0.5, rgba(colour, 0.3));
      g.addColorStop(1, rgba(colour, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    /**
     * Voice ring — a camera-facing circle whose radius ripples with speech.
     * Drawn in screen space (not projected) so it stays a clean ring behind
     * the head instead of collapsing into a flat disc.
     */
    function drawVoiceRing(colour, t) {
      if (!S.speaking) return;
      const amp = 0.018 + S.mouth * 0.045;
      const R = scale * 1.55;
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * TAU;
        const wobble = Math.sin(a * 6 + t * 6) * amp + Math.sin(a * 11 - t * 4) * amp * 0.5;
        const r = R * (1 + wobble);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = rgba(colour, 0.3 * S.glow);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // ---- per-frame update ------------------------------------------------
    function update(dt) {
      time += dt;
      const key = (emotion && emotion.emotion) || 'neutral';
      const ex = EXPRESSION[key] || EXPRESSION.neutral;

      S.smile = approach(S.smile, ex.smile, 3, dt);
      S.browRaise = approach(S.browRaise, ex.brow, 3, dt);

      // blinking
      S.nextBlink -= dt;
      if (S.nextBlink <= 0 && S.blinkT < 0) {
        S.blinkT = 0;
        S.nextBlink = 2.2 + Math.random() * 4.5;
      }
      let blink = 1;
      if (S.blinkT >= 0) {
        S.blinkT += dt;
        const d = 0.16;
        blink = S.blinkT < d / 2 ? 1 - S.blinkT / (d / 2) : clamp((S.blinkT - d / 2) / (d / 2), 0, 1);
        if (S.blinkT > d) S.blinkT = -1;
      }
      S.eyeOpen = approach(S.eyeOpen, ex.open * (S.listening ? 1.05 : 1), 8, dt) * blink;

      // gaze saccades
      S.nextSaccade -= dt;
      if (S.nextSaccade <= 0) {
        S.gazeX = (Math.random() - 0.5) * 1.4;
        S.gazeY = (Math.random() - 0.5) * 0.8;
        S.nextSaccade = 1.2 + Math.random() * 3;
      }

      // orientation
      const sway = Math.sin(time * 0.42) * 0.1 + Math.sin(time * 0.23) * 0.05;
      const nod = Math.sin(time * 0.31) * 0.04;
      S.targetRotY = sway + pointer.x * 0.32;
      S.targetRotX = nod + pointer.y * 0.18 + (S.thinking ? 0.07 : 0);
      S.rotY = approach(S.rotY, S.targetRotY, 2.2, dt);
      S.rotX = approach(S.rotX, S.targetRotX, 2.2, dt);

      S.breath = Math.sin(time * (S.speaking ? 1.5 : 0.85)) * 0.5 + 0.5;

      // lip sync
      if (S.speaking) {
        S.syllableT -= dt;
        if (S.syllableT <= 0) {
          const v = pickViseme(S.viseme);
          S.viseme = v.k;
          S.mouthTarget = v.h;
          S.mouthWTarget = v.w;
          S.mouthRTarget = v.r;
          S.syllablePhase = 0;
          S.syllableT = 0.10 + Math.random() * 0.12;
        }
        S.syllablePhase += dt;
        // quick attack, slower decay — the shape of a spoken syllable
        const env = Math.min(1, S.syllablePhase / 0.045) * Math.exp(-S.syllablePhase * 4.2);
        S.mouth = approach(S.mouth, S.mouthTarget * env, 26, dt);
        S.mouthW = approach(S.mouthW, S.mouthWTarget, 16, dt);
        S.mouthR = approach(S.mouthR, S.mouthRTarget, 16, dt);
      } else {
        S.mouth = approach(S.mouth, S.listening ? 0.05 : 0.02, 8, dt);
        S.mouthW = approach(S.mouthW, 1, 6, dt);
        S.mouthR = approach(S.mouthR, 0, 6, dt);
      }

      S.glow = approach(S.glow, S.speaking ? 1 : S.thinking ? 0.8 : S.listening ? 0.7 : 0.42, 3, dt);
    }

    // ---- frame -----------------------------------------------------------
    function draw() {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      update(dt);

      ctx.clearRect(0, 0, w, h);

      const accent = readAccent();
      const key = (emotion && emotion.emotion) || 'neutral';
      const ex = EXPRESSION[key] || EXPRESSION.neutral;
      const colour = ex.tint ? mix(accent, ex.tint, 0.4) : accent;

      const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 2.6);
      bloom.addColorStop(0, rgba(colour, 0.15 * S.glow));
      bloom.addColorStop(0.5, rgba(colour, 0.05 * S.glow));
      bloom.addColorStop(1, rgba(colour, 0));
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, w, h);

      drawParticles(colour, time);
      drawHalo(colour, time);
      drawSkin(colour);

      const prevScale = scale;
      scale = prevScale * (1 + S.breath * 0.007);

      ctx.lineJoin = 'round';
      for (const line of TORSO) strokePath(line.map(project), colour, 0.3 * (0.55 + S.glow * 0.6), 1.1);

      for (let i = 0; i < HEAD.rings.length; i++) {
        const ring = HEAD.rings[i];
        // emphasise the brow line and the jaw line
        const emphasis = (Math.abs(ring.y - 0.22) < 0.05 || Math.abs(ring.y + 0.55) < 0.05) ? 1.7 : 1;
        strokePath(ring.pts.map(project), colour, 0.055 * emphasis * (0.5 + S.glow * 0.7), 1);
      }
      for (const line of HEAD.meridians) {
        strokePath(line.map(project), colour, 0.035 * (0.5 + S.glow * 0.7), 1);
      }

      // face
      drawEars(colour);
      drawContours(colour);
      const eyeY = 0.02;
      drawBrow(-0.10, eyeY + 0.145, -1, colour);
      drawBrow(0.10, eyeY + 0.145, 1, colour);
      drawLidCrease(-0.235, eyeY, colour);
      drawLidCrease(0.235, eyeY, colour);
      drawEye(-0.235, eyeY, S.eyeOpen, colour, S.glow);
      drawEye(0.235, eyeY, S.eyeOpen, colour, S.glow);
      drawNose(colour);
      drawMouth(colour, S.glow);

      drawScan(colour, time);
      drawVoiceRing(colour, time);

      scale = prevScale;
      raf = requestAnimationFrame(draw);
    }

    function onPointer(e) {
      const r = canvas.getBoundingClientRect();
      pointer.x = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
      pointer.y = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
    }

    return {
      mount(selector) {
        canvas = typeof selector === 'string' ? document.querySelector(selector) : selector;
        if (!canvas || !canvas.getContext) return false;
        ctx = canvas.getContext('2d');
        resize();
        window.addEventListener('resize', resize);
        window.addEventListener('mousemove', onPointer);
        last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
        return true;
      },
      setState(next) {
        if (!next) return;
        if ('speaking' in next) S.speaking = !!next.speaking;
        if ('listening' in next) S.listening = !!next.listening;
        if ('thinking' in next) S.thinking = !!next.thinking;
      },
      setEmotion(e) {
        if (e && typeof e === 'object') emotion = e;
        else if (typeof e === 'string') emotion = { emotion: e, valence: 0 };
      },
      syllable() { S.syllableT = 0; S.syllablePhase = 0; },
      destroy() {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        window.removeEventListener('mousemove', onPointer);
      }
    };
  }

  window.gemAvatar = createAvatar();
})();
