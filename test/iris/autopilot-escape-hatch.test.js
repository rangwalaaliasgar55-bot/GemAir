"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const autopilot_controller_1 = require("../../lib/iris/main/autopilot-controller");
const runner_1 = require("../../lib/iris/services/autopilot/runner");
const shell_1 = require("../../lib/iris/services/autopilot/shell");
/**
 * The red 'Stop' escape hatch — the Windows port of macOS `Test6EscapeHatchTests`.
 * The two properties that make the button trustworthy: closing is UNCONDITIONAL
 * (never a dead button, even when the run has already stopped), and an abort ends
 * the run for good — the running command's process tree is killed and NO further
 * step runs.
 */
function commandStep(id, command) {
    return { id, title: `Run ${id}`, kind: "command", command };
}
function recipe(steps) {
    return {
        slug: "demo",
        appName: "Demo",
        output: { type: "local_web", url: "http://localhost:1234" },
        steps,
    };
}
/// A shell whose `run` blocks until the test releases it, so an abort can land
/// while a command is genuinely in flight (a `MockShell` finishes instantly).
class GatedShell {
    commandsRun = [];
    aborted = false;
    cwd = "C:\\Users\\test\\app";
    release = null;
    async run(command, _deadlineMs) {
        this.commandsRun.push(command.text);
        await new Promise((resolve) => {
            this.release = resolve;
        });
        // Whatever a killed process would report — this is discarded once aborted.
        return { kind: "succeeded", output: "" };
    }
    async runLongRunning(command) {
        return this.run(command, 0);
    }
    /// Lets the currently-blocked `run` resolve.
    releaseCurrent() {
        const release = this.release;
        this.release = null;
        release?.();
    }
    longRunningStillAlive() {
        return false;
    }
    currentDirectory() {
        return this.cwd;
    }
    abort() {
        this.aborted = true;
    }
    dispose() {
        // Nothing to tear down.
    }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
(0, vitest_1.describe)("the runner's escape hatch", () => {
    (0, vitest_1.it)("runs no step at all when aborted before it starts", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("a", "npm ci")]), "win32", true);
        const shell = shell_1.MockShell.alwaysSucceeds();
        const status = runner.abort();
        (0, vitest_1.expect)(status.type).toBe("aborted");
        const afterward = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(afterward.type).toBe("aborted");
        (0, vitest_1.expect)(shell.commandsRun).toEqual([]);
    });
    (0, vitest_1.it)("ends a running install mid-command and runs no further step", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("a", "npm ci"), commandStep("b", "cargo build --release")]), "win32", true);
        const shell = new GatedShell();
        // Start pumping. The first command reaches the shell synchronously and then
        // blocks in `run`, so the runner is now sitting inside step A.
        const pumping = runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["npm ci"]);
        // The reader hits 'Stop' while A is running.
        runner.abort();
        // The killed command's outcome comes back…
        shell.releaseCurrent();
        const status = await pumping;
        (0, vitest_1.expect)(status.type).toBe("aborted");
        // …and B never ran.
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["npm ci"]);
        const events = runner.drainEvents();
        (0, vitest_1.expect)(events.some((event) => event.type === "aborted")).toBe(true);
    });
    (0, vitest_1.it)("stays aborted when the reader tries to resume", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([{ id: "s", title: "Sign in", kind: "sign_in" }, commandStep("b", "npm ci")]), "win32", true);
        const shell = shell_1.MockShell.alwaysSucceeds();
        await runner.runUntilBlocked(shell); // stops at the sign-in for the reader
        runner.abort();
        (0, vitest_1.expect)((await runner.readerFinishedCurrentStep(shell)).type).toBe("aborted");
        (0, vitest_1.expect)((await runner.confirmCurrentCommand(true, shell)).type).toBe("aborted");
        (0, vitest_1.expect)(shell.commandsRun).toEqual([]); // nothing ran after the abort
    });
    (0, vitest_1.it)("is idempotent — a second abort changes nothing", () => {
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("a", "npm ci")]), "win32", true);
        runner.abort();
        runner.drainEvents();
        const status = runner.abort();
        (0, vitest_1.expect)(status.type).toBe("aborted");
        // No second `aborted` event on the repeat.
        (0, vitest_1.expect)(runner.drainEvents().some((event) => event.type === "aborted")).toBe(false);
    });
});
class RecordingHost {
    events = [];
    aborts = 0;
    autonomyAnswer = true;
    async ensureAutonomyGranted() {
        return this.autonomyAnswer;
    }
    emitEvent(event) {
        this.events.push(event);
    }
    openExternal() { }
    floatToGate() { }
    onFinished(_finishedInstall) { }
    onAborted() {
        this.aborts += 1;
    }
}
(0, vitest_1.describe)("the controller's escape hatch", () => {
    (0, vitest_1.it)("folds the window away even when nothing is running (the dead-button fix)", () => {
        const host = new RecordingHost();
        const controller = new autopilot_controller_1.AutopilotController(host, () => shell_1.MockShell.alwaysSucceeds());
        // No install has started — the old bug returned early and closed nothing.
        const status = controller.abort();
        (0, vitest_1.expect)(status.type).toBe("aborted");
        (0, vitest_1.expect)(host.aborts).toBe(1);
    });
    (0, vitest_1.it)("kills the shell, ends the run, and folds the window away mid-install", async () => {
        const host = new RecordingHost();
        const shell = new GatedShell();
        const installRecipe = recipe([commandStep("a", "npm ci"), commandStep("b", "cargo build --release")]);
        const controller = new autopilot_controller_1.AutopilotController(host, () => shell, (slug) => slug === installRecipe.slug ? installRecipe : undefined);
        const running = controller.start("demo");
        await tick(); // let consent resolve and command A reach the (gated) shell
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["npm ci"]);
        const aborted = controller.abort();
        (0, vitest_1.expect)(aborted.type).toBe("aborted");
        (0, vitest_1.expect)(shell.aborted).toBe(true); // the process tree was told to die
        (0, vitest_1.expect)(host.aborts).toBe(1);
        (0, vitest_1.expect)(host.events.some((event) => event.type === "aborted")).toBe(true);
        shell.releaseCurrent();
        const finalStatus = await running;
        (0, vitest_1.expect)(finalStatus.type).toBe("aborted");
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["npm ci"]); // B never ran
    });
});
