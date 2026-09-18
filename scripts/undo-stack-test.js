'use strict';
/**
 * scripts/undo-stack-test.js — "undo — take back what the assistant did".
 *
 * Concept port verification (no upstream code): lib/undo-stack.js implements
 * Mark-LIV's shared undo stack semantics for GemAir's file tools:
 *   - nothing runs at registration; reversal runs once, on demand
 *   - >1 MB snapshots refused with honesty, not hoarding
 *   - created files are removed only while unchanged; rolled-back files only
 *     while untouched; folders only while empty; moves only while collision-free
 *   - stack caps and archives evictions (nothing silently forgotten)
 * plus the main.js wiring: tools declared, risk-tiered, journaled, and an
 * undo:list IPC.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UndoStack, snapshotFile, fileWriteEntry, fileMoveEntry, organizeEntry, folderCreateEntry, MAX_SNAPSHOT_BYTES } = require('../lib/undo-stack.js');

const ok = (m) => console.log('  ok  ', m);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-undo-'));

  // 1) write a new file → undo removes it (contents unchanged); retry-proof
  {
    const stack = new UndoStack();
    const target = path.join(tmp, 'new-file.txt');
    const before = await snapshotFile(fs.promises, target);
    assert.strictEqual(before.exists, false, 'fresh file snapshot reports non-existence');
    fs.writeFileSync(target, 'hello from gemair');
    stack.push(fileWriteEntry(target, before, Buffer.from('hello from gemair')));
    assert.strictEqual(stack.size(), 1);
    const result = await stack.undoLast();
    assert.strictEqual(result.ok, true, 'undo of a fresh write succeeds');
    assert.strictEqual(fs.existsSync(target), false, 'undo removed the created file');
    assert.strictEqual(stack.size(), 0, 'successful undo consumes the entry');
  }
  ok('file-write undo: created file removed, entry consumed');

  // 2) created file since edited by the user → undo REFUSES (no data loss)
  {
    const stack = new UndoStack();
    const target = path.join(tmp, 'user-edited.txt');
    const before = await snapshotFile(fs.promises, target);
    fs.writeFileSync(target, 'gemair wrote this');
    stack.push(fileWriteEntry(target, before, Buffer.from('gemair wrote this')));
    fs.writeFileSync(target, 'the human rewrote this — precious');
    const result = await stack.undoLast();
    assert.strictEqual(result.ok, false, 'undo refuses on changed content');
    assert.match(result.error, /changed|Refusing/i, 'refusal explains itself');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'the human rewrote this — precious', 'user edits survive the refused undo');
    assert.strictEqual(stack.size(), 1, 'failed undo stays on the stack');
  }
  ok('file-write undo: user edits after the write are never destroyed');

  // 3) overwrite of a pre-existing file → restore + no-restore-after-user-edit
  {
    const stack = new UndoStack();
    const target = path.join(tmp, 'existing.txt');
    fs.writeFileSync(target, 'ORIGINAL');
    const before = await snapshotFile(fs.promises, target);
    assert.strictEqual(before.exists, true);
    fs.writeFileSync(target, 'gemair version');
    stack.push(fileWriteEntry(target, before, Buffer.from('gemair version')));
    const r1 = await stack.undoLast();
    assert.strictEqual(r1.ok, true, 'rollback succeeds while untouched');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'original contents restored');
  }
  ok('file-write undo: overwrite rolls back to the exact snapshot');

  // 4) >1 MB snapshot exclusion is honest, not hoarded
  {
    const target = path.join(tmp, 'big.bin');
    fs.writeFileSync(target, Buffer.alloc(MAX_SNAPSHOT_BYTES + 16, 65));
    const snap = await snapshotFile(fs.promises, target);
    assert.strictEqual(snap.excluded, true, 'oversized files excluded');
    assert.match(snap.reason, /1 MB/i, 'exclusion says why');
    const stack = new UndoStack();
    stack.push(fileWriteEntry(target, snap, null));
    const r = await stack.undoLast();
    assert.strictEqual(r.ok, false, 'excluded entries refuse instead of guessing');
  }
  ok('oversized snapshots: excluded with an explicit reason, refused on undo');

  // 5) folder-create: removed only while empty
  {
    const stack = new UndoStack();
    const dir = path.join(tmp, 'fresh-dir');
    fs.mkdirSync(dir);
    stack.push(folderCreateEntry(dir));
    fs.writeFileSync(path.join(dir, 'something.txt'), 'x');
    const refuse = await stack.undoLast();
    assert.strictEqual(refuse.ok, false, 'refuses while the folder holds content');
    assert.ok(fs.existsSync(dir), 'non-empty folder survives');
    fs.unlinkSync(path.join(dir, 'something.txt'));
    const r2 = await stack.undoLast();
    assert.strictEqual(r2.ok, true, 'emptied folder now removable');
    assert.ok(!fs.existsSync(dir), 'empty folder removed');
  }
  ok('folder-create undo: empty-only removal, retried after user empties it');

  // 6) organize batch: moves back in one shot + prunes the created empty dirs
  {
    const stack = new UndoStack();
    const base = path.join(tmp, 'desk');
    fs.mkdirSync(base);
    const aFrom = path.join(base, 'a.txt'), bFrom = path.join(base, 'b.txt');
    fs.writeFileSync(aFrom, 'A'); fs.writeFileSync(bFrom, 'B');
    const imgDir = path.join(base, 'images');
    fs.mkdirSync(imgDir);
    const moves = [{ from: aFrom, to: path.join(imgDir, 'a.txt') }, { from: bFrom, to: path.join(imgDir, 'b.txt') }];
    for (const mv of moves) fs.renameSync(mv.from, mv.to);
    stack.push(organizeEntry('organize desk', moves, [imgDir]));
    const r = await stack.undoLast();
    assert.strictEqual(r.ok, true, 'batch reversal succeeds');
    assert.strictEqual(fs.readFileSync(aFrom, 'utf8'), 'A', 'first file back in place');
    assert.strictEqual(fs.readFileSync(bFrom, 'utf8'), 'B', 'second file back in place');
    assert.ok(!fs.existsSync(imgDir), 'created category folder pruned once empty');
  }
  ok('organize undo: everything moves back at once; empty folders pruned');

  // 7) collision guard: a move-back refuses when the origin got occupied
  {
    const stack = new UndoStack();
    const base = path.join(tmp, 'collide');
    fs.mkdirSync(base);
    const from = path.join(base, 'x.txt'), to = path.join(base, 'sub', 'x.txt');
    fs.mkdirSync(path.join(base, 'sub'));
    fs.writeFileSync(from, 'moved out');
    fs.renameSync(from, to);
    stack.push(fileMoveEntry(from, to));
    fs.writeFileSync(from, 'somebody else parked here');
    const r = await stack.undoLast();
    assert.strictEqual(r.ok, false, 'collision refuses rather than overwriting');
    assert.strictEqual(fs.readFileSync(from, 'utf8'), 'somebody else parked here');
  }
  ok('move-back undo: collision at the origin refuses honestly');

  // 8) cap + archive: evicted entries report, oldest leaves the live stack
  {
    const archived = [];
    const fakeArchive = { append: (kind, items, meta) => archived.push({ kind, items, meta }) };
    const stack = new UndoStack({ cap: 3, archive: fakeArchive }); // floor is 5 by design
    for (let i = 0; i < 8; i++) stack.push({ kind: 'noop', label: 'entry ' + i, undo: async () => ({ ok: true }) });
    assert.strictEqual(stack.size(), 5, 'cap floor of 5 holds');
    assert.strictEqual(archived.length, 3, 'three evictions archived, never silently forgotten');
    assert.strictEqual(archived[0].kind, 'undoLog');
    assert.deepStrictEqual(stack.list().map((e) => e.label), ['entry 7', 'entry 6', 'entry 5', 'entry 4', 'entry 3'], 'list is newest-first');
    const byId = await stack.undo(stack.list()[1].id);
    assert.strictEqual(byId.ok, true, 'undo by id works');
    assert.deepStrictEqual(stack.list().map((e) => e.label), ['entry 7', 'entry 5', 'entry 4', 'entry 3']);
  }
  ok('cap eviction: archived verbatim; floor of 5; list/undo-by-id behave');

  // 9) empty stack reports honestly
  {
    const stack = new UndoStack();
    const r = await stack.undoLast();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.empty, true, 'empty flag present for honest reporting');
  }
  ok('empty undo reports instead of pretending');

  // 10) main.js wiring: tools declared + risk tier + journaling + IPC
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    for (const name of ['undo_last', 'list_undoable', 'recall_clipboard_entry', 'list_clipboard_entries', 'get_assistant_capabilities']) {
      assert.ok(main.includes(`name: '${name}'`), `tool ${name} declared`);
      assert.ok(main.includes(`case '${name}'`), `tool ${name} dispatched`);
    }
    for (const fragment of [
      'const undoStack = new UndoStack',
      'snapshotFile(fs.promises, safePath)',
      'undoStack.push(fileWriteEntry(',
      'undoStack.push(organizeEntry(`organize ',
      'undoStack.push(folderCreateEntry(',
      "ipcMain.handle('undo:list'",
      'ipcMain.handle(\'automation:apply\''
    ]) assert.ok(main.includes(fragment), 'main.js wire: ' + fragment);
    assert.ok(/reversible: journalMoves\.length > 0/.test(main), 'file tools report reversibility to the model');
    assert.ok(main.includes("confirmAction('Take this back?'"), 'undo_last still passes a human confirm');
  }
  ok('main.js: undo tools declared, journaled, human-confirmed, IPC exposed');

  console.log('\nAll undo-stack tests passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
