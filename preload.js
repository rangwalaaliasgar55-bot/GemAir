// GemAir 2.5 — preload (contextBridge)
const { contextBridge, ipcRenderer } = require('electron');

function subscribeIpc(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('gemair', {
  platform: process.platform,
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getActionLog: () => ipcRenderer.invoke('audit:get'),
  screenInspect: () => ipcRenderer.invoke('screen:inspect'),
  consumeRecovery: () => ipcRenderer.invoke('recovery:consume'),
  usageGet: () => ipcRenderer.invoke('usage:get'),
  usageTrack: (action, metadata) => ipcRenderer.invoke('usage:track', action, metadata || {}),
  usageClear: () => ipcRenderer.invoke('usage:clear'),
  getProfile: () => ipcRenderer.invoke('profile:get'),
  setProfile: (data) => ipcRenderer.invoke('profile:set', data),
  aiChat: (config, messages) => ipcRenderer.invoke('ai:chat', config, messages),
  aiChatStream: (config, messages, onDelta) => {
    const reqId = 'r' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const onChunk = (_e, data) => { if (data.reqId === reqId) onDelta(data.delta); };
      const onEnd = (_e, data) => { if (data.reqId === reqId) { cleanup(); resolve({ ok: true, reply: data.reply, provider: data.provider, model: data.model, fallbackFrom: data.fallbackFrom }); } };
      const onErr = (_e, data) => { if (data.reqId === reqId) { cleanup(); resolve({ ok: false, error: data.error }); } };
      const cleanup = () => { ipcRenderer.removeListener('ai:chunk', onChunk); ipcRenderer.removeListener('ai:streamEnd', onEnd); ipcRenderer.removeListener('ai:streamError', onErr); };
      ipcRenderer.on('ai:chunk', onChunk);
      ipcRenderer.on('ai:streamEnd', onEnd);
      ipcRenderer.on('ai:streamError', onErr);
      ipcRenderer.invoke('ai:chatStream', reqId, config, messages).catch((e) => { cleanup(); reject(e); });
    });
  },
  aiSummarize: (config, text) => ipcRenderer.invoke('ai:summarize', config, text),
  aiAgentChat: (agentName, config, messages) => ipcRenderer.invoke('ai:agentChat', agentName, config, messages),
  collaborateAgents: (task) => ipcRenderer.invoke('agent:collaborate', task),
  aiOffline: (text) => ipcRenderer.invoke('ai:offline', text),
  sidecarsStatus: () => ipcRenderer.invoke('sidecars:status'),
  openJarvisInstall: () => ipcRenderer.invoke('openjarvis:install'),
  openJarvisCancelInstall: () => ipcRenderer.invoke('openjarvis:cancelInstall'),
  openJarvisAsk: (mode, query, context) => ipcRenderer.invoke('openjarvis:ask', mode, query, context),
  openJarvisMemorySearch: (query, topK) => ipcRenderer.invoke('openjarvis:memorySearch', query, topK),
  openJarvisScan: (text, includePii) => ipcRenderer.invoke('openjarvis:scan', text, !!includePii),
  openJarvisCapabilities: () => ipcRenderer.invoke('openjarvis:capabilities'),
  openJarvisSkillCatalog: () => ipcRenderer.invoke('openjarvis:skillCatalog'),
  openJarvisMcpDiscover: () => ipcRenderer.invoke('openjarvis:mcpDiscover'),
  onOpenJarvisInstallProgress: (cb) => subscribeIpc('openjarvis:installProgress', cb),
  listLocalModels: () => ipcRenderer.invoke('ai:listLocalModels'),
  getHeadlines: (limit, category) => ipcRenderer.invoke('news:get', limit, category),
  webGet: (kind, params) => ipcRenderer.invoke('web:get', kind, params || {}),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  checkForUpdates: (force = false) => ipcRenderer.invoke('app:checkForUpdates', !!force),
  installUpdate: (releaseUrl) => ipcRenderer.invoke('app:installUpdate', releaseUrl),
  applyUpdate: () => ipcRenderer.invoke('app:applyUpdate'),
  onUpdateAvailable: (cb) => subscribeIpc('app:update-available', cb),
  onUpdaterEvent: (cb) => subscribeIpc('app:updater-event', cb),
  version: () => ipcRenderer.invoke('app:version'),
  updaterStatus: () => ipcRenderer.invoke('app:updaterStatus'),
  borrowGeminiKey: () => ipcRenderer.invoke('connections:borrowGeminiKey'),
  openExtensionFolder: () => ipcRenderer.invoke('app:openExtensionFolder'),
  extensionFolderPath: () => ipcRenderer.invoke('app:extensionFolderPath'),
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),

  memoryGet: () => ipcRenderer.invoke('memory:get'),
  memoryAppend: (role, content) => ipcRenderer.invoke('memory:append', role, content),
  memoryClearTranscript: () => ipcRenderer.invoke('memory:clearTranscript'),
  memoryAddFact: (fact) => ipcRenderer.invoke('memory:addFact', fact),
  memoryDeleteFact: (id) => ipcRenderer.invoke('memory:deleteFact', id),
  memoryAddNote: (text) => ipcRenderer.invoke('memory:addNote', text),
  memoryDeleteNote: (id) => ipcRenderer.invoke('memory:deleteNote', id),
  memoryAddReminder: (text, at, repeat) => ipcRenderer.invoke('memory:addReminder', text, at, repeat),
  memoryDeleteReminder: (id) => ipcRenderer.invoke('memory:deleteReminder', id),
  memoryMarkReminder: (id, done) => ipcRenderer.invoke('memory:markReminder', id, done),
  memoryExtract: (config, userText, assistantText) => ipcRenderer.invoke('memory:extract', config, userText, assistantText),
  memoryAddMood: (emotion, note) => ipcRenderer.invoke('memory:addMood', emotion, note),
  memoryAddGoal: (text, category) => ipcRenderer.invoke('memory:addGoal', text, category),
  memoryDeleteGoal: (id) => ipcRenderer.invoke('memory:deleteGoal', id),
  memoryToggleGoal: (id) => ipcRenderer.invoke('memory:toggleGoal', id),
  analyzeEmotion: (text) => ipcRenderer.invoke('emotion:analyze', text),
  memoryAddSkill: (text, name) => ipcRenderer.invoke('memory:addSkill', text, name),
  memoryDeleteSkill: (id) => ipcRenderer.invoke('memory:deleteSkill', id),
  memoryAddInstruction: (text) => ipcRenderer.invoke('memory:addInstruction', text),
  memoryDeleteInstruction: (id) => ipcRenderer.invoke('memory:deleteInstruction', id),

  listProcesses: (limit) => ipcRenderer.invoke('proc:list', limit),
  killProcess: (pid, name) => ipcRenderer.invoke('proc:kill', pid, name),

  memoryListTodos: () => ipcRenderer.invoke('memory:listTodos'),
  memoryAddTodo: (text) => ipcRenderer.invoke('memory:addTodo', text),
  memoryToggleTodo: (id) => ipcRenderer.invoke('memory:toggleTodo', id),
  memoryDeleteTodo: (id) => ipcRenderer.invoke('memory:deleteTodo', id),

  saveWindowBounds: () => ipcRenderer.invoke('win:saveBounds'),
  saveCode: (content, suggestedName) => ipcRenderer.invoke('file:saveCode', content, suggestedName),

  generateReport: () => ipcRenderer.invoke('report:generate'),
  generateDailyDigest: () => ipcRenderer.invoke('digest:generate'),
  onDailyDigest: (cb) => subscribeIpc('digest:ready', cb),
  onDailyDigestError: (cb) => subscribeIpc('digest:error', cb),
  needsCheckIn: () => ipcRenderer.invoke('report:needsCheckIn'),
  exportMemory: () => ipcRenderer.invoke('memory:export'),
  importMemory: (data) => ipcRenderer.invoke('memory:import', data),

  connectionsOauthChatGPT: () => ipcRenderer.invoke('connections:oauthChatGPT'),
  connectionsPollChatGPT: (loginId) => ipcRenderer.invoke('connections:pollChatGPT', loginId),
  connectionsCancelChatGPT: (loginId) => ipcRenderer.invoke('connections:cancelChatGPT', loginId),
  connectionsRefreshChatGPTModels: () => ipcRenderer.invoke('connections:refreshChatGPTModels'),
  connectionsSetChatGPTPreferences: (prefs) => ipcRenderer.invoke('connections:setChatGPTPreferences', prefs),
  connectionsImportCodex: () => ipcRenderer.invoke('connections:importCodex'),
  connectionsCodexStatus: () => ipcRenderer.invoke('connections:codexStatus'),
  connectionsLaunchCodexLogin: () => ipcRenderer.invoke('connections:launchCodexLogin'),
  connectionsOauthGemini: () => ipcRenderer.invoke('connections:oauthGemini'),
  connectionsGetStatus: () => ipcRenderer.invoke('connections:getStatus'),
  connectionsSetGeminiApiKey: (apiKey, model) => ipcRenderer.invoke('connections:setGeminiApiKey', apiKey, model),
  connectionsTestGeminiApiKey: (apiKey, model) => ipcRenderer.invoke('connections:testGeminiApiKey', apiKey, model),
  connectionsListGeminiModels: (apiKey) => ipcRenderer.invoke('connections:listGeminiModels', apiKey),
  onConnectionsUpdated: (cb) => subscribeIpc('connections:updated', cb),
  connectionsSetPriority: (p) => ipcRenderer.invoke('connections:setPriority', p),
  connectionsAcknowledgeWarning: () => ipcRenderer.invoke('connections:acknowledgeWarning'),
  connectionsOpenChatGPT: () => ipcRenderer.invoke('connections:openChatGPT'),
  connectionsCaptureChatGPT: () => ipcRenderer.invoke('connections:captureChatGPT'),
  connectionsImportSessionJson: (text) => ipcRenderer.invoke('connections:importSessionJson', text),
  connectionsValidateSessionJson: (text) => ipcRenderer.invoke('connections:validateSessionJson', text),
  connectionsOpenGemini: () => ipcRenderer.invoke('connections:openGemini'),
  connectionsCaptureGemini: (isFallback) => ipcRenderer.invoke('connections:captureGemini', isFallback),
  connectionsOpenAIStudio: () => ipcRenderer.invoke('connections:openAIStudio'),
  connectionsDisconnect: (provider) => ipcRenderer.invoke('connections:disconnect', provider),
  connectionsClearAll: () => ipcRenderer.invoke('connections:clearAll'),
  connectionsChatStream: (provider, messages, onDelta) => {
    const reqId = 'r' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const onChunk = (_e, data) => { if (data.reqId === reqId) onDelta(data.delta); };
      const onEnd = (_e, data) => { if (data.reqId === reqId) { cleanup(); resolve({ ok: true, reply: data.reply, provider: data.provider, model: data.model, fallbackFrom: data.fallbackFrom, sourceError: data.sourceError }); } };
      const onErr = (_e, data) => { if (data.reqId === reqId) { cleanup(); resolve({ ok: false, error: data.error, detail: data.detail, provider: data.provider, sessionExpired: data.sessionExpired === true, retryable: data.retryable === true }); } };
      const cleanup = () => { ipcRenderer.removeListener('ai:chunk', onChunk); ipcRenderer.removeListener('ai:streamEnd', onEnd); ipcRenderer.removeListener('ai:streamError', onErr); };
      ipcRenderer.on('ai:chunk', onChunk);
      ipcRenderer.on('ai:streamEnd', onEnd);
      ipcRenderer.on('ai:streamError', onErr);
      ipcRenderer.invoke('connections:chatStream', reqId, provider, messages).catch((e) => { cleanup(); reject(e); });
    });
  },

  modesList: () => ipcRenderer.invoke('modes:list'),
  modesGet: (name) => ipcRenderer.invoke('modes:get', name),
  modesSave: (mode) => ipcRenderer.invoke('modes:save', mode),
  modesDelete: (name) => ipcRenderer.invoke('modes:delete', name),
  modesApply: (name) => ipcRenderer.invoke('modes:apply', name),

  desktopListWindows: () => ipcRenderer.invoke('desktop:listWindows'),
  desktopGetFocused: () => ipcRenderer.invoke('desktop:getFocused'),
  desktopLaunchApp: (name, args) => ipcRenderer.invoke('desktop:launchApp', name, args),
  desktopFocusApp: (name) => ipcRenderer.invoke('desktop:focusApp', name),
  desktopSnapWindow: (dir) => ipcRenderer.invoke('desktop:snapWindow', dir),
  desktopMinimizeAll: () => ipcRenderer.invoke('desktop:minimizeAll'),
  desktopNextDesktop: () => ipcRenderer.invoke('desktop:nextDesktop'),
  desktopOpenSite: (url, browser) => ipcRenderer.invoke('desktop:openSite', url, browser),
  desktopSetVolume: (args) => ipcRenderer.invoke('desktop:setVolume', args),

  computerUse: (task, config) => ipcRenderer.invoke('agent:computerUse', task, config || {}),
  computerUseStop: () => ipcRenderer.invoke('agent:computerUseStop'),
  computerUseStatus: () => ipcRenderer.invoke('agent:computerUseStatus'),
  computerUseScreen: () => ipcRenderer.invoke('agent:computerUseScreen'),
  onComputerUseEvent: (cb) => subscribeIpc('agent:computerEvent', cb),
  codingUse: (task, workingDir, config) => ipcRenderer.invoke('agent:codingUse', task, workingDir, config || {}),
  codingUseStop: () => ipcRenderer.invoke('agent:codingUseStop'),
  codingUseStatus: () => ipcRenderer.invoke('agent:codingUseStatus'),
  onCodingUseEvent: (cb) => subscribeIpc('agent:codingEvent', cb),

  onReminder: (cb) => subscribeIpc('reminder:due', cb),
  onTopicMonitorAlert: (cb) => subscribeIpc('monitor:alert', cb),
  onWakeToggle: (cb) => subscribeIpc('wake:toggle', cb),
  onActivity: (cb) => subscribeIpc('ai:activity', cb),
  onHudPanel: (cb) => subscribeIpc('hud:panel', cb),
  onConnectionsUpdated: (cb) => subscribeIpc('connections:updated', cb),
  onConnectionsExpired: (cb) => subscribeIpc('connections:expired', cb),
  onDesktopFocus: (cb) => subscribeIpc('desktop:focus', cb),
  onDesktopVolume: (cb) => subscribeIpc('desktop:volume', cb),
  onDesktopTheme: (cb) => subscribeIpc('desktop:theme', cb),
  onDesktopDnd: (cb) => subscribeIpc('desktop:dnd', cb),
  onModeChanged: (cb) => subscribeIpc('mode:changed', cb)
});

