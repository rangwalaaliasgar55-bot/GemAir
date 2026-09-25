"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const shell_1 = require("../../lib/iris/services/autopilot/shell");
const guide_recipe_1 = require("../../lib/iris/services/autopilot/guide-recipe");
/**
 * The macOS incident these mirror: chat ran `npm run dev`, the process was
 * killed at the deadline, and the reader was told "i stopped the command after
 * 2 minutes since dev servers run forever, but it's still serving." It was not.
 *
 * Windows already had the long-running lane — `runLongRunning` starts a server
 * detached, surfaces an immediate exit as a failure to start, and kills the
 * tree on abort and dispose — so the gap here was narrower than on macOS: a
 * server that resolved and then died later had nothing that would ever notice,
 * because the only evidence anyone held was the URL it printed at startup.
 * `longRunningStillAlive` is that missing re-ask, and these pin the property it
 * exists for: STARTED is not RUNNING.
 */
const approved = { text: "npm.cmd run dev" };
(0, vitest_1.describe)("a command that never exits is recognised as one", () => {
    (0, vitest_1.it)("catches the exact command from the incident, and its .cmd spelling", () => {
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("npm run dev")).toBe(true);
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("npm.cmd run dev")).toBe(true);
    });
    (0, vitest_1.it)("catches the other ways a reader runs an app from source", () => {
        for (const command of [
            "pnpm dev",
            "yarn start",
            "bun run serve",
            "next dev",
            "vite",
            "rails server",
            "cargo run",
            "python3 -m http.server",
        ]) {
            (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)(command), command).toBe(true);
        }
    });
    (0, vitest_1.it)("does not mistake an ordinary command for a server", () => {
        for (const command of ["npm.cmd install", "git status", "npm run build", "cargo build"]) {
            (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)(command), command).toBe(false);
        }
    });
});
(0, vitest_1.describe)("started is not running", () => {
    (0, vitest_1.it)("reports a server that died after it started as not alive", async () => {
        const shell = new shell_1.MockShell();
        const outcome = await shell.runLongRunning(approved, undefined, 0);
        // It started — this is the state the old code stopped at, and the state
        // the reader was told about two minutes after it had stopped being true.
        (0, vitest_1.expect)(outcome.kind).toBe("succeeded");
        // And it is gone now. The whole point: the successful start above is not
        // evidence about this, and only re-asking gets the right answer.
        (0, vitest_1.expect)(shell.longRunningStillAlive()).toBe(false);
    });
    (0, vitest_1.it)("reports a server that is genuinely still up as alive", async () => {
        const shell = new shell_1.MockShell();
        shell.longRunningIsAlive = true;
        await shell.runLongRunning(approved, undefined, 0);
        (0, vitest_1.expect)(shell.longRunningStillAlive()).toBe(true);
    });
});
(0, vitest_1.describe)("the served URL is read, never guessed", () => {
    (0, vitest_1.it)("takes the real port out of the server's own output", () => {
        // The macOS model invented localhost:4173 before running anything, then
        // relayed 5174 from a process it had killed. Windows reads the port out of
        // what the server actually printed, which is the behaviour to keep.
        (0, vitest_1.expect)((0, shell_1.detectServedUrl)("  ➜  Local:   http://localhost:5174/")).toBe("http://localhost:5174");
        (0, vitest_1.expect)((0, shell_1.detectServedUrl)("Listening on http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    });
    (0, vitest_1.it)("returns nothing rather than a guess when no port was printed", () => {
        (0, vitest_1.expect)((0, shell_1.detectServedUrl)("compiling...")).toBeUndefined();
        (0, vitest_1.expect)((0, shell_1.detectServedUrl)("")).toBeUndefined();
    });
});
