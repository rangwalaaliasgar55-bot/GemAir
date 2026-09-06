#!/usr/bin/env node
'use strict';

/**
 * GemAir original UI sound pack.
 *
 * Every sample below is synthesized deterministically by THIS script
 * (layered sine/triangle oscillators with exponential envelopes) and
 * written as 16-bit mono WAV. No third-party audio is used anywhere:
 * run `node scripts/generate-sfx.js` to regenerate the pack byte-for-byte.
 */
const fs = require('fs');
const path = require('path');

const RATE = 44100;
const OUT = path.join(__dirname, '..', 'renderer', 'assets', 'sfx');

function tone({ dur = 0.15, freq = 440, freqEnd = null, type = 'sine', gain = 0.5, delay = 0, total = null }) {
  const seconds = total || dur + delay + 0.05;
  const n = Math.floor(seconds * RATE);
  const buf = new Float32Array(n);
  const start = Math.floor(delay * RATE);
  const len = Math.floor(dur * RATE);
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const k = i / len;
    const f = freqEnd == null ? freq : freq + (freqEnd - freq) * k;
    const phase = 2 * Math.PI * f * t;
    let v;
    if (type === 'square') v = Math.sign(Math.sin(phase)) * 0.6;
    else if (type === 'triangle') v = (2 / Math.PI) * Math.asin(Math.sin(phase));
    else v = Math.sin(phase);
    buf[start + i] += v * gain * Math.exp(-4 * k);
  }
  return { buf, seconds };
}

function mix(seconds, ...parts) {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (const { buf } of parts) {
    const m = Math.min(n, buf.length);
    for (let i = 0; i < m; i++) out[i] += buf[i];
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.95) for (let i = 0; i < n; i++) out[i] *= 0.95 / peak;
  return out;
}

function writeWav(name, samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + samples.length * 2, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(RATE, 24); data.writeUInt32LE(RATE * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(path.join(OUT, name), data);
  return data.length;
}

// Original GemAir recipes: short cinematic blips, chimes and sweeps.
const pack = {
  'click.wav': mix(0.12, tone({ dur: 0.05, freq: 840, freqEnd: 420, gain: 0.5 })),
  'hover.wav': mix(0.1, tone({ dur: 0.05, freq: 1200, freqEnd: 1500, type: 'triangle', gain: 0.3 })),
  'activate.wav': mix(0.5, tone({ dur: 0.32, freq: 320, freqEnd: 920, gain: 0.5 }), tone({ dur: 0.3, freq: 640, freqEnd: 1840, delay: 0.08, type: 'triangle', gain: 0.25 })),
  'message.wav': mix(0.4, tone({ dur: 0.1, freq: 523.25, type: 'triangle', gain: 0.45 }), tone({ dur: 0.16, freq: 659.25, delay: 0.09, type: 'triangle', gain: 0.45 })),
  'swoosh.wav': mix(0.16, tone({ dur: 0.12, freq: 620, freqEnd: 180, gain: 0.4 })),
  'alert.wav': mix(0.5, tone({ dur: 0.12, freq: 660, type: 'square', gain: 0.3 }), tone({ dur: 0.12, freq: 520, type: 'square', delay: 0.14, gain: 0.3 })),
  'mic.wav': mix(0.25, tone({ dur: 0.08, freq: 500, freqEnd: 900, gain: 0.4 }), tone({ dur: 0.1, freq: 900, freqEnd: 1350, delay: 0.07, gain: 0.35 })),
  'success.wav': mix(0.6, tone({ dur: 0.12, freq: 523.25, type: 'triangle', gain: 0.4 }), tone({ dur: 0.12, freq: 659.25, delay: 0.1, type: 'triangle', gain: 0.4 }), tone({ dur: 0.22, freq: 783.99, delay: 0.2, type: 'triangle', gain: 0.4 }))
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, samples] of Object.entries(pack)) {
  console.log(name, writeWav(name, samples), 'bytes');
}
console.log('original GemAir sfx pack written to renderer/assets/sfx/');
