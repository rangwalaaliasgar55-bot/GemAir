"use strict";
//
// The shell the autopilot runs approved commands in.
//
// `ShellSession` is the seam: the runner is written against this interface, so it
// is driven by a `MockShell` in the vitest suite and by a real persistent
// PowerShell (src/main/powershell-session.ts) at runtime. A session is
// *persistent* — working directory and environment carry from one step to the
// next — because an install is a sequence (`git clone`, then `cd repo`, then
// `pnpm install`) that falls apart if each step starts fresh.
//
// This module is pure (no `child_process`), so it stays in `services/` and runs
// in the suite on any host. The real handle lives in `main/`.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockShell = exports.LONG_RUNNING_GRACE_MS = exports.DEFAULT_COMMAND_TIMEOUT_MS = void 0;
exports.succeeded = succeeded;
exports.detectServedUrl = detectServedUrl;
/// The default per-command ceiling (ms). A real install command can be slow
/// (a large `winget install`, a `pnpm install`), so this is generous; it exists
/// to stop a hung command wedging the autopilot, not to hurry anything.
exports.DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
/// How long to wait for a dev server to announce itself before treating it as
/// started (ms). Generous: a first `pnpm dev` compiles before it serves.
exports.LONG_RUNNING_GRACE_MS = 90 * 1000;
function succeeded(outcome) {
    return outcome.kind === "succeeded";
}
/// Pulls the first localhost URL a dev server prints out of its output (Vite's
/// "Local: http://localhost:5174/"), so the install opens the app that is really
/// there rather than whatever was squatting on the default port.
function detectServedUrl(output) {
    const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i);
    return match ? match[0] : undefined;
}
/// A scripted shell for the suite: returns queued outcomes in order and records
/// every command it was asked to run.
class MockShell {
    outcomes;
    cwd;
    commandsRun = [];
    next = 0;
    constructor(outcomes = [], cwd = "C:\\Users\\test") {
        this.outcomes = outcomes;
        this.cwd = cwd;
    }
    /// A shell where every command succeeds.
    static alwaysSucceeds() {
        return new MockShell();
    }
    async run(command, _deadlineMs) {
        this.commandsRun.push(command.text);
        const outcome = this.outcomes[this.next] ?? { kind: "succeeded", output: "" };
        this.next += 1;
        return outcome;
    }
    async runLongRunning(command, _readyMarker, _graceMs) {
        // A started server counts as run; tests assert on `commandsRun`.
        return this.run(command, exports.DEFAULT_COMMAND_TIMEOUT_MS);
    }
    /// Scripted: the suite sets this to model a server that died after it
    /// started, which is the case the real implementations exist to catch.
    longRunningIsAlive = false;
    longRunningStillAlive() {
        return this.longRunningIsAlive;
    }
    currentDirectory() {
        return this.cwd;
    }
    /// Records that the escape hatch fired, so a test can assert the shell was
    /// told to kill the running process tree.
    aborted = false;
    abort() {
        this.aborted = true;
    }
    dispose() {
        // Nothing to tear down.
    }
}
exports.MockShell = MockShell;
