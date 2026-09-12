'use strict';
/* Gem Air — persistent attention state. Atomic writes via the existing store helper. */

const path = require('path');
const { readJsonRecovering, writeJsonAtomic } = require('../atomic-store');
const { hydrate, defaultState } = require('./core/schema');

const MAX_BYTES = 12 * 1024 * 1024;

class AttentionStore {
  constructor(file) {
    this.file = file;
    this.state = hydrate(readJsonRecovering(file, { maxBytes: MAX_BYTES }) || null);
    this._dirty = false;
    this._timer = null;
  }

  get() { return this.state; }

  /** Mutate then persist (debounced — the tracker writes every few seconds). */
  update(fn) {
    const result = fn(this.state);
    if (result && typeof result === 'object') this.state = result;
    this.markDirty();
    return this.state;
  }

  markDirty() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 1500);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (!this._dirty) return true;
    this._dirty = false;
    return writeJsonAtomic(this.file, this.state, { maxBytes: MAX_BYTES });
  }

  reset() {
    this.state = defaultState();
    this.flush();
    return this.state;
  }
}

function createStore(userDataDir) {
  return new AttentionStore(path.join(userDataDir, 'gemair-attention.json'));
}

module.exports = { AttentionStore, createStore };
