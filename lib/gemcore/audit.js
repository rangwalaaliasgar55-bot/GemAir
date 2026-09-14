'use strict';
/* ============================================================
   GemCore — Audit Log (ported from AERA)
   ------------------------------------------------------------
   Tamper-evident local audit trail for actions and tool calls:
   append-only, hash-chained records with automatic hygiene
   (prune + re-tighten the chain) when the log grows.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 5000;
const PRUNE_TO = 3000;

function hashEntry(entry) {
  return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16);
}

class AuditLog {
  constructor(userDataPath) {
    this.logPath = path.join(userDataPath, 'gemcore', 'audit.json');
    this.entries = [];
    this.silent = false;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.logPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
        this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      }
    } catch { this.entries = []; }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.writeFileSync(this.logPath, JSON.stringify({ version: 1, entries: this.entries }, null, 2));
    } catch { /* audit persistence is best-effort */ }
  }

  /** Append an audit record. Every record links to the previous hash. */
  append(record) {
    if (this.silent) return null;
    const entry = {
      id: 'aud-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      at: Date.now(),
      kind: String(record && record.kind || 'action').slice(0, 40),
      ...(record && record.tool ? { tool: String(record.tool).slice(0, 60) } : {}),
      ...(record && record.tier ? { tier: record.tier } : {}),
      ...(record && record.source ? { source: String(record.source).slice(0, 60) } : {}),
      ...(record && record.outcome ? { outcome: String(record.outcome).slice(0, 40) } : {}),
      ...(record && record.detail ? { detail: String(record.detail).slice(0, 400) } : {}),
      ...(record && record.error ? { error: String(record.error).slice(0, 300) } : {}),
      ...(record && record.args ? { args: record.args } : {})
    };
    const previous = this.entries.length > 0 ? this.entries[this.entries.length - 1].hash : null;
    const envelope = { ...entry, prev: previous };
    envelope.hash = hashEntry({ ...envelope, hash: null });
    this.entries.push(envelope);
    if (this.entries.length > MAX_ENTRIES) this.hygiene();
    else this._persist();
    return envelope;
  }

  /** Prune old entries and re-tighten the hash chain. */
  hygiene() {
    const pruned = Math.max(0, this.entries.length - PRUNE_TO);
    if (pruned > 0) this.entries = this.entries.slice(-PRUNE_TO);
    // Rebuild the chain over surviving entries.
    let previous = null;
    for (const entry of this.entries) {
      entry.prev = previous;
      const { hash, ...rest } = entry;
      entry.hash = hashEntry({ ...rest, hash: null });
      previous = entry.hash;
    }
    this._persist();
    return { pruned, remaining: this.entries.length };
  }

  /** Verify the chain is intact. */
  verify() {
    let previous = null;
    for (const entry of this.entries) {
      const { hash, ...rest } = entry;
      if (entry.prev !== previous) return { valid: false, brokenAt: entry.id, reason: 'prev-hash mismatch' };
      if (hashEntry({ ...rest, hash: null }) !== hash) return { valid: false, brokenAt: entry.id, reason: 'hash mismatch' };
      previous = hash;
    }
    return { valid: true, entries: this.entries.length };
  }

  recent(limit = 50, kind = null) {
    const filtered = kind ? this.entries.filter((entry) => entry.kind === kind) : this.entries;
    return filtered.slice(-limit).reverse().map((entry) => ({ ...entry }));
  }

  stats() {
    const byKind = {};
    for (const entry of this.entries) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    return { total: this.entries.length, byKind, chain: this.verify() };
  }

  clear() {
    this.entries = [];
    this._persist();
    return { cleared: true };
  }
}

module.exports = { AuditLog };
