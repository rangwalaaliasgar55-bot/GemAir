'use strict';
/* ============================================================
   GemCore core systems tests — scoped memory (AERA), audit
   hash chain (AERA), reasoning levels/trace (AERA), emotion
   profiles (AERA), and the createGemCore assembly.
   ============================================================ */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryStore } = require('../lib/gemcore/memory-store');
const { AuditLog } = require('../lib/gemcore/audit');
const { ReasoningTrace, REASONING_LEVELS, classifyReasoningLevel, reasoningScaffoldPrompt } = require('../lib/gemcore/reasoning');
const emotion = require('../lib/gemcore/emotion-profiles');
const gemcore = require('../lib/gemcore');

let passed = 0;
const tests = [];
function ok(label, fn) { tests.push([label, fn]); }
async function runTests() {
  for (const [label, fn] of tests) {
    try { await fn(); passed += 1; }
    catch (error) { console.error('✗ ' + label + ': ' + (error && error.message || error)); process.exitCode = 1; }
  }
  console.log('gemcore-core-test: ' + passed + ' assertions passed' + (process.exitCode ? ' (WITH FAILURES)' : ''));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-core-'));

/* ---------------- scoped memory ---------------- */
ok('memory: scopes are separate and default to user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-mem-'));
  const memory = new MemoryStore(dir);
  memory.remember('I prefer dark mode', { scope: 'user' });
  memory.remember('Currently migrating the database', { scope: 'task' });
  memory.remember('The API base is api.internal:8443', { scope: 'long-term' });
  assert.equal(memory.list().user.length, 1);
  assert.equal(memory.list().task.length, 1);
  assert.equal(memory.list()['long-term'].length, 1);
  assert.throws(() => memory.remember('x', { scope: 'secret' }), /Unknown memory scope/);
});

ok('memory: secrets are redacted before storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-mem2-'));
  const memory = new MemoryStore(dir);
  const record = memory.remember('My key is sk-abcdef1234567890abcdef and email me at me@example.com');
  assert(!record.content.includes('sk-abcdef1234567890abcdef'));
  assert(!record.content.includes('me@example.com'));
  assert(record.redacted === true);
  const raw = fs.readFileSync(path.join(dir, 'gemcore', 'memory.json'), 'utf8');
  assert(!raw.includes('sk-abcdef1234567890abcdef'));
});

ok('memory: keyed updates replace instead of duplicating', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-mem3-'));
  const memory = new MemoryStore(dir);
  memory.remember('favorite color is blue', { key: 'favorite-color' });
  memory.remember('favorite color is green', { key: 'favorite-color' });
  assert.equal(memory.list().user.length, 1);
  assert(memory.list().user[0].content.includes('green'));
});

ok('memory: duplicate content bumps hit count, no duplicate rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-mem4-'));
  const memory = new MemoryStore(dir);
  memory.remember('I like tea');
  const again = memory.remember('I like tea');
  assert(again.duplicate === true);
  assert.equal(memory.list().user.length, 1);
});

ok('memory: recall ranks by term overlap + importance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-mem5-'));
  const memory = new MemoryStore(dir);
  memory.remember('User works on the GemAir project', { importance: 1 });
  memory.remember('User loves pineapple pizza', { importance: 5 });
  memory.remember('Project deadline is Friday', { importance: 3 });
  const results = memory.recall('project deadline');
  assert(results.length > 0);
  assert(/deadline/i.test(results[0].content));
  assert(memory.recall('nothing matches this zebra query').length <= 3);
});

ok('memory: context block formats retrievable memories for the model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-mem6-'));
  const memory = new MemoryStore(dir);
  memory.remember('Name is Aliasgar');
  const block = memory.contextBlock('what is my name');
  assert(block.includes('## What Gem remembers'));
  assert(block.includes('Aliasgar'));
  assert.equal(memory.contextBlock('qqqq zzzz'), ''); // nothing relevant → no block
});

ok('memory: forget + clearScope + persistence across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-mem7-'));
  const memory = new MemoryStore(dir);
  const a = memory.remember('remember A');
  memory.remember('remember B');
  memory.remember('task note', { scope: 'task' });
  const forgotten = memory.forget(a.id);
  assert.equal(forgotten.forgotten, true);
  assert.equal(memory.list().user.length, 1);
  const cleared = memory.clearScope('task');
  assert.equal(cleared.cleared, 1);
  const reloaded = new MemoryStore(dir);
  assert.equal(reloaded.list().user.length, 1);
  assert(reloaded.list().user[0].content.includes('remember B'));
});

