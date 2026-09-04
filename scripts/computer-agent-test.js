#!/usr/bin/env node
/* ============================================================
   GemAir 2.5 — Computer-Use Agent (keyless) dry-run test.

   Verifies the Desktop Agent wiring WITHOUT touching the real
   mouse/keyboard, an AI provider or the network:

     1. lib/computer-agent.js loads in plain Node (no Electron, no API key).
     2. Safe builders: clampPoint, winKeyCode, linuxKeyToken, macKeyToken
        produce safe, bounded, validated output (no shell injection).
     3. main.js registers every computer-use tool in TOOLS + executeToolNow,
        defines the computerUseAgent / offlineComputerUse brain, and gates
        input on the allowComputerUse preference.
     4. preload.js bridges computerUse / computerUseStop / computerUseStatus /
        computerUseScreen / onComputerUseEvent.
     5. renderer exposes api.computerUse* and wires the Desktop Agent modal.

   Run:  node scripts/computer-agent-test.js   (also runs in `npm run check`)
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const failures = [];
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => failures.push(m);

function includesLabel(src, needle, label) {
  if (src.includes(needle)) ok(label);
  else fail(label + ` (missing "${needle}")`);
}

// 0. Provider catalog (providers.js)
const providers = read('renderer/providers.js');
// Load it in a context that provides a stub `window` so we can validate.
let cat = null;
try {
  const vm = require('vm');
  const sandbox = { window: {} };
  sandbox.self = sandbox.window;
  vm.runInNewContext(providers, sandbox, { filename: 'providers.js' });
  cat = sandbox.window.GemAirProviders;
  if (cat && cat.PROVIDERS.length >= 15) ok('providers.js catalog loads with ' + cat.PROVIDERS.length + ' providers');
  else fail('providers.js catalog missing or too small');
} catch (e) {
  fail('providers.js failed to load in sandbox: ' + e.message);
}
if (cat) {
  if (cat.FREE_MODELS.length >= 25) ok('free-model catalog has ' + cat.FREE_MODELS.length + ' free models');
  else fail('FREE_MODELS too small: ' + cat.FREE_MODELS.length);
  if (cat.PROVIDERS.some((p) => p.id === 'cerebras')) ok('catalog includes Cerebras');
  else fail('catalog missing Cerebras');
  if (cat.PROVIDERS.some((p) => p.id === 'sambanova')) ok('catalog includes SambaNova');
  else fail('catalog missing SambaNova');
  if (cat.PROVIDERS.some((p) => p.id === 'nvidia')) ok('catalog includes NVIDIA NIM');
  else fail('catalog missing NVIDIA NIM');
  if (cat.PROVIDERS.some((p) => p.id === 'zai')) ok('catalog includes Z.AI (GLM)');
  else fail('catalog missing Z.AI');
  // detection
  if (cat.detect('https://api.cerebras.ai/v1') === 'cerebras') ok('detect() resolves Cerebras');
  else fail('detect() Cerebras failed: ' + cat.detect('https://api.cerebras.ai/v1'));
  if (cat.detect('http://localhost:11434/v1') === 'ollama') ok('detect() resolves local Ollama');
  else fail('detect() Ollama failed: ' + cat.detect('http://localhost:11434/v1'));
}

// 1. Module loads without Electron.
let agent = null;
try {
  // Resolve require against the project's node_modules if any, else relative.
  agent = require(path.join(ROOT, 'lib/computer-agent.js'));
  ok('lib/computer-agent.js loads in plain Node');
} catch (e) {
  fail('lib/computer-agent.js failed to load: ' + e.message);
}

// 2. Safe builders.
if (agent) {
  const p = agent.clampPoint(-5, 99999, 1920, 1080);
  if (p.x === 0 && p.y === 1079) ok('clampPoint clamps coordinates to bounds');
  else fail('clampPoint returned out-of-bounds coords: ' + JSON.stringify(p));

  const w = agent.winKeyCode('ctrl+shift+3');
  if (w === '^+3') ok('winKeyCode builds modifier combo: ' + w);
  else fail('winKeyCode combo unexpected: ' + JSON.stringify(w));

  const wEnter = agent.winKeyCode('enter');
  if (wEnter === '{ENTER}') ok('winKeyCode maps enter');
  else fail('winKeyCode enter unexpected: ' + JSON.stringify(wEnter));

  const wBad = agent.winKeyCode('; rm -rf /');
  if (wBad === null) ok('winKeyCode rejects shell-y input (returns null)');
  else fail('winKeyCode did not reject shell-y input: ' + JSON.stringify(wBad));

  const lk = agent.linuxKeyToken('ctrl+a');
  if (lk === 'ctrl+a') ok('linuxKeyToken builds ctrl+a');
  else fail('linuxKeyToken unexpected: ' + JSON.stringify(lk));

  const lkBad = agent.linuxKeyToken('... && rm -rf /');
  if (lkBad === null) ok('linuxKeyToken rejects shell-y input (returns null)');
  else fail('linuxKeyToken did not reject shell-y input: ' + JSON.stringify(lkBad));

  const mk = agent.macKeyToken('cmd+shift+3');
  if (mk === 'command+shift+3') ok('macKeyToken expands cmd to command');
  else fail('macKeyToken unexpected: ' + JSON.stringify(mk));

  const mkBad = agent.macKeyToken('rm -rf /');
  if (mkBad === null) ok('macKeyToken rejects shell-y input (returns null)');
  else fail('macKeyToken did not reject shell-y input: ' + JSON.stringify(mkBad));

  if (agent.platformSupported()) ok('platformSupported true for ' + agent.platform);
  else fail('platformSupported should be true on win/mac/linux');
}

// 2b. Coding Agent safe builders / keyless resolver share the same primitives.
if (agent) {
  const same = agent.clampPoint(10, 20, 100, 100);
  if (same.x === 10 && same.y === 20) ok('computer-agent primitives reusable for Coding Agent');
  else fail('clampPoint reused unexpectedly: ' + JSON.stringify(same));
}

// 3. main.js wiring.
const main = read('main.js');
includesLabel(main, "name: 'move_mouse'", 'TOOLS registers move_mouse');
includesLabel(main, "name: 'mouse_click'", 'TOOLS registers mouse_click');
includesLabel(main, "name: 'type_text'", 'TOOLS registers type_text');
includesLabel(main, "name: 'press_key'", 'TOOLS registers press_key');
includesLabel(main, "name: 'scroll_mouse'", 'TOOLS registers scroll_mouse');
includesLabel(main, "name: 'capture_agent_screen'", 'TOOLS registers capture_agent_screen');
includesLabel(main, "name: 'describe_screen'", 'TOOLS registers describe_screen');
includesLabel(main, "case 'move_mouse':", 'executeToolNow handles move_mouse');
includesLabel(main, "case 'mouse_click':", 'executeToolNow handles mouse_click');
includesLabel(main, "case 'type_text':", 'executeToolNow handles type_text');
includesLabel(main, "case 'press_key':", 'executeToolNow handles press_key');
includesLabel(main, "case 'scroll_mouse':", 'executeToolNow handles scroll_mouse');
includesLabel(main, 'async function computerUseAgent(', 'computerUseAgent loop defined');
includesLabel(main, 'async function offlineComputerUse(', 'keyless offlineComputerUse fallback defined');
includesLabel(main, 'allowComputerUse', 'input gated on allowComputerUse preference');
includesLabel(main, "require('./lib/computer-agent')", 'main.js requires computer-agent module');
includesLabel(main, "agent:computerUse", 'ipc agent:computerUse registered');
includesLabel(main, "agent:computerUseStop", 'ipc agent:computerUseStop registered');
includesLabel(main, 'resolveComputerUseConfig', 'keyless config resolver present');
// Coding Agent wiring
includesLabel(main, "name: 'run_coding_cli'", 'TOOLS registers run_coding_cli');
includesLabel(main, "case 'run_coding_cli':", 'executeToolNow handles run_coding_cli');
includesLabel(main, 'async function codingAgent(', 'codingAgent loop defined');
includesLabel(main, 'async function runCodingCli(', 'keyless coding-CLI adapter defined');
includesLabel(main, 'CODING_TOOL_NAMES', 'coding tool set defined');
includesLabel(main, 'allowCodingAgent', 'coding actions gated on allowCodingAgent');
includesLabel(main, 'codingAutoApprove', 'coding auto-approve guard present');
includesLabel(main, "agent:codingUse", 'ipc agent:codingUse registered');
includesLabel(main, "agent:codingUseStop", 'ipc agent:codingUseStop registered');
includesLabel(main, "agent:codingUseStatus", 'ipc agent:codingUseStatus registered');

// 4. preload bridge.
const preload = read('preload.js');
includesLabel(preload, 'computerUse:', 'preload bridges computerUse');
includesLabel(preload, 'computerUseStop:', 'preload bridges computerUseStop');
includesLabel(preload, 'computerUseStatus:', 'preload bridges computerUseStatus');
includesLabel(preload, 'computerUseScreen:', 'preload bridges computerUseScreen');
includesLabel(preload, 'onComputerUseEvent:', 'preload bridges onComputerUseEvent');
includesLabel(preload, 'codingUse:', 'preload bridges codingUse');
includesLabel(preload, 'codingUseStop:', 'preload bridges codingUseStop');
includesLabel(preload, 'codingUseStatus:', 'preload bridges codingUseStatus');
includesLabel(preload, 'onCodingUseEvent:', 'preload bridges onCodingUseEvent');

// 5. renderer wiring.
const app = read('renderer/app.js');
const html = read('renderer/index.html');
includesLabel(app, 'runDesktopAgent', 'renderer defines runDesktopAgent');
includesLabel(app, 'openAgentModal', 'renderer defines openAgentModal');
includesLabel(app, 'onComputerUseEvent', 'renderer subscribes to agent events');
includesLabel(app, 'setComputerUse', 'renderer reads/saves allowComputerUse');
includesLabel(html, 'agentModal', 'index.html has the agent modal');
includesLabel(html, 'agentTaskInput', 'index.html has the task input');
includesLabel(html, 'agentRunBtn', 'index.html has the run button');
includesLabel(html, 'setComputerUse', 'index.html has the enable toggle');
includesLabel(app, 'runCodingAgent', 'renderer defines runCodingAgent');
includesLabel(app, 'openCodingAgentModal', 'renderer defines openCodingAgentModal');
includesLabel(app, 'onCodingUseEvent', 'renderer subscribes to coding events');
includesLabel(app, 'setCodingAgent', 'renderer reads/saves allowCodingAgent');
includesLabel(html, 'codingAgentModal', 'index.html has the coding agent modal');
includesLabel(html, 'codingTaskInput', 'index.html has the coding task input');
includesLabel(html, 'codingRunBtn', 'index.html has the coding run button');
includesLabel(html, 'setCodingAgent', 'index.html has the enable toggle');
// Provider catalog UI + slash commands
includesLabel(app, 'renderFreeModelsList', 'renderer renders the free-model picker');
includesLabel(app, 'applyFreeModel', 'renderer applies a free model');
includesLabel(app, 'handleSlashCommand', 'renderer handles /models /providers slash commands');
includesLabel(app, 'refreshOllamaModels', 'renderer detects local Ollama models');
includesLabel(app, 'renderModelSelect', 'renderer renders the per-provider model select');
includesLabel(html, 'freeModelsList', 'index.html has the free-models container');
includesLabel(html, 'setModelSelect', 'index.html has the model select');
includesLabel(html, 'ollamaModels', 'index.html has the local-models container');
includesLabel(main, "ai:listLocalModels", 'ipc ai:listLocalModels registered');
includesLabel(preload, 'listLocalModels:', 'preload bridges listLocalModels');
includesLabel(read('api/chat.js'), "id: 'cerebras'", 'FREE CORE fallback chain includes Cerebras');
includesLabel(read('api/chat.js'), "id: 'sambanova'", 'FREE CORE fallback chain includes SambaNova');

console.log(failures.length ? `\n${failures.length} FAILURE(S):` : '\nAll computer-agent checks passed.');
failures.forEach((f) => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
