"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const tray_1 = require("./tray");
const settings_1 = require("./settings");
const companion_1 = require("./companion");
const deep_link_parser_1 = require("../services/deep-link-parser");
const external_links_1 = require("../services/external-links");
const tool_versions_1 = require("../services/tool-versions");
const secrets_1 = require("./secrets");
const opencode_session_1 = require("./opencode-session");
const opencode_models_1 = require("../services/opencode-models");
const assistant_transport_1 = require("../services/assistant-transport");
const guide_service_1 = require("../services/guide-service");
const autopilot_controller_1 = require("./autopilot-controller");
const guide_recipe_resolver_1 = require("../services/autopilot/guide-recipe-resolver");
const fix_ladder_1 = require("../services/autopilot/fix-ladder");
const watch_1 = require("../services/autopilot/watch");
const model_provider_1 = require("../services/maintain/model-provider");
const setup_detour_host_1 = require("./setup-detour-host");
const controller_1 = require("./maintain/controller");
const window_geometry_1 = require("../services/window-geometry");
/**
 * main/index.js
 *
 * The GemAir Assist subsystem: windows, IPC, tray items, and the `gemair://`
 * scheme. Ported from `iris-windows/src/main/index.ts`.
 *
 * Two structural differences from upstream, both because this is a subsystem
 * rather than an app:
 *
 *   1. Nothing runs at import time. Upstream's file WAS the app — it took the
 *      single-instance lock, answered Squirrel's install hooks and called
 *      `app.whenReady()` as it loaded. GemAir's `main.js` owns all of that, so
 *      everything here hangs off `startAssist()`, which GemAir calls once the
 *      app is ready, and `assistTrayItems()`, which GemAir's own tray folds in.
 *
 *   2. No publik, no accounts, no balance. The chat routes are the free
 *      OpenCode ones (`services/assistant-transport.js`), guides ship with the
 *      app (`services/guide-service.js`), and the Squirrel/self-update paths
 *      are gone because GemAir installs with NSIS and updates itself.
 *
 * The command names handled here (`check_tool_version`, `take_pending_guide`,
 * `open_external`, ...) are the ones `renderer/iris/guide/app.js` invokes —
 * that file is the Tauri panel transplanted almost verbatim, so this process
 * answers the same vocabulary its Rust counterpart did.
 */
let chatWindow = null;
let settingsWindow = null;
let overlayWindows = [];
/** Built on `startAssist()`, not at import: `app.getPath("userData")` is only
 *  answerable once the app is ready, and importing this file must be free. */
let settings = null;
let firstRunWindow = null;
/** Mirrors the companion's probe, so settings can show the option honestly. */
let cliAvailableCached = false;
let companion;
let maintain;
let cursorBuddyInterval = null;
/** Set by `startAssist`, so a host app can be told to show its own window. */
let hostHooks = {};
/** A guide link that arrived before the panel was ready to receive it. */
let pendingGuideDeepLink = null;
// MARK: - Deep links
//
// Windows delivers a custom-scheme link by launching the app again with the URL
// in argv. GemAir's `main.js` already holds the single-instance lock, so it
// forwards the second launch's argv here (`receiveDeepLinksFromArgv`) rather
// than this file taking a lock of its own.
function registerGemAirScheme() {
    // Registering the scheme makes an "Open in GemAir" link on a web page land
    // in this app. Harmless to re-register; Electron replaces the association.
    if (process.defaultApp && process.argv.length >= 2) {
        // In development the executable is Electron itself, so the registration has
        // to name the script too or Windows launches a bare Electron.
        electron_1.app.setAsDefaultProtocolClient(deep_link_parser_1.GEMAIR_URL_SCHEME, process.execPath, [
            node_path_1.default.resolve(process.argv[1]),
        ]);
    }
    else {
        electron_1.app.setAsDefaultProtocolClient(deep_link_parser_1.GEMAIR_URL_SCHEME);
    }
}
function receiveDeepLinksFromArgv(argv) {
    for (const argument of argv) {
        if (argument.startsWith(`${deep_link_parser_1.GEMAIR_URL_SCHEME}://`))
            receiveDeepLink(argument);
    }
}
function receiveDeepLink(url) {
    const result = (0, deep_link_parser_1.parseIrisDeepLink)(url);
    if (!result.ok) {
        broadcast("iris-deep-link-rejected", result.rejection);
        return;
    }
    if (result.link.kind === "guide") {
        pendingGuideDeepLink = result.link.guide;
        openGuideWindow();
        broadcast("iris-guide-opened", result.link.guide);
        return;
    }
    // Upstream's other link kind was `gemair://auth/callback`, the tail of a
    // Supabase sign-in. GemAir has no accounts, so a callback link has nowhere
    // to go: it is reported as rejected rather than silently swallowed.
    broadcast("gemair-deep-link-rejected", {
        reason: "GemAir has no sign-in, so an auth callback has nothing to complete.",
    });
}
function broadcast(channel, payload) {
    for (const window of electron_1.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed())
            window.webContents.send(channel, payload);
    }
}
// MARK: - Which free route is answering
//
// Upstream had a balance here: what is left, what the last reply cost, and an
// "Add credit" button, all pushed to the tray and every open window. None of
// that exists in GemAir, because none of it can: every route is free. What is
// left is the one honest thing a reader still wants to know — WHICH free route
// is answering right now — published on the same channel so the ported tray and
// settings renderers keep working.
function currentRouteView() {
    if (!companion)
        return null;
    return {
        route: companion.currentRouteDescription(),
        model: settings.get("openCodeModel"),
        cliAvailable: cliAvailableCached,
        localServer: companion.localServerBaseUrl ?? null,
        free: true,
    };
}
/** Pushes the route view to every open window (and GemAir's tray, via the host). */
function publishRoute() {
    const view = currentRouteView();
    // The tray line that replaced upstream's balance lines, the host's own hook,
    // and every open window — the same three places a balance change reached.
    (0, tray_1.setTrayRoute)(view);
    hostHooks.onRouteChanged?.(view);
    broadcast("assist:routeChanged", view);
}
/** Re-probes what is reachable, then publishes whatever is now true. */
async function refreshRoute() {
    if (companion) {
        await companion.refreshLocalServer();
        cliAvailableCached = await companion.refreshCliAvailability();
    }
    publishRoute();
    return currentRouteView();
}
function focusExistingWindow() {
    const window = chatWindow ?? electron_1.BrowserWindow.getAllWindows().find((each) => !each.isDestroyed());
    if (!window || window.isDestroyed())
        return;
    if (window.isMinimized())
        window.restore();
    window.show();
    window.focus();
}
/**
 * The one way GemAir's chat is brought up — from the tray, from a second launch
 * (the Desktop or Start Menu shortcut), and from the first-run notice. Creates
 * it when it was closed, restores it when it was minimized, and brings it to
 * the front either way. The old second-launch path fell back to "any window",
 * which after the chat was closed meant a transparent click-through overlay:
 * the launch appeared to do nothing.
 */
