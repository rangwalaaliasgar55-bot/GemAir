#!/usr/bin/env node
"use strict";
/**
 * scripts/assist-preview.js — run the Assist windows in a browser.
 *
 *   node scripts/assist-preview.js            # then open the printed URL
 *   PORT=4173 node scripts/assist-preview.js
 *
 * Why this exists
 * ---------------
 * `lib/iris/` is a whole Electron subsystem: seven renderer windows talking to a
 * main process over a preload bridge. Electron cannot run in this environment —
 * there is no display and `node_modules/` is empty — so until now the only way
 * to see any of it was to read the code.
 *
 * This harness runs the REAL main process (`lib/iris/integration.js`, mounted on
 * `test/iris/fixtures/fake-electron.js`) inside a plain Node HTTP server, serves
 * the REAL renderer files from `renderer/iris/`, and gives the page a bridge
 * that has the same shape as `lib/iris/preload.js` — `invoke` over POST, the
 * `on…` callbacks over Server-Sent Events. Nothing in `lib/iris/` or
 * `renderer/iris/` is modified or duplicated to make this work; if a renderer
 * calls a channel the main process does not handle, it breaks here exactly as it
 * would break in Electron.
 *
 * What is NOT real
 * ----------------
 *   - Windows. A browser tab stands in for a BrowserWindow, so `window:minimize`
 *     and the frameless chrome are no-ops.
 *   - Model answers, by default. Outbound network is usually unavailable here,
 *     so `ASSIST_PREVIEW_OFFLINE=1` (the default) answers chat locally with a
 *     canned reply and a visible "simulated" banner. Set it to `0` to let the
 *     real free OpenCode Zen route answer.
 *   - Screen capture. There is no screen; the fake hands the pipeline a blank
 *     1920x1080 image, which is enough for the pointing path to run end to end.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Module } = require("node:module");

const REPO_ROOT = path.join(__dirname, "..");
const RENDERER_ROOT = path.join(REPO_ROOT, "renderer", "iris");
const FAKE_ELECTRON_PATH = path.join(REPO_ROOT, "test", "iris", "fixtures", "fake-electron.js");

/** The seven windows, in the order the index page lists them. */
const WINDOWS = [
  { name: "chat", title: "Chat", blurb: "Ask a question; the answer comes from a free OpenCode model.", open: (assist) => assist.openChat() },
  { name: "guide", title: "Install guides", blurb: "The transplanted guide panel: pick an app, follow the steps.", open: (assist) => assist.openGuide() },
  { name: "autopilot", title: "Autopilot", blurb: "The animated terminal that installs an app for the reader.", open: (assist) => assist.openAutopilot("excalidraw") },
  { name: "settings", title: "Settings", blurb: "Route, model, autopilot consent, maintain mode.", open: (assist) => assist.openSettings() },
  { name: "maintain", title: "Maintain card", blurb: "The ask card that appears when something of theirs breaks.", open: null },
  { name: "first-run", title: "First run", blurb: "Shown once, and almost never: the free route needs no key.", open: null },
  { name: "overlay", title: "Overlay", blurb: "The click-through glow that points at a control.", open: null },
];

// MARK: - The fake Electron, installed before anything requires it

Module._resolveFilename = ((original) => function resolveWithFakeElectron(request, ...rest) {
  return request === "electron" ? FAKE_ELECTRON_PATH : original.call(this, request, ...rest);
})(Module._resolveFilename);

const electron = require(FAKE_ELECTRON_PATH);

/** A blank screen for the capture pipeline, so pointing can run with no display. */
electron.desktopCapturer.sources = [
  { id: "screen:0", display_id: "1", name: "Preview screen", thumbnail: electron.createImage(1920, 1080) },
];

const OFFLINE = process.env.ASSIST_PREVIEW_OFFLINE !== "0";
const CANNED_ANSWER =
  "This reply is simulated by scripts/assist-preview.js, because this machine has no outbound network. " +
  "The request that produced it was built by the real transport and addressed to a free OpenCode Zen model. " +
  "Run with ASSIST_PREVIEW_OFFLINE=0 to let the real route answer. [POINT:780,440:the Settings button:screen0]";

