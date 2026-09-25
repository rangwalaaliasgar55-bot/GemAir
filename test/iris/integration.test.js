"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_module_1 = require("node:module");
const node_path_1 = require("node:path");
const vitest_1 = require("./vitest-shim");
/**
 * The mount, end to end, on a fake Electron.
 *
 * Everything else in this directory tests `lib/iris/services/*` — pure modules
 * that never needed Electron. This file covers the half that did: the tray
 * fragment, the windows, the deep-link funnel, the IPC surface and the one call
 * GemAir's own `main.js` makes (`integration.mount()`), driven against
 * `fixtures/fake-electron.js`. Before this, that path was only ever checked
 * statically, and the interesting failure — a subsystem that throws on mount and
 * takes the host down with it — is precisely the one static checks cannot see.
 *
 * No network: `fetch` is replaced per test, and the loopback probe is answered
 * the way a machine with no `opencode serve` really answers it, by refusing the
 * connection.
 */
const FAKE_ELECTRON_PATH = require.resolve("./fixtures/fake-electron.js");
// `require("electron")` inside lib/iris resolves to the fake for this process.
const originalResolveFilename = node_module_1.Module._resolveFilename;
node_module_1.Module._resolveFilename = function resolveWithFakeElectron(request, ...rest) {
    if (request === "electron")
        return FAKE_ELECTRON_PATH;
    return originalResolveFilename.call(this, request, ...rest);
};
const electron = require(FAKE_ELECTRON_PATH);
const integration_1 = require("../../lib/iris/integration");
const opencode_models_1 = require("../../lib/iris/services/opencode-models");
/** A fetch that records every call, refuses loopback (no local `opencode serve`
 *  is running), and answers anything else with one assistant turn. */
