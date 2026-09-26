#!/usr/bin/env node
'use strict';

// Proactive engine tests: time-of-day greetings, consumed-once session
// memory, pending reminder / monitor awareness, rotation-aware opt-in idle
// check-ins, quiet hours. Pure functions (lib/proactive.js) + wiring checks.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const proactive = require(path.join(ROOT, 'lib/proactive.js'));

console.log('\nGemAir — proactive engine tests\n');

// ---------------------------------------------------------------------------
// buildGreeting: consumes last session exactly once, time-of-day aware
// ---------------------------------------------------------------------------
{
  const memory = {
    transcript: [
      { role: 'user', content: 'prepare the astronomy presentation', ts: 1 },
      { role: 'assistant', content: 'sure', ts: 2 },
      { role: 'user', content: 'compare oled and ips monitors', ts: 3 }
    ],
    reminders: [],
    monitors: [],
    goals: []
  };
  const record = proactive.recordSessionSummary(memory, { now: Date.parse('2026-09-16T22:30:00') });
  assert(record && record.consumed === false, 'session summary recorded un-consumed');
  assert(record.topics.length === 2, 'two distinctive user topics extracted');
  assert(/monitors/.test(record.topics[0]), 'newest topic first');

  // Next morning: greeting recalls the session and CONSUMES it.
  const morning = Date.parse('2026-09-17T09:15:00');
  const greeting = proactive.buildGreeting({ now: morning, memory, profile: { name: 'Ada' } });
  assert(greeting, 'a greeting must exist when a fresh session summary is stored');
  assert(/Good morning, Ada/.test(greeting.text), 'time-of-day greeting includes the user name');
  assert(/oled and ips monitors/.test(greeting.text), 'greeting recalls the last session topics');
  assert(memory.lastSession.consumed === true, 'summary is marked consumed on delivery');

  // Same day, second call: nothing more to recall — no repeat.
  const again = proactive.buildGreeting({ now: morning + 3600000, memory: { ...memory, reminders: [], monitors: [] }, profile: { name: 'Ada' } });
  assert(again === null, 'a consumed session summary is never repeated');
  console.log('  ok   greeting recalls last session once — never twice');
}

// Greeting surfaces pending reminders + monitor findings, empty memory = null
{
  const memory = {
    reminders: [
      { id: '1', text: 'call the dentist', at: Date.parse('2026-09-17T15:00:00'), done: false },
      { id: '2', text: 'far away thing', at: Date.parse('2026-10-01T09:00:00'), done: false }
    ],
    monitors: [
      { topic: 'Formula 1', lastHeadline: 'Race moved', alertPending: true },
      { topic: 'Nothing new', lastHeadline: 'Old', alertPending: false }
    ]
  };
  const greeting = proactive.buildGreeting({ now: Date.parse('2026-09-17T08:00:00'), memory, profile: {} });
  assert(greeting, 'reminders alone must still produce a greeting');
  assert(/call the dentist/.test(greeting.text), 'pending reminder is mentioned');
  assert(!/far away thing/.test(greeting.text), 'reminders beyond the 24h window stay out');
  assert(/Formula 1/.test(greeting.text), 'monitor with a pending alert is mentioned');
  assert(!/Nothing new/.test(greeting.text), 'quiet monitors stay quiet');

  assert.strictEqual(proactive.buildGreeting({ now: Date.parse('2026-09-17T08:00:00'), memory: {}, profile: {} }), null, 'empty memory = no invented greeting');
  assert.strictEqual(proactive.buildGreeting({ now: Date.parse('2026-09-17T08:00:00'), memory: null, profile: null }), null, 'null memory never throws');
  console.log('  ok   greeting covers reminders + monitors; never invents content');
}

// Time-of-day labels. Keep the reminder timestamp relative to each simulated
// clock, not the wall clock: the old Date.now() fixture expired after 24 hours
// and made every scheduled nightly run fail with a null greeting.
{
  const mk = (h) => {
    const now = new Date(2026, 8, 17, h, 0, 0).getTime();
    return proactive.buildGreeting({ now, memory: { reminders: [{ id: 'x', text: 'ping', at: now - 1000, done: false }] }, profile: {} });
  };
  assert(/Good morning/.test(mk(8).text), 'morning window');
  assert(/Good afternoon/.test(mk(14).text), 'afternoon window');
  assert(/Good evening/.test(mk(19).text), 'evening window');
  assert(/Still up/.test(mk(23).text) || /Still up/.test(mk(2).text), 'late night window');
  console.log('  ok   time-of-day greeting windows');
}