if (OFFLINE) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    if (!address.includes("opencode.ai")) {
      // The `opencode serve` probe answers the way it does on a machine that
      // is not running one, rather than hanging for its whole timeout. Any
      // other loopback call — including this harness's own — is left alone.
      if (/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/v1\//.test(address)) {
        throw new Error("connect ECONNREFUSED");
      }
      return realFetch ? realFetch(url, init) : Promise.reject(new Error("offline"));
    }
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: CANNED_ANSWER } }] });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
}

// MARK: - Pushes from the main process to the page

/** Every connected page, by window name. */
const subscribers = new Map();

function subscribe(windowName, response) {
  const forWindow = subscribers.get(windowName) ?? new Set();
  forWindow.add(response);
  subscribers.set(windowName, forWindow);
  return () => forWindow.delete(response);
}

function pushToWindow(windowName, channel, args) {
  const payload = `data: ${JSON.stringify({ channel, args })}\n\n`;
  for (const response of subscribers.get(windowName) ?? []) {
    response.write(payload);
  }
}

/** Which of the seven windows a fake BrowserWindow is. */
function windowNameFor(browserWindow) {
  const file = String(browserWindow?.loadedFile ?? "");
  const match = /renderer[/\\]iris[/\\]([^/\\]+)[/\\]/.exec(file);
  return match ? match[1] : null;
}

// Tee every `webContents.send` into the SSE stream for that window. This is the
// one piece of glue: in Electron the message would cross the preload bridge.
const FakeWebContents = Object.getPrototypeOf(new electron.BrowserWindow({}).webContents).constructor;
const originalSend = FakeWebContents.prototype.send;
FakeWebContents.prototype.send = function sendAndMirror(channel, ...args) {
  originalSend.call(this, channel, ...args);
  const name = windowNameFor(this.window);
  if (name) pushToWindow(name, channel, args);
};

// MARK: - Mount the real subsystem

const integration = require(path.join(REPO_ROOT, "lib", "iris", "integration.js"));
const assist = integration.mount({
  startDetection: false,
  onTrayChanged: (items) => pushToWindow("__tray", "tray", [items]),
});
if (!assist.available) {
  console.error(`Assist did not mount: ${assist.reason}`);
  process.exit(1);
}

/** The fake window for a renderer, opening it first if the host API can. */
function browserWindowFor(windowName) {
  const existing = electron.BrowserWindow.getAllWindows().find((window) => windowNameFor(window) === windowName);
  if (existing) return existing;
  const descriptor = WINDOWS.find((entry) => entry.name === windowName);
  if (descriptor?.open) {
    descriptor.open(assist);
    return electron.BrowserWindow.getAllWindows().find((window) => windowNameFor(window) === windowName) ?? null;
  }
  return null;
}

// MARK: - The HTTP surface

const BRIDGE_SCRIPT = `
/* Injected by scripts/assist-preview.js — the browser half of lib/iris/preload.js. */
(() => {
  const windowName = document.documentElement.getAttribute("data-assist-window") || "chat";
  const listeners = new Map();
  function on(channel, callback) {
    const forChannel = listeners.get(channel) || [];
    forChannel.push(callback);
    listeners.set(channel, forChannel);
  }
  async function invoke(channel, ...args) {
    const response = await fetch("/__ipc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, args, window: windowName }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  const events = new EventSource("/__events?window=" + encodeURIComponent(windowName));
  events.onmessage = (message) => {
    const { channel, args } = JSON.parse(message.data);
    for (const callback of listeners.get(channel) || []) callback(...args);
  };
  const gemair = {
    sendQuery: (text) => invoke("chat:query", text),
    lastChatFailure: () => invoke("chat:lastFailure"),
    onStage: (callback) => on("companion:stage", callback),
    onPoint: (callback) => on("overlay:point", callback),
    onCursorBuddy: (callback) => on("overlay:cursor-buddy", callback),
    onCursorBuddyVisible: (callback) => on("overlay:cursor-buddy-visible", callback),
    getSettings: () => invoke("settings:getAll"),
    setSetting: (key, value) => invoke("settings:set", key, value),
    route: () => invoke("assist:route"),
    refreshRoute: () => invoke("assist:refreshRoute"),
    refreshFreeModels: () => invoke("assist:refreshFreeModels"),
    refreshCli: () => invoke("assist:refreshCli"),
    onRouteChanged: (callback) => on("assist:routeChanged", callback),
    completeFirstRun: () => invoke("firstRun:complete"),
    openGuide: () => invoke("guide:open"),
    listGuides: () => invoke("guide:list"),
    showGuide: (slug) => invoke("guide:show", slug),
    openSettings: () => invoke("settings:open"),
    openExternal: (url) => invoke("shell:openExternal", url),
    minimizeWindow: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    getMaintainSnapshot: () => invoke("maintain:getSnapshot"),
    answerMaintainAsk: (answer) => invoke("maintain:answerAsk", answer),
    clearMaintainFixStatus: () => invoke("maintain:clearFixStatus"),
    mutedMaintainApps: () => invoke("maintain:mutedApps"),
    unmuteMaintainApp: (slug) => invoke("maintain:unmuteApp", slug),
    resizeMaintainCard: (height) => invoke("maintain:resize", height),
    onMaintainSnapshot: (callback) => on("maintain:snapshot", callback),
    onDeepLinkRejected: (callback) => on("gemair-deep-link-rejected", callback),
    onGuideOpened: (callback) => on("gemair-guide-opened", callback),
  };
  window.gemair = gemair;
  window.iris = gemair;
  window.gemairNative = {
    invoke: (command, args) => invoke("gemair:invoke", command, args || {}),
    listen: (eventName, handler) => {
      on(eventName, (payload) => handler(payload));
      return () => {};
    },
  };
  window.irisNative = window.gemairNative;
})();
`;

