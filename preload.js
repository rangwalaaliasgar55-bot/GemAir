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
      const onEnd = (_e, data) => { if (data.reqId === reqId) { cleanup(); resolve({ ok: true, reply: data.reply }); } };
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
  listLocalModels: () => ipcRenderer.invoke('ai:listLocalModels'),
  getHeadlines: (limit, category) => ipcRenderer.invoke('news:get', limit, category),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  checkForUpdates: (force = false) => ipcRenderer.invoke('app:checkForUpdates', !!force),
  installUpdate: (releaseUrl) => ipcRenderer.invoke('app:installUpdate', releaseUrl),
  applyUpdate: () => ipcRenderer.invoke('app:applyUpdate'),
  onUpdateAvailable: (cb) => subscribeIpc('app:update-available', cb),
  onUpdaterEvent: (cb) => subscribeIpc('app:updater-event', cb),
  version: () => ipcRenderer.invoke('app:version'),

  memoryGet: () => ipcRenderer.invoke('memory:get'),
  memoryAppend: (role, content) => ipcRenderer.invoke('memory:append', role, content),
  memoryClearTranscript: () => ipcRenderer.invoke('memory:clearTranscript'),
  memoryAddFact: (fact) => ipcRenderer.invoke('memory:addFact', fact),
  memoryDeleteFact: (id) => ipcRenderer.invoke('memory:deleteFact', id),
  memoryAddNote: (text) => ipcRenderer.invoke('memory:addNote', text),
  memoryDeleteNote: (id) => ipcRenderer.invoke('memory:deleteNote', id),
  memoryAddReminder: (text, at) => ipcRenderer.invoke('memory:addReminder', text, at),
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
  needsCheckIn: () => ipcRenderer.invoke('report:needsCheckIn'),
  exportMemory: () => ipcRenderer.invoke('memory:export'),
  importMemory: (data) => ipcRenderer.invoke('memory:import', data),

  connectionsOauthChatGPT: () => ipcRenderer.invoke('connections:oauthChatGPT'),
  connectionsOauthGemini: () => ipcRenderer.invoke('connections:oauthGemini'),
  connectionsGetStatus: () => ipcRenderer.invoke('connections:getStatus'),
  connectionsSetPriority: (p) => ipcRenderer.invoke('connections:setPriority', p),
  connectionsAcknowledgeWarning: () => ipcRenderer.invoke('connections:acknowledgeWarning'),
  connectionsOpenChatGPT: () => ipcRenderer.invoke('connections:openChatGPT'),
  connectionsCaptureChatGPT: () => ipcRenderer.invoke('connections:captureChatGPT'),
  connectionsOpenGemini: () => ipcRenderer.invoke('connections:openGemini'),
  connectionsCaptureGemini: (isFallback) => ipcRenderer.invoke('connections:captureGemini', isFallback),
  connectionsOpenAIStudio: () => ipcRenderer.invoke('connections:openAIStudio'),
  connectionsDisconnect: (provider) => ipcRenderer.invoke('connections:disconnect', provider),
  connectionsClearAll: () => ipcRenderer.invoke('connections:clearAll'),
  connectionsChatStream: (provider, messages, onDelta) => {
    const reqId = 'r' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const onChunk = (_e, data) => { if (data.reqId === reqId) onDelta(data.delta); };
      const onEnd = (_e, data) => { if (data.reqId === reqId) { cleanup(); resolve({ ok: true, reply: data.reply }); } };
      const onErr = (_e, data) => { if (data.reqId === reqId) { cleanup(); resolve({ ok: false, error: data.error, provider: data.provider }); } };
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
