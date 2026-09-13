'use strict';
/* Gem Air — planning engine. Plans, focus periods, breaks, and Sleep windows.
   Pure time math so it can be unit-tested without a clock. */

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function fmt(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

/** True when `now` falls inside [start,end), handling windows that cross midnight. */
function inWindow(now, start, end) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return false;
  const t = minutesOfDay(now);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

/** Minutes remaining until the window closes (assumes inWindow is true). */
function minutesUntilEnd(now, end) {
  const e = toMinutes(end);
  if (e === null) return 0;
  const t = minutesOfDay(now);
  return e > t ? e - t : 1440 - t + e;
}

function dayActive(days, now) {
  if (!Array.isArray(days) || !days.length) return true;
  return days.includes(now.getDay());
}

function windowBounds(now, start, end) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return null;
  const begin = new Date(now);
  begin.setSeconds(0, 0);
  begin.setHours(Math.floor(s / 60), s % 60, 0, 0);
  const finish = new Date(begin);
  if (s <= e) {
    finish.setHours(Math.floor(e / 60), e % 60, 0, 0);
  } else {
    const afterMidnight = minutesOfDay(now) < e;
    if (afterMidnight) begin.setDate(begin.getDate() - 1);
    finish.setTime(begin.getTime());
    finish.setDate(finish.getDate() + 1);
    finish.setHours(Math.floor(e / 60), e % 60, 0, 0);
  }
  return { startMs: begin.getTime(), endMs: finish.getTime() };
}

/**
 * Which plan blocks are active right now.
 * A plan = { id, name, enabled, days:[0-6], blocks:[{start,end,kind:'focus'|'break',label}], rules:{...} }
 */
function activePlanBlocks(plans, now = new Date()) {
  const out = [];
  for (const plan of plans || []) {
    if (plan.enabled === false) continue;
    if (Number.isFinite(Number(plan.expiresAt)) && now.getTime() >= Number(plan.expiresAt)) continue;
    if (!dayActive(plan.days, now)) continue;
    for (const block of plan.blocks || []) {
      if (!inWindow(now, block.start, block.end)) continue;
      const bounds = windowBounds(now, block.start, block.end);
      out.push({
        planId: plan.id,
        planName: plan.name,
        kind: block.kind || 'focus',
        label: block.label || plan.name,
        start: block.start,
        end: block.end,
        startMs: bounds ? bounds.startMs : null,
        endMs: bounds ? bounds.endMs : null,
        endsInMinutes: minutesUntilEnd(now, block.end),
        rules: plan.rules || {}
      });
    }
  }
  return out;
}

function sleepStatus(sleep, now = new Date()) {
  if (!sleep || !sleep.enabled) return { active: false };
  if (!dayActive(sleep.days, now) && !inWindow(now, sleep.start, sleep.end)) return { active: false };
  const active = inWindow(now, sleep.start, sleep.end);
  return {
    active,
    start: sleep.start,
    end: sleep.end,
    endsInMinutes: active ? minutesUntilEnd(now, sleep.end) : null
  };
}

/** The next scheduled thing (plan block or sleep) after `now`, for the island's "up next". */
function nextEvent(state, now = new Date()) {
  const t = minutesOfDay(now);
  const candidates = [];
  for (const plan of state.plans || []) {
    if (plan.enabled === false) continue;
    if (Number.isFinite(Number(plan.expiresAt)) && now.getTime() >= Number(plan.expiresAt)) continue;
    for (const block of plan.blocks || []) {
      const s = toMinutes(block.start);
      if (s === null) continue;
      const delta = s >= t ? s - t : 1440 - t + s;
      const startsToday = s >= t;
      if (startsToday && !dayActive(plan.days, now)) continue;
      candidates.push({ in: delta, label: block.label || plan.name, at: block.start, kind: block.kind || 'focus' });
    }
  }
  if (state.sleep && state.sleep.enabled) {
    const s = toMinutes(state.sleep.start);
    if (s !== null) {
      const delta = s >= t ? s - t : 1440 - t + s;
      candidates.push({ in: delta, label: 'Sleep', at: state.sleep.start, kind: 'sleep' });
    }
  }
  candidates.sort((a, b) => a.in - b.in);
  return candidates[0] || null;
}

module.exports = { toMinutes, minutesOfDay, fmt, inWindow, minutesUntilEnd, windowBounds, activePlanBlocks, sleepStatus, nextEvent };