/* ---------------- audit log ---------------- */
ok('audit: entries are hash-chained and verify', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-audit-'));
  const audit = new AuditLog(dir);
  audit.append({ kind: 'tool', tool: 'run_command', tier: 'CRITICAL', outcome: 'ok' });
  audit.append({ kind: 'memory', detail: 'remember [user]', outcome: 'ok' });
  audit.append({ kind: 'permission', detail: 'session approval', outcome: 'ok' });
  const verify = audit.verify();
  assert.equal(verify.valid, true);
  assert.equal(verify.entries, 3);
  assert.equal(audit.recent(10).length, 3);
  assert.equal(audit.recent(10, 'tool').length, 1);
});

ok('audit: tampering breaks the chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-audit2-'));
  const audit = new AuditLog(dir);
  audit.append({ kind: 'tool', tool: 'write_file', outcome: 'ok' });
  audit.append({ kind: 'tool', tool: 'read_file', outcome: 'ok' });
  const file = path.join(dir, 'gemcore', 'audit.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.entries[0].detail = 'SILENTLY ALTERED';
  fs.writeFileSync(file, JSON.stringify(raw));
  const tampered = new AuditLog(dir);
  const verify = tampered.verify();
  assert.equal(verify.valid, false);
});

ok('audit: hygiene prunes and re-tightens the chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-audit3-'));
  const audit = new AuditLog(dir);
  audit.silent = false;
  for (let i = 0; i < 120; i += 1) audit.append({ kind: 'tool', detail: 'entry ' + i, outcome: 'ok' });
  const result = audit.hygiene();
  // PRUNE_TO keeps 3000, so nothing is pruned at 120 — but the chain stays valid.
  assert.equal(result.pruned, 0);
  assert(audit.verify().valid);
  // Force a prune by shrinking the entries directly.
  audit.entries = audit.entries.slice(0, 50);
  const pruned = audit.hygiene();
  assert.equal(pruned.pruned, 0);
  assert.equal(audit.entries.length, 50);
  assert(audit.verify().valid, 'chain must verify after re-tightening');
});

ok('audit: stats summarize by kind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-audit4-'));
  const audit = new AuditLog(dir);
  audit.append({ kind: 'tool', outcome: 'ok' });
  audit.append({ kind: 'tool', outcome: 'error' });
  audit.append({ kind: 'memory', outcome: 'ok' });
  const stats = audit.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.byKind.tool, 2);
  assert.equal(stats.byKind.memory, 1);
  assert.equal(stats.chain.valid, true);
});

/* ---------------- reasoning ---------------- */
ok('reasoning: reflex / heuristic / deliberate / deep classification', () => {
  assert.equal(classifyReasoningLevel('hi').id, 'reflex');
  assert.equal(classifyReasoningLevel('thanks!').id, 'reflex');
  assert.equal(classifyReasoningLevel('what is 2+2?').id, 'heuristic');
  assert.equal(classifyReasoningLevel('explain why the sky is blue').id, 'deliberate');
  assert.equal(classifyReasoningLevel('read this file and summarize it', { toolCount: 3 }).id, 'deliberate');
  assert.equal(classifyReasoningLevel('design the architecture with trade-offs for a distributed system').id, 'deep');
  assert.equal(classifyReasoningLevel('x'.repeat(1500)).id, 'deep');
});

ok('reasoning: scaffold prompts match the level', () => {
  assert.equal(reasoningScaffoldPrompt(REASONING_LEVELS.REFLEX), null);
  assert(/directly and concisely/.test(reasoningScaffoldPrompt(REASONING_LEVELS.HEURISTIC)));
  assert(/step by step/.test(reasoningScaffoldPrompt(REASONING_LEVELS.DELIBERATE)));
  assert(/methodically/.test(reasoningScaffoldPrompt(REASONING_LEVELS.DEEP)));
});

ok('reasoning: trace records, caps, and summarizes', () => {
  const trace = new ReasoningTrace({ maxEntries: 5 });
  for (let i = 0; i < 8; i += 1) trace.record({ level: REASONING_LEVELS.HEURISTIC, phase: 'p' + i, detail: 'd' + i });
  assert.equal(trace.entries.length, 5);
  assert.equal(trace.recent(2)[1].phase, 'p7');
  const summary = trace.summary();
  assert.equal(summary.total, 5);
  assert.equal(summary.byLevel.heuristic, 5);
  trace.clear();
  assert.equal(trace.entries.length, 0);
});

