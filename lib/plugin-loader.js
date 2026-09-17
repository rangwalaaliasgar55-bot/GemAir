'use strict';
/* ============================================================
   GemAir — single-file drop-in plugin loader.
   ------------------------------------------------------------
   Concept shaped by Mark-LIII/LIV (FatihMakes, CC BY-NC — no
   upstream code copied, only the "adding a skill is moving a
   file" authoring pattern, reimplemented against GemAir's own
   tool-calling engine and risk-gating):

     plugins/hello.js
     ----------------------------------------------------------------
     module.exports = {
       PLUGIN: {
         name: 'hello_world',          // required, a-z0-9_, unique
         description: 'Say a friendly hello.',
         parameters: {                // optional JSON Schema object
           type: 'object',
           properties: { name: { type: 'string' } }
         },
         risk: 'safe'                 // optional: 'safe' | 'sensitive'
       },
       async run(args, context) {     // required
         return { message: `Hello, ${args.name || 'friend'}!` };
       }
     };
     ----------------------------------------------------------------

   - Every file at the top level of plugins/ whose name does NOT
     start with "_" is loaded. (_template.js is documentation.)
   - One bad plugin can never break the app or block other
     plugins: load errors and run-time throws are captured as
     plain error objects.
   - Declarations merge into the OpenAI-function-style tool list
     the AI model already sees; dispatch happens inside the
     existing permission-gated executor (sensitive plugins need a
     user-confirmed dialog unless coding auto-approve is on).
   - Plugins are files the user consciously placed in the folder;
     GemAir never downloads plugin code from the network.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const PLUGIN_NAME_RE = /^[a-z][a-z0-9_]{1,49}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate one module's exports; returns { error } or { meta, run }. */
function validatePlugin(exportsValue, file) {
  if (!isObject(exportsValue)) return { error: `Plugin ${file}: module must export an object ({ PLUGIN, run }).` };
  const meta = exportsValue.PLUGIN || exportsValue.TOOL;
  if (!isObject(meta)) return { error: `Plugin ${file}: missing PLUGIN (or TOOL) declaration object.` };
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!PLUGIN_NAME_RE.test(name)) {
    return { error: `Plugin ${file}: PLUGIN.name "${name}" must match ${PLUGIN_NAME_RE} (2-50 chars, lowercase snake_case).` };
  }
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (description.length < 8) return { error: `Plugin ${file}: PLUGIN.description must explain the skill (min 8 chars).` };
  let parameters = meta.parameters;
  if (parameters == null) parameters = { type: 'object', properties: {} };
  if (!isObject(parameters) || (parameters.type && parameters.type !== 'object')) {
    return { error: `Plugin ${file}: PLUGIN.parameters must be a JSON Schema object (type: "object").` };
  }
  const risk = meta.risk === 'sensitive' ? 'sensitive' : 'safe';
  if (typeof exportsValue.run !== 'function') return { error: `Plugin ${file}: missing async run(args, context) handler.` };
  return { meta: { name, description, parameters, risk }, run: exportsValue.run };
}

/**
 * Load every plugin file in `dir`. Never throws.
 * Returns { plugins: [{name, description, parameters, risk, file, run }],
 *           errors: [{file, message}] }
 */
function loadPlugins(dir, { builtinNames = new Set(), requirer = require, stat } = {}) {
  const result = { plugins: [], errors: [] };
  if (!dir) return result;
  let entries = [];
  try {
    if (stat ? !stat(dir) : !fs.existsSync(dir)) return result;
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    result.errors.push({ file: dir, message: `plugins folder unreadable: ${error.message}` });
    return result;
  }
  const seen = new Set(builtinNames);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    if (entry.name.startsWith('_')) continue; // _template.js & friends are docs
    const file = path.join(dir, entry.name);
    try {
      delete (requirer.cache || require.cache)[requirer.resolve ? requirer.resolve(file) : file];
      const exportsValue = requirer(file);
      const check = validatePlugin(exportsValue, entry.name);
      if (check.error) {
        result.errors.push({ file: entry.name, message: check.error });
        continue;
      }
      if (seen.has(check.meta.name)) {
        result.errors.push({ file: entry.name, message: `Plugin name "${check.meta.name}" collides with an existing tool or plugin.` });
        continue;
      }
      seen.add(check.meta.name);
      result.plugins.push({ ...check.meta, file: entry.name, run: check.run });
    } catch (error) {
      result.errors.push({ file: entry.name, message: (error && error.message) ? error.message.slice(0, 300) : String(error) });
    }
  }
  return result;
}

/**
 * Convert a plugin into the exact { type:'function', function:{...} } shape
 * GemAir's provider adapters already send to models.
 */
function toToolDeclaration(plugin) {
  return {
    type: 'function',
    function: { name: plugin.name, description: plugin.description, parameters: plugin.parameters }
  };
}

/** The context object handed to plugin run() — controlled surface only. */
function buildPluginContext(helpers) {
  const h = helpers || {};
  return Object.freeze({
    homeDir: h.homeDir || '',
    platform: h.platform || process.platform,
    version: h.version || '',
    userName: h.userName || '',
    notify: typeof h.notify === 'function' ? h.notify : () => {},
    log: typeof h.log === 'function' ? h.log : () => {}
  });
}

/**
 * Registry wrapper used by main.js: keeps load results, answers
 * has()/declaration()/risk()/run() and reload().
 */
function createPluginRegistry(dir, helpers, options = {}) {
  let builtinNames = options.builtinNames || new Set();
  let state = { plugins: [], errors: [] };
  const byName = new Map();

  function absorb() {
    byName.clear();
    for (const plugin of state.plugins) byName.set(plugin.name, plugin);
  }

  function reload(nextDir) {
    if (nextDir) dir = nextDir;
    state = loadPlugins(dir, { builtinNames });
    absorb();
    return state;
  }

  reload();

  return {
    reload,
    setBuiltins(names) { builtinNames = names; },
    list: () => state.plugins.map((p) => ({ name: p.name, description: p.description, risk: p.risk, file: p.file })),
    errors: () => state.errors.slice(),
    has: (name) => byName.has(name),
    get: (name) => byName.get(name) || null,
    declarations: () => state.plugins.map(toToolDeclaration),
    risk: (name) => (byName.has(name) ? byName.get(name).risk : null),
    async run(name, args) {
      const plugin = byName.get(name);
      if (!plugin) return { error: `Unknown plugin: ${name}` };
      try {
        const output = await plugin.run(isObject(args) ? args : {}, buildPluginContext(helpers));
        if (output == null) return { ok: true };
        if (typeof output === 'string') return { message: output.slice(0, 4000) };
        if (isObject(output)) {
          try { return JSON.parse(JSON.stringify(output)); } catch { return { error: `Plugin ${plugin.name}: returned a value that is not JSON-serializable.` }; }
        }
        return { result: String(output).slice(0, 4000) };
      } catch (error) {
        return { error: `Plugin ${plugin.name} failed: ${(error && error.message) ? error.message.slice(0, 300) : String(error)}` };
      }
    }
  };
}

module.exports = { loadPlugins, validatePlugin, toToolDeclaration, buildPluginContext, createPluginRegistry, PLUGIN_NAME_RE };
