/* ============================================================
   GemAir — Gem's avatar (character build).

   Renders the 3D character portrait and animates it in 2.5D:

     • breathing        slow vertical bob + micro-scale
     • parallax         the figure leans with the pointer
     • blinking         eyelids painted in a skin tone sampled from the art
     • lip sync         viseme mouth shapes drawn over the closed-lip smile
     • states           standby / listening / thinking / speaking
     • emotion          head tilt, glow colour and mouth curve

   The artwork is a closed-mouth portrait on purpose: an open mouth is
   composited on top when Gem speaks, so nothing has to be erased.

   Public API (window.gemAvatar) — unchanged:
     mount(selector) · setState({...}) · setEmotion(e) · syllable() · destroy()
   ============================================================ */
'use strict';

(function () {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;
  const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

  // ---- Calibrated feature positions, as fractions of the artwork ----------
  // Measured against renderer/assets/gem-character.png (473x743) by rendering
  // markers over the art and checking them by eye.
  const ART = {
    src: 'assets/gem-character.png',
    leftEye:  { x: 0.393, y: 0.319 },
    rightEye: { x: 0.597, y: 0.319 },
    eyeR:     { x: 0.052, y: 0.030 },
    mouth:    { x: 0.499, y: 0.453 },
    mouthHalfW: 0.070,
    skinSample: { x: 0.50, y: 0.235 }   // forehead — used for the eyelid colour
  };

  function parseColor(str) {
    if (!str) return null;
    let m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    m = str.match(/^rgba?\(([^)]+)\)$/i);
    if (m) { const p = m[1].split(',').map(Number); return { r: p[0] | 0, g: p[1] | 0, b: p[2] | 0 }; }
    m = str.match(/^hsla?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map(parseFloat);
      const h = ((p[0] % 360) + 360) % 360 / 360, s = (p[1] || 0) / 100, l = (p[2] || 0) / 100;
      const f = (n) => {
        const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
      };
      return { r: f(0), g: f(8), b: f(4) };
    }
    return null;
  }
  const readAccent = () => parseColor(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) || { r: 59, g: 201, b: 255 };
  const rgba = (c, a) => `rgba(${c.r},${c.g},${c.b},${a})`;
  const shade = (c, k) => ({ r: clamp(Math.round(c.r * k), 0, 255), g: clamp(Math.round(c.g * k), 0, 255), b: clamp(Math.round(c.b * k), 0, 255) });

  // ---- Visemes: the mouth shapes speech is actually made of ---------------
  const VISEMES = [
    { k: 'AA', w: 1.00, h: 1.00, r: 0.00, p: 0.16 },
    { k: 'EH', w: 1.12, h: 0.58, r: 0.00, p: 0.14 },
    { k: 'EE', w: 1.26, h: 0.30, r: 0.00, p: 0.13 },
    { k: 'IH', w: 1.05, h: 0.36, r: 0.00, p: 0.12 },
    { k: 'OH', w: 0.74, h: 0.82, r: 0.80, p: 0.12 },
    { k: 'OO', w: 0.58, h: 0.46, r: 1.00, p: 0.09 },
    { k: 'L',  w: 1.02, h: 0.54, r: 0.00, p: 0.08 },
    { k: 'FV', w: 1.00, h: 0.18, r: 0.10, p: 0.08 },
    { k: 'MM', w: 0.94, h: 0.04, r: 0.20, p: 0.08 }
  ];
  function pickViseme(prev) {
    for (let i = 0; i < 6; i++) {
      let r = Math.random();
      for (const v of VISEMES) { r -= v.p; if (r <= 0) { if (v.k !== prev) return v; break; } }
    }
    return VISEMES[0];
  }

  const EXPRESSION = {
    joy:        { tilt: -0.03, curve: 0.9, tint: { r: 255, g: 205, b: 90 } },
    excitement: { tilt: -0.04, curve: 1.0, tint: { r: 255, g: 170, b: 60 } },
    love:       { tilt: 0.04, curve: 0.8, tint: { r: 255, g: 120, b: 175 } },
    gratitude:  { tilt: 0.02, curve: 0.7, tint: { r: 255, g: 190, b: 120 } },
    hope:       { tilt: -0.02, curve: 0.5, tint: { r: 160, g: 230, b: 255 } },
    relief:     { tilt: 0.03, curve: 0.45, tint: { r: 150, g: 240, b: 200 } },
    confident:  { tilt: -0.02, curve: 0.35, tint: { r: 200, g: 220, b: 255 } },
    curiosity:  { tilt: 0.07, curve: 0.2, tint: { r: 150, g: 200, b: 255 } },
    neutral:    { tilt: 0.00, curve: 0.1, tint: null },
    boredom:    { tilt: 0.05, curve: -0.1, tint: { r: 150, g: 150, b: 170 } },
    tired:      { tilt: 0.06, curve: -0.2, tint: { r: 140, g: 150, b: 190 } },
    anxiety:    { tilt: -0.05, curve: -0.4, tint: { r: 190, g: 150, b: 255 } },
    fear:       { tilt: -0.06, curve: -0.5, tint: { r: 170, g: 140, b: 255 } },
    sadness:    { tilt: 0.05, curve: -0.7, tint: { r: 110, g: 160, b: 255 } },
    anger:      { tilt: -0.02, curve: -0.6, tint: { r: 255, g: 80, b: 60 } },
    guilty:     { tilt: 0.06, curve: -0.45, tint: { r: 160, g: 160, b: 210 } },
    embarrassed:{ tilt: 0.05, curve: -0.2, tint: { r: 255, g: 140, b: 170 } }
  };

  function createAvatar() {
    let canvas = null, ctx = null, raf = 0;
    let w = 0, h = 0, dpr = 1;
    let last = 0, time = 0;

    const img = new Image();
    let imgReady = false;
    let skin = { r: 240, g: 196, b: 174 };
    let skinDark = { r: 205, g: 158, b: 138 };

    const S = {
      speaking: false, listening: false, thinking: false,
      mouth: 0, mouthTarget: 0, mouthW: 1, mouthWTarget: 1, mouthR: 0, mouthRTarget: 0,
      viseme: 'MM', syllableT: 0, syllablePhase: 0,
      eyeOpen: 1, nextBlink: 1.8, blinkT: -1,
      lean: 0, leanY: 0, tilt: 0, breath: 0, glow: 0.4
    };
    let emotion = { emotion: 'neutral', valence: 0 };
    const pointer = { x: 0, y: 0 };

    // layout of the artwork inside the canvas
    let L = { x: 0, y: 0, w: 0, h: 0 };

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth || 520;
      h = canvas.clientHeight || 520;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout();
    }

    function layout() {
      if (!imgReady) return;
      const ar = img.width / img.height;
      // fill the height, leave room for the caption bar at the bottom
      let dh = h * 0.94;
      let dw = dh * ar;
      if (dw > w * 0.96) { dw = w * 0.96; dh = dw / ar; }
      L = { x: (w - dw) / 2, y: h - dh, w: dw, h: dh };
    }

    /** Pull the real skin colour out of the artwork for the eyelids. */
    function sampleSkin() {
      try {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(
          Math.round(img.width * ART.skinSample.x),
          Math.round(img.height * ART.skinSample.y), 1, 1
        ).data;
        if (d[3] > 200) {
          skin = { r: d[0], g: d[1], b: d[2] };
          skinDark = shade(skin, 0.82);
        }
      } catch (e) { /* keep the fallback tone */ }
    }

    // pixel position of a normalised artwork point, in canvas space
    const P = (p) => ({ x: L.x + p.x * L.w, y: L.y + p.y * L.h });

    // ---- drawing ----------------------------------------------------------
    function drawAura(colour) {
      const cx = w / 2, cy = L.y + L.h * 0.34, r = Math.max(w, h) * 0.42;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, rgba(colour, 0.20 * S.glow));
      g.addColorStop(0.45, rgba(colour, 0.07 * S.glow));
      g.addColorStop(1, rgba(colour, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // HUD rings behind the figure
      const rings = [
        { r: L.h * 0.30, a: 0.22, spd: 0.22 },
        { r: L.h * 0.345, a: 0.13, spd: -0.15 }
      ];
      for (const ring of rings) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(time * ring.spd);
        ctx.scale(1, 0.32);
        ctx.beginPath();
        ctx.arc(0, 0, ring.r, 0, TAU);
        ctx.strokeStyle = rgba(colour, ring.a * (0.5 + S.glow * 0.6));
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.restore();
      }
    }

    function drawParticles(colour) {
      const n = 34;
      const energy = S.thinking ? 2.3 : S.speaking ? 1.6 : S.listening ? 1.3 : 1;
      const cx = w / 2, cy = L.y + L.h * 0.4;
      for (let i = 0; i < n; i++) {
        const seed = i * 12.9898;
        const a = (i / n) * TAU + time * (0.1 + (i % 5) * 0.03) * energy;
        const rad = L.h * (0.30 + 0.13 * Math.sin(seed + time * 0.6));
        const x = cx + Math.cos(a) * rad;
        const y = cy + Math.sin(a) * rad * 0.55 + Math.sin(seed + time * 0.4) * 12;
        ctx.beginPath();
        ctx.fillStyle = rgba(colour, (0.12 + 0.34 * Math.abs(Math.sin(seed + time * 2))) * (0.4 + S.glow * 0.6));
        ctx.arc(x, y, 1 + (i % 3) * 0.7, 0, TAU);
        ctx.fill();
      }
    }

    /** Eyelids, painted in the character's own skin tone. */
    function drawBlink() {
      const closed = 1 - S.eyeOpen;
      if (closed < 0.02) return;
      for (const e of [ART.leftEye, ART.rightEye]) {
        const c = P(e);
        const rx = ART.eyeR.x * L.w;
        const ry = ART.eyeR.y * L.h;
        const lidH = ry * 2 * closed;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, rx, ry, 0, 0, TAU);
        ctx.clip();
        const g = ctx.createLinearGradient(c.x, c.y - ry, c.x, c.y - ry + lidH);
        g.addColorStop(0, `rgb(${skin.r},${skin.g},${skin.b})`);
        g.addColorStop(1, `rgb(${skinDark.r},${skinDark.g},${skinDark.b})`);
        ctx.fillStyle = g;
        ctx.fillRect(c.x - rx, c.y - ry, rx * 2, lidH);
        // lash line at the lid edge
        if (closed > 0.25) {
          ctx.strokeStyle = `rgba(60,40,34,${0.5 * closed})`;
          ctx.lineWidth = Math.max(1, ry * 0.18);
          ctx.beginPath();
          ctx.moveTo(c.x - rx, c.y - ry + lidH);
          ctx.lineTo(c.x + rx, c.y - ry + lidH);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    /** The speaking mouth, composited over the closed-lip smile. */
    function drawMouth() {
      const open = S.mouth;
      if (open < 0.035) return;

      const c = P(ART.mouth);
      const halfW = ART.mouthHalfW * L.w * S.mouthW * (1 - S.mouthR * 0.18);
      const openH = open * L.h * 0.030;
      const ex = EXPRESSION[(emotion && emotion.emotion) || 'neutral'] || EXPRESSION.neutral;
      const curve = ex.curve * halfW * 0.10;

      // lip outline: upper bow + lower bow
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(c.x - halfW, c.y);
        ctx.quadraticCurveTo(c.x, c.y - openH * 0.55 - curve * 0.5, c.x + halfW, c.y);
        ctx.quadraticCurveTo(c.x, c.y + openH * 1.25 - curve * 0.2, c.x - halfW, c.y);
        ctx.closePath();
      };

      // cavity
      path();
      ctx.fillStyle = 'rgba(58,22,26,0.95)';
      ctx.fill();

      ctx.save();
      path();
      ctx.clip();

      // upper teeth
      const band = Math.min(openH * 0.85, L.h * 0.011);
      ctx.fillStyle = 'rgba(252,250,248,0.97)';
      ctx.beginPath();
      ctx.moveTo(c.x - halfW, c.y - openH * 0.5);
      ctx.quadraticCurveTo(c.x, c.y - openH * 0.62 - curve * 0.5, c.x + halfW, c.y - openH * 0.5);
      ctx.lineTo(c.x + halfW, c.y - openH * 0.5 + band);
      ctx.quadraticCurveTo(c.x, c.y - openH * 0.62 - curve * 0.5 + band, c.x - halfW, c.y - openH * 0.5 + band);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,150,165,0.35)';
      ctx.lineWidth = 1;
      for (let k = 1; k < 5; k++) {
        const x = c.x - halfW + (halfW * 2) * (k / 5);
        ctx.beginPath();
        ctx.moveTo(x, c.y - openH * 0.52);
        ctx.lineTo(x, c.y - openH * 0.52 + band);
        ctx.stroke();
      }

      // tongue, only when properly open
      if (open > 0.55) {
        ctx.fillStyle = 'rgba(190,86,96,0.9)';
        ctx.beginPath();
        ctx.ellipse(c.x, c.y + openH * 0.85, halfW * 0.62, openH * 0.42, 0, 0, TAU);
        ctx.fill();
      }

      // lower teeth hint
      if (open > 0.6) {
        ctx.fillStyle = 'rgba(240,238,236,0.55)';
        ctx.fillRect(c.x - halfW, c.y + openH * 1.05, halfW * 2, band * 0.5);
      }
      ctx.restore();

      // lip edge so the overlay marries into the artwork
      path();
      ctx.strokeStyle = `rgba(${skinDark.r},${skinDark.g},${skinDark.b},0.95)`;
      ctx.lineWidth = Math.max(1.5, L.h * 0.004);
      ctx.stroke();
    }

    // ---- update -----------------------------------------------------------
    function update(dt) {
      time += dt;
      const ex = EXPRESSION[(emotion && emotion.emotion) || 'neutral'] || EXPRESSION.neutral;

      // blink
      S.nextBlink -= dt;
      if (S.nextBlink <= 0 && S.blinkT < 0) { S.blinkT = 0; S.nextBlink = 2.4 + Math.random() * 4.2; }
      let blink = 1;
      if (S.blinkT >= 0) {
        S.blinkT += dt;
        const d = 0.15;
        blink = S.blinkT < d / 2 ? 1 - S.blinkT / (d / 2) : clamp((S.blinkT - d / 2) / (d / 2), 0, 1);
        if (S.blinkT > d) S.blinkT = -1;
      }
      S.eyeOpen = blink;

      // breathing + lean
      S.breath = Math.sin(time * (S.speaking ? 1.45 : 0.8)) * 0.5 + 0.5;
      S.lean = approach(S.lean, pointer.x, 2.4, dt);
      S.leanY = approach(S.leanY, pointer.y, 2.4, dt);
      S.tilt = approach(S.tilt, ex.tilt + Math.sin(time * 0.33) * 0.012 + (S.thinking ? 0.03 : 0), 2.2, dt);

      // lip sync
      if (S.speaking) {
        S.syllableT -= dt;
        if (S.syllableT <= 0) {
          const v = pickViseme(S.viseme);
          S.viseme = v.k;
          S.mouthTarget = v.h; S.mouthWTarget = v.w; S.mouthRTarget = v.r;
          S.syllablePhase = 0;
          S.syllableT = 0.10 + Math.random() * 0.12;
        }
        S.syllablePhase += dt;
        const env = Math.min(1, S.syllablePhase / 0.04) * Math.exp(-S.syllablePhase * 4.0);
        S.mouth = approach(S.mouth, S.mouthTarget * env, 26, dt);
        S.mouthW = approach(S.mouthW, S.mouthWTarget, 16, dt);
        S.mouthR = approach(S.mouthR, S.mouthRTarget, 16, dt);
      } else {
        S.mouth = approach(S.mouth, 0, 10, dt);
        S.mouthW = approach(S.mouthW, 1, 6, dt);
        S.mouthR = approach(S.mouthR, 0, 6, dt);
      }

      S.glow = approach(S.glow, S.speaking ? 1 : S.thinking ? 0.8 : S.listening ? 0.7 : 0.42, 3, dt);
    }

    function draw() {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      update(dt);

      ctx.clearRect(0, 0, w, h);
      const accent = readAccent();
      const ex = EXPRESSION[(emotion && emotion.emotion) || 'neutral'] || EXPRESSION.neutral;
      const colour = ex.tint
        ? { r: Math.round((accent.r + ex.tint.r) / 2), g: Math.round((accent.g + ex.tint.g) / 2), b: Math.round((accent.b + ex.tint.b) / 2) }
        : accent;

      drawAura(colour);
      drawParticles(colour);

      if (imgReady) {
        const bob = (S.breath - 0.5) * L.h * 0.008;
        const px = S.lean * L.w * 0.022;
        const py = S.leanY * L.h * 0.010;
        const sc = 1 + (S.breath - 0.5) * 0.006 + (S.speaking ? 0.004 : 0);
        const cx = L.x + L.w / 2, cy = L.y + L.h * 0.62;

        ctx.save();
        ctx.translate(cx + px, cy + bob + py);
        ctx.rotate(S.tilt + S.lean * 0.03);
        ctx.scale(sc, sc);
        ctx.translate(-cx, -cy);

        ctx.drawImage(img, L.x, L.y, L.w, L.h);
        drawBlink();
        drawMouth();

        // listening: a soft rim light so it is obvious Gem is paying attention
        if (S.listening || S.speaking) {
          ctx.save();
          ctx.globalCompositeOperation = 'source-atop';
          const g = ctx.createLinearGradient(L.x, L.y, L.x + L.w, L.y + L.h);
          g.addColorStop(0, rgba(colour, 0.16 * S.glow));
          g.addColorStop(0.5, rgba(colour, 0));
          g.addColorStop(1, rgba(colour, 0.12 * S.glow));
          ctx.fillStyle = g;
          ctx.fillRect(L.x, L.y, L.w, L.h);
          ctx.restore();
        }
        ctx.restore();
      }

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
        img.onload = () => { imgReady = true; layout(); sampleSkin(); };
        img.onerror = () => { imgReady = false; console.warn('[GemAir] avatar art failed to load'); };
        img.src = ART.src;
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
