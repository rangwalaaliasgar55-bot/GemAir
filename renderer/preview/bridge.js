/* Preview shim: reproduces the window.air contract over HTTP so the real island
   and attention UI run unmodified in a browser. In the shipped app this is the
   contextBridge in preload.js. */
(function () {
  'use strict';
  const subs = { update: [], question: [], attempt: [], enforced: [], navigate: [] };

  async function invoke(channel, ...args) {
    const res = await fetch('/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args })
    });
    return res.json();
  }

  const es = new EventSource('/events');
  es.addEventListener('update', (e) => {
    const snap = JSON.parse(e.data);
    subs.update.forEach((f) => f(snap));
    if (snap.island && snap.island.question) subs.question.forEach((f) => f(snap.island.question));
  });

  const on = (key) => (cb) => { subs[key].push(cb); return () => { subs[key] = subs[key].filter((f) => f !== cb); }; };

  window.air = {
    platform: 'preview',
    snapshot: () => invoke('air:snapshot'),
    state: () => invoke('air:state'),
    capabilities: () => invoke('air:capabilities'),
    summary: (d) => invoke('air:summary', d),
    timeline: (d) => invoke('air:timeline', d),
    trend: (n) => invoke('air:trend', n),
    recent: (n) => invoke('air:recent', n),
    lastHour: () => invoke('air:lastHour'),
    resetActivity: () => invoke('air:resetActivity'),
    exportData: () => invoke('air:export'),
    answer: (q, c) => invoke('air:answer', q, c),
    dismissQuestion: () => invoke('air:dismissQuestion'),
    createCategory: (p) => invoke('air:createCategory', p),
    deleteCategory: (id) => invoke('air:deleteCategory', id),
    classify: (p) => invoke('air:classify', p),
    deleteRule: (k, m) => invoke('air:deleteRule', k, m),
    addBlock: (p) => invoke('air:addBlock', p),
    removeBlock: (k, id) => invoke('air:removeBlock', k, id),
    toggleBlock: (k, id, e) => invoke('air:toggleBlock', k, id, e),
    addException: (p) => invoke('air:addException', p),
    removeException: (id) => invoke('air:removeException', id),
    attempts: (n) => invoke('air:attempts', n),
    requestSystemBlock: (h) => invoke('air:systemBlockRequest', h),
    savePlan: (p) => invoke('air:savePlan', p),
    startFocus: (n) => invoke('air:startFocus', n),
    deletePlan: (id) => invoke('air:deletePlan', id),
    togglePlan: (id, e) => invoke('air:togglePlan', id, e),
    activeBlocks: () => invoke('air:activeBlocks'),
    setSleep: (s) => invoke('air:setSleep', s),
    sleepStatus: () => invoke('air:sleepStatus'),
    setSettings: (p) => invoke('air:setSettings', p),
    setStartup: (e) => invoke('air:setStartup', e),
    bridgeStatus: () => invoke('air:bridgeStatus'),
    bridgePair: () => invoke('air:bridgePair'),
    browserPolicy: () => invoke('air:browserPolicy'),
    island: () => invoke('air:island'),
    islandResize: (mode) => { window.dispatchEvent(new CustomEvent('preview:islandResize', { detail: mode })); return invoke('air:islandResize', mode); },
    openMain: (tab) => { subs.navigate.forEach((f) => f(tab)); return Promise.resolve({ ok: true }); },
    openFocusx: (p) => invoke('air:openFocusx', p).then((r) => { window.open(r.url, '_blank', 'noreferrer'); return r; }),
    onUpdate: on('update'),
    onQuestion: on('question'),
    onAttempt: on('attempt'),
    onEnforced: on('enforced'),
    onNavigate: on('navigate'),
    // preview only
    feed: (sample) => invoke('preview:feed', sample),
    enforcements: () => invoke('preview:enforcements')
  };
})();
