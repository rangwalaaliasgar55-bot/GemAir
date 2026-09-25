"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const tool_versions_1 = require("../../lib/iris/services/tool-versions");
/**
 * A guide is server-served content: it changes without a client release, and no
 * reviewer of this binary saw it. So the set of programs a guide can cause GemAir
 * to execute has to be fixed here, in the client, and nothing in the command may
 * come from guide text.
 */
(0, vitest_1.describe)("only allowlisted tools can ever be run", () => {
    vitest_1.it.each(["git", "node", "npm", "pnpm", "bun", "python", "python3", "uv", "cargo", "rustc", "docker", "java", "adb"])("allows the known tool %s", (tool) => {
        (0, vitest_1.expect)((0, tool_versions_1.isAllowlistedTool)(tool)).toBe(true);
        (0, vitest_1.expect)((0, tool_versions_1.toolSpecFor)(tool)).not.toBeNull();
    });
    vitest_1.it.each([
        "cmd",
        "powershell",
        "rm",
        "curl",
        "git; rm -rf /",
        "git --version && calc",
        "../../../windows/system32/cmd.exe",
        "",
        "NODE",
    ])("refuses %s", (tool) => {
        (0, vitest_1.expect)((0, tool_versions_1.isAllowlistedTool)(tool)).toBe(false);
        (0, vitest_1.expect)((0, tool_versions_1.toolSpecFor)(tool)).toBeNull();
    });
    (0, vitest_1.it)("builds arguments from a constant, never from the caller", () => {
        // The spec is a fixed pair. There is no place for guide-supplied text to
        // enter the argument list.
        const spec = (0, tool_versions_1.toolSpecFor)("git");
        (0, vitest_1.expect)(spec).toEqual(["git", ["--version"]]);
        (0, vitest_1.expect)((0, tool_versions_1.toolSpecFor)("adb")).toEqual(["adb", ["version"]]);
    });
});
(0, vitest_1.describe)("command output is bounded", () => {
    (0, vitest_1.it)("takes the first line only", () => {
        (0, vitest_1.expect)((0, tool_versions_1.boundedCommandOutput)("git version 2.43.0\nextra noise\nmore", "")).toBe("git version 2.43.0");
    });
    (0, vitest_1.it)("handles Windows line endings", () => {
        (0, vitest_1.expect)((0, tool_versions_1.boundedCommandOutput)("v22.11.0\r\n", "")).toBe("v22.11.0");
    });
    (0, vitest_1.it)("falls back to stderr, which is where some tools print their version", () => {
        (0, vitest_1.expect)((0, tool_versions_1.boundedCommandOutput)("", "openjdk version \"21\"")).toBe('openjdk version "21"');
    });
    (0, vitest_1.it)("truncates a program that will not stop talking", () => {
        (0, vitest_1.expect)((0, tool_versions_1.boundedCommandOutput)("x".repeat(10_000), "").length).toBeLessThanOrEqual(200);
    });
    (0, vitest_1.it)("returns an empty string when there is nothing at all", () => {
        (0, vitest_1.expect)((0, tool_versions_1.boundedCommandOutput)("", "")).toBe("");
    });
});
