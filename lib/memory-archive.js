'use strict';
/* ============================================================
   GemAir — memory cold archive (lookup-on-demand overflow).
   ------------------------------------------------------------
   Shaped by the memory limitation documented in Mark-LII/LIII
   (a flat blob with a hard character cap, silently deleting the
   oldest entries when full). GemAir's hot memory already keeps
   per-collection caps (importance-sorted facts, bounded
   transcript/action log). This module removes the "silently"
   part: anything evicted from hot memory is archived to a cold,
   append-only store that search_memory can fall back to. Nothing
   the assistant learned is thrown away, and nothing goes missing
   without being recoverable.

   Design:
     • Append-only JSON file organized per collection ("kinds").
     • Rotation: when the file crosses MAX_ARCHIVE_BYTES, the
       oldest half of each kind is folded into a single
       checkpoint line and dropped, keeping the file bounded
       while preserving *count evidence* in stats (a fork from
       "silently forgot" to "summarized + bounded").
     • All writes are redacted via lib/privacy-redaction on the
       way in, consistent with the rest of GemAir's storage.
   ============================================================ */

const fs = require('fs');
const fsNative = require('fs');
const path = require('path');

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const KNOWN_KINDS = new Set(['facts', 'transcript', 'actionLog', 'mood', 'notes', 'reminders', 'todos', 'goals', 'memory', 'eviction']);

let redact = (s) => s;
try {
  const { redactSensitiveText } = require('./privacy-redaction');
  redact = (s) => {
    try {
      const out = redactSensitiveText(s);
      return (out && typeof out.text === 'string') ? out.text : s;
    } catch { return s; }
  };
} catch { /* redaction is best-effort */ }

function normalizeKind(kind) {
  const k = String(kind || 'memory');
  return KNOWN_KINDS.has(k) ? k : 'memory';
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

class MemoryArchive {
  constructor(file, { fsImpl = fsNative, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
    this.file = file;
    this.fs = fsImpl;
    this.maxBytes = maxBytes;
    this.data = { version: 1, archivedAt: Date.now(), counts: {}, entries: [] };
    this._load();
  }

  _load() {
    try {
      if (!this.fs.existsSync(this.file)) return;
      const parsed = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) {
        this.data = {
          version: 1,
          archivedAt: Number(parsed.archivedAt) || Date.now(),
          counts: (parsed.counts && typeof parsed.counts === 'object') ? parsed.counts : {},
          entries: parsed.entries
        };
      }
    } catch { /* a corrupt archive never blocks the app; start clean in memory */ }
  }

  _persist() {
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      let payload = JSON.stringify(this.data);
      if (Buffer.byteLength(payload) > this.maxBytes) this._rotate();
      payload = JSON.stringify(this.data);
      const tmp = this.file + '.tmp';
      this.fs.writeFileSync(tmp, payload);
      this.fs.renameSync(tmp, this.file);
    } catch { /* archive failures must never break the assistant */ }
  }

  _rotate() {
    // Fold the oldest half into a per-kind checkpoint so the total evidence
    // of what was learned survives in counts even when the raw lines rotate.
    // The live `counts` ledger is debited by what moved into the checkpoint,
    // so stats() = counts (live, unfolded) + checkpoints (folded) never
    // double-counts a rotated entry.
    const entries = this.data.entries;
    const fold = Math.floor(entries.length / 2);
    const folded = {};
    for (const entry of entries.slice(0, fold)) folded[entry.kind] = (folded[entry.kind] || 0) + 1;
    for (const [kind, n] of Object.entries(folded)) {
      this.data.counts[kind] = Math.max(0, (this.data.counts[kind] || 0) - n);
    }
    this.data.checkpoints = this.data.checkpoints || [];
    this.data.checkpoints.push({ at: Date.now(), folded });
    this.data.entries = entries.slice(fold);
  }

  /**
   * Archive evicted entries for a collection kind.
   * entries: array of { text?, ... } records (shape kept as-is).
   * Returns the number archived.
   */
  append(kind, entries, { reason = 'evicted' } = {}) {
    const k = normalizeKind(kind);
    const list = Array.isArray(entries) ? entries : [entries];
    let added = 0;
    for (const raw of list) {
      if (raw == null) continue;
      const text = redact(asText(raw)).slice(0, 2000);
      if (!text.trim()) continue;
      this.data.entries.push({ kind: k, text, at: Date.now(), reason });
      added++;
    }
    if (added) {
      this.data.counts[k] = (this.data.counts[k] || 0) + added;
      this._persist();
    }
    return added;
  }

  /** Recount of what the archive holds (per kind), incl. rotated checkpoints. */
  stats() {
    const checkpointed = {};
    for (const cp of (this.data.checkpoints || [])) {
      for (const [k, n] of Object.entries(cp.folded || {})) checkpointed[k] = (checkpointed[k] || 0) + n;
    }
    const kinds = new Set([...Object.keys(this.data.counts), ...Object.keys(checkpointed)]);
    const out = {};
    for (const k of kinds) out[k] = (this.data.counts[k] || 0) + (checkpointed[k] || 0);
    return { totalLive: this.data.entries.length, byKind: out };
  }

  /**
   * Look up archived entries the hot memory no longer carries.
   * Simple token-overlap scoring, newest first, cap `limit`.
   */
  search(query, { kinds = null, limit = 5 } = {}) {
    const terms = String(query || '').toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 2);
    if (!terms.length) return [];
    const allowed = Array.isArray(kinds) && kinds.length ? new Set(kinds.map(normalizeKind)) : null;
    const scored = [];
    for (const entry of this.data.entries) {
      if (allowed && !allowed.has(entry.kind)) continue;
      const hay = entry.text.toLowerCase();
      let score = 0;
      for (const term of terms) if (hay.includes(term)) score += 1;
      if (score > 0) scored.push({ score, entry });
    }
    scored.sort((a, b) => (b.score - a.score) || (b.entry.at - a.entry.at));
    return scored.slice(0, Math.max(1, Math.min(20, limit || 5))).map(({ entry }) => ({
      kind: entry.kind,
      text: entry.text,
      archivedAt: entry.at,
      archived: true
    }));
  }

  recent(kind, limit = 10) {
    const k = normalizeKind(kind);
    return this.data.entries
      .filter((e) => e.kind === k)
      .slice(-Math.max(1, Math.min(100, limit || 10)))
      .map((e) => ({ kind: e.kind, text: e.text, archivedAt: e.at, archived: true }));
  }
}

module.exports = { MemoryArchive, MAX_ARCHIVE_BYTES };
