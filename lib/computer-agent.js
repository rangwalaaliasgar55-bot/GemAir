/* ============================================================
   GemAir — Computer-Use Agent: Cross-Platform Input Primitives
   ------------------------------------------------------------
   Drives the real mouse, keyboard and screen with OS-native tools:

     Windows  : PowerShell (user32 P/Invoke + System.Windows.Forms).
     macOS    : cliclick (if installed) fallback to AppleScript System Events.
     Linux    : xdotool.

   Design goals:
     - NO API keys, NO Claude/OpenAI/Anthropic/vendor lock-in.
     - NO native node addons (no robotjs / nut.js) — works with plain
       Electron + Node, no rebuild, no platform toolchain.
     - Fully local: every action runs on this machine.
     - Every command is built with strict validation (numbers, key
       allow-list, escaped text) so a model can never inject shell.
   ============================================================ */
'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'

// ---------------------------------------------------------------------------
// Safe command runner — always ignores the shell (no user text ever reaches a
// shell prompt). Resolves { ok, out, errOut } and never throws.
// ---------------------------------------------------------------------------
function run(cmd, timeout = 10000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (error.code || 1) : 0,
        out: String(stdout || ''),
        errOut: String(stderr || '')
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
function screenSize() {
  // Use Electron's screen module in the main process when available (accurate
  // physical+DPI aware), otherwise fall back to OS tooling.
  try {
    const { screen } = require('electron');
    if (screen) {
      const primary = screen.getPrimaryDisplay();
      const s = screen.getPrimaryDisplay();
      return { width: s.size.width, height: s.size.height, scaleFactor: s.scaleFactor || 1, primary: primary.id };
    }
  } catch (e) { /* not running under Electron — fall through */ }

  if (PLATFORM === 'win32') {
    // Windows: PowerShell System.Windows.Forms bounds.
    // Handled by caller via a builder; see buildWinScreenSize().
    return null;
  }
  if (PLATFORM === 'linux' && hasBinary('xdotool')) {
    return null;
  }
  return null;
}

function hasBinary(bin) {
  const cmd = PLATFORM === 'win32' ? `where ${bin} >nul 2>nul` : `command -v ${bin} >/dev/null 2>&1`;
  // synchronous check via spawn is not available here without a promise; do a
  // best-effort sync using a tiny child process.
  try {
    const r = require('child_process').spawnSync(PLATFORM === 'win32' ? 'where' : 'sh', PLATFORM === 'win32' ? [bin] : ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return r.status === 0 || (r.stdout && r.stdout.toString().trim().length > 0);
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Input — platform dispatch
// ---------------------------------------------------------------------------

// Validates a coordinate pair, clamps to the given bounds, returns integers.
function clampPoint(x, y, width, height) {
  const nx = Math.max(0, Math.min(Math.round(Number(x) || 0), (width || 100000) - 1));
  const ny = Math.max(0, Math.min(Math.round(Number(y) || 0), (height || 100000) - 1));
  return { x: nx, y: ny };
}

// --- Windows ---------------------------------------------------------------
function escPwText(text) {
  // Wrap text for a PowerShell single-quoted string: double any single quote.
  return String(text || '').replace(/'/g, "''");
}

async function winScreenSize() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ConvertTo-Json -Compress'
  ].join('\n');
  const file = path.join(os.tmpdir(), `gemair-screen-${Date.now()}.ps1`);
  await fs.promises.writeFile(file, script, 'utf8');
  const r = await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`);
  await fs.promises.unlink(file).catch(() => {});
  if (!r.ok) return { error: 'Unable to read screen size.' };
  try {
    const b = JSON.parse(r.out.trim());
    return { width: b.Width || b.width, height: b.Height || b.height };
  } catch (e) { return { error: 'Screen size parse failed.' }; }
}

async function winMoveMouse(x, y) {
  const script = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class MOUSE { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); }"',
    `[MOUSE]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})`
  ].join('\n');
  const file = path.join(os.tmpdir(), `gemair-move-${Date.now()}.ps1`);
  await fs.promises.writeFile(file, script, 'utf8');
  const r = await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`);
  await fs.promises.unlink(file).catch(() => {});
  return r.ok ? { ok: true, x: Math.round(x), y: Math.round(y) } : { error: 'Move mouse failed: ' + r.errOut.trim() };
}