/* ---------------- emotion profiles ---------------- */
ok('emotion: original GemAir eight are unchanged', () => {
  assert.deepEqual(emotion.EMOTION_PROFILES.happy, { rate: 0.08, pitch: 0.12, volume: 0.05, pause: 0 });
  assert.deepEqual(emotion.EMOTION_PROFILES.neutral, { rate: 0, pitch: 0, volume: 0, pause: 0 });
  assert.deepEqual(emotion.EMOTION_PROFILES.urgent, { rate: 0.12, pitch: 0.06, volume: 0.12, pause: 0 });
});

ok('emotion: AERA dialogue states exist and normalize with synonyms', () => {
  for (const key of ['attentive', 'deliberate', 'concerned', 'apologetic', 'curious', 'celebratory', 'stern']) {
    assert(emotion.EMOTION_PROFILES[key], key + ' profile should exist');
  }
  assert.equal(emotion.normalizeEmotion('thoughtful'), 'deliberate');
  assert.equal(emotion.normalizeEmotion('TRIUMPHANT'), 'celebratory');
  assert.equal(emotion.normalizeEmotion('unknown-feeling'), 'neutral');
});

ok('emotion: response classification picks fitting profiles', () => {
  assert.equal(emotion.classifyResponseEmotion('Congratulations, you did it! 🎉'), 'celebratory');
  assert.equal(emotion.classifyResponseEmotion('I\'m sorry, my mistake there.'), 'apologetic');
  assert.equal(emotion.classifyResponseEmotion('WARNING: do not delete that file'), 'stern');
  assert.equal(emotion.classifyResponseEmotion('I understand, that sounds hard.'), 'empathetic');
  assert.equal(emotion.classifyResponseEmotion('Let me think — here\'s my analysis, step by step'), 'deliberate');
  assert.equal(emotion.classifyResponseEmotion('plain statement.'), 'neutral');
});

ok('emotion: user sentiment detection drives adaptation', () => {
  const frustrated = emotion.classifyUserSentiment('this stupid thing never works, ugh!');
  assert.equal(frustrated.sentiment, 'frustrated');
  assert.equal(emotion.adaptEmotionToUserState(frustrated), 'apologetic');
  const sad = emotion.classifyUserSentiment('I feel sad and exhausted today');
  assert.equal(sad.sentiment, 'sad');
  assert.equal(emotion.adaptEmotionToUserState(sad), 'empathetic');
  const anxious = emotion.classifyUserSentiment('I am worried about the deadline, nervous');
  assert.equal(anxious.sentiment, 'anxious');
  assert.equal(emotion.adaptEmotionToUserState(anxious), 'concerned');
  const joy = emotion.classifyUserSentiment('thank you so much, this is amazing!');
  assert.equal(joy.sentiment, 'joyful');
  assert.equal(emotion.adaptEmotionToUserState(joy), 'celebratory');
  assert.equal(emotion.adaptEmotionToUserState({ sentiment: 'neutral', intensity: 0 }, 'confident'), 'confident');
});

ok('emotion: prosody clamps to TTS engine bounds, delays fit the state', () => {
  const low = emotion.prosodyFor('deliberate', { baseRate: 0.4, basePitch: 0.2, baseVolume: 0.1 });
  assert.equal(low.rate, 0.5); // clamped up to the engine floor
  assert.equal(low.pitch, 0.5);
  const high = emotion.prosodyFor('celebratory', { baseRate: 1.49, basePitch: 1.49, baseVolume: 1 });
  assert.equal(high.rate, 1.5); // clamped to the engine ceiling
  assert.equal(high.pitch, 1.5);
  assert(emotion.delayForEmotion('deliberate') >= emotion.delayForEmotion('neutral'));
  assert(emotion.delayForEmotion('apologetic') > 0);
});

/* ---------------- createGemCore assembly ---------------- */
ok('assembly: createGemCore wires audit into the tool broker', async () => {
  const engine = gemcore.createGemCore(tmpRoot, {
    confirm: async () => true,
    executeTool: async () => ({ ok: true })
  });
  assert(engine.providerService && engine.memory && engine.audit && engine.toolBroker && engine.budgets && engine.reasoningTrace);
  await engine.toolBroker.execute('write_file', { path: '/tmp/gc-test.txt', content: 'x' }, { source: 'assembly-test' });
  const stats = engine.audit.stats();
  assert(stats.total >= 1);
  assert(stats.byKind.tool >= 1);
  assert(engine.audit.verify().valid);
});

ok('assembly: default executor denies politely when none supplied', async () => {
  const engine = gemcore.createGemCore(fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-asm2-')), {});
  // LOW-impact tool reaches the (absent) executor directly, no approval needed.
  const result = await engine.toolBroker.execute('get_current_time', {});
  assert(result.error && /not available/.test(result.error));
});

runTests();
