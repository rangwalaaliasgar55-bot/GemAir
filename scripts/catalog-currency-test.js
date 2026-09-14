#!/usr/bin/env node
'use strict';

/**
 * Catalog currency test.
 *
 * Every other connection test here verifies OUR code against OUR assumptions.
 * None of them could see the failure that actually killed GemAir's chat in
 * 2026: providers retired model IDs upstream (Groq shut llama-3.1-8b-instant
 * and llama-3.3-70b-versatile down on 2026-08-16; Google retired the Gemini 2.0
 * family on 2026-06-01; SambaNova removed Meta-Llama-3.1-8B-Instruct on
 * 2026-04-14; xAI retired the Grok 3/4 line on 2026-05-15) and the suite stayed
 * green while the product stopped answering. This test pins the calendar:
 *
 *   1. no retired model id may appear in first-party source;
 *   2. every catalog entry must survive the repair map (no self-contradiction);
 *   3. the renderer catalog and the serverless free chain must not disagree
 *      about the providers they both ship;
 *   4. repairModelId must be idempotent and never invent an empty model;
 *   5. the ledger must be reviewed on a schedule, not "when someone complains".
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const currency = require(path.join(ROOT, 'renderer', 'model-currency.js'));

let passed = 0;
const ok = (label) => { passed += 1; console.log('  ok   ' + label); };

// --- 1. no retired id anywhere in shipped first-party source ----------------
const SCANNED = [
  'renderer/providers.js', 'renderer/app.js', 'renderer/ai-client.js',
  'renderer/tts-engine.js', 'renderer/gemini-live.js', 'renderer/apple.js',
  'main.js', 'preload.js', 'api/chat.js', 'api/config.js', 'api/health.js',
  'lib/connections.js', 'lib/chatgpt-codex.js', 'lib/gemini-oauth-generate.js',
  'lib/free-chatgpt.js', 'lib/oauth-gemini-pkce.js', 'lib/tool-router.js'
];
const offenders = [];
for (const rel of SCANNED) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { offenders.push(`${rel}: missing`); continue; }
  const text = fs.readFileSync(file, 'utf8');
  for (const retired of Object.keys(currency.RETIRED_MODELS)) {
    // Quoted literal only — prose mentions inside comments are how this test
    // documents history, so they stay allowed.
    const quoted = new RegExp(`['"\`]${retired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
    const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    if (quoted.test(code)) offenders.push(`${rel}: retired model id "${retired}"`);
  }
}
assert.deepStrictEqual(offenders, [], 'Retired model ids found in first-party source:\n  ' + offenders.join('\n  '));
ok('no retired model id survives in shipped source');

// --- 2. catalog entries agree with the ledger ------------------------------
const providersSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'providers.js'), 'utf8');
const sandbox = { window: { GemAirModelCurrency: currency } };
// providers.js is a browser IIFE; evaluate it with a window stub.
new Function('window', providersSrc.replace(/^\s*\/\*[\s\S]*?\*\//, ''))(sandbox.window);
const catalog = sandbox.window.GemAirProviders;
assert.ok(catalog && Array.isArray(catalog.PROVIDERS) && catalog.PROVIDERS.length >= 15, 'renderer catalog did not load');
let entryCount = 0;
for (const provider of catalog.PROVIDERS) {
  assert.ok(provider.id && provider.name && provider.baseURL, `provider ${provider.id} is missing id/name/baseURL`);
  assert.ok(/^https?:\/\//.test(provider.baseURL), `${provider.id}: baseURL must be absolute`);
  assert.ok(Array.isArray(provider.models) && provider.models.length > 0, `${provider.id}: no models`);
  for (const model of provider.models) {
    entryCount += 1;
    assert.ok(!currency.isKnownRetired(model.id), `${provider.id}: lists retired model ${model.id}`);
  if (currency.PROVIDER_MODEL_ALIASES[provider.id]) {
    const alias = currency.PROVIDER_MODEL_ALIASES[provider.id][model.id];
    assert.ok(!alias, `${provider.id}: lists ${model.id}, which its own alias table rewrites to ${alias}`);
  }
    const repair = currency.repairModelId(model.id, provider.id);
    assert.strictEqual(repair.repaired, false, `${provider.id}: ${model.id} should already be healed (wants ${repair.model})`);
    if (provider.id !== 'gemini' && provider.id !== 'ollama') {
      assert.ok(currency.isChatCapable(model.id), `${provider.id}: ${model.id} is not a chat-capable model`);
    }
  }
  // A provider labelled `free` is a promise the picker makes to the user, so it
  // must not be contradicted by its own note (Cerebras moved from a standing
  // free tier to a card-required trial on 2026-07-21 — that is free: false).
  const note = provider.note || '';
  if (provider.free === true) {
    assert.ok(!/free tier (is )?(gone|ended|removed)|no (standing )?free tier|replaced by a .{0,20}trial|no longer free/i.test(note),
      `${provider.id}: labelled free but the note says the tier is gone`);
  }
  if (provider.free === false && provider.noCard !== true) {
    assert.ok(!/permanent free tier|generous free tier/i.test(note), `${provider.id}: note promises a free tier while marked not-free`);
  }
}
ok(`catalog holds ${entryCount} live model ids across ${catalog.PROVIDERS.length} providers`);

// --- 3. the server chain must not lag the catalog --------------------------
const chatSrc = fs.readFileSync(path.join(ROOT, 'api', 'chat.js'), 'utf8');
const chainBlock = chatSrc.slice(chatSrc.indexOf('const FREE_PROVIDERS'), chatSrc.indexOf('function availableProviders'));
for (const provider of catalog.PROVIDERS) {
  if (provider.id === 'ollama' || provider.id === 'claude' || provider.id === 'siliconflow' || provider.id === 'hyperbolic' || provider.id === 'novita') continue;
  if (!chainBlock.includes(`id: '${provider.id}'`)) continue; // serverless chain is deliberately narrower
  const block = chatSrc.match(new RegExp(`id: '${provider.id}'[\\s\\S]*?models: \\[([^\\]]*)\\]`));
  assert.ok(block, `api/chat.js: could not read the model list for ${provider.id}`);
  const serverModels = block[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.ok(serverModels.length > 0, `api/chat.js: ${provider.id} has no models`);
  for (const model of serverModels) {
    assert.ok(!currency.isKnownRetired(model), `api/chat.js: ${provider.id} chains retired ${model}`);
    assert.ok(catalog.PROVIDERS.some((p) => p.id === provider.id && p.models.some((m) => m.id === model)),
      `api/chat.js: ${provider.id} chains ${model}, which the catalog does not offer`);
    assert.ok(!currency.repairModelId(model, provider.id).repaired, `api/chat.js: ${provider.id} chains ${model}, which the ledger still wants to rewrite`);
  }
}
ok('serverless free chain matches the catalog (no retired or invented ids)');

// --- 4. repair semantics ----------------------------------------------------
assert.strictEqual(currency.repairModelId('llama-3.1-8b-instant', 'groq').repaired, true);
assert.strictEqual(currency.repairModelId('openai/gpt-oss-120b', 'groq').repaired, false);
for (const [retired, replacement] of Object.entries(currency.RETIRED_MODELS)) {
  const once = currency.repairModelId(retired).model;
  const twice = currency.repairModelId(once).model;
  assert.strictEqual(once, twice, `repair of ${retired} is not idempotent (→ ${once} → ${twice})`);
  assert.ok(once && once.length > 1, `repair of ${retired} produced an empty model id`);
  assert.ok(!currency.isKnownRetired(once), `repair of ${retired} produced another retired id (${once})`);
  assert.ok(replacement && !currency.isKnownRetired(replacement), `ledger entry ${retired} → ${replacement} is itself retired`);
}
assert.deepStrictEqual(currency.repairModelId('', 'groq'), { model: '', repaired: false, from: '', reason: '' }, 'empty model must stay empty');
assert.deepStrictEqual(currency.repairModelId(undefined).model, '', 'undefined model must not become a string');
// No fuzzy rewrites: a live id that merely shares a suffix with a retired one
// must come back untouched (this is what kept HF's Qwen model working).
assert.strictEqual(currency.repairModelId('groq/llama-3.1-8b-instant').model, 'groq/llama-3.1-8b-instant');
assert.strictEqual(currency.repairModelId('Qwen/Qwen2.5-72B-Instruct', 'hf').model, 'Qwen/Qwen2.5-72B-Instruct');
// SambaNova's own (unprefixed) id IS healed; the Hugging Face-prefixed form is
// a different model and must not be.
assert.strictEqual(currency.repairModelId('Qwen2.5-72B-Instruct', 'sambanova').model, 'Meta-Llama-3.3-70B-Instruct');
assert.strictEqual(currency.repairModelId('Meta-Llama-3.1-8B-Instruct', 'sambanova').model, 'Meta-Llama-3.3-70B-Instruct');
assert.strictEqual(currency.repairModelId('llama-3.3-70b', 'cerebras').model, 'gpt-oss-120b');
assert.strictEqual(currency.repairModelId('llama-3.3-70b', 'novita').model, 'llama-3.3-70b');
ok(`repair map heals ${Object.keys(currency.RETIRED_MODELS).length} retired ids idempotently`);

// --- 5. the ledger is reviewed, not remembered ----------------------------
const revision = currency.CATALOG_REVISION;
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(revision), `CATALOG_REVISION must be an ISO date (found ${revision})`);
const ageDays = (Date.now() - Date.parse(revision + 'T00:00:00Z')) / 86400000;
assert.ok(ageDays >= -1, `CATALOG_REVISION ${revision} is in the future`);
if (ageDays > 120) {
  console.warn(`  WARN  catalog ledger is ${Math.round(ageDays)} days old (${revision}); re-check provider deprecation pages.`);
} else {
  ok(`catalog ledger is current (${revision}, ${Math.round(ageDays)} days old)`);
}

// --- 6. the docs quote the catalog, not a stale copy of it ------------------
for (const rel of ['README.md', '.env.example', 'CONNECTIONS.md', 'GUIDE.md', 'AI-FRAMEWORK.md', 'ARCHITECTURE.md']) {
  const doc = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = doc.split('\n').filter((line) => !/^\s*>?\s*\/\/\s*/.test(line));
  const body = code.join('\n');
  for (const retired of Object.keys(currency.RETIRED_MODELS)) {
    const re = new RegExp('`' + retired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`|=' + retired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'm');
    assert.ok(!re.test(body), `${rel} still recommends the retired model id "${retired}"`);
  }
}
// README's default-model column must be exactly what the catalog offers first.
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const brainTable = readme.slice(readme.indexOf('| Brain | Connection |'), readme.indexOf('> **🆓 Free models are shown in the app.**'));
for (const provider of catalog.PROVIDERS) {
  if (provider.id === 'claude') continue; // intentionally not advertised as a brain
  const row = brainTable.split('\n').find((line) => line.includes('`' + provider.models[0].id + '`'));
  assert.ok(row, `README brain table does not list ${provider.id}'s current default ${provider.models[0].id}`);
  assert.ok(/free tier|credits|local, keyless/.test(row), `README row for ${provider.id} has no honest tier label: ${row}`);
}
// The date is read from the ledger, not repeated as a literal, so re-dating the
// catalog only requires updating the docs sentence once (and forgetting fails here).
assert.ok(brainTable.includes(currency.CATALOG_REVISION), `README must state which catalog revision its ids reflect (${currency.CATALOG_REVISION})`);
ok('README and operator docs quote the live catalog and date it');

// --- 7. every consumer of the catalog can resolve a preset -----------------
for (const provider of catalog.PROVIDERS) {
  const preset = catalog.presetFor(provider.id);
  assert.ok(preset && preset.baseURL === provider.baseURL && preset.model, `${provider.id}: presetFor is broken`);
  assert.strictEqual(currency.isKnownRetired(preset.model), false, `${provider.id}: preset offers a retired model`);
  assert.strictEqual(catalog.detect(provider.baseURL), provider.id, `${provider.id}: detect() does not round-trip its own baseURL`);
}
ok('presets and base-URL detection round-trip for every provider');

console.log(`\n  All ${passed} catalog currency checks passed.\n`);
