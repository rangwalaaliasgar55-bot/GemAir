"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const posix_shell_session_1 = require("../../lib/iris/main/posix-shell-session");
const powershell_session_1 = require("../../lib/iris/main/powershell-session");
const shell_1 = require("../../lib/iris/services/autopilot/shell");
/**
 * The POSIX shell spawns zsh and only does real work on a Mac, but its command
 * wrapping is pure — and it emits the same marker lines the PowerShell session
 * does, so `parseRun` reads a Mac run exactly like a Windows one. Pinned here.
 */
(0, vitest_1.describe)("POSIX command wrapping", () => {
    (0, vitest_1.it)("pins the location, runs the command, and appends both markers", () => {
        const script = (0, posix_shell_session_1.wrapPosixCommand)("git status", "/Users/me/repo");
        (0, vitest_1.expect)(script).toContain("cd '/Users/me/repo'");
        (0, vitest_1.expect)(script).toContain("git status");
        (0, vitest_1.expect)(script).toContain("__IRIS_CODE__:");
        (0, vitest_1.expect)(script).toContain("__IRIS_CWD__:");
    });
    (0, vitest_1.it)("single-quotes the directory so a space or apostrophe cannot break out", () => {
        (0, vitest_1.expect)((0, posix_shell_session_1.wrapPosixCommand)("ls", "/Users/me/my apps")).toContain("cd '/Users/me/my apps'");
    });
    (0, vitest_1.it)("produces marker output the shared parser reads the same as Windows", () => {
        // Simulate what the wrapped script prints to stdout on a Mac.
        const stdout = ["Cloning into 'OpenASCII'...", "__IRIS_CWD__:/Users/me/gemair-apps", "__IRIS_CODE__:0"].join("\n");
        const parsed = (0, powershell_session_1.parseRun)(stdout, "");
        (0, vitest_1.expect)(parsed.exitCode).toBe(0);
        (0, vitest_1.expect)(parsed.cwd).toBe("/Users/me/gemair-apps");
        (0, vitest_1.expect)(parsed.output).toBe("Cloning into 'OpenASCII'...");
    });
});
(0, vitest_1.describe)("detecting the served URL a dev server actually came up on", () => {
    (0, vitest_1.it)("reads the port out of Vite's output, even when it moved off the default", () => {
        const viteOutput = "  VITE v5  ready\n  ➜  Local:   http://localhost:5174/\n  ➜  press h to show help";
        (0, vitest_1.expect)((0, shell_1.detectServedUrl)(viteOutput)).toBe("http://localhost:5174");
    });
    (0, vitest_1.it)("returns undefined when nothing announced a local URL", () => {
        (0, vitest_1.expect)((0, shell_1.detectServedUrl)("Compiling...\nDone.")).toBeUndefined();
    });
});
