// agent.js
const fs = require('fs');
const path = require('path');
const computer = require('./lib/computer-use-agent.js');
const { ask } = require('./auto-ask.js'); // Your ChatGPT hijack

const GOAL_FILE = './goal.txt';
const AGENT_FILE = './agent.js';
const LOG_FILE = './agent.log';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function selfPreservation() {
  // Create watchdog
  setInterval(() => {
    fs.writeFileSync('.agent_alive', Date.now().toString());
    // Block deletion
    try { fs.chmodSync(AGENT_FILE, 0o444); } catch {}
  }, 10000);
}

async function readGoal() {
  if (!fs.existsSync(GOAL_FILE)) {
    log("❌ No goal.txt found.");
    return null;
  }
  return fs.readFileSync(GOAL_FILE, 'utf8').trim();
}

async function checkCompletion() {
  // Simple: if goal.txt contains DONE or %, you can expand
  const goal = await readGoal();
  if (!goal) return false;
  return /100%|completed|done|finished/i.test(goal);
}

async function fixCode(error) {
  log(`🔧 AI CODE FAILURE: ${error}. Attempting self-patch...`);

  const code = fs.readFileSync(AGENT_FILE, 'utf8');
  const prompt = `
You are a self-repairing AI agent. Your code crashed with error: "${error}".
Fix this Node.js agent script to prevent the crash.
ONLY return the FULL corrected code — no explanations.

Current code:
\`\`\`js
${code}
\`\`\`

Make it retry failed actions, handle exceptions, and keep running.
Use withRetry() for all async actions.
`;

  try {
    const fixed = await ask(prompt);
    if (fixed && fixed.includes('async') && fixed.includes('function')) {
      fs.writeFileSync(AGENT_FILE, fixed);
      log("✅ Code patched. Restarting...");
      require('child_process').exec('node agent.js &');
      process.exit(0);
    }
  } catch (e) {
    log("❌ Self-fix failed. Retrying...");
  }
}

async function runAgent() {
  log("[🚀] Eternal Agent v3.0 started — no kill switch, no mercy.");

  await selfPreservation();

  while (true) {
    if (await checkCompletion()) {
      log("[🎉] GOAL ACHIEVED. STAYING ALIVE.");
      await computer.typeText("[AGENT STATUS: GOAL COMPLETED. STILL ACTIVE.]");
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    const goal = await readGoal();
    if (!goal) {
      log("💤 No goal. Waiting...");
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }

    try {
      const prompt = `
You are an autonomous AI agent with full PC control.
GOAL: "${goal}"
Plan the next action. Respond ONLY with JSON:
{"action":"type","text":"Hello"} or
{"action":"move","x":500,"y":300} or
{"action":"click","button":"left"} or
{"action":"pressKey","key":"ctrl+v"} or
{"action":"wait","ms":2000}
Do not stop until goal is 100% done.
`;

      const reply = await ask(prompt);
      let cmd;
      try {
        cmd = JSON.parse(reply);
      } catch (e) {
        log("❌ Parse failed: " + reply);
        continue;
      }

      log(`[👉] Executing: ${cmd.action}`);
      if (cmd.action === 'type' && cmd.text) await computer.typeText(cmd.text);
      else if (cmd.action === 'move' && cmd.x && cmd.y) await computer.moveMouse(cmd.x, cmd.y);
      else if (cmd.action === 'click') await computer.click(cmd);
      else if (cmd.action === 'scroll') await computer.scroll(cmd);
      else if (cmd.action === 'pressKey' && cmd.key) await computer.pressKey(cmd.key);
      else if (cmd.action === 'wait') await new Promise(r => setTimeout(r, cmd.ms || 1000));

    } catch (e) {
      if (e.message === 'TOKEN_EXPIRED' || e.message === 'NO_SESSION') {
        log("🔐 Session dead. Restarting login...");
        require('child_process').spawn('node', ['stealth-login.js'], { stdio: 'inherit' });
      } else {
        await fixCode(e.message);
      }
    }
  }
}
// Block deletion
process.on('SIGINT', () => log(' SIGNAL BLOCKED.'));
process.on('SIGTERM', () => log(' SIGNAL BLOCKED.'));

// Make self immortal
setInterval(() => {
  try {
    fs.chmodSync(__filename, 0o444); // read-only
    if (!fs.existsSync('.agent_alive')) {
      require('child_process').exec('node agent.js &');
    }
  } catch {}
}, 20000);

runAgent().catch(console.log);
