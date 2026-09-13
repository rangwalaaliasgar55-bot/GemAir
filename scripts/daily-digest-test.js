'use strict';

const assert = require('assert');
const { buildDailyDigest, dayKey } = require('../lib/daily-digest');

const now = new Date(2026, 8, 13, 8, 0, 0, 0).getTime();
const digest = buildDailyDigest({
  reminders: [
    { id: 'r1', text: 'Review the launch notes', at: now + 60 * 60 * 1000 },
    { id: 'old', text: 'Already done', at: now - 60 * 1000, done: true }
  ],
  todos: [{ id: 't1', text: 'Walk for ten minutes' }],
  goals: [{ id: 'g1', text: 'Ship the morning workflow', category: 'career' }],
  mood: [{ emotion: 'steady', note: 'Good energy' }],
  monitors: [{ topic: 'GemAir' }]
}, {
  now,
  name: 'Commander',
  weather: { city: 'Indore', condition: 'Clear', temperature: 24 },
  headlines: [{ title: 'A useful headline', url: 'https://example.com', by: 'Example' }],
  monitorAlerts: [{ topic: 'GemAir', title: 'New release', url: 'https://example.com/release' }]
});

assert.equal(dayKey(new Date(now)), '2026-09-13');
assert.equal(digest.ok, true);
assert.equal(digest.sections.reminders.length, 1);
assert.equal(digest.sections.todos.length, 1);
assert.equal(digest.sections.headlines.length, 1);
assert.equal(digest.sections.monitored.length, 1);
assert.match(digest.summary, /Commander/);
assert.match(digest.summary, /1 reminder/);

const empty = buildDailyDigest({}, { now });
assert.equal(empty.sections.reminders.length, 0);
assert.match(empty.summary, /No reminders/);
console.log('daily-digest-test: all assertions passed');
