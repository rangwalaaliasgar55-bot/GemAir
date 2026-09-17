/* GemAir — Hardware Watch (pure, injectable; no Electron imports).

   Concept ported from Mark-LIV's hardware monitoring (continuous CPU/RAM/
   temperature telemetry with alerts in the user's language), reimplemented
   dependency-free on GemAir's own engine.

   Rules it enforces — the honest ones:
     • polling only exists while enabled; stop() tears the loop down fully
       (off means genuinely off, same rule as the clipboard watcher);
     • transient spikes stay silent: CPU/RAM/temp must stay hot for N
       consecutive samples before they speak;
     • once spoken, a condition goes quiet for RE-ALERT minutes — it does
       not nag every poll;
     • what this OS can't report (temperature on Windows/macOS without
       native deps, battery on most desktops) is reported as unavailable
       once, then left alone — never guessed, never faked. */
'use strict';

const DEFAULTS = {
  intervalMs: 20000,
  cpuPercent: 90,
  cpuSustain: 3,        // samples: ~60s of continuous heat
  memFreePercent: 5,
  memSustain: 3,
  tempC: 85,
  tempSustain: 2,
  batteryPercent: 15,
  realertMs: 15 * 60 * 1000
};

function createHardwareWatch(deps) {
  const d = deps || {};
  const cfg = Object.assign({}, DEFAULTS, d.config || {});
  if (typeof d.sample !== 'function') throw new Error('hardware-watch needs a sample() function');
  const sample = d.sample;
  const alert = typeof d.alert === 'function' ? d.alert : () => {};
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const setT = (d.setInterval || setInterval);
  const clearT = (d.clearInterval || clearInterval);

  let timer = null;
  const sustain = { cpu: 0, mem: 0, temp: 0 };
  const alertedAt = {};      // kind -> timestamp of last alert
  const unavailable = {};    // kind -> true once reported

  function fire(kind, percent, extra) {
    alertedAt[kind] = now();
    alert(Object.assign({
      kind,                 // 'cpu' | 'mem' | 'temp' | 'battery' | 'unavailable:<thing>'
      at: alertedAt[kind]
    }, extra || {}));
  }

  function throttled(kind) {
    const last = alertedAt[kind];
    return last && (now() - last) < cfg.realertMs;
  }

  /* One evaluation of a reading against the rules. Pure — exported for tests. */
  function evaluate(reading) {
    if (!reading) return null;
    let fired = null;

    if (typeof reading.cpuPercent === 'number') {
      sustain.cpu = reading.cpuPercent >= cfg.cpuPercent ? sustain.cpu + 1 : 0;
      if (sustain.cpu >= cfg.cpuSustain && !throttled('cpu')) { fire('cpu', reading.cpuPercent); fired = 'cpu'; }
    }
    if (typeof reading.memFreePercent === 'number') {
      sustain.mem = reading.memFreePercent <= cfg.memFreePercent ? sustain.mem + 1 : 0;
      if (sustain.mem >= cfg.memSustain && !throttled('mem')) { fire('mem', reading.memFreePercent); fired = 'mem'; }
    }
    if (reading.tempC === null) {
      if (!unavailable.temp) { unavailable.temp = true; fire('unavailable:temp', null, { thing: 'temperature' }); }
    } else if (typeof reading.tempC === 'number') {
      sustain.temp = reading.tempC >= cfg.tempC ? sustain.temp + 1 : 0;
      if (sustain.temp >= cfg.tempSustain && !throttled('temp')) { fire('temp', reading.tempC); fired = 'temp'; }
    }
    if (reading.batteryPercent === null) {
      if (!unavailable.battery) { unavailable.battery = true; fire('unavailable:battery', null, { thing: 'battery' }); }
    } else if (typeof reading.batteryPercent === 'number' && reading.batteryCharging === false) {
      if (reading.batteryPercent <= cfg.batteryPercent && !throttled('battery')) { fire('battery', reading.batteryPercent); fired = 'battery'; }
    }
    return fired;
  }

  function tick() {
    let reading = null;
    try { reading = sample(); } catch (e) { return; } // a bad sample is silent, never a crash storm
    if (reading) evaluate(reading);
  }

  function start() {
    if (timer) return true;
    timer = setT(tick, cfg.intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }
  function stop() {
    if (timer) { clearT(timer); timer = null; }
    return true;
  }
  function status() {
    return { running: !!timer, intervalMs: cfg.intervalMs, alertedAt: Object.assign({}, alertedAt), unavailable: Object.keys(unavailable) };
  }

  return { start, stop, status, evaluate, isRunning: () => !!timer };
}

/* Real sampling, built from injected Node primitives so the module stays
   pure/importable in tests: pass require('os') and require('fs'). */
function createSampler(deps) {
  const os = deps && deps.os;
  const fsx = deps && deps.fs;
  const platform = (deps && deps.platform) || process.platform;
  let lastCpu = null;

  function cpuPercentNow() {
    const cpus = os.cpus();
    const snap = cpus.map((c) => Object.assign({}, c.times));
    let pct = 0;
    if (lastCpu && lastCpu.length === snap.length) {
      let idle = 0, total = 0;
      for (let i = 0; i < snap.length; i++) {
        for (const k of Object.keys(snap[i])) {
          idle += k === 'idle' ? snap[i][k] - lastCpu[i][k] : 0;
          total += snap[i][k] - lastCpu[i][k];
        }
      }
      pct = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    }
    lastCpu = snap;
    return pct; // first call returns 0 — an honest "no delta yet", not a guess
  }

  function tempCNow() {
    // Only Linux exposes this without native modules. Everywhere else:
    // honest null → the watcher reports unavailable exactly once.
    if (platform !== 'linux' || !fsx) return null;
    try {
      const zones = fsx.readdirSync('/sys/class/thermal').filter((f) => f.startsWith('thermal_zone'));
      let best = null;
      for (const z of zones) {
        try {
          const t = parseInt(String(fsx.readFileSync('/sys/class/thermal/' + z + '/temp', 'utf8')).trim(), 10);
          if (Number.isFinite(t) && t > 0 && (best === null || t > best)) best = t / 1000;
        } catch {}
      }
      return best;
    } catch { return null; }
  }

  function batteryNow() {
    if (platform !== 'linux' || !fsx) return { percent: null, charging: null };
    try {
      const bats = fsx.readdirSync('/sys/class/power_supply').filter((f) => /^BAT/i.test(f));
      if (!bats.length) return { percent: null, charging: null };
      const cap = parseInt(String(fsx.readFileSync('/sys/class/power_supply/' + bats[0] + '/capacity', 'utf8')).trim(), 10);
      const stat = String(fsx.readFileSync('/sys/class/power_supply/' + bats[0] + '/status', 'utf8')).trim();
      return { percent: Number.isFinite(cap) ? cap : null, charging: /charging|full/i.test(stat) };
    } catch { return { percent: null, charging: null }; }
  }

  return function sample() {
    const total = os.totalmem(), free = os.freemem();
    const bat = batteryNow();
    return {
      cpuPercent: cpuPercentNow(),
      memFreePercent: Math.round((free / total) * 100),
      tempC: tempCNow(),
      batteryPercent: bat.percent,
      batteryCharging: bat.charging
    };
  };
}

module.exports = { createHardwareWatch, createSampler, DEFAULTS };
