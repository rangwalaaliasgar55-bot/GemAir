'use strict';
/**
 * lib/undo-stack.js — shared "take back what GemAir did" journal.
 *
 * Concept port (no upstream code) of FatihMakes/Mark-LIV's core/undo.py:
 * one shared undo stack where every reversible action registers how to
 * reverse itself at the moment it performs the action. Semantics that are
 * deliberately kept byte-for-byte in spirit:
 *
 *  - Nothing runs at registration time; undo pays only when asked.
 *  - >1 MB snapshots are refused with an honest note (no hoarding).
 *  - A created file is only removed if its contents still match what we
 *    wrote (we never delete the user's own later edits).
 *  - A created folder is only removed while it is still empty.
 *  - Moved/renamed files move back only if they still exist; collisions
 *    are reported, never overwritten.
 *  - The stack is in-memory (a closure journal, not a disk queue), capped,
 *    and evictions are archived into the memory cold-archive so "GemAir
 *    forgot what it did" never happens silently.
 *
 * Each entry: { id, kind, label, ts, meta, undo }. undo() returns
 * { ok, detail, note? } and is invoked exactly once (entry is consumed on
 * success; on failure it stays so the user sees it and can retry).
 */

const fs = require('fs');

const MAX_SNAPSHOT_BYTES = 1024 * 1024; // Mark parity: 1 MB
const DEFAULT_CAP = 25;

let nextId = 1;

class UndoStack {
  constructor(opts = {}) {
    this._entries = [];
    this._cap = Math.max(5, opts.cap || DEFAULT_CAP);
    this._archive = opts.archive || null; // memoryArchive instance (optional)
    this._archiveReason = opts.archiveReason || 'undo-evict';
  }

  /** Number of live undoable entries. */
  size() { return this._entries.length; }

  /** List entries newest-first (structured clone of metadata only). */
  list() {
    return this._entries.slice().reverse().map((entry) => ({
      id: entry.id, kind: entry.kind, label: entry.label, ts: entry.ts,
      meta: JSON.parse(JSON.stringify(entry.meta || {}))
    }));
  }

  /**
   * Register a reversible action. `spec`:
   *   kind: string ('file-write' | 'file-move' | 'folder-create' | ...)
   *   label: human one-liner for logs / UI
   *   meta: structured details (paths, counts)
   *   undo: async () => { ok, detail }  — runs ONLY on undoLast()/undo(id)
   */
  push(spec) {
    if (!spec || typeof spec.undo !== 'function') throw new Error('undo entries need an undo() closure');
    const entry = {
      id: nextId++, kind: String(spec.kind || 'generic'), label: String(spec.label || 'action'),
      ts: Date.now(), meta: spec.meta || {}, undo: spec.undo
    };
    this._entries.push(entry);
    let evicted = 0;
    while (this._entries.length > this._cap) {
      const old = this._entries.shift(); evicted++;
      if (this._archive) {
        try {
          this._archive.append('undoLog', [{
            id: old.id, kind: old.kind, label: old.label, ts: old.ts, meta: old.meta,
            note: 'evicted from the live undo stack — can no longer be undone'
          }], { reason: this._archiveReason });
        } catch {}
      }
    }
    return { id: entry.id, evicted };
  }

  /**
   * Undo the most recent entry. Entries are consumed ONLY on success;
   * a failed undo stays on the stack and reports why.
   */
  async undoLast() {
    const entry = this._entries[this._entries.length - 1];
    if (!entry) return { ok: false, error: 'Nothing to undo.', empty: true };
    let result;
    try { result = await entry.undo(); }
    catch (error) { result = { ok: false, detail: 'Undo failed: ' + error.message }; }
    if (result && result.ok) {
      this._entries.pop();
      return { ok: true, label: entry.label, kind: entry.kind, detail: result.detail || entry.label, note: result.note };
    }
    return { ok: false, label: entry.label, kind: entry.kind, error: (result && result.detail) || 'Undo refused.', note: result && result.note };
  }

  /** Undo a specific entry by id (for the model/UI picking from the list). */
  async undo(id) {
    const index = this._entries.findIndex((entry) => entry.id === Number(id));
    if (index < 0) return { ok: false, error: 'No reversible action with id ' + id + ' (already undone or evicted).' };
    const entry = this._entries[index];
    let result;
    try { result = await entry.undo(); }
    catch (error) { result = { ok: false, detail: 'Undo failed: ' + error.message }; }
    if (result && result.ok) {
      this._entries.splice(index, 1);
      return { ok: true, label: entry.label, kind: entry.kind, detail: result.detail || entry.label, note: result.note };
    }
    return { ok: false, label: entry.label, kind: entry.kind, error: (result && result.detail) || 'Undo refused.', note: result && result.note };
  }

  clear() { this._entries.length = 0; }
}

// ----- file-op undo factories (kept pure: caller performs the action,
// then registers the reversal with the exact facts of what happened) -----

/** Snapshot a ≤1 MB file for later restore. Excluded files report honestly. */
function snapshotFile(fsPromises, absPath) {
  return (async () => {
    try {
      const stat = await fsPromises.stat(absPath);
      if (!stat.isFile()) return { exists: false };
      if (stat.size > MAX_SNAPSHOT_BYTES) {
        return { excluded: true, reason: `File is ${Math.round(stat.size / 1048576 * 10) / 10} MB — undo snapshots skip files over 1 MB rather than hoarding.` };
      }
      const content = await fsPromises.readFile(absPath);
      return { exists: true, size: stat.size, content };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false };
      return { excluded: true, reason: 'Could not snapshot: ' + error.message };
    }
  })();
}

