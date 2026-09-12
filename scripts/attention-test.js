#!/usr/bin/env node
/* Gem Air — attention engine tests. Pure logic, no Electron, no network. */
'use strict';

const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { defaultState, hydrate } = require(path.join(ROOT, 'lib/attention/core/schema'));
const classify = require(path.join(ROOT, 'lib/attention/core/classify'));
const blocking = require(path.join(ROOT, 'lib/attention/core/blocking'));
const schedule = require(path.join(ROOT, 'lib/attention/core/schedule'));
const tracking = require(path.join(ROOT, 'lib/attention/core/tracking'));
const { BrowserBridge } = require(path.join(ROOT, 'lib/attention/bridge'));
const enforcer = require(path.join(ROOT, 'lib/attention/native/enforcer'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

const at = (hh, mm, day = 3) => {
  const d = new Date(2026, 0, 7, hh, mm, 0); // Wed 7 Jan 2026
  assert.strictEqual(d.getDay(), day);
  return d;
};

console.log('\nclassification');
test('maps a known application to its category and relevance', () => {
  const s = defaultState();
  const c = classify.classify(s, { app: 'Code.exe', title: 'main.js — project' });
  assert.strictEqual(c.categoryId, 'development');
  assert.strictEqual(c.relevance, 'focus');
  assert.strictEqual(c.appLabel, 'VS Code');
  assert.strictEqual(c.known, true);
});

test('classifies the SITE inside a browser, not just "Chrome is open"', () => {
  const s = defaultState();
  const c = classify.classify(s, { app: 'chrome', title: 'Home - YouTube', url: 'https://www.youtube.com/watch?v=1' });
  assert.strictEqual(c.kind, 'site');
  assert.strictEqual(c.site, 'youtube.com');
  assert.strictEqual(c.categoryId, 'distraction');
  assert.strictEqual(c.urlSource, 'extension');
});

test('distinguishes a work site from a distraction site in the same browser', () => {
  const s = defaultState();
  const work = classify.classify(s, { app: 'chrome', url: 'https://developer.chrome.com/docs' });
  const play = classify.classify(s, { app: 'chrome', url: 'https://x.com/home' });
  assert.strictEqual(work.relevance, 'focus');
  assert.strictEqual(play.relevance, 'distraction');
});

test('falls back to window-title inference when no extension is paired', () => {
  const s = defaultState();
  const c = classify.classify(s, { app: 'msedge', title: 'Inbox (12) - Gmail' });
  assert.strictEqual(c.site, 'mail.google.com');
  assert.strictEqual(c.urlSource, 'title');
});

test('unknown application is reported as unknown so it can be asked about', () => {
  const s = defaultState();
  const c = classify.classify(s, { app: 'SomeNewTool', title: '' });
  assert.strictEqual(c.known, false);
  assert.strictEqual(c.categoryId, 'other');
});

test('learning a classification persists and changes the next result', () => {
  const s = defaultState();
  classify.learn(s, { kind: 'app', subject: 'SomeNewTool', categoryId: 'design' });
  const c = classify.classify(s, { app: 'SomeNewTool.exe' });
  assert.strictEqual(c.categoryId, 'design');
  assert.strictEqual(c.known, true);
});

test('subdomains match their parent site rule', () => {
  assert.strictEqual(classify.hostMatches('music.youtube.com', 'youtube.com'), true);
  assert.strictEqual(classify.hostMatches('notyoutube.com', 'youtube.com'), false);
});

console.log('\nschedule');
test('time windows work across midnight', () => {
  assert.strictEqual(schedule.inWindow(at(23, 45), '23:30', '07:00'), true);
  assert.strictEqual(schedule.inWindow(at(3, 0), '23:30', '07:00'), true);
  assert.strictEqual(schedule.inWindow(at(9, 0), '23:30', '07:00'), false);
});

test('minutes until a window ends is correct across midnight', () => {
  assert.strictEqual(schedule.minutesUntilEnd(at(23, 30), '07:00'), 450);
});

test('active plan blocks respect weekday selection', () => {
  const plans = [{ id: 'p1', name: 'Study', enabled: true, days: [1, 2, 3, 4, 5], blocks: [{ start: '09:00', end: '10:00', kind: 'focus', label: 'Focus' }], rules: {} }];
  assert.strictEqual(schedule.activePlanBlocks(plans, at(9, 30)).length, 1);
  assert.strictEqual(schedule.activePlanBlocks(plans, at(11, 0)).length, 0);
  const sunday = new Date(2026, 0, 4, 9, 30);
  assert.strictEqual(schedule.activePlanBlocks(plans, sunday).length, 0);
});

test('sleep status reports when the restriction lifts', () => {
  const st = schedule.sleepStatus({ enabled: true, start: '23:30', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }, at(1, 0));
  assert.strictEqual(st.active, true);
  assert.strictEqual(st.endsInMinutes, 360);
});

console.log('\nblocking');
function stateWithBlock(extra = {}) {
  const s = defaultState();
  s.blocks.sites.push({ id: 'b1', target: 'youtube.com', reason: 'Protected block', protected: true, enabled: true });
  s.blocks.apps.push({ id: 'b2', target: 'discord', reason: 'Focus', protected: false, enabled: true });
  return Object.assign(s, extra);
}

test('a blocked site is blocked with its reason', () => {
  const s = stateWithBlock();
  const c = classify.classify(s, { app: 'chrome', url: 'https://youtube.com' });
  const d = blocking.evaluate(s, c, at(10, 0));
  assert.strictEqual(d.blocked, true);
  assert.strictEqual(d.protectedBlock, true);
  assert.strictEqual(d.source, 'blocklist');
});

test('an exception releases a normal block but NOT a protected one', () => {
  const s = stateWithBlock();
  s.blocks.exceptions.push({ id: 'e1', kind: 'app', target: 'discord', reason: 'standup' });
  s.blocks.exceptions.push({ id: 'e2', kind: 'site', target: 'youtube.com' });
  const discord = blocking.evaluate(s, classify.classify(s, { app: 'discord' }), at(10, 0));
  const yt = blocking.evaluate(s, classify.classify(s, { app: 'chrome', url: 'https://youtube.com' }), at(10, 0));
  assert.strictEqual(discord.blocked, false, 'normal block should be waived');
  assert.strictEqual(yt.blocked, true, 'protected block must survive an exception');
});

test('an expired exception no longer applies', () => {
  const s = stateWithBlock();
  s.blocks.exceptions.push({ id: 'e1', kind: 'app', target: 'discord', until: Date.now() - 1000 });
  const d = blocking.evaluate(s, classify.classify(s, { app: 'discord' }), new Date());
  assert.strictEqual(d.blocked, true);
});

test('plan rules block during the focus period and release after it', () => {
  const s = defaultState();
  s.plans.push({
    id: 'p1', name: 'Study', enabled: true, days: [1, 2, 3, 4, 5],
    blocks: [{ start: '09:00', end: '10:00', kind: 'focus', label: 'Focus' }],
    rules: { blockedSites: ['youtube.com', 'instagram.com'], allowedSites: ['github.com'], protected: true }
  });
  const yt = classify.classify(s, { app: 'chrome', url: 'https://youtube.com' });
  assert.strictEqual(blocking.evaluate(s, yt, at(9, 30)).blocked, true);
  assert.strictEqual(blocking.evaluate(s, yt, at(10, 30)).blocked, false);
  const gh = classify.classify(s, { app: 'chrome', url: 'https://github.com/x' });
  assert.strictEqual(blocking.evaluate(s, gh, at(9, 30)).blocked, false);
});

test('strict plans block anything that is not focus or allow-listed', () => {
  const s = defaultState();
  s.plans.push({
    id: 'p2', name: 'Deep work', enabled: true, days: [0, 1, 2, 3, 4, 5, 6],
    blocks: [{ start: '09:00', end: '11:00', kind: 'focus', label: 'Deep' }],
    rules: { strict: true, allowedApps: ['code'], allowedCategories: ['development'] }
  });
  assert.strictEqual(blocking.evaluate(s, classify.classify(s, { app: 'code' }), at(10, 0)).blocked, false);
  assert.strictEqual(blocking.evaluate(s, classify.classify(s, { app: 'spotify' }), at(10, 0)).blocked, true);
});

test('breaks inside a plan do not block', () => {
  const s = defaultState();
  s.plans.push({
    id: 'p3', name: 'Study', enabled: true, days: [0, 1, 2, 3, 4, 5, 6],
    blocks: [{ start: '10:00', end: '10:15', kind: 'break', label: 'Break' }],
    rules: { strict: true, blockedSites: ['youtube.com'] }
  });
  const yt = classify.classify(s, { app: 'chrome', url: 'https://youtube.com' });
  assert.strictEqual(blocking.evaluate(s, yt, at(10, 5)).blocked, false);
});

test('sleep blocks the configured categories until morning', () => {
  const s = defaultState();
  s.sleep = { enabled: true, start: '23:30', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6], blockCategories: ['distraction'], blockApps: [], blockSites: [] };
  const yt = classify.classify(s, { app: 'chrome', url: 'https://youtube.com' });
  const night = blocking.evaluate(s, yt, at(2, 0));
  assert.strictEqual(night.blocked, true);
  assert.strictEqual(night.source, 'sleep');
  assert.strictEqual(blocking.evaluate(s, yt, at(12, 0)).blocked, false);
});

test('browser policy hands the extension a flat, enforceable rule set', () => {
  const s = stateWithBlock();
  s.plans.push({
    id: 'p1', name: 'Study', enabled: true, days: [0, 1, 2, 3, 4, 5, 6],
    blocks: [{ start: '09:00', end: '10:00', kind: 'focus', label: 'Focus' }],
    rules: { blockedSites: ['instagram.com'] }
  });
  const policy = blocking.browserPolicy(s, at(9, 30));
  const targets = policy.blocked.map((b) => b.target);
  assert.ok(targets.includes('youtube.com'));
  assert.ok(targets.includes('instagram.com'));
  assert.ok(policy.categoryRules.length > 0);
});

console.log('\ntracking');
test('records and merges segments, and totals by lane', () => {
  const s = defaultState();
  const ctx = classify.classify(s, { app: 'code' });
  const now = Date.now();
  tracking.record(s, ctx, now, 60000);
  tracking.record(s, ctx, now + 60000, 60000);
  const sum = tracking.summarize(s);
  assert.strictEqual(sum.totals.focus, 120000);
  const key = tracking.dayKey(now);
  assert.strictEqual(s.activity.days[key].segments.length, 1, 'same subject should merge');
});

test('distraction and idle are separated in the summary', () => {
  const s = defaultState();
  const now = Date.now();
  tracking.record(s, classify.classify(s, { app: 'chrome', url: 'https://youtube.com' }), now, 60000);
  tracking.record(s, { subject: 'idle', relevance: 'idle', categoryId: 'other', kind: 'app' }, now + 60000, 120000);
  const sum = tracking.summarize(s);
  assert.strictEqual(sum.totals.distraction, 60000);
  assert.strictEqual(sum.totals.idle, 120000);
  assert.strictEqual(sum.percentages.distraction, 33.3);
});

test('timeline and trend produce usable dashboard data', () => {
  const s = defaultState();
  tracking.record(s, classify.classify(s, { app: 'code' }), Date.now(), 300000);
  assert.strictEqual(tracking.timeline(s).length, 1);
  assert.strictEqual(tracking.trend(s, 7).length, 7);
  assert.ok(tracking.lastHour(s).focus > 0);
});

console.log('\npersistence');
test('hydrate keeps user data and restores missing defaults', () => {
  const s = hydrate({ plans: [{ id: 'p' }], settings: { idleAfterSeconds: 60 } });
  assert.strictEqual(s.plans.length, 1);
  assert.strictEqual(s.settings.idleAfterSeconds, 60);
  assert.ok(s.categories.length >= 9);
  assert.ok(s.settings.pollIntervalMs > 0);
});

console.log('\nbrowser bridge');
(async () => {
  await testAsync('bridge rejects unpaired clients and accepts a valid pairing code', async () => {
    const tabs = [];
    const bridge = new BrowserBridge({ port: 18677, onTab: (t) => tabs.push(t), getPolicy: () => ({ blocked: [{ target: 'youtube.com' }], exceptions: [], categoryRules: [] }) });
    await bridge.start();
    try {
      const unauth = await fetch('http://127.0.0.1:18677/policy');
      assert.strictEqual(unauth.status, 401);

      const badPair = await fetch('http://127.0.0.1:18677/pair?code=000000');
      assert.strictEqual(badPair.status, 403);

      const code = bridge.newPairCode();
      const paired = await (await fetch(`http://127.0.0.1:18677/pair?code=${code}`)).json();
      assert.ok(paired.token);

      const policy = await (await fetch('http://127.0.0.1:18677/policy', { headers: { 'x-gemair-token': paired.token } })).json();
      assert.strictEqual(policy.blocked[0].target, 'youtube.com');

      await fetch('http://127.0.0.1:18677/tab', {
        method: 'POST',
        headers: { 'x-gemair-token': paired.token, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://youtube.com', title: 'YouTube' })
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(tabs.length, 1);
      assert.strictEqual(bridge.status().connected, true);
    } finally { bridge.stop(); }
  });

  console.log('\nenforcement boundary');
  test('enforcer rejects unsafe process names', () => {
    assert.strictEqual(enforcer.safeProcessName('discord'), 'discord');
    assert.strictEqual(enforcer.safeProcessName('a & calc'), null);
    assert.strictEqual(enforcer.safeProcessName('x; rm -rf /'), null);
  });

  await testAsync('system-wide site blocking honestly reports that it needs elevation', async () => {
    const r = await enforcer.blockSiteSystemWide(['youtube.com']);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.requiresNativeIntegration, true);
    assert.ok(r.howToEnable);
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures' : ''}\n`);
})();
