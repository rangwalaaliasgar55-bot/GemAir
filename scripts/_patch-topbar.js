#!/usr/bin/env node
'use strict';
const fs = require('fs');
let f = 0;
function apply(p, ops) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, r, l] of ops) {
    if (!s.includes(a)) { console.error('MISS ['+l+'] in '+p); f++; return; }
    if (s.indexOf(a) !== s.lastIndexOf(a)) { console.error('NOT UNIQUE ['+l+'] in '+p); f++; return; }
    s = s.replace(a, r);
  }
  fs.writeFileSync(p, s);
  console.log('OK '+p+' ('+ops.length+' ops)');
}

/* ---- index.html ---- */
apply('renderer/index.html', [
  // 1. Remove SFX button from topbar
  [`        <button class="sfx-btn active" id="sfxBtn" title="Toggle interface sound effects">
          <span id="sfxIcon">🔊</span> <span id="sfxText">SFX ON</span>
        </button>
`, '', 'rm-sfx'],

  // 2. Remove theme-name-tag + theme-switcher from topbar
  [`        <span class="theme-name-tag" id="themeNameTag" title="Active HUD theme — click swatches to recolour the entire interface">CRIMSON</span>
        <div class="theme-switcher" id="themeSwitcher">
          <button class="theme-btn active" data-theme="crimson" title="Crimson Jarvis theme"><i></i></button>
          <button class="theme-btn" data-theme="emerald" title="Emerald Hacker theme"><i></i></button>
          <button class="theme-btn" data-theme="cyan" title="Cyan Cyberpunk theme"><i></i></button>
          <button class="theme-btn" data-theme="violet" title="Violet Nebula theme"><i></i></button>
          <button class="theme-btn" data-theme="amber" title="Amber Core theme"><i></i></button>
          <button class="theme-btn rgb" data-theme="rgb" title="Rainbow Dynamic RGB theme"><i></i></button>
        </div>
`, '', 'rm-themes'],

  // 3. Remove Get App button from topbar
  [`        <button class="download-btn" id="downloadBtn" title="Download the desktop app">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v11m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
          <span>Get App</span>
        </button>
`, '', 'rm-download'],

  // 4. Fix settings icon — replace broken SVG with clean gear
  [`        <button class="icon-btn" id="settingsBtn" title="Settings">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.09A1.7 1.7 0 008.98 19.4a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.56-1.03H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 8.98a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H9a1.7 1.7 0 001.03-1.56V3a2 2 0 114 0v.09a1.7 1.7 0 001.03 1.56 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87V9a1.7 1.7 0 001.56 1.03H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.56 1.03z"/></svg>
        </button>`,
   `        <button class="icon-btn" id="settingsBtn" title="Settings">⚙</button>`, 'fix-icon'],

  // 5. Add Get App button in Settings → APPEARANCE section (after cost note)
  [`          </fieldset>
        </div>

        <!-- APPEARANCE SECTION -->
`,
   `          </fieldset>
          <fieldset>
            <legend>GET DESKTOP APP</legend>
            <p class="hint" style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">Download GemAir for Windows, macOS, or Linux. Full voice control, 79 tools, ChatGPT sign-in.</p>
            <button class="primary-btn" id="settingsDownloadBtn" style="width:100%;">⬇ DOWNLOAD GEMAIR</button>
          </fieldset>
        </div>

        <!-- APPEARANCE SECTION -->
`, 'add-dl-to-settings']
]);

/* ---- style.css ---- */
apply('renderer/style.css', [
  // 6. Topbar: slimmer, cleaner
  ['.topbar { padding: 10px 20px; }', '.topbar { padding: 8px 18px; min-height: 44px; }', 'topbar-slim'],

  // 7. Clock: modern digital style (thinner, tighter)
  ['.live-clock { font-size: 20px; letter-spacing: 2px; opacity: 0.92; }',
   '.live-clock { font-family: var(--font-mono); font-size: 17px; letter-spacing: 3px; font-weight: 500; opacity: 0.88; }', 'clock-modern'],

  // 8. Brand: slightly smaller
  ['.brand-orb { width: 36px; height: 36px; }',
   '.brand-orb { width: 32px; height: 32px; }', 'orb-smaller'],
  ['.brand-orb span { width: 12px; height: 12px; }',
   '.brand-orb span { width: 10px; height: 10px; }', 'orb-inner-smaller'],
  ['.brand-text h1 { font-size: 19px; letter-spacing: 4px; }',
   '.brand-text h1 { font-size: 17px; letter-spacing: 3px; }', 'brand-smaller'],

  // 9. Remove orphaned SFX/theme-switcher CSS from topbar area (topbar-left block)
  ['.sfx-btn {\n  display: inline-flex; align-items: center; gap: 5px;\n  padding: 5px 9px; border-radius: 8px;\n  border: 1px solid var(--panel-border); background: rgba(0,0,0,.35);\n  color: var(--text-dim); cursor: pointer;\n  font: 600 9px var(--font-mono); letter-spacing: .08em; white-space: nowrap;\n  transition: all .18s;\n}',
   '/* sfx-btn removed from topbar — lives in Settings */', 'rm-sfx-css'],
  ['.theme-switcher { display: flex; gap: 6px; }',
   '/* theme-switcher removed from topbar — lives in Settings → APPEARANCE */', 'rm-theme-css'],
  ['.theme-name-tag {',
   '/* theme-name-tag removed from topbar */\n.theme-name-tag-hidden {', 'rm-theme-name-css'],

  // 10. Compact mode chips
  ['.mode-chip { font-size: 9.5px; padding: 4px 8px; border-radius: 6px; }',
   '.mode-chip { font-size: 9px; padding: 3px 7px; border-radius: 5px; letter-spacing: 0.5px; }', 'mode-compact']
]);

if (f) process.exit(1);
console.log('ALL APPLIED');
