'use strict';
/* Gem Air — detection engine.
   Foreground application + window title + idle time.

   IMPLEMENTED: Windows (PowerShell/user32 via the existing window-tools), macOS, Linux (best effort).
   Idle time uses Electron's powerMonitor when available, otherwise a native fallback.
   Active browser TAB/URL does NOT come from here — it arrives from the browser extension
   through lib/attention/bridge.js. Window titles are only a fallback heuristic. */

const windowTools = require('../../window-tools');

let powerMonitor = null;
try { ({ powerMonitor } = require('electron')); } catch { /* running outside Electron (tests) */ }

class Detector {
  constructor({ intervalMs = 2000 } = {}) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.listeners = new Set();
    this.last = null;
    this.supported = process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
  }

  onSample(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  idleSeconds() {
    try {
      if (powerMonitor && typeof powerMonitor.getSystemIdleTime === 'function') return powerMonitor.getSystemIdleTime();
    } catch {}
    return 0;
  }

  async sample() {
    let focused = { app: '', title: '', pid: 0 };
    try { focused = (await windowTools.getFocusedWindow()) || focused; } catch {}
    return {
      app: focused.app || '',
      title: focused.title || '',
      pid: focused.pid || 0,
      idleSeconds: this.idleSeconds(),
      at: Date.now()
    };
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      let sample;
      try { sample = await this.sample(); } catch { return; }
      this.last = sample;
      for (const fn of this.listeners) {
        try { fn(sample); } catch {}
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Detector };
