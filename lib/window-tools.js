/* ============================================================
   GemAir 2.4 — Agentic Desktop Management: Window/Desktop Tools
   like a coding-agent CLI, but for Windows. Cross-platform where possible,
   graceful no-op with clear message where not.
   Tools: launch_app, focus_app, snap_window, minimize_all,
          next_virtual_desktop, open_site, list_windows
   + Context awareness: focused app/window polling
   ============================================================ */
'use strict';
const { exec, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function execOut(cmd, timeout=8000) {
  return new Promise((resolve)=>{
    exec(cmd, { timeout, maxBuffer: 4*1024*1024 }, (err, stdout, stderr)=>{
      resolve({ err, out: String(stdout||''), errOut: String(stderr||'') });
    });
  });
}

// Common app map for launch_app
const APP_MAP = {
  // Windows exe names + macOS app names + linux binaries
  chrome: { win: 'start chrome', mac: 'open -a "Google Chrome"', linux: 'google-chrome' },
  'google chrome': { win: 'start chrome', mac: 'open -a "Google Chrome"', linux: 'google-chrome' },
  firefox: { win: 'start firefox', mac: 'open -a Firefox', linux: 'firefox' },
  edge: { win: 'start msedge', mac: 'open -a "Microsoft Edge"', linux: 'microsoft-edge' },
  brave: { win: 'start brave', mac: 'open -a "Brave Browser"', linux: 'brave-browser' },
  opera: { win: 'start opera', mac: 'open -a Opera', linux: 'opera' },
  safari: { win: '', mac: 'open -a Safari', linux: '' },
  spotify: { win: 'start spotify', mac: 'open -a Spotify', linux: 'spotify' },
  discord: { win: 'start discord', mac: 'open -a Discord', linux: 'discord' },
  slack: { win: 'start slack', mac: 'open -a Slack', linux: 'slack' },
  telegram: { win: 'start telegram', mac: 'open -a Telegram', linux: 'telegram' },
  whatsapp: { win: 'start whatsapp', mac: 'open -a WhatsApp', linux: 'whatsapp' },
  vscode: { win: 'code', mac: 'open -a "Visual Studio Code"', linux: 'code' },
  'visual studio code': { win: 'code', mac: 'open -a "Visual Studio Code"', linux: 'code' },
  code: { win: 'code', mac: 'open -a "Visual Studio Code"', linux: 'code' },
  notepad: { win: 'notepad', mac: 'open -a TextEdit', linux: 'gedit' },
  calculator: { win: 'calc', mac: 'open -a Calculator', linux: 'gnome-calculator' },
  calc: { win: 'calc', mac: 'open -a Calculator', linux: 'gnome-calculator' },
  terminal: { win: 'start cmd', mac: 'open -a Terminal', linux: 'gnome-terminal' },
  cmd: { win: 'start cmd', mac: 'open -a Terminal', linux: 'gnome-terminal' },
  powershell: { win: 'start powershell', mac: '', linux: '' },
  explorer: { win: 'explorer', mac: 'open .', linux: 'xdg-open .' },
  finder: { win: '', mac: 'open .', linux: '' },
  files: { win: 'explorer', mac: 'open .', linux: 'xdg-open .' },
  settings: { win: 'start ms-settings:', mac: 'open -a "System Settings"', linux: 'gnome-control-center' },
  premiere: { win: 'start premiere', mac: 'open -a "Adobe Premiere Pro"', linux: '' },
  photoshop: { win: 'start photoshop', mac: 'open -a "Adobe Photoshop"', linux: '' },
  steam: { win: 'start steam', mac: 'open -a Steam', linux: 'steam' },
  zoom: { win: 'start zoom', mac: 'open -a zoom.us', linux: 'zoom' },
  teams: { win: 'start teams', mac: 'open -a "Microsoft Teams"', linux: 'teams' }
};

function resolveLaunchCmd(name) {
  const q = String(name||'').toLowerCase().trim();
  for (const key of Object.keys(APP_MAP)) {
    if (q.includes(key)) return APP_MAP[key];
  }
  return null;
}

function safeLaunchName(value) {
  const name = String(value || '').trim();
  return name.length > 0 && name.length <= 80 && /^[\p{L}\p{N} ._+#()-]+$/u.test(name) ? name : null;
}

function normalizeLaunchArgs(value) {
  if (value == null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 20) return null;
  const out = values.map((item) => String(item));
  if (out.some((item) => item.length > 500 || /[\0\r\n]/.test(item))) return null;
  return out;
}

function mappedLaunchSpec(mapped, platform) {
  const command = mapped && (mapped[platform] || (platform === 'win32' ? mapped.win : null));
  if (!command) return null;
  // APP_MAP is static, trusted data. Convert it to an executable + argv without
  // invoking a shell, so user-controlled app arguments can never become syntax.
  const quoted = String(command).match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const parts = quoted.map((part) => part.replace(/^"|"$/g, ''));
  if (platform === 'win32' && parts[0] === 'start') parts.shift();
  if (platform === 'win32' && parts[0] && /^[a-z][a-z0-9+.-]*:$/i.test(parts[0])) return { file: 'explorer.exe', args: [parts[0]] };
  if (platform === 'darwin' && parts[0] === 'open') return { file: 'open', args: parts.slice(1) };
  return parts.length ? { file: parts[0], args: parts.slice(1) } : null;
}

function spawnDetached(file, argv) {
  return new Promise((resolve) => {
    let settled = false;
    try {
      const child = spawn(file, argv, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.once('error', (error) => { if (!settled) { settled = true; resolve({ error: `Launch failed: ${error.message}` }); } });
      child.once('spawn', () => { if (!settled) { settled = true; child.unref(); resolve({ ok: true }); } });
    } catch (error) {
      resolve({ error: `Launch failed: ${error.message}` });
    }
  });
}

async function launchApp(name, args) {
  const q = safeLaunchName(name);
  if (!q) return { error: 'Invalid app name. Use 1-80 letters, numbers, spaces, or . _ + # ( ) -.' };
  const extraArgs = normalizeLaunchArgs(args);
  if (!extraArgs) return { error: 'Invalid app arguments.' };
  const platform = process.platform;
  const mapped = resolveLaunchCmd(q);
  let spec = mappedLaunchSpec(mapped, platform);
  if (!spec) {
    if (platform === 'darwin') spec = { file: 'open', args: ['-a', q] };
    else spec = { file: q, args: [] };
  }
  const result = await spawnDetached(spec.file, [...spec.args, ...extraArgs]);
  if (result.error) return result;
  return { ok: true, app: q, note: `Launched ${q}` };
}

function execFileOut(file, argv, timeout = 8000) {
  return new Promise((resolve) => {
    const child = spawn(file, argv, { shell: false, windowsHide: true });
    let out = '', errOut = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('Timed out')); }, timeout);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ err: error || null, out, errOut });
    };
    child.stdout && child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr && child.stderr.on('data', (chunk) => { errOut += chunk; });
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0 ? null : new Error(errOut || `Exited ${code}`)));
  });
}

