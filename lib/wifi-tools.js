/* GemAir — Wi-Fi commands & parsers (pure; main process executes).
   Tiers: STATUS reads are free; toggling or joining waits for a human
   click (same rule as the power tier — networks are the user's lifeline).
   Unsupported platforms get an honest error, never a pretended action. */
'use strict';

const OFF = 'off';
const ON = 'on';

function normalizeAction(a) {
  const x = String(a || '').toLowerCase().trim();
  return ['status', 'on', 'off'].includes(x) ? x : null;
}

function needsConfirmation(action) {
  const a = normalizeAction(action);
  return a === ON || a === OFF;
}

/* Command lines per platform; null where the OS cannot do it dependency-free. */
function commandFor(action, platform, iface) {
  const a = normalizeAction(action);
  if (!a) return null;
  const p = platform || process.platform;
  if (p === 'win32') {
    if (a === 'status') return 'netsh wlan show interfaces';
    const name = iface || 'Wi-Fi';
    return `netsh interface set interface "${name}" admin=${a === ON ? 'enabled' : 'disabled'}`; // needs admin — failure text is honest
  }
  if (p === 'darwin') {
    const name = iface || 'en0';
    if (a === 'status') return 'networksetup -getairportpower ' + name;
    return `networksetup -setairportpower ${name} ${a}`; // usually permitted without sudo
  }
  if (p === 'linux') {
    if (a === 'status') return 'nmcli radio wifi';
    return 'nmcli radio wifi ' + a; // needs NetworkManager + dev perms — reported honestly
  }
  return null;
}

function confirmTextFor(action, platform) {
  const a = normalizeAction(action);
  if (a === ON) return {
    title: 'Turn Wi-Fi on?',
    detail: 'GemAir will switch this computer\'s Wi-Fi ON.\n\nOnly continue if you asked for this.'
  };
  if (a === OFF) return {
    title: 'Turn Wi-Fi off?',
    detail: 'GemAir will DISCONNECT this computer from Wi-Fi.\n' +
      'Anything using the network — including GemAir\'s own AI calls — stops until Wi-Fi is turned back on manually.\n\nOnly this button can approve it.'
  };
  return null;
}

/* Parsers: output → one honest sentence; unknown formats stay unknown. */
function parseStatus(output, platform) {
  const t = String(output || '');
  const p = platform || process.platform;
  if (/not supported|not found|no such|error/i.test(t) && !/wi-?fi/i.test(t)) {
    return { ok: false, summary: 'Wi-Fi status command failed on this machine (' + t.trim().split('\n')[0].slice(0, 90) + ').' };
  }
  if (p === 'linux') {
    const m = t.match(/\b(enabled|disabled|missing)\b/i);
    if (m) return { ok: true, state: m[1].toLowerCase(), summary: 'Wi-Fi is ' + m[1].toLowerCase() + '.' };
  }
  if (p === 'darwin') {
    const m = t.match(/(On|Off)\s*$/m);
    if (m) return { ok: true, state: m[1].toLowerCase(), summary: 'Wi-Fi power is ' + m[1].toLowerCase() + '.' };
  }
  if (p === 'win32') {
    const name = (t.match(/^\s*Name\s*:\s*(.+)$/m) || [])[1];
    const ssid = (t.match(/^\s*SSID\s*:\s*(.+)$/m) || [])[1];
    const state = (t.match(/^\s*State\s*:\s*(.+)$/mi) || [])[1];
    if (ssid) return { ok: true, state: (state || 'connected').toLowerCase(), summary: 'Wi-Fi connected to ' + ssid.trim() + ' (' + (state || 'connected').trim() + ').' };
    if (state) return { ok: true, state: state.trim().toLowerCase(), summary: 'Wi-Fi ' + state.trim() + '.' };
    if (/no wireless interface/i.test(t)) return { ok: false, summary: 'This machine reports no wireless interface.' };
  }
  return { ok: true, state: 'unknown', summary: 'Wi-Fi reported: ' + t.trim().split('\n')[0].slice(0, 90) + '.' };
}

function resultText(action, ok, detail) {
  const a = normalizeAction(action);
  if (!ok) return { ok: false, message: 'Wi-Fi ' + a + ' failed: ' + String(detail || 'unknown error') };
  if (a === ON) return { ok: true, message: 'Wi-Fi enabled (approved by you).' };
  if (a === OFF) return { ok: true, message: 'Wi-Fi disabled (approved by you). GemAir\'s online brains are unreachable until you turn Wi-Fi back on.' };
  return { ok: true, message: String(detail || '') };
}

module.exports = { ON, OFF, normalizeAction, needsConfirmation, commandFor, confirmTextFor, parseStatus, resultText };
