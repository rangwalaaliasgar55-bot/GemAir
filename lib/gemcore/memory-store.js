'use strict';
/* ============================================================
   GemCore — Memory Store (ported from AERA)
   ------------------------------------------------------------
   Scoped persistent memory: every memory carries a scope —
   USER (cross-session preferences), TASK (per working session),
   or LONG_TERM (compressed durable knowledge). User scope is
   the default; nothing lands in LONG_TERM unless asked. All
   writes pass through secret redaction before hitting disk.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { redactForStorage } = require('./request-manager');

const MEMORY_SCOPES = {
  USER: { id: 'user', label: 'User preferences', description: 'What Gem should remember about you across sessions.', default: true },
  TASK: { id: 'task', label: 'Current task', description: 'Working memory for the active task; cleared with the task.', default: false },
  LONG_TERM: { id: 'long-term', label: 'Long-term knowledge', description: 'Durable knowledge, added only when you ask.', default: false }
};

const MAX_MEMORIES_PER_SCOPE = 300;
const MAX_MEMORY_CHARS = 4000;

class MemoryStore {
  constructor(userDataPath) {
    this.storePath = path.join(userDataPath, 'gemcore', 'memory.json');
    this.memories = { user: [], task: [], 'long-term': [] };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        this.memories = {
          user: Array.isArray(parsed.user) ? parsed.user : [],
          task: Array.isArray(parsed.task) ? parsed.task : [],
          'long-term': Array.isArray(parsed['long-term']) ? parsed['long-term'] : []
        };
      }
    } catch { this.memories = { user: [], task: [], 'long-term': [] }; }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.memories, null, 2));
    } catch { /* storage failures must not break chat */ }
  }

  _validateScope(scope) {
    const id = String(scope || '').toLowerCase();
    if (id === 'user' || id === 'task' || id === 'long-term') return id;
    throw new Error('Unknown memory scope. Use "user", "task", or "long-term".');
  }

  /** Store a memory; returns the stored record (post-redaction). */
  remember(content, { scope = 'user', key = null, source = 'user', importance = 1 } = {}) {
    const scopeId = this._validateScope(scope);
    const redacted = redactForStorage(String(content || '').trim());
    const text = redacted.text.slice(0, MAX_MEMORY_CHARS);
    if (!text) throw new Error('Memory content is empty.');

    if (key) {
      const existing = this.memories[scopeId].find((memory) => memory.key === key);
      if (existing) {
        existing.content = text;
        existing.updatedAt = Date.now();
        existing.importance = Number.isFinite(importance) ? importance : existing.importance;
        this._persist();
        return { ...existing, redacted: redacted.redacted };
      }
    }

    // Deduplication: identical content in scope updates instead of duplicating.
    const duplicate = this.memories[scopeId].find((memory) => memory.content === text);
    if (duplicate) {
      duplicate.updatedAt = Date.now();
      duplicate.hitCount = (duplicate.hitCount || 0) + 1;
      this._persist();
      return { ...duplicate, redacted: redacted.redacted, duplicate: true };
    }

    const record = {
      id: 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      key: key || null,
      content: text,
      scope: scopeId,
      source: String(source || 'user').slice(0, 60),
      importance: Math.max(1, Math.min(5, Number(importance) || 1)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hitCount: 0
    };
    this.memories[scopeId].push(record);
    if (this.memories[scopeId].length > MAX_MEMORIES_PER_SCOPE) {
      // Evict least important, least recently used first.
      this.memories[scopeId].sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt));
      this.memories[scopeId] = this.memories[scopeId].slice(0, MAX_MEMORIES_PER_SCOPE);
    }
    this._persist();
    return { ...record, redacted: redacted.redacted };
  }

  recall(query, { scope = null, limit = 10 } = {}) {
    const scopes = scope ? [this._validateScope(scope)] : ['user', 'task', 'long-term'];
    const terms = String(query || '').toLowerCase().split(/\W+/).filter((term) => term.length > 2);
    const scored = [];
    for (const scopeId of scopes) {
      for (const memory of this.memories[scopeId]) {
        const haystack = (memory.content + ' ' + (memory.key || '')).toLowerCase();
        let hits = 0;
        for (const term of terms) if (haystack.includes(term)) hits += 1;
        if (terms.length > 0 && hits === 0) continue; // relevance floor: term queries must match
        let score = memory.importance + hits * 3;
        if (terms.length === 0) score += (memory.updatedAt > Date.now() - 86400000 ? 2 : 0);
        scored.push({ memory, score });
      }
    }
    scored.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
    return scored.slice(0, limit).map((entry) => entry.memory);
  }

  /** Memory injection prompt for the model. */
  contextBlock(query, { limit = 8 } = {}) {
    const recalled = this.recall(query, { limit });
    if (recalled.length === 0) return '';
    const lines = recalled.map((memory) => '- [' + memory.scope + '] ' + memory.content);
    return '## What Gem remembers (retrieved for this message)\n' + lines.join('\n');
  }

  forget(memoryId) {
    for (const scopeId of ['user', 'task', 'long-term']) {
      const before = this.memories[scopeId].length;
      this.memories[scopeId] = this.memories[scopeId].filter((memory) => memory.id !== memoryId);
      if (this.memories[scopeId].length !== before) { this._persist(); return { forgotten: true, memoryId }; }
    }
    return { forgotten: false, memoryId };
  }

  clearScope(scope) {
    const scopeId = this._validateScope(scope);
    const count = this.memories[scopeId].length;
    this.memories[scopeId] = [];
    this._persist();
    return { cleared: count, scope: scopeId };
  }

  list(scope = null) {
    const scopes = scope ? [this._validateScope(scope)] : ['user', 'task', 'long-term'];
    const out = {};
    for (const scopeId of scopes) {
      out[scopeId] = this.memories[scopeId]
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((memory) => ({ ...memory }));
    }
    return out;
  }

  stats() {
    const stats = {};
    for (const scopeId of ['user', 'task', 'long-term']) {
      stats[scopeId] = { count: this.memories[scopeId].length };
    }
    return stats;
  }
}

module.exports = { MemoryStore, MEMORY_SCOPES };