async function focusApp(name) {
  const q = safeLaunchName(name);
  if (!q) return { error: 'Invalid app name.' };
  const platform = process.platform;
  if (platform === 'win32') {
    const script = `$wshell = New-Object -ComObject wscript.shell; if (-not $wshell.AppActivate('${q}')) { exit 1 }`;
    const result = await execFileOut('powershell', ['-NoProfile', '-Command', script]);
    return result.err ? { error: `Could not focus ${q}` } : { ok: true, app: q, note: `Focused ${q} (Windows)` };
  }
  if (platform === 'darwin') {
    const result = await execFileOut('osascript', ['-e', `tell application "${q}" to activate`]);
    return result.err ? { error: `Could not focus ${q}` } : { ok: true, app: q, note: `Focused ${q} (macOS)` };
  }
  let result = await execFileOut('wmctrl', ['-a', q]);
  if (result.err) {
    const search = await execFileOut('xdotool', ['search', '--name', q]);
    const windowId = search.out.trim().split(/\s+/)[0];
    if (search.err || !/^\d+$/.test(windowId)) return { error: `Could not focus ${q}; install wmctrl or xdotool.` };
    result = await execFileOut('xdotool', ['windowactivate', windowId]);
  }
  return result.err ? { error: `Could not focus ${q}` } : { ok: true, app: q, note: `Focused ${q} (Linux)` };
}

