"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_module_1 = require("node:module");
const vitest_1 = require("./vitest-shim");
/**
 * Maintain mode as the reader meets it: something of theirs broke, a small card
 * appears in the corner, they answer it, it goes away.
 *
 * The service-level ladder (signatures, the pool, replay, Tier C) is covered by
 * `maintain-*.test.js`. What only an Electron-level test can show is the card
 * itself — that it opens without stealing focus, that the snapshot reaches the
 * renderer even though the window was still loading when it was raised, that
 * answering through the real IPC channel puts it away, and that a muted app
 * stays quiet. The middle one is a genuine trap: the snapshot has to be queued
 * until `did-finish-load`, and a card that renders empty looks exactly like a
 * detector that never fired.
 */
const FAKE_ELECTRON_PATH = require.resolve("./fixtures/fake-electron.js");
const originalResolveFilename = node_module_1.Module._resolveFilename;
node_module_1.Module._resolveFilename = function resolveWithFakeElectron(request, ...rest) {
    if (request === "electron")
        return FAKE_ELECTRON_PATH;
    return originalResolveFilename.call(this, request, ...rest);
};
const electron = require(FAKE_ELECTRON_PATH);
const integration_1 = require("../../lib/iris/integration");
/** No network at all: no pool is configured, and nothing may reach out. */
const networkCalls = [];
globalThis.fetch = async (url) => {
    networkCalls.push(String(url));
    throw new Error("connect ECONNREFUSED");
};
/** Lets the queued `did-finish-load` push run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
function maintainWindow() {
    return electron.BrowserWindow.getAllWindows()
        .find((window) => typeof window.loadedFile === "string" && window.loadedFile.includes("/maintain/"));
}
function snapshotsSentToCard() {
    return (maintainWindow()?.webContents.sentMessages ?? [])
        .filter((message) => message.channel === "maintain:snapshot")
        .map((message) => message.args[0]);
}
function aLaunchFailure(overrides = {}) {
    return {
        appSlug: "ollama",
        appName: "Ollama",
        appStack: "other",
        daemon: "ollama app.exe",
        reason: "exited with code 1",
        ...overrides,
    };
}
let assist;
let maintain;
(0, vitest_1.beforeAll)(() => {
    // Detection ON: this is the path a real install takes once the reader turns
    // maintain mode on, watchers and all.
    assist = (0, integration_1.mount)({ startDetection: true });
    maintain = assist.raw().maintain();
});
(0, vitest_1.afterAll)(() => {
    assist?.stop?.();
    node_module_1.Module._resolveFilename = originalResolveFilename;
});
(0, vitest_1.describe)("starting the watchers", () => {
    (0, vitest_1.it)("starts detection without opening anything or asking anything", () => {
        (0, vitest_1.expect)(maintain).toBeDefined();
        (0, vitest_1.expect)(maintain.currentSnapshot().pendingAsk).toBeNull();
        (0, vitest_1.expect)(maintainWindow()).toBeUndefined();
    });
    (0, vitest_1.it)("registers the channels the card talks back on", () => {
        const channels = [...electron.calls.ipcHandlers.keys()];
        for (const channel of ["maintain:getSnapshot", "maintain:answerAsk", "maintain:mutedApps", "maintain:unmuteApp"]) {
            (0, vitest_1.expect)(channels).toContain(channel);
        }
    });
});
(0, vitest_1.describe)("when something of theirs fails to start", () => {
    (0, vitest_1.it)("raises one ask, in the reader's words rather than the crash's", async () => {
        maintain.reportLaunchFailure(aLaunchFailure());
        await settle();
        const ask = maintain.currentSnapshot().pendingAsk;
        (0, vitest_1.expect)(ask).toBeDefined();
        (0, vitest_1.expect)(ask.appSlug).toBe("ollama");
        (0, vitest_1.expect)(ask.evidenceSentence).toBe("Ollama didn't start just now.");
        // Not a stack, not an exit code, not a signature hash.
        (0, vitest_1.expect)(ask.evidenceSentence).not.toContain("code 1");
    });
    (0, vitest_1.it)("shows the card without taking the keyboard away from the reader", () => {
        const card = maintainWindow();
        (0, vitest_1.expect)(card).toBeDefined();
        (0, vitest_1.expect)(card.isVisible()).toBe(true);
        // Put on screen INACTIVE: `show()` here would yank the keyboard out of
        // whatever the reader was typing at the moment their app fell over.
        (0, vitest_1.expect)(card.shownInactive).toBeGreaterThan(0);
        (0, vitest_1.expect)(card.shownActive).toBe(0);
        (0, vitest_1.expect)(card.alwaysOnTopLevel).toBe("screen-saver");
        (0, vitest_1.expect)(card.options.frame).toBe(false);
        (0, vitest_1.expect)(card.options.skipTaskbar).toBe(true);
    });
    (0, vitest_1.it)("delivers the snapshot even though the window was still loading", () => {
        // The raise happens before the renderer exists, so the push has to be
        // queued until `did-finish-load` — this is the assertion that proves it.
        const snapshots = snapshotsSentToCard();
        (0, vitest_1.expect)(snapshots.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(snapshots.at(-1).pendingAsk.appName).toBe("Ollama");
    });
    (0, vitest_1.it)("asks without a pool, a key or a network round trip", () => {
        // No maintain pool is configured by default, so a break is handled
        // entirely on the reader's machine until they ask for a fix.
        // The startup route probe is loopback and unrelated; what must not happen
        // is a call OUT — no pool, no telemetry, no model, until the reader asks.
        (0, vitest_1.expect)(networkCalls.filter((url) => !url.includes("127.0.0.1") && !url.includes("localhost"))).toHaveLength(0);
        (0, vitest_1.expect)(maintain.currentSnapshot().recipesForPendingAsk).toEqual([]);
    });
    (0, vitest_1.it)("serves the same snapshot over IPC when the card asks for it", async () => {
        const handler = electron.calls.ipcHandlers.get("maintain:getSnapshot");
        const overIpc = await handler({});
        (0, vitest_1.expect)(overIpc.pendingAsk.appSlug).toBe("ollama");
    });
});
(0, vitest_1.describe)("answering the card", () => {
    (0, vitest_1.it)("says honestly that there is no fix yet, instead of inventing one", async () => {
        const handler = electron.calls.ipcHandlers.get("maintain:answerAsk");
        const after = await handler({}, "somethingIsBroken");
        (0, vitest_1.expect)(after.pendingAsk).toBeNull();
        (0, vitest_1.expect)(String(after.fixStatusLine)).toContain("No known fix yet");
    });
    (0, vitest_1.it)("puts the card away once the reader clears the status", async () => {
        const clear = electron.calls.ipcHandlers.get("maintain:clearFixStatus");
        await clear({});
        await settle();
        (0, vitest_1.expect)(maintainWindow().isVisible()).toBe(false);
    });
});
(0, vitest_1.describe)("not asking twice", () => {
    (0, vitest_1.it)("does not nag when the same app breaks again the same day", async () => {
        // Ollama was already asked about above. A second failure is real, but a
        // second card within 24 hours is nagging, so it is swallowed.
        maintain.reportLaunchFailure(aLaunchFailure({ reason: "exited with code 9" }));
        await settle();
        (0, vitest_1.expect)(maintain.currentSnapshot().pendingAsk).toBeNull();
    });
    (0, vitest_1.it)("stays quiet about a break the reader said was their own doing", async () => {
        maintain.reportLaunchFailure(aLaunchFailure({ appSlug: "vscode", appName: "VS Code", appStack: "electron" }));
        await settle();
        (0, vitest_1.expect)(maintain.currentSnapshot().pendingAsk.appSlug).toBe("vscode");
        maintain.answerAsk("thatWasMe");
        (0, vitest_1.expect)(maintain.currentSnapshot().pendingAsk).toBeNull();
    });
    (0, vitest_1.it)("remembers an app the reader muted, and can unmute it again", async () => {
        maintain.reportLaunchFailure(aLaunchFailure({ appSlug: "obsidian", appName: "Obsidian", appStack: "electron" }));
        await settle();
        (0, vitest_1.expect)(maintain.currentSnapshot().pendingAsk.appSlug).toBe("obsidian");
        maintain.answerAsk("neverAskAboutThisApp");
        (0, vitest_1.expect)(maintain.mutedApps()).toContain("obsidian");
        (0, vitest_1.expect)(maintain.currentSnapshot().pendingAsk).toBeNull();
        // Muting survives a new incident: nothing is raised, ever, for this app.
        maintain.reportLaunchFailure(aLaunchFailure({ appSlug: "obsidian", appName: "Obsidian", appStack: "electron", reason: "ENOENT" }));
        await settle();
        (0, vitest_1.expect)(maintain.currentSnapshot().pendingAsk).toBeNull();
        // And unmuting is a real undo, reachable from the card's own IPC channel.
        const unmute = electron.calls.ipcHandlers.get("maintain:unmuteApp");
        await unmute({}, "obsidian");
        (0, vitest_1.expect)(maintain.mutedApps()).not.toContain("obsidian");
    });
    (0, vitest_1.it)("keeps the mute list across a restart of the subsystem", () => {
        // The gate state lives on disk, not in memory: a reader who muted an app
        // last week must not be asked about it again after a reboot.
        maintain.reportLaunchFailure(aLaunchFailure({ appSlug: "godot", appName: "Godot", appStack: "other" }));
        maintain.answerAsk("neverAskAboutThisApp");
        (0, vitest_1.expect)(maintain.mutedApps()).toContain("godot");
        const reloaded = (0, integration_1.mount)({ startDetection: false }).raw().maintain();
        (0, vitest_1.expect)(reloaded.mutedApps()).toContain("godot");
        reloaded.unmuteApp("godot");
    });
});
(0, vitest_1.describe)("stopping", () => {
    (0, vitest_1.it)("stops the watchers, leaving nothing ticking behind it", () => {
        // A leaked interval here would hold the whole test process open; the fact
        // that this file exits is half the assertion.
        (0, vitest_1.expect)(() => maintain.stopDetection()).not.toThrow();
        (0, vitest_1.expect)(() => maintain.stopDetection()).not.toThrow();
    });
});
