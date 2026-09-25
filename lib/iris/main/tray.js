"use strict";
/**
 * main/tray.js
 *
 * The Assist subsystem's half of the tray menu.
 *
 * Upstream this file OWNED the tray: it constructed `new Tray(...)`, set the
 * icon and the tooltip, and rebuilt the whole context menu on every state
 * change. GemAir already has a tray (see `createTray()` in `main.js`), and two
 * tray icons for one app is a bug, not a feature — so this file keeps all of
 * upstream's state machine and gives up the icon:
 *
 *   `assistMenuItems()`   — the menu template fragment GemAir splices into its
 *                           own menu, exactly as upstream built it.
 *   `onAssistTrayChanged` — fires when the fragment would change (a run
 *                           starting, the reader's turn arriving), so the host
 *                           rebuilds its menu. Electron menus are immutable
 *                           once built, so a change means a rebuild.
 *   `assistTrayTooltip()` — "GemAir needs you — your turn" while an install is
 *                           waiting, otherwise null, so the host can leave its
 *                           own resting tooltip alone.
 *
 * The "your turn" toast and the YourTurnTracker are unchanged: they are the
 * reason this state machine exists — an install that stops for the reader must
 * say so somewhere they will see it, even with every GemAir window closed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureAssistTray = configureAssistTray;
exports.assistMenuItems = assistMenuItems;
exports.onAssistTrayChanged = onAssistTrayChanged;
exports.assistTrayTooltip = assistTrayTooltip;
exports.observeAutopilotEventForTray = observeAutopilotEventForTray;
exports.setTrayInstallActive = setTrayInstallActive;
exports.clearTrayYourTurn = clearTrayYourTurn;
exports.setTrayRoute = setTrayRoute;
const electron_1 = require("electron");
const your_turn_1 = require("../services/autopilot/your-turn");

const YOUR_TURN_TOOLTIP = "GemAir needs you — your turn";

let callbacks = null;
let listener = null;
// The tracker turns the stream of autopilot events into "waiting on the reader"
// transitions; `installActive` is the separate fact of whether a run exists at
// all (so 'Stop the install' shows during a run even while a command is running,
// not only while waiting).
const tracker = new your_turn_1.YourTurnTracker();
let waitingInstruction;
let installActive = false;
/** Which free route is answering — the line that replaced upstream's balance. */
let route = null;

/** Wires the callbacks the menu items invoke. Called once by `startAssist`. */
function configureAssistTray(cb) {
    callbacks = cb;
}

/** Registers the host's "rebuild your menu" callback. */
function onAssistTrayChanged(cb) {
    listener = cb;
}

function changed() {
    listener?.();
}

/**
 * The Assist fragment of the tray menu, as an Electron menu template. Built
 * fresh on every call because that is the only way an Electron menu changes.
 */
function assistMenuItems() {
    if (!callbacks) return [];
    const cb = callbacks;
    const template = [];
    if (tracker.isWaiting) {
        template.push({
            label: waitingInstruction
                ? `Your turn — ${trimForMenu(waitingInstruction)}`
                : "Your turn — bring GemAir to front",
            click: cb.onYourTurn,
        });
        template.push({ type: "separator" });
    }
    template.push({ label: "Ask GemAir Assist", click: cb.onChat }, { label: "Install guides", click: cb.onGuide }, { label: "Assist settings", click: cb.onSettings });
    if (route && route.route) {
        // Upstream showed "$4.12 left · about 300 more messages · Add credit".
        // Every GemAir route is free, so the honest line is which one is
        // answering — and it is disabled, because there is nothing to buy.
        template.push({ label: `Answering via ${route.route}`, enabled: false });
    }
    if (installActive) {
        template.push({ type: "separator" }, { label: "Stop the install", click: cb.onStopInstall });
    }
    return template;
}

/** "Your turn" while an install waits, otherwise null (host keeps its own). */
function assistTrayTooltip() {
    return tracker.isWaiting ? YOUR_TURN_TOOLTIP : null;
}

/// A menu label wants one short line; a multi-line instruction is squeezed to
/// its first sentence-ish chunk so the item stays readable.
function trimForMenu(instruction) {
    const firstLine = String(instruction).split("\n")[0].trim();
    return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

/// Feed one autopilot event to the tray. Raises the "your turn" state (with a
/// one-off toast) when the run stops for the reader, and clears it when the run
/// moves again. Called from the autopilot host's `emitEvent`.
function observeAutopilotEventForTray(event) {
    // A run that ends — for any reason — is no longer active, so 'Stop the
    // install' should disappear even if the tracker treated the event as a
    // "moving again" clear.
    if (event.type === "finished" || event.type === "aborted") {
        installActive = false;
    }
    const update = tracker.observe(event);
    if (update.action === "raise") {
        waitingInstruction = update.instruction;
        changed();
        if (update.notify) showYourTurnToast(update.instruction);
    }
    else if (update.action === "clear") {
        waitingInstruction = undefined;
        changed();
    }
    else if (event.type === "finished" || event.type === "aborted") {
        // Not a waiting-state change, but the run ended: refresh so 'Stop the
        // install' is removed.
        changed();
    }
}

/// Marks whether an install is running, so 'Stop the install' shows for its
/// whole duration. Set true when the autopilot window opens, false when it
/// closes or the run ends.
function setTrayInstallActive(active) {
    if (installActive === active) return;
    installActive = active;
    changed();
}

/// Clears any pending "your turn" state — used when the autopilot window closes
/// so a stale tooltip/menu never outlives the run.
function clearTrayYourTurn() {
    if (!tracker.isWaiting && waitingInstruction === undefined) return;
    // Feed a synthetic "moving again" so the tracker's own state clears too.
    tracker.observe({ type: "aborted" });
    waitingInstruction = undefined;
    changed();
}

/// Tells the tray which free route is answering. Replaces upstream's
/// `setTrayPublikBalance`: same call site, same "skip the rebuild when nothing
/// changed" rule, no money.
function setTrayRoute(nextRoute) {
    if (JSON.stringify(nextRoute) === JSON.stringify(route)) return;
    route = nextRoute;
    changed();
}

function showYourTurnToast(instruction) {
    if (!electron_1.Notification.isSupported()) return;
    new electron_1.Notification({
        title: "GemAir needs you",
        body: trimForMenu(instruction),
    }).show();
}
