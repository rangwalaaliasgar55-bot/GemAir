"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_module_1 = require("node:module");
const vitest_1 = require("./vitest-shim");
/**
 * The eye, end to end: capture -> model -> POINT -> refinement -> overlay.
 *
 * This is the feature GemAir Assist exists for — being SHOWN where to click, not
 * told — and it is the one that spans the most seams: `main/screenshot.js`,
 * `services/coordinates.js`, `services/model-chat.js`, `main/companion.js` and
 * the overlay windows. `coordinates.test.js` already proves the arithmetic of
 * the three spaces (NATIVE -> IMAGE, capped at 1568 -> DISPLAY); what it cannot
 * prove is that the pipeline is wired up in that order with those units, which
 * is exactly the class of bug that produces a glow on the wrong monitor.
 *
 * Two displays are configured before the mount so the multi-monitor routing is
 * covered: the second display starts at x=1920, so a point that lands on it must
 * come back with an x beyond 1920 and must be sent to the SECOND overlay window.
 */
const FAKE_ELECTRON_PATH = require.resolve("./fixtures/fake-electron.js");
const originalResolveFilename = node_module_1.Module._resolveFilename;
node_module_1.Module._resolveFilename = function resolveWithFakeElectron(request, ...rest) {
    if (request === "electron")
        return FAKE_ELECTRON_PATH;
    return originalResolveFilename.call(this, request, ...rest);
};
const electron = require(FAKE_ELECTRON_PATH);
// Two 1920x1080 monitors side by side, the right-hand one at 2x scale, so the
// NATIVE -> IMAGE downscale is not a no-op on it.
electron.screen.displays = [electron.aDisplay(1, 0), electron.aDisplay(2, 1920, 1920, 1080, 2)];
electron.desktopCapturer.sources = [
    { id: "screen:0", display_id: "1", name: "Screen 1", thumbnail: electron.createImage(1920, 1080) },
    { id: "screen:1", display_id: "2", name: "Screen 2", thumbnail: electron.createImage(3840, 2160) },
];
const integration_1 = require("../../lib/iris/integration");
const coordinates_1 = require("../../lib/iris/services/coordinates");
/** Every model request this test's fetch saw, newest last. */
let requests = [];
/**
 * A fetch that hands back queued replies in order. Loopback is refused, as on a
 * machine with no `opencode serve`, so the free Zen route is what answers.
 */