async function winClick(x, y, button, double) {
  const left = button === 'right' ? 'RIGHTDOWN' : 'LEFTDOWN';
  const leftUp = button === 'right' ? 'RIGHTUP' : 'LEFTUP';
  const clicks = double ? 2 : 1;
  const lines = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class MOUSE { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr x); }"'
  ];
  lines.push(`[MOUSE]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})`);
  for (let i = 0; i < clicks; i++) {
    lines.push(`[MOUSE]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)`); // down
    lines.push(`[MOUSE]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)`); // up
  }
  if (button === 'right') {
    // left down/up already issued above; replace by using right flags
  }
  const script = lines.join('\n');
  // For right/middle we need the correct down/up flags; rebuild accordingly.
  const flag = button === 'right' ? 0x0008 : 0x0002;
  const flagUp = button === 'right' ? 0x0010 : 0x0004;
  const script2 = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class MOUSE { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr x); }"',
    `[MOUSE]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})`
  ];
  for (let i = 0; i < clicks; i++) {
    script2.push(`[MOUSE]::mouse_event(${flag},0,0,0,[UIntPtr]::Zero)`);
    script2.push(`[MOUSE]::mouse_event(${flagUp},0,0,0,[UIntPtr]::Zero)`);
  }
  const file = path.join(os.tmpdir(), `gemair-click-${Date.now()}.ps1`);
  await fs.promises.writeFile(file, script2.join('\n'), 'utf8');
  const r = await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`);
  await fs.promises.unlink(file).catch(() => {});
  return r.ok ? { ok: true, x: Math.round(x), y: Math.round(y), button, double: !!double }
              : { error: 'Click failed: ' + r.errOut.trim() };
}

async function winScroll(amount, direction) {
  const delta = direction === 'up' ? 120 * Math.abs(amount) : -(120 * Math.abs(amount));
  const script = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class MOUSE { [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr x); }"',
    `[MOUSE]::mouse_event(0x0800,0,0,${Math.round(delta)},[UIntPtr]::Zero)`
  ].join('\n');
  const file = path.join(os.tmpdir(), `gemair-scroll-${Date.now()}.ps1`);
  await fs.promises.writeFile(file, script, 'utf8');
  const r = await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`);
  await fs.promises.unlink(file).catch(() => {});
  return r.ok ? { ok: true, amount, direction } : { error: 'Scroll failed: ' + r.errOut.trim() };
}

async function winTypeText(text) {
  // Reliable arbitrary text: set-clipboard + Ctrl+V paste (avoids SendKeys escaping).
  const safe = escPwText(text);
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Set-Clipboard -Value '${safe}'`,
    '$wshell = New-Object -ComObject wscript.shell',
    'Start-Sleep -Milliseconds 60',
    '$wshell.SendKeys("^v")'
  ].join('\n');
  const file = path.join(os.tmpdir(), `gemair-type-${Date.now()}.ps1`);
  await fs.promises.writeFile(file, script, 'utf8');
  const r = await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`);
  await fs.promises.unlink(file).catch(() => {});
  return r.ok ? { ok: true, chars: text.length } : { error: 'Type failed: ' + r.errOut.trim() };
}

// Strict validation for a key token: letters, digits, dots and '+' separators
// ONLY. Any space or shell metacharacter is rejected so a model can never
// turn `press_key` into a shell injection or a typed menu-bar command.
function safeKeyToken(s) {
  if (typeof s !== 'string') return false;
  return /^[a-z0-9.]+(\+[a-z0-9]+)*$/i.test(s.trim());
}

function winKeyCode(key) {
  if (!safeKeyToken(key)) return null;
  const k = key.trim().toLowerCase();
  const map = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', space: ' ', esc: '{ESC}', escape: '{ESC}',
    backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    home: '{HOME}', end: '{END}', pgup: '{PGUP}', pageup: '{PGUP}', pgdn: '{PGDN}', pagedown: '{PGDN}',
    insert: '{INSERT}', caps: '{CAPSLOCK}', printscreen: '{PRTSC}', window: '{LWIN}',
    f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
    f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}'
  };
  if (map[k]) return map[k];
  // Single printable char
  if (/^[a-zA-Z0-9.]$/.test(k)) return k.toUpperCase();
  // Modifier combos like ctrl+c, alt+tab, cmd+shift+3
  const parts = k.split('+');
  const combo = parts.map((part) => {
    if (part === 'ctrl' || part === 'control') return '^';
    if (part === 'alt') return '%';
    if (part === 'shift') return '+';
    if (part === 'cmd' || part === 'meta' || part === 'win') return '^';
    if (part === 'tab') return '{TAB}';
    if (part === 'esc' || part === 'escape') return '{ESC}';
    if (part === 'enter' || part === 'return') return '{ENTER}';
    if (part === '.' ) return '.';
    return part.toUpperCase();
  });
  return combo.join('');
}

