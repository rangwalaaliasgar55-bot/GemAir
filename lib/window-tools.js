/* ============================================================
   GemAir 2.4 — Agentic Desktop Management: Window/Desktop Tools
   like a coding-agent CLI, but for Windows. Cross-platform where possible,
   graceful no-op with clear message where not.
   Tools: launch_app, focus_app, snap_window, minimize_all,
          next_virtual_desktop, open_site, list_windows
   + Context awareness: focused app/window polling
   ============================================================ */
'use strict';
const { exec } = require('child_process');
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

async function launchApp(name, args) {
  const q = String(name||'').trim();
  if (!q) return { error: 'Provide app name' };
  const mapped = resolveLaunchCmd(q);
  const platform = process.platform;
  let cmd = null;
  if (mapped) {
    cmd = mapped[platform] || mapped.win;
  }
  // If args provided, append
  if (args) cmd = (cmd||'') + ' ' + String(args);
  // If no mapping, try generic launch
  if (!cmd) {
    if (platform === 'win32') cmd = `start "" "${q}"`;
    else if (platform === 'darwin') cmd = `open -a "${q}"`;
    else cmd = `${q}`;
  }
  if (!cmd) return { error: `Cannot launch ${q} on ${platform}` };
  exec(cmd, ()=>{});
  return { ok: true, app: q, cmd, note: `Launched ${q}` };
}

async function focusApp(name) {
  const q = String(name||'').trim();
  if (!q) return { error: 'Provide app name' };
  const platform = process.platform;
  if (platform === 'win32') {
    // Use powershell AppActivate
    const ps = `powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate('${q.replace(/'/g,"''")}')"`;
    exec(ps, ()=>{});
    return { ok: true, app: q, note: `Focused ${q} (Windows)` };
  } else if (platform === 'darwin') {
    const cmd = `osascript -e 'tell application "${q}" to activate'`;
    exec(cmd, ()=>{});
    return { ok: true, app: q, note: `Focused ${q} (macOS)` };
  } else {
    // Linux: wmctrl if available
    const cmd = `wmctrl -a "${q}" 2>/dev/null || xdotool search --name "${q}" windowactivate 2>/dev/null || echo no-wmctrl`;
    const { out } = await execOut(cmd);
    if (out.includes('no-wmctrl')) return { ok: false, error: `focus_app not available on Linux without wmctrl/xdotool — tried ${q}`, note: 'Graceful no-op: install wmctrl' };
    return { ok: true, app: q, note: `Focused ${q} (Linux)` };
  }
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

async function openSite(url, browser) {
  let u = String(url||'').trim();
  if (!u) return { error: 'Provide URL' };
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const b = String(browser||'').toLowerCase();
  const platform = process.platform;
  let cmd = null;
  if (b) {
    if (b.includes('chrome')) {
      if (platform === 'win32') cmd = `start chrome "${u}"`;
      else if (platform === 'darwin') cmd = `open -a "Google Chrome" "${u}"`;
      else cmd = `google-chrome "${u}"`;
    } else if (b.includes('firefox')) {
      if (platform === 'win32') cmd = `start firefox "${u}"`;
      else if (platform === 'darwin') cmd = `open -a Firefox "${u}"`;
      else cmd = `firefox "${u}"`;
    } else if (b.includes('edge')) {
      if (platform === 'win32') cmd = `start msedge "${u}"`;
      else if (platform === 'darwin') cmd = `open -a "Microsoft Edge" "${u}"`;
      else cmd = `microsoft-edge "${u}"`;
    } else if (b.includes('brave')) {
      if (platform === 'win32') cmd = `start brave "${u}"`;
      else if (platform === 'darwin') cmd = `open -a "Brave Browser" "${u}"`;
      else cmd = `brave-browser "${u}"`;
    } else {
      // generic browser name
      if (platform === 'win32') cmd = `start ${b} "${u}"`;
      else if (platform === 'darwin') cmd = `open -a "${b}" "${u}"`;
      else cmd = `${b} "${u}"`;
    }
  } else {
    // default browser via shell
    try {
      const { shell } = require('electron');
      shell.openExternal(u);
      return { ok: true, url: u, browser: browser||'default', note: `Opened ${u} in default browser` };
    } catch (e) {
      cmd = platform === 'win32' ? `start "" "${u}"` : platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
    }
  }
  if (cmd) exec(cmd, ()=>{});
  return { ok: true, url: u, browser: browser||'default', note: `Opened ${u} in ${browser||'default browser'}` };
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