async function snapWindow(direction) {
  const dir = String(direction||'').toLowerCase();
  const valid = ['left','right','quarter','max','maximize','minimize'];
  if (!valid.includes(dir)) return { error: `Invalid direction ${direction}. Use left|right|quarter|max` };
  const platform = process.platform;
  if (platform !== 'win32') {
    return { ok: false, error: `snap_window is Windows-only — ${dir} not available on ${platform}`, note: 'Graceful no-op: Windows snap not supported here' };
  }
  // Use PowerShell to snap foreground window via WinAPI key simulation
  // Simulate Win+Left/Right/Up via SendKeys
  const keyMap = {
    left: '%{LEFT}', // Alt+Left? Actually need Win+Left
    right: '%{RIGHT}',
    max: '%{UP}',
    maximize: '%{UP}',
    minimize: '%{DOWN}'
  };
  // More reliable: use powershell to call SetWindowPos? We'll use SendKeys with Win key via WScript.Shell
  // WScript.Shell SendKeys uses ^%+ for modifiers, but Win key is not directly supported. Use workaround: use PowerShell to move window.
  let ps = '';
  if (dir === 'left') {
    ps = `powershell -NoProfile -Command "Add-Type @' using System; using System.Runtime.InteropServices; public class Win { [DllImport(\\"user32.dll\\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r); [DllImport(\\"user32.dll\\")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint); [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); public struct RECT { public int Left, Top, Right, Bottom; } } '@; $h=[Win]::GetForegroundWindow(); $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; [Win]::MoveWindow($h, $s.Left, $s.Top, $s.Width/2, $s.Height, $true)"`;
  } else if (dir === 'right') {
    ps = `powershell -NoProfile -Command "Add-Type @' using System; using System.Runtime.InteropServices; public class Win { [DllImport(\\"user32.dll\\")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint); [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); } '@; $h=[Win]::GetForegroundWindow(); $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; [Win]::MoveWindow($h, $s.Left+$s.Width/2, $s.Top, $s.Width/2, $s.Height, $true)"`;
  } else if (dir === 'max' || dir === 'maximize') {
    ps = `powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('% x'); Start-Sleep -m 200; $wshell.SendKeys('x')"`; // Alt+Space, maximize
  } else {
    ps = `powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('% x')"`; // generic
  }
  exec(ps, ()=>{});
  return { ok: true, direction: dir, note: `Snapped window ${dir} (Windows)` };
}

async function minimizeAll() {
  const platform = process.platform;
  if (platform === 'win32') {
    exec(`powershell -NoProfile -Command "$shell = New-Object -ComObject Shell.Application; $shell.MinimizeAll()"`, ()=>{});
    return { ok: true, note: 'Minimized all windows (Windows)' };
  } else if (platform === 'darwin') {
    exec(`osascript -e 'tell application "System Events" to keystroke "m" using {command down, option down}'`, ()=>{});
    return { ok: true, note: 'Minimized all (macOS)' };
  } else {
    exec(`xdotool key super+d 2>/dev/null || wmctrl -k on 2>/dev/null || echo no-tool`, ()=>{});
    return { ok: true, note: 'Minimized all (Linux, if wmctrl/xdotool available)' };
  }
}

async function nextVirtualDesktop() {
  const platform = process.platform;
  if (platform !== 'win32') {
    return { ok: false, error: `next_virtual_desktop is Windows-only, not on ${platform}`, note: 'Graceful no-op' };
  }
  // Simulate Ctrl+Win+Right
  exec(`powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('^#{RIGHT}')"` , ()=>{});
  return { ok: true, note: 'Switched to next virtual desktop (Windows)' };
}

function normalizeWebUrl(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || text.length > 2048) return null;
    return parsed.toString();
  } catch { return null; }
}