/**
 * Build the journal entry for write_file/create_file.
 * Caller must have a BEFORE snapshot (snapshotFile) taken pre-write.
 */
function fileWriteEntry(absPath, before, wroteBuffer) {
  return {
    kind: 'file-write',
    label: `write ${absPath}`,
    meta: { path: absPath, existedBefore: !!before.exists, snapshotExcluded: !!before.excluded },
    undo: async () => {
      if (before.excluded) return { ok: false, detail: before.reason };
      if (before.exists) {
        // Only roll back if the file is still exactly what we wrote — after
        // GemAir's write you may have edited it, and restoring the snapshot
        // would then destroy YOUR edits. That undo must refuse.
        if (wroteBuffer) {
          let current;
          try { current = await fs.promises.readFile(absPath); }
          catch (error) { return { ok: false, detail: 'Cannot undo: file unreadable (' + error.message + ').' }; }
          if (Buffer.compare(current, wroteBuffer) !== 0) {
            return { ok: false, detail: 'Refusing to roll back: the file changed since GemAir wrote it — restoring would destroy those edits.', note: 'content-changed' };
          }
        }
        await fs.promises.writeFile(absPath, before.content);
        return { ok: true, detail: `Restored previous contents of ${absPath} (${before.size} bytes).` };
      }
      // Created fresh: delete ONLY if the content is still exactly what we wrote.
      let current;
      try { current = await fs.promises.readFile(absPath); }
      catch (error) { return { ok: false, detail: 'Cannot undo: file unreadable (' + error.message + ').' }; }
      if (wroteBuffer && Buffer.compare(current, wroteBuffer) !== 0) {
        return { ok: false, detail: 'Refusing to delete: you (or something else) changed the file since GemAir created it. Reversing would destroy those edits.', note: 'content-changed' };
      }
      await fs.promises.unlink(absPath);
      return { ok: true, detail: `Removed ${absPath} (created by GemAir, contents unchanged).` };
    }
  };
}

/** Build a move-back entry for one rename/move (from→to already done). */
function fileMoveEntry(from, to) {
  return {
    kind: 'file-move',
    label: `move ${from} → ${to}`,
    meta: { from, to },
    undo: async () => {
      try { await fs.promises.stat(to); }
      catch { return { ok: false, detail: `Cannot undo: ${to} no longer exists.` }; }
      let free;
      try { await fs.promises.stat(from); free = false; }
      catch { free = true; }
      if (!free) return { ok: false, detail: `Cannot undo: ${from} is occupied by a new file — moving back would overwrite it.`, note: 'collision' };
      await fs.promises.mkdir(require('path').dirname(from), { recursive: true });
      await fs.promises.rename(to, from);
      return { ok: true, detail: `Moved back: ${to} → ${from}` };
    }
  };
}

/**
 * Batch "organize"-style entry: reversal moves every move back in one shot,
 * then prunes the folders it created ONLY while still empty (Mark parity).
 */
function organizeEntry(label, moves, createdDirs) {
  return {
    kind: 'file-organize',
    label,
    meta: { moves: moves.length, dirs: createdDirs.length },
    undo: async () => {
      let restored = 0; const problems = [];
      const pathModule = require('path');
      for (const mv of moves.slice().reverse()) {
        try {
          await fs.promises.stat(mv.to);
          let free;
          try { await fs.promises.stat(mv.from); free = false; } catch { free = true; }
          if (!free) { problems.push(`collision at ${mv.from}`); continue; }
          await fs.promises.rename(mv.to, mv.from);
          restored++;
        } catch (error) { problems.push(pathModule.basename(mv.to) + ': ' + error.message); }
      }
      let pruned = 0;
      for (const dir of createdDirs) {
        try {
          const inside = await fs.promises.readdir(dir);
          if (inside.length === 0) { await fs.promises.rmdir(dir); pruned++; }
        } catch {}
      }
      if (problems.length) {
        return {
          ok: restored === moves.length,
          detail: `Restored ${restored}/${moves.length} files, pruned ${pruned} empty folder(s). Issues: ${problems.slice(0, 10).join('; ')}`,
          note: restored === moves.length ? undefined : 'partial'
        };
      }
      return { ok: true, detail: `Restored all ${restored} file(s) back in place` + (pruned ? ` and removed ${pruned} now-empty folder(s).` : '.') };
    }
  };
}

/** Folder-creation reversal: removes the folder ONLY while empty. */
function folderCreateEntry(absPath) {
  return {
    kind: 'folder-create',
    label: `create folder ${absPath}`,
    meta: { path: absPath },
    undo: async () => {
      let inside;
      try { inside = await fs.promises.readdir(absPath); }
      catch (error) {
        if (error && error.code === 'ENOENT') return { ok: true, detail: 'Folder already gone — nothing to remove.', note: 'already-gone' };
        return { ok: false, detail: 'Cannot undo: ' + error.message };
      }
      if (inside.length > 0) {
        return { ok: false, detail: `Refusing to remove ${absPath}: it now holds ${inside.length} item(s). Only empty folders GemAir created are removed.`, note: 'not-empty' };
      }
      await fs.promises.rmdir(absPath);
      return { ok: true, detail: `Removed empty folder ${absPath}.` };
    }
  };
}

module.exports = { UndoStack, MAX_SNAPSHOT_BYTES, snapshotFile, fileWriteEntry, fileMoveEntry, organizeEntry, folderCreateEntry };
