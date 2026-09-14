#!/usr/bin/env node
'use strict';

/**
 * Desktop autonomy + island tab awareness contracts.
 *
 * Two behaviours are pinned here that were both "improvements" and safety
 * properties, so they must not regress silently:
 *
 *  A. The autonomous desktop agent may only act under a grant, and that grant
 *     must be scoped to ONE task and released when the run ends. The previous
 *     design prompted per action, which pushed users to flip the *global*
 *     auto-approve setting to get anything done — strictly worse than what it
 *     replaced. A run-scoped grant plus an action budget is the middle ground.
 *  B. The island's tab ledger must measure dwell time from real focus changes,
 *     label where a tab reading came from (live extension vs window title), and
 *     never report a stale browser tab as current.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const { selectRelevantTools, INTENT_HINTS } = require('../lib/tool-router');
const checks = [];
const ok = (label) => { checks.push(label); console.log('  ok   ' + label); };

// ---------------------------------------------------------------------------
// A. the tool exists, is gated, and is described as the autonomous path
// ---------------------------------------------------------------------------
const toolDecl = mainSrc.split('\n').find((line) => line.includes("name: 'run_desktop_task'")) || '';
assert.ok(toolDecl, 'run_desktop_task must be declared in TOOLS');
assert.ok(/REAL mouse and keyboard/i.test(toolDecl), 'the tool description must be explicit that it drives the real input devices');
assert.ok(/required: \['task'\]/.test(toolDecl), 'task must be a required parameter');
assert.ok(/maxSteps/.test(toolDecl), 'the caller must be able to bound the step budget');
assert.ok(/run_desktop_task: 'computer'/.test(mainSrc), 'run_desktop_task must sit in the gated computer tier, not "safe"');
ok('run_desktop_task is declared, task-required, and computer-tier gated');

// ---------------------------------------------------------------------------
// B. the consent grant is scoped and always released
// ---------------------------------------------------------------------------
assert.ok(/let computerRunGrant = null;/.test(mainSrc), 'the grant must be module state, reset per process');
assert.ok(/releaseComputerRunGrant\(\);/.test(mainSrc), 'releaseComputerRunGrant must be called');
const agentBody = mainSrc.slice(mainSrc.indexOf('async function computerUseAgent('), mainSrc.indexOf('// Deterministic, KEYLESS fallback brain'));
assert.ok(/\} finally \{[\s\S]*?releaseComputerRunGrant\(\);/.test(agentBody),
  'the grant must be released in the agent run\'s `finally`, so a throw cannot leave the agent approved');
const gateBody = mainSrc.slice(mainSrc.indexOf('async function gateComputerUse('), mainSrc.indexOf('async function getAgentScreenSize'));
assert.ok(gateBody.indexOf('if (computerRunGrant)') < gateBody.indexOf('profile.computerUseAuto'),
  'the run grant must be consulted before the global auto-approve setting');
assert.ok(/RUN_BUDGET_EXHAUSTED/.test(gateBody), 'a granted run must still be bounded by an action budget');
assert.ok(/computerRunGrant\.actions \+= 1;/.test(gateBody), 'every gated action must be counted against the budget');
assert.ok(/Only allow this if you are watching the screen/.test(mainSrc),
  'the one-time task dialog must say what the user is approving');
ok('consent is granted per task, counted, budgeted, and released on exit');

// ---------------------------------------------------------------------------
// C. the loop perceives, notices repetition, and reports honestly
// ---------------------------------------------------------------------------
const agentSrc = mainSrc.slice(mainSrc.indexOf('async function computerUseAgent('), mainSrc.indexOf('// Deterministic, KEYLESS fallback brain'));
assert.ok(/windowTools\.getFocusedWindow\(\)/.test(agentSrc), 'each step must know which window is focused');
assert.ok(/windowTools\.listWindows\(\)/.test(agentSrc), 'each step must know what windows are open');
assert.ok(/Steps so far/.test(agentSrc), 'the model must see its own history so it does not repeat itself');
assert.ok(/repeatStreak >= 1/.test(agentSrc), 'a repeated identical action must be interrupted with a nudge');
assert.ok(/failureStreak >= 2/.test(agentSrc), 'two failed steps must stop rather than burn the budget');
assert.ok(/The connected brain may not support tool calling/.test(agentSrc),
  'a model with no tool calls must be reported as a capability problem, not silence');
assert.ok(/actionsTaken/.test(mainSrc.slice(mainSrc.indexOf("case 'run_desktop_task'"))), 'the tool result must report how many actions ran');
assert.ok(!/computerUseAuto = true/.test(agentSrc), 'the agent must never write the global auto-approve preference');
ok('agent loop perceives focus, guards against loops, and reports capability gaps');

// ---------------------------------------------------------------------------
// D. the router offers the agent for multi-step phrasings only
// ---------------------------------------------------------------------------
const hintedFor = (query) => {
  const set = new Set();
  for (const hint of INTENT_HINTS) if (hint.re.test(query)) hint.tools.forEach((name) => set.add(name));
  return set;
};
assert.ok(hintedFor('fill in the sign-up form and submit it').has('run_desktop_task'), 'a form-filling task must surface the desktop agent');
assert.ok(hintedFor('click submit then type my address on screen').has('run_desktop_task'), 'mouse/keyboard phrasings must surface it');
assert.ok(!hintedFor('what is the weather in Indore').has('run_desktop_task'), 'an unrelated question must not');
assert.ok(!hintedFor('remind me to call mom at 6').has('run_desktop_task'), 'reminders must not');
const catalog = ['run_desktop_task', 'web_search', 'get_weather', 'set_reminder', 'move_mouse', 'list_directory'].map((name) => ({
  type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } }
}));
assert.ok(Array.isArray(selectRelevantTools(catalog, [{ role: 'user', content: 'hello' }], { limit: 8 })), 'the router must never throw on a short catalog');
ok('tool routing offers autonomous control only for physical multi-step intents');

// ---------------------------------------------------------------------------
// E. island tab ledger behaviour (real service, temp userData)
// ---------------------------------------------------------------------------
const { AttentionService } = require('../lib/attention/service');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemair-tabs-'));
  const service = new AttentionService({ userDataDir: dir });
  const base = Date.now();
  assert.deepStrictEqual(service.tabs(), [], 'no samples yet means no tabs');

  service.onSample({ app: 'chrome', title: 'Q3 budget — Google Sheets - Google Chrome', at: base, idleSeconds: 0 });
  service.onSample({ app: 'chrome', title: 'Q3 budget — Google Sheets - Google Chrome', at: base + 5000, idleSeconds: 0 });
  let tabs = service.tabs(6, base + 5000);
  assert.strictEqual(tabs.length, 1, 'the same tab re-sampled must not create a second entry');
  assert.strictEqual(tabs[0].label, 'Q3 budget — Google Sheets', 'browser chrome suffix must be trimmed off the label');
  assert.strictEqual(tabs[0].live, true, 'the current tab is live');

  service.onSample({ app: 'code', title: 'service.js — GemAir', at: base + 65000, idleSeconds: 0 });
  tabs = service.tabs(6, base + 65000);
  assert.strictEqual(tabs.length, 2, 'switching windows opens a second tab entry');
  assert.strictEqual(tabs[0].label, 'service.js — GemAir', 'newest tab must sort first');
  assert.strictEqual(tabs[0].current, true, 'the newest tab is the current one');
  assert.strictEqual(tabs[1].label, 'Q3 budget — Google Sheets', 'the tab that was left stays in the strip');
  // Dwell is measured open→left (65s: 60s of presence after the re-sample plus
  // the 5s before it), NOT as a count of poll samples.
  assert.ok(Math.abs(tabs[1].ms - 65000) <= 1000, `left tab dwell should be ~65s, got ${tabs[1].ms}`);
  assert.strictEqual(tabs[1].live, false, 'a left tab is no longer live');

  // Idle samples are not tabs (nobody was "on" idle).
  const before = service.tabs().length;
  service.onSample({ app: 'idle', title: '', at: base + 70000, idleSeconds: 600 });
  assert.strictEqual(service.tabs().length, before, 'idle must not add a tab');

  // A fresh extension tab is reported with its real title and marked live.
  service.onBrowserTab({ url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox (4) - Gmail', browser: 'chrome' });
  service.onSample({ app: 'chrome', title: 'mail.google.com', at: Date.now(), idleSeconds: 0 });
  const state = service.islandState(new Date());
  assert.ok(state.tab, 'islandState must carry the current tab');
  assert.strictEqual(state.tab.source, 'extension', 'a live extension tab must be labelled as the source');
  assert.match(state.tab.title, /Inbox \(4\) - Gmail/, 'the extension tab title must win over the bare URL host');
  assert.strictEqual(state.tab.live, true);

  // GemAir's own view is reported and survives a snapshot refresh.
  service.setAppView('town');
  assert.strictEqual(service.islandState(new Date()).appView, 'town', 'the island must know which GemAir tab is showing');
  service.stop();
  ok('tab ledger measures dwell, source, and GemAir view correctly');
}

// The ledger is memory-only: nothing about where someone clicked must persist.
{
  const persisted = fs.readFileSync(path.join(ROOT, 'lib', 'attention', 'store.js'), 'utf8');
  assert.ok(!/tabLedger/.test(persisted), 'the tab ledger must never be written to the attention store');
  const serviceSrc = fs.readFileSync(path.join(ROOT, 'lib', 'attention', 'service.js'), 'utf8');
  const trackTabBody = serviceSrc.slice(serviceSrc.indexOf('trackTab(context'), serviceSrc.indexOf('/** Recent tabs with live dwell'));
  assert.ok(!/this\.store\.update/.test(trackTabBody), 'tab tracking must not write to disk on every poll sample');
  ok('tab activity stays in memory (nothing written to disk per sample)');
}

// ---------------------------------------------------------------------------
// F. the new air: surface is registered everywhere it must be
// ---------------------------------------------------------------------------
for (const [file, needles] of [
  ['lib/attention/ipc.js', ['air:setAppView', 'air:tabs', 'air:focusTab']],
  ['preload.js', ["'air:setAppView'", "'air:tabs'", "'air:focusTab'"]],
  ['renderer/preview/bridge.js', ["'air:setAppView'", "'air:tabs'", "'air:focusTab'"]],
  ['scripts/attention-preview.js', ["'air:setAppView'", "'air:tabs'", "'air:focusTab'"]]
]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const needle of needles) assert.ok(src.includes(needle), `${file} is missing ${needle} — the island, preload, preview shim and harness must expose the same surface`);
}
assert.ok(/focusSubject/.test(mainSrc), 'main.js must hand the attention IPC a real window-focus path');
assert.ok(/window\.air && window\.air\.setAppView/.test(fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8')),
  'the main window must report its active tab to the island');
const islandHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'air', 'island.html'), 'utf8');
for (const id of ['tabs-panel', 'tab-now-label', 'tab-list', 'tabs-source', 'tab-app']) {
  assert.ok(islandHtml.includes(`id="${id}"`), `island.html is missing #${id}`);
}
assert.ok(/renderTabs\(is\)/.test(fs.readFileSync(path.join(ROOT, 'renderer', 'air', 'island.js'), 'utf8')), 'the island renderer must render the tabs card');
ok('island tab surface is wired through IPC, preload, preview shim and UI');

console.log(`\n  All ${checks.length} desktop autonomy + island tab checks passed.\n`);