// ---------------------------------------------------------------------------
// buildCheckIn: opt-in, rate-limited, quiet at night, rotation-aware
// ---------------------------------------------------------------------------
{
  const now = new Date(2026, 8, 17, 11, 0, 0).getTime(); // 11am
  const memory = { todos: [{ text: 'water the plants', done: false }], reminders: [], goals: [] };

  // Off by default: the setting is an explicit opt-in.
  assert.strictEqual(proactive.buildCheckIn({ now, memory, profile: {}, state: {} }), null, 'check-ins are opt-in (default off)');

  const profile = { proactiveCheckIns: true };
  const first = proactive.buildCheckIn({ now, memory, profile, state: {} });
  assert(first && /water the plants/.test(first.text), 'first check-in mentions open to-dos');
  assert.strictEqual(first.angle, 'todos');

  // Rate limit: less than 3h since last one → silence.
  const tooSoon = proactive.buildCheckIn({ now: now + 1000 * 60 * 30, memory, profile, state: { lastCheckInAt: now, lastAngle: first.angle } });
  assert.strictEqual(tooSoon, null, 'check-ins never fire more often than the 3h gap');

  // Rotation: after the gap, the same angle must NOT repeat back-to-back.
  const later = proactive.buildCheckIn({ now: now + 4 * 3600000, memory, profile, state: { lastCheckInAt: now, lastAngle: 'todos' } });
  assert(later, 'check-in resumes after the gap');
  assert(later.angle !== 'todos', 'rotation never repeats the same angle twice in a row');

  // Quiet hours: nothing at night even when everything else aligns.
  const night = new Date(2026, 8, 17, 23, 30, 0).getTime();
  assert.strictEqual(proactive.buildCheckIn({ now: night, memory, profile, state: {} }), null, 'no check-ins during quiet hours (22:00-07:00)');
  console.log('  ok   check-ins: opt-in, 3h rate limit, angle rotation, quiet hours');
}

// extractTopics: skips bare greetings, dedupes, newest-first
{
  const memory = {
    transcript: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi!' },
      { role: 'user', content: 'plan the road trip itinerary' },
      { role: 'user', content: 'thanks' },
      { role: 'user', content: 'debug the flaky login test' }
    ]
  };
  const topics = proactive.extractTopics(memory, { limit: 3 });
  assert.deepStrictEqual(topics, ['debug the flaky login test', 'plan the road trip itinerary'], 'meaningful topics only, newest first');
  console.log('  ok   topic extraction skips small talk');
}

// ---------------------------------------------------------------------------
// Wiring: main.js scheduler, IPC + renderer subscription
// ---------------------------------------------------------------------------
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert(mainSrc.includes("require('./lib/proactive')"), 'main.js must require the proactive engine');
  assert(mainSrc.includes('startProactiveScheduler()'), 'proactive scheduler must be started from app.whenReady');
  assert(mainSrc.includes("sendToRenderer('proactive:greeting'"), 'launch greeting must be pushed to the renderer');
  assert(mainSrc.includes("sendToRenderer('proactive:checkin'"), 'idle check-ins must be pushed to the renderer');
  assert(mainSrc.includes('recordSessionEnd()'), 'session summary must be recorded at quit');
  assert(/before-quit/.test(mainSrc) && mainSrc.indexOf('recordSessionEnd()') > mainSrc.indexOf("app.on('before-quit'"), 'recordSessionEnd must run on before-quit');
  assert(mainSrc.includes('entry.alertPending = true'), 'monitor scheduler must flag fresh findings for the greeting');

  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert(preloadSrc.includes('onProactiveGreeting') && preloadSrc.includes('onProactiveCheckIn'), 'preload must expose both proactive channels');

  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert(appSrc.includes('api.onProactiveGreeting') && appSrc.includes('api.onProactiveCheckIn'), 'renderer must subscribe to both proactive channels');
  console.log('  ok   wiring: scheduler, IPC push, renderer subscriptions, quit-time summary');
}

console.log('\nAll proactive-engine tests passed.\n');
