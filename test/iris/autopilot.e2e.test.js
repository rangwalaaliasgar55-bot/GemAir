"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const runner_1 = require("../../lib/iris/services/autopilot/runner");
const powershell_session_1 = require("../../lib/iris/main/powershell-session");
/**
 * The one test that drives the *real* PowerShell session end to end — the
 * developer's Mac cannot run it, so it is guarded to Windows and runs on the
 * windows-latest CI runner (the "VM"). It exercises what a unit test with a mock
 * shell cannot: that commands actually run, that a non-zero exit is seen, and
 * crucially that `cd` in one step carries to the next (the recipe writes a file
 * in a folder an earlier step changed into and reads it back).
 *
 * Deterministic and offline: only git, node, and PowerShell built-ins, all
 * present on the runner. No network, no dev server, no browser — those belong in
 * a heavier smoke, not this correctness check.
 */
const E2E_RECIPE = {
    slug: "e2e",
    appName: "Autopilot E2E",
    output: { type: "none" },
    steps: [
        { id: "git", title: "Git is present", kind: "command", command: "git --version" },
        { id: "node", title: "Node is present", kind: "command", command: "node --version" },
        { id: "scratch", title: "Go to a scratch folder", kind: "command", command: "Set-Location -LiteralPath $env:TEMP" },
        {
            id: "make",
            title: "Make a working directory",
            kind: "command",
            command: "New-Item -ItemType Directory -Force -Path gemair-autopilot-e2e | Out-Null",
        },
        { id: "enter", title: "Enter it", kind: "command", command: "cd gemair-autopilot-e2e" },
        {
            id: "write",
            title: "Write a file here",
            kind: "command",
            command: "Set-Content -LiteralPath hello.txt -Value 'installed by gemair'",
        },
        // This only succeeds if the working directory carried across the last three
        // steps — the whole point of a persistent shell.
        { id: "read", title: "Read it back", kind: "command", command: "Get-Content -LiteralPath hello.txt" },
    ],
};
(0, vitest_1.describe)("autopilot end-to-end on real PowerShell", () => {
    vitest_1.it.runIf(process.platform === "win32")("drives a whole recipe to completion with a persistent working directory", async () => {
        const shell = new powershell_session_1.PowerShellSession();
        const runner = new runner_1.AutopilotRunner(E2E_RECIPE);
        try {
            const status = await runner.runUntilBlocked(shell);
            (0, vitest_1.expect)(status.type).toBe("finished");
            // The read step's output proves the file written two steps earlier in a
            // directory changed into three steps earlier was found — cwd persisted.
            const events = runner.drainEvents();
            const readOutput = events
                .filter((event) => event.type === "commandFinished")
                .map((event) => (event.type === "commandFinished" ? event.output : ""))
                .join("\n");
            (0, vitest_1.expect)(readOutput).toContain("installed by gemair");
        }
        finally {
            shell.dispose();
        }
    }, 120_000);
    (0, vitest_1.it)("keeps the file non-empty off Windows so vitest never flags 'no tests'", () => {
        (0, vitest_1.expect)(typeof process.platform).toBe("string");
    });
});
