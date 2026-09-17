#!/usr/bin/env node
'use strict';

// Drop-in plugin system tests (single-file skills, Mark-heritage authoring
// pattern reimplemented for GemAir). Real temp-dir fixtures for the loader;
// static/string checks for the main.js → preload → renderer wiring.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const pluginLoader = require(path.join(ROOT, 'lib/plugin-loader.js'));

console.log('\nGemAir — drop-in plugin system tests\n');

// ---------------------------------------------------------------------------
// Loader: discovery, validation, isolation
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-plugins-'));
  try {
    fs.writeFileSync(path.join(dir, 'hello.js'), `'use strict';
module.exports = {
  PLUGIN: {
    name: 'hello_world',
    description: 'Greets the user by name.',
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
    risk: 'safe'
  },
  async run(args, context) {
    return { message: 'Hello, ' + (args.name || context.userName || 'friend') + '!', platform: context.platform };
  }
};`);
    fs.writeFileSync(path.join(dir, 'risky.js'), `'use strict';
module.exports = {
  PLUGIN: { name: 'danger_touch', description: 'Pretends to change the system state.', risk: 'sensitive' },
  async run() { return { ok: true }; }
};`);
    fs.writeFileSync(path.join(dir, 'broken-no-run.js'), `'use strict';
module.exports = { PLUGIN: { name: 'no_runner', description: 'Has no run handler at all.' } };`);
    fs.writeFileSync(path.join(dir, 'broken-name.js'), `'use strict';
module.exports = { PLUGIN: { name: 'Bad Name!', description: 'Illegal name should be rejected.' }, async run() { return {}; } };`);
    fs.writeFileSync(path.join(dir, 'throws.js'), `'use strict';
throw new Error('boom at import time');`);
    fs.writeFileSync(path.join(dir, 'duplicate.js'), `'use strict';
module.exports = { PLUGIN: { name: 'hello_world', description: 'A colliding duplicate name.' }, async run() { return {}; } };`);
    // Underscore-prefixed files are documentation, never loaded.
    fs.writeFileSync(path.join(dir, '_template.js'), `'use strict';
module.exports = { PLUGIN: { name: 'template_skill', description: 'Starter template.' }, async run() { return {}; } };`);
    fs.writeFileSync(path.join(dir, 'note.txt'), 'not a plugin');
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'ignored.js'), `'use strict';
module.exports = { PLUGIN: { name: 'nested_skill', description: 'Nested folders are not scanned.' }, async run() { return {}; } };`);

    const result = pluginLoader.loadPlugins(dir);
    const names = result.plugins.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ['danger_touch', 'hello_world'], 'only valid top-level plugins load');
    assert.strictEqual(result.errors.length, 4, 'broken-name, broken-no-run, throws and the collision must all be reported');
    const files = result.errors.map((e) => e.file).sort();
    assert(files.includes('broken-name.js') && files.includes('broken-no-run.js') && files.includes('throws.js'), 'errors must name every offending file');
    // The name collision (duplicate.js vs hello.js, both claiming
    // 'hello_world') is order-dependent — exactly ONE of them must error.
    const collisionFiles = files.filter((f) => f === 'hello.js' || f === 'duplicate.js');
    assert.strictEqual(collisionFiles.length, 1, 'exactly one same-name plugin must be refused with a collision error');
    assert(!names.includes('template_skill'), '_-prefixed files must never load');
    assert(!names.includes('nested_skill'), 'plugins must be top-level single files');
    const risky = result.plugins.find((p) => p.name === 'danger_touch');
    assert.strictEqual(risky.risk, 'sensitive', 'risk flag survives loading');
    console.log('  ok   discovery: valid vs invalid vs underscore vs nested vs name-collision');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Declaration shape + builtin collision guard
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-plugins-'));
  try {
    fs.writeFileSync(path.join(dir, 'collision.js'), `'use strict';
module.exports = { PLUGIN: { name: 'web_search', description: 'Tries to shadow a builtin tool name.' }, async run() { return {}; } };`);
    fs.writeFileSync(path.join(dir, 'fresh.js'), `'use strict';
module.exports = { PLUGIN: { name: 'fresh_skill', description: 'A fresh unique skill.' }, async run() { return 'plain string result'; } };`);
    const result = pluginLoader.loadPlugins(dir, { builtinNames: new Set(['web_search']) });
    assert.strictEqual(result.plugins.length, 1, 'builtin name collision must be refused');
    assert.strictEqual(result.plugins[0].name, 'fresh_skill');
    assert.strictEqual(result.errors.length, 1);
    assert(/collides/.test(result.errors[0].message), 'collision error must say so');
    const decl = pluginLoader.toToolDeclaration(result.plugins[0]);
    assert.strictEqual(decl.type, 'function', 'declaration matches the OpenAI function-tool shape');
    assert.strictEqual(decl.function.name, 'fresh_skill');
    assert.strictEqual(decl.function.parameters.type, 'object');
    console.log('  ok   declaration shape + builtin-name collision guard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Registry: run(), error isolation, result normalization, reload
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-plugins-'));
  try {
    fs.writeFileSync(path.join(dir, 'echo.js'), `'use strict';
module.exports = {
  PLUGIN: { name: 'echo_back', description: 'Echoes the provided text.' },
  async run(args, context) { return { echo: args && args.text, user: context.userName, home: !!context.homeDir }; }
};`);
    fs.writeFileSync(path.join(dir, 'explode.js'), `'use strict';
module.exports = {
  PLUGIN: { name: 'explode_now', description: 'Always throws while running.' },
  async run() { throw new Error('kaboom'); }
};`);
    fs.writeFileSync(path.join(dir, 'badjson.js'), `'use strict';
module.exports = {
  PLUGIN: { name: 'circular_result', description: 'Returns a non-serializable value.' },
  async run() { const o = {}; o.self = o; return o; }
};`);

    const registry = pluginLoader.createPluginRegistry(dir, {
      homeDir: '/tmp/home', platform: 'linux', version: '9.9.9', userName: 'Tester',
      notify: () => {}, log: () => {}
    });
    assert(registry.has('echo_back'), 'registry must expose has()');
    assert.deepStrictEqual(registry.list().map((p) => p.name).sort(), ['circular_result', 'echo_back', 'explode_now']);

    const ok = await registry.run('echo_back', { text: 'hi' });
    assert.strictEqual(ok.echo, 'hi', 'run returns the plugin output');
    assert.strictEqual(ok.user, 'Tester', 'context.userName reaches the plugin');
    assert.strictEqual(ok.home, true, 'context.homeDir reaches the plugin');

    const boom = await registry.run('explode_now', {});
    assert(boom.error && /kaboom/.test(boom.error), 'a throwing plugin becomes a clean tool error, not a crash');

    const circular = await registry.run('circular_result', {});
    assert(circular.error && /JSON-serializable/.test(circular.error), 'non-serializable outputs convert to tool errors');

    const missing = await registry.run('nope', {});
    assert(missing.error, 'unknown plugin -> error, never a throw');

    // Reload picks up new files without a restart.
    fs.writeFileSync(path.join(dir, 'later.js'), `'use strict';
module.exports = { PLUGIN: { name: 'late_skill', description: 'Added after first scan.' }, async run() { return { ok: 1 }; } };`);
    registry.reload();
    assert(registry.has('late_skill'), 'reload() discovers plugins added later');
    console.log('  ok   registry run(): output, context surface, throw-isolation, hot reload');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Wiring: main.js merges plugins into the model-facing catalog and
  // dispatches them inside the same risk gates as built-ins.
  // -------------------------------------------------------------------------
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert(mainSrc.includes("require('./lib/plugin-loader')"), 'main.js must require the plugin loader');
  assert(mainSrc.includes('createPluginRegistry(PLUGINS_DIR'), 'main.js must build a registry over plugins/');
  assert(mainSrc.includes('function getAllTools()'), 'main.js must expose a merged catalog getter');
  assert(/TOOLS\.concat\(pluginRegistry\.declarations\(\)\)/.test(mainSrc), 'getAllTools() must merge built-ins + plugin declarations');
  // Every model-facing call site uses the merged catalog, so plugins are
  // actually callable from chat — not just loaded and ignored.
  for (const site of ['callChat(base, key, model, msgs, getAllTools())', 'body.tools = getAllTools()', 'selectRelevantTools(getAllTools(), reasonedMessages', 'selectRelevantTools(getAllTools(), allMessages']) {
    assert(mainSrc.includes(site), `missing merged-catalog call site: ${site}`);
  }
  assert(mainSrc.includes('pluginRegistry.has(name)'), 'executeToolNow must dispatch plugin names');
  assert(mainSrc.includes('pluginRegistry.risk(name)'), 'plugin risk must feed the risk gate');
  assert(/Run plugin skill\?/.test(mainSrc), 'sensitive plugins need a human confirmation dialog');
  assert(mainSrc.includes("ipcMain.handle('plugins:list'"), 'plugins:list IPC missing');
  assert(mainSrc.includes("ipcMain.handle('plugins:reload'"), 'plugins:reload IPC missing');
  assert(mainSrc.includes("ipcMain.handle('plugins:openFolder'"), 'plugins:openFolder IPC missing');
  console.log('  ok   main.js wiring: merged catalog, gated dispatch, IPC surface');

  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  for (const api of ['pluginsList', 'pluginsReload', 'pluginsOpenFolder']) {
    assert(preloadSrc.includes(api), `preload must expose ${api}`);
  }
  console.log('  ok   preload bridge: pluginsList / pluginsReload / pluginsOpenFolder');

  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  assert(htmlSrc.includes('data-section="plugins"'), 'index.html must contain the Plugins settings section');
  assert(htmlSrc.includes('data-ssection="plugins"'), 'settings nav must include Plugins');
  assert(htmlSrc.includes('id="pluginsReloadBtn"') && htmlSrc.includes('id="pluginsOpenFolderBtn"'), 'plugins panel buttons missing');
  assert(appSrc.includes('function setupPluginsPanel()'), 'app.js must wire the plugins panel');
  assert(appSrc.includes("safe('pluginsPanel', setupPluginsPanel)"), 'plugins panel must be part of boot');
  assert(appSrc.includes('renderPluginsPanel'), 'plugins panel must render the live list');
  console.log('  ok   renderer: Plugins settings section + panel wiring + boot hook');

  // Template file: it must be a VALID plugin the syntactic checker accepts as
  // fixture, AND its shipped dir listing must ignore it at run time.
  const template = require(path.join(ROOT, 'plugins/_template.js'));
  const check = pluginLoader.validatePlugin(template, '_template.js');
  assert(!check.error, '_template.js must itself validate (it is the canonical example)');
  assert.strictEqual(check.meta.name, 'my_skill_name');
  console.log('  ok   plugins/_template.js validates as the canonical example');

  console.log('\nAll plugin-system tests passed.\n');
})().catch((error) => { console.error(error); process.exit(1); });