function respondWith(...replies) {
    requests = [];
    const queue = [...replies];
    globalThis.fetch = async (url, init = {}) => {
        const address = String(url);
        if (address.includes("127.0.0.1") || address.includes("localhost")) {
            throw new Error("connect ECONNREFUSED");
        }
        const request = { url: address, init, body: init.body ? JSON.parse(init.body) : null };
        requests.push(request);
        const content = queue.length > 1 ? queue.shift() : (queue[0] ?? "");
        const body = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
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
/** The chat (not catalogue) requests, in order. */
function chatRequests() {
    return requests.filter((request) => request.url.includes("/chat/completions"));
}
/** Every image attached to a request, as the model would receive it. */
function imagesIn(request) {
    const images = [];
    for (const message of request.body?.messages ?? []) {
        if (!Array.isArray(message.content))
            continue;
        for (const part of message.content) {
            if (part?.type === "image_url" && part.image_url?.url)
                images.push(String(part.image_url.url));
        }
    }
    return images;
}
/** What the overlay for a given display was last told to draw. */
function overlayPoints(displayIndex) {
    const overlays = electron.BrowserWindow.getAllWindows()
        .filter((window) => typeof window.loadedFile === "string" && window.loadedFile.includes("/overlay/"));
    const messages = (overlays[displayIndex]?.webContents.sentMessages ?? [])
        .filter((message) => message.channel === "overlay:point");
    return messages.at(-1)?.args[0] ?? [];
}
let assist;
(0, vitest_1.beforeAll)(() => {
    respondWith("");
    assist = (0, integration_1.mount)({ startDetection: false });
});
(0, vitest_1.afterAll)(() => {
    assist?.stop?.();
    node_module_1.Module._resolveFilename = originalResolveFilename;
});
(0, vitest_1.describe)("what the model is shown", () => {
    (0, vitest_1.it)("sends one image per monitor, downscaled to the model's limit", async () => {
        respondWith("Nothing to point at.");
        await assist.ask("what is on my screens?");
        const images = imagesIn(chatRequests()[0]);
        (0, vitest_1.expect)(images).toHaveLength(2);
        // `jpeg:WxH` survives the base64 round trip the fake image does, so the
        // size the model was actually shown is readable here.
        const sizes = images.map((image) => {
            const decoded = Buffer.from(image.split(",")[1] ?? "", "base64").toString("utf8");
            const match = /(\d+)x(\d+)/.exec(decoded);
            return { width: Number(match[1]), height: Number(match[2]) };
        });
        for (const size of sizes) {
            (0, vitest_1.expect)(Math.max(size.width, size.height)).toBeLessThanOrEqual(coordinates_1.MAX_MODEL_IMAGE_EDGE);
        }
        // The 1920-wide monitor is capped on its long edge...
        (0, vitest_1.expect)(sizes[0]).toEqual({ width: 1568, height: 882 });
        // ...and the 2x monitor is captured at 3840 native and capped to the same.
        (0, vitest_1.expect)(sizes[1]).toEqual({ width: 1568, height: 882 });
    });
    (0, vitest_1.it)("captures fresh for every question rather than reusing the first shot", async () => {
        respondWith("Fine.");
        await assist.ask("and now?");
        (0, vitest_1.expect)(imagesIn(chatRequests()[0])).toHaveLength(2);
    });
});
(0, vitest_1.describe)("pointing at something", () => {
    (0, vitest_1.it)("refines the first-pass point with a second, closer look", async () => {
        // Pass 1 points into the left monitor's image space; pass 2 answers about
        // the crop it is then shown.
        respondWith("Click here. [POINT:784,441:Settings button:screen0]", "[POINT:100,100:Settings button:screen0]");
        await assist.ask("where do i click to open settings?");
        const chats = chatRequests();
        (0, vitest_1.expect)(chats.length).toBeGreaterThanOrEqual(2);
        // The refinement pass is shown exactly one image, and it is a crop —
        // smaller than the full downscaled screen it came from.
        const refinementImages = imagesIn(chats[1]);
        (0, vitest_1.expect)(refinementImages).toHaveLength(1);
        const decoded = Buffer.from(refinementImages[0].split(",")[1] ?? "", "base64").toString("utf8");
        const cropSize = /(\d+)x(\d+)/.exec(decoded);
        (0, vitest_1.expect)(Number(cropSize[1])).toBeLessThan(1568);
    });
    (0, vitest_1.it)("hands the overlay a point in DISPLAY space, inside that monitor", async () => {
        respondWith("There. [POINT:784,441:Settings button:screen0]", "[POINT:100,100:Settings button:screen0]");
        await assist.ask("where do i click?");
        const points = overlayPoints(0);
        (0, vitest_1.expect)(points).toHaveLength(1);
        (0, vitest_1.expect)(points[0].label).toBe("Settings button");
        // Display 0 is 1920x1080 at the origin; a point in its image space must
        // come back scaled up into it, not left in image space.
        (0, vitest_1.expect)(points[0].x).toBeGreaterThan(0);
        (0, vitest_1.expect)(points[0].x).toBeLessThan(1920);
        (0, vitest_1.expect)(points[0].y).toBeGreaterThan(0);
        (0, vitest_1.expect)(points[0].y).toBeLessThan(1080);
    });
    (0, vitest_1.it)("routes a point on the second monitor to the second monitor's overlay", async () => {
        respondWith("Over there. [POINT:784,441:Install button:screen1]", "[POINT:100,100:Install button:screen1]");
        await assist.ask("where is the install button?");
        const points = overlayPoints(1);
        (0, vitest_1.expect)(points).toHaveLength(1);
        (0, vitest_1.expect)(points[0].label).toBe("Install button");
        // Coordinates are relative to the overlay WINDOW, not to the desktop:
        // each overlay already covers its own monitor, so the right-hand
        // monitor's point stays in 0..1919 and is placed by which window it was
        // sent to. Adding display.bounds.x here would push the glow off screen.
        (0, vitest_1.expect)(points[0].x).toBeGreaterThanOrEqual(0);
        (0, vitest_1.expect)(points[0].x).toBeLessThan(1920);
        // ...and the first monitor's overlay was NOT told to draw it.
        (0, vitest_1.expect)(overlayPoints(0).some((point) => point.label === "Install button")).toBe(false);
    });
    (0, vitest_1.it)("keeps the point when the second pass fails, rather than losing it", async () => {
        let call = 0;
        globalThis.fetch = async (url, init = {}) => {
            const address = String(url);
            if (address.includes("127.0.0.1") || address.includes("localhost"))
                throw new Error("connect ECONNREFUSED");
            call += 1;
            if (call > 1)
                throw new Error("the refinement call fell over");
            const body = JSON.stringify({
                choices: [{ message: { role: "assistant", content: "Here. [POINT:784,441:Save:screen0]" } }],
            });
            return { ok: true, status: 200, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
        };
        await assist.ask("where do i save?");
        const points = overlayPoints(0);
        (0, vitest_1.expect)(points.at(-1).label).toBe("Save");
        (0, vitest_1.expect)(points.at(-1).x).toBeLessThan(1920);
    });
    (0, vitest_1.it)("shows the reader prose, never the raw tag", async () => {
        respondWith("Click the blue Save button. [POINT:784,441:Save:screen0]", "[POINT:100,100:Save:screen0]");
        const reply = String(await assist.ask("where do i save?"));
        (0, vitest_1.expect)(reply).toBe("Click the blue Save button.");
        (0, vitest_1.expect)(reply).not.toContain("POINT");
    });
    (0, vitest_1.it)("draws nothing when the model points at no screen at all", async () => {
        respondWith("I can't see that window — is it minimised?");
        const before = overlayPoints(0);
        const reply = String(await assist.ask("where is my mail app?"));
        (0, vitest_1.expect)(reply).toContain("minimised");
        (0, vitest_1.expect)(overlayPoints(0)).toEqual(before);
    });
});
(0, vitest_1.describe)("the overlays themselves", () => {
    (0, vitest_1.it)("makes one click-through window per monitor, covering it exactly", () => {
        const overlays = electron.BrowserWindow.getAllWindows()
            .filter((window) => typeof window.loadedFile === "string" && window.loadedFile.includes("/overlay/"));
        (0, vitest_1.expect)(overlays).toHaveLength(electron.screen.displays.length);
        for (const [index, overlay] of overlays.entries()) {
            const bounds = electron.screen.displays[index].bounds;
            (0, vitest_1.expect)(overlay.options.width).toBe(bounds.width);
            (0, vitest_1.expect)(overlay.options.height).toBe(bounds.height);
            (0, vitest_1.expect)(overlay.options.x).toBe(bounds.x);
            // A full-screen window that stole clicks would make the desktop
            // unusable, so these must be frameless, transparent and see-through.
            (0, vitest_1.expect)(overlay.options.transparent).toBe(true);
            (0, vitest_1.expect)(overlay.options.frame).toBe(false);
            (0, vitest_1.expect)(overlay.options.focusable).toBe(false);
        }
    });
});