function stubbedFetch(replyText = "Open Settings, then Network.") {
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init });
        if (String(url).includes("127.0.0.1") || String(url).includes("localhost")) {
            throw new Error("connect ECONNREFUSED");
        }
        const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: replyText } }] });
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => body,
            json: async () => JSON.parse(body),
        };
    };
    return requests;
}
/** The live window showing a given renderer, e.g. `guide` or `chat`. */
function windowShowing(rendererFolder) {
    return electron.BrowserWindow.getAllWindows().find((window) => typeof window.loadedFile === "string"
        && (0, node_path_1.basename)((0, node_path_1.dirname)(window.loadedFile)) === rendererFolder);
}
/** The renderer folder a loaded file lives in — `chat`, `guide`, `settings`… */
function loadedRendererFolders() {
    return electron.calls.loaded
        .filter((load) => typeof load.file === "string")
        .map((load) => (0, node_path_1.basename)((0, node_path_1.dirname)(load.file)));
}
const trayChanges = [];
const routeChanges = [];
let assist;
(0, vitest_1.beforeAll)(() => {
    stubbedFetch();
    assist = (0, integration_1.mount)({
        onTrayChanged: (items) => trayChanges.push(items),
        onRouteChanged: (route) => routeChanges.push(route),
        // The watchers are opt-in in GemAir; a suite must not start timers.
        startDetection: false,
    });
});
(0, vitest_1.afterAll)(() => {
    assist?.stop?.();
    node_module_1.Module._resolveFilename = originalResolveFilename;
});
(0, vitest_1.describe)("mounting Assist", () => {
    (0, vitest_1.it)("comes up available, with no reason to report", () => {
        (0, vitest_1.expect)(assist.available).toBe(true);
        (0, vitest_1.expect)(assist.reason).toBeNull();
    });
    (0, vitest_1.it)("opens no windows and starts no watchers by mounting alone", () => {
        // A tray app that throws four windows on screen at launch is a tray app
        // nobody keeps installed.
        (0, vitest_1.expect)(electron.BrowserWindow.getAllWindows().filter((window) => window.isVisible())).toHaveLength(0);
    });
    (0, vitest_1.it)("registers the gemair:// scheme so a link can reach the app at all", () => {
        (0, vitest_1.expect)(electron.calls.protocolsRegistered.map((entry) => entry.scheme)).toContain("gemair");
    });
    (0, vitest_1.it)("exposes exactly the host API GemAir's main.js calls", () => {
        for (const method of [
            "openChat", "openGuide", "openGuideFor", "openSettings", "openAutopilot",
            "receiveDeepLinksFromArgv", "receiveDeepLink", "menuItems", "trayTooltip",
            "ask", "route", "refreshRoute", "guides", "showInstalledNotice", "stop", "raw",
        ]) {
            (0, vitest_1.expect)(typeof assist[method]).toBe("function");
        }
    });
    (0, vitest_1.it)("registers its IPC handlers on the main process", () => {
        const channels = [...electron.calls.ipcHandlers.keys()];
        (0, vitest_1.expect)(channels).toContain("chat:query");
        (0, vitest_1.expect)(channels).toContain("gemair:invoke");
        // And nothing registered twice under a different name.
        (0, vitest_1.expect)(new Set(channels).size).toBe(channels.length);
    });
});
(0, vitest_1.describe)("what the tray shows", () => {
    (0, vitest_1.it)("offers the three everyday entries, and no 'your turn' when nothing is waiting", () => {
        const labels = assist.menuItems().map((item) => item.label);
        (0, vitest_1.expect)(labels.slice(0, 3)).toEqual(["Ask GemAir Assist", "Install guides", "Assist settings"]);
        (0, vitest_1.expect)(labels.some((label) => label.includes("Your turn"))).toBe(false);
        (0, vitest_1.expect)(assist.trayTooltip()).toBeNull();
    });
    (0, vitest_1.it)("names the route it is answering on once the probe has settled", () => {
        // Which free model is answering is the one thing a reader cannot infer
        // from anywhere else, so the tray says it.
        const labels = assist.menuItems().map((item) => item.label);
        (0, vitest_1.expect)(labels.some((label) => label.startsWith("Answering via"))).toBe(true);
        (0, vitest_1.expect)(trayChanges.length).toBeGreaterThan(0);
    });
});
(0, vitest_1.describe)("the guides it ships", () => {
    (0, vitest_1.it)("lists the bundled guides, each one summarised well enough to render", () => {
        const guides = assist.guides();
        (0, vitest_1.expect)(guides.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(guides.map((guide) => guide.slug)).toContain("excalidraw");
        for (const guide of guides) {
            (0, vitest_1.expect)(typeof guide.appName).toBe("string");
            (0, vitest_1.expect)(guide.appName.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(typeof guide.summary).toBe("string");
            (0, vitest_1.expect)(typeof guide.outputType).toBe("string");
        }
    });
    (0, vitest_1.it)("works offline — listing guides made no network call", () => {
        const requests = stubbedFetch();
        assist.guides();
        (0, vitest_1.expect)(requests).toHaveLength(0);
    });
});
(0, vitest_1.describe)("which route answers", () => {
    (0, vitest_1.it)("reports a free route with a free model on a machine with nothing installed", async () => {
        stubbedFetch();
        const route = await assist.refreshRoute();
        (0, vitest_1.expect)(route).toBeDefined();
        (0, vitest_1.expect)(route.free).toBe(true);
        (0, vitest_1.expect)((0, opencode_models_1.isFreeModelId)(route.model)).toBe(true);
        (0, vitest_1.expect)(route.cliAvailable).toBe(false);
        (0, vitest_1.expect)(route.localServer).toBeNull();
        (0, vitest_1.expect)(assist.route()).toEqual(route);
    });
    (0, vitest_1.it)("tells the host when the route changed, so the tray can say so", () => {
        (0, vitest_1.expect)(routeChanges.length).toBeGreaterThan(0);
        (0, vitest_1.expect)((0, opencode_models_1.isFreeModelId)(routeChanges.at(-1).model)).toBe(true);
    });
});
(0, vitest_1.describe)("asking a question", () => {
    (0, vitest_1.it)("answers from the free Zen route, in the assistant's own words", async () => {
        const requests = stubbedFetch("Open Settings, then Network, then Wi-Fi.");
        const reply = await assist.ask("how do i turn wifi on?");
        (0, vitest_1.expect)(String(reply)).toContain("Wi-Fi");
        const chat = requests.find((request) => request.url.includes("/chat/completions"));
        (0, vitest_1.expect)(chat).toBeDefined();
        (0, vitest_1.expect)(new URL(chat.url).hostname).toBe("opencode.ai");
        (0, vitest_1.expect)(chat.init.headers.Authorization).toBe(`Bearer ${opencode_models_1.OPENCODE_PUBLIC_TOKEN}`);
    });
    (0, vitest_1.it)("only ever asks for a free model", async () => {
        const requests = stubbedFetch();
        await assist.ask("what is my battery level?");
        const chat = requests.find((request) => request.url.includes("/chat/completions"));
        (0, vitest_1.expect)((0, opencode_models_1.isFreeModelId)(JSON.parse(chat.init.body).model)).toBe(true);
    });
    (0, vitest_1.it)("answers through the chat:query IPC channel the chat window uses", async () => {
        stubbedFetch("Two ways to do that.");
        const handler = electron.calls.ipcHandlers.get("chat:query");
        (0, vitest_1.expect)(String(await handler({}, "how do i install ollama?"))).toContain("Two ways");
    });
    (0, vitest_1.it)("turns a refused request into something a person can act on, not a stack trace", async () => {
        globalThis.fetch = async () => {
            throw new Error("getaddrinfo ENOTFOUND opencode.ai");
        };
        let message;
        try {
            await assist.ask("anything");
        }
        catch (error) {
            message = String(error && error.message ? error.message : error);
        }
        (0, vitest_1.expect)(message).toBeDefined();
        (0, vitest_1.expect)(message).not.toContain("at Object.");
        (0, vitest_1.expect)(message.length).toBeGreaterThan(0);
    });
});
(0, vitest_1.describe)("opening its windows", () => {
    (0, vitest_1.it)("opens the chat window on the renderer that belongs to it", () => {
        electron.reset();
        assist.openChat();
        (0, vitest_1.expect)(loadedRendererFolders()).toContain("chat");
    });
    (0, vitest_1.it)("opens settings and the guide list on theirs", () => {
        electron.reset();
        assist.openSettings();
        (0, vitest_1.expect)(loadedRendererFolders()).toContain("settings");
        electron.reset();
        assist.openGuide();
        (0, vitest_1.expect)(loadedRendererFolders()).toContain("guide");
    });
    (0, vitest_1.it)("opens the autopilot on a slug it ships a recipe for", () => {
        electron.reset();
        assist.openAutopilot("ollama");
        (0, vitest_1.expect)(loadedRendererFolders()).toContain("autopilot");
    });
    (0, vitest_1.it)("reuses the window it already has instead of stacking a second one", () => {
        electron.reset();
        assist.openChat();
        const opened = electron.calls.windows.length;
        assist.openChat();
        (0, vitest_1.expect)(electron.calls.windows.length).toBe(opened);
    });
});
(0, vitest_1.describe)("deep links", () => {
    /** Every message broadcast to the windows since the last reset. */
    function broadcasts() {
        return electron.BrowserWindow.getAllWindows().flatMap((window) => window.webContents.sentMessages);
    }
    (0, vitest_1.it)("opens the guide a good link names, and tells the window which one", () => {
        electron.reset();
        assist.receiveDeepLink("gemair://guide/excalidraw?version=2");
        (0, vitest_1.expect)(windowShowing("guide")?.isVisible()).toBe(true);
        // The channel names must match the ones `lib/iris/preload.js` listens on —
        // they did not, once, and a deep link reached no window at all.
        const opened = broadcasts().find((message) => message.channel === "gemair-guide-opened");
        (0, vitest_1.expect)(opened).toBeDefined();
        (0, vitest_1.expect)(opened.args[0].slug).toBe("excalidraw");
        (0, vitest_1.expect)(opened.args[0].version).toBe(2);
    });
    (0, vitest_1.it)("rejects a link carrying a query it does not understand, and opens nothing", () => {
        electron.reset();
        assist.receiveDeepLink("gemair://guide/excalidraw?utm_source=somewhere");
        (0, vitest_1.expect)(electron.calls.windows).toHaveLength(0);
        (0, vitest_1.expect)(broadcasts().some((message) => message.channel === "gemair-deep-link-rejected")).toBe(true);
    });
    (0, vitest_1.it)("rejects a link with no version, because a guide without one cannot be pinned", () => {
        electron.reset();
        assist.receiveDeepLink("gemair://guide/excalidraw");
        const rejection = broadcasts().find((message) => message.channel === "gemair-deep-link-rejected");
        (0, vitest_1.expect)(rejection).toBeDefined();
        (0, vitest_1.expect)(String(rejection.args[0])).toContain("version");
    });
    (0, vitest_1.it)("rejects an auth callback, because GemAir has no sign-in to complete", () => {
        electron.reset();
        assist.receiveDeepLink("gemair://auth/callback?code=abc");
        (0, vitest_1.expect)(broadcasts().some((message) => message.channel === "gemair-deep-link-rejected")).toBe(true);
    });
    (0, vitest_1.it)("takes the link out of an argv, which is where Windows puts it", () => {
        electron.reset();
        assist.receiveDeepLinksFromArgv(["gemair.exe", "--hidden", "gemair://guide/ollama?version=1"]);
        (0, vitest_1.expect)(broadcasts().some((message) => message.channel === "gemair-guide-opened")).toBe(true);
    });
    (0, vitest_1.it)("finds a link sitting in the argv that launched the app", () => {
        (0, vitest_1.expect)((0, integration_1.argvCarriesDeepLink)(["gemair.exe", "gemair://guide/ollama"])).toBe(true);
        (0, vitest_1.expect)((0, integration_1.argvCarriesDeepLink)(["gemair.exe", "--hidden"])).toBe(false);
        (0, vitest_1.expect)((0, integration_1.argvCarriesDeepLink)([])).toBe(false);
    });
    (0, vitest_1.it)("survives junk without throwing into the host", () => {
        for (const link of ["", "not a url", "https://example.com", "gemair://", "gemair://nope/x"]) {
            (0, vitest_1.expect)(() => assist.receiveDeepLink(link)).not.toThrow();
        }
    });
});
(0, vitest_1.describe)("the stub it returns when it cannot start", () => {
    (0, vitest_1.it)("answers every host call without throwing, so GemAir carries on without Assist", async () => {
        const stub = integration_1.NOT_MOUNTED;
        (0, vitest_1.expect)(stub.available).toBe(false);
        (0, vitest_1.expect)(stub.menuItems()).toEqual([]);
        (0, vitest_1.expect)(stub.trayTooltip()).toBeNull();
        (0, vitest_1.expect)(stub.guides()).toEqual([]);
        (0, vitest_1.expect)(stub.route()).toBeNull();
        (0, vitest_1.expect)(() => stub.openChat()).not.toThrow();
        (0, vitest_1.expect)(() => stub.receiveDeepLink("gemair://guide/x")).not.toThrow();
        (0, vitest_1.expect)(await stub.refreshRoute()).toBeNull();
        // `ask` is the one call that must REPORT rather than answer nothing.
        await (0, vitest_1.expect)(stub.ask("hello")).rejects.toThrow();
    });
    (0, vitest_1.it)("is frozen, so a host cannot accidentally make the fallback stateful", () => {
        (0, vitest_1.expect)(Object.isFrozen(integration_1.NOT_MOUNTED)).toBe(true);
    });
});
(0, vitest_1.describe)("stopping", () => {
    (0, vitest_1.it)("destroys every window it owns", () => {
        assist.openChat();
        assist.openSettings();
        (0, vitest_1.expect)(electron.BrowserWindow.getAllWindows().length).toBeGreaterThan(0);
        assist.stop();
        (0, vitest_1.expect)(electron.BrowserWindow.getAllWindows()).toHaveLength(0);
        // Re-mounted for anything that runs after this file's teardown.
        assist = (0, integration_1.mount)({ startDetection: false });
        (0, vitest_1.expect)(assist.available).toBe(true);
    });
});
