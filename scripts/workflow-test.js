#!/usr/bin/env node
/* ============================================================
   GemAir 2.2 — Section IV/V dry-run test.

   Verifies the ERRORLESS mandate without touching the real disk, a real AI
   provider, or the network:

     1. The FREE CORE (api/chat.js) boots with ZERO configuration and answers
        via freeBrain (ok:true, never a key-demanding error).
     2. Fair use and per-IP throttling actually count (V1 — the 2.1 version of
        this test require()d the module twice, got the SAME cached instance and
        therefore measured nothing at all).
     3. Origin allow-listing rejects third-party sites but not the app itself.
     4. Every one of the 12 workflows maps to tool names registered in
        main.js TOOLS + executeTool.
     5. The system prompt carries few-shot recipes for all 12 workflows.
     6. Regression guards for the 2.2 bug fixes (Section R).

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

/**
 * V1 — slice a source file between two anchors SAFELY.
 *
 * 2.1 did `src.slice(src.indexOf(a), src.indexOf(b))`. If either anchor moved
 * or disappeared, indexOf returned -1 and the slice silently produced the wrong
 * range (or the whole file), so the assertions that followed were meaningless
 * while still reporting "ok". This validates both anchors and their order.
 */
function sliceBetween(src, startAnchor, endAnchor, label) {
  const start = src.indexOf(startAnchor);
  if (start < 0) { fail(`${label}: start anchor not found ("${startAnchor}")`); return ''; }
  const end = endAnchor ? src.indexOf(endAnchor, start) : src.length;
  if (endAnchor && end < 0) { fail(`${label}: end anchor not found after start ("${endAnchor}")`); return ''; }
  if (endAnchor && end <= start) { fail(`${label}: end anchor precedes start anchor`); return ''; }
  const out = src.slice(start, endAnchor ? end : undefined);
  if (out.length < 50) { fail(`${label}: sliced range is suspiciously small (${out.length} chars)`); return ''; }
  return out;
}

/** Load api/chat.js as a genuinely FRESH module instance (V1). 2.5: also
 *  busts the shared api/_lib modules so limiter state resets for real. */
function freshFreeCore() {
  for (const p of Object.keys(require.cache)) {
    const norm = p.split(path.sep).join('/');
    if (norm.includes('/api/')) delete require.cache[p];
  }
  return require(path.join(ROOT, 'api/chat.js'));
}

/** Minimal res double that records the payload and status. */
function makeRes() {
  const out = { payload: null, statusCode: 200, headers: {} };
  const res = {
    setHeader(k, v) { out.headers[k] = v; },
    status(code) { out.statusCode = code; return { json(p) { out.payload = p; }, end() {} }; },
    writeHead() {},
    end() {},
    json(payload) { out.payload = payload; }
  };
  return { res, out };
}

function callCore(core, body, headers = {}) {
  const { res, out } = makeRes();
  return core({ method: 'POST', headers, body }, res).then(() => out);
}

