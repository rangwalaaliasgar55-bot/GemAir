/* ============================================================
   GemCore UI — ALTREX provider engine + AERA systems for GemAir
   ------------------------------------------------------------
   Renderer module (plain JS, no dependencies). Owns:
   · the GemCore settings section (providers, models, memory,
     audit, impact tiers, reasoning trace)
   · the Multi-AI team modal (director + specialist agents)
   · emotion-profile wiring into the existing TTS engine
   Exposes window.GemCore for app.js and other scripts.
   ============================================================ */
(function () {
  'use strict';

  const bridge = () => window.gemcore;
  /** Bridge or null + a visible hint when running where gemcore is unavailable (web preview). */
  function requireBridge(hintEl) {
    const b = bridge();
    if (!b) {
      const target = hintEl || $('#gemcoreDiagnosticsSummary');
      if (target) target.textContent = 'GemCore is available in the desktop app.';
      return null;
    }
    return b;
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };

  /* ---------------- injected styles ---------------- */
  const STYLE = `
.gc-card { border:1px solid var(--border,#2c2f36); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:8px; background:var(--surface,#16181d); }
.gc-card-head { display:flex; align-items:center; gap:8px; }
.gc-logo { width:34px; height:34px; border-radius:9px; display:flex; align-items:center; justify-content:center; font:700 11px var(--font-mono,monospace); background:var(--accent-dim,rgba(120,140,255,.15)); color:var(--accent,#8ea2ff); flex:0 0 auto; }
.gc-name { font-weight:700; font-size:13px; }
.gc-desc { font-size:11px; color:var(--text-dim,#9aa0aa); line-height:1.45; }
.gc-dot { width:9px; height:9px; border-radius:50%; background:#5a5f68; margin-left:auto; flex:0 0 auto; }
.gc-dot.on { background:#4ade80; box-shadow:0 0 8px rgba(74,222,128,.6); }
.gc-dot.cfg { background:#fbbf24; }
.gc-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.gc-btn { border:1px solid var(--border,#2c2f36); background:transparent; color:var(--text,#e8eaf0); border-radius:7px; padding:5px 10px; font-size:10.5px; cursor:pointer; font-family:inherit; }
.gc-btn:hover { border-color:var(--accent,#8ea2ff); }
.gc-btn.primary { background:var(--accent,#8ea2ff); color:#10131a; border-color:transparent; font-weight:700; }
.gc-btn.danger { color:#e05d5d; }
.gc-btn:disabled { opacity:.5; cursor:default; }
.gc-select { background:var(--surface-2,#1d2027); color:var(--text,#e8eaf0); border:1px solid var(--border,#2c2f36); border-radius:7px; padding:5px 8px; font-size:11px; max-width:100%; }
.gc-err { font-size:10.5px; color:#e0a35d; line-height:1.4; }
.gc-mem-item { display:flex; gap:8px; align-items:flex-start; padding:7px 9px; border:1px solid var(--border,#2c2f36); border-radius:8px; margin-bottom:6px; font-size:12px; background:var(--surface-2,#1d2027); }
.gc-mem-item .scope { font:600 9px var(--font-mono,monospace); padding:2px 6px; border-radius:5px; background:var(--accent-dim,rgba(120,140,255,.15)); color:var(--accent,#8ea2ff); flex:0 0 auto; margin-top:1px; }
.gc-mem-item .del { margin-left:auto; flex:0 0 auto; }
.gc-audit-line { padding:3px 0; border-bottom:1px dotted var(--border,#2c2f36); }
.gc-agent { border:1px solid var(--border,#2c2f36); border-radius:10px; padding:10px 12px; background:var(--surface-2,#1d2027); }
.gc-agent-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.gc-agent-status { font:600 9.5px var(--font-mono,monospace); padding:2px 8px; border-radius:6px; text-transform:uppercase; letter-spacing:.4px; }
.gc-agent-status.waiting { background:rgba(120,130,150,.18); color:#9aa4b8; }
.gc-agent-status.running { background:rgba(96,165,250,.18); color:#7ab3ff; animation:gcPulse 1.2s ease-in-out infinite; }
.gc-agent-status.completed { background:rgba(74,222,128,.16); color:#4ade80; }
.gc-agent-status.failed { background:rgba(224,93,93,.16); color:#e07070; }
.gc-agent-status.cancelled { background:rgba(150,150,150,.16); color:#999; }
.gc-agent-desc { font-size:11.5px; color:var(--text-dim,#9aa0aa); margin-top:6px; line-height:1.5; }
.gc-agent-out { margin-top:8px; font-size:12px; white-space:pre-wrap; max-height:260px; overflow:auto; border-top:1px dashed var(--border,#2c2f36); padding-top:8px; display:none; }
.gc-agent-out.open { display:block; }
@keyframes gcPulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
.gc-chip { display:inline-block; font:600 9.5px var(--font-mono,monospace); padding:2px 7px; border-radius:6px; margin:2px 3px 2px 0; }
.gc-chip.LOW { background:rgba(74,222,128,.13); color:#4ade80; }
.gc-chip.MODERATE { background:rgba(96,165,250,.13); color:#7ab3ff; }
.gc-chip.HIGH { background:rgba(251,191,36,.13); color:#fbbf24; }
.gc-chip.CRITICAL { background:rgba(224,93,93,.15); color:#e07070; }
`;

  function injectStyles() {
    if (document.getElementById('gemcore-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'gemcore-ui-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  /* ============================================================
     Emotion profiles → existing TTS engine (AERA wiring)
     ============================================================ */
  const AERA_EMOTIONS = {
    attentive: { rate: -0.04, pitch: 0.02, volume: 0.02, pause: 0.25 },
    deliberate: { rate: -0.10, pitch: -0.03, volume: 0.03, pause: 0.6 },
    concerned: { rate: -0.07, pitch: -0.05, volume: -0.02, pause: 0.6 },
    apologetic: { rate: -0.09, pitch: -0.08, volume: -0.04, pause: 0.7 },
    curious: { rate: 0.04, pitch: 0.08, volume: 0.03, pause: 0.3 },
    celebratory: { rate: 0.12, pitch: 0.15, volume: 0.12, pause: 0.2 },
    stern: { rate: -0.02, pitch: -0.06, volume: 0.05, pause: 0.4 }
  };

  function wireEmotions() {
    if (window.TTS && window.TTS.EMOTIONS) {
      Object.assign(window.TTS.EMOTIONS, AERA_EMOTIONS);
    }
  }

  /** Ask gemcore which emotion to speak `text` with, given the user's message. */
  async function emotionFor(text, userText) {
    try {
      if (bridge() && bridge().emotion) return await bridge().emotion({ text, userText });
    } catch { /* fall through to local heuristic */ }
    return { emotion: 'neutral', profile: AERA_EMOTIONS.neutral || { rate: 0, pitch: 0, volume: 0, pause: 0 }, delayMs: 0 };
  }

  /** Speak through the existing TTS engine with a gemcore-chosen emotion. */
  async function speakWithEmotion(text, userText, opts) {
    const result = await emotionFor(text, userText);
    if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    if (window.TTS && typeof window.TTS.speak === 'function') {
      return window.TTS.speak(text, { ...(opts || {}), emotion: result.emotion });
    }
    return result;
  }

  /* ============================================================
     Provider engine UI
     ============================================================ */
  let providerCache = [];
  let connectTarget = null;

  async function refreshProviders() {
    if (!bridge() || !bridge().providers) return;
    try {
      providerCache = await bridge().providers();
    } catch { providerCache = []; }
    renderProviders();
  }

  function renderProviders() {
    const grid = $('#gemcoreProviderGrid');
    if (!grid) return;
    if (!providerCache.length) {
      grid.innerHTML = '<div class="gc-desc">Provider catalog unavailable.</div>';
      return;
    }
    grid.innerHTML = providerCache.map((provider) => {
      const status = provider.connected ? 'on' : provider.configured ? 'cfg' : '';
      const dotTitle = provider.connected ? 'Connected and tested' : provider.configured ? 'Configured — test to connect' : 'Not configured';
      const keyBtn = provider.apiKeyUrl
        ? `<button class="gc-btn" data-gc-act="keyurl" data-gc-id="${esc(provider.id)}" type="button">Get API key ↗</button>` : '';
      const docsBtn = provider.docsUrl
        ? `<button class="gc-btn" data-gc-act="docsurl" data-gc-id="${esc(provider.id)}" type="button">Docs ↗</button>` : '';
      const lastError = provider.lastError
        ? `<div class="gc-err">⚠ ${esc(provider.lastError.message || '')}${provider.lastError.technicalDetails ? ' · ' + esc(provider.lastError.technicalDetails).slice(0, 160) : ''}</div>` : '';
      const modelOptions = provider.models.filter((m) => !m.disabled).map((m) =>
        `<option value="${esc(m.id)}" ${m.id === provider.defaultModel ? 'selected' : ''}>${esc(m.name || m.id)}${m.reasoning ? ' 🧠' : ''}</option>`
      ).join('');
      return `
        <div class="gc-card" data-gc-card="${esc(provider.id)}">
          <div class="gc-card-head">
            <span class="gc-logo">${esc(provider.logo || provider.name.slice(0, 2).toUpperCase())}</span>
            <span class="gc-name">${esc(provider.name)}</span>
            <span class="gc-dot ${status}" title="${esc(dotTitle)}"></span>
          </div>
          <div class="gc-desc">${esc(provider.description || '')}</div>
          ${provider.configured && modelOptions ? `
            <label class="gc-desc" style="display:flex;gap:6px;align-items:center;">
              <span style="flex:0 0 auto;">Model</span>
              <select class="gc-select" data-gc-act="defaultmodel" data-gc-id="${esc(provider.id)}" style="flex:1;">${modelOptions}</select>
            </label>` : ''}
          ${lastError}
          <div class="gc-row">
            ${provider.configured
              ? `<button class="gc-btn ${provider.connected ? '' : 'primary'}" data-gc-act="test" data-gc-id="${esc(provider.id)}" type="button">Test</button>
                 <button class="gc-btn" data-gc-act="manage" data-gc-id="${esc(provider.id)}" type="button">Edit</button>
                 <button class="gc-btn" data-gc-act="disconnect" data-gc-id="${esc(provider.id)}" type="button">Disconnect</button>
                 <button class="gc-btn danger" data-gc-act="remove" data-gc-id="${esc(provider.id)}" type="button">Remove</button>`
              : `<button class="gc-btn primary" data-gc-act="connect" data-gc-id="${esc(provider.id)}" type="button">Connect</button>`}
            ${keyBtn}${docsBtn}
          </div>
        </div>`;
    }).join('');
  }

  function openConnectForm(providerId) {
    const provider = providerCache.find((p) => p.id === providerId);
    const form = $('#gemcoreProviderConnect');
    if (!provider || !form) return;
    connectTarget = providerId;
    form.hidden = false;
    $('#gemcoreConnectTitle').textContent = 'CONNECT — ' + provider.name.toUpperCase();
    $('#gemcoreConnectLabel').value = provider.label || provider.name;
    $('#gemcoreConnectUrl').value = provider.baseUrl && provider.baseUrl !== 'https://' ? provider.baseUrl : (provider.baseUrl || '');
    $('#gemcoreConnectKey').value = '';
    $('#gemcoreConnectKey').placeholder = provider.requiresApiKey ? 'paste API key — stays on this device' : 'optional (not required for this provider)';
    $('#gemcoreConnectHint').textContent = provider.apiKeyUrl ? 'Official key page: ' + provider.apiKeyUrl : '';
  }

  async function saveConnectForm() {
    if (!connectTarget) return;
    const saveBtn = $('#gemcoreConnectSave');
    const hint = $('#gemcoreConnectHint');
    saveBtn.disabled = true;
    hint.textContent = 'Testing connection…';
    try {
      const result = await bridge().providerConnect({
        providerId: connectTarget,
        label: $('#gemcoreConnectLabel').value.trim(),
        baseUrl: $('#gemcoreConnectUrl').value.trim(),
        apiKey: $('#gemcoreConnectKey').value.trim()
      });
      if (result && result.connected) {
        hint.textContent = '✓ Connected — ' + (result.modelCount != null ? result.modelCount + ' models discovered' : 'ready');
        setTimeout(() => { $('#gemcoreProviderConnect').hidden = true; }, 900);
      } else {
        const error = result && result.error || {};
        hint.textContent = '✗ ' + (error.message || 'Connection failed') + (error.technicalDetails ? ' — ' + String(error.technicalDetails).slice(0, 200) : '');
      }
    } catch (error) {
      hint.textContent = '✗ ' + (error && error.message || error);
    } finally {
      saveBtn.disabled = false;
      refreshProviders();
    }
  }

  async function handleProviderAction(action, providerId) {
    try {
      if (action === 'connect' || action === 'manage') openConnectForm(providerId);
      else if (action === 'test') { await bridge().providerTest(providerId); refreshProviders(); }
      else if (action === 'disconnect') { await bridge().providerDisconnect(providerId); refreshProviders(); }
      else if (action === 'remove') { await bridge().providerRemove(providerId); refreshProviders(); }
      else if (action === 'keyurl') await bridge().openProviderUrl(providerId, 'apiKey');
      else if (action === 'docsurl') await bridge().openProviderUrl(providerId, 'docs');
    } catch (error) {
      console.warn('[gemcore] provider action failed', error);
    }
  }

  async function handleModelDefault(providerId, modelId) {
    try { await bridge().modelDefault(providerId, modelId); refreshProviders(); }
    catch (error) { console.warn('[gemcore] set default model failed', error); }
  }

  async function runDiagnostics() {
    const summary = $('#gemcoreDiagnosticsSummary');
    const detail = $('#gemcoreDiagnosticsDetail');
    if (!bridge().diagnostics) return;
    summary.textContent = 'Running…';
    try {
      const diagnostics = await bridge().diagnostics();
      const connected = (diagnostics.providers || []).filter((p) => p.connected).length;
      const open = Object.values(diagnostics.circuits || {}).filter((c) => c.open).length;
      summary.textContent = `${connected} provider(s) connected · ${open} circuit(s) open`;
      detail.hidden = false;
      detail.textContent = JSON.stringify(diagnostics, null, 2).slice(0, 6000);
    } catch (error) {
      summary.textContent = 'Diagnostics failed: ' + (error && error.message || error);
    }
  }

  /* ============================================================
     Scoped memory UI (AERA)
     ============================================================ */
  let memoryScope = 'user';

  async function refreshMemory() {
    if (!bridge().memoryList) return;
    try {
      const [lists, stats] = await Promise.all([bridge().memoryList(), bridge().memoryStats()]);
      renderMemory(lists, stats);
    } catch (error) {
      console.warn('[gemcore] memory list failed', error);
    }
  }

  function renderMemory(lists, stats) {
    const container = $('#gemcoreMemoryList');
    const statsEl = $('#gemcoreMemoryStats');
    if (!container) return;
    $$('.gc-mem-tab').forEach((tab) => {
      tab.style.borderColor = tab.dataset.memscope === memoryScope ? 'var(--accent,#8ea2ff)' : '';
    });
    if (statsEl && stats) statsEl.textContent = `user: ${stats.user ? stats.user.count : 0} · task: ${stats.task ? stats.task.count : 0} · long-term: ${stats['long-term'] ? stats['long-term'].count : 0}`;
    const items = (lists[memoryScope] || []);
    container.innerHTML = items.length === 0
      ? '<div class="gc-desc">No memories in this scope yet.</div>'
      : items.map((memory) => `
        <div class="gc-mem-item">
          <span class="scope">${esc(memory.scope)}</span>
          <span style="flex:1;word-break:break-word;">${esc(memory.content)}</span>
          <button class="gc-btn del" data-gc-mem-del="${esc(memory.id)}" type="button" title="Forget this memory">✕</button>
        </div>`).join('');
  }

  async function addMemory() {
    const input = $('#gemcoreMemoryInput');
    const value = input.value.trim();
    if (!value) return;
    const b = requireBridge($('#gemcoreMemoryStats'));
    if (!b) return;
    try {
      await b.memoryRemember(value, { scope: memoryScope });
      input.value = '';
      refreshMemory();
    } catch (error) {
      console.warn('[gemcore] remember failed', error);
    }
  }

  /* ============================================================
     Audit UI (AERA)
     ============================================================ */
  async function refreshAudit() {
    if (!bridge().auditRecent) return;
    try {
      const [recent, stats] = await Promise.all([bridge().auditRecent(60), bridge().auditStats()]);
      renderAudit(recent, stats);
    } catch (error) {
      console.warn('[gemcore] audit list failed', error);
    }
  }

  function renderAudit(recent, stats) {
    const list = $('#gemcoreAuditList');
    const statsEl = $('#gemcoreAuditStats');
    if (statsEl && stats) {
      statsEl.textContent = stats.total + ' entries · chain ' + (stats.chain && stats.chain.valid ? '✓ intact' : '✗ BROKEN');
    }
    if (!list) return;
    list.innerHTML = recent.length === 0
      ? 'No audited actions yet.'
      : recent.map((entry) => {
        const parts = [fmtTime(entry.at), entry.kind, entry.tool ? entry.tool : '', entry.outcome ? '→ ' + entry.outcome : '', entry.detail ? '· ' + entry.detail : '', entry.error ? '⚠ ' + entry.error : ''];
        return `<div class="gc-audit-line">${esc(parts.filter(Boolean).join('  ')).slice(0, 300)}</div>`;
      }).join('');
  }

  async function verifyAudit() {
    try {
      const result = await bridge().auditVerify();
      const statsEl = $('#gemcoreAuditStats');
      if (statsEl) statsEl.textContent = result.valid
        ? '✓ Chain verified — ' + result.entries + ' entries intact'
        : '✗ Chain BROKEN at ' + (result.brokenAt || '?') + ' (' + (result.reason || '') + ')';
      refreshAudit();
    } catch (error) { console.warn('[gemcore] verify failed', error); }
  }

  /* ============================================================
     Impact tiers UI (AERA)
     ============================================================ */
  async function refreshTiers() {
    if (!bridge().toolTiers) return;
    try {
      const data = await bridge().toolTiers();
      renderTiers(data.impact || {});
    } catch (error) { console.warn('[gemcore] tiers failed', error); }
  }

  function renderTiers(impact) {
    const table = $('#gemcoreTierTable');
    if (!table) return;
    const byTier = {};
    for (const [tool, tier] of Object.entries(impact)) {
      (byTier[tier] = byTier[tier] || []).push(tool);
    }
    table.innerHTML = Object.entries(byTier).map(([tier, tools]) => `
      <div style="margin-bottom:8px;">
        <span class="gc-chip ${esc(tier)}">${esc(tier)}</span>
        <span class="gc-desc">${tools.map(esc).join(' · ')}</span>
      </div>`).join('') +
      '<div class="gc-desc">Unknown tools default to <b>HIGH</b> and always ask.</div>';
  }

  /* ============================================================
     Reasoning trace UI (AERA)
     ============================================================ */
  async function refreshReasoning() {
    if (!bridge().reasoning) return;
    try {
      const data = await bridge().reasoning(30);
      renderReasoning(data);
    } catch (error) { console.warn('[gemcore] reasoning failed', error); }
  }

  function renderReasoning(data) {
    const list = $('#gemcoreReasoningList');
    const summary = $('#gemcoreReasoningSummary');
    if (summary && data && data.summary) {
      const byLevel = Object.entries(data.summary.byLevel || {}).map(([level, count]) => level + ':' + count).join(' · ') || 'empty';
      summary.textContent = data.summary.total + ' traced inferences — ' + byLevel;
    }
    if (!list) return;
    const recent = (data && data.recent) || [];
    list.innerHTML = recent.length === 0
      ? 'No reasoning traced yet — send a message through a GemCore path.'
      : recent.map((entry) => `<div class="gc-audit-line">[${esc(entry.level)}] ${fmtTime(entry.at)} ${esc(entry.phase || '')} ${esc(entry.detail || '')}`.slice(0, 280) + '</div>').join('');
  }

  /* ============================================================
     Multi-AI team modal (ALTREX director)
     ============================================================ */
  let teamUnsubscribe = null;
  let teamAgentState = [];

  function openTeamModal(prefill) {
    const modal = $('#gemcoreTeamModal');
    if (!modal) return;
    modal.classList.add('open');
    if (prefill && $('#gemcoreTeamInput')) $('#gemcoreTeamInput').value = prefill;
    if (!$('#gemcoreTeamStatus').textContent) $('#gemcoreTeamStatus').textContent = 'Describe the job, then assemble the team.';
  }

  function closeTeamModal() {
    const modal = $('#gemcoreTeamModal');
    if (modal) modal.classList.remove('open');
  }

  function renderTeamAgents() {
    const container = $('#gemcoreTeamAgents');
    if (!container) return;
    container.innerHTML = teamAgentState.map((agent) => `
      <div class="gc-agent" data-gc-agent="${esc(agent.agentId)}">
        <div class="gc-agent-head">
          <span class="gc-agent-status ${esc(agent.status)}">${esc(agent.status)}</span>
          <b style="font-size:13px;">${esc(agent.role)}</b>
          <span class="gc-desc" style="font-family:var(--font-mono,monospace);font-size:10px;">${esc(agent.agentId)}</span>
          ${agent.dependsOn && agent.dependsOn.length ? `<span class="gc-desc" style="font-size:10px;">depends on: ${agent.dependsOn.map(esc).join(', ')}</span>` : ''}
          ${agent.outputPreview ? `<button class="gc-btn" data-gc-agent-toggle="${esc(agent.agentId)}" type="button" style="margin-left:auto;">show output</button>` : ''}
        </div>
        <div class="gc-agent-desc">${esc(agent.description || '')}</div>
        ${agent.error ? `<div class="gc-err">⚠ ${esc(agent.error)}</div>` : ''}
        <div class="gc-agent-out" data-gc-agent-out="${esc(agent.agentId)}">${esc(agent.outputPreview || '')}</div>
      </div>`).join('') || '<div class="gc-desc">No team yet.</div>';
  }

  function syncTeamAgents(snapshot) {
    if (!snapshot || !snapshot.agents) return;
    const previous = new Map(teamAgentState.map((agent) => [agent.agentId, agent]));
    teamAgentState = snapshot.agents.map((agent) => {
      const existing = previous.get(agent.agentId);
      return { ...agent, outputPreview: agent.outputPreview || (existing ? existing.outputPreview : '') };
    });
    renderTeamAgents();
  }

  async function runTeam() {
    const request = ($('#gemcoreTeamInput') && $('#gemcoreTeamInput').value.trim()) || '';
    const statusEl = $('#gemcoreTeamStatus');
    const runBtn = $('#gemcoreTeamRun');
    const stopBtn = $('#gemcoreTeamStop');
    if (!request) { statusEl.textContent = 'Describe the job first.'; return; }
    if (!bridge().multiaiRun) { statusEl.textContent = 'GemCore bridge unavailable.'; return; }

    runBtn.disabled = true;
    stopBtn.hidden = false;
    statusEl.textContent = 'Planning the team…';
    teamAgentState = [];
    renderTeamAgents();

    if (teamUnsubscribe) { teamUnsubscribe(); teamUnsubscribe = null; }
    teamUnsubscribe = bridge().onMultiai((event) => {
      if (!event) return;
      if (event.type === 'planning') statusEl.textContent = event.message || 'Planning…';
      else if (event.type === 'plan') {
        statusEl.textContent = 'Team assembled — running.';
        if (event.plan && event.plan.tasks) {
          teamAgentState = event.plan.tasks.map((task) => ({
            agentId: task.agentId || task.taskId, role: task.role || 'agent',
            description: task.description || '', dependsOn: task.dependsOn || [],
            status: 'waiting', outputPreview: '', error: null
          }));
          renderTeamAgents();
        }
      } else if (event.type === 'phase') statusEl.textContent = 'Phase: ' + event.phase;
      else if (event.type === 'agent-started' || event.type === 'agent-completed' || event.type === 'agent-failed') {
        bridge().multiaiStatus().then(syncTeamAgents).catch(() => {});
      } else if (event.type === 'error') statusEl.textContent = '⚠ ' + (event.message || 'error');
      else if (event.type === 'session-ended') {
        statusEl.textContent = 'Session ' + event.phase + (event.summary ? ' — ' + event.summary.split('\n')[1] : '');
        runBtn.disabled = false;
        stopBtn.hidden = true;
        bridge().multiaiStatus().then(syncTeamAgents).catch(() => {});
      }
    });

    try {
      const result = await bridge().multiaiRun({ userRequest: request });
      if (!result || !result.ok) {
        statusEl.textContent = '⚠ ' + ((result && result.error) || 'Could not start the team.');
        runBtn.disabled = false;
        stopBtn.hidden = true;
      }
    } catch (error) {
      statusEl.textContent = '⚠ ' + (error && error.message || error);
      runBtn.disabled = false;
      stopBtn.hidden = true;
    }
  }

  async function stopTeam() {
    try { await bridge().multiaiStop(); } catch { /* ignore */ }
    $('#gemcoreTeamRun').disabled = false;
    $('#gemcoreTeamStop').hidden = true;
    $('#gemcoreTeamStatus').textContent = 'Stopped.';
    bridge().multiaiStatus().then(syncTeamAgents).catch(() => {});
  }

  /* ============================================================
     Event wiring
     ============================================================ */
  function wireEvents() {
    // Provider grid actions (delegated)
    document.addEventListener('click', async (event) => {
      const actionBtn = event.target.closest('[data-gc-act]');
      if (actionBtn) {
        event.preventDefault();
        await handleProviderAction(actionBtn.dataset.gcAct, actionBtn.dataset.gcId);
        return;
      }
      const memDel = event.target.closest('[data-gc-mem-del]');
      if (memDel) {
        const b = requireBridge();
        if (b) { await b.memoryForget(memDel.dataset.gcMemDel); refreshMemory(); }
        return;
      }
      const agentToggle = event.target.closest('[data-gc-agent-toggle]');
      if (agentToggle) {
        const out = $(`[data-gc-agent-out="${agentToggle.dataset.gcAgentToggle}"]`);
        if (out) {
          out.classList.toggle('open');
          agentToggle.textContent = out.classList.contains('open') ? 'hide output' : 'show output';
        }
      }
    });

    document.addEventListener('change', async (event) => {
      const modelSelect = event.target.closest('[data-gc-act="defaultmodel"]');
      if (modelSelect) await handleModelDefault(modelSelect.dataset.gcId, modelSelect.value);
    });

    const connectSave = $('#gemcoreConnectSave');
    if (connectSave) connectSave.addEventListener('click', saveConnectForm);
    const connectCancel = $('#gemcoreConnectCancel');
    if (connectCancel) connectCancel.addEventListener('click', () => { $('#gemcoreProviderConnect').hidden = true; });
    const diagnosticsBtn = $('#gemcoreDiagnosticsBtn');
    if (diagnosticsBtn) diagnosticsBtn.addEventListener('click', runDiagnostics);

    $$('.gc-mem-tab').forEach((tab) => {
      tab.addEventListener('click', () => { memoryScope = tab.dataset.memscope; refreshMemory(); });
    });
    const memoryAdd = $('#gemcoreMemoryAdd');
    if (memoryAdd) memoryAdd.addEventListener('click', () => { if (requireBridge($('#gemcoreMemoryStats'))) addMemory(); });
    const memoryInput = $('#gemcoreMemoryInput');
    if (memoryInput) memoryInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addMemory(); } });
    const memoryClear = $('#gemcoreMemoryClear');
    if (memoryClear) memoryClear.addEventListener('click', async () => {
      const b = requireBridge($('#gemcoreMemoryStats'));
      if (b && confirm('Clear all memories in the "' + memoryScope + '" scope?')) {
        await b.memoryClear(memoryScope);
        refreshMemory();
      }
    });

    const auditVerify = $('#gemcoreAuditVerify');
    if (auditVerify) auditVerify.addEventListener('click', verifyAudit);
    const auditClear = $('#gemcoreAuditClear');
    if (auditClear) auditClear.addEventListener('click', async () => {
      const b = requireBridge($('#gemcoreAuditStats'));
      if (b && confirm('Clear the entire audit log? This cannot be undone.')) { await b.auditClear(); refreshAudit(); }
    });

    const approveHigh = $('#gemcoreApproveHigh');
    if (approveHigh) approveHigh.addEventListener('click', async () => {
      if (!requireBridge()) return;
      await bridge().approveTier('HIGH');
      approveHigh.textContent = '✓ HIGH APPROVED FOR THIS SESSION';
      approveHigh.disabled = true;
    });
    const approveCritical = $('#gemcoreApproveCritical');
    if (approveCritical) approveCritical.addEventListener('click', async () => {
      const b = requireBridge();
      if (b && confirm('Approve CRITICAL-impact actions (shell commands, system control) for this whole session without asking each time?')) {
        await bridge().approveTier('CRITICAL');
        approveCritical.textContent = '✓ CRITICAL APPROVED FOR THIS SESSION';
        approveCritical.disabled = true;
      }
    });

    const reasoningRefresh = $('#gemcoreReasoningRefresh');
    if (reasoningRefresh) reasoningRefresh.addEventListener('click', refreshReasoning);

    // Multi-AI team modal
    const teamBtn = $('#gemcoreTeamBtn');
    if (teamBtn) teamBtn.addEventListener('click', () => {
      const chatInput = $('#chatInput');
      openTeamModal(chatInput ? chatInput.value.trim() : '');
    });
    const teamClose = $('#gemcoreTeamClose');
    if (teamClose) teamClose.addEventListener('click', closeTeamModal);
    const teamDone = $('#gemcoreTeamDone');
    if (teamDone) teamDone.addEventListener('click', closeTeamModal);
    const teamRun = $('#gemcoreTeamRun');
    if (teamRun) teamRun.addEventListener('click', runTeam);
    const teamStop = $('#gemcoreTeamStop');
    if (teamStop) teamStop.addEventListener('click', stopTeam);
    const teamModal = $('#gemcoreTeamModal');
    if (teamModal) teamModal.addEventListener('click', (event) => { if (event.target === teamModal) closeTeamModal(); });

    // Refresh the gemcore section when its settings tab is opened
    document.addEventListener('click', (event) => {
      const navBtn = event.target.closest('.settings-nav-btn[data-ssection="gemcore"]');
      if (navBtn) {
        refreshProviders();
        refreshMemory();
        refreshAudit();
        refreshTiers();
        refreshReasoning();
      }
    });
  }

  /* ============================================================
     Public API — window.GemCore
     ============================================================ */
  window.GemCore = {
    // Hardened chat (streaming, tools, budgets, compaction, recovery)
    chatStream(payload, handlers) {
      if (!bridge() || !bridge().chatStream) {
        if (handlers && handlers.onError) handlers.onError({ message: 'GemCore bridge unavailable.' });
        return Promise.resolve({ ok: false });
      }
      return bridge().chatStream(payload, handlers || {});
    },
    abort(requestId) { return bridge().abort(requestId); },
    // Emotion-aware TTS
    emotionFor,
    speakWithEmotion,
    AERA_EMOTIONS,
    // Team
    openTeamModal, closeTeamModal,
    // Refreshers (used when settings open elsewhere)
    refreshProviders, refreshMemory, refreshAudit, refreshTiers, refreshReasoning
  };

  /* ---------------- boot ---------------- */
  function boot() {
    injectStyles();
    wireEmotions();
    wireEvents();
    refreshProviders();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
