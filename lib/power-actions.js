/* GemAir — power action tiering & commands (pure, no Electron imports).

   Concept ported from Mark-LIV's core/confirm.py ("Shutdown, restart and
   WiFi wait for a button you press — the model cannot confirm its own
   irreversible actions"), reimplemented for GemAir's own engine.

   The rule this module encodes:
     • shutdown / restart are POWER tier — they ALWAYS require a real human
       confirmation (main process shows a dialog; nothing in GemAir may
       self-confirm them, and no auto-approve flag may bypass it);
     • lock / sleep are CONVENIENCE tier — reversible and safe to run on a
       spoken or typed request without a dialog.

   Everything here is pure data + pure functions so the policy is testable
   without Electron. */
'use strict';

const POWER_TIER = ['shutdown', 'restart'];
const CONVENIENCE_TIER = ['lock', 'sleep'];

const COMMANDS = {
  lock: {
    win32: 'rundll32.exe user32.dll,LockWorkStation',
    darwin: '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession -suspend',
    linux: 'loginctl lock-session'
  },
  sleep: {
    win32: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
    darwin: 'pmset sleepnow',
    linux: 'systemctl suspend'
  },
  shutdown: {
    win32: 'shutdown /s /t 10',
    darwin: 'osascript -e \'tell app "System Events" to shut down\'',
    linux: 'systemctl poweroff'
  },
  restart: {
    win32: 'shutdown /r /t 10',
    darwin: 'osascript -e \'tell app "System Events" to restart\'',
    linux: 'systemctl reboot'
  }
};

// Why the human gets a say — surfaced verbatim in the confirmation dialog.
const CONFIRM_TEXT = {
  shutdown: {
    title: 'Shut down this computer?',
    detail: 'GemAir wants to SHUT DOWN this computer in 10 seconds.\n' +
      'Unsaved work in other apps will be lost.\n\n' +
      'This cannot be undone from inside GemAir, and no assistant setting ' +
      'can approve it for you — only this button can.'
  },
  restart: {
    title: 'Restart this computer?',
    detail: 'GemAir wants to RESTART this computer in 10 seconds.\n' +
      'Unsaved work in other apps will be lost.\n\n' +
      'This cannot be undone from inside GemAir, and no assistant setting ' +
      'can approve it for you — only this button can.'
  }
};

function normalizeAction(action) {
  const a = String(action || '').toLowerCase().trim();
  const aliases = { poweroff: 'shutdown', off: 'shutdown', reboot: 'restart', logout: 'lock' };
  return aliases[a] || a;
}

function tierFor(action) {
  const a = normalizeAction(action);
  if (POWER_TIER.includes(a)) return 'power';
  if (CONVENIENCE_TIER.includes(a)) return 'convenience';
  return 'unknown';
}

function commandFor(action, platform) {
  const a = normalizeAction(action);
  const row = COMMANDS[a];
  if (!row) return null;
  const p = platform || process.platform;
  return row[p] || row.win32 || null;
}

function confirmTextFor(action) {
  return CONFIRM_TEXT[normalizeAction(action)] || null;
}

/* The answer the model/user gets after the flow. Kept here so the wording
   is honest everywhere it surfaces: it never says "shutting down" unless a
   human actually approved. */
function resultTextFor(action, approved) {
  const a = normalizeAction(action);
  if (tierFor(a) !== 'power') return approved ? (a + ' ok') : (a + ' not requested');
  return approved
    ? (a === 'shutdown' ? 'Approved by you — shutting down in 10 seconds.' : 'Approved by you — restarting in 10 seconds.')
    : (a === 'shutdown' ? 'Shutdown cancelled — the computer stays on. Nothing was done.' : 'Restart cancelled — the computer stays on. Nothing was done.');
}

module.exports = { POWER_TIER, CONVENIENCE_TIER, COMMANDS, CONFIRM_TEXT, normalizeAction, tierFor, commandFor, confirmTextFor, resultTextFor };