const INDEX_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>GemAir Assist — preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 48px 32px; font: 15px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif;
         background: #0b0d10; color: #e7ecf2; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }
  p.lede { color: #97a3b4; margin: 0 0 32px; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  a.card { display: block; padding: 16px 18px; border: 1px solid #1e2732; border-radius: 12px;
           background: #11151b; color: inherit; text-decoration: none; transition: border-color .15s, background .15s; }
  a.card:hover { border-color: #3b82f6; background: #151b23; }
  .title { font-weight: 600; }
  .blurb { color: #8d99a8; font-size: 13.5px; }
  .row { margin-top: 32px; display: flex; gap: 10px; flex-wrap: wrap; }
  button { font: inherit; padding: 9px 14px; border-radius: 9px; border: 1px solid #263141;
           background: #161c24; color: #e7ecf2; cursor: pointer; }
  button:hover { border-color: #3b82f6; }
  code { background: #161c24; padding: 1px 5px; border-radius: 5px; font-size: 13px; }
  .note { margin-top: 28px; color: #6f7c8c; font-size: 13px; }
</style></head>
<body><main>
  <h1>GemAir Assist</h1>
  <p class="lede">The ported Iris windows, served from <code>renderer/iris/</code> and driven by the real
  main process in <code>lib/iris/</code>. Every click below runs the same code Electron would run.</p>
  <ul>__CARDS__</ul>
  <div class="row">
    <button data-demo="crash">Raise a maintain incident</button>
    <button data-demo="deep-link">Send a gemair:// deep link</button>
    <button data-demo="point">Point at something on the overlay</button>
  </div>
  <p class="note" id="note">Model replies are __MODE__.</p>
</main>
<script>
  for (const button of document.querySelectorAll("button[data-demo]")) {
    button.addEventListener("click", async () => {
      const response = await fetch("/__demo/" + button.dataset.demo, { method: "POST" });
      document.getElementById("note").textContent = (await response.json()).message;
    });
  }
</script></body></html>`;

function indexPage() {
  const cards = WINDOWS.map((entry) => `<li><a class="card" href="/${entry.name}/" target="_blank">
    <div class="title">${entry.title}</div><div class="blurb">${entry.blurb}</div></a></li>`).join("\n");
  return INDEX_PAGE
    .replace("__CARDS__", cards)
    .replace("__MODE__", OFFLINE ? "simulated locally (no outbound network); set ASSIST_PREVIEW_OFFLINE=0 for the real free route" : "coming from the real free OpenCode Zen route");
}

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
  });
}

async function handleIpc(request, response) {
  const { channel, args = [], window: windowName } = JSON.parse((await readBody(request)) || "{}");
  const handler = electron.calls.ipcHandlers.get(channel);
  if (!handler) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: `no handler for ${channel}` }));
    return;
  }
  const sender = browserWindowFor(windowName)?.webContents ?? null;
  try {
    const value = await handler({ sender }, ...args);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, value: value === undefined ? null : value }));
  } catch (error) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}

const DEMOS = {
  crash() {
    const maintain = assist.raw().maintain();
    maintain.reportLaunchFailure({
      appSlug: "excalidraw", appName: "Excalidraw", appStack: "node",
      daemon: "node", reason: "exited with code 1",
    });
    return "Raised a launch failure for Excalidraw — open the Maintain card window.";
  },
  "deep-link"() {
    assist.receiveDeepLink("gemair://guide/excalidraw?version=1");
    return "Sent gemair://guide/excalidraw?version=1 — the guide window has the pending link.";
  },
  point() {
    assist.raw().companion().sendPointsToOverlays([{ x: 640, y: 380, label: "the Install button", screen: 0 }]);
    return "Sent a point to the overlay window.";
  },
};

async function handleDemo(name, response) {
  const demo = DEMOS[name];
  if (!demo) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: `no demo named ${name}` }));
    return;
  }
  let message;
  try {
    message = demo();
  } catch (error) {
    message = `That demo failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ message }));
}

/**
 * The one concession the browser needs.
 *
 * Every Assist window ships `default-src 'none'`, which in Electron is correct:
 * the page talks to the main process through the preload bridge and never over
 * the network. Here the bridge IS the network — POST /__ipc and an EventSource —
 * so the served copy gets `connect-src 'self'` added, and nothing else. The
 * files on disk are untouched; the relaxation lives in this harness, where it is
 * visible, rather than being weakened in the app.
 */
function relaxContentSecurityPolicy(html) {
  return html.replace(/(<meta[^>]*Content-Security-Policy[^>]*content=")([^"]*)(")/i, (_match, before, policy, after) => {
    const trimmed = policy.trim().replace(/;$/, "");
    return /connect-src/i.test(trimmed) ? `${before}${policy}${after}` : `${before}${trimmed}; connect-src 'self';${after}`;
  });
}

function serveRendererFile(windowName, relativePath, response) {
  const isDirectory = relativePath === "" || relativePath.endsWith("/");
  const file = path.join(RENDERER_ROOT, windowName, isDirectory ? "index.html" : relativePath);
  if (!file.startsWith(RENDERER_ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const extension = path.extname(file);
  if (extension === ".html") {
    // Open the matching fake window first, so the main process's own window
    // state (pending deep link, maintain readiness) is real before the page
    // asks for it.
    browserWindowFor(windowName);
    const html = relaxContentSecurityPolicy(fs.readFileSync(file, "utf8"))
      .replace(/<html/i, `<html data-assist-window="${windowName}"`)
      // Inlined rather than linked: these windows ship a CSP that allows
      // `'unsafe-inline'` but not `'self'` for scripts, because in Electron the
      // bridge arrives through a preload and never as a file the page fetches.
      .replace(/<head([^>]*)>/i, `<head$1>\n<script>${BRIDGE_SCRIPT}</script>`);
    response.writeHead(200, { "content-type": CONTENT_TYPES[".html"] });
    response.end(html);
    return;
  }
  response.writeHead(200, { "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream" });
  response.end(fs.readFileSync(file));
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") {
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"] });
      response.end(indexPage());
      return;
    }
    if (pathname === "/__bridge.js") {
      response.writeHead(200, { "content-type": CONTENT_TYPES[".js"] });
      response.end(BRIDGE_SCRIPT);
      return;
    }
    if (pathname === "/__ipc" && request.method === "POST") return handleIpc(request, response);
    if (pathname.startsWith("/__demo/") && request.method === "POST") {
      return handleDemo(pathname.slice("/__demo/".length), response);
    }
    if (pathname === "/__events") {
      const windowName = url.searchParams.get("window") ?? "chat";
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(": connected\n\n");
      const unsubscribe = subscribe(windowName, response);
      request.on("close", unsubscribe);
      return;
    }
    const segments = pathname.split("/").filter(Boolean);
    const windowName = segments[0];
    if (WINDOWS.some((entry) => entry.name === windowName)) {
      const rest = pathname.slice(windowName.length + 1).replace(/^\//, "");
      return serveRendererFile(windowName, pathname.endsWith("/") || rest === "" ? "" : rest, response);
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
}

module.exports = { createServer, assist, electron, WINDOWS };

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT ?? "4173", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`GemAir Assist preview on http://0.0.0.0:${port}`);
    console.log(OFFLINE ? "Model replies are simulated (ASSIST_PREVIEW_OFFLINE=1)." : "Model replies come from the real free OpenCode Zen route.");
  });
}
