"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const autopilot_controller_1 = require("../../lib/iris/main/autopilot-controller");
const shell_1 = require("../../lib/iris/services/autopilot/shell");
/**
 * The controller is the seam between the pure runner and Electron. These pin the
 * two app-only side effects it owns — opening links and floating to a gate — plus
 * that a finished install reports its output. All with a fake host and a mock
 * shell, so it runs on any host.
 */
class RecordingHost {
    events = [];
    opened = [];
    floated = [];
    finishedInstall;
    /** What the one-time consent answers, and how often it was asked. */
    autonomyAnswer = true;
    autonomyAsked = 0;
    async ensureAutonomyGranted() {
        this.autonomyAsked += 1;
        return this.autonomyAnswer;
    }
    emitEvent(event) {
        this.events.push(event);
    }
    openExternal(url) {
        this.opened.push(url);
    }
    floatToGate(instruction, href) {
        this.floated.push({ instruction, href });
    }
    onFinished(finishedInstall) {
        this.finishedInstall = finishedInstall;
    }
}
function controllerFor(recipe, shell = shell_1.MockShell.alwaysSucceeds()) {
    const host = new RecordingHost();
    const controller = new autopilot_controller_1.AutopilotController(host, () => shell, (slug) => (slug === recipe.slug ? recipe : undefined));
    return { controller, host, shell };
}
const localWebRecipe = {
    slug: "web",
    appName: "Web",
    output: { type: "local_web", url: "http://localhost:5173" },
    steps: [
        { id: "clone", title: "Clone", kind: "command", command: "git clone https://example.com/x.git" },
        { id: "open", title: "Open it", kind: "open", href: "http://localhost:5173" },
    ],
};
(0, vitest_1.describe)("the autopilot controller", () => {
    (0, vitest_1.it)("asks for the one-time autonomy consent and runs the install once granted", async () => {
        const { controller, host, shell } = controllerFor(localWebRecipe);
        const status = await controller.start("web");
        (0, vitest_1.expect)(host.autonomyAsked).toBe(1);
        (0, vitest_1.expect)(status.type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toContain("git clone https://example.com/x.git");
    });
    (0, vitest_1.it)("runs nothing when the reader declines the autonomy consent", async () => {
        const { controller, host, shell } = controllerFor(localWebRecipe);
        host.autonomyAnswer = false;
        const status = await controller.start("web");
        (0, vitest_1.expect)(host.autonomyAsked).toBe(1);
        (0, vitest_1.expect)(status.type).toBe("surfaced");
        (0, vitest_1.expect)(shell.commandsRun).toEqual([]); // no shell spun up, nothing executed
    });
    (0, vitest_1.it)("streams events, opens an open step's link, and reports the finished output", async () => {
        const { controller, host, shell } = controllerFor(localWebRecipe);
        const status = await controller.start("web");
        (0, vitest_1.expect)(status.type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["git clone https://example.com/x.git"]);
        (0, vitest_1.expect)(host.opened).toContain("http://localhost:5173"); // the open step
        (0, vitest_1.expect)(host.finishedInstall?.output).toEqual({ type: "local_web", url: "http://localhost:5173" });
        (0, vitest_1.expect)(host.events.some((event) => event.type === "finished")).toBe(true);
    });
    (0, vitest_1.it)("reports the finished install's provenance facts — clone flag, clone path, repo, and commit", async () => {
        const desktopRecipe = {
            slug: "demoapp",
            appName: "demoapp",
            output: { type: "desktop_app", launch: { via: "path", path: "C:\\App\\app.exe" } },
            canonicalRepo: "gemair-demo/demoapp",
            pinnedCommit: "a53a359b985b1d2d666266062936cc186f02340b",
            steps: [
                { id: "clone", title: "Clone", kind: "command", command: "git clone https://github.com/gemair-demo/demoapp.git" },
                { id: "enter", title: "Enter", kind: "command", command: "cd demoapp" },
            ],
        };
        // A shell whose cwd is the clone directory the recipe cd'd into.
        const shell = new shell_1.MockShell([], "C:\\Users\\test\\demoapp");
        const { controller, host } = controllerFor(desktopRecipe, shell);
        const status = await controller.start("demoapp");
        (0, vitest_1.expect)(status.type).toBe("finished");
        (0, vitest_1.expect)(host.finishedInstall).toEqual({
            slug: "demoapp",
            appName: "demoapp",
            output: { type: "desktop_app", launch: { via: "path", path: "C:\\App\\app.exe" } },
            canonicalRepo: "gemair-demo/demoapp",
            pinnedCommit: "a53a359b985b1d2d666266062936cc186f02340b",
            clonedARepo: true,
            clonePath: "C:\\Users\\test\\demoapp",
        });
    });
    (0, vitest_1.it)("floats to a gate on a sign-in step and resumes when the reader is done", async () => {
        const signInRecipe = {
            slug: "auth",
            appName: "Auth",
            output: { type: "none" },
            steps: [
                {
                    id: "sign-in",
                    title: "Sign in",
                    kind: "sign_in",
                    href: "https://example.com/login",
                    instruction: "Sign in, then GemAir carries on.",
                },
                { id: "after", title: "Finish", kind: "command", command: "npm run setup" },
            ],
        };
        const { controller, host, shell } = controllerFor(signInRecipe);
        const blocked = await controller.start("auth");
        (0, vitest_1.expect)(blocked.type).toBe("needsReader");
        (0, vitest_1.expect)(host.floated).toEqual([{ instruction: "Sign in, then GemAir carries on.", href: "https://example.com/login" }]);
        (0, vitest_1.expect)(shell.commandsRun).toHaveLength(0);
        const resumed = await controller.readerFinished();
        (0, vitest_1.expect)(resumed.type).toBe("finished");
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["npm run setup"]);
    });
    (0, vitest_1.it)("runs a confirm-tier command straight through under the autonomy grant (no pause, no float)", async () => {
        // Under the grant (the host's default answer), a command that WITHOUT the
        // grant would pause for a tap now just runs — that is the whole point of the
        // grant. The not-granted confirm path is covered at the runner level in
        // autopilot-autonomy.test.ts.
        const riskyRecipe = {
            slug: "risky",
            appName: "Risky",
            output: { type: "none" },
            steps: [{ id: "elevate", title: "Elevate", kind: "command", command: "Set-ExecutionPolicy Bypass -Scope Process" }],
        };
        const { controller, host, shell } = controllerFor(riskyRecipe);
        const status = await controller.start("risky");
        (0, vitest_1.expect)(status.type).toBe("finished");
        (0, vitest_1.expect)(host.floated).toHaveLength(0);
        (0, vitest_1.expect)(shell.commandsRun).toEqual(["Set-ExecutionPolicy Bypass -Scope Process"]);
    });
    (0, vitest_1.it)("knows which apps it can install", async () => {
        const { controller } = controllerFor(localWebRecipe);
        (0, vitest_1.expect)(await controller.canInstall("web")).toBe(true);
        (0, vitest_1.expect)(await controller.canInstall("nope")).toBe(false);
    });
    (0, vitest_1.it)("throws when asked to install an app it has no recipe for", async () => {
        const { controller } = controllerFor(localWebRecipe);
        await (0, vitest_1.expect)(controller.start("nope")).rejects.toThrow(/no Windows recipe/);
    });
});
