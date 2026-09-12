'use strict';
/* Gem Air — enforcement layer (the part that actually acts on the OS).

   CAPABILITY HONESTY — read this before claiming a feature works:

   | Capability                | Windows            | macOS / Linux        |
   | app close/enforce         | IMPLEMENTED        | IMPLEMENTED (kill)   |
   | app launch prevention     | PARTIAL (re-close) | PARTIAL              |
   | site blocking (in-browser)| via extension      | via extension        |
   | site blocking (system)    | REQUIRES ELEVATION | REQUIRES ELEVATION   |
   | kernel-level protection   | NOT IMPLEMENTED    | NOT IMPLEMENTED      |

   "Enforce" on an app means: the foreground blocked process is closed (graceful first,
   then forced if the rule is protected). This is real, not simulated. Anything we cannot
   do is reported with { ok:false, requiresNativeIntegration:true } so the UI can say so. */

const { exec, execFile } = require('child_process');
const os = require('os');

function run(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String((stderr || '') + (err ? err.message : '')) });
    });
  });
}

function safeProcessName(name) {
  const n = String(name || '').trim().replace(/\.exe$/i, '');
  return /^[A-Za-z0-9 _.\-]{1,64}$/.test(n) ? n : null;
}

const capabilities = {
  closeApp: true,
  preventRelaunch: 'partial',
  blockSiteInBrowser: 'extension',
  blockSiteSystemWide: 'requires-elevation',
  lockScreen: process.platform === 'win32',
  notifications: true
};

/** Close the foreground/blocked application. Real OS action. */
async function closeApp(processName, { force = false } = {}) {
  const name = safeProcessName(processName);
  if (!name) return { ok: false, error: 'invalid process name' };
  if (process.platform === 'win32') {
    const cmd = `taskkill ${force ? '/F ' : ''}/IM "${name}.exe"`;
    const r = await run(cmd);
    if (!r.ok && !force) return closeApp(name, { force: true });
    return { ok: r.ok, action: 'closeApp', target: name, forced: force, detail: r.out || r.err };
  }
  if (process.platform === 'darwin') {
    const r = await run(`osascript -e 'tell application "${name}" to quit'`);
    if (r.ok) return { ok: true, action: 'closeApp', target: name };
    const k = await run(`pkill -x ${JSON.stringify(name)}`);
    return { ok: k.ok, action: 'closeApp', target: name, forced: true };
  }
  const r = await run(`pkill ${force ? '-9 ' : ''}-f ${JSON.stringify(name)}`);
  return { ok: r.ok, action: 'closeApp', target: name, forced: force };
}

/**
 * System-wide site blocking via the hosts file.
 * Honest status: needs Administrator. We never silently fail — we report what is needed.
 */
async function blockSiteSystemWide(hosts) {
  return {
    ok: false,
    requiresNativeIntegration: true,
    reason: 'System-wide site blocking edits the hosts file and requires an elevated helper service.',
    howToEnable: 'Install the Gem Air helper (elevated) or keep browser-extension blocking, which is active and does not need Administrator.',
    hosts: Array.isArray(hosts) ? hosts : []
  };
}

/** Is a process currently running? Used to verify an enforcement actually worked. */
async function isRunning(processName) {
  const name = safeProcessName(processName);
  if (!name) return false;
  if (process.platform === 'win32') {
    const r = await run(`tasklist /FI "IMAGENAME eq ${name}.exe" /NH`);
    return r.out.toLowerCase().includes(name.toLowerCase());
  }
  const r = await run(`pgrep -f ${JSON.stringify(name)}`);
  return r.ok && r.out.trim().length > 0;
}

async function setLaunchAtStartup(enabled, { appName = 'GemAir', exePath = process.execPath } = {}) {
  if (process.platform !== 'win32') return { ok: false, requiresNativeIntegration: true, reason: 'Startup registration handled by the OS elsewhere.' };
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const cmd = enabled
    ? `reg add "${key}" /v ${appName} /t REG_SZ /d "\\"${exePath}\\" --background" /f`
    : `reg delete "${key}" /v ${appName} /f`;
  const r = await run(cmd);
  return { ok: r.ok, enabled: !!enabled, detail: r.out || r.err };
}

module.exports = { capabilities, closeApp, blockSiteSystemWide, isRunning, setLaunchAtStartup, safeProcessName };
