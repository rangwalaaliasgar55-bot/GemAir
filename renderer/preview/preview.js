/* Preview harness controls: drive the foreground feed and mirror island resize. */
(function () {
  'use strict';
  const APPS = [
    { label: 'VS Code', app: 'code', title: 'service.js — gem-air' },
    { label: 'Figma', app: 'figma', title: 'Design system' },
    { label: 'Slack', app: 'slack', title: 'team' },
    { label: 'Chrome · GitHub', app: 'chrome', url: 'https://github.com/org/repo', title: 'org/repo' },
    { label: 'Chrome · YouTube', app: 'chrome', url: 'https://youtube.com/watch?v=1', title: 'YouTube' },
    { label: 'Chrome · X', app: 'chrome', url: 'https://x.com/home', title: 'Home / X' },
    { label: 'Chrome · MDN', app: 'chrome', url: 'https://developer.mozilla.org/en-US/', title: 'MDN' },
    { label: 'Steam', app: 'steam', title: 'Library' },
    { label: 'Unknown tool', app: 'LedgerPro', title: 'Ledger' },
    { label: 'Away (idle)', app: 'code', title: '', idleSeconds: 600 }
  ];

  const strip = document.getElementById('simApps');
  const note = document.getElementById('simNote');
  let current = null;

  APPS.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'sim-btn';
    b.innerHTML = '<i></i>';
    b.appendChild(document.createTextNode(a.label));
    b.onclick = async () => {
      current = a;
      strip.querySelectorAll('.sim-btn').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      const snap = await window.air.feed(a);
      const is = snap.island;
      note.textContent = `Island → ${is.mode.toUpperCase()} · ${is.primary}${is.secondary ? ' · ' + is.secondary : ''}`;
    };
    strip.appendChild(b);
  });

  // keep time accruing on the active app
  setInterval(() => { if (current) window.air.feed(current); }, 5000);

  // mirror the island's own resize request onto the iframe
  const frame = document.getElementById('islandFrame');
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'gemair:islandResize') frame.classList.toggle('expanded', e.data.mode === 'expanded');
  });

  strip.querySelector('.sim-btn').click();
})();
