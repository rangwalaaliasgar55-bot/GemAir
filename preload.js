// GemAir — preload (contextBridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gemair', {
  platform: process.platform,
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
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
  aiOffline: (text) => ipcRenderer.invoke('ai:offline', text),
  getHeadlines: (limit) => ipcRenderer.invoke('news:get', limit),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  version: () => ipcRenderer.invoke('app:version'),

  // memory
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

  // files
  saveCode: (content, suggestedName) => ipcRenderer.invoke('file:saveCode', content, suggestedName),

  // report & backup
  generateReport: () => ipcRenderer.invoke('report:generate'),
  needsCheckIn: () => ipcRenderer.invoke('report:needsCheckIn'),
  exportMemory: () => ipcRenderer.invoke('memory:export'),
  importMemory: (data) => ipcRenderer.invoke('memory:import', data),

  // events (main -> renderer)
  onReminder: (cb) => ipcRenderer.on('reminder:due', (_e, reminder) => cb(reminder)),
  onWakeToggle: (cb) => ipcRenderer.on('wake:toggle', (_e, on) => cb(on)),
  onActivity: (cb) => ipcRenderer.on('ai:activity', (_e, data) => cb(data)),
  onHudPanel: (cb) => ipcRenderer.on('hud:panel', (_e, data) => cb(data))
});