/* ---------- Gem Air — attention layer API ----------
   Exposed separately so the island window and the main UI share one contract. */
/* ============================================================
   GemCore bridge — ALTREX provider engine + AERA systems
   ============================================================ */
contextBridge.exposeInMainWorld('gemcore', {
  // Provider lifecycle
  providers: () => ipcRenderer.invoke('gemcore:providers'),
  providerConnect: (payload) => ipcRenderer.invoke('gemcore:providerConnect', payload || {}),
  providerUpdate: (providerId, patch) => ipcRenderer.invoke('gemcore:providerUpdate', providerId, patch || {}),
  providerTest: (providerId) => ipcRenderer.invoke('gemcore:providerTest', providerId),
  providerDisconnect: (providerId) => ipcRenderer.invoke('gemcore:providerDisconnect', providerId),
  providerRemove: (providerId) => ipcRenderer.invoke('gemcore:providerRemove', providerId),
  openProviderUrl: (providerId, kind) => ipcRenderer.invoke('gemcore:openProviderUrl', providerId, kind),
  status: () => ipcRenderer.invoke('gemcore:status'),
  diagnostics: () => ipcRenderer.invoke('gemcore:diagnostics'),

  // Model registry
  modelDefault: (providerId, modelId) => ipcRenderer.invoke('gemcore:modelDefault', providerId, modelId),
  modelToggle: (providerId, modelId, disabled) => ipcRenderer.invoke('gemcore:modelToggle', providerId, modelId, disabled),
  modelRemove: (providerId, modelId) => ipcRenderer.invoke('gemcore:modelRemove', providerId, modelId),
  modelRestore: (providerId, modelId) => ipcRenderer.invoke('gemcore:modelRestore', providerId, modelId),

  // Scoped memory (AERA)
  memoryList: (scope) => ipcRenderer.invoke('gemcore:memoryList', scope),
  memoryRemember: (content, options) => ipcRenderer.invoke('gemcore:memoryRemember', content, options || {}),
  memoryRecall: (query, scope) => ipcRenderer.invoke('gemcore:memoryRecall', query, scope),
  memoryForget: (memoryId) => ipcRenderer.invoke('gemcore:memoryForget', memoryId),
  memoryClear: (scope) => ipcRenderer.invoke('gemcore:memoryClear', scope),
  memoryStats: () => ipcRenderer.invoke('gemcore:memoryStats'),

  // Audit log (AERA)
  auditRecent: (limit, kind) => ipcRenderer.invoke('gemcore:auditRecent', limit, kind),
  auditStats: () => ipcRenderer.invoke('gemcore:auditStats'),
  auditVerify: () => ipcRenderer.invoke('gemcore:auditVerify'),
  auditClear: () => ipcRenderer.invoke('gemcore:auditClear'),

  // Reasoning trace (AERA)
  reasoning: (limit) => ipcRenderer.invoke('gemcore:reasoning', limit),

  // Emotion profiles (AERA)
  emotion: (payload) => ipcRenderer.invoke('gemcore:emotion', payload || {}),
  emotionProfiles: () => ipcRenderer.invoke('gemcore:emotionProfiles'),

  // Impact tiers (AERA tool broker)
  approveTier: (tier) => ipcRenderer.invoke('gemcore:approveTier', tier),
  toolTiers: () => ipcRenderer.invoke('gemcore:toolTiers'),

  // Hardened chat with tools, budgets, compaction, recovery
  chatStream: (payload, handlers) => {
    const reqId = 'gc' + Math.random().toString(36).slice(2);
    const onChunk = (data) => { if (data.requestId === reqId && handlers.onDelta) handlers.onDelta(data.text); };
    const onTool = (data) => { if (data.requestId === reqId && handlers.onTool) handlers.onTool(data); };
    const onToolResult = (data) => { if (data.requestId === reqId && handlers.onToolResult) handlers.onToolResult(data); };
    const onSystem = (data) => { if (data.requestId === reqId && handlers.onSystem) handlers.onSystem(data); };
    const onError = (data) => { if (data.requestId === reqId && handlers.onError) handlers.onError(data); };
    const onDone = (data) => {
      if (data.requestId !== reqId) return;
      cleanup();
      if (handlers.onDone) handlers.onDone(data);
    };
    const cleanup = () => {
      ipcRenderer.removeListener('gemcore:chunk', onChunk);
      ipcRenderer.removeListener('gemcore:tool', onTool);
      ipcRenderer.removeListener('gemcore:toolResult', onToolResult);
      ipcRenderer.removeListener('gemcore:system', onSystem);
      ipcRenderer.removeListener('gemcore:error', onError);
      ipcRenderer.removeListener('gemcore:done', onDone);
    };
    ipcRenderer.on('gemcore:chunk', onChunk);
    ipcRenderer.on('gemcore:tool', onTool);
    ipcRenderer.on('gemcore:toolResult', onToolResult);
    ipcRenderer.on('gemcore:system', onSystem);
    ipcRenderer.on('gemcore:error', onError);
    ipcRenderer.on('gemcore:done', onDone);
    return ipcRenderer.invoke('gemcore:chatStream', { ...(payload || {}), requestId: reqId }).then((start) => ({ ...start, requestId: reqId })).catch((error) => { cleanup(); throw error; });
  },
  abort: (requestId) => ipcRenderer.invoke('gemcore:abort', requestId),

  // Multi-AI director (ALTREX)
  multiaiRun: (payload) => ipcRenderer.invoke('gemcore:multiaiRun', payload || {}),
  multiaiStatus: () => ipcRenderer.invoke('gemcore:multiaiStatus'),
  multiaiStop: () => ipcRenderer.invoke('gemcore:multiaiStop'),
  onMultiai: (cb) => subscribeIpc('gemcore:multiai', cb)
});


