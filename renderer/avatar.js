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
    const LAT = 19;
    const LON = 44;
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
      syllableT: 0, syllablePhase: 0
    };

    let emotion = { emotion: 'neutral', valence: 0 };
    const pointer = { x: 0, y: 0 };

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

    function project(p) {
      const cyr = Math.cos(S.rotY), syr = Math.sin(S.rotY);
      let x = p.x * cyr + p.z * syr;
      let z = -p.x * syr + p.z * cyr;
      const cxr = Math.cos(S.rotX), sxr = Math.sin(S.rotX);
      const y = p.y * cxr - z * sxr;
      z = p.y * sxr + z * cxr;
      const f = CAM / (CAM - z);
      return { x: cx + x * f * scale, y: cy - y * f * scale, z, f };
    }

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
      const pts = eyeOutline(sx, sy, Math.max(openness, 0.04)).map(project);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.strokeStyle = rgba(colour, 0.85);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (openness < 0.15) return;

      // iris — follows the gaze, clipped to the eye opening
      const gx = sx + S.gazeX * 0.035;
      const gy = sy + S.gazeY * 0.02;
      const c = project(facePoint(gx, gy, 0.05));
      const r = 0.040 * scale * c.f;

      ctx.save();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.clip();

      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r * 2.6);
      g.addColorStop(0, rgba(colour, 0.95 * glow));
      g.addColorStop(0.4, rgba(colour, 0.45 * glow));
      g.addColorStop(1, rgba(colour, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * 2.6, 0, TAU);
      ctx.fill();

      ctx.beginPath();
      ctx.strokeStyle = rgba(colour, 0.9);
      ctx.lineWidth = 1.2;
      ctx.arc(c.x, c.y, r, 0, TAU);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = `rgba(255,255,255,${0.85 * glow})`;
      ctx.arc(c.x - r * 0.25, c.y - r * 0.25, r * 0.34, 0, TAU);
      ctx.fill();
      ctx.restore();
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

      // base / nostrils
      const base = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const x = lerp(-0.075, 0.075, t);
        base.push(project(facePoint(x, -0.44 - Math.sin(t * Math.PI) * 0.025, 0.055)));
      }
      strokePath(base, colour, 0.55, 1.4);
    }

    function drawMouth(colour, glow) {
      const open = S.mouth;
      const curve = S.smile * 0.05;
      const halfW = lerp(0.135, 0.175, open * 0.6);
      const top = [], bottom = [];
      for (let i = 0; i <= 18; i++) {
        const t = i / 18;
        const px = lerp(-halfW, halfW, t);
        const bow = Math.sin(t * Math.PI);
        const yBase = -0.62 - curve * bow;
        top.push(facePoint(px, yBase + 0.016 * bow + open * 0.014, 0.035));
        bottom.push(facePoint(px, yBase - bow * open * 0.17 - 0.005, 0.035));
      }
      const topP = top.map(project), botP = bottom.map(project);

      if (open > 0.04) {
        ctx.beginPath();
        topP.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        for (let i = botP.length - 1; i >= 0; i--) ctx.lineTo(botP[i].x, botP[i].y);
        ctx.closePath();
        ctx.fillStyle = rgba(colour, 0.14 + 0.28 * open * glow);
        ctx.fill();
      }
      for (const line of [topP, botP]) {
        ctx.beginPath();
        line.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.strokeStyle = rgba(colour, 0.88);
        ctx.lineWidth = 1.9;
        ctx.stroke();
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
          S.syllablePhase = 0;
          S.syllableT = 0.11 + Math.random() * 0.13;
          S.mouthTarget = 0.35 + Math.random() * 0.65;
        }
        S.syllablePhase += dt;
        S.mouth = approach(S.mouth, S.mouthTarget * Math.exp(-S.syllablePhase * 7), 22, dt);
      } else {
        S.mouth = approach(S.mouth, S.listening ? 0.05 : 0.02, 8, dt);
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

      const prevScale = scale;
      scale = prevScale * (1 + S.breath * 0.007);

      ctx.lineJoin = 'round';
      for (const line of TORSO) strokePath(line.map(project), colour, 0.3 * (0.55 + S.glow * 0.6), 1.1);

      for (let i = 0; i < HEAD.rings.length; i++) {
        const ring = HEAD.rings[i];
        // emphasise the brow line and the jaw line
        const emphasis = (Math.abs(ring.y - 0.22) < 0.05 || Math.abs(ring.y + 0.55) < 0.05) ? 1.7 : 1;
        strokePath(ring.pts.map(project), colour, 0.30 * emphasis * (0.5 + S.glow * 0.7), 1);
      }
      for (const line of HEAD.meridians) {
        strokePath(line.map(project), colour, 0.16 * (0.5 + S.glow * 0.7), 1);
      }

      // face
      const eyeY = 0.02;
      drawBrow(-0.10, eyeY + 0.145, -1, colour);
      drawBrow(0.10, eyeY + 0.145, 1, colour);
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
