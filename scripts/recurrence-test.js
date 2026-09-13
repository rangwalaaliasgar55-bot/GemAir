#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { normalizeRecurrence, nextOccurrence } = require('../lib/recurrence');

assert.strictEqual(normalizeRecurrence('daily').label, 'daily');
assert.strictEqual(normalizeRecurrence('every 2 hours').label, 'every 2 hours');
assert.strictEqual(normalizeRecurrence('not a schedule'), null);

const start = new Date(2026, 0, 5, 9, 0, 0).getTime(); // Monday
assert.strictEqual(new Date(nextOccurrence(start, 'weekdays', start)).getDay(), 2, 'weekday recurrence skips to Tuesday');
assert.strictEqual(nextOccurrence(start, 'daily', start) - start, 24 * 60 * 60 * 1000);
assert.strictEqual(nextOccurrence(start, 'every 2 hours', start) - start, 2 * 60 * 60 * 1000);

const month = new Date(2026, 0, 31, 9, 0, 0).getTime();
assert.strictEqual(new Date(nextOccurrence(month, 'monthly', month)).getMonth(), 2, 'monthly recurrence follows calendar month semantics');
assert.strictEqual(nextOccurrence(start, 'daily', start + 3 * 24 * 60 * 60 * 1000) > start + 3 * 24 * 60 * 60 * 1000, true, 'missed occurrences are advanced without a notification burst');
console.log('ok - recurring reminder grammar and scheduler advancement');