contextBridge.exposeInMainWorld('air', {
  platform: process.platform,
  snapshot: () => ipcRenderer.invoke('air:snapshot'),
  state: () => ipcRenderer.invoke('air:state'),
  setAppView: (view) => ipcRenderer.invoke('air:setAppView', view),
  tabs: (limit) => ipcRenderer.invoke('air:tabs', limit),
  focusTab: (entry) => ipcRenderer.invoke('air:focusTab', entry),
  capabilities: () => ipcRenderer.invoke('air:capabilities'),

  summary: (day) => ipcRenderer.invoke('air:summary', day),
  timeline: (day) => ipcRenderer.invoke('air:timeline', day),
  trend: (days) => ipcRenderer.invoke('air:trend', days),
  recent: (limit) => ipcRenderer.invoke('air:recent', limit),
  lastHour: () => ipcRenderer.invoke('air:lastHour'),
  resetActivity: () => ipcRenderer.invoke('air:resetActivity'),
  exportData: () => ipcRenderer.invoke('air:export'),

  answer: (questionId, categoryId) => ipcRenderer.invoke('air:answer', questionId, categoryId),
  dismissQuestion: () => ipcRenderer.invoke('air:dismissQuestion'),
  createCategory: (payload) => ipcRenderer.invoke('air:createCategory', payload),
  deleteCategory: (id) => ipcRenderer.invoke('air:deleteCategory', id),
  classify: (payload) => ipcRenderer.invoke('air:classify', payload),
  deleteRule: (kind, match) => ipcRenderer.invoke('air:deleteRule', kind, match),

  addBlock: (payload) => ipcRenderer.invoke('air:addBlock', payload),
  removeBlock: (kind, id) => ipcRenderer.invoke('air:removeBlock', kind, id),
  toggleBlock: (kind, id, enabled) => ipcRenderer.invoke('air:toggleBlock', kind, id, enabled),
  addException: (payload) => ipcRenderer.invoke('air:addException', payload),
  removeException: (id) => ipcRenderer.invoke('air:removeException', id),
  attempts: (limit) => ipcRenderer.invoke('air:attempts', limit),
  requestSystemBlock: (hosts) => ipcRenderer.invoke('air:systemBlockRequest', hosts),

  savePlan: (plan) => ipcRenderer.invoke('air:savePlan', plan),
  startFocus: (minutes) => ipcRenderer.invoke('air:startFocus', minutes),
  deletePlan: (id) => ipcRenderer.invoke('air:deletePlan', id),
  togglePlan: (id, enabled) => ipcRenderer.invoke('air:togglePlan', id, enabled),
  activeBlocks: () => ipcRenderer.invoke('air:activeBlocks'),

  setSleep: (sleep) => ipcRenderer.invoke('air:setSleep', sleep),
  sleepStatus: () => ipcRenderer.invoke('air:sleepStatus'),

  setSettings: (patch) => ipcRenderer.invoke('air:setSettings', patch),
  setStartup: (enabled) => ipcRenderer.invoke('air:setStartup', enabled),
  bridgeStatus: () => ipcRenderer.invoke('air:bridgeStatus'),
  bridgePair: () => ipcRenderer.invoke('air:bridgePair'),
  browserPolicy: () => ipcRenderer.invoke('air:browserPolicy'),

  island: (action, payload) => ipcRenderer.invoke('air:island', action, payload),
  islandResize: (mode) => ipcRenderer.invoke('air:islandResize', mode),
  openMain: (tab) => ipcRenderer.invoke('air:openMain', tab),
  openFocusx: (path) => ipcRenderer.invoke('air:openFocusx', path),

  onUpdate: (cb) => subscribeIpc('air:update', cb),
  onQuestion: (cb) => subscribeIpc('air:question', cb),
  onAttempt: (cb) => subscribeIpc('air:attempt', cb),
  onEnforced: (cb) => subscribeIpc('air:enforced', cb),
  onNavigate: (cb) => subscribeIpc('air:navigate', cb)
});
