'use strict';
/* Gem Air — the floating island window.
   A frameless, transparent, always-on-top capsule that sits above the user's work.
   Not a sidebar, not a page: an OS-level floating utility window. */

const path = require('path');

const COMPACT = { width: 372, height: 68 };
const EXPANDED = { width: 440, height: 612 };

function createIslandWindow(electron, { preloadPath, position, onMoved }) {
  const { BrowserWindow, screen } = electron;
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const x = position && Number.isFinite(position.x) ? clamp(position.x, area.x, area.x + area.width - COMPACT.width) : Math.round(area.x + (area.width - COMPACT.width) / 2);
  const y = position && Number.isFinite(position.y) ? clamp(position.y, area.y, area.y + area.height - COMPACT.height) : area.y + 16;

  const win = new BrowserWindow({
    x, y,
    width: COMPACT.width,
    height: COMPACT.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'air', 'island.html'));
  win.once('ready-to-show', () => win.showInactive());

  let moveTimer = null;
  win.on('move', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [px, py] = win.getPosition();
      onMoved && onMoved({ x: px, y: py });
    }, 400);
  });

  return win;
}

function resizeIsland(win, mode) {
  if (!win || win.isDestroyed()) return;
  const size = mode === 'expanded' ? EXPANDED : COMPACT;
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width: size.width, height: size.height }, true);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

module.exports = { createIslandWindow, resizeIsland, COMPACT, EXPANDED };