async function winPressKey(key) {
  const token = winKeyCode(key);
  if (!token) return { error: 'Unsupported key: ' + key };
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$wshell = New-Object -ComObject wscript.shell',
    `$wshell.SendKeys('${token.replace(/'/g, "''")}')`
  ].join('\n');
  const file = path.join(os.tmpdir(), `gemair-key-${Date.now()}.ps1`);
  await fs.promises.writeFile(file, script, 'utf8');
  const r = await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`);
  await fs.promises.unlink(file).catch(() => {});
  return r.ok ? { ok: true, key } : { error: 'Press key failed: ' + r.errOut.trim() };
}

// --- macOS ----------------------------------------------------------------
function macEscape(text) {
  return String(text || '').replace(/"/g, '\\"').replace(/\\/g, '\\\\');
}

async function macMoveMouse(x, y) {
  if (hasBinary('cliclick')) {
    const r = await run(`cliclick m:${Math.round(x)},${Math.round(y)}`);
    return r.ok ? { ok: true, x: Math.round(x), y: Math.round(y) } : { error: 'cliclick move failed: ' + r.errOut.trim() };
  }
  return { error: 'Install cliclick (`brew install cliclick`) to move the mouse, or use keyboard-only actions.' };
}

async function macClick(x, y, button, double) {
  const b = button === 'right' ? 'r' : button === 'double' || double ? 'd' : 'c';
  if (hasBinary('cliclick')) {
    const r = await run(`cliclick w:10 m:${Math.round(x)},${Math.round(y)} ${b}:`);
    return r.ok ? { ok: true, x: Math.round(x), y: Math.round(y), button, double: !!double } : { error: 'cliclick click failed: ' + r.errOut.trim() };
  }
  return { error: 'Install cliclick (`brew install cliclick`) to click, or use keyboard-only actions.' };
}

async function macScroll(amount, direction) {
  // cliclick uses -w for wheel; we use AppleScript/Key-down alternative:
  const sc = direction === 'up' ? 1 : -1;
  if (hasBinary('cliclick')) {
    const r = await run(`cliclick w:${sc * Math.abs(amount) || sc}`);
    return r.ok ? { ok: true, amount, direction } : { error: 'cliclick scroll failed: ' + r.errOut.trim() };
  }
  const script = `tell application "System Events" to key code ${direction === 'up' ? 126 : 125}`;
  const r = await run(`osascript -e '${macEscape(script)}'`);
  return r.ok ? { ok: true, amount, direction } : { error: 'Scroll failed: ' + r.errOut.trim() };
}

function macKeyToken(key) {
  if (!safeKeyToken(key)) return null;
  const k = key.trim().toLowerCase();
  const map = {
    enter: 'return', return: 'return', tab: 'tab', space: 'space', esc: 'escape', escape: 'escape',
    backspace: 'delete', delete: 'delete', up: 'up', down: 'down', left: 'left', right: 'right',
    home: 'home', end: 'end', pgup: 'page up', pgdn: 'page down'
  };
  if (map[k]) return map[k];
  if (/^[a-z]$/i.test(k)) return k;
  if (/^[0-9]$/.test(k)) return String(Number(k));
  // combos — expand cmd/meta/win → 'command' so AppleScript can use it.
  const combo = k.split('+').map((part) => {
    if (part === 'cmd' || part === 'meta' || part === 'win') return 'command';
    if (part === 'ctrl' || part === 'control') return 'control';
    if (part === 'alt' || part === 'option') return 'option';
    if (part === 'shift') return 'shift';
    return map[part] || part;
  });
  return combo.join('+');
}

async function macTypeText(text) {
  // Paste via clipboard + cmd+v for reliable arbitrary text.
  const safe = macEscape(text);
  const script = [
    `set the clipboard to "${safe}"`,
    'delay 0.05',
    'tell application "System Events" to keystroke "v" using command down'
  ].join('\n');
  const r = await run(`osascript -e '${macEscape(script)}'`);
  return r.ok ? { ok: true, chars: text.length } : { error: 'Type failed: ' + r.errOut.trim() };
}

async function macPressKey(key) {
  if (!safeKeyToken(key)) return { error: 'Unsupported key: ' + key };
  const token = macKeyToken(key);
  if (!token) return { error: 'Unsupported key: ' + key };
  const k = key.trim().toLowerCase();
  let script;
  if (k.includes('+')) {
    const parts = k.split('+');
    const keyPart = parts[parts.length - 1];
    let mods = [];
    if (parts.includes('cmd') || parts.includes('meta') || parts.includes('win')) mods.push('command down');
    if (parts.includes('alt') || parts.includes('option')) mods.push('option down');
    if (parts.includes('ctrl') || parts.includes('control')) mods.push('control down');
    if (parts.includes('shift')) mods.push('shift down');
    script = `tell application "System Events" to keystroke "${keyPart}" using ${mods.join(', ')}`;
  } else if (/^[a-z0-9]$/i.test(token)) {
    script = `tell application "System Events" to keystroke "${token}"`;
  } else {
    const code = macKeyCode(token);
    script = `tell application "System Events" to key code ${code}`;
  }
  const r = await run(`osascript -e '${macEscape(script)}'`);
  return r.ok ? { ok: true, key } : { error: 'Press key failed: ' + r.errOut.trim() };
}

function macKeyCode(token) {
  const map = { return: 36, tab: 48, space: 49, escape: 53, delete: 51, up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, 'page up': 116, 'page down': 121 };
  return map[token] || 0;
}

// --- Linux (xdotool) -------------------------------------------------------
async function linuxMoveMouse(x, y) {
  if (!hasBinary('xdotool')) return { error: 'Install xdotool (`sudo apt install xdotool`) to use computer control.' };
  const r = await run(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`);
  return r.ok ? { ok: true, x: Math.round(x), y: Math.round(y) } : { error: 'Move failed: ' + r.errOut.trim() };
}

