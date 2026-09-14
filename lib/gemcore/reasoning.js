'use strict';
/* ============================================================
   GemCore — Reasoning Pipeline (ported from AERA)
   ------------------------------------------------------------
   Explicit reasoning levels with trace logging: each inference
   records level, duration, and a compact trace so the user can
   see HOW Gem thought, not just what it concluded.
   ============================================================ */

const REASONING_LEVELS = {
  REFLEX: { id: 'reflex', label: 'Reflex', description: 'Instant response for greetings and known patterns.', maxDurationMs: 0 },
  HEURISTIC: { id: 'heuristic', label: 'Heuristic', description: 'Pattern-matched routing with tool selection.', maxDurationMs: 2000 },
  DELIBERATE: { id: 'deliberate', label: 'Deliberate', description: 'Multi-step reasoning over context and tool results.', maxDurationMs: 15000 },
  DEEP: { id: 'deep', label: 'Deep', description: 'Extended chain-of-thought for complex or high-stakes problems.', maxDurationMs: 60000 }
};

const REFLEX_PATTERNS = [
  /^(hi|hey|hello|yo|sup|namaste)\b/i,
  /^(thanks|thank you|thx|ty)\b/i,
  /^(bye|goodbye|good night|gn)\b/i,
  /^(ok|okay|cool|nice|great|awesome)\b.?$/,
  /^(yes|yeah|yep|no|nope|nah)\b.?$/,
  /^(what time|what.s the time)\b/i,
  /^(what.s the date|today.s date)\b/i
];

const DELIBERATE_TRIGGERS = [
  /\b(why|how come|explain|analy[sz]e|compare|difference between)\b/i,
  /\b(plan|design|architect|build|create|write|implement|refactor|debug)\b/i,
  /\b(step[- ]by[- ]step|walk me through|guide me)\b/i
];

const DEEP_TRIGGERS = [
  /\b(architect|architecture|trade[- ]?offs?|root cause|prove|derive|optimi[sz]e|strategy)\b/i,
  /\b(multi[- ]step|complex|complicated|intricate|end[- ]to[- ]end)\b/i,
  /\?[^?]*\?/ // multiple questions in one message
];

function classifyReasoningLevel(input, { toolCount = 0 } = {}) {
  const text = String(input || '').trim();
  if (!text) return REASONING_LEVELS.REFLEX;
  if (REFLEX_PATTERNS.some((pattern) => pattern.test(text)) && text.length < 40 && toolCount === 0) {
    return REASONING_LEVELS.REFLEX;
  }
  if (DEEP_TRIGGERS.some((pattern) => pattern.test(text)) || text.length > 1200) return REASONING_LEVELS.DEEP;
  if (DELIBERATE_TRIGGERS.some((pattern) => pattern.test(text)) || toolCount > 0 || text.length > 300) {
    return REASONING_LEVELS.DELIBERATE;
  }
  return REASONING_LEVELS.HEURISTIC;
}

/** Accumulates reasoning traces for the current session. */
class ReasoningTrace {
  constructor({ maxEntries = 200 } = {}) {
    this.entries = [];
    this.maxEntries = maxEntries;
    this.enabled = true;
  }

  record({ level, phase, detail, durationMs, meta }) {
    if (!this.enabled) return null;
    const entry = {
      at: Date.now(),
      level: level && level.id ? level.id : String(level || 'unknown'),
      phase: String(phase || '').slice(0, 80),
      detail: String(detail || '').slice(0, 1000),
      durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : undefined,
      ...(meta ? { meta } : {})
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return entry;
  }

  recent(limit = 20) {
    return this.entries.slice(-limit);
  }

  summary() {
    const counts = {};
    for (const entry of this.entries) counts[entry.level] = (counts[entry.level] || 0) + 1;
    return { total: this.entries.length, byLevel: counts };
  }

  clear() { this.entries = []; }
}

/** Build a chain-of-thought scaffold prompt for deliberate/deep levels. */
function reasoningScaffoldPrompt(level) {
  if (level === REASONING_LEVELS.DEEP) {
    return 'Work through this methodically: (1) restate the problem precisely, (2) enumerate the constraints and unknowns, (3) consider at least two approaches with trade-offs, (4) choose one and justify it, (5) execute it fully, (6) verify the result against the original goal. Keep each step tight.';
  }
  if (level === REASONING_LEVELS.DELIBERATE) {
    return 'Think this through step by step, then give the complete answer. If tools would help, use them.';
  }
  if (level === REASONING_LEVELS.HEURISTIC) {
    return 'Answer directly and concisely. Use a tool only if the answer genuinely requires live data.';
  }
  return null; // reflex: no scaffold
}

module.exports = { REASONING_LEVELS, classifyReasoningLevel, ReasoningTrace, reasoningScaffoldPrompt };