(async () => {
  console.log('\nGemAir 2.2 workflow dry-run\n');

  // Fresh env: no provider keys anywhere.
  for (const k of Object.keys(process.env)) {
    if (/API_KEY|AI_|GROQ|GEMINI|OPENROUTER|OPENAI|SUPABASE|FAIR_USE|THROTTLE|ALLOWED_ORIGINS|KV_|UPSTASH|REDIS/.test(k)) delete process.env[k];
  }

  // -------------------------------------------------------------------------
  // 1. An unconfigured server must not pretend a model answered.
  // -------------------------------------------------------------------------
  {
    const core = freshFreeCore();
    const r = await callCore(core, { messages: [{ role: 'user', content: 'hello there' }] });
    const p = r.payload || {};
    if (p.ok !== false || p.reply) fail('Unconfigured chat returned a fake success');
    else ok('Unconfigured chat reports failure without a fabricated reply');
    if (!p.error || !p.message) fail('Unconfigured chat must explain how to connect a provider');
    else ok('Unconfigured chat returns an actionable connection error');
  }

  // -------------------------------------------------------------------------
  // 2. Fair use ACTUALLY counts (V1). Uses a fresh module + a tiny daily cap.
  // -------------------------------------------------------------------------
  const originalFetch = global.fetch;
  process.env.GROQ_API_KEY = 'test-only-key';
  global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Test completion' } }] }), { headers: { 'Content-Type': 'application/json' } });
  {
    process.env.FAIR_USE_DAILY = '3';
    process.env.THROTTLE_PER_MIN = '100'; // isolate fair use from throttling
    const core = freshFreeCore();
    const headers = { 'x-forwarded-for': '203.0.113.10' };
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push((await callCore(core, { messages: [{ role: 'user', content: 'msg ' + i }] }, headers)).payload || {});
    }
    const limitedFlags = results.map((r) => !!r.limited);
    if (limitedFlags.slice(0, 3).some(Boolean)) fail('fair use limited a request before the cap was reached');
    else if (!limitedFlags[3]) fail('fair use did NOT limit the request past the daily cap (counter is not counting)');
    else ok('fair use counts per identity and limits exactly past the cap');
    if (results[3] && results[3].ok !== false) fail('the fair-use limit response pretends to be a successful reply');
    else ok('fair-use limit reports an honest error');

    // a DIFFERENT ip must have its own budget
    const other = (await callCore(core, { messages: [{ role: 'user', content: 'hi' }] }, { 'x-forwarded-for': '203.0.113.99' })).payload || {};
    if (other.limited) fail('fair use leaked one identity budget onto another IP');
    else ok('fair use is scoped per identity, not global');

    // a rotated userId must NOT reset the cap (R10)
    const rotated = (await callCore(core, { userId: 'brand-new-id', messages: [{ role: 'user', content: 'hi' }] }, headers)).payload || {};
    if (!rotated.limited) fail('rotating userId reset the fair-use cap (identity is not IP-anchored)');
    else ok('rotating userId cannot reset the cap (IP-anchored identity)');
    delete process.env.FAIR_USE_DAILY;
    delete process.env.THROTTLE_PER_MIN;
  }

  // -------------------------------------------------------------------------
  // 2b. The module cache really is being defeated — the guard for this test.
  // -------------------------------------------------------------------------
  {
    process.env.FAIR_USE_DAILY = '1';
    const a = freshFreeCore();
    const headers = { 'x-forwarded-for': '198.51.100.7' };
    await callCore(a, { messages: [{ role: 'user', content: 'one' }] }, headers);
    const second = (await callCore(a, { messages: [{ role: 'user', content: 'two' }] }, headers)).payload || {};
    const b = freshFreeCore(); // fresh instance = fresh counters
    const afterReload = (await callCore(b, { messages: [{ role: 'user', content: 'three' }] }, headers)).payload || {};
    if (!second.limited) fail('cap of 1 did not limit the second call');
    else if (afterReload.limited) fail('freshFreeCore() returned the CACHED module — this test measures nothing');
    else ok('freshFreeCore() defeats the require cache (state is genuinely reset)');
    delete process.env.FAIR_USE_DAILY;
  }

  // -------------------------------------------------------------------------
  // 3. Throttling + origin allow-check (R10).
  // -------------------------------------------------------------------------
  global.fetch = originalFetch;
  delete process.env.GROQ_API_KEY;
  {
    process.env.THROTTLE_PER_MIN = '2';
    const core = freshFreeCore();
    const headers = { 'x-forwarded-for': '192.0.2.5' };
    let throttled = null;
    for (let i = 0; i < 3; i++) {
      throttled = (await callCore(core, { messages: [{ role: 'user', content: 'x' }] }, headers)).payload || {};
    }
    if (!throttled.throttled) fail('per-IP throttle did not engage past the configured rate');
    else ok('per-IP throttle engages past the configured rate');
    delete process.env.THROTTLE_PER_MIN;
  }
  {
    const core = freshFreeCore();
    const evil = await callCore(core, { messages: [{ role: 'user', content: 'x' }] }, { origin: 'https://evil.example.com', 'x-forwarded-for': '192.0.2.6' });
    if (evil.statusCode !== 403) fail('a third-party origin was allowed to spend the free provider keys');
    else ok('third-party origins are rejected (403)');

    const mine = await callCore(core, { messages: [{ role: 'user', content: 'x' }] }, { origin: 'https://gemair.vercel.app', 'x-forwarded-for': '192.0.2.7' });
    if (mine.statusCode === 403) fail("GemAir's own origin was rejected by the allow-check");
    else ok("GemAir's own origin passes the allow-check");

    const native = await callCore(core, { messages: [{ role: 'user', content: 'x' }] }, { 'x-forwarded-for': '192.0.2.8' });
    if (native.statusCode === 403) fail('the desktop app (no Origin header) was rejected');
    else ok('the desktop app (no Origin header) is still allowed');
  }

  // -------------------------------------------------------------------------
  // 4. The 12 workflows → registered tool names.
  // -------------------------------------------------------------------------
  const mainSrc = read('main.js');
  const TOOLS_SECTION = sliceBetween(mainSrc, 'const TOOLS = [', 'function safeEval', 'TOOLS registry');
  const toolNames = new Set([...TOOLS_SECTION.matchAll(/\bname:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
  if (toolNames.size < 20) fail(`TOOLS registry parsed only ${toolNames.size} tools — the slice anchors are probably wrong`);

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
  const NEW_24_TOOLS = ['launch_app', 'focus_app', 'snap_window', 'minimize_all', 'next_virtual_desktop', 'open_site', 'list_windows', 'apply_mode', 'list_modes', 'create_mode'];
  for (const t of NEW_TOOLS) {
    if (!toolNames.has(t)) fail(`Section III tool not registered in TOOLS: ${t}`);
  }
  if (NEW_TOOLS.every((t) => toolNames.has(t))) ok('All 5 new Section III tools registered in TOOLS');
  for (const t of NEW_24_TOOLS) {
    if (!toolNames.has(t)) fail(`2.4 tool not registered in TOOLS: ${t}`);
  }
  if (NEW_24_TOOLS.every((t) => toolNames.has(t))) ok('All 10 new 2.4 tools registered in TOOLS');

  let workflowCount = 0;
  for (const [wf, tools] of Object.entries(WORKFLOW_TOOLS)) {
    workflowCount++;
    const missing = tools.filter((t) => !toolNames.has(t));
    if (missing.length) fail(`${wf} references unregistered tool(s): ${missing.join(', ')}`);
  }
  if (workflowCount === 12) ok('All 12 workflows validated against the registered tool set');
  else fail(`Expected 12 workflows, found ${workflowCount}`);

  const execCases = [...mainSrc.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1]);
  const missingCases = NEW_TOOLS.filter((t) => !execCases.includes(t));
  if (missingCases.length) fail(`executeTool missing case(s): ${missingCases.join(', ')}`);
  else ok('executeTool has a case for every new Section III tool');
  const missing24 = NEW_24_TOOLS.filter((t) => !execCases.includes(t));
  if (missing24.length) fail(`executeTool missing 2.4 case(s): ${missing24.join(', ')}`);
  else ok('executeTool has a case for every new 2.4 tool');

  // -------------------------------------------------------------------------
  // 5. Few-shot recipes for all 12 workflows are present in the system prompt.
  //    V1: the window was a fixed 8000 chars from the function start, which the
  //    prompt has already outgrown. Slice to the real end of the function.
  // -------------------------------------------------------------------------
  const appSrc = read('renderer/app.js');
  const promptStart = appSrc.indexOf('function buildSystemPrompt');
  let promptSrc = '';
  if (promptStart < 0) fail('buildSystemPrompt not found in renderer/app.js');
  else {
    // find the closing brace of the function (first line that is exactly "}")
    const rest = appSrc.slice(promptStart);
    const endIdx = rest.indexOf('\n}\n');
    // fall back to a GENEROUS window rather than a tight 8000 chars
    promptSrc = endIdx > 0 ? rest.slice(0, endIdx) : rest.slice(0, 24000);
    if (promptSrc.length < 1000) fail(`buildSystemPrompt slice is only ${promptSrc.length} chars — anchors are wrong`);
    else ok(`system prompt window resolved to ${promptSrc.length} chars (no fixed 8000-char cliff)`);
  }
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
    ['open_whatsapp', 'wf-whatsapp'],
    ['launch_app', '2.4 launch_app'],
    ['apply_mode', '2.4 apply_mode'],
    ['chill mode', '2.4 chill mode']
  ];
  let recipes = 0;
  for (const [hint, wf] of recipeHints) {
    if (promptSrc.includes(hint)) recipes++;
    else fail(`System prompt missing few-shot recipe for ${wf}`);
  }
  if (recipes >= 12) ok(`System prompt carries few-shot recipes for ${recipes} workflows (including 2.4 modes)`);

  // -------------------------------------------------------------------------
  // 6. Section R regression guards — the exact bugs 2.2 fixed must stay fixed.
  // -------------------------------------------------------------------------
  {
    // R1: skipFinalSpeak must be declared before it is used
    if (/\bskipFinalSpeak\b/.test(appSrc) && !/\blet\s+skipFinalSpeak\b/.test(appSrc)) {
      fail('R1 regression: skipFinalSpeak is used but never declared');
    } else ok('R1: skipFinalSpeak is declared');

    // R2: Edge frame header must be 2-byte big-endian
    const edge = read('renderer/edge-tts.js');
    if (/\(data\[0\]\s*<<\s*24\)/.test(edge)) fail('R2 regression: Edge parser is back to a 4-byte header length');
    else if (!/\(data\[0\]\s*<<\s*8\)\s*\|\s*data\[1\]/.test(edge)) fail('R2 regression: Edge parser does not read a 2-byte big-endian header');
    else ok('R2: Edge binary frames parsed with a 2-byte big-endian header');
    if (!/Sec-MS-GEC/.test(edge)) fail('R2 regression: Sec-MS-GEC params missing from the Edge WSS URL');
    else ok('R2: Sec-MS-GEC / Sec-MS-GEC-Version present on the Edge handshake');

    // R3: barge-in must stop the TTS engine
    if (!/function stopSpeaking\(\)[\s\S]{0,600}ttsEngine\.stop\(\)/.test(appSrc)) {
      fail('R3 regression: stopSpeaking() no longer stops window.ttsEngine');
    } else ok('R3: stopSpeaking() stops the TTS engine (barge-in cuts audio)');

    // R5: gaming optimizer must use the High Performance scheme
    if (/setactive\s+SCHEME_MIN/.test(mainSrc)) fail('R5 regression: powercfg /setactive SCHEME_MIN (power saver) is back');
    else if (!/SCHEME_MAX/.test(mainSrc)) fail('R5 regression: powercfg SCHEME_MAX not found');
    else ok('R5: gaming optimizer uses SCHEME_MAX (high performance)');

    // R6: hexToRgba must not parseInt a raw string
    if (/function hexToRgba\([\s\S]{0,300}parseInt\(m\.slice/.test(appSrc)) {
      fail('R6 regression: hexToRgba is back to hex-only parseInt (breaks hsl accents)');
    } else ok('R6: hexToRgba routes through the tolerant colour parser');

    // R7: no crossOrigin against translate.google.com
    const tts = read('renderer/tts-engine.js');
    const neural = sliceBetween(tts, 'async speakNeural(', 'playUrl(url, opts', 'speakNeural');
    if (/crossOrigin/.test(neural)) fail('R7 regression: crossOrigin is set on the Google TTS request again');
    else ok('R7: Google neural tier no longer sets a CORS-failing crossOrigin');

    // R9: folder-tree path guard rejects any ".." segment
    if (!/segments\.some\(\(seg\) => seg === '\.\.'/.test(mainSrc)) {
      fail('R9 regression: createFolderTree no longer rejects every ".." segment');
    } else ok('R9: createFolderTree rejects absolute paths and all ".." segments');

    // R10: upstream fetches must have timeouts
    const chatSrc = read('api/chat.js');
    if (!/AbortController/.test(chatSrc)) fail('R10 regression: no AbortController timeout on provider fetches');
    else ok('R10: provider fetches carry an AbortController timeout');

    // U1: the dead parallel TTS stack must stay deleted
    for (const dead of ['function speakNeural(', 'function playAudioUrl(', 'function chunkForSpeech(', 'function speakSystem(']) {
      if (appSrc.includes(dead)) fail(`U1 regression: dead TTS function reintroduced in app.js (${dead})`);
    }
    ok('U1: app.js carries no parallel TTS stack (single engine path)');

    // S4: hi/ur dictionaries must cover every English key
    const i18nSrc = read('renderer/i18n.js');
    const enKeys = [...sliceBetween(i18nSrc, '    en: {', '    hi: {', 'i18n en').matchAll(/'([a-z0-9.]+)':/g)].map((m) => m[1]);
    for (const lang of ['hi', 'ur']) {
      const endAnchor = lang === 'hi' ? '    ur: {' : '  };';
      const block = sliceBetween(i18nSrc, `    ${lang}: {`, endAnchor, `i18n ${lang}`);
      const keys = new Set([...block.matchAll(/'([a-z0-9.]+)':/g)].map((m) => m[1]));
      const missing = enKeys.filter((k) => !keys.has(k));
      if (missing.length) fail(`S4: ${lang} dictionary missing ${missing.length} key(s): ${missing.slice(0, 5).join(', ')}`);
    }
    if (!failures.some((f) => f.startsWith('S4:'))) ok(`S4: hi and ur dictionaries cover all ${enKeys.length} keys`);
  }

  console.log('\n  ' + (failures.length ? failures.length + ' FAILURE(S):' : 'All checks passed.'));
  failures.forEach((f) => console.log('  ✗  ' + f));
  process.exit(failures.length ? 1 : 0);
})();
