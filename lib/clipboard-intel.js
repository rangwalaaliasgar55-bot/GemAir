'use strict';
/**
 * lib/clipboard-intel.js — clipboard intelligence, local-first.
 *
 * Concept port (no upstream code) of Mark-LIV's clipboard intelligence:
 * copy any text → a floating panel offers Translate / Summarise / Explain /
 * Fix. Ours adds the GemAir-parity guarantees:
 *
 *  - OPT-IN: nothing is read until the user enables it in Settings; the poll
 *    loop only exists while enabled and the window is alive.
 *  - Secret-aware: entries that look like API keys/tokens/passwords are
 *    redacted at rest (lib/privacy-redaction) BEFORE they hit memory, the
 *    archive, the model, or the island panel.
 *  - Never silently forgotten: the ring is small; evicted entries go to the
 *    memory archive, same rule as every other capped collection.
 *
 * The class is transport-pure: inject readText() (Electron clipboard in
 * main, a stub in tests) and it never imports electron itself.
 */

const { redactSensitiveText } = require('./privacy-redaction.js');

const MAX_ENTRIES = 30;
const MAX_TEXT = 4000;       // chars kept per entry
const PANEL_MIN_CHARS = 3;   // shorter copies aren't worth a floating panel
const PANEL_MAX_CHARS = 3000;

const SECRET_CATEGORIES = new Set(['secret', 'bearer', 'jwt']); // key/token material only — an email in a copied paragraph must NOT kill the panel
function looksSecret(text) {
  try {
    const r = redactSensitiveText(text);
    return !!(r && r.redacted && (r.categories || []).some((c) => SECRET_CATEGORIES.has(c)));
  } catch { return false; }
}
function redactForStorage(text) {
  try {
    const r = redactSensitiveText(text);
    return r && typeof r.text === 'string' ? r.text : String(text || '');
  } catch { return String(text || ''); }
}

function classify(text) {
  const t = String(text || '');
  if (/^https?:\/\/\S+$/i.test(t.trim())) return 'url';
  if (looksSecret(t)) return 'secret';
  if (t.length > 800) return 'long';
  return 'text';
}

class ClipboardIntel {
  constructor(opts = {}) {
    this._readText = opts.readText || (() => '');
    this._archive = opts.archive || null;   // memoryArchive (optional)
    this._onEvent = opts.onEvent || null;   // ({type, entry}) => void
    this._max = Math.max(5, opts.maxEntries || MAX_ENTRIES);
    this._entries = [];        // newest last: { id, text(redacted), preview, kind, chars, ts, seen }
    this._lastRaw = null;      // last raw clipboard text (for change detection only)
    this._nextId = 1;
    this.enabled = false;
    this._dropped = 0;         // evicted/ignored counter for stats honesty
  }

  setEnabled(on) { this.enabled = !!on; if (!on) { this._lastRaw = null; } return this.enabled; }

  /**
   * One poll tick (main drives this on an interval while enabled).
   * Returns the new entry or null.
   */
  tick() {
    if (!this.enabled) return null;
    let raw;
    try { raw = this._readText(); } catch { return null; }
    if (typeof raw !== 'string') return null;
    raw = raw.trim();
    if (!raw || raw === this._lastRaw) return null;
    this._lastRaw = raw;
    if (raw.length < PANEL_MIN_CHARS) return null; // ignore single-word churn
    const kind = classify(raw);
    const stored = kind === 'secret' ? redactForStorage(raw).slice(0, MAX_TEXT) : raw.slice(0, MAX_TEXT);
    const entry = {
      id: this._nextId++,
      text: stored,
      preview: stored.replace(/\s+/g, ' ').slice(0, 140),
      kind,
      chars: raw.length,
      ts: Date.now(),
      seen: false
    };
    this._entries.push(entry);
    let evicted = null;
    while (this._entries.length > this._max) {
      evicted = this._entries.shift(); this._dropped++;
      if (this._archive) {
        try {
          this._archive.append('clipboardHistory', [{
            text: evicted.text, kind: evicted.kind, chars: evicted.chars, ts: evicted.ts,
            note: 'evicted from the live clipboard ring'
          }], { reason: 'clipboard-evict' });
        } catch {}
      }
    }
    const showPanel = kind !== 'secret' && entry.chars <= PANEL_MAX_CHARS;
    if (this._onEvent) {
      try { this._onEvent({ type: 'new', entry: this._public(entry), showPanel }); } catch {}
      if (kind === 'secret') {
        try { this._onEvent({ type: 'secret', entry: this._public(entry) }); } catch {}
      }
    }
    return entry;
  }

  _public(entry) {
    return { id: entry.id, preview: entry.preview, kind: entry.kind, chars: entry.chars, ts: entry.ts, seen: entry.seen };
  }

  /** Newest-first previews for the model/UI (no full text — recall by id). */
  history() { return this._entries.slice().reverse().map((entry) => this._public(entry)); }

  /** Full (redaction-preserving) text of one entry; marks it seen. */
  recall(id) {
    const entry = this._entries.find((e) => e.id === Number(id));
    if (!entry) return { error: 'No clipboard entry ' + id + ' (aged out or never captured).' };
    entry.seen = true;
    return { id: entry.id, text: entry.text, kind: entry.kind, chars: entry.chars, ts: entry.ts };
  }

  clear() { this._entries.length = 0; this._lastRaw = null; }

  stats() {
    return { enabled: this.enabled, entries: this._entries.length, evicted: this._dropped, max: this._max };
  }
}

module.exports = { ClipboardIntel, classify, looksSecret, MAX_ENTRIES, PANEL_MAX_CHARS };
