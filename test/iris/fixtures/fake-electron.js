"use strict";
/**
 * A fake `electron`, big enough to mount the whole Assist subsystem headlessly.
 *
 * `lib/iris/main/*` is the half of the port that only runs inside Electron, and
 * Electron cannot run in CI here (no display, and `node_modules/` is empty), so
 * until now nothing exercised `integration.mount()` at all — the most important
 * entry point in the port was the least tested. This module is the seam that
 * fixes that: it implements exactly the twenty Electron APIs `lib/iris` touches
 * (`grep -rho "electron_1\.[A-Za-z.]*" lib/iris`), records what was asked of
 * them, and does nothing else.
 *
 * It is deliberately NOT a general Electron emulator. Every method either
 * records a call or returns a plausible value; anything the port starts using
 * that is not here fails loudly as "not a function" rather than silently
 * passing, which is the point.
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

/** Everything the fake saw, for a test to assert on. */
const calls = {
  windows: [],
  loaded: [],
  ipcHandlers: new Map(),
  externalUrlsOpened: [],
  notifications: [],
  protocolsRegistered: [],
  messageBoxes: [],
  quit: 0,
};

const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gemair-assist-fake-electron-"));

/** The slice of Node's EventEmitter the port actually uses. */
class TinyEmitter {
  constructor() {
    this.listeners = new Map();
  }
  on(event, listener) {
    const forEvent = this.listeners.get(event) ?? [];
    forEvent.push({ listener, once: false });
    this.listeners.set(event, forEvent);
    return this;
  }
  once(event, listener) {
    const forEvent = this.listeners.get(event) ?? [];
    forEvent.push({ listener, once: true });
    this.listeners.set(event, forEvent);
    return this;
  }
  emit(event, ...args) {
    const forEvent = this.listeners.get(event) ?? [];
    this.listeners.set(event, forEvent.filter((entry) => !entry.once));
    for (const entry of forEvent) entry.listener({ preventDefault() {} }, ...args);
    return forEvent.length > 0;
  }
}

class FakeWebContents extends TinyEmitter {
  constructor(window) {
    super();
    this.window = window;
    this.sentMessages = [];
    this.session = {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: { onBeforeRequest() {}, onHeadersReceived() {} },
    };
  }
  setWindowOpenHandler() {}
  send(channel, ...args) {
    this.sentMessages.push({ channel, args });
  }
  executeJavaScript() {
    return Promise.resolve(undefined);
  }
  openDevTools() {}
  isDestroyed() {
    return this.window.destroyed;
  }
}

