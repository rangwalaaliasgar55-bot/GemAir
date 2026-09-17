/* GemAir — Brightness commands (pure; main executes).
   Honest platform reality:
     win32  → WMI monitor brightness via PowerShell (external monitors may
              ignore it — the reply says which method ran);
     linux  → brightnessctl when present, else a SOFTWARE gamma fallback
              via xrandr that is always labelled "not the backlight";
     darwin → macOS exposes no dependency-free programmatic brightness —
              we say so instead of pretending. */
'use strict';

function clampLevel(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(100, n));
}

function reads(platform) {
  const p = platform || process.platform;
  if (p === 'win32') return 'powershell -NoProfile -Command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness"';
  if (p === 'linux') return 'brightnessctl -m 2>/dev/null || cat /sys/class/backlight/*/brightness 2>/dev/null || xrandr --verbose 2>/dev/null | grep -i brightness | head -1';
  return null; // darwin: honest unsupported
}

function sets(level, platform) {
  const n = clampLevel(level);
  if (n === null) return null;
  const p = platform || process.platform;
  if (p === 'win32') {
    return { cmd: `powershell -NoProfile -Command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,${n})"`, method: 'hardware (WMI)' };
  }
  if (p === 'linux') {
    return { cmd: `brightnessctl set ${n}% 2>/dev/null || xrandr --output "$(xrandr | grep ' connected' | head -1 | cut -d' ' -f1)" --brightness ${(n / 100).toFixed(2)}`, method: 'hardware if brightnessctl exists, otherwise software gamma (xrandr — the panel itself is unchanged)' };
  }
  return null;
}

function parseLevel(output, platform) {
  const t = String(output || '').trim();
  let m = t.match(/(\d{1,3})/);
  if (platform === 'linux') {
    const fm = t.match(/,(\d{1,3})%/);  // brightnessctl -m → ... ,42%,...
    if (fm) m = fm;
    else {
      const xr = t.match(/brightness[:\s]*([\d.]+)/i);
      if (xr) return Math.round(parseFloat(xr[1]) * 100);
    }
  }
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 100 ? n : null;
}

function unsupportedText(platform) {
  if ((platform || process.platform) === 'darwin') {
    return 'macOS brightness is not exposed to apps without third-party helpers — GemAir refuses to fake it. Use Control Center / Touch Bar; the other platforms adjust for real.';
  }
  return 'Brightness control is not available on this platform.';
}

module.exports = { clampLevel, reads, sets, parseLevel, unsupportedText };
