'use strict';
/* Gem Air — tracking engine. Private, local activity timeline.
   Segments are merged when the subject stays the same, so a day is a compact list. */

const MAX_SEGMENTS_PER_DAY = 2000;
const RETENTION_DAYS = 120;

function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ensureDay(activity, key) {
  if (!activity.days[key]) activity.days[key] = { segments: [] };
  return activity.days[key];
}

/**
 * Record that `context` was in the foreground from the previous sample until `at`.
 * Idle is recorded as a segment with relevance 'idle'.
 */
function record(state, context, at = Date.now(), durationMs = 0) {
  if (!durationMs || durationMs < 0) return state;
  const key = dayKey(at);
  const day = ensureDay(state.activity, key);
  const segments = day.segments;
  const last = segments[segments.length - 1];
  const subject = context.relevance === 'idle' ? 'idle' : (context.subject || context.app || 'unknown');
  const sameSubject = last && last.subject === subject && last.categoryId === context.categoryId && last.relevance === context.relevance;
  if (sameSubject && at - (last.start + last.duration) <= 60_000) {
    last.duration = at - last.start;
  } else {
    segments.push({
      start: at - durationMs,
      duration: durationMs,
      subject,
      kind: context.kind || 'app',
      app: context.app || '',
      label: context.relevance === 'idle' ? 'Idle' : (context.kind === 'site' ? context.site : context.appLabel),
      categoryId: context.categoryId || 'other',
      relevance: context.relevance || 'neutral',
      blocked: !!context.blocked
    });
    if (segments.length > MAX_SEGMENTS_PER_DAY) segments.splice(0, segments.length - MAX_SEGMENTS_PER_DAY);
  }
  prune(state);
  return state;
}

function prune(state) {
  const keys = Object.keys(state.activity.days).sort();
  while (keys.length > RETENTION_DAYS) delete state.activity.days[keys.shift()];
}

/** Bucket a relevance into the four dashboard lanes. */
function lane(relevance) {
  if (relevance === 'idle') return 'idle';
  if (relevance === 'focus') return 'focus';
  if (relevance === 'distraction') return 'distraction';
  return 'other';
}

function summarize(state, key = dayKey(Date.now())) {
  const day = state.activity.days[key];
  const totals = { focus: 0, distraction: 0, other: 0, idle: 0 };
  const byCategory = {};
  const bySubject = {};
  if (day) {
    for (const s of day.segments) {
      totals[lane(s.relevance)] += s.duration;
      byCategory[s.categoryId] = (byCategory[s.categoryId] || 0) + s.duration;
      if (s.relevance !== 'idle') bySubject[s.label || s.subject] = (bySubject[s.label || s.subject] || 0) + s.duration;
    }
  }
  const tracked = totals.focus + totals.distraction + totals.other;
  const total = tracked + totals.idle;
  const pct = (v) => (total ? Math.round((v / total) * 1000) / 10 : 0);
  return {
    day: key,
    totals,
    tracked,
    total,
    percentages: { focus: pct(totals.focus), distraction: pct(totals.distraction), other: pct(totals.other), idle: pct(totals.idle) },
    byCategory,
    top: Object.entries(bySubject).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, ms]) => ({ label, ms }))
  };
}

/** Compact timeline for the dashboard bar: [{start, duration, lane, label}] */
function timeline(state, key = dayKey(Date.now())) {
  const day = state.activity.days[key];
  if (!day) return [];
  return day.segments.map((s) => ({ start: s.start, duration: s.duration, lane: lane(s.relevance), label: s.label || s.subject, categoryId: s.categoryId }));
}

function lastHour(state, now = Date.now()) {
  const cutoff = now - 3600_000;
  const out = { focus: 0, distraction: 0, other: 0, idle: 0 };
  for (const key of [dayKey(cutoff), dayKey(now)]) {
    const day = state.activity.days[key];
    if (!day) continue;
    for (const s of day.segments) {
      const end = s.start + s.duration;
      if (end <= cutoff) continue;
      out[lane(s.relevance)] += Math.min(end, now) - Math.max(s.start, cutoff);
    }
  }
  return out;
}

function trend(state, days = 7, now = Date.now()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(now - i * 86400_000);
    const s = summarize(state, key);
    out.push({ day: key, focus: s.totals.focus, distraction: s.totals.distraction, other: s.totals.other, idle: s.totals.idle });
  }
  return out;
}

function recent(state, limit = 20, now = Date.now()) {
  const items = [];
  for (const key of [dayKey(now - 86400_000), dayKey(now)]) {
    const day = state.activity.days[key];
    if (day) items.push(...day.segments);
  }
  return items.sort((a, b) => b.start - a.start).slice(0, limit);
}

module.exports = { dayKey, record, summarize, timeline, lastHour, trend, recent, lane, RETENTION_DAYS };
