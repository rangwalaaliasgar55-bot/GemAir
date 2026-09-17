'use strict';
/**
 * lib/autostart.js — honest OS-native auto-launch registration.
 *
 * Concept port (no upstream code) of Mark-LIV's "auto-start on boot"
 * (registry / LaunchAgent / .desktop). We model it over Electron's
 * app.setLoginItemSettings / getLoginItemSettings:
 *
 *   win32  → HKCU\...\Run registry value            (launch at login)
 *   darwin → macOS login item (SMAppService / pre-Ventura helper)
 *   linux  → XDG autostart .desktop entry           (Electron ≥ 15; needs a
 *            packaged app name — dev mode registers the electron binary and
 *            we say so honestly rather than pretending it works)
 *
 * The factory takes the app object so tests can pass a mock — this module
 * never imports electron itself.
 */

const PLATFORM_NOTES = {
  win32: 'Windows Run-key registry entry (HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run).',
  darwin: 'macOS Login Item (System Settings → General → Login Items).',
  linux: 'XDG autostart .desktop file in ~/.config/autostart — most reliable from an installed package (.deb/.AppImage); in developer checkouts it registers the Electron dev binary.',
  fallback: 'Auto-start is not available on this platform.'
};

function createAutoStart(app, opts = {}) {
  const platform = opts.platform || process.platform;
  const name = opts.name || 'GemAir';

  function isSupported() {
    return platform === 'win32' || platform === 'darwin' || platform === 'linux';
  }

  function note() {
    return PLATFORM_NOTES[platform] || PLATFORM_NOTES.fallback;
  }

  function getState() {
    if (!isSupported()) return { supported: false, enabled: false, note: note() };
    try {
      const settings = app.getLoginItemSettings();
      return {
        supported: true,
        enabled: !!settings.openAtLogin,
        openedAsHidden: !!settings.openedAsHidden,
        note: note(),
        devMode: platform === 'linux' && !app.isPackaged
      };
    } catch (error) {
      return { supported: true, enabled: false, error: error.message, note: note() };
    }
  }

  function setEnabled(enabled) {
    if (!isSupported()) return { ok: false, error: 'Auto-start is not available on this platform.' };
    try {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        openAsHidden: false,            // GemAir announces itself; no sneaky background start
        name,
        ...(platform === 'darwin' ? { args: [] } : {})
      });
      return { ok: true, enabled: !!enabled, note: note(), devMode: platform === 'linux' && !app.isPackaged };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return { isSupported, getState, setEnabled, note };
}

module.exports = { createAutoStart, PLATFORM_NOTES };
