/* Hardware watch tests — sustained-threshold alerts with honest unavailability.
   Pure: sample/now/timers injected, so no real hardware is touched. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const hw = require(path.join(ROOT, 'lib', 'hardware-watch.js'));

function harness(readings, cfg) {
  const alerts = [];
  let t = 1000000;
  let timer = null;
  const w = hw.createHardwareWatch({
    sample: () => readings.shift() || readings[readings.length],
    alert: (a) => alerts.push(a),
    now: () => t,
    setInterval: (fn) => { timer = { fn, cleared: false, unref() {} }; return timer; },
    clearInterval: (x) => { x.cleared = true; },
    config: cfg
  });
  return { w, alerts, get timer() { return timer; }, advance: (ms) => { t += ms; } };
}

test('a single CPU spike stays silent; sustained heat alerts once', () => {
  const { w, alerts } = harness([]);
  w.evaluate({ cpuPercent: 95, memFreePercent: 50, tempC: null, batteryPercent: null, batteryCharging: null });
  w.evaluate({ cpuPercent: 12, memFreePercent: 50, tempC: null, batteryPercent: null, batteryCharging: null });
  const cpuAlerts = alerts.filter(a => a.kind === 'cpu');
  assert.equal(cpuAlerts.length, 0, 'spike alone must not alert');
  w.evaluate({ cpuPercent: 95, memFreePercent: 50, tempC: null, batteryPercent: null, batteryCharging: null });
  w.evaluate({ cpuPercent: 95, memFreePercent: 50, tempC: null, batteryPercent: null, batteryCharging: null });
  w.evaluate({ cpuPercent: 95, memFreePercent: 50, tempC: null, batteryPercent: null, batteryCharging: null });
  assert.equal(alerts.filter(a => a.kind === 'cpu').length, 1, 'sustained heat speaks exactly once');
});

test('re-alert is throttled by the re-alert window, not per-sample nagging', () => {
  const { w, alerts, advance } = harness([]);
  for (let i = 0; i < 6; i++) w.evaluate({ cpuPercent: 99, memFreePercent: 50, tempC: null, batteryPercent: null, batteryCharging: null });
  assert.equal(alerts.filter(a => a.kind === 'cpu').length, 1);
  advance(hw.DEFAULTS.realertMs + 1000); // 15 min pass
  for (let i = 0; i < 3; i++) w.evaluate({ cpuPercent: 99, memFreePercent: 50, tempC: null, batteryPercent: null, batteryCharging: null });
  assert.equal(alerts.filter(a => a.kind === 'cpu').length, 2, 'it may speak again after the honest cooldown');
});

test('unavailable sensors are reported exactly once, then left alone', () => {
  const { w, alerts } = harness([]);
  for (let i = 0; i < 5; i++) w.evaluate({ cpuPercent: 10, memFreePercent: 80, tempC: null, batteryPercent: null, batteryCharging: null });
  assert.equal(alerts.filter(a => a.kind === 'unavailable:temp').length, 1);
  assert.equal(alerts.filter(a => a.kind === 'unavailable:battery').length, 1);
});

test('battery alert only counts when NOT charging', () => {
  const { w, alerts } = harness([]);
  for (let i = 0; i < 3; i++) w.evaluate({ cpuPercent: 10, memFreePercent: 80, tempC: 40, batteryPercent: 8, batteryCharging: true });
  assert.equal(alerts.filter(a => a.kind === 'battery').length, 0, 'charging is fine');
  w.evaluate({ cpuPercent: 10, memFreePercent: 80, tempC: 40, batteryPercent: 8, batteryCharging: false });
  assert.equal(alerts.filter(a => a.kind === 'battery').length, 1);
});

test('stop() tears the loop down: timer cleared, no polling left', () => {
  const h = harness([]);
  h.w.start();
  assert.ok(h.w.isRunning());
  h.w.stop();
  assert.equal(h.w.isRunning(), false);
  assert.equal(h.timer.cleared, true, 'off means genuinely off — the interval is dead');
});

test('evaluate ignores malformed readings instead of throwing', () => {
  const { w, alerts } = harness([]);
  w.evaluate(null);
  w.evaluate({});
  assert.equal(alerts.length, 0);
});

test('createSampler produces a real reading shape from injected os/fs', () => {
  const fakeOs = { cpus: () => [{ times: { user: 5, nice: 0, sys: 3, idle: 92, irq: 0 } }], totalmem: () => 100, freemem: () => 40 };
  const fakeFs = {
    readdirSync: () => { throw new Error('no /sys here'); },
    readFileSync: () => { throw new Error('nope'); }
  };
  const sample = hw.createSampler({ os: fakeOs, fs: fakeFs, platform: 'linux' });
  const r1 = sample();
  assert.equal(typeof r1.cpuPercent, 'number');
  assert.equal(r1.memFreePercent, 40);
  assert.equal(r1.tempC, null, 'unreadable thermal zones → honest null');
  assert.equal(r1.batteryPercent, null);
});

/* ---- wiring ---- */
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const ackSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'instant-ack.js'), 'utf8');

test('main starts the watcher ONLY when the profile opted in', () => {
  const i = mainSrc.indexOf('function syncHardwareWatch');
  const body = mainSrc.slice(i, i + 500);
  assert.ok(body.includes("p.hardwareWatch === true"), 'explicit opt-in, never default-on');
  assert.ok(body.includes('hw.stop()'), 'toggling off tears the loop down');
});

test('alerts surface as localized speech and honest "unavailable" toasts', () => {
  assert.ok(appSrc.includes('setupHardwareWatch'));
  assert.ok(appSrc.includes("startsWith('unavailable:')"));
  for (const k of ['warn-cpu', 'warn-ram', 'warn-temp', 'warn-battery']) {
    assert.ok(ackSrc.includes("'" + k + "'"), k);
    assert.ok(appSrc.includes(k), k);
  }
  const langs = { en: 'processor', hi: 'प्रोसेसर', ru: 'процессор', de: 'Prozessor' };
  for (const [lang, word] of Object.entries(langs)) assert.ok(ackSrc.includes(word), `${lang} warn line: ${word}`);
});

test('the settings hint is honest about what the OS cannot report', () => {
  const i = htmlSrc.indexOf('id="hardwareWatchHint"');
  assert.ok(i > -1);
  const hint = htmlSrc.slice(i, i + 600);
  assert.match(hint, /every 20s/);
  assert.match(hint, /says so once/i, 'unavailable sensors must be announced, not faked');
  assert.match(htmlSrc, /id="setHardwareWatch"/);
});