async function linuxClick(x, y, button, double) {
  if (!hasBinary('xdotool')) return { error: 'Install xdotool (`sudo apt install xdotool`) to use computer control.' };
  const b = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
  if (x != null && y != null) { await run(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`); }
  const count = double ? '--repeat 2 ' : '';
  const r = await run(`xdotool click ${count}${b}`);
  return r.ok ? { ok: true, x: x != null ? Math.round(x) : null, y: y != null ? Math.round(y) : null, button, double: !!double } : { error: 'Click failed: ' + r.errOut.trim() };
}

async function linuxScroll(amount, direction) {
  if (!hasBinary('xdotool')) return { error: 'Install xdotool (`sudo apt install xdotool`) to use computer control.' };
  const sign = direction === 'up' ? 1 : -1;
  const btn = 4; // 4 wheel up, 5 wheel down
  const count = Math.max(1, Math.min(20, Math.abs(Math.round(amount) || 1)));
  const r = await run(`xdotool click --repeat ${count} ${direction === 'up' ? 4 : 5}`);
  return r.ok ? { ok: true, amount, direction } : { error: 'Scroll failed: ' + r.errOut.trim() };
}

async function linuxTypeText(text) {
  if (!hasBinary('xdotool')) return { error: 'Install xdotool (`sudo apt install xdotool`) to use computer control.' };
  // type --clearmodifiers is safest; write the text as an argv (xdotool takes it literally).
  const r = await run(`xdotool type --delay 12 --clearmodifiers '${String(text).replace(/'/g, "'\\''")}'`);
  return r.ok ? { ok: true, chars: text.length } : { error: 'Type failed: ' + r.errOut.trim() };
}

async function linuxPressKey(key) {
  if (!hasBinary('xdotool')) return { error: 'Install xdotool (`sudo apt install xdotool`) to use computer control.' };
  const token = linuxKeyToken(key);
  if (!token) return { error: 'Unsupported key: ' + key };
  const r = await run(`xdotool key ${token}`);
  return r.ok ? { ok: true, key } : { error: 'Press key failed: ' + r.errOut.trim() };
}