class BrowserWindow extends TinyEmitter {
  static allWindows = [];
  static getAllWindows() {
    return BrowserWindow.allWindows.filter((window) => !window.destroyed);
  }
  static fromWebContents(webContents) {
    return webContents && webContents.window ? webContents.window : null;
  }
  constructor(options = {}) {
    super();
    this.options = options;
    this.destroyed = false;
    this.visible = Boolean(options.show);
    this.loadedFile = null;
    // How a window was put on screen matters: a card or an overlay that used
    // `show()` would steal the keyboard from whatever the reader was doing.
    this.shownActive = 0;
    this.shownInactive = 0;
    this.alwaysOnTopLevel = null;
    this.webContents = new FakeWebContents(this);
    BrowserWindow.allWindows.push(this);
    calls.windows.push(options);
  }
  loadFile(file, loadOptions) {
    this.loadedFile = file;
    calls.loaded.push({ file, options: loadOptions });
    return this.finishLoading();
  }
  loadURL(url) {
    calls.loaded.push({ url });
    return this.finishLoading();
  }
  /**
   * Real Electron finishes a load asynchronously and only then fires
   * `did-finish-load`, which is when the main process is allowed to push state
   * into the renderer. Several windows queue their first message until that
   * event, so a fake that never fires it would make them look silently broken.
   */
  finishLoading() {
    return new Promise((resolve) => {
      setImmediate(() => {
        if (!this.destroyed) {
          this.webContents.emit("dom-ready");
          this.webContents.emit("did-finish-load");
          this.emit("ready-to-show");
        }
        resolve();
      });
    });
  }
  show() {
    this.shownActive += 1;
    this.visible = true;
  }
  showInactive() {
    this.shownInactive += 1;
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {}
  center() {}
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible && !this.destroyed;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
  setIgnoreMouseEvents() {}
  setAlwaysOnTop(flag, level = null) {
    this.alwaysOnTopLevel = flag ? level : null;
  }
  setVisibleOnAllWorkspaces() {}
  setBounds() {}
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  getSize() {
    return [800, 600];
  }
  removeMenu() {}
  setPosition() {}
  setSize() {}
  setContentProtection() {}
}

const app = {
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  getPath(name) {
    const directory = path.join(userDataDirectory, name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  },
  getVersion: () => "0.0.0-test",
  getName: () => "GemAir",
  setAsDefaultProtocolClient(scheme, execPath, args) {
    calls.protocolsRegistered.push({ scheme, execPath, args });
    return true;
  },
  quit() {
    calls.quit += 1;
  },
  on() {},
  once() {},
};

const ipcMain = {
  handle(channel, listener) {
    calls.ipcHandlers.set(channel, listener);
  },
  handleOnce(channel, listener) {
    calls.ipcHandlers.set(channel, listener);
  },
  removeHandler(channel) {
    calls.ipcHandlers.delete(channel);
  },
  on() {},
};

/** One 1920×1080 display at the origin, and a cursor in the middle of it. */
function aDisplay(id, x = 0, width = 1920, height = 1080, scaleFactor = 1) {
  return {
    id,
    bounds: { x, y: 0, width, height },
    workArea: { x, y: 0, width, height: height - 40 },
    scaleFactor,
    rotation: 0,
  };
}

const screen = {
  /** Reassign before mounting to test multi-monitor behaviour. */
  displays: [aDisplay(1)],
  cursor: { x: 960, y: 540 },
  getAllDisplays: () => screen.displays,
  getPrimaryDisplay: () => screen.displays[0],
  getCursorScreenPoint: () => screen.cursor,
  getDisplayNearestPoint: (point) =>
    screen.displays.find((display) => point
      && point.x >= display.bounds.x
      && point.x < display.bounds.x + display.bounds.width) ?? screen.displays[0],
};

const shell = {
  openExternal(url) {
    calls.externalUrlsOpened.push(url);
    return Promise.resolve();
  },
  openPath() {
    return Promise.resolve("");
  },
  showItemInFolder() {},
};

const dialog = {
  showMessageBox(...args) {
    const options = args.length > 1 ? args[1] : args[0];
    calls.messageBoxes.push(options);
    return Promise.resolve({ response: 0, checkboxChecked: false });
  },
};

class Notification {
  static isSupported() {
    return true;
  }
  constructor(options) {
    this.options = options;
    calls.notifications.push(options);
  }
  show() {}
  on() {}
}

/**
 * Encryption is reported UNAVAILABLE by default, which is the interesting case:
 * `main/secrets.js` must then refuse to store a secret rather than fall back to
 * plaintext. A test that wants the other branch sets `safeStorage.available`.
 */
const safeStorage = {
  available: false,
  isEncryptionAvailable() {
    return safeStorage.available;
  },
  encryptString(value) {
    if (!safeStorage.available) throw new Error("encryption is not available");
    return Buffer.from(`enc:${value}`, "utf8");
  },
  decryptString(buffer) {
    if (!safeStorage.available) throw new Error("encryption is not available");
    return String(buffer).replace(/^enc:/, "");
  },
};

/**
 * An image that knows only its own size — which is all the capture pipeline
 * asks it. `resize` and `crop` return the size they were asked for, and
 * `toJPEG` produces a byte string carrying the dimensions, so a test can prove
 * which image reached the model without decoding anything.
 */
function createImage(width, height) {
  return {
    width,
    height,
    isEmpty: () => width <= 0 || height <= 0,
    getSize: () => ({ width, height }),
    resize: (size) => createImage(size.width ?? width, size.height ?? height),
    crop: (rect) => createImage(rect.width, rect.height),
    toJPEG: () => Buffer.from(`jpeg:${width}x${height}`, "utf8"),
    toPNG: () => Buffer.from(`png:${width}x${height}`, "utf8"),
    toDataURL: () => `data:image/jpeg;base64,${Buffer.from(`jpeg:${width}x${height}`, "utf8").toString("base64")}`,
  };
}

/** `jpeg:1920x1080` back to an image, so a round trip keeps its size. */
function imageFromBuffer(buffer) {
  const match = /^(?:jpeg|png):(\d+)x(\d+)$/.exec(String(buffer ?? ""));
  return match ? createImage(Number(match[1]), Number(match[2])) : createImage(1, 1);
}

const nativeImage = {
  createFromBuffer: imageFromBuffer,
  createFromPath: () => createImage(32, 32),
  createEmpty: () => createImage(0, 0),
};

const desktopCapturer = {
  /** Set to whatever the test wants on screen; empty means "nothing captured". */
  sources: [],
  getSources() {
    return Promise.resolve(desktopCapturer.sources);
  },
};

const globalShortcut = {
  register: () => true,
  unregister() {},
  unregisterAll() {},
};

/**
 * Forgets what was recorded — windows opened, files loaded, messages sent — so a
 * test can assert on what ITS action did.
 *
 * It deliberately does NOT forget the windows themselves: the subsystem holds
 * its own references to them and reuses a window it already has, so dropping
 * the registry here would make the fake and the code under test disagree about
 * what is on screen.
 */
function reset() {
  for (const window of BrowserWindow.allWindows) {
    window.webContents.sentMessages = [];
  }
  calls.windows = [];
  calls.loaded = [];
  calls.ipcHandlers = new Map();
  calls.externalUrlsOpened = [];
  calls.notifications = [];
  calls.protocolsRegistered = [];
  calls.messageBoxes = [];
  calls.quit = 0;
  safeStorage.available = false;
}

module.exports = {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  shell,
  dialog,
  Notification,
  safeStorage,
  nativeImage,
  desktopCapturer,
  globalShortcut,
  // Test-only surface.
  calls,
  reset,
  createImage,
  aDisplay,
  userDataDirectory,
};
