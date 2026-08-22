#!/usr/bin/env node
'use strict';
const fs = require('fs');
const p = 'renderer/app.js';
let s = fs.readFileSync(p, 'utf8');

// 1. themeNameTag + theme-btn toggle from applyTheme
const a1 = "    const tag = $('#themeNameTag');\n    if (tag) tag.textContent = theme.label.toUpperCase();\n  }\n  document.body.dataset.theme = t;\n  $$('.theme-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === t));";
if (s.includes(a1)) { s = s.replace(a1, "  }\n  document.body.dataset.theme = t;"); }
else { console.error('MISS a1'); process.exit(1); }

// 2. theme-btn event wiring
const a2 = "  $$('.theme-btn').forEach((b) => b.addEventListener('click', () => {\n    playSfx('click');\n    profile.theme = b.dataset.theme;\n    applyTheme(profile.theme);\n    persistProfile();\n  }));";
if (s.includes(a2)) { s = s.replace(a2, '/* theme-btn swatches removed — themes live in Settings */'); }
else { console.error('MISS a2'); process.exit(1); }

// 3. sfxBtn handler
const a3 = "  const sfxBtn = $('#sfxBtn');\n  if (sfxBtn) {\n    sfxBtn.addEventListener('click', () => {\n      profile.sfx = profile.sfx === false ? undefined : false;\n      sfxBtn.classList.toggle('active', profile.sfx !== false);\n      $('#sfxIcon').textContent = profile.sfx !== false ? '🔊' : '🔇';\n      $('#sfxText').textContent = profile.sfx !== false ? 'SFX ON' : 'SFX OFF';\n      persistProfile();\n    });\n  }";
if (s.includes(a3)) { s = s.replace(a3, '/* sfxBtn removed — toggle in Settings */'); }
else { console.error('MISS a3'); process.exit(1); }

// 4. downloadBtn block
const a4 = "  const dlBtn = $('#downloadBtn');\n  if (dlBtn) {\n    // inside the packaged desktop app there is nothing to download\n    if (window.gemair) dlBtn.hidden = true;\n    else dlBtn.addEventListener('click', openDownload);\n  }";
if (s.includes(a4)) { s = s.replace(a4, '/* downloadBtn removed — lives in Settings */'); }
else { console.error('MISS a4'); process.exit(1); }

fs.writeFileSync(p, s);
console.log('OK app.js');

// CSS: remove theme-btn hide rule
const css = 'renderer/style.css';
let c = fs.readFileSync(css, 'utf8');
const hideRule = ".theme-btn { display: none; } /* fallback: settings grid uses its own */";
if (c.includes(hideRule)) {
  c = c.replace(hideRule, '/* theme-btn: topbar swatches removed */');
  fs.writeFileSync(css, c);
  console.log('OK style.css');
}
