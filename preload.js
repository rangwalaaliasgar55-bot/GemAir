// GemAI — preload (contextBridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gemai', {
  platform: process.platform,
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getProfile: () => ipcRenderer.invoke('profile:get'),
  setProfile: (data) => ipcRenderer.invoke('profile:set', data),
  aiChat: (config, messages) => ipcRenderer.invoke('ai:chat', config, messages),
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

  // files
  saveCode: (content, suggestedName) => ipcRenderer.invoke('file:saveCode', content, suggestedName),

  // events (main -> renderer)
  onReminder: (cb) => ipcRenderer.on('reminder:due', (_e, reminder) => cb(reminder))
});
