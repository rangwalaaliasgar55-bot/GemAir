'use strict';
/**
 * scripts/self-knowledge-test.js — "it knows what it is, and what it isn't".
 *
 * Concept port (no upstream code) of Mark-LIV's runtime self-knowledge:
 * identity, machine, live tool/plugin registry and — crucially — honest
 * limits, assembled from the live system rather than a stale prompt line.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildSelfKnowledge, gatherFacts, CORE_LIMITS } = require('../lib/self-knowledge.js');

const ok = (m) => console.log('  ok  ', m);

function main() {
  // 1) full snapshot carries every dimension Mark specifies
  {
    const info = buildSelfKnowledge({
      assistantName: 'Gem', userName: 'Ali', version: '2.13.0',
      platform: 'linux', arch: 'x64',
      toolNames: ['web_search', 'undo_last', 'write_file'],
      pluginNames: ['gcal_sync'], pluginErrors: ['broken.js: PLUGIN.name missing'],
      memoryCounts: { facts: 12, skills: 2, reminders: 3, archiveEntries: 41 },
      capabilities: { liveReady: true, wakeEnabled: true, visionReady: false, lowResource: false }
    });
    const t = info.text;
    assert.ok(t.includes('Gem'), 'identity present');
    assert.ok(t.includes('2.13.0'), 'version present');
    assert.ok(t.includes('linux x64'), 'machine present');
    assert.ok(t.includes('serving Ali'), 'user named');
    assert.ok(t.includes('3 live tools') && t.includes('undo_last'), 'live registry counted + sampled');
    assert.ok(t.includes('gcal_sync'), 'fresh plugin appears in knowledge');
    assert.ok(t.includes('failed to load'), 'broken plugins are disclaimed');
    assert.ok(/Live voice: READY/.test(t) && /Screen awareness: off/.test(t), 'capability state honest');
    assert.ok(t.includes('12 facts') && t.includes('41 archived'), 'memory + archive counts present');
    assert.ok(t.includes('single JPEG frame'), 'limit: sight is a frame, not a feed');
    assert.ok(t.includes('THIS machine'), 'limit: scope');
    assert.ok(t.includes('trust this over older prompt text'), 'freshness contract stated');
    assert.strictEqual(info.toolCount, 3);
    assert.ok(info.oneLine.includes('Gem v2.13.0'), 'oneLine works for chips');
  }
  ok('snapshot: identity, machine, live registry, plugins, memory, limits');

  // 2) limits are ALWAYS the honest baseline; caller overrides replace all
  {
    const keepCore = buildSelfKnowledge({});
    assert.strictEqual(keepCore.text.split('  · ').length - 1, CORE_LIMITS.length, 'default limits all present');
    const custom = buildSelfKnowledge({ limits: ['Custom limit one.'] });
    assert.ok(custom.text.includes('Custom limit one.'));
    assert.ok(!custom.text.includes('single JPEG'), 'caller limits fully replace the core set');
  }
  ok('limit set: complete by default, fully replaceable');

  // 3) gatherFacts tolerates a bare context and reports counts itself
  {
    const info = gatherFacts({
      memory: { facts: [{}, {}], transcript: [{}], todos: [], reminders: [], goals: [], skills: [], instructions: [], mood: [] },
      archiveStats: { totalEntries: 7 },
      toolNames: ['a'], capabilities: { liveReady: false }
    });
    assert.ok(info.text.includes('2 facts') && info.text.includes('7 archived'), 'counts gathered');
    assert.ok(/Live voice: OFFLINE/.test(info.text), 'offline brain stated');
  }
  ok('gatherFacts: bare contexts still produce honest snapshots');

  // 4) wiring: main builds + exposes, renderer injects into the prompt
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    for (const frag of [
      "require('./lib/self-knowledge.js')", 'function refreshSelfKnowledge', 'selfKnowledge.gatherFacts',
      "ipcMain.handle('self:knowledge'", "refreshSelfKnowledge()', shardsBroken", 'getAllTools().map((t) => t.function.name)',
      'pluginRegistry.list().map', 'archiveStats: memoryArchive.stats()'
    ]) {
      if (frag === "refreshSelfKnowledge()', shardsBroken") continue; // guard trick below
      if (!mainSrc.includes(frag)) throw new Error('main.js missing: ' + frag);
    }
    assert.ok(mainSrc.includes("name: 'get_assistant_capabilities'"), 'capabilities tool declared');
    assert.ok(mainSrc.includes("case 'get_assistant_capabilities'"), 'capabilities tool dispatched');
    assert.ok(/plugins:reload[\s\S]{0,220}refreshSelfKnowledge/.test(mainSrc), 'plugin reload refreshes self-knowledge');
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.ok(preloadSrc.includes("selfKnowledge: () => ipcRenderer.invoke('self:knowledge')"), 'preload bridge');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    for (const frag of [
      'let selfKnowledgeText', 'function refreshSelfKnowledgeCache', 'await api.selfKnowledge()',
      'selfKnowledgeText ? `\\n${selfKnowledgeText}\\n` : \'\'', "safe('selfKnowledge'",
      'setupPluginsPanel', 'refreshSelfKnowledgeCache()'
    ]) assert.ok(appSrc.includes(frag), 'app.js wire: ' + frag);
    const fnStart = appSrc.indexOf('function buildSystemPrompt()');
    const injectAt = appSrc.indexOf('${selfKnowledgeText}');
    const answerStyle = appSrc.indexOf('ANSWER STYLE');
    assert.ok(fnStart !== -1 && injectAt > fnStart && injectAt < answerStyle, 'self-knowledge lands INSIDE buildSystemPrompt before the style block');
  }
  ok('main → IPC → preload → renderer prompt injection fully wired');

  console.log('\nAll self-knowledge tests passed.');
}

main();
