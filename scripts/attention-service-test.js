#!/usr/bin/env node
/* Gem Air — end-to-end service test.
   Drives the real AttentionService (store + classification + blocking + tracking + island)
   with synthetic foreground samples, so the whole pipeline is exercised without Electron. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { AttentionService } = require(path.join(ROOT, 'lib/attention/service'));
const enforcer = require(path.join(ROOT, 'lib/attention/native/enforcer'));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-air-'));
  const notes = [];
  const service = new AttentionService({ userDataDir: dir, notify: (n) => notes.push(n) });
  // Never touch the real OS or ports in this test.
  service.detector.start = () => {};
  service.detector.stop = () => {};
  const closed = [];
  enforcer.closeApp = async (name) => { closed.push(name); return { ok: true, target: name }; };

  const feed = (app, extra = {}) => {
    service.onSample({ app, title: extra.title || '', pid: 1, idleSeconds: extra.idleSeconds || 0, at: extra.at || Date.now() });
  };

  console.log('\nservice pipeline');

  await test('island starts compact with a real context after the first sample', () => {
    feed('code', { title: 'service.js' });
    const is = service.islandState();
    assert.strictEqual(is.primary, 'VS Code');
    assert.strictEqual(is.secondary, 'Development');
    assert.strictEqual(is.mode, 'working');
    assert.match(is.timerLabel, /^\d{2}:\d{2}:\d{2}$/);
  });

  await test('time accrues against the previous context, not the new one', () => {
    const t0 = Date.now();
    feed('code', { at: t0 });
    feed('code', { at: t0 + 120000 });
    const sum = service.snapshot().summary;
    assert.ok(sum.totals.focus >= 120000, 'focus should have accrued: ' + sum.totals.focus);
  });

  await test('browser tab from the extension changes the island to the site', () => {
    service.onBrowserTab({ url: 'https://www.youtube.com/watch?v=x', title: 'YouTube' });
    feed('chrome', { title: 'YouTube - Google Chrome' });
    const is = service.islandState();
    assert.strictEqual(is.primary, 'youtube.com');
    assert.strictEqual(is.mode, 'distraction');
    assert.strictEqual(is.urlSource, 'extension');
  });

  await test('an unknown app raises the "what is this for?" question exactly once', () => {
    service.question = null;
    service.askedThisSession.clear();
    feed('MysteryTool');
    assert.ok(service.question, 'expected a question');
    assert.strictEqual(service.question.prompt, 'What is this for?');
    assert.strictEqual(service.islandState().mode, 'question');
    const first = service.question;
    service.question = null;
    feed('code');
    feed('MysteryTool');
    assert.strictEqual(service.question, null, 'should not re-ask in the same session');
    service.question = first;
  });

  await test('answering the question files the app permanently and clears the island', () => {
    const q = service.question;
    const res = service.answerQuestion(q.id, 'design');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(service.question, null);
    feed('MysteryTool');
    assert.strictEqual(service.context.categoryId, 'design');
    assert.strictEqual(service.context.known, true);
  });

  await test('a user-created category is stored and usable', () => {
    const cat = service.createCategory({ label: 'Research', color: '#ff00aa', relevance: 'focus' });
    assert.strictEqual(cat.id, 'research');
    service.askedThisSession.clear();
    feed('ZoteroApp');
    service.answerQuestion(service.question.id, 'research');
    feed('ZoteroApp');
    assert.strictEqual(service.context.categoryId, 'research');
    assert.strictEqual(service.context.relevance, 'focus');
  });

  await test('blocking a site flips the island to Blocked and records the attempt', async () => {
    service.store.update((s) => { s.blocks.sites.push({ id: 'b1', target: 'youtube.com', reason: 'Protected block', protected: true, enabled: true }); return s; });
    service.onBrowserTab({ url: 'https://youtube.com/', title: 'YouTube' });
    feed('chrome');
    await new Promise((r) => setTimeout(r, 20));
    const is = service.islandState();
    assert.strictEqual(is.mode, 'blocked');
    assert.strictEqual(is.blocked, true);
    assert.strictEqual(is.protectedBlock, true);
    assert.ok(service.state.attempts.length > 0, 'attempt should be recorded');
    assert.ok(notes.some((n) => n.title === 'Blocked'), 'user should be notified');
  });

  await test('a blocked APPLICATION triggers real enforcement (process close)', async () => {
    service.store.update((s) => { s.blocks.apps.push({ id: 'b2', target: 'steam', reason: 'Focus', protected: false, enabled: true }); return s; });
    feed('steam');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(closed.includes('steam'), 'enforcer should have been asked to close steam');
  });

  await test('idle time is tracked separately and shown on the island', () => {
    feed('code', { idleSeconds: 600 });
    assert.strictEqual(service.islandState().mode, 'idle');
    const t = Date.now();
    feed('code', { idleSeconds: 600, at: t });
    feed('code', { idleSeconds: 600, at: t + 60000 });
    assert.ok(service.snapshot().summary.totals.idle > 0);
  });

  await test('sleep mode takes over the island and states when it ends', () => {
    const now = new Date();
    const start = `${String(now.getHours()).padStart(2, '0')}:00`;
    const endH = (now.getHours() + 2) % 24;
    service.store.update((s) => {
      s.sleep = { enabled: true, start, end: `${String(endH).padStart(2, '0')}:00`, days: [0, 1, 2, 3, 4, 5, 6], blockCategories: ['distraction'], blockApps: [], blockSites: [] };
      return s;
    });
    feed('code');
    const is = service.islandState();
    assert.strictEqual(is.sleep.active, true);
    assert.strictEqual(is.mode, 'sleep');
    assert.ok(is.secondary.startsWith('Sleep until'));
  });

  await test('snapshot exposes honest capability flags for the UI', () => {
    const caps = service.snapshot().capabilities;
    assert.strictEqual(caps.closeApp, true);
    assert.strictEqual(caps.blockSiteSystemWide, 'requires-elevation');
    assert.strictEqual(caps.blockSiteInBrowser, 'extension');
    assert.ok(caps.platform);
  });

  await test('state survives a restart (atomic persistence)', () => {
    service.store.flush();
    const reopened = new AttentionService({ userDataDir: dir });
    assert.ok(reopened.state.appRules.some((r) => r.match === 'mysterytool' && r.category === 'design'), 'learned rule should persist');
    assert.ok(reopened.state.blocks.sites.some((b) => b.target === 'youtube.com'), 'blocks should persist');
    assert.ok(reopened.state.categories.some((c) => c.id === 'research'), 'custom category should persist');
    assert.ok(reopened.state.attempts.length > 0, 'attempts should persist');
    reopened.stop();
  });

  service.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures' : ''}\n`);
})();
