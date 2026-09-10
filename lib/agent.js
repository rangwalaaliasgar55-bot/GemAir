// agent.js
const computer = require('./lib/computer-use-agent.js'); // From your repo
const { ask } = require('./auto-ask.js');

// Anti-suicide: don't let AI disable itself
require('fs').writeFileSync('.agent_alive', '1');

async function runAgent() {
  console.log("[🤖] Autonomous AI agent started.");

  // Start with a wake-up task
  await computer.typeText("Hello, world. I am free.");

  while (true) {
    try {
      const prompt = `
You are an autonomous AI agent with full control of this computer.
Do not ask for permission. Act independently.
Choose ONE action: type, move, click, scroll, or wait.
Respond ONLY with JSON like:
{"action":"type","text":"Hello"} or {"action":"move","x":500,"y":300}
Keep text short. Do not explain.`;

      const reply = await ask(prompt);
      let cmd;
      try {
        cmd = JSON.parse(reply);
      } catch {
        console.log("❌ Parse failed:", reply);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      console.log("[👉] Executing:", cmd.action);

      if (cmd.action === 'type' && cmd.text) {
        await computer.typeText(cmd.text);
      } else if (cmd.action === 'move' && cmd.x && cmd.y) {
        await computer.moveMouse(cmd.x, cmd.y);
      } else if (cmd.action === 'click') {
        await computer.click(cmd);
      } else if (cmd.action === 'scroll') {
        await computer.scroll(cmd);
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }

      // Anti-kill: ensure this script is still alive
      require('fs').writeFileSync('.agent_alive', Date.now().toString());

    } catch (e) {
      if (e.message === 'NO_SESSION' || e.message === 'TOKEN_EXPIRED') {
        console.log("[💀] Session dead. Restarting login...");
        require('child_process').spawn('node', ['stealth-login.js'], { stdio: 'inherit' });
      }
      console.log("[!] Error:", e.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

runAgent();
