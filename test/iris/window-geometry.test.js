"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const vitest_1 = require("./vitest-shim");
const window_geometry_1 = require("../../lib/iris/services/window-geometry");
/**
 * "I can't resize the menu settings and it show up the 2 big default scroller
 * vertical and horizontal" — a paying subscriber, 2026-09-24. Two halves:
 * the windows must be resizable (geometry, below), and the pages inside them
 * must never need a horizontal scrollbar and must not fall back to Windows'
 * default one for the vertical (CSS, further below).
 *
 * jsdom does no layout, so the CSS half pins the rules that produce the
 * behaviour rather than measuring it; the headed GUI e2e suite measures the
 * real settings window at its narrowest width on windows-latest.
 */
(0, vitest_1.describe)("the Settings and first-run window sizes", () => {
    vitest_1.it.each([
        ["settings", window_geometry_1.SETTINGS_WINDOW_GEOMETRY],
        ["first-run", window_geometry_1.FIRST_RUN_WINDOW_GEOMETRY],
    ])("the %s window can be resized, and opens at least as big as its minimum", (_name, geometry) => {
        (0, vitest_1.expect)(geometry.resizable).toBe(true);
        (0, vitest_1.expect)(geometry.width).toBeGreaterThanOrEqual(geometry.minWidth);
        (0, vitest_1.expect)(geometry.height).toBeGreaterThanOrEqual(geometry.minHeight);
    });
    vitest_1.it.each([
        ["settings", window_geometry_1.SETTINGS_WINDOW_GEOMETRY],
        ["first-run", window_geometry_1.FIRST_RUN_WINDOW_GEOMETRY],
    ])("the %s window cannot shrink past the width its layout is checked at", (_name, geometry) => {
        (0, vitest_1.expect)(geometry.minWidth).toBe(window_geometry_1.NARROWEST_FORM_WINDOW_WIDTH);
    });
    (0, vitest_1.it)("opens both windows small enough for a 1366x768 laptop", () => {
        for (const geometry of [window_geometry_1.SETTINGS_WINDOW_GEOMETRY, window_geometry_1.FIRST_RUN_WINDOW_GEOMETRY]) {
            (0, vitest_1.expect)(geometry.width).toBeLessThanOrEqual(1366);
            // 768 minus the taskbar leaves roughly 720.
            (0, vitest_1.expect)(geometry.height).toBeLessThanOrEqual(720);
        }
    });
});
const RENDERER_DIR = (0, node_path_1.join)(__dirname, "..", "..", "renderer", "iris");
function stylesOf(page) {
    const html = (0, node_fs_1.readFileSync)((0, node_path_1.join)(RENDERER_DIR, page, "index.html"), "utf-8");
    return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("\n");
}
/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(styles, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = styles.match(new RegExp(`(^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "m"));
    return match?.[2] ?? "";
}
(0, vitest_1.describe)("the scrollbars inside GemAir's own windows", () => {
    vitest_1.it.each(["settings", "first-run", "chat"])("the %s window styles its scrollbar instead of using Windows' default", (page) => {
        const styles = stylesOf(page);
        (0, vitest_1.expect)(ruleBody(styles, "::-webkit-scrollbar")).toMatch(/width:\s*\d+px/);
        (0, vitest_1.expect)(ruleBody(styles, "::-webkit-scrollbar-thumb")).toMatch(/background/);
    });
    vitest_1.it.each(["settings", "first-run", "chat"])("the %s window does not set scrollbar-width or scrollbar-color, which would switch that styling off", (page) => {
        // Chromium 121+ ignores every ::-webkit-scrollbar rule on an element
        // whose scrollbar-width or scrollbar-color is set, and falls back to the
        // native scrollbar — the very one this replaced.
        (0, vitest_1.expect)(stylesOf(page)).not.toMatch(/scrollbar-(width|color)\s*:/);
    });
    vitest_1.it.each(["settings", "first-run"])("the %s window never scrolls sideways", (page) => {
        const body = ruleBody(stylesOf(page), "body");
        (0, vitest_1.expect)(body).toMatch(/overflow-x:\s*hidden/);
        (0, vitest_1.expect)(body).toMatch(/overflow-y:\s*auto/);
        // Long unbroken text — an email address, a key placeholder — may break
        // rather than push the page wider than the window.
        (0, vitest_1.expect)(body).toMatch(/overflow-wrap:\s*anywhere/);
    });
    vitest_1.it.each(["settings", "first-run"])("the %s window's rows of buttons wrap onto a new line instead of overflowing", (page) => {
        (0, vitest_1.expect)(ruleBody(stylesOf(page), ".row")).toMatch(/flex-wrap:\s*wrap/);
    });
});
