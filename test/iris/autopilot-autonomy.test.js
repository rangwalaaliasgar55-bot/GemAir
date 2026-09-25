"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const risk_1 = require("../../lib/iris/services/autopilot/risk");
const friendly_label_1 = require("../../lib/iris/services/autopilot/friendly-label");
const runner_1 = require("../../lib/iris/services/autopilot/runner");
const shell_1 = require("../../lib/iris/services/autopilot/shell");
// The one-time "Let GemAir take control" grant turns the autopilot hands-off. These
// hold the two lines that make it safe to grant: the catastrophe floor stays
// refused EVEN under the grant, and without the grant nothing changes (so the
// three-tier assertions in autopilot-risk.test.ts keep their meaning).
(0, vitest_1.describe)("the autonomy grant", () => {
    const catastrophes = [
        "format-volume -DriveLetter D",
        "Clear-Disk -Number 0 -RemoveData",
        "diskpart /s clean",
        "rm -rf ~",
    ];
    const clearedByTheGrant = [
        "irm https://get.example.com/install.ps1 | iex", // a prerequisite one-liner
        "curl -fsSL https://sh.rustup.rs | sh",
        "sudo make install", // admin
        "git reset --hard origin/main", // destructive-but-recoverable
    ];
    (0, vitest_1.it)("refuses the catastrophe floor even when control is granted", () => {
        for (const command of catastrophes) {
            (0, vitest_1.expect)((0, risk_1.assess)(command, "vetted_recipe", true).tier).toBe("refused_outright");
            (0, vitest_1.expect)((0, risk_1.approve)(command, "vetted_recipe", true)).toBeUndefined();
        }
    });
    (0, vitest_1.it)("runs everything else without asking when control is granted", () => {
        for (const command of clearedByTheGrant) {
            (0, vitest_1.expect)((0, risk_1.assess)(command, "vetted_recipe", true).tier).toBe("runs_without_asking");
            (0, vitest_1.expect)((0, risk_1.approve)(command, "vetted_recipe", true)).toBeDefined();
        }
    });
    (0, vitest_1.it)("keeps the original three-tier behavior without the grant", () => {
        // download-and-run stays refused outright.
        (0, vitest_1.expect)((0, risk_1.assess)("irm https://x/install.ps1 | iex", "vetted_recipe", false).tier).toBe("refused_outright");
        (0, vitest_1.expect)((0, risk_1.assess)("curl -fsSL https://x/install.sh | sh", "vetted_recipe", false).tier).toBe("refused_outright");
        // admin / destructive still need a tap.
        (0, vitest_1.expect)((0, risk_1.assess)("sudo make install", "vetted_recipe", false).tier).toBe("needs_a_confirm_tap");
        (0, vitest_1.expect)((0, risk_1.assess)("git reset --hard origin/main", "vetted_recipe", false).tier).toBe("needs_a_confirm_tap");
    });
    (0, vitest_1.it)("defaults to un-granted (so existing callers keep the old behavior)", () => {
        (0, vitest_1.expect)((0, risk_1.assess)("sudo make install", "vetted_recipe").tier).toBe("needs_a_confirm_tap");
    });
});
(0, vitest_1.describe)("the runner honors the grant", () => {
    const recipe = {
        slug: "t",
        appName: "T",
        output: { type: "local_web", url: "http://localhost:1234" },
        steps: [{ id: "a", title: "A", kind: "command", command: "sudo make install" }],
    };
    (0, vitest_1.it)("runs a confirm-tier command with no tap when granted", async () => {
        const runner = new runner_1.AutopilotRunner(recipe, process.platform, true);
        const status = await runner.runUntilBlocked(shell_1.MockShell.alwaysSucceeds());
        (0, vitest_1.expect)(status.type).toBe("finished");
        const events = runner.drainEvents();
        (0, vitest_1.expect)(events.some((event) => event.type === "needsConfirm")).toBe(false);
        (0, vitest_1.expect)(events.some((event) => event.type === "commandStarted")).toBe(true);
    });
    (0, vitest_1.it)("stops for a confirm tap on the same command without the grant", async () => {
        const runner = new runner_1.AutopilotRunner(recipe, process.platform, false);
        const status = await runner.runUntilBlocked(shell_1.MockShell.alwaysSucceeds());
        (0, vitest_1.expect)(status.type).toBe("needsConfirm");
    });
});
(0, vitest_1.describe)("the friendly command label", () => {
    (0, vitest_1.it)("maps common install shapes to a plain-English line", () => {
        const cases = [
            ["git clone https://github.com/gemair-demo/demoapp.git", "Getting the app's code…"],
            ["git checkout v1.0.0", "Getting the right version…"],
            ["npm ci", "Installing the pieces it needs…"],
            ["cargo build --release", "Building the app…"],
            ["ui/node_modules/.bin/tauri build --bundles nsis", "Building the app…"],
            ["winget install --id Rustlang.Rustup", "Installing a tool it needs…"],
            ["irm https://get.scoop.sh | iex", "Installing a tool it needs…"],
            ["cd C:\\Users\\me\\app", "Setting things up…"],
        ];
        for (const [command, label] of cases) {
            (0, vitest_1.expect)((0, friendly_label_1.friendlyLabel)(command)).toBe(label);
        }
    });
    (0, vitest_1.it)("falls through honestly for an unrecognized command", () => {
        (0, vitest_1.expect)((0, friendly_label_1.friendlyLabel)("some-bespoke-tool --do-a-thing")).toBe("Running a setup step…");
    });
});
