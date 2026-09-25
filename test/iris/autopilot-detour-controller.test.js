"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const autopilot_controller_1 = require("../../lib/iris/main/autopilot-controller");
const shell_1 = require("../../lib/iris/services/autopilot/shell");
const setup_detour_1 = require("../../lib/iris/services/autopilot/setup-detour");
/**
 * The controller wiring for the setup-recovery detour: with the detour seams
 * present, `start` walks the detour before the recipe, and an `openRequested`
 * from the detour reaches `openExternal` the same way a recipe's open step does.
 */
class RecordingHost {
    events = [];
    opened = [];
    finishedInstall;
    aborted = false;
    async ensureAutonomyGranted() {
        return true;
    }
    emitEvent(event) {
        this.events.push(event);
    }
    openExternal(url) {
        this.opened.push(url);
    }
    floatToGate() { }
    onFinished(finishedInstall) {
        this.finishedInstall = finishedInstall;
    }
    onAborted() {
        this.aborted = true;
    }
}
class FakeToolProbe {
    answers;
    wingetPresent;
    constructor(answers, wingetPresent = true) {
        this.answers = answers;
        this.wingetPresent = wingetPresent;
    }
    async probe(tool) {
        const sequence = this.answers[tool] ?? [false];
        const answer = sequence.length > 1 ? sequence.shift() : sequence[0];
        return answer ? "installed" : "notInstalled";
    }
    async isWingetAvailable() {
        return this.wingetPresent;
    }
}
class FakeClock {
    t = 0;
    now() {
        return this.t;
    }
    async sleep(ms) {
        this.t += ms;
    }
}
const recipe = {
    slug: "demo",
    appName: "Demo",
    output: { type: "local_web", url: "http://localhost:5173" },
    steps: [
        { id: "check-git", title: "Check Git", kind: "command", command: "git --version", check: { type: "tool_version", tool: "git" } },
        { id: "check-node", title: "Check Node", kind: "command", command: "node --version", check: { type: "tool_version", tool: "node" } },
        { id: "clone", title: "Clone", kind: "command", command: "git clone https://example.com/x.git" },
    ],
};
function controllerWith(probe) {
    const host = new RecordingHost();
    const shell = shell_1.MockShell.alwaysSucceeds();
    const controller = new autopilot_controller_1.AutopilotController(host, () => shell, (slug) => (slug === recipe.slug ? recipe : undefined), 
    // No fix ladder in the detour tests; the detour seams are the 5th arg.
    () => undefined, { probe, clock: new FakeClock() });
    return { controller, host, shell };
}
(0, vitest_1.describe)("the controller's setup detour", () => {
    (0, vitest_1.it)("installs a missing prerequisite with winget, then runs the recipe to the end", async () => {
        const { controller, host, shell } = controllerWith(new FakeToolProbe({ git: [false, true], node: [true] }, true));
        const status = await controller.start("demo");
        (0, vitest_1.expect)(status.type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toContain((0, setup_detour_1.wingetInstallCommand)("Git.Git"));
        (0, vitest_1.expect)(shell.commandsRun).toContain("git clone https://example.com/x.git");
        (0, vitest_1.expect)(host.events.some((e) => e.type === "setupDetour")).toBe(true);
        (0, vitest_1.expect)(host.opened).not.toContain("https://git-scm.com/download/win"); // winget worked, no page
    });
    (0, vitest_1.it)("opens the download page through openExternal when winget is absent", async () => {
        const { controller, host } = controllerWith(new FakeToolProbe({ git: [false, true], node: [true] }, false));
        const status = await controller.start("demo");
        (0, vitest_1.expect)(status.type).toBe("finished");
        // The detour's openRequested reached openExternal via the shared forwarder.
        (0, vitest_1.expect)(host.opened).toContain("https://git-scm.com/download/win");
    });
    (0, vitest_1.it)("surfaces (and never starts the recipe) when a prerequisite never appears", async () => {
        const { controller, host, shell } = controllerWith(new FakeToolProbe({ git: [false], node: [true] }, false));
        const status = await controller.start("demo");
        (0, vitest_1.expect)(status.type).toBe("surfaced");
        // The recipe's own steps never ran — the detour stopped first.
        (0, vitest_1.expect)(shell.commandsRun).not.toContain("git clone https://example.com/x.git");
        (0, vitest_1.expect)(host.events.some((e) => e.type === "surfaced")).toBe(true);
    });
    (0, vitest_1.it)("the red 'Stop' during the detour ends the run without starting the recipe or crashing", async () => {
        const host = new RecordingHost();
        const shell = shell_1.MockShell.alwaysSucceeds();
        const holder = {};
        // git never appears and winget is absent, so the detour opens the page and
        // polls; the reader hits Stop while it is mid-wait.
        const probe = new FakeToolProbe({ git: [false], node: [true] }, false);
        const clock = {
            now: () => 0, // never reaches the deadline on its own
            sleep: async () => {
                holder.controller.abort();
            },
        };
        const controller = new autopilot_controller_1.AutopilotController(host, () => shell, (slug) => (slug === recipe.slug ? recipe : undefined), () => undefined, { probe, clock });
        holder.controller = controller;
        const status = await controller.start("demo");
        // Aborted cleanly — the old code resumed past the detour and called
        // runUntilBlocked on a shell abort() had already disposed to undefined.
        (0, vitest_1.expect)(status.type).toBe("aborted");
        (0, vitest_1.expect)(shell.commandsRun).not.toContain("git clone https://example.com/x.git");
        // The window was folded away via onAborted.
        (0, vitest_1.expect)(host.aborted).toBe(true);
    });
});
