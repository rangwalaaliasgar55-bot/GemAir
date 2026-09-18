#!/usr/bin/env node
'use strict';

// Memory cold-archive tests (the Mark-LII/LIII memory lesson: capped memory
// must never silently delete). Covers lib/memory-archive.js directly, the
// main-process eviction call sites, and the GemCore memory-store eviction
// reporting + archive fallback.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const { MemoryArchive, MAX_ARCHIVE_BYTES } = require(path.join(ROOT, 'lib/memory-archive.js'));

console.log('\nGemAir — memory archive tests\n');

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-archive-'));
  return { dir, file: path.join(dir, name) };
}

// ---------------------------------------------------------------------------
// Append / search / stats / rotation
// ---------------------------------------------------------------------------
{
  const { dir, file } = tempFile('archive.json');
  try {
    const archive = new MemoryArchive(file);
    assert.strictEqual(archive.stats().totalLive, 0, 'archive starts empty');

    const added = archive.append('facts', ['Ada likes espresso', 'Ada works on the GemAir repo', 'unrelated filler entry']);
    assert.strictEqual(added, 3, 'all entries archived');
    archive.append('mood', [{ emotion: 'calm', ts: 1 }]);
    archive.append('transcript', 'user asked about oled monitors');

    const stats = archive.stats();
    assert.strictEqual(stats.totalLive, 5);
    assert.strictEqual(stats.byKind.facts, 3);
    assert.strictEqual(stats.byKind.mood, 1);

    const hits = archive.search('espresso GemAir', { limit: 5 });
    assert.strictEqual(hits.length, 2, 'token-overlap search finds both relevant entries');
    assert(hits.every((h) => h.archived === true), 'archive results are marked archived');
    assert(hits[0].kind === 'facts');

    const empty = archive.search('', {});
    assert.deepStrictEqual(empty, [], 'empty query never scans');
    assert.strictEqual(archive.recent('facts', 2).length, 2, 'recent() caps and orders');

    // Persistence across instances.
    const reloaded = new MemoryArchive(file);
    assert.strictEqual(reloaded.stats().totalLive, 5, 'archive survives a reload');
    console.log('  ok   append / stats / search / persistence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Redaction: secrets never land in the archive as-is
{
  const { dir, file } = tempFile('redact.json');
  try {
    const archive = new MemoryArchive(file);
    archive.append('facts', 'my api key is sk-test1234567890abcdef');
    const raw = fs.readFileSync(file, 'utf8');
    const { redactSensitiveText } = require(path.join(ROOT, 'lib/privacy-redaction.js'));
    const expected = redactSensitiveText('my api key is sk-test1234567890abcdef').text;
    assert(raw.includes(expected.slice(0, 20)), 'archive stores the redacted form of entries');
    console.log('  ok   writes pass through the storage redactor');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Rotation: oversized archives fold the oldest half into checkpoints
// (bounded file, but the COUNT evidence of what was learned is never lost).
{
  const { dir, file } = tempFile('rotate.json');
  try {
    const archive = new MemoryArchive(file, { maxBytes: 60 * 1024 }); // small injected budget for a fast, precise test
    const TOTAL = 120;
    for (let i = 0; i < TOTAL; i++) {
      archive.append('facts', ['record ' + i + ' ' + 'x'.repeat(1900)]);
    }
    const stats = archive.stats();
    const size = fs.statSync(file).size;
    assert(size <= 60 * 1024, 'rotated archive stays within its byte budget');
    assert(MAX_ARCHIVE_BYTES > 60 * 1024, 'production budget stays generous');
    assert((stats.byKind.facts || 0) === TOTAL, 'checkpoints preserve the total count evidence');
    assert(stats.totalLive < TOTAL, 'raw lines were folded, not kept entire');
    console.log('  ok   rotation bounds file size while preserving learn counts');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Corrupt archive never breaks the app — starts fresh in memory.
{
  const { dir, file } = tempFile('corrupt.json');
  try {
    fs.writeFileSync(file, '{ not json at all');
    const archive = new MemoryArchive(file);
    assert.strictEqual(archive.stats().totalLive, 0, 'corrupt archive reads as empty, never throws');
    archive.append('facts', 'recovery works');
    assert.strictEqual(archive.stats().totalLive, 1);
    console.log('  ok   corruption resilience');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// main.js integration: every hot-memory cap archives before it trims, and
// search_memory falls back to the archive.
// ---------------------------------------------------------------------------
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert(mainSrc.includes("require('./lib/memory-archive')"), 'main.js must require the archive');
  assert(mainSrc.includes('const memoryArchive = new MemoryArchive(MEMORY_ARCHIVE_FILE)'), 'one shared archive instance over userData');
  for (const site of ["memoryArchive.append('facts'", "memoryArchive.append('mood'", "memoryArchive.append('transcript'", "memoryArchive.append('actionLog'"]) {
    assert(mainSrc.includes(site), `missing eviction archival: ${site}`);
  }
  // Every archival call must come BEFORE (or inside the same branch as) the
  // trim — an archived-then-trimmed ordering is the whole point.
  const factsIdx = mainSrc.indexOf("memoryArchive.append('facts'");
  const factsTrimIdx = mainSrc.indexOf('m.facts = m.facts.slice(0, 300)', factsIdx);
  assert(factsIdx > -1 && factsTrimIdx > factsIdx, 'facts are archived before being trimmed');
  assert(mainSrc.includes('memoryArchive.search(q'), 'search_memory must fall back to the archive');
  assert(mainSrc.includes("ipcMain.handle('memory:archiveStats'"), 'archive stats IPC exposed');
  assert(mainSrc.includes("ipcMain.handle('memory:searchArchive'"), 'archive search IPC exposed');
  console.log('  ok   main.js: all four hot-memory caps archive, search falls back, IPC surface');
}

// ---------------------------------------------------------------------------
// GemCore scoped memory store: eviction is reported + archived + recallable.
// ---------------------------------------------------------------------------
{
  const { MemoryStore } = require(path.join(ROOT, 'lib/gemcore/memory-store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-gemcore-mem-'));
  try {
    const store = new MemoryStore(dir);
    let evictedSeen = null;
    // 300 per scope is the cap: push 302 memories. Entries 0 and 1 carry
    // importance 1 while the rest carry 5, so the eviction order is
    // deterministic (lowest importance leaves first) regardless of
    // same-millisecond timestamps in a fast loop.
    for (let i = 0; i < 302; i++) {
      const out = store.remember('fact number ' + i + ' about lunar regolith', { scope: 'user', importance: i < 2 ? 1 : 5 });
      if (out.evicted) evictedSeen = out.evicted;
    }
    assert.strictEqual(store.memories.user.length, 300, 'hot scope stays at the cap');
    assert(evictedSeen && evictedSeen.length >= 1, 'eviction is reported on the remember() result');
    assert(fs.existsSync(path.join(dir, 'gemcore', 'memory-archive.json')), 'evicted entries are archived to disk');

    // The two oldest facts ("fact number 0" / "fact number 1") were evicted;
    // recall must still surface them via the archive merge, marked archived.
    const recalled = store.recall('fact number 0', { scope: 'user', limit: 10 });
    assert(recalled.some((m) => m.archived === true), 'recall falls back to the cold archive for evicted memories');
    assert(recalled.some((m) => m.archived === true && /fact number 0 about lunar regolith/.test(m.content)), 'the oldest evicted memory comes back verbatim from the archive');
    console.log('  ok   GemCore store: capped scope archives evictions; recall finds them again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nAll memory-archive tests passed.\n');