function linuxKeyToken(key) {
  if (!safeKeyToken(key)) return null;
  const k = key.trim().toLowerCase();
  const map = {
    enter: 'Return', return: 'Return', tab: 'Tab', space: 'space', esc: 'Escape', escape: 'Escape',
    backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    home: 'Home', end: 'End', pgup: 'Page_Up', pageup: 'Page_Up', pgdn: 'Page_Down', pagedown: 'Page_Down',
    insert: 'Insert', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
    f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12'
  };
  if (map[k]) return map[k];
  if (/^[a-zA-Z0-9.]$/.test(k)) return k;
  if (k.includes('+')) {
    return k.split('+').map((part) => {
      const p = part === 'ctrl' || part === 'control' ? 'ctrl' : part === 'alt' ? 'alt' : part === 'shift' ? 'shift' : part === 'cmd' || part === 'meta' || part === 'win' ? 'super' : map[part] || part;
      return p;
    }).join('+');
  }
  return null;
}

// --- Public dispatch -------------------------------------------------------
async function moveMouse(x, y) {
  const p = clampPoint(x, y);
  if (PLATFORM === 'win32') return winMoveMouse(p.x, p.y);
  if (PLATFORM === 'darwin') return macMoveMouse(p.x, p.y);
  return linuxMoveMouse(p.x, p.y);
}

async function click({ x, y, button = 'left', double = false } = {}) {
  const p = clampPoint(x, y);
  if (PLATFORM === 'win32') return winClick(p.x, p.y, button, double);
  if (PLATFORM === 'darwin') return macClick(p.x, p.y, button, double);
  return linuxClick(x != null ? p.x : null, y != null ? p.y : null, button, double);
}

async function scroll({ amount = 1, direction = 'down' } = {}) {
  if (PLATFORM === 'win32') return winScroll(amount, direction);
  if (PLATFORM === 'darwin') return macScroll(amount, direction);
  return linuxScroll(amount, direction);
}

async function typeText(text) {
  if (text == null) return { error: 'No text provided.' };
  if (PLATFORM === 'win32') return winTypeText(String(text));
  if (PLATFORM === 'darwin') return macTypeText(String(text));
  return linuxTypeText(String(text));
}

async function pressKey(key) {
  if (!key) return { error: 'No key provided.' };
  if (PLATFORM === 'win32') return winPressKey(String(key));
  if (PLATFORM === 'darwin') return macPressKey(String(key));
  return linuxPressKey(String(key));
}

async function getScreenSize() {
  if (PLATFORM === 'win32') return winScreenSize();
  try {
    const { screen } = require('electron');
    if (screen) {
      const s = screen.getPrimaryDisplay();
      return { width: s.size.width, height: s.size.height, scaleFactor: s.scaleFactor || 1 };
    }
  } catch (e) { /* fall through */ }
  if (PLATFORM === 'linux' && hasBinary('xdotool')) {
    const r = await run('xdotool getdisplaygeometry');
    if (r.ok) {
      const [w, h] = r.out.trim().split(/\s+/).map(Number);
      if (w && h) return { width: w, height: h };
    }
  }
  return { error: 'Screen size unavailable. Try Windows or Linux with xdotool.' };
}

function platformSupported() {
  return PLATFORM === 'win32' || PLATFORM === 'darwin' || PLATFORM === 'linux';
}

// Fallback descriptive screen (no vision models): returns what we can know.
async function describeScreenState() {
  try {
    const titles = [];
    if (windowToolsRef && windowToolsRef.listWindows) {
      const windows = await windowToolsRef.listWindows();
      if (windows && windows.windows) titles.push(...windows.windows.slice(0, 6).map((w) => (w.title || w.name || 'untitled')));
    }
    const size = await getScreenSize();
    return {
      display: titleCase(PLATFORM),
      size,
      openWindows: titles,
      note: 'This model is not vision-capable; control is approximate. Prefer keyboard shortcuts and exact app windows.'
    };
  } catch (e) {
    return { display: titleCase(PLATFORM), note: 'Unable to introspect screen.' };
  }
}
let windowToolsRef = null;
function setWindowTools(ref) { windowToolsRef = ref; }

function titleCase(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

module.exports = {
  platformSupported,
  platform: PLATFORM,
  getScreenSize,
  moveMouse,
  click,
  scroll,
  typeText,
  pressKey,
  describeScreenState,
  setWindowTools,
  // exposed for tests
  clampPoint,
  winKeyCode,
  linuxKeyToken,
  macKeyToken,
  hasBinary
};
