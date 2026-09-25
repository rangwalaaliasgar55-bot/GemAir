"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const recipe_1 = require("../../lib/iris/services/autopilot/recipe");
const recipes_1 = require("../../lib/iris/services/autopilot/recipes");
const runner_1 = require("../../lib/iris/services/autopilot/runner");
(0, vitest_1.describe)("step-kind routing", () => {
    (0, vitest_1.it)("sends a command to GemAir and an open to auto-advance", () => {
        (0, vitest_1.expect)((0, recipe_1.isRunByIris)("command")).toBe(true);
        (0, vitest_1.expect)((0, recipe_1.needsTheReader)("command")).toBe(false);
        (0, vitest_1.expect)((0, recipe_1.isDoneOnceOpened)("open")).toBe(true);
        (0, vitest_1.expect)((0, recipe_1.needsTheReader)("open")).toBe(false);
    });
    vitest_1.it.each(["sign_in", "permission", "manual"])("keeps %s with the reader", (kind) => {
        (0, vitest_1.expect)((0, recipe_1.needsTheReader)(kind)).toBe(true);
        (0, vitest_1.expect)((0, recipe_1.isRunByIris)(kind)).toBe(false);
        (0, vitest_1.expect)((0, recipe_1.isDoneOnceOpened)(kind)).toBe(false);
    });
});
(0, vitest_1.describe)("the built-in recipes", () => {
    // Upstream's local-web recipe was OpenASCII; GemAir ships Excalidraw in that
    // slot (same shape: clone, install, long-running dev server, open).
    (0, vitest_1.it)("finds Excalidraw and shapes it right", () => {
        const recipe = (0, recipes_1.recipeForSlug)("excalidraw");
        (0, vitest_1.expect)(recipe).toBeDefined();
        (0, vitest_1.expect)(recipe?.appName).toBe("Excalidraw");
        // It ends by starting a dev server and opening it — a local-web app.
        (0, vitest_1.expect)(recipe?.output.type).toBe("local_web");
        // The dev-server step must be long-running or the runner hangs on it.
        (0, vitest_1.expect)(recipe?.steps.some((step) => step.longRunning)).toBe(true);
        (0, vitest_1.expect)(recipe?.steps.some((step) => step.kind === "open")).toBe(true);
    });
    (0, vitest_1.it)("has no recipe for an unknown slug", () => {
        (0, vitest_1.expect)((0, recipes_1.recipeForSlug)("not-a-real-app")).toBeUndefined();
    });
    (0, vitest_1.it)("picks the Windows command on win32 and the posix command elsewhere", () => {
        const step = {
            id: "deps",
            title: "Install",
            kind: "command",
            command: "corepack.cmd pnpm install",
            posixCommand: "corepack pnpm install",
        };
        (0, vitest_1.expect)((0, recipe_1.commandForPlatform)(step, "win32")).toBe("corepack.cmd pnpm install");
        (0, vitest_1.expect)((0, recipe_1.commandForPlatform)(step, "darwin")).toBe("corepack pnpm install");
        (0, vitest_1.expect)((0, recipe_1.commandForPlatform)(step, "linux")).toBe("corepack pnpm install");
    });
    (0, vitest_1.it)("falls back to the one command when there is no posix variant", () => {
        const step = { id: "clone", title: "Clone", kind: "command", command: "git clone x" };
        (0, vitest_1.expect)((0, recipe_1.commandForPlatform)(step, "win32")).toBe("git clone x");
        (0, vitest_1.expect)((0, recipe_1.commandForPlatform)(step, "darwin")).toBe("git clone x");
    });
    (0, vitest_1.it)("gives Excalidraw a macOS variant for its Windows-only yarn step", () => {
        const deps = (0, recipes_1.recipeForSlug)("excalidraw")?.steps.find((step) => step.id === "dependencies");
        (0, vitest_1.expect)(deps?.command).toContain("yarn.cmd");
        (0, vitest_1.expect)(deps?.posixCommand).toBe("yarn install");
    });
    (0, vitest_1.it)("gives every recipe a slug and at least one step", () => {
        for (const recipe of (0, recipes_1.builtinRecipes)()) {
            (0, vitest_1.expect)(recipe.slug.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(recipe.steps.length).toBeGreaterThan(0);
        }
    });
});
/**
 * The folder every step runs in, held to the same positional rule the published
 * guides are (`checkGuideInvariants` in publik/lib/guide-invariants.ts).
 *
 * The rule is positional rather than clever about which commands are relative,
 * because "does this command depend on the cwd" is not decidable from its text:
 * `npm.cmd install`, `node_modules\\.bin\\tauri.cmd build` and
 * `Get-ChildItem src-tauri\\target\\...` all do, and a rule that has to guess is a
 * rule that lets the next one through. Before this, the runner and its four
 * tests supported `workingDirectory` and not one shipped recipe declared one —
 * the field was plumbing with nothing plugged into it.
 */
(0, vitest_1.describe)("every shipped recipe says where its steps run", () => {
    /** Simulates the shell: the folder each step ends up in, following the `cd`s. */
    function foldersByInheritance(recipe, platform, home) {
        const landedIn = new Map();
        let cwd = home;
        for (const step of recipe.steps) {
            const command = (0, recipe_1.commandForPlatform)(step, platform);
            if (command === undefined)
                continue;
            landedIn.set(step.id, cwd);
            // Only the `cd`s in the recipes matter here, and they are all of the form
            // `cd <literal>` (possibly after a `mkdir -p`, on one line).
            for (const piece of command.split(";")) {
                const moved = /^\s*cd\s+(\S+)\s*$/.exec(piece);
                if (!moved)
                    continue;
                const folder = moved[1];
                cwd = folder.startsWith("~") ? folder.replace("~", home) : `${cwd}/${folder}`;
            }
        }
        return landedIn;
    }
    for (const platform of ["win32", "darwin"]) {
        vitest_1.it.each((0, recipes_1.builtinRecipes)().map((recipe) => [recipe.slug, recipe]))(`declares a folder for every %s step from the clone onward (${platform})`, (_slug, recipe) => {
            const clone = (0, recipe_1.cloneStepIndex)(recipe);
            if (clone < 0) {
                // GemAir also ships tool installers (winget/brew/curl), which clone
                // nothing and have no project folder to declare. The rule for those
                // is the stricter one: they must never move the shell at all, so
                // there is no folder for a later step to inherit wrongly.
                for (const step of recipe.steps) {
                    const command = (0, recipe_1.commandForPlatform)(step, platform);
                    if (command === undefined)
                        continue;
                    (0, vitest_1.expect)(/(^|;)\s*cd\s/.test(command), `${recipe.slug}/${step.id} changes folder in a recipe that clones nothing`).toBe(false);
                    (0, vitest_1.expect)((0, recipe_1.workingDirectoryForPlatform)(step, platform)).toBeUndefined();
                }
                return;
            }
            for (const step of recipe.steps.slice(clone)) {
                if ((0, recipe_1.commandForPlatform)(step, platform) === undefined)
                    continue;
                (0, vitest_1.expect)((0, recipe_1.workingDirectoryForPlatform)(step, platform), `${recipe.slug}/${step.id} would inherit whatever folder the shell happens to be in`).toBeDefined();
            }
        });
        vitest_1.it.each((0, recipes_1.builtinRecipes)().map((recipe) => [recipe.slug, recipe]))(`declares the folder %s's own cd steps actually produce (${platform})`, (_slug, recipe) => {
            // A declaration that disagrees with the linear run would be worse than
            // none: it would silently move the install somewhere it has never been
            // tested. So the declared folder must be exactly the inherited one.
            const inherited = foldersByInheritance(recipe, platform, "~");
            for (const step of recipe.steps) {
                const declared = (0, recipe_1.workingDirectoryForPlatform)(step, platform);
                if (declared === undefined)
                    continue;
                (0, vitest_1.expect)(declared, `${recipe.slug}/${step.id}`).toBe(inherited.get(step.id));
            }
        });
    }
    (0, vitest_1.it)("declares folders the runner will accept as plain paths", () => {
        for (const recipe of (0, recipes_1.builtinRecipes)()) {
            for (const step of recipe.steps) {
                for (const platform of ["win32", "darwin"]) {
                    const declared = (0, recipe_1.workingDirectoryForPlatform)(step, platform);
                    if (declared === undefined)
                        continue;
                    (0, vitest_1.expect)((0, runner_1.isAPlainFolder)(declared), `${recipe.slug}/${step.id}: ${declared}`).toBe(true);
                }
            }
        }
    });
});
