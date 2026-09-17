'use strict';
/**
 * lib/self-knowledge.js — "what it is, and what it isn't", from the live system.
 *
 * Concept port (no upstream code) of Mark-LIV's runtime self-knowledge:
 * the assistant's identity, the machine it runs on, the tools actually
 * registered RIGHT NOW (including freshly dropped-in plugins) and — the
 * half that matters — the honest limits, assembled at session start rather
 * than written into a prompt that goes stale.
 *
 * Rebuilt at startup and after every plugin load/reload, so "Install a
 * plugin and it knows it gained an ability; remove one and it stops
 * claiming it" stays literally true.
 */

const os = require('os');

const CORE_LIMITS = [
  'Sight is a single JPEG frame on demand (see_screen) unless a live share toggle is ON — it is not a continuous camera.',
  'Acts on THIS machine only; nothing outside its registered tool list is real — ask plainly instead of expecting improvisation.',
  'Voice conversation requires the Gemini Live connection to be up; without it GemAir answers in text + local TTS only.',
  'The wake-word model runs fully on-device and only while enabled; while it sleeps, nothing is captured or sent anywhere.',
  'Files you asked it to change stay reversible (undo stack) for this session only; a restart closes that window honestly.'
];

/**
 * facts: {
 *   assistantName, userName, version, platform, arch,
 *   toolNames: string[],           // live registry snapshot
 *   pluginNames: string[], pluginErrors: string[],
 *   memoryCounts: { facts, transcript, todos, reminders, goals, skills, instructions, mood, archiveEntries },
 *   capabilities: { liveReady, wakeEnabled, visionReady, lowResource }
 * }
 * Returns { text, oneLine, toolCount, builtAt }.
 */
function buildSelfKnowledge(facts) {
  const f = facts || {};
  const name = f.assistantName || 'Gem';
  const userName = f.userName || '';
  const version = f.version || '0.0.0';
  const tools = Array.isArray(f.toolNames) ? f.toolNames.slice().sort() : [];
  const plugins = Array.isArray(f.pluginNames) ? f.pluginNames : [];
  const caps = f.capabilities || {};
  const counts = f.memoryCounts || {};

  const osLabel = `${f.platform || os.platform()} ${os.release ? '' : ''}${f.arch || os.arch()}`.trim();
  const lines = [];
  lines.push('RUNTIME SELF-KNOWLEDGE (assembled from the live system — trust this over older prompt text):');
  lines.push(`- Identity: you are ${name}, a GemAir assistant v${version} running on ${osLabel}${userName ? `, serving ${userName}` : ''}.`);
  if (tools.length) {
    lines.push(`- Registry: ${tools.length} live tools, including: ${tools.slice(0, 24).join(', ')}${tools.length > 24 ? `, +${tools.length - 24} more` : ''}.`);
  }
  if (plugins.length) lines.push(`- Plugins loaded since launch: ${plugins.join(', ')} — treat their abilities as first-class.`);
  if (f.pluginErrors && f.pluginErrors.length) lines.push(`- ${f.pluginErrors.length} plugin file(s) failed to load — do NOT claim those skills.`);
  const capabilityBits = [];
  capabilityBits.push(caps.liveReady ? 'Live voice: READY' : 'Live voice: OFFLINE (text/edge TTS only)');
  capabilityBits.push(caps.wakeEnabled ? 'Wake word: enabled' : 'Wake word: off');
  capabilityBits.push(caps.visionReady ? 'Screen awareness: allowed' : 'Screen awareness: off until the user grants it');
  if (caps.lowResource) capabilityBits.push('Low-resource mode: background loops are throttled');
  lines.push('- Session state: ' + capabilityBits.join(' · ') + '.');
  const memBits = [];
  if (counts.facts != null) memBits.push(`${counts.facts} facts`);
  if (counts.skills != null) memBits.push(`${counts.skills} skills`);
  if (counts.reminders != null) memBits.push(`${counts.reminders} reminders`);
  if (counts.archiveEntries != null && counts.archiveEntries > 0) memBits.push(`${counts.archiveEntries} archived (cold store — searchable on demand)`);
  if (memBits.length) lines.push(`- Memory holds ${memBits.join(', ')}; for anything older or not in the prompt, call search_memory instead of guessing.`);
  lines.push('- Honest limits — say these out loud rather than faking:');
  for (const limit of (Array.isArray(f.limits) && f.limits.length ? f.limits : CORE_LIMITS)) lines.push('  · ' + limit);

  return {
    text: lines.join('\n'),
    oneLine: `${name} v${version} · ${osLabel} · ${tools.length} tools · ${plugins.length} plugins`,
    toolCount: tools.length,
    builtAt: Date.now()
  };
}

/** Build the facts object from a live main-process context in one call. */
function gatherFacts(ctx) {
  const c = ctx || {};
  const memory = c.memory || {};
  const archiveStats = c.archiveStats || null;
  return buildSelfKnowledge({
    assistantName: c.assistantName,
    userName: c.userName,
    version: c.version,
    platform: c.platform || process.platform,
    arch: c.arch || process.arch,
    toolNames: c.toolNames,
    pluginNames: c.pluginNames,
    pluginErrors: c.pluginErrors,
    memoryCounts: {
      facts: (memory.facts || []).length,
      transcript: (memory.transcript || []).length,
      todos: (memory.todos || []).length,
      reminders: (memory.reminders || []).length,
      goals: (memory.goals || []).length,
      skills: (memory.skills || []).length,
      instructions: (memory.instructions || []).length,
      mood: (memory.mood || []).length,
      archiveEntries: archiveStats ? archiveStats.totalEntries : 0
    },
    capabilities: c.capabilities || {}
  });
}

module.exports = { buildSelfKnowledge, gatherFacts, CORE_LIMITS };