async function openSite(url, browser) {
  const u = normalizeWebUrl(url);
  if (!u) return { error: 'Provide a valid HTTP(S) URL without embedded credentials.' };
  const requested = String(browser || '').toLowerCase().trim();
  const aliases = { chrome: 'chrome', firefox: 'firefox', edge: 'edge', brave: 'brave', opera: 'opera', safari: 'safari' };
  if (requested && requested !== 'default') {
    const appName = aliases[requested];
    if (!appName) return { error: 'Unsupported browser. Use chrome, firefox, edge, brave, opera, safari, or default.' };
    const result = await launchApp(appName, [u]);
    return result.error ? result : { ...result, url: u, browser: requested, note: `Opened ${u} in ${requested}` };
  }
  try {
    const electron = require('electron');
    if (!electron.shell || typeof electron.shell.openExternal !== 'function') throw new Error('Electron shell unavailable');
    await electron.shell.openExternal(u);
    return { ok: true, url: u, browser: 'default', note: `Opened ${u} in default browser` };
  } catch (error) {
    const platform = process.platform;
    const spec = platform === 'win32' ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', u] }
      : platform === 'darwin' ? { file: 'open', args: [u] }
      : { file: 'xdg-open', args: [u] };
    const result = await spawnDetached(spec.file, spec.args);
    return result.error ? result : { ok: true, url: u, browser: 'default', note: `Opened ${u} in default browser` };
  }
}

async function listWindows() {
  const platform = process.platform;
  if (platform === 'win32') {
    // PowerShell: Get processes with MainWindowTitle
    const ps = `powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json -Compress"`;
    const { out } = await execOut(ps, 10000);
    try {
      let rows = JSON.parse(out);
      if (!Array.isArray(rows)) rows = [rows];
      return { ok: true, windows: rows.filter(Boolean).map(r=>({ app: r.ProcessName, pid: r.Id, title: r.MainWindowTitle })).slice(0,50) };
    } catch (e) {
      return { ok: true, windows: [], note: 'Could not parse window list' };
    }
  } else if (platform === 'darwin') {
    const cmd = `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`;
    const { out } = await execOut(cmd, 8000);
    const apps = out.split(',').map(s=>s.trim()).filter(Boolean);
    return { ok: true, windows: apps.map(a=>({ app: a, title: a, pid: 0 })).slice(0,50) };
  } else {
    const cmd = `wmctrl -l 2>/dev/null | head -50 || echo no-wmctrl`;
    const { out } = await execOut(cmd, 8000);
    if (out.includes('no-wmctrl')) {
      return { ok: true, windows: [], note: 'list_windows needs wmctrl on Linux — install wmctrl for full desktop state' };
    }
    const lines = out.trim().split('\n').map(l=>{
      const parts = l.split(/\s+/);
      return { id: parts[0], app: 'unknown', title: parts.slice(3).join(' ') };
    });
    return { ok: true, windows: lines };
  }
}

async function getFocusedWindow() {
  const platform = process.platform;
  if (platform === 'win32') {
    const ps = `powershell -NoProfile -Command "Add-Type @' using System; using System.Runtime.InteropServices; public class Win { [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\"user32.dll\\")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count); [DllImport(\\"user32.dll\\")] public static extern int GetWindowTextLength(IntPtr hWnd); [DllImport(\\"user32.dll\\")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid); } '@; $h=[Win]::GetForegroundWindow(); $len=[Win]::GetWindowTextLength($h); $sb=New-Object System.Text.StringBuilder $len; [Win]::GetWindowText($h, $sb, $len+1); $pid=0; [Win]::GetWindowThreadProcessId($h, [ref]$pid); $proc=(Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName; Write-Output \\"$proc|$($sb.ToString())| $pid\\""`;
    const { out } = await execOut(ps, 6000);
    const line = out.trim();
    const [app, title, pid] = line.split('|');
    return { app: app||'unknown', title: title||'', pid: Number(pid)||0 };
  } else if (platform === 'darwin') {
    const cmd = `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`;
    const { out } = await execOut(cmd, 5000);
    return { app: out.trim()||'unknown', title: out.trim()||'', pid: 0 };
  } else {
    const cmd = `xdotool getactivewindow getwindowname 2>/dev/null || echo unknown`;
    const { out } = await execOut(cmd, 5000);
    return { app: 'unknown', title: out.trim(), pid: 0 };
  }
}

module.exports = {
  launchApp,
  focusApp,
  snapWindow,
  minimizeAll,
  nextVirtualDesktop,
  openSite,
  listWindows,
  getFocusedWindow
};
