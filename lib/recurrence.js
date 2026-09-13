'use strict';

// Small, dependency-free recurrence contract shared by the Electron scheduler
// and its tests. Values are deliberately human-readable in persisted memory so
// an exported GemAir profile remains understandable and forward-compatible.
const UNIT_ALIASES = new Map([
  ['minute', 'minutes'], ['minutes', 'minutes'], ['min', 'minutes'], ['mins', 'minutes'], ['m', 'minutes'],
  ['hour', 'hours'], ['hours', 'hours'], ['hr', 'hours'], ['hrs', 'hours'], ['h', 'hours'],
  ['day', 'days'], ['days', 'days'], ['d', 'days'],
  ['week', 'weeks'], ['weeks', 'weeks'], ['w', 'weeks'],
  ['month', 'months'], ['months', 'months'],
]);

function normalizeRecurrence(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;
  if (['daily', 'every day', 'day'].includes(raw)) return { kind: 'interval', amount: 1, unit: 'days', label: 'daily' };
  if (['weekdays', 'every weekday', 'weekdays only'].includes(raw)) return { kind: 'weekdays', amount: 1, unit: 'days', label: 'weekdays' };
  if (['weekly', 'every week', 'week'].includes(raw)) return { kind: 'interval', amount: 1, unit: 'weeks', label: 'weekly' };
  if (['monthly', 'every month', 'month'].includes(raw)) return { kind: 'interval', amount: 1, unit: 'months', label: 'monthly' };
  if (['hourly', 'every hour'].includes(raw)) return { kind: 'interval', amount: 1, unit: 'hours', label: 'hourly' };

  const match = raw.match(/^every\s+(\d+)\s+([a-z]+)$/);
  if (!match) return null;
  const amount = Math.max(1, Math.min(365, Number(match[1])));
  const unit = UNIT_ALIASES.get(match[2]);
  if (!unit) return null;
  return { kind: 'interval', amount, unit, label: `every ${amount} ${unit}` };
}

function nextOccurrence(at, recurrence, now = Date.now()) {
  const rule = typeof recurrence === 'string' ? normalizeRecurrence(recurrence) : recurrence;
  const start = Number(at);
  if (!rule || !Number.isFinite(start)) return null;
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  let next = start;
  if (rule.kind === 'weekdays') {
    do next += 24 * 60 * 60 * 1000;
    while ([0, 6].includes(new Date(next).getDay()));
  } else if (rule.unit === 'months') {
    const date = new Date(next);
    date.setMonth(date.getMonth() + rule.amount);
    next = date.getTime();
  } else {
    const multiplier = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000 }[rule.unit];
    next += rule.amount * multiplier;
  }
  // If GemAir was closed for several periods, advance to the next future
  // occurrence instead of firing a burst of stale notifications on launch.
  let guard = 0;
  while (next <= current && guard++ < 1000) {
    next = nextOccurrence(next, rule, current);
    if (!next) return null;
  }
  return next;
}

module.exports = { normalizeRecurrence, nextOccurrence };
