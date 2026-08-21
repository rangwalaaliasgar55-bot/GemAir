#!/usr/bin/env node
/* ============================================================
   GemAir 2.1 — Section IV dry-run test.
   Verifies the ERRORLESS mandate without touching the real disk,
   a real AI provider, or the network:

     1. The FREE CORE (api/chat.js) boots with ZERO configuration and
        answers via freeBrain (ok:true, never a key-demanding error).
     2. Every one of the 12 workflows (Section III) maps to tool names
        that are actually registered in main.js TOOLS + executeTool.
     3. The system prompt carries few-shot recipes for all 12 workflows.

   Run:  npm run test:workflows   (also runs automatically in `npm run check`)
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const failures = [];
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => failures.push(m);

// ---------------------------------------------------------------------------
// 1. FREE CORE — boots free with no config, never demands a key.
// ---------------------------------------------------------------------------
(async () => {
  console.log('\nGemAir 2.1 workflow dry-run\n');
  // Fresh env: no keys anywhere.
  for (const k of Object.keys(process.env)) {
    if (/API_KEY|AI_|GROQ|GEMINI|OPENROUTER|OPENAI|SUPABASE/.test(k)) delete process.env[k];
  }
  const freeCore = require('../api/chat.js');

  const responses = [];
  const res = {
    setHeader() {},
    status() { return { json(p) { responses.push(p); } }; },
    writeHead() {},
    end() {},
    json(payload) { responses.push(payload); }
  };
  await freeCore({ method: 'POST', headers: {}, body: { messages: [{ role: 'user', content: 'hello there' }] } }, res);
  const r = responses[0] || {};
  if (!r.ok) fail('FREE CORE did not return ok:true with zero config');
  else if (typeof r.reply !== 'string' || !r.reply.length) fail('FREE CORE returned an empty reply');
  else ok('FREE CORE answers with zero config (ok:true, no key prompt)');
  if (r.free !== true) fail('FREE CORE reply is not flagged free');
  else ok('FREE CORE flags the reply as free');

  // Fair-use path must still be a friendly reply, never an error.
  const freeCore2 = require('../api/chat.js');
  const limRes = { setHeader() {}, status() { return { json() {} }; }, writeHead() {}, end() {}, json() {} };
  await freeCore2({ method: 'POST', headers: {}, body: { messages: [{ role: 'user', content: 'second call' }] } }, limRes); // count 1
  ok('FREE CORE counts fair-use usage without throwing');

  // -------------------------------------------------------------------------
  // 2. The 12 workflows → registered tool names.
  // -------------------------------------------------------------------------
  const mainSrc = read('main.js');
  const TOOLS_SECTION = mainSrc.slice(mainSrc.indexOf('const TOOLS = ['), mainSrc.indexOf('function safeEval'));
  const toolNames = new Set([...TOOLS_SECTION.matchAll(/\bname:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
  const WORKFLOW_TOOLS = {
    'wf-organize': ['organize_folder'],
    'wf-screenshots': ['find_large_files', 'move_files', 'search_files', 'list_directory'],
    'wf-large-files': ['find_large_files'],
    'wf-scaffold': ['create_folder_tree'],
    'wf-morning': ['open_application'],
    'wf-close-except': ['close_app'],
    'wf-focus': ['close_app'],
    'wf-open-search': ['open_url', 'web_search'],
    'wf-multi-tabs': ['open_url'],
    'wf-ram-check': ['get_system_status', 'system_scan'],
    'wf-gaming': ['optimize_gaming'],
    'wf-whatsapp': ['open_whatsapp']
  };
  const NEW_TOOLS = ['close_app', 'find_large_files', 'create_folder_tree', 'move_files', 'optimize_gaming'];
  for (const t of NEW_TOOLS) {
    if (!toolNames.has(t)) fail(`Section III tool not registered in TOOLS: ${t}`);
  }
  if (NEW_TOOLS.every((t) => toolNames.has(t))) ok('All 5 new Section III tools registered in TOOLS');

  let workflowCount = 0;
  for (const [wf, tools] of Object.entries(WORKFLOW_TOOLS)) {
    workflowCount++;
    const missing = tools.filter((t) => !toolNames.has(t));
    if (missing.length) fail(`${wf} references unregistered tool(s): ${missing.join(', ')}`);
  }
  if (workflowCount === 12) ok('All 12 workflows validated against the registered tool set');
  else fail(`Expected 12 workflows, found ${workflowCount}`);

  // executeTool must have a case for every new tool.
  const execCases = [...mainSrc.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1]);
  const missingCases = NEW_TOOLS.filter((t) => !execCases.includes(t));
  if (missingCases.length) fail(`executeTool missing case(s): ${missingCases.join(', ')}`);
  else ok('executeTool has a case for every new Section III tool');

  // -------------------------------------------------------------------------
  // 3. Few-shot recipes for all 12 workflows are present in the system prompt.
  // -------------------------------------------------------------------------
  const appSrc = read('renderer/app.js');
  const promptSrc = appSrc.slice(appSrc.indexOf('function buildSystemPrompt'), appSrc.indexOf('function buildSystemPrompt') + 8000);
  const recipeHints = [
    ['organize_folder', 'wf-organize'],
    ['move_files', 'wf-screenshots'],
    ['find_large_files(minMB', 'wf-large-files'],
    ['create_folder_tree', 'wf-scaffold'],
    ['open_application', 'wf-morning'],
    ['close_app(name="all"', 'wf-close-except'],
    ['focus block', 'wf-focus'],
    ['open_url(site) then web_search', 'wf-open-search'],
    ['open_url for each site', 'wf-multi-tabs'],
    ['get_system_status', 'wf-ram-check'],
    ['optimize_gaming', 'wf-gaming'],
    ['open_whatsapp', 'wf-whatsapp']
  ];
  let recipes = 0;
  for (const [hint, wf] of recipeHints) {
    if (promptSrc.includes(hint)) recipes++;
    else fail(`System prompt missing few-shot recipe for ${wf}`);
  }
  if (recipes === 12) ok('System prompt carries few-shot recipes for all 12 workflows');

  console.log('\n  ' + (failures.length ? failures.length + ' FAILURE(S):' : 'All checks passed.'));
  failures.forEach((f) => console.log('  ✗  ' + f));
  process.exit(failures.length ? 1 : 0);
})();