function showChatWindow() {
    if (chatWindow && !chatWindow.isDestroyed()) {
        if (chatWindow.isMinimized())
            chatWindow.restore();
        chatWindow.show();
        chatWindow.focus();
        return;
    }
    chatWindow = createChatWindow();
    chatWindow.on("closed", () => {
        chatWindow = null;
    });
}
/** Opens Settings, or brings the open one to the front. */
function showSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        if (settingsWindow.isMinimized())
            settingsWindow.restore();
        settingsWindow.show();
        settingsWindow.focus();
        return;
    }
    settingsWindow = createSettingsWindow();
    settingsWindow.on("closed", () => {
        settingsWindow = null;
    });
}
/**
 * Shown when the host app asks for it: where GemAir Assist lives. GemAir is a tray app, and on Windows 11 a new tray icon is
 * tucked behind the ^ arrow, so without this the reader's only clue after
 * closing the chat was an icon they could not see.
 */
function showInstalledNotice() {
    if (!electron_1.Notification.isSupported())
        return;
    const notice = new electron_1.Notification({
        title: "GemAir is installed",
        body: "Open GemAir any time from its icon on your desktop or in the Start menu. While it runs, it also sits in the system tray, near the clock.",
    });
    notice.on("click", () => showChatWindow());
    notice.show();
}
// MARK: - Cursor buddy
function startCursorBuddy() {
    if (cursorBuddyInterval)
        return;
    cursorBuddyInterval = setInterval(() => {
        if (overlayWindows.length === 0)
            return;
        const point = electron_1.screen.getCursorScreenPoint();
        // Route the buddy to the overlay for the display that contains the cursor and
        // hide it on every other one. Coordinates are translated into that display's
        // local space, exactly as POINT tags are.
        const targetDisplay = electron_1.screen.getDisplayNearestPoint(point);
        const displays = electron_1.screen.getAllDisplays();
        const targetIndex = displays.findIndex((display) => display.id === targetDisplay.id);
        for (let index = 0; index < overlayWindows.length; index++) {
            const window = overlayWindows[index];
            if (!window || window.isDestroyed())
                continue;
            if (index === targetIndex) {
                window.webContents.send("overlay:cursor-buddy", point.x - targetDisplay.bounds.x, point.y - targetDisplay.bounds.y);
            }
            else {
                window.webContents.send("overlay:cursor-buddy-visible", false);
            }
        }
    }, 16);
}
function stopCursorBuddy() {
    if (cursorBuddyInterval) {
        clearInterval(cursorBuddyInterval);
        cursorBuddyInterval = null;
    }
    for (const window of overlayWindows) {
        if (window && !window.isDestroyed()) {
            window.webContents.send("overlay:cursor-buddy-visible", false);
        }
    }
}
// MARK: - Windows
/** The one preload every Assist window loads. Upstream shipped it at
 *  `dist/preload/index.js`; GemAir keeps the subsystem self-contained, so it
 *  sits next to this file at `lib/iris/preload.js`. */
const preloadPath = () => node_path_1.default.join(__dirname, "..", "preload.js");
/** The Assist renderers live under GemAir's own `renderer/` tree, in their own
 *  `iris/` folder, so they sit beside GemAir's UI without colliding with it. */
const rendererPath = (...segments) => node_path_1.default.join(__dirname, "..", "..", "..", "renderer", "iris", ...segments);
/**
 * One transparent click-through overlay per display. The array index matches
 * `screen.getAllDisplays()`, which is also the order `ScreenCapture` uses, so a
 * POINT tag's `screen` field indexes into this array directly.
 */
