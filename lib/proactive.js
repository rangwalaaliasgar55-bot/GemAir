'use strict';
/* ============================================================
   GemAir — proactive check-in engine.
   ------------------------------------------------------------
   Concept shaped by Mark's "Proactive 2.0" (time-aware,
   context-aware check-ins and "Session Memory" that summarizes
   each conversation and brings it up the next day, consumed
   once, never repeated). Reimplemented for GemAir's memory
   model — no upstream code.

   Two surfaces, both pure functions over the memory file:

     1. sessionSummaryFor(memory)  — called at session end (app
        quit / window close). Distills the tail of the transcript
        into topic lines so tomorrow's greeting can recall them.

     2. buildGreeting({ now, memory, profile }) — called once per
        launch. Time-of-day aware, project/reminder/monitor aware,
        and — when a previous-session summary exists and has not
        been consumed — folds it in naturally and then marks it
        consumed, so it is said exactly once, Mark-style.

     3. buildCheckIn({ now, memory, profile, lastCheckInAt }) — an
        optional idle nudge for long-running sessions. Rotation-
        aware: never repeats the same angle twice in a row, and
        rate-limited (default: at most every 3 hours, quiet at
        night). Opt-in via profile.proactiveCheckIns.
   ============================================================ */

const CHECKIN_MIN_GAP_MS = 3 * 60 * 60 * 1000;
const QUIET_HOUR_START = 22; // 10pm
const QUIET_HOUR_END = 7;    // 7am
const MAX_TOPIC_SCAN = 30;

function safeMemory(memory) {
  return (memory && typeof memory === 'object') ? memory : {};
}

function timeOfDayGreeting(date, name) {
  const hour = date.getHours();
  const who = name ? `, ${name}` : '';
  if (hour >= 5 && hour < 12) return `Good morning${who}`;
  if (hour >= 12 && hour < 17) return `Good afternoon${who}`;
  if (hour >= 17 && hour < 22) return `Good evening${who}`;
  return `Still up${who}`;
}

/** Pull distinctive user-topic phrases out of recent user turns. */
function extractTopics(memory, { limit = 3 } = {}) {
  const m = safeMemory(memory);
  const transcript = Array.isArray(m.transcript) ? m.transcript : [];
  const seen = new Set();
  const topics = [];
  for (let i = transcript.length - 1; i >= 0 && topics.length < MAX_TOPIC_SCAN; i--) {
    const turn = transcript[i];
    if (!turn || turn.role !== 'user') continue;
    let text = String(turn.content || '').replace(/\s+/g, ' ').trim();
    if (text.length < 4) continue;
    if (text.length > 80) text = text.slice(0, 77).replace(/\s+\S*$/, '') + '…';
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Drop bare greetings/acknowledgments — they make empty-sounding recaps.
    if (/^(hi|hello|hey|ok|okay|thanks|thank you|yes|no|sure)\b/i.test(text) && text.split(' ').length < 5) continue;
    topics.push(text);
    if (topics.length >= limit) break;
  }
  return topics;
}

/**
 * Distill the tail of the conversation into a "last session" record that
 * the next launch can recall. Called at session end. Mutates `memory` —
 * returns the record written, or null when nothing worth recalling.
 */
function recordSessionSummary(memory, { now = Date.now(), limit = 3 } = {}) {
  const m = safeMemory(memory);
  const topics = extractTopics(m, { limit });
  if (!topics.length) return null;
  const record = {
    endedAt: now,
    topics,
    consumed: false
  };
  m.lastSession = record;
  return record;
}

function pendingReminders(memory, now) {
  const m = safeMemory(memory);
  const reminders = Array.isArray(m.reminders) ? m.reminders : [];
  return reminders
    .filter((r) => r && !r.done && Number(r.at) > 0 && Number(r.at) <= now + 24 * 60 * 60 * 1000)
    .sort((a, b) => a.at - b.at);
}

function sentenceJoin(parts) {
  const list = parts.filter(Boolean);
  if (list.length < 2) return list.join(' ');
  return list.slice(0, -1).join(', ') + (list.length > 2 ? ',' : '') + ' and ' + list[list.length - 1];
}

