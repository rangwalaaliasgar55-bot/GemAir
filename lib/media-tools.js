/* GemAir — media-key control (pure; main executes).
   play/pause/next/previous on whatever player is active. Each platform gets
   its real mechanism; failure is reported, never swallowed. */
'use strict';

const ACTIONS = ['playpause', 'next', 'previous'];

function normalizeAction(a) {
  const x = String(a || '').toLowerCase().trim();
  const map = { play: 'playpause', pause: 'playpause', previous: 'previous', back: 'previous', skip: 'next' };
  const v = map[x] || x;
  return ACTIONS.includes(v) ? v : null;
}

function commandFor(action, platform) {
  const a = normalizeAction(action);
  if (!a) return null;
  const p = platform || process.platform;
  if (p === 'win32') {
    const vk = { playpause: '0xB3', next: '0xB0', previous: '0xB1' }[a];
    // Send the virtual MEDIA key through keybd_event — no third-party helper needed.
    return 'powershell -NoProfile -Command "' +
      'Add-Type -TypeDefinition \\"using System;using System.Runtime.InteropServices;' +
      'public class MK{[DllImport(\\"user32.dll\\")]public static extern void keybd_event(byte k,byte s,int f,System.IntPtr e);}\\" -PassThru | Out-Null;' +
      `[MK]::keybd_event(${vk},0,0,[System.IntPtr]::Zero);[MK]::keybd_event(${vk},0,2,[System.IntPtr]::Zero)"`;
  }
  if (p === 'darwin') {
    // Targets Spotify when running, else Music; if neither runs the caller reports honestly.
    const verb = { playpause: 'playpause', next: 'next track', previous: 'previous track' }[a];
    return `osascript -e 'tell application "System Events" to if exists (first process whose name is "Spotify") then tell application "Spotify" to ${verb}' ` +
           `-e 'tell application "System Events" to if not (exists (first process whose name is "Spotify")) then tell application "Music" to ${verb}'`;
  }
  if (p === 'linux') {
    const v = { playpause: 'play-pause', next: 'next', previous: 'previous' }[a];
    return 'playerctl ' + v; // fails clearly when playerctl missing
  }
  return null;
}

/* Convert an exec failure into an honest sentence. */
function failureText(platform, stderr) {
  const p = platform || process.platform;
  const tail = String(stderr || '').trim().split('\n')[0].slice(0, 90);
  if (p === 'linux' && /command not found|not recognized|No such file/i.test(tail)) {
    return 'Media control needs playerctl on Linux (install it, e.g. sudo apt install playerctl) — not found on this machine.';
  }
  if (p === 'darwin') return 'macOS media control here targets Spotify or Music — neither seems to be running.';
  return 'Media command failed' + (tail ? ': ' + tail : '') + '.';
}

function successText(action) {
  return { playpause: 'Toggled play/pause (media key sent).', next: 'Skipped to the next track.', previous: 'Back to the previous track.' }[normalizeAction(action)];
}

module.exports = { ACTIONS, normalizeAction, commandFor, failureText, successText };