function createOverlayWindows() {
    return electron_1.screen.getAllDisplays().map((display, index) => createOverlayWindow(display, index));
}
function createOverlayWindow(display, displayIndex) {
    const { x, y, width, height } = display.bounds;
    const window = new electron_1.BrowserWindow({
        x,
        y,
        width,
        height,
        transparent: true,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        show: false,
        webPreferences: {
            preload: preloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.setAlwaysOnTop(true, "screen-saver");
    void window.loadFile(rendererPath("overlay", "index.html"));
    // Windows sometimes drops always-on-top at show time, and `ready-to-show` does
    // not always fire for transparent windows — hence both paths.
    window.once("ready-to-show", () => {
        window.showInactive();
        window.setAlwaysOnTop(true, "screen-saver");
    });
    window.webContents.once("did-finish-load", () => {
        if (!window.isVisible()) {
            window.showInactive();
            window.setAlwaysOnTop(true, "screen-saver");
        }
    });
    window.webContents.on("console-message", (_event, level, message, line) => {
        console.log(`[overlay${displayIndex}:${level}] ${message} (line ${line})`);
    });
    return window;
}
function createChatWindow() {
    const window = new electron_1.BrowserWindow({
        width: 420,
        height: 550,
        resizable: true,
        show: false,
        frame: false,
        alwaysOnTop: settings.get("alwaysOnTop"),
        webPreferences: {
            preload: preloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    void window.loadFile(rendererPath("chat", "index.html"));
    window.once("ready-to-show", () => {
        window.show();
        if (settings.get("alwaysOnTop")) {
            // More reliable after show than as a constructor option, and Windows can
            // still reset it a moment later.
            window.setAlwaysOnTop(true, "screen-saver");
            setTimeout(() => {
                if (!window.isDestroyed())
                    window.setAlwaysOnTop(true, "screen-saver");
            }, 500);
        }
    });
    return window;
}
let guideWindow = null;
function openGuideWindow() {
    if (guideWindow && !guideWindow.isDestroyed()) {
        guideWindow.show();
        guideWindow.focus();
        return guideWindow;
    }
    guideWindow = new electron_1.BrowserWindow({
        width: 420,
        height: 620,
        resizable: true,
        show: false,
        frame: false,
        webPreferences: {
            preload: preloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    void guideWindow.loadFile(rendererPath("guide", "index.html"));
    guideWindow.once("ready-to-show", () => guideWindow?.show());
    guideWindow.on("closed", () => {
        guideWindow = null;
    });
    return guideWindow;
}
function createSettingsWindow() {
    const window = new electron_1.BrowserWindow({
        // Resizable, with a minimum the page's layout is checked at — see
        // services/window-geometry.ts for the report that changed this.
        ...window_geometry_1.SETTINGS_WINDOW_GEOMETRY,
        show: false,
        webPreferences: {
            preload: preloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    // No File/Edit/View menu bar: Electron's default one has nothing for a
    // settings form, and its View > Zoom is one way the page ends up wider than
    // the window. Typing, copy and paste in the fields do not need it.
    window.removeMenu();
    void window.loadFile(rendererPath("settings", "index.html"));
    window.once("ready-to-show", () => window.show());
    return window;
}
/**
 * The first-run window. Windows had no onboarding at all before this: a new
 * user met an empty chat box and a setup panel that only appeared once they had
 * already typed something and been refused.
 *
 * It is only ever opened when GemAir genuinely cannot reach a model, so an
 * install that already has a key (or a reinstall over one) never sees it.
 */
function createFirstRunWindow() {
    const window = new electron_1.BrowserWindow({
        ...window_geometry_1.FIRST_RUN_WINDOW_GEOMETRY,
        show: false,
        title: "Welcome to GemAir",
        webPreferences: {
            preload: preloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    window.removeMenu();
    void window.loadFile(rendererPath("first-run", "index.html"));
    window.once("ready-to-show", () => window.show());
    return window;
}
/**
 * Shows onboarding when, and only when, there is no way to reach a model. The
 * guided-install product works without one, so this must not become a gate in
 * front of the whole app.
 */
function openFirstRunWindowIfNeeded() {
    if (settings.get("hasCompletedFirstRun"))
        return;
    if (settings.isConfigured()) {
        settings.set("hasCompletedFirstRun", true);
        return;
    }
    if (firstRunWindow && !firstRunWindow.isDestroyed()) {
        firstRunWindow.focus();
        return;
    }
    firstRunWindow = createFirstRunWindow();
    firstRunWindow.on("closed", () => {
        firstRunWindow = null;
    });
}
// MARK: - The guide panel's native commands
async function checkToolVersion(tool) {
    const spec = (0, tool_versions_1.toolSpecFor)(tool);
    if (!spec)
        throw new Error(`tool '${tool}' is not allowlisted`);
    const [executable, args] = spec;
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)(executable, [...args], { windowsHide: true, timeout: 10_000, shell: false }, (error, stdout, stderr) => {
            const version = (0, tool_versions_1.boundedCommandOutput)(String(stdout), String(stderr));
            if (error && !version) {
                resolve({ tool, available: false, version: "" });
                return;
            }
            resolve({ tool, available: !error, version });
        });
    });
}
/** Floats the guide panel to a screen corner. Shared by the `glide_iris` command
 *  and the autopilot's "float to a gate". */
function glideGuidePanel(anchor) {
    if (!guideWindow || guideWindow.isDestroyed())
        return;
    const display = electron_1.screen.getDisplayNearestPoint(electron_1.screen.getCursorScreenPoint());
    const [windowWidth, windowHeight] = guideWindow.getSize();
    const margin = 24;
    const isRight = anchor.includes("right");
    const isBottom = anchor.includes("bottom");
    guideWindow.setPosition(isRight
        ? display.bounds.x + display.bounds.width - windowWidth - margin
        : display.bounds.x + margin, isBottom
        ? display.bounds.y + display.bounds.height - windowHeight - margin
        : display.bounds.y + margin, true);
}
/** Opens a link only if the external-link allowlist permits it, swallowing a
 *  refusal so a side effect (opening a sign-in page, opening the finished app)
 *  never throws out of the autopilot. */
function openExternalSafely(url) {
    const classification = (0, external_links_1.classifyExternalLink)(url);
    if (classification.allowed)
        void electron_1.shell.openExternal(classification.url);
}
let autopilotWindow = null;
let autopilot = null;
const EYE_SIZE = 108;
const TERMINAL_WIDTH = 600;
const TERMINAL_HEIGHT = 460;
/** The eye's resting spot: the top-left corner of the current display. */
function autopilotEyeRect() {
    const display = electron_1.screen.getDisplayNearestPoint(electron_1.screen.getCursorScreenPoint());
    const margin = 28;
    return { x: display.workArea.x + margin, y: display.workArea.y + margin, width: EYE_SIZE, height: EYE_SIZE };
}
/** The terminal's spot: centred on the current display. */
function autopilotTerminalRect() {
    const { x, y, width, height } = electron_1.screen.getDisplayNearestPoint(electron_1.screen.getCursorScreenPoint()).workArea;
    return {
        x: Math.round(x + (width - TERMINAL_WIDTH) / 2),
        y: Math.round(y + (height - TERMINAL_HEIGHT) / 2),
        width: TERMINAL_WIDTH,
        height: TERMINAL_HEIGHT,
    };
}
/** Animates a window's bounds to `to` with an ease-out, then runs `done`, so the
 *  window grows or shrinks in step with the renderer's eye<->terminal crossfade. */
function animateWindowBounds(window, to, durationMs, done) {
    const from = window.getBounds();
    const frames = Math.max(1, Math.round(durationMs / 16));
    let frame = 0;
    const timer = setInterval(() => {
        if (window.isDestroyed()) {
            clearInterval(timer);
            return;
        }
        frame += 1;
        const progress = Math.min(1, frame / frames);
        const eased = 1 - Math.pow(1 - progress, 3);
        window.setBounds({
            x: Math.round(from.x + (to.x - from.x) * eased),
            y: Math.round(from.y + (to.y - from.y) * eased),
            width: Math.round(from.width + (to.width - from.width) * eased),
            height: Math.round(from.height + (to.height - from.height) * eased),
        });
        if (progress >= 1) {
            clearInterval(timer);
            done?.();
        }
    }, 16);
}
/** Opens the autopilot as the GemAir eye in the top-left, then glides it to centre
 *  and morphs it into the terminal (the renderer crossfades in step). Shown on
 *  `did-finish-load`, which — unlike `ready-to-show` — fires reliably for a
 *  transparent frameless window; the old code relied on `ready-to-show` and so
 *  the window opened but stayed invisible. */
function openAutopilotWindow(slug) {
    if (autopilotWindow && !autopilotWindow.isDestroyed()) {
        autopilotWindow.show();
        autopilotWindow.focus();
        return autopilotWindow;
    }
    autopilotWindow = new electron_1.BrowserWindow({
        ...autopilotEyeRect(),
        frame: false,
        transparent: true,
        resizable: false,
        show: false,
        hasShadow: false,
        alwaysOnTop: true,
        backgroundColor: "#00000000",
        webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
    });
    const win = autopilotWindow;
    // A run is now active, so the tray offers 'Stop the install' for its duration.
    (0, tray_1.setTrayInstallActive)(true);
    void win.loadFile(rendererPath("autopilot", "index.html"), { query: { slug } });
    win.webContents.once("did-finish-load", () => {
        if (win.isDestroyed())
            return;
        win.show();
        win.focus();
        // Let the eye sit a beat in the corner, then fly to centre and become the
        // terminal — the renderer crossfades on the same "morph" signal.
        setTimeout(() => {
            if (win.isDestroyed())
                return;
            win.webContents.send("autopilot:morph", "terminal");
            animateWindowBounds(win, autopilotTerminalRect(), 520);
        }, 650);
    });
    win.on("closed", () => {
        autopilotWindow = null;
        autopilot?.dispose();
        // The run is over; drop the tray's 'Stop the install' item and any stale
        // "your turn" state.
        (0, tray_1.setTrayInstallActive)(false);
        (0, tray_1.clearTrayYourTurn)();
    });
    return win;
}
/** Morphs the terminal back into the eye, glides it to the top-left, then closes —
 *  the "turn back into the eye" finish. Called by the renderer once it is done. */
function collapseAutopilotWindow() {
    const win = autopilotWindow;
    if (!win || win.isDestroyed())
        return;
    win.webContents.send("autopilot:morph", "eye");
    animateWindowBounds(win, autopilotEyeRect(), 460, () => {
        setTimeout(() => {
            if (!win.isDestroyed())
                win.close();
        }, 550);
    });
}
// MARK: - Maintain mode's ask card
//
// The one piece of UI maintain mode has: a small always-on-top card, bottom-
// right of the display the cursor is on — the notification corner, distinct
// from the autopilot's top-left eye so an install and an ask can never
// contend for the same spot. It appears the moment the coordinator has
// something to show (a pending ask, or a fix-status line after one was
// answered) and disappears the moment it does not — mirrored from Swift's
// `MaintainAskCard`, whose body "renders nothing when there is nothing to
// ask... which is almost always, by design." Unlike the overlay windows, this
// one is NOT click-through: the three answer buttons need real clicks, so it
// stays a small ordinary (if frameless, transparent, and non-activating on
// first appearance) window rather than joining `overlayWindows`.
let maintainWindow = null;
let maintainWindowReady = false;
let pendingMaintainSnapshot = null;
const MAINTAIN_CARD_WIDTH = 340;
/** Just tall enough for nothing — the window still exists at this height for
 *  an instant between `showInactive()` and the renderer's first real
 *  `maintain:resize` call, which happens within one animation frame of the
 *  card's content actually painting. */
const MAINTAIN_CARD_COLLAPSED_HEIGHT = 40;
const MAINTAIN_CARD_MAX_HEIGHT = 440;
/** Bottom-right of whatever display the cursor is on, sized to `height` and
 *  clamped to a sane range — the renderer measures its own content and calls
 *  back through `maintain:resize` (mirrors Swift's `clickyResizePanelToContent`
 *  notification, posted from `MaintainAskCard`'s `onAppear`/`onDisappear`). */
function maintainCardRect(height) {
    const display = electron_1.screen.getDisplayNearestPoint(electron_1.screen.getCursorScreenPoint());
    const margin = 24;
    const clampedHeight = Math.max(MAINTAIN_CARD_COLLAPSED_HEIGHT, Math.min(MAINTAIN_CARD_MAX_HEIGHT, Math.round(height)));
    return {
        x: display.workArea.x + display.workArea.width - MAINTAIN_CARD_WIDTH - margin,
        y: display.workArea.y + display.workArea.height - clampedHeight - margin,
        width: MAINTAIN_CARD_WIDTH,
        height: clampedHeight,
    };
}
function createMaintainWindow() {
    const window = new electron_1.BrowserWindow({
        ...maintainCardRect(MAINTAIN_CARD_COLLAPSED_HEIGHT),
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        backgroundColor: "#00000000",
        webPreferences: {
            preload: preloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    void window.loadFile(rendererPath("maintain", "index.html"));
    window.webContents.once("did-finish-load", () => {
        maintainWindowReady = true;
        if (pendingMaintainSnapshot) {
            window.webContents.send("maintain:snapshot", pendingMaintainSnapshot);
            pendingMaintainSnapshot = null;
        }
    });
    window.on("closed", () => {
        maintainWindow = null;
        maintainWindowReady = false;
    });
    return window;
}
function maintainWindowInstance() {
    if (maintainWindow && !maintainWindow.isDestroyed())
        return maintainWindow;
    maintainWindow = createMaintainWindow();
    return maintainWindow;
}
/** True exactly when the coordinator has nothing to show — the same
 *  condition `incident-coordinator.ts`'s own `currentSnapshot()` collapses
 *  to `EMPTY_SNAPSHOT` on. */
function maintainSnapshotIsEmpty(snapshot) {
    return snapshot.pendingAsk === null && snapshot.fixStatusLine === null && snapshot.fixGuidanceSteps.length === 0;
}
function showMaintainCard(snapshot) {
    const window = maintainWindowInstance();
    const currentHeight = window.isVisible() ? window.getBounds().height : MAINTAIN_CARD_COLLAPSED_HEIGHT;
    window.setBounds(maintainCardRect(currentHeight));
    if (maintainWindowReady) {
        window.webContents.send("maintain:snapshot", snapshot);
    }
    else {
        pendingMaintainSnapshot = snapshot;
    }
    if (!window.isVisible()) {
        // Inactive, like the overlay windows: an ask card that steals focus the
        // instant it appears would yank the keyboard out from under whatever the
        // reader was doing when the app crashed.
        window.showInactive();
        window.setAlwaysOnTop(true, "screen-saver");
    }
}
function hideMaintainCard() {
    if (maintainWindow && !maintainWindow.isDestroyed() && maintainWindow.isVisible()) {
        maintainWindow.hide();
    }
}
/** The host `MaintainController` pushes every observable state change
 *  through — the main-process half of the push/pull pair
 *  `incident-coordinator.ts`'s header describes. */
function maintainHost() {
    return {
        emitSnapshot: (snapshot) => {
            if (maintainSnapshotIsEmpty(snapshot)) {
                hideMaintainCard();
            }
            else {
                showMaintainCard(snapshot);
            }
        },
    };
}
/** The one autopilot controller, built lazily. Its host turns runner events into
 *  the app-only side effects: streaming to the terminal, opening links, floating
 *  to a gate, and opening the finished app. */
/** The network a self-hoster's guide source is reached through — Electron's
 *  global `fetch`, narrowed to the injectable `FetchLike` shape so the resolver
 *  stays a pure, unit-tested module. Unused on the default `bundled:` source,
 *  where the guides come off disk. */
const guideFetchImplementation = (url, init) => globalThis.fetch(url, init);
/** The primary recipe resolver: read the app's guide, derive a recipe from the
 *  branch for THIS platform, and fall back to the built-in `recipes.js` table
 *  only when there is no guide. This is what makes every guide with a matching
 *  branch auto-installable without a code change — including a guide a reader
 *  drops into `lib/iris/guides/` themselves. */
function productionRecipeResolver(slug) {
    return (0, guide_recipe_resolver_1.guideBackedRecipeResolver)({
        apiBase: settings.get("guideSource"),
        fetchImplementation: guideFetchImplementation,
        // Desktop/local-web install for THIS computer. Upstream hard-coded
        // "windows" because that build only ran there; GemAir ships on both, and
        // the guides carry a macos branch, so the platform is read rather than
        // assumed. A mobile guide's branch stays a later concern, threaded from
        // the deep link's `branch=windows:android`.
        target: { platform: process.platform === "win32" ? "windows" : "macos" },
    })(slug);
}
function autopilotController() {
    if (autopilot)
        return autopilot;
    autopilot = new autopilot_controller_1.AutopilotController({
        // The one-time "Let GemAir take control?" consent, remembered across installs
        // via the persisted `autopilotAutonomyGranted` setting (revocable from the
        // settings window). Once granted, the whole vetted install runs hands-off.
        ensureAutonomyGranted: async () => {
            // The headed GUI e2e drives the autopilot with no one to click a modal, so
            // it pre-grants via GEMAIR_E2E (the same flag that unlocks the e2e-only guide
            // hook). The real granted/declined logic is unit-tested in
            // autopilot-controller.test.ts; a modal cannot be exercised headlessly.
            if (process.env.GEMAIR_E2E === "1")
                return true;
            if (settings.get("autopilotAutonomyGranted"))
                return true;
            const options = {
                type: "question",
                buttons: ["Let GemAir take control", "Not now"],
                defaultId: 0,
                cancelId: 1,
                message: "Let GemAir take control of your PC?",
                detail: "GemAir will run this install itself — installing the tools it needs, building the app, and setting it up — without asking you to approve each step. It never runs anything that would erase your disk, and you can turn this off anytime in GemAir's settings.",
            };
            const parent = autopilotWindow && !autopilotWindow.isDestroyed() ? autopilotWindow : null;
            const result = parent
                ? await electron_1.dialog.showMessageBox(parent, options)
                : await electron_1.dialog.showMessageBox(options);
            const granted = result.response === 0;
            if (granted)
                settings.set("autopilotAutonomyGranted", true);
            return granted;
        },
        emitEvent: (event) => {
            broadcast("autopilot:event", event);
            // Drive the tray's "your turn" state (tooltip, menu item, toast) off the
            // same event stream — it raises when the run stops for the reader and
            // clears when it moves again. See `services/autopilot/your-turn.ts`.
            (0, tray_1.observeAutopilotEventForTray)(event);
        },
        openExternal: (url) => openExternalSafely(url),
        floatToGate: (instruction, href) => {
            // Bring the terminal to the reader and open the page a sign-in step points
            // at; the renderer shows the instruction next to the eye. A model-located
            // glow at the exact field is a later refinement.
            const surface = autopilotWindow && !autopilotWindow.isDestroyed()
                ? autopilotWindow
                : guideWindow && !guideWindow.isDestroyed()
                    ? guideWindow
                    : null;
            if (surface) {
                surface.show();
                surface.focus();
            }
            if (href)
                openExternalSafely(href);
            broadcast("autopilot:gate", { instruction, href });
            // Then float the eye to the actual control the reader must use. A sign-in
            // page needs a moment to render before it can be found; a permission
            // prompt is already up. Best-effort — pointAtGate swallows its own errors.
            const pointingTarget = href ? `sign in on the page that just opened — ${instruction}` : instruction;
            const settleDelayMs = href ? 2500 : 800;
            setTimeout(() => void companion.pointAtGate(pointingTarget), settleDelayMs);
        },
        onFinished: (finishedInstall) => {
            // The one moment provenance is knowable for certain — a guide-source
            // clone maintain mode may later patch, versus a signed download it never
            // may. Recorded before anything opens, mirroring macOS's
            // `onGuideCompleted` → `recordInstallProvenance` ordering.
            maintain.recordInstallProvenance(finishedInstall);
            // Once it's done, the app just opens. A local_web app opens its URL; a
            // desktop app is left for the reader/inventory to launch (opening an
            // arbitrary exe path is deliberately not an autopilot side effect).
            const output = finishedInstall.output;
            if (output.type === "local_web")
                openExternalSafely(output.url);
            broadcast("autopilot:finished", output);
        },
        onAborted: () => {
            // The reader hit 'Stop': fold the terminal away so they are never left
            // with a window they can't get out of (macOS `onAutopilotDidStop`). The
            // window's own 'closed' handler clears the tray's run state.
            if (autopilotWindow && !autopilotWindow.isDestroyed())
                autopilotWindow.close();
        },
    }, 
    // Keep the default shell factory (PowerShell on Windows), and inject the
    // guide-backed resolver as the primary path so `canInstall`/`start` answer
    // from the fetched guide, with the built-in table as the offline fallback.
    undefined, productionRecipeResolver, 
    // The self-repair ladder, powered by the reader's own model key.
    buildFixLadderForRecipe, 
    // The setup-recovery detour's real seams: a tool probe that re-reads the PATH
    // from the registry (so a tool the detour just installed is seen) and the wall
    // clock. Wiring them is what turns the detour on in production; the unit suite
    // leaves them out and injects fakes.
    { probe: new setup_detour_host_1.RegistryRefreshingToolProbe(), clock: new setup_detour_host_1.RealDetourClock() }, 
    // The watch executor for `verify`/watched steps. Its toolVersion rung — the
    // cheapest and most heavily-authored watch signal (every guide's `install-rust`
    // watches for `cargo`, every tools check for git/node) — is wired to the same
    // execFile-based `checkToolVersion` the `check_tool_version` IPC already uses,
    // so it can actually verify in production instead of the "not wired" default
    // that answers false forever. The visual capture/evaluation seams stay unwired
    // here (they need the screenshot pipeline + a model transport); side-signal
    // watching is fully live. Wrapped so a non-allowlisted tool — which
    // `checkToolVersion` throws on, though the executor already refuses one before
    // asking — can never escape as a rejection, only a quiet "not installed".
    () => (0, watch_1.defaultWatchExecutor)({
        isToolInstalled: async (tool) => {
            try {
                return (await checkToolVersion(tool)).available;
            }
            catch {
                return false;
            }
        },
    }));
    return autopilot;
}
/** Builds the self-repair ladder for one install. The proposer runs on the free
 *  OpenCode route (`firstAvailableMaintainProvider`, which reads the reader's own
 *  key when they have one and falls back to the public token when they do not);
 *  when nothing is reachable the proposer is undefined and the ladder degrades to
 *  "surface the failure at once with a clear reason" rather than hanging.
 *  Autonomy is granted here because an autopilot run is only ever constructed
 *  after the reader consented (see `start`). Upstream threaded per-install spend
 *  caps through here to bound publik's spend; GemAir's routes are free, so the
 *  ladder is bounded by its rung count alone. */
function buildFixLadderForRecipe(recipe) {
    const provider = (0, model_provider_1.firstAvailableMaintainProvider)({
        // The reader's own `opencode` first — it needs no key at all and it is
        // already signed in to whatever they signed it into.
        probeOpenCodeCli: () => (0, opencode_session_1.openCodeIsAvailable)(),
        createOpenCodeCliBackend: (model) => new opencode_session_1.OpenCodeChatBackend({ model }),
        // Otherwise the hosted free gateway, with the reader's free-tier key when
        // they pasted one and the public token when they did not.
        readOpenCodeApiKey: () => settings.getOpenCodeApiKey(),
        modelId: settings.get("openCodeModel"),
    });
    const proposer = provider ? new fix_ladder_1.ModelFixProposer(provider) : undefined;
    return new fix_ladder_1.FixLadder(proposer, recipe, (0, fix_ladder_1.hostsReachedByRecipe)(recipe), {
        shellPath: process.platform === "win32" ? "powershell.exe" : process.env.SHELL ?? "/bin/zsh",
        operatingSystemVersion: `${node_os_1.default.type()} ${node_os_1.default.release()}`,
        architecture: node_os_1.default.arch(),
        knownToolVersions: [],
    }, process.platform, true, confirmFixCommandWithReader);
}
/** Asks the reader to approve one model-proposed repair the risk gate could not
 *  read from its text — an opaque `$(...)`/backtick shape, which trips a confirm
 *  tap at `model_proposed_fix` provenance even under the autonomy grant (opacity
 *  is judged before the grant short-circuits; see `risk.ts`). Without this
 *  wired, `FixLadder`'s `confirmFix` defaults to "always refuse", so a benign,
 *  mechanically-correct opaque fix could never run and the ladder would burn
 *  rungs declining fixes nobody was asked about. This is a real blocking prompt,
 *  the analog of macOS `askTheReaderToConfirm(isFromAFix: true)` — the same
 *  modal shape `ensureAutonomyGranted` uses above. */
async function confirmFixCommandWithReader(command, reason) {
    // The headless e2e has no one to answer a modal; decline rather than hang.
    // Declining is the safe direction — it just means an opaque fix is not run.
    if (process.env.GEMAIR_E2E === "1")
        return false;
    const options = {
        type: "question",
        buttons: ["Run this repair", "Skip it"],
        defaultId: 1,
        cancelId: 1,
        message: "GemAir found a repair it couldn't fully read. Run it?",
        detail: `${reason}\n\nThe repair GemAir wants to run:\n${command}`,
    };
    const parent = autopilotWindow && !autopilotWindow.isDestroyed() ? autopilotWindow : null;
    const result = parent
        ? await electron_1.dialog.showMessageBox(parent, options)
        : await electron_1.dialog.showMessageBox(options);
    return result.response === 0;
}
function handleGuideCommand(command, args) {
    switch (command) {
        case "take_pending_guide": {
            // Taken, not read: a pending link is delivered exactly once, so reopening
            // the panel later does not silently reset the reader's place.
            const guide = pendingGuideDeepLink;
            pendingGuideDeepLink = null;
            return guide;
        }
        case "check_tool_version":
            return checkToolVersion(String(args.tool ?? ""));
        case "fetch_guide":
            // Upstream's panel fetched this itself, straight from publik over
            // HTTPS. GemAir's guides ship inside the app, so the read happens
            // here — one place that knows the bundle directory, the version
            // rules and the four status meanings, and the only place allowed to
            // touch the disk.
            return (0, guide_service_1.fetchGuide)({
                slug: String(args.slug ?? ""),
                version: typeof args.version === "number" ? args.version : null,
                apiBase: typeof args.apiBase === "string" && args.apiBase ? args.apiBase : settings.get("guideSource"),
                fetchImplementation: guideFetchImplementation,
            }).catch((error) => {
                // A GuideServiceError carries a reader-ready sentence; anything
                // else is reported as itself. Either way the panel renders it as
                // its error state rather than a blank screen.
                throw new Error((0, guide_service_1.guideErrorMessage)(error?.details) ?? (error instanceof Error ? error.message : String(error)));
            });
        case "list_guides":
            // Every guide this build ships — the install list.
            return (0, guide_service_1.bundledGuideSummaries)();
        case "open_external": {
            const classification = (0, external_links_1.classifyExternalLink)(args.url);
            if (!classification.allowed) {
                // Refuse loudly. The panel turns this into a disabled control naming the
                // host rather than a button that appears to do nothing.
                throw new Error((0, external_links_1.refusalMessage)(classification) ?? "GemAir blocked that link.");
            }
            return electron_1.shell.openExternal(classification.url);
        }
        case "quit_iris":
            electron_1.app.quit();
            return null;
        case "hide_iris":
            guideWindow?.hide();
            return null;
        case "resize_iris": {
            const presetSizes = {
                collapsed: { width: 420, height: 220 },
                menu: { width: 420, height: 520 },
                guide: { width: 420, height: 620 },
            };
            const size = presetSizes[String(args.preset ?? "guide")] ?? presetSizes.guide;
            if (guideWindow && !guideWindow.isDestroyed()) {
                guideWindow.setSize(size.width, size.height, true);
            }
            return null;
        }
        case "glide_iris": {
            glideGuidePanel(String(args.anchor ?? "bottom-right"));
            return null;
        }
        // ── Autopilot (guided install) ──────────────────────────────────────────
        // The panel drives an install through these; the runner streams its progress
        // back on the `autopilot:event` channel (see `autopilotController`).
        case "autopilot_open":
            // Opens the animated terminal window, which then calls `autopilot_start`.
            openAutopilotWindow(String(args.slug ?? ""));
            return null;
        case "autopilot_collapse":
            // The renderer finished; morph the terminal back into the eye and close.
            collapseAutopilotWindow();
            return null;
        case "autopilot_can_install":
            return autopilotController().canInstall(String(args.slug ?? ""));
        case "autopilot_start":
            return autopilotController().start(String(args.slug ?? ""));
        case "autopilot_confirm":
            return autopilotController().confirm(Boolean(args.approved));
        case "autopilot_reader_done":
            return autopilotController().readerFinished();
        case "autopilot_retry":
            // The reader chose "Try again" on a surfaced (self-repair-exhausted) step.
            return autopilotController().retry();
        case "autopilot_continue_past":
            // The reader chose "Continue past it" on a surfaced step.
            return autopilotController().continuePast();
        case "autopilot_abort":
            // The red 'Stop': kill the running step's process tree and end the run.
            // The host's `onAborted` folds the window away.
            return autopilotController().abort();
        case "foreground_app_identity":
            // Windows has no cross-process foreground-app API without a native module.
            // Returning null keeps the guide panel's watch strip honest instead of
            // inventing an answer; `app.js` already renders that case.
            return null;
        case "e2e_open_settings": {
            // TEST-ONLY, gated behind `GEMAIR_E2E=1`, so it never affects shipped
            // behaviour: outside the e2e suite this command does not exist and falls
            // through to the same "unknown command" error as any other. The headed
            // GUI e2e suite (`tests/gui-e2e/`) needs to open the Settings window from
            // CDP — a native tray click is not reachable over the DevTools protocol —
            // and there is otherwise no renderer-facing way in. See
            // `tests/gui-e2e/README.md`.
            if (process.env.GEMAIR_E2E !== "1") {
                throw new Error(`unknown GemAir command '${command}'`);
            }
            showSettingsWindow();
            return null;
        }
        default:
            throw new Error(`unknown GemAir command '${command}'`);
    }
}
// MARK: - IPC
function setupIPC() {
    electron_1.ipcMain.handle("chat:query", async (_event, text) => companion.processQuery(text));
    // Read by the chat window right after `chat:query` rejects: the clean
    // sentence, and the one "Add credit" link when the failure was a 402. An
    // invoke rejection carries only a (prefixed) message, so the link has to
    // come back this way.
    electron_1.ipcMain.handle("chat:lastFailure", () => companion.lastChatFailure());
    electron_1.ipcMain.handle("settings:getAll", () => ({
        ...settings.getAll(),
        // Never the key itself — only whether one is stored. The reader's own
        // OpenCode key is optional: the free ids answer to the public token, so
        // this is "do you have your own rate limit", not "can you use GemAir".
        hasOpenCodeApiKey: Boolean(settings.getOpenCodeApiKey()),
        hasGitHubToken: Boolean(settings.getGitHubToken()),
        secretStorageAvailable: (0, secrets_1.secretStorageIsAvailable)(),
        // Which routes are actually usable right now, so the panel can show the
        // options honestly rather than offering one that cannot answer.
        cliAvailable: cliAvailableCached,
        localServer: companion?.localServerBaseUrl ?? null,
        route: currentRouteView(),
        // The free-model catalogue the gate will accept, for the model picker.
        // The picker offers the free ids chat can actually use — the gate still
        // says yes to the other free ones (Jev, the Muse Spark contributor ids),
        // they just answer on a different endpoint.
        freeModels: (0, opencode_models_1.chatCapableFreeModelIds)(),
        defaultFreeModel: opencode_models_1.DEFAULT_FREE_MODEL,
        providerPreferences: assistant_transport_1.PROVIDER_PREFERENCES,
        // Every guide that ships with this build, for the install list.
        guides: (0, guide_service_1.bundledGuideSummaries)(),
    }));
    electron_1.ipcMain.handle("settings:set", (_event, key, value) => {
        if (key === "openCodeApiKey") {
            const accepted = settings.setOpenCodeApiKey(String(value ?? ""));
            publishRoute();
            return accepted;
        }
        if (key === "githubAccessToken") {
            return settings.setGitHubToken(String(value ?? ""));
        }
        if (key === "openCodeModel") {
            // The free-model gate runs HERE, at the moment a model is chosen,
            // rather than only when a request is built: a reader who types a paid
            // id is told no by the field they typed it into, which is the only
            // place the refusal reads as an answer instead of a failure.
            try {
                (0, opencode_models_1.assertFreeModelId)(String(value ?? ""));
            }
            catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        }
        settings.set(key, value);
        if (key === "providerPreference" || key === "openCodeServerPort") {
            void refreshRoute();
        }
        if (key === "alwaysOnTop" && chatWindow && !chatWindow.isDestroyed()) {
            chatWindow.setAlwaysOnTop(Boolean(value), "screen-saver");
        }
        if (key === "cursorBuddyEnabled") {
            if (value)
                startCursorBuddy();
            else
                stopCursorBuddy();
        }
        if (key === "maintainEnabled" && maintain) {
            if (value)
                maintain.startDetection();
            else
                maintain.stopDetection?.();
        }
        return true;
    });
    // MARK: The free routes
    //
    // Upstream had provisioning, a claim code, a balance and a top-up link here.
    // GemAir has three calls, none of which involve money or an account.
    /** What is reachable right now, re-probed. */
    electron_1.ipcMain.handle("assist:route", () => currentRouteView());
    electron_1.ipcMain.handle("assist:refreshRoute", () => refreshRoute());
    /**
     * Asks OpenCode Zen for today's catalogue and folds the free ids into the
     * gate, so a model that became free this morning is offerable this morning.
     * Never widens anything: `refreshFreeModelIds` only learns ids the catalogue
     * itself marks free.
     */
    electron_1.ipcMain.handle("assist:refreshFreeModels", async () => {
        try {
            const request = (0, assistant_transport_1.makeModelCatalogueRequest)({
                tier: "zen",
                apiKey: settings.getOpenCodeApiKey() || undefined,
                apiBaseUrl: settings.get("openCodeBaseUrl"),
            });
            const response = await globalThis.fetch(request.url, {
                method: request.method,
                headers: request.headers,
            });
            if (!response.ok)
                return { ok: false, models: (0, opencode_models_1.knownFreeModelIds)() };
            (0, opencode_models_1.refreshFreeModelIds)(await response.text());
            return { ok: true, models: (0, opencode_models_1.knownFreeModelIds)() };
        }
        catch {
            return { ok: false, models: (0, opencode_models_1.knownFreeModelIds)() };
        }
    });
    /** Re-probed after the reader installs the CLI, so settings stops saying
     *  "not found" without a restart. */
    electron_1.ipcMain.handle("assist:refreshCli", async () => {
        cliAvailableCached = await companion.refreshCliAvailability();
        publishRoute();
        return cliAvailableCached;
    });
    electron_1.ipcMain.handle("firstRun:complete", () => {
        settings.set("hasCompletedFirstRun", true);
        if (firstRunWindow && !firstRunWindow.isDestroyed())
            firstRunWindow.close();
        return true;
    });
    electron_1.ipcMain.handle("guide:open", () => {
        openGuideWindow();
    });
    /** Every guide that ships with this build — the install list's data. */
    electron_1.ipcMain.handle("guide:list", () => (0, guide_service_1.bundledGuideSummaries)());
    /** Opens the guide panel straight onto one app, the way a deep link does. */
    electron_1.ipcMain.handle("guide:show", (_event, slug) => {
        pendingGuideDeepLink = { slug: String(slug ?? ""), version: null, branch: null, step: null };
        openGuideWindow();
        broadcast("gemair-guide-opened", pendingGuideDeepLink);
        return true;
    });
    // The chat window's gear button: Settings in one click, instead of only
    // through the tray icon's right-click menu.
    electron_1.ipcMain.handle("settings:open", () => {
        showSettingsWindow();
    });
    // The single entry point the transplanted guide panel uses.
    electron_1.ipcMain.handle("gemair:invoke", (_event, command, args) => handleGuideCommand(command, args ?? {}));
    electron_1.ipcMain.handle("shell:openExternal", (_event, url) => {
        const classification = (0, external_links_1.classifyExternalLink)(url);
        if (!classification.allowed) {
            throw new Error((0, external_links_1.refusalMessage)(classification) ?? "GemAir blocked that link.");
        }
        return electron_1.shell.openExternal(classification.url);
    });
    electron_1.ipcMain.handle("window:minimize", (event) => {
        electron_1.BrowserWindow.fromWebContents(event.sender)?.minimize();
    });
    electron_1.ipcMain.handle("window:close", (event) => {
        electron_1.BrowserWindow.fromWebContents(event.sender)?.close();
    });
    // ── Maintain mode ────────────────────────────────────────────────────────
    // The five calls the ask card drives, plus the resize callback described in
    // `showMaintainCard`'s comment. `maintain:snapshot` (the push half) is sent
    // directly to `maintainWindow`, not broadcast to every window, since the
    // card is the only renderer that ever needs it.
    electron_1.ipcMain.handle("maintain:getSnapshot", () => maintain.currentSnapshot());
    electron_1.ipcMain.handle("maintain:answerAsk", (_event, answer) => maintain.answerAsk(answer));
    electron_1.ipcMain.handle("maintain:clearFixStatus", () => maintain.clearFixStatus());
    electron_1.ipcMain.handle("maintain:mutedApps", () => maintain.mutedApps());
    electron_1.ipcMain.handle("maintain:unmuteApp", (_event, appSlug) => maintain.unmuteApp(appSlug));
    electron_1.ipcMain.handle("maintain:resize", (_event, height) => {
        if (maintainWindow && !maintainWindow.isDestroyed()) {
            maintainWindow.setBounds(maintainCardRect(height));
        }
    });
}
// MARK: - Bootstrap
//
// Upstream this was `app.whenReady().then(...)` guarded by the single-instance
// lock — the file WAS the app. Here it is a function GemAir's `main.js` calls
// once, after its own `whenReady`, and everything above hangs off it.

let started = false;

/**
 * Starts the Assist subsystem. Safe to call once; a second call is ignored.
 *
 * @param {object} [options]
 * @param {() => void} [options.onRouteChanged] Host hook: which free route is
 *        answering has changed (the tray line).
 * @param {() => void} [options.onTrayChanged] Host hook: rebuild the tray menu,
 *        because `assistMenuItems()` would now return something different.
 * @param {boolean} [options.showChat] Open the chat window at startup. Off by
 *        default: GemAir has its own main window, and a second one appearing
 *        uninvited at every launch is not what a subsystem does.
 * @param {boolean} [options.startDetection] Run maintain mode's crash/hang
 *        watch. Defaults to the `maintainEnabled` setting, which is off.
 */
function startAssist(options = {}) {
    if (started)
        return assistApi();
    started = true;
    hostHooks = options;
    settings = new settings_1.SettingsStore();
    registerGemAirScheme();
    overlayWindows = createOverlayWindows();
    companion = new companion_1.CompanionManager(settings, overlayWindows);
    maintain = new controller_1.MaintainController(maintainHost());
    setupIPC();
    (0, tray_1.configureAssistTray)({
        onChat: () => showChatWindow(),
        onGuide: () => openGuideWindow(),
        onSettings: () => showSettingsWindow(),
        onYourTurn: () => {
            // Land the reader on the install that is waiting for them.
            if (autopilotWindow && !autopilotWindow.isDestroyed()) {
                autopilotWindow.show();
                autopilotWindow.focus();
            }
        },
        onStopInstall: () => {
            // The tray's half of the escape hatch — same funnel as the window's red
            // 'Stop'. `onAborted` folds the window away.
            autopilotController().abort();
        },
        onQuit: () => electron_1.app.quit(),
    });
    if (options.onTrayChanged)
        (0, tray_1.onAssistTrayChanged)(options.onTrayChanged);
    if (options.showChat)
        showChatWindow();
    if (settings.get("cursorBuddyEnabled"))
        startCursorBuddy();
    // Which free route can actually answer — the CLI probe and the local-server
    // probe, both in the background, so a missing one costs nothing.
    void refreshRoute();
    // Ask for a key once, on the first launch. Unlike upstream this is almost
    // never shown: the free ids answer to the public token, so `isConfigured()`
    // is already true unless the reader pinned a route that is not reachable.
    openFirstRunWindowIfNeeded();
    // A link that launched the app is sitting in this process's own argv.
    receiveDeepLinksFromArgv(process.argv);
    // Test convenience: `GEMAIR_AUTOPILOT_DEMO=<slug>` opens the animated terminal
    // and starts installing that app straight away, so the whole autopilot can be
    // watched running an install end to end with no clicks.
    const demoSlug = process.env.GEMAIR_AUTOPILOT_DEMO;
    if (demoSlug && demoSlug.length > 0) {
        openAutopilotWindow(demoSlug);
    }
    // The always-on detection layer: the crash-artifact watch (event-driven,
    // free) and — on Windows — the 2s hang-probe tick over the frontmost
    // catalog app. Opt-in here, unlike upstream, because GemAir is not only an
    // installer and a reader who never used the autopilot has nothing for it to
    // watch; see `maintain/controller.js`'s `startDetection`.
    if (options.startDetection ?? settings.get("maintainEnabled")) {
        maintain.startDetection();
        // Same idiom, maintain mode's side: `GEMAIR_MAINTAIN_DEMO_CRASH=<slug>`
        // raises a synthetic ask a few seconds in, so the whole ladder — ask
        // card, pool round trip, fix status — is provable with no real crash.
        maintain.triggerDemoIncidentIfConfigured();
    }
    console.log("GemAir Assist started");
    return assistApi();
}

/** Everything the host app may call once Assist is running. */
function assistApi() {
    return {
        openChat: () => showChatWindow(),
        openGuide: () => openGuideWindow(),
        openGuideFor: (slug) => {
            pendingGuideDeepLink = { slug: String(slug ?? ""), version: null, branch: null, step: null };
            openGuideWindow();
        },
        openSettings: () => showSettingsWindow(),
        openAutopilot: (slug) => openAutopilotWindow(String(slug ?? "")),
        /** Forward a second launch's argv, which is where Windows puts a link. */
        receiveDeepLinksFromArgv,
        receiveDeepLink,
        /** The tray fragment and its tooltip override. */
        menuItems: () => (0, tray_1.assistMenuItems)(),
        trayTooltip: () => (0, tray_1.assistTrayTooltip)(),
        /** Ask the companion a question directly, without the chat window. */
        ask: (text) => companion.processQuery(String(text ?? "")),
        route: () => currentRouteView(),
        refreshRoute,
        guides: () => (0, guide_service_1.bundledGuideSummaries)(),
        maintain: () => maintain,
        companion: () => companion,
        settings: () => settings,
        showInstalledNotice,
        /** Tear down the timers and windows this subsystem owns. */
        stop: () => {
            stopCursorBuddy();
            maintain?.stopDetection?.();
            autopilot?.dispose();
            for (const window of [chatWindow, settingsWindow, firstRunWindow, guideWindow, autopilotWindow, maintainWindow, ...overlayWindows]) {
                if (window && !window.isDestroyed())
                    window.destroy();
            }
            overlayWindows = [];
            started = false;
        },
    };
}

exports.startAssist = startAssist;
exports.assistMenuItems = () => (0, tray_1.assistMenuItems)();
exports.assistTrayTooltip = () => (0, tray_1.assistTrayTooltip)();
