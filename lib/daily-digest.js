'use strict';

// Local-first morning digest. This module deliberately does not fetch data or
// call a model: the main process supplies optional headlines/weather/monitor
// results, while reminders, tasks, goals and mood stay on the user's device.

function asTime(value) {
  const time = Number(value);
  return Number.isFinite(time) ? time : 0;
}

function isDone(item) {
  return item && (item.done === true || item.completed === true || item.status === 'done');
}

function cleanText(value, fallback = '') {
  return String(value == null ? fallback : value).replace(/\s+/g, ' ').trim().slice(0, 280);
}

function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(timestamp, locale = undefined) {
  const date = new Date(asTime(timestamp));
  if (!asTime(timestamp) || Number.isNaN(date.getTime())) return 'unscheduled';
  try { return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date); } catch { return date.toLocaleTimeString(); }
}

function buildDailyDigest(memory = {}, options = {}) {
  const now = asTime(options.now) || Date.now();
  const nextDay = now + 24 * 60 * 60 * 1000;
  const reminders = Array.isArray(memory.reminders) ? memory.reminders : [];
  const todos = Array.isArray(memory.todos) ? memory.todos : [];
  const goals = Array.isArray(memory.goals) ? memory.goals : [];
  const mood = Array.isArray(memory.mood) ? memory.mood : [];
  const monitors = Array.isArray(memory.monitors) ? memory.monitors : [];

  const upcoming = reminders
    .filter((item) => !isDone(item) && asTime(item.at) >= now && asTime(item.at) <= nextDay)
    .sort((a, b) => asTime(a.at) - asTime(b.at))
    .slice(0, 8)
    .map((item) => ({ id: item.id || null, text: cleanText(item.text, 'Reminder'), at: asTime(item.at), time: formatTime(item.at) }));
  const openTodos = todos
    .filter((item) => !isDone(item))
    .slice(0, 8)
    .map((item) => ({ id: item.id || null, text: cleanText(item.text || item.title, 'Task') }));
  const activeGoals = goals
    .filter((item) => !isDone(item))
    .slice(0, 6)
    .map((item) => ({ id: item.id || null, text: cleanText(item.text || item.title, 'Goal'), category: cleanText(item.category, '') }));
  const latestMood = mood.length ? mood[mood.length - 1] : null;
  const headlines = (Array.isArray(options.headlines) ? options.headlines : [])
    .filter((item) => item && item.title)
    .slice(0, 6)
    .map((item) => ({ title: cleanText(item.title), url: item.url || null, source: cleanText(item.by || item.source, 'News') }));
  const monitorAlerts = (Array.isArray(options.monitorAlerts) ? options.monitorAlerts : [])
    .filter((item) => item && item.title)
    .slice(0, 8)
    .map((item) => ({ topic: cleanText(item.topic, 'Monitored topic'), title: cleanText(item.title), url: item.url || null, source: cleanText(item.source, '') }));

  const lines = [];
  lines.push(`Good morning${options.name ? `, ${cleanText(options.name, 'there')}` : ''}.`);
  if (options.weather && options.weather.city) {
    lines.push(`Weather in ${cleanText(options.weather.city)}: ${cleanText(options.weather.condition, 'current conditions')}, ${options.weather.temperature ?? '—'}°C.`);
  }
  if (upcoming.length) lines.push(`${upcoming.length} reminder${upcoming.length === 1 ? '' : 's'} in the next 24 hours.`);
  else lines.push('No reminders are due in the next 24 hours.');
  if (openTodos.length) lines.push(`${openTodos.length} open task${openTodos.length === 1 ? '' : 's'} in your local list.`);
  if (activeGoals.length) lines.push(`Keep one small step moving on: ${activeGoals[0].text}.`);
  if (latestMood && (latestMood.emotion || latestMood.label)) lines.push(`Last check-in: ${cleanText(latestMood.emotion || latestMood.label)}.`);
  if (monitorAlerts.length) lines.push(`${monitorAlerts.length} monitored topic${monitorAlerts.length === 1 ? '' : 's'} changed.`);

  return {
    ok: true,
    kind: 'daily-digest',
    day: dayKey(new Date(now)),
    generatedAt: new Date(now).toISOString(),
    title: 'Daily Digest',
    summary: lines.join(' '),
    sections: {
      weather: options.weather || null,
      reminders: upcoming,
      todos: openTodos,
      goals: activeGoals,
      mood: latestMood ? { emotion: cleanText(latestMood.emotion || latestMood.label), note: cleanText(latestMood.note) } : null,
      monitored: monitorAlerts,
      headlines
    },
    sources: {
      localMemory: true,
      headlines: headlines.length > 0,
      weather: !!(options.weather && options.weather.city),
      monitored: monitorAlerts.length > 0,
      monitoredTopics: monitors.length
    }
  };
}

module.exports = { buildDailyDigest, dayKey, formatTime };
