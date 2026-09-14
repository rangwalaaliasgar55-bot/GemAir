/* ============================================================
   GemAir web gate — the app runs on the desktop, not the browser.
   ------------------------------------------------------------
   GemAir's assistant (voice, memory, tools, agents) is a PC app.
   The public website is a landing + download page, so this gate
   makes the app renderer unusable when it is served over http(s)
   without the Electron preload bridge. In the desktop app
   (file:// + window.gemair) it does nothing at all.
   ============================================================ */
(function () {
  'use strict';
  var isDesktop = !!window.gemair;
  var isWebProtocol = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  // Local dev servers (npm run web / serve) also get the gate: the web build
  // is intentionally download-only everywhere.
  if (isDesktop || !isWebProtocol) return;

  window.__GEMAIR_WEB_BLOCKED = true;

  var style = document.createElement('style');
  style.textContent = [
    'html.gemair-web-blocked, html.gemair-web-blocked body { overflow: hidden !important; height: 100%; }',
    'html.gemair-web-blocked body > *:not(#gemair-web-gate) { visibility: hidden !important; }',
    '#gemair-web-gate { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; color: #eef1f6; text-align: center; padding: 24px;',
    '  background: radial-gradient(1200px 600px at 50% -10%, #1b2436 0%, #0b0e14 55%, #07090d 100%); }',
    '#gemair-web-gate .gate-card { max-width: 560px; }',
    '#gemair-web-gate .gate-logo { width: 74px; height: 74px; margin: 0 auto 22px; border-radius: 22px;',
    '  background: linear-gradient(135deg, #6d8bff, #9a6dff); display: flex; align-items: center; justify-content: center; font-size: 34px; }',
    '#gemair-web-gate h1 { font-size: clamp(28px, 5vw, 40px); letter-spacing: -0.03em; margin: 0 0 12px; line-height: 1.1; }',
    '#gemair-web-gate p { color: #9aa4b8; font-size: 16px; line-height: 1.65; margin: 0 0 26px; }',
    '#gemair-web-gate .gate-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }',
    '#gemair-web-gate a.gate-btn { display: inline-flex; align-items: center; gap: 8px; padding: 13px 22px; border-radius: 999px;',
    '  background: linear-gradient(135deg, #6d8bff, #9a6dff); color: #fff; text-decoration: none; font-weight: 650; font-size: 15px; }',
    '#gemair-web-gate a.gate-btn.ghost { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); color: #cfd6e4; }',
    '#gemair-web-gate .gate-note { margin-top: 26px; color: #66708a; font-size: 12.5px; }'
  ].join('\n');
  document.documentElement.classList.add('gemair-web-blocked');
  document.head.appendChild(style);

  var gate = document.createElement('div');
  gate.id = 'gemair-web-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-label', 'GemAir is a desktop app');
  gate.innerHTML =
    '<div class="gate-card">' +
    '  <div class="gate-logo" aria-hidden="true">💎</div>' +
    '  <h1>GemAir lives on your desktop</h1>' +
    '  <p>GemAir\'s assistant — voice, memory, tools and agents — runs privately on your PC, not in a browser tab. Download the app for Windows, Mac or Linux; it is free and needs no account.</p>' +
    '  <div class="gate-actions">' +
    '    <a class="gate-btn" href="/download">⬇ Download GemAir</a>' +
    '    <a class="gate-btn ghost" href="https://github.com/rangwalaaliasgar55-bot/GemAir" target="_blank" rel="noopener">View source on GitHub</a>' +
    '  </div>' +
    '  <p class="gate-note">This webpage is the GemAir home &amp; download center. The app itself only runs on your computer.</p>' +
    '</div>';
  (document.body || document.documentElement).appendChild(gate);
})();