function capitalize(text) {
  const s = String(text || '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The once-per-launch proactive greeting. Consumes the previous-session
 * summary (marks it `consumed` inside `memory` — caller persists).
 * Returns { text, consumedSession, pendingReminderCount } or null when
 * there is genuinely nothing to say.
 */
function buildGreeting({ now = Date.now(), memory, profile } = {}) {
  const m = safeMemory(memory);
  const p = profile && typeof profile === 'object' ? profile : {};
  const date = new Date(now);
  const parts = [];
  let consumedSession = false;

  if (m.lastSession && m.lastSession.consumed === false && Array.isArray(m.lastSession.topics) && m.lastSession.topics.length) {
    const when = new Date(Number(m.lastSession.endedAt) || now);
    const sameDay = when.toDateString() === date.toDateString();
    const label = sameDay ? 'earlier' : 'last time we talked';
    const topics = m.lastSession.topics.slice(0, 3);
    const recap = topics.length === 1
      ? `we were looking at “${topics[0]}”`
      : `we were working on ${sentenceJoin(topics.map((t) => `“${t}”`))}`;
    parts.push(`${capitalize(label)} ${recap} — happy to pick that back up where we left off`);
    m.lastSession.consumed = true;
    consumedSession = true;
  }

  const upcoming = pendingReminders(m, now);
  if (upcoming.length) {
    const next = upcoming[0];
    const at = new Date(Number(next.at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    parts.push(upcoming.length === 1
      ? `you have a reminder coming up at ${at} (“${String(next.text || '').slice(0, 60)}”)`
      : `you have ${upcoming.length} reminders in the next day — the next one is at ${at} (“${String(next.text || '').slice(0, 60)}”)`);
  }

  const monitors = Array.isArray(m.monitors) ? m.monitors : [];
  const fresh = monitors.filter((mon) => mon && mon.lastHeadline && mon.alertPending === true);
  if (fresh.length) {
    parts.push(fresh.length === 1
      ? `your “${String(fresh[0].topic).slice(0, 40)}” monitor found something new`
      : `${fresh.length} of your topic monitors found something new`);
  }

  const watchGoals = (Array.isArray(m.goals) ? m.goals : []).filter((g) => g && !g.done);
  if (watchGoals.length && date.getHours() >= 5 && date.getHours() < 12 && Math.random() < 0.5) {
    parts.push(`still rooting for “${String(watchGoals[0].text || '').slice(0, 60)}”`);
  }

  if (!parts.length && !consumedSession) return null;
  const head = timeOfDayGreeting(date, String(p.name || '').trim());
  const keep = parts.slice(0, 3);
  return {
    text: `${head}! ${sentenceJoin(keep)}.`,
    consumedSession,
    pendingReminderCount: upcoming.length
  };
}

/**
 * Idle check-in for long-running sessions (opt-in). Rotation-aware: the
 * angle chosen is never the same as the previous one, and nothing is
 * said at night or more often than every 3 hours. Returns null when the
 * moment does not deserve an interruption.
 */
function buildCheckIn({ now = Date.now(), memory, profile, state } = {}) {
  const m = safeMemory(memory);
  const p = profile && typeof profile === 'object' ? profile : {};
  if (p.proactiveCheckIns !== true) return null;
  const date = new Date(now);
  const hour = date.getHours();
  if (hour >= QUIET_HOUR_START || hour < QUIET_HOUR_END) return null;

  const s = (state && typeof state === 'object') ? state : {};
  const lastAt = Number(s.lastCheckInAt) || 0;
  if (now - lastAt < CHECKIN_MIN_GAP_MS) return null;

  const angles = [];
  const upcoming = pendingReminders(m, now).filter((r) => Number(r.at) > now);
  if (upcoming.length) {
    const next = upcoming[0];
    angles.push({ id: 'reminder', text: `Heads up — “${String(next.text || '').slice(0, 60)}” is due at ${new Date(Number(next.at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` });
  }
  const todos = (Array.isArray(m.todos) ? m.todos : []).filter((t) => t && !t.done);
  if (todos.length) angles.push({ id: 'todos', text: `You still have ${todos.length} open to-do${todos.length === 1 ? '' : 's'} — the first is “${String(todos[0].text || '').slice(0, 60)}”.` });
  const goals = (Array.isArray(m.goals) ? m.goals : []).filter((g) => g && !g.done);
  if (goals.length) angles.push({ id: 'goal', text: `Small step for “${String(goals[0].text || '').slice(0, 60)}”?` });
  angles.push({ id: 'ambient', text: `${timeOfDayGreeting(date, '')}! Anything you'd like to hand to me?` });

  let pick = angles.find((a) => a.id !== s.lastAngle) || angles[0];
  if (s.lastAngle && angles.length > 1 && pick.id === s.lastAngle) {
    pick = angles[(angles.findIndex((a) => a.id === pick.id) + 1) % angles.length];
  }
  return { text: pick.text, angle: pick.id };
}

module.exports = {
  buildGreeting, buildCheckIn, recordSessionSummary, extractTopics,
  CHECKIN_MIN_GAP_MS, QUIET_HOUR_START, QUIET_HOUR_END
};
