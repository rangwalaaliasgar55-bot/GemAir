"use strict";
/**
 * lib/iris/preload.js
 *
 * The only channel between the Assist renderers and the main process. Context
 * isolation is on and node integration is off, so this file is the complete
 * list of what an Assist window can do.
 *
 * Two surfaces are exposed:
 *   `window.gemair`       — the chat, overlay, settings, first-run and
 *                           maintain-mode ask card windows.
 *   `window.gemairNative` — the generic command/event pair the transplanted
 *                           guide panel needs. `renderer/iris/guide/gemair-bridge.js`
 *                           reshapes it into the `window.__TAURI__` object that
 *                           `app.js` already knows how to call.
 *
 * `window.iris` is kept as an alias of `window.gemair` so the ported renderer
 * files — which are large, and which upstream wrote against that name — run
 * unedited.
 *
 * Notably absent: anything that returns a stored secret. A renderer can ask
 * whether a key exists and can set one, but never read one back.
 */
const { contextBridge, ipcRenderer } = require("electron");

const gemair = {
  // Chat
  sendQuery: (text) => ipcRenderer.invoke("chat:query", text),
  /** Why the last `sendQuery` rejected: the clean sentence, and whether the
   *  reader has to set something up before it can work. Upstream also carried
   *  an "Add credit" link here; every GemAir route is free, so `addCreditUrl`
   *  is always null and is kept only so the ported chat renderer's optional
   *  chaining keeps working. */
  lastChatFailure: () => ipcRenderer.invoke("chat:lastFailure"),
  onStage: (callback) => {
    ipcRenderer.on("companion:stage", (_event, data) => callback(data));
  },

  // Overlay
  onPoint: (callback) => {
    ipcRenderer.on("overlay:point", (_event, tags) => callback(tags));
  },
  onCursorBuddy: (callback) => {
    ipcRenderer.on("overlay:cursor-buddy", (_event, x, y) => callback(x, y));
  },
  onCursorBuddyVisible: (callback) => {
    ipcRenderer.on("overlay:cursor-buddy-visible", (_event, visible) => callback(visible));
  },

  // Settings. `getSettings` reports whether a key is stored, never the key.
  getSettings: () => ipcRenderer.invoke("settings:getAll"),
  setSetting: (key, value) => ipcRenderer.invoke("settings:set", key, value),

  // The free routes. There is no provisioning, no claim code and no balance:
  // the model ids GemAir will send are free, and the hosted gateway answers the
  // public token when the reader has pasted no key of their own. What is left
  // is which route is answering and what it can offer.
  route: () => ipcRenderer.invoke("assist:route"),
  refreshRoute: () => ipcRenderer.invoke("assist:refreshRoute"),
  /** Re-reads OpenCode Zen's catalogue so a model that became free today is
   *  offerable today. Never widens the gate beyond what the catalogue marks. */
  refreshFreeModels: () => ipcRenderer.invoke("assist:refreshFreeModels"),
  /** Re-probes the reader's `opencode` binary after they install it. */
  refreshCli: () => ipcRenderer.invoke("assist:refreshCli"),
  onRouteChanged: (callback) => {
    ipcRenderer.on("assist:routeChanged", (_event, route) => callback(route));
  },
  completeFirstRun: () => ipcRenderer.invoke("firstRun:complete"),

  // Guides
  openGuide: () => ipcRenderer.invoke("guide:open"),
  /** Every guide that ships with this build. */
  listGuides: () => ipcRenderer.invoke("guide:list"),
  /** Open the guide panel straight onto one app, the way a deep link does. */
  showGuide: (slug) => ipcRenderer.invoke("guide:show", slug),
  // Settings, from the chat window's gear button (the tray menu has its own).
  openSettings: () => ipcRenderer.invoke("settings:open"),

  // Shell + window controls
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),

  // Maintain mode. The ask card (renderer/iris/maintain) is the only renderer
  // that calls these — see `main/index.js`'s "Maintain mode" section and
  // `services/maintain/incident-coordinator.js`'s `MaintainIncidentSnapshot`.
  getMaintainSnapshot: () => ipcRenderer.invoke("maintain:getSnapshot"),
  answerMaintainAsk: (answer) => ipcRenderer.invoke("maintain:answerAsk", answer),
  clearMaintainFixStatus: () => ipcRenderer.invoke("maintain:clearFixStatus"),
  mutedMaintainApps: () => ipcRenderer.invoke("maintain:mutedApps"),
  unmuteMaintainApp: (appSlug) => ipcRenderer.invoke("maintain:unmuteApp", appSlug),
  /** The card measures its own rendered height and reports it back so the
   *  (frameless, non-resizable-by-the-OS) window can be sized to fit — see
   *  `main/index.js`'s `maintainCardRect`. */
  resizeMaintainCard: (height) => ipcRenderer.invoke("maintain:resize", height),
  onMaintainSnapshot: (callback) => {
    ipcRenderer.on("maintain:snapshot", (_event, snapshot) => callback(snapshot));
  },

  // Deep links the main process could not act on, so a window can say so.
  onDeepLinkRejected: (callback) => {
    ipcRenderer.on("gemair-deep-link-rejected", (_event, rejection) => callback(rejection));
  },
  onGuideOpened: (callback) => {
    ipcRenderer.on("gemair-guide-opened", (_event, guide) => callback(guide));
  },
};

contextBridge.exposeInMainWorld("gemair", gemair);
// The ported renderers were written against `window.iris`; same object.
contextBridge.exposeInMainWorld("iris", gemair);

/** The generic bridge the transplanted guide panel drives. */
const nativeBridge = {
  invoke: (command, args) => ipcRenderer.invoke("gemair:invoke", command, args),

  /** Returns an unlisten function, which is what `app.js` stores and calls. */
  listen: (eventName, handler) => {
    const subscription = (_event, payload) => handler(payload);
    ipcRenderer.on(eventName, subscription);
    return () => ipcRenderer.removeListener(eventName, subscription);
  },
};

contextBridge.exposeInMainWorld("gemairNative", nativeBridge);
contextBridge.exposeInMainWorld("irisNative", nativeBridge);
