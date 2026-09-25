"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const runner_1 = require("../../lib/iris/services/autopilot/runner");
const shell_1 = require("../../lib/iris/services/autopilot/shell");
/**
 * The no-click state machine. Command and open steps advance themselves; only a
 * sign-in / permission / manual step stops for the reader, and a failed command
 * surfaces rather than pretending to recover.
 */
function commandStep(id, command) {
    return { id, title: `Run ${id}`, kind: "command", command };
}
function recipe(steps) {
    return {
        slug: "demo",
        appName: "Demo",
        output: { type: "desktop_app", launch: { via: "shell", command: 'start "" Demo' } },
        steps,
    };
}
(0, vitest_1.describe)("the autopilot runner", () => {
    (0, vitest_1.it)("runs a clean recipe to the end and reports what to open", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("clone", "git clone https://example.com/x.git"), commandStep("build", "npm ci")]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        const status = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(status.type).toBe("finished");
        if (status.type === "finished") {
            (0, vitest_1.expect)(status.output.type).toBe("desktop_app");
        }
        (0, vitest_1.expect)(shell.commandsRun).toHaveLength(2);
        (0, vitest_1.expect)(runner.drainEvents().at(-1)?.type).toBe("finished");
    });
    (0, vitest_1.it)("advances an open step with no tap", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([
            { id: "docs", title: "Open the docs", kind: "open", href: "https://example.com" },
            commandStep("build", "npm ci"),
        ]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        const status = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(status.type).toBe("finished");
        const events = runner.drainEvents();
        (0, vitest_1.expect)(events.some((event) => event.type === "openRequested")).toBe(true);
        (0, vitest_1.expect)(events.some((event) => event.type === "handedToReader")).toBe(false);
    });
    (0, vitest_1.it)("runs a paste step's file-opening command, then still hands the step to the reader", async () => {
        // Reported bug: a paste step's command exists only to open the file the
        // reader is about to edit (chatmany-mann's real guide: `notepad
        // wrangler.toml`) — it must run, but running it must not make the step
        // auto-complete the way a real `command` step does.
        const runner = new runner_1.AutopilotRunner(recipe([
            {
                id: "set-db-id",
                title: "Put the database id in the config",
                kind: "paste",
                instruction: "In wrangler.toml, replace the placeholder with your database_id.",
                command: "notepad wrangler.toml",
            },
        ]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        const status = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(status.type).toBe("needsReader");
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["notepad wrangler.toml"]);
        const events = runner.drainEvents();
        (0, vitest_1.expect)(events.some((event) => event.type === "commandStarted")).toBe(true);
        (0, vitest_1.expect)(events.some((event) => event.type === "commandFinished")).toBe(true);
        (0, vitest_1.expect)(events.some((event) => event.type === "handedToReader")).toBe(true);
    });
    (0, vitest_1.it)("still hands a paste step to the reader even when its opening command fails", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([
            {
                id: "set-db-id",
                title: "Put the database id in the config",
                kind: "paste",
                instruction: "In wrangler.toml, replace the placeholder with your database_id.",
                command: "notepad wrangler.toml",
            },
        ]));
        const shell = new shell_1.MockShell([{ kind: "failed", exitCode: 1, output: "notepad could not be found" }]);
        const status = await runner.runUntilBlocked(shell);
        // A failed courtesy-open is not a failed step — no self-heal, no fix
        // ladder, just the ordinary reader handoff the step always gets.
        (0, vitest_1.expect)(status.type).toBe("needsReader");
        const events = runner.drainEvents();
        (0, vitest_1.expect)(events.some((event) => event.type === "needsConfirm")).toBe(false);
        (0, vitest_1.expect)(events.some((event) => event.type === "handedToReader")).toBe(true);
    });
    (0, vitest_1.it)("never runs a paste step's command when the guide gave it none", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([
            {
                id: "sign-up",
                title: "Create an account",
                kind: "paste",
                instruction: "Copy your API key from the dashboard.",
            },
        ]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        const status = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(status.type).toBe("needsReader");
        (0, vitest_1.expect)(shell.commandsRun).toHaveLength(0);
    });
    (0, vitest_1.it)("stops for the reader at a sign-in, then resumes on its own", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([
            commandStep("clone", "git clone https://example.com/x.git"),
            {
                id: "sign-in",
                title: "Sign in",
                kind: "sign_in",
                href: "https://example.com/login",
                instruction: "Sign in and come back.",
            },
            commandStep("finish", "npm run setup"),
        ]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        const blocked = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(blocked.type).toBe("needsReader");
        if (blocked.type === "needsReader") {
            (0, vitest_1.expect)(blocked.stepIndex).toBe(1);
            (0, vitest_1.expect)(blocked.instruction).toBe("Sign in and come back.");
            (0, vitest_1.expect)(blocked.href).toBe("https://example.com/login");
        }
        const resumed = await runner.readerFinishedCurrentStep(shell);
        (0, vitest_1.expect)(resumed.type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["git clone https://example.com/x.git", "npm run setup"]);
    });
    (0, vitest_1.it)("surfaces a failing command rather than pretending", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("build", "npm ci")]));
        const failing = { kind: "failed", exitCode: 1, output: "npm ERR!" };
        const shell = new shell_1.MockShell([failing]);
        const status = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(status.type).toBe("surfaced");
    });
    (0, vitest_1.it)("waits at a confirm-tier command, then runs it on approval", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("elevate", "Set-ExecutionPolicy Bypass -Scope Process")]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        const blocked = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(blocked.type).toBe("needsConfirm");
        (0, vitest_1.expect)(shell.commandsRun).toHaveLength(0);
        const approved = await runner.confirmCurrentCommand(true, shell);
        (0, vitest_1.expect)(approved.type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toHaveLength(1);
    });
    (0, vitest_1.it)("surfaces and never runs a declined confirm command", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("elevate", "Start-Process powershell -Verb RunAs")]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        (0, vitest_1.expect)((await runner.runUntilBlocked(shell)).type).toBe("needsConfirm");
        (0, vitest_1.expect)((await runner.confirmCurrentCommand(false, shell)).type).toBe("surfaced");
        (0, vitest_1.expect)(shell.commandsRun).toHaveLength(0);
    });
    (0, vitest_1.it)("starts a long-running dev server instead of hanging on it", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([{ id: "run", title: "Start server", kind: "command", command: "pnpm dev", longRunning: true, readyWhen: "localhost" }]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        const status = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(status.type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["pnpm dev"]);
    });
    // Parity with the macOS runner's `moveInto` — the resume bug, which is the
    // same bug on both clients: a resumed install starts a brand-new shell in the
    // home folder, so a step written relative to an earlier `cd` runs in the
    // wrong place and fails with a 127 nobody can read.
    //
    // The platform is PINNED in both directions, and that is the point of the
    // second case. This test used to construct the runner with the default
    // platform — `process.platform`, i.e. darwin on the machine this is written
    // on — and still assert a `Set-Location`. `MockShell` answers "succeeded" to
    // any string, so it passed while the real zsh session the runner drives on a
    // Mac would have answered `command not found: Set-Location`, exit 127, and
    // surfaced every declared step. The test was measuring that the runner emits
    // a string, not that the string is a command the shell speaks.
    (0, vitest_1.it)("moves into the folder a step declares before running its command", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([
            { ...commandStep("build", "pnpm build"), workingDirectory: "~/demoapp/app" },
        ]), "win32");
        const shell = shell_1.MockShell.alwaysSucceeds();
        (0, vitest_1.expect)((await runner.runUntilBlocked(shell)).type).toBe("finished");
        // A SEPARATE Set-Location whose outcome is checked, never a `;` chain:
        // PowerShell's `;` does not abort on a failed Set-Location.
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["Set-Location ~/demoapp/app", "pnpm build"]);
    });
    (0, vitest_1.it)("uses a folder move the shell it is actually driving understands", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([
            {
                ...commandStep("build", "pnpm build"),
                workingDirectory: "~/demoapp/app",
                posixWorkingDirectory: "~/gemair-apps/demoapp/app",
            },
        ]), "darwin");
        const shell = shell_1.MockShell.alwaysSucceeds();
        (0, vitest_1.expect)((await runner.runUntilBlocked(shell)).type).toBe("finished");
        // `cd`, not `Set-Location` — and the posix folder, because the two
        // platforms' clone steps do not land in the same place.
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["cd ~/gemair-apps/demoapp/app", "pnpm build"]);
    });
    (0, vitest_1.it)("treats an empty declared folder as no declaration at all", async () => {
        // The guide renderers fill the field in with "" when a step omits it, and a
        // `cd` with no argument goes home — which is the bug, not the fix.
        const runner = new runner_1.AutopilotRunner(recipe([{ ...commandStep("build", "npm ci"), workingDirectory: "" }]), "win32");
        const shell = shell_1.MockShell.alwaysSucceeds();
        (0, vitest_1.expect)((await runner.runUntilBlocked(shell)).type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["npm ci"]);
    });
    (0, vitest_1.it)("leaves a step that declares no folder exactly where the shell already is", async () => {
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("build", "npm ci")]));
        const shell = shell_1.MockShell.alwaysSucceeds();
        (0, vitest_1.expect)((await runner.runUntilBlocked(shell)).type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["npm ci"]);
    });
    (0, vitest_1.it)("stops the step rather than running the command in the wrong folder", async () => {
        const failedMove = { kind: "failed", exitCode: 1, output: "Cannot find path" };
        const runner = new runner_1.AutopilotRunner(recipe([
            { ...commandStep("build", "pnpm build"), workingDirectory: "~/demoapp/app" },
        ]), "win32");
        const shell = new shell_1.MockShell([failedMove]);
        const status = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(status.type).toBe("surfaced");
        if (status.type === "surfaced") {
            (0, vitest_1.expect)(status.reason).toContain("~/demoapp/app");
        }
        // The command itself was never typed — that is the whole point.
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["Set-Location ~/demoapp/app"]);
    });
    (0, vitest_1.it)("refuses a declared folder that is not a plain path", () => {
        for (const folder of ["~/cue; rm -rf ~", "~/cue/../../etc", "$HOME/cue", '"~/cue"', "cue", ""]) {
            (0, vitest_1.expect)((0, runner_1.isAPlainFolder)(folder), folder).toBe(false);
        }
        for (const folder of ["~/cue", "~/demoapp/app", "/opt/src", "C:\\Users\\me\\cue"]) {
            (0, vitest_1.expect)((0, runner_1.isAPlainFolder)(folder), folder).toBe(true);
        }
    });
    (0, vitest_1.it)("judges an undeclared-folder step against the shell's real current directory", async () => {
        // A destructive command with NO declared folder, run while the shell is
        // sitting in a system folder (an earlier step or a fix left it there). Without
        // the cwd fallback the gate would see no folder and, under the grant, run it;
        // with the fallback the working-directory floor stays live for every command,
        // not only the steps that name a folder, so this is refused. (Finding: the
        // per-step gate only saw a folder when the STEP declared one.)
        const runner = new runner_1.AutopilotRunner(recipe([commandStep("tidy", "Remove-Item -Recurse -Force .")]), "win32", true);
        const shell = new shell_1.MockShell([], "C:\\Windows");
        const status = await runner.runUntilBlocked(shell);
        (0, vitest_1.expect)(status.type).toBe("surfaced");
        // The destructive command was never run — the floor caught it on the folder.
        (0, vitest_1.expect)(shell.commandsRun).toEqual([]);
    });
});
