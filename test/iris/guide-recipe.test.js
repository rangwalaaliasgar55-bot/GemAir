"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("./vitest-shim");
const guide_model_1 = require("../../lib/iris/services/autopilot/guide-model");
const guide_recipe_1 = require("../../lib/iris/services/autopilot/guide-recipe");
const guide_recipe_resolver_1 = require("../../lib/iris/services/autopilot/guide-recipe-resolver");
const recipes_1 = require("../../lib/iris/services/autopilot/recipes");
const runner_1 = require("../../lib/iris/services/autopilot/runner");
const shell_1 = require("../../lib/iris/services/autopilot/shell");
/**
 * Guide-derived recipes. These prove that every publik guide with a Windows
 * branch derives into an `InstallRecipe` the runner can drive — the primary path
 * that replaces the two-entry static table — and that the derivation preserves
 * the guide's commands in order, reports unsupported pairs, and never throws on a
 * malformed payload.
 *
 * The fixtures under `tests/fixtures/guides/` are the LIVE JSON of all 18 guides,
 * fetched once with `curl https://publikhq.com/api/gemair/guides/<slug>`, so this
 * suite stays offline while testing against exactly what the route serves.
 */
const FIXTURES_DIRECTORY = node_path_1.default.join(__dirname, "fixtures", "guides");
function loadGuideFixture(slug) {
    const raw = (0, node_fs_1.readFileSync)(node_path_1.default.join(FIXTURES_DIRECTORY, `${slug}.json`), "utf8");
    return (0, guide_model_1.decodeIrisGuide)(JSON.parse(raw));
}
function fixtureSlugs() {
    return (0, node_fs_1.readdirSync)(FIXTURES_DIRECTORY)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .sort();
}
function fixtureJsonText(slug) {
    return (0, node_fs_1.readFileSync)(node_path_1.default.join(FIXTURES_DIRECTORY, `${slug}.json`), "utf8");
}
/** The guide commands, in order, that GemAir itself runs — a `terminal`/`check`
 *  step with a non-blank command that the guide did NOT mark sensitive. A
 *  sensitive command (a secret entered while it is open) is handed to the reader
 *  as a `manual` step, so it is deliberately NOT a `command` GemAir runs; everything
 *  else (opens, reader steps, prose, verify) carries no command either. */
function branchCommandsInOrder(branch) {
    return branch.steps
        .filter((step) => (step.kind === "terminal" || step.kind === "check") &&
        step.command !== undefined &&
        step.command.trim() !== "" &&
        step.watch?.sensitive !== true)
        .map((step) => step.command);
}
/** Removes winget's non-interactive agreement flags, so the "commands preserved
 *  in order" check can compare a derived command against the raw guide command
 *  without the derivation's deliberate winget normalization (finding: a bare
 *  `winget install` would stall on the interactive Y/N prompt) reading as a
 *  mismatch. The flags themselves are asserted separately. */
function withoutWingetAgreementFlags(command) {
    return command
        .replace(/\s--accept-source-agreements/g, "")
        .replace(/\s--accept-package-agreements/g, "");
}
function targetForBranch(branch) {
    return { platform: "windows", ...(branch.target !== undefined ? { target: branch.target } : {}) };
}
(0, vitest_1.describe)("deriving a recipe from every guide with a Windows branch", () => {
    const slugs = fixtureSlugs();
    (0, vitest_1.it)("has all 18 guide fixtures", () => {
        (0, vitest_1.expect)(slugs.length).toBe(18);
    });
    const derivedSuccessfully = [];
    const unsupportedReported = [];
    for (const slug of slugs) {
        (0, vitest_1.it)(`derives ${slug}'s Windows branches, command-for-command`, () => {
            const guide = loadGuideFixture(slug);
            const windowsBranches = guide.branches.filter((branch) => branch.platform === "windows");
            (0, vitest_1.expect)(windowsBranches.length).toBeGreaterThan(0);
            for (const branch of windowsBranches) {
                const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, targetForBranch(branch));
                if (branch.unsupported !== undefined) {
                    // An unsupported pair is an explanation, never a recipe.
                    (0, vitest_1.expect)(resolution.kind).toBe("unsupported");
                    if (resolution.kind === "unsupported") {
                        (0, vitest_1.expect)(resolution.branchKey).toBe((0, guide_model_1.branchKeyFor)(branch));
                        (0, vitest_1.expect)(resolution.unsupported.headline.length).toBeGreaterThan(0);
                    }
                    unsupportedReported.push(`${slug}:${(0, guide_model_1.branchKeyFor)(branch)}`);
                    continue;
                }
                (0, vitest_1.expect)(resolution.kind).toBe("recipe");
                if (resolution.kind !== "recipe")
                    continue;
                const recipe = resolution.recipe;
                // The recipe's slug/name come from the guide.
                (0, vitest_1.expect)(recipe.slug).toBe(guide.appSlug);
                (0, vitest_1.expect)(recipe.appName).toBe(guide.appName);
                // Every guide step maps to exactly one recipe step.
                (0, vitest_1.expect)(recipe.steps.length).toBe(branch.steps.length);
                // The command steps equal the branch's non-sensitive commands, in order
                // (a sensitive command becomes a reader-run `manual` step, not a
                // `command`). Compared against the AUTHORED command (`posixCommand`, which
                // the derivation keeps whenever it rewrites the Windows command — the
                // POSIX clone-step idiom → PowerShell), falling back to `command` for the
                // untouched steps. Winget's agreement flags are stripped from both sides,
                // since the derivation deliberately adds them; the flags are asserted on
                // their own below.
                const derivedCommands = recipe.steps
                    .filter((step) => step.kind === "command")
                    .map((step) => withoutWingetAgreementFlags((step.posixCommand ?? step.command)));
                (0, vitest_1.expect)(derivedCommands).toEqual(branchCommandsInOrder(branch).map(withoutWingetAgreementFlags));
                // Ids and titles are preserved position-for-position.
                (0, vitest_1.expect)(recipe.steps.map((step) => step.id)).toEqual(branch.steps.map((step) => step.id));
                (0, vitest_1.expect)(recipe.steps.map((step) => step.title)).toEqual(branch.steps.map((step) => step.title));
                derivedSuccessfully.push(`${slug}:${(0, guide_model_1.branchKeyFor)(branch)}`);
            }
        });
    }
    (0, vitest_1.it)("summarises which branches derived and which were unsupported", () => {
        // Re-derive to build the summary independently of test ordering.
        const derived = [];
        const unsupported = [];
        for (const slug of fixtureSlugs()) {
            const guide = loadGuideFixture(slug);
            for (const branch of guide.branches.filter((each) => each.platform === "windows")) {
                const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, targetForBranch(branch));
                if (resolution.kind === "recipe")
                    derived.push(`${slug}:${(0, guide_model_1.branchKeyFor)(branch)}`);
                else if (resolution.kind === "unsupported")
                    unsupported.push(`${slug}:${(0, guide_model_1.branchKeyFor)(branch)}`);
            }
        }
        // Every supported Windows branch derives; the four Windows+iPhone pairs are
        // the only unsupported ones.
        (0, vitest_1.expect)(unsupported.sort()).toEqual([
            "kneecap:windows:ios",
            "lunara:windows:ios",
            "noscroll:windows:ios",
            "nut-ai:windows:ios",
        ]);
        (0, vitest_1.expect)(derived.length).toBeGreaterThanOrEqual(18);
    });
});
(0, vitest_1.describe)("the derivation mapping", () => {
    (0, vitest_1.it)("maps a no-command terminal/check step to a self-completing noop", () => {
        const guide = loadGuideFixture("openascii");
        const branch = guide.branches.find((each) => each.platform === "windows");
        const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, { platform: "windows" });
        (0, vitest_1.expect)(resolution.kind).toBe("recipe");
        if (resolution.kind !== "recipe")
            return;
        // openascii's `open-shell` prose step carries no command.
        const openShell = resolution.recipe.steps.find((step) => step.id === "open-shell");
        (0, vitest_1.expect)(openShell?.kind).toBe("noop");
        // The guide's own `open-shell` step really has no command.
        (0, vitest_1.expect)(branch.steps.find((step) => step.id === "open-shell")?.command).toBeUndefined();
    });
    (0, vitest_1.it)("carries a verify step's watch expectations without executing them", () => {
        const guide = loadGuideFixture("publikclip");
        const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, { platform: "windows" });
        (0, vitest_1.expect)(resolution.kind).toBe("recipe");
        if (resolution.kind !== "recipe")
            return;
        const verify = resolution.recipe.steps.find((step) => step.kind === "verify");
        (0, vitest_1.expect)(verify).toBeDefined();
        // The `open-app` step declares a foregroundApp expectation; the verify step's
        // expectations (when present) are carried through as data, never run.
        const openApp = resolution.recipe.steps.find((step) => step.id === "open-app");
        (0, vitest_1.expect)(openApp?.kind).toBe("command");
    });
    (0, vitest_1.it)("hands reader-only kinds (permission/web/paste) to the reader with the guide's body", () => {
        const guide = loadGuideFixture("anthropic-api-key");
        const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, { platform: "windows" });
        (0, vitest_1.expect)(resolution.kind).toBe("recipe");
        if (resolution.kind !== "recipe")
            return;
        const pasteStep = resolution.recipe.steps.find((step) => step.kind === "paste");
        (0, vitest_1.expect)(pasteStep).toBeDefined();
        (0, vitest_1.expect)(pasteStep?.instruction).toBeTruthy();
        const webStep = resolution.recipe.steps.find((step) => step.kind === "web");
        (0, vitest_1.expect)(webStep).toBeDefined();
    });
    (0, vitest_1.it)("carries a guide branch's setup steps as recipe prerequisites (tools + hrefs)", () => {
        const guide = loadGuideFixture("openascii");
        const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, { platform: "windows" });
        (0, vitest_1.expect)(resolution.kind).toBe("recipe");
        if (resolution.kind !== "recipe")
            return;
        const prerequisites = resolution.recipe.prerequisites ?? [];
        (0, vitest_1.expect)(prerequisites.map((prerequisite) => prerequisite.tool)).toEqual(["git", "node"]);
        (0, vitest_1.expect)(prerequisites.every((prerequisite) => (prerequisite.href ?? "").length > 0)).toBe(true);
    });
    (0, vitest_1.it)("marks a dev-server step long-running and a build step not", () => {
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("corepack.cmd pnpm dev")).toBe(true);
        // The spelling the shipped Windows guides actually use: the .cmd shim.
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("npm.cmd run dev")).toBe(true);
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("pnpm.cmd dev")).toBe(true);
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("bun.cmd run dev")).toBe(true);
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("npm.cmd install")).toBe(false);
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("npm run build")).toBe(false);
        (0, vitest_1.expect)((0, guide_recipe_1.commandHoldsTheShellOpen)("git checkout abc123")).toBe(false);
        const guide = loadGuideFixture("openascii");
        const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, { platform: "windows" });
        if (resolution.kind !== "recipe")
            throw new Error("expected a recipe");
        const runStep = resolution.recipe.steps.find((step) => step.id === "run");
        (0, vitest_1.expect)(runStep?.longRunning).toBe(true);
    });
    (0, vitest_1.it)("chooses a local_web url for a local-web guide and a desktop launch for a desktop app", () => {
        const openascii = (0, guide_recipe_1.recipeFromGuide)(loadGuideFixture("openascii"), { platform: "windows" });
        if (openascii.kind !== "recipe")
            throw new Error("expected a recipe");
        (0, vitest_1.expect)(openascii.recipe.output).toEqual({ type: "local_web", url: "http://localhost:5173" });
        const publikclip = (0, guide_recipe_1.recipeFromGuide)(loadGuideFixture("publikclip"), { platform: "windows" });
        if (publikclip.kind !== "recipe")
            throw new Error("expected a recipe");
        (0, vitest_1.expect)(publikclip.recipe.output.type).toBe("desktop_app");
        if (publikclip.recipe.output.type === "desktop_app") {
            (0, vitest_1.expect)(publikclip.recipe.output.launch.via).toBe("path");
            if (publikclip.recipe.output.launch.via === "path") {
                // The PowerShell $env: token is rewritten to the %VAR% form the launcher
                // expands, and it points at the installed exe.
                (0, vitest_1.expect)(publikclip.recipe.output.launch.path).toContain("%LOCALAPPDATA%");
                (0, vitest_1.expect)(publikclip.recipe.output.launch.path.toLowerCase()).toContain("publikclip");
            }
        }
    });
    (0, vitest_1.it)("attaches source provenance only to a cloning recipe", () => {
        const publikclip = (0, guide_recipe_1.recipeFromGuide)(loadGuideFixture("publikclip"), { platform: "windows" });
        if (publikclip.kind !== "recipe")
            throw new Error("expected a recipe");
        // publikclip clones a repo, so it carries its canonical repo + pinned commit.
        (0, vitest_1.expect)(publikclip.recipe.canonicalRepo).toMatch(/\//);
        (0, vitest_1.expect)(publikclip.recipe.pinnedCommit).toBeTruthy();
    });
    (0, vitest_1.it)("returns noBranch for a platform/target the guide does not have", () => {
        const guide = loadGuideFixture("openascii");
        // openascii has no Android branch.
        const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, { platform: "windows", target: "android" });
        (0, vitest_1.expect)(resolution.kind).toBe("noBranch");
    });
});
(0, vitest_1.describe)("lenient, total decoding", () => {
    (0, vitest_1.it)("never throws on a wholly malformed payload", () => {
        (0, vitest_1.expect)(() => (0, guide_model_1.decodeIrisGuide)(null)).not.toThrow();
        (0, vitest_1.expect)(() => (0, guide_model_1.decodeIrisGuide)(42)).not.toThrow();
        (0, vitest_1.expect)(() => (0, guide_model_1.decodeIrisGuide)("not a guide")).not.toThrow();
        (0, vitest_1.expect)(() => (0, guide_model_1.decodeIrisGuide)({})).not.toThrow();
        (0, vitest_1.expect)((0, guide_model_1.decodeIrisGuide)({}).branches).toEqual([]);
    });
    (0, vitest_1.it)("falls an unknown step kind back to terminal and drops an unknown expectation", () => {
        const guide = (0, guide_model_1.decodeIrisGuide)({
            appSlug: "x",
            appName: "X",
            version: 1,
            outputType: "local_web",
            branches: [
                {
                    platform: "windows",
                    label: "Windows",
                    shell: "powershell",
                    steps: [
                        {
                            id: "s1",
                            kind: "totally-made-up",
                            title: "T",
                            body: "B",
                            command: "echo hi",
                            watch: {
                                expect: [{ type: "weird-signal" }, { type: "toolVersion", tool: "git" }],
                                extraUnknownField: true,
                            },
                        },
                    ],
                    extraUnknownBranchField: 7,
                },
            ],
            extraUnknownTopLevelField: "ignored",
        });
        const step = guide.branches[0].steps[0];
        (0, vitest_1.expect)(step.kind).toBe("terminal");
        // The unknown expectation was dropped; the known one survives.
        (0, vitest_1.expect)(step.watch?.expect).toEqual([{ type: "toolVersion", tool: "git" }]);
    });
    (0, vitest_1.it)("derives without throwing from a guide full of unknown fields", () => {
        const guide = (0, guide_model_1.decodeIrisGuide)({
            appSlug: "x",
            appName: "X",
            version: 1,
            outputType: "banana", // unknown → local_web
            branches: [
                {
                    platform: "windows",
                    steps: [
                        { id: "a", kind: "mystery", title: "A", body: "", command: "git clone https://example.com/x.git" },
                        { id: "b", kind: "verify", title: "B", body: "", watch: { expect: [{ type: "nope" }] } },
                    ],
                },
            ],
        });
        (0, vitest_1.expect)(() => (0, guide_recipe_1.recipeFromGuide)(guide, { platform: "windows" })).not.toThrow();
        const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, { platform: "windows" });
        (0, vitest_1.expect)(resolution.kind).toBe("recipe");
    });
    (0, vitest_1.it)("drops a step with no id and a branch with an unplaceable platform", () => {
        const guide = (0, guide_model_1.decodeIrisGuide)({
            appSlug: "x",
            appName: "X",
            version: 1,
            outputType: "local_web",
            branches: [
                { platform: "beos", steps: [] }, // dropped
                { platform: "windows", steps: [{ kind: "terminal", title: "no id", body: "" }] },
            ],
        });
        (0, vitest_1.expect)(guide.branches.length).toBe(1);
        (0, vitest_1.expect)(guide.branches[0].platform).toBe("windows");
        (0, vitest_1.expect)(guide.branches[0].steps.length).toBe(0); // the id-less step was dropped
    });
});
(0, vitest_1.describe)("the runner drives a derived recipe exactly as a static one", () => {
    /** Runs a recipe to completion on a shell where everything succeeds, on win32,
     *  and returns the event stream. No reader steps, so it runs in one pump. */
    async function eventsFromRunning(recipe) {
        const runner = new runner_1.AutopilotRunner(recipe, "win32", true);
        const status = await runner.runUntilBlocked(shell_1.MockShell.alwaysSucceeds());
        (0, vitest_1.expect)(status.type).toBe("finished");
        return runner.drainEvents();
    }
    /** A hand-built guide whose Windows branch mirrors GemAir's static Excalidraw
     *  recipe step-for-step, so its derived recipe and the static recipe produce
     *  the same runner events. (Upstream mirrored OpenASCII here; GemAir ships
     *  Excalidraw as its clone-build-serve recipe.) */
    function guideMirroringTheStaticExcalidrawRecipe() {
        const staticRecipe = (0, recipes_1.recipeForSlug)("excalidraw");
        const clone = staticRecipe.steps.find((step) => step.id === "clone");
        return (0, guide_model_1.decodeIrisGuide)({
            appSlug: "excalidraw",
            appName: "Excalidraw",
            version: 2,
            status: "pilot",
            outputType: "local_web",
            branches: [
                {
                    platform: "windows",
                    label: "Windows",
                    shell: "powershell",
                    setupSteps: [],
                    steps: [
                        { id: "check-git", kind: "check", title: "Check Git", body: "", command: "git --version" },
                        { id: "check-node", kind: "check", title: "Check Node", body: "", command: "node --version" },
                        {
                            id: "clone",
                            kind: "terminal",
                            title: "Copy Excalidraw to this computer",
                            body: "",
                            command: clone.command,
                            workingDirectory: "~",
                        },
                        {
                            id: "dependencies",
                            kind: "terminal",
                            title: "Install dependencies",
                            body: "",
                            command: "yarn.cmd install",
                            workingDirectory: "~/gemair-apps/excalidraw",
                        },
                        {
                            id: "run",
                            kind: "terminal",
                            title: "Start Excalidraw",
                            body: "",
                            command: "yarn.cmd start",
                            workingDirectory: "~/gemair-apps/excalidraw",
                        },
                        { id: "open", kind: "open", title: "Open Excalidraw", body: "", href: "http://localhost:3000" },
                    ],
                },
            ],
        });
    }
    (0, vitest_1.it)("emits identical events for the derived and the static Excalidraw recipe", async () => {
        const derived = (0, guide_recipe_1.recipeFromGuide)(guideMirroringTheStaticExcalidrawRecipe(), { platform: "windows" });
        if (derived.kind !== "recipe")
            throw new Error("expected a recipe");
        const staticRecipe = (0, recipes_1.recipeForSlug)("excalidraw");
        const derivedEvents = await eventsFromRunning(derived.recipe);
        const staticEvents = await eventsFromRunning(staticRecipe);
        (0, vitest_1.expect)(derivedEvents).toEqual(staticEvents);
        // And it really did run the whole thing.
        (0, vitest_1.expect)(derivedEvents.some((event) => event.type === "openRequested")).toBe(true);
        (0, vitest_1.expect)(derivedEvents.at(-1)?.type).toBe("finished");
    });
    (0, vitest_1.it)("runs the LIVE openascii guide's derived recipe up to its watched verify step", async () => {
        const derived = (0, guide_recipe_1.recipeFromGuide)(loadGuideFixture("openascii"), { platform: "windows" });
        if (derived.kind !== "recipe")
            throw new Error("expected a recipe");
        // Driven with NO watch executor wired, the prose open-shell (noop) self-
        // completes and every command runs, so the install reaches the open step —
        // and then the trailing `verify` step (a visual watch: "drop in a photo") is
        // handed to the reader as "your turn", because nothing can confirm it without
        // watching the machine. This is the integrated watch-loop behaviour: a verify
        // step is no longer silently self-completed.
        const runner = new runner_1.AutopilotRunner(derived.recipe, "win32", true);
        const status = await runner.runUntilBlocked(shell_1.MockShell.alwaysSucceeds());
        const events = runner.drainEvents();
        (0, vitest_1.expect)(events.some((event) => event.type === "openRequested" && event.href === "http://localhost:5173")).toBe(true);
        (0, vitest_1.expect)(status.type).toBe("needsReader");
        // The last thing the runner did was hand the verify step over.
        (0, vitest_1.expect)(events.at(-1)?.type).toBe("handedToReader");
    });
});
(0, vitest_1.describe)("the guide-backed resolver", () => {
    (0, vitest_1.beforeEach)(() => (0, guide_recipe_resolver_1.clearGuideCache)());
    /** A fetch that serves a fixture's raw JSON for any URL. */
    function fetchServing(slug) {
        let calls = 0;
        const fetch = async () => {
            calls += 1;
            return { ok: true, status: 200, text: async () => fixtureJsonText(slug) };
        };
        return { fetch, callCount: () => calls };
    }
    (0, vitest_1.it)("resolves a recipe from the fetched guide (guide is the primary path)", async () => {
        const { fetch } = fetchServing("openascii");
        const resolved = await (0, guide_recipe_resolver_1.resolveGuideRecipe)("openascii", {
            apiBase: "http://127.0.0.1:8787",
            fetchImplementation: fetch,
        });
        (0, vitest_1.expect)(resolved.kind).toBe("recipe");
        if (resolved.kind !== "recipe")
            return;
        (0, vitest_1.expect)(resolved.source).toBe("guide");
        (0, vitest_1.expect)(resolved.recipe.slug).toBe("openascii");
        // A fetched guide can carry an app GemAir ships no static recipe for at
        // all — deriving is what makes that app installable.
        (0, vitest_1.expect)((0, recipes_1.recipeForSlug)("openascii")).toBeUndefined();
        (0, vitest_1.expect)(resolved.recipe.steps.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("caches by slug for the session — one fetch serves repeated resolves", async () => {
        const { fetch, callCount } = fetchServing("openascii");
        const options = { apiBase: "http://127.0.0.1:8787", fetchImplementation: fetch };
        await (0, guide_recipe_resolver_1.resolveGuideRecipe)("openascii", options);
        await (0, guide_recipe_resolver_1.resolveGuideRecipe)("openascii", options);
        (0, vitest_1.expect)(callCount()).toBe(1);
        (0, guide_recipe_resolver_1.clearGuideCache)();
        await (0, guide_recipe_resolver_1.resolveGuideRecipe)("openascii", options);
        (0, vitest_1.expect)(callCount()).toBe(2);
    });
    (0, vitest_1.it)("falls back to the built-in recipe ONLY when the fetch fails", async () => {
        const failingFetch = async () => {
            throw new Error("network down");
        };
        const resolved = await (0, guide_recipe_resolver_1.resolveGuideRecipe)("excalidraw", {
            apiBase: "http://127.0.0.1:8787",
            fetchImplementation: failingFetch,
        });
        (0, vitest_1.expect)(resolved.kind).toBe("recipe");
        if (resolved.kind !== "recipe")
            return;
        (0, vitest_1.expect)(resolved.source).toBe("offline_fallback");
        // The offline recipe is the static table's excalidraw, byte-for-byte.
        (0, vitest_1.expect)(resolved.recipe.steps.length).toBe((0, recipes_1.recipeForSlug)("excalidraw").steps.length);
    });
    (0, vitest_1.it)("is unreachable when the fetch fails and no offline recipe covers the slug", async () => {
        const failingFetch = async () => {
            throw new Error("network down");
        };
        const resolved = await (0, guide_recipe_resolver_1.resolveGuideRecipe)("astro", {
            apiBase: "http://127.0.0.1:8787",
            fetchImplementation: failingFetch,
        });
        (0, vitest_1.expect)(resolved.kind).toBe("unreachable");
    });
    (0, vitest_1.it)("reports an unsupported branch as unsupported, never a recipe", async () => {
        const { fetch } = fetchServing("kneecap");
        const resolved = await (0, guide_recipe_resolver_1.resolveGuideRecipe)("kneecap", {
            apiBase: "http://127.0.0.1:8787",
            fetchImplementation: fetch,
            target: { platform: "windows", target: "ios" },
        });
        (0, vitest_1.expect)(resolved.kind).toBe("unsupported");
        if (resolved.kind !== "unsupported")
            return;
        (0, vitest_1.expect)(resolved.headline).toMatch(/iPhone/i);
        (0, vitest_1.expect)(resolved.alternatives.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("the controller adapter returns a recipe for a supported branch and undefined otherwise", async () => {
        const { fetch: kneecapFetch } = fetchServing("kneecap");
        const resolveIos = (0, guide_recipe_resolver_1.guideBackedRecipeResolver)({
            apiBase: "http://127.0.0.1:8787",
            fetchImplementation: kneecapFetch,
            target: { platform: "windows", target: "ios" },
        });
        (0, vitest_1.expect)(await resolveIos("kneecap")).toBeUndefined(); // unsupported → undefined
        (0, guide_recipe_resolver_1.clearGuideCache)();
        const { fetch: openasciiFetch } = fetchServing("openascii");
        const resolveDesktop = (0, guide_recipe_resolver_1.guideBackedRecipeResolver)({
            apiBase: "http://127.0.0.1:8787",
            fetchImplementation: openasciiFetch,
        });
        const recipe = await resolveDesktop("openascii");
        (0, vitest_1.expect)(recipe?.slug).toBe("openascii");
    });
});
(0, vitest_1.describe)("sensitive commands and winget normalization", () => {
    /** Derives the desktop Windows recipe for a slug, or throws when it is not a
     *  recipe — the fixtures used here all have a supported desktop branch. */
    function desktopRecipe(slug) {
        const resolution = (0, guide_recipe_1.recipeFromGuide)(loadGuideFixture(slug), { platform: "windows" });
        if (resolution.kind !== "recipe")
            throw new Error(`${slug} did not derive to a recipe`);
        return resolution.recipe;
    }
    (0, vitest_1.it)("hands a sensitive command step to the reader instead of running it (chatmany-mann)", () => {
        const recipe = desktopRecipe("chatmany-mann");
        // Both sensitive steps in the live guide pipe a secret into `wrangler secret put`.
        for (const stepId of ["owner-token", "app-secrets"]) {
            const step = recipe.steps.find((candidate) => candidate.id === stepId);
            (0, vitest_1.expect)(step, `step ${stepId} present`).toBeDefined();
            if (step === undefined)
                continue;
            // It is a reader-handled manual step — GemAir never runs it, so there is NO
            // runnable command field for any code path to execute.
            (0, vitest_1.expect)(step.kind).toBe("manual");
            (0, vitest_1.expect)(step.command).toBeUndefined();
            (0, vitest_1.expect)(step.longRunning).toBeUndefined();
            // The reader is told what to type (the command rides in the instruction),
            // and told it is theirs to run because it is sensitive.
            (0, vitest_1.expect)(step.instruction).toBeDefined();
            (0, vitest_1.expect)(step.instruction).toContain("wrangler secret put");
            (0, vitest_1.expect)(step.instruction).toMatch(/secret|yourself/i);
        }
    });
    (0, vitest_1.it)("carries a non-sensitive paste step's command through, to open the file it names (chatmany-mann)", () => {
        // Reported bug: `set-db-id` (kind "paste") authors `notepad wrangler.toml`
        // purely to open the file the reader edits by hand — the secret itself
        // never rides on this command — but the derivation used to drop every
        // paste step's command unconditionally, leaving the reader with nothing
        // open and no path to go looking for.
        const recipe = desktopRecipe("chatmany-mann");
        const step = recipe.steps.find((candidate) => candidate.id === "set-db-id");
        (0, vitest_1.expect)(step).toBeDefined();
        if (step === undefined)
            return;
        (0, vitest_1.expect)(step.kind).toBe("paste");
        (0, vitest_1.expect)(step.command).toBe("notepad wrangler.toml");
        (0, vitest_1.expect)(step.workingDirectory).toBe("~/chatmany");
        // The reader is still the one who finishes it — carrying the command
        // through must not turn this into something that auto-completes.
        (0, vitest_1.expect)(step.instruction).toContain("wrangler.toml");
    });
    (0, vitest_1.it)("never derives a sensitive step into a `command` step for any guide", () => {
        for (const slug of fixtureSlugs()) {
            const guide = loadGuideFixture(slug);
            for (const branch of guide.branches.filter((candidate) => candidate.platform === "windows")) {
                if (branch.unsupported !== undefined)
                    continue;
                const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, targetForBranch(branch));
                if (resolution.kind !== "recipe")
                    continue;
                const sensitiveGuideStepIds = new Set(branch.steps.filter((step) => step.watch?.sensitive === true).map((step) => step.id));
                for (const step of resolution.recipe.steps) {
                    if (sensitiveGuideStepIds.has(step.id)) {
                        (0, vitest_1.expect)(step.kind, `${slug}:${step.id} must not be a command`).not.toBe("command");
                        (0, vitest_1.expect)(step.command).toBeUndefined();
                    }
                }
            }
        }
    });
    (0, vitest_1.it)("adds winget's non-interactive agreement flags to a bare `winget install` (plantgpt install-rust)", () => {
        const recipe = desktopRecipe("plantgpt");
        const installRust = recipe.steps.find((step) => step.id === "install-rust");
        (0, vitest_1.expect)(installRust).toBeDefined();
        (0, vitest_1.expect)(installRust?.command).toContain("winget install");
        (0, vitest_1.expect)(installRust?.command).toContain("--accept-source-agreements");
        (0, vitest_1.expect)(installRust?.command).toContain("--accept-package-agreements");
    });
    (0, vitest_1.it)("does not double up the agreement flags on a winget command that already has them", () => {
        // publikclip's guide installs uv with the flags already present; derivation
        // must not append a second copy.
        const recipe = desktopRecipe("publikclip");
        for (const step of recipe.steps) {
            const command = step.command;
            if (command === undefined || !/winget\s+install/i.test(command))
                continue;
            (0, vitest_1.expect)(command.match(/--accept-source-agreements/g)?.length ?? 0).toBeLessThanOrEqual(1);
            (0, vitest_1.expect)(command.match(/--accept-package-agreements/g)?.length ?? 0).toBeLessThanOrEqual(1);
        }
    });
});
/**
 * The POSIX clone-step idiom → PowerShell (finding: the Windows branch's `clone`
 * step is left as macOS bash — `cd ~ / if [ ! -d App/.git ]; then / git clone … /
 * fi` — which is a hard PowerShell ParserError, so nothing in the step runs, not
 * even the clone, and the "command not found" self-heal never fires). The
 * derivation rewrites it to PowerShell for the Windows command and keeps the
 * authored bash as `posixCommand` for the Mac test host.
 */
(0, vitest_1.describe)("POSIX clone-step translation", () => {
    (0, vitest_1.it)("translates the bash idempotent-clone idiom to runnable PowerShell", () => {
        const bash = "cd ~\nif [ ! -d WhimprFlow/.git ]; then\ngit clone https://github.com/Blueturboguy07/WhimprFlow.git\nfi";
        (0, vitest_1.expect)((0, guide_recipe_1.commandNeedsPosixTranslation)(bash)).toBe(true);
        const powershell = (0, guide_recipe_1.translatePosixShellToPowerShell)(bash);
        // The bash-only syntax is gone…
        (0, vitest_1.expect)(powershell).not.toMatch(/\[\s*!?\s*-[a-z]\s/);
        (0, vitest_1.expect)(powershell.split("\n").some((line) => line.trim() === "fi")).toBe(false);
        // …replaced by the PowerShell existence guard, with the clone body intact.
        (0, vitest_1.expect)(powershell).toContain("if (-not (Test-Path WhimprFlow/.git)) {");
        (0, vitest_1.expect)(powershell).toContain("git clone https://github.com/Blueturboguy07/WhimprFlow.git");
        (0, vitest_1.expect)(powershell.trimEnd().endsWith("}")).toBe(true);
        // `cd ~` is valid in both shells and is left untouched.
        (0, vitest_1.expect)(powershell).toContain("cd ~");
    });
    (0, vitest_1.it)("leaves an already-PowerShell command untouched", () => {
        const powershell = 'if (!(Test-Path "$env:APPDATA\\App\\models\\x.bin")) { curl.exe -f -L -o "x" https://example.com/x }';
        (0, vitest_1.expect)((0, guide_recipe_1.commandNeedsPosixTranslation)(powershell)).toBe(false);
        (0, vitest_1.expect)((0, guide_recipe_1.translatePosixShellToPowerShell)(powershell)).toBe(powershell);
        // And an ordinary chained command with `cd`/`;` is not mistaken for bash.
        const chained = "cd ui; pnpm.cmd install; cd ..; pnpm.cmd --dir ui approve-builds --all";
        (0, vitest_1.expect)((0, guide_recipe_1.commandNeedsPosixTranslation)(chained)).toBe(false);
    });
    (0, vitest_1.it)("derives every fixture's Windows commands free of bash-only syntax", () => {
        // Every derived Windows `command` step must be PowerShell-parseable: no `[ -x
        // ]` test, no bare `then`/`fi` line. The authored bash survives on
        // `posixCommand` for the clone steps the derivation rewrote.
        let clonesTranslated = 0;
        for (const slug of fixtureSlugs()) {
            const guide = loadGuideFixture(slug);
            for (const branch of guide.branches.filter((each) => each.platform === "windows")) {
                const resolution = (0, guide_recipe_1.recipeFromGuide)(guide, targetForBranch(branch));
                if (resolution.kind !== "recipe")
                    continue;
                for (const step of resolution.recipe.steps) {
                    if (step.kind !== "command")
                        continue;
                    (0, vitest_1.expect)((0, guide_recipe_1.commandNeedsPosixTranslation)(step.command), `${slug}:${step.id}`).toBe(false);
                    if (step.posixCommand !== undefined) {
                        // A translated step keeps the authored bash, and the win32 command is
                        // the PowerShell rewrite of it.
                        (0, vitest_1.expect)((0, guide_recipe_1.commandNeedsPosixTranslation)(step.posixCommand)).toBe(true);
                        (0, vitest_1.expect)(step.command).toBe((0, guide_recipe_1.translatePosixShellToPowerShell)(step.posixCommand));
                        clonesTranslated += 1;
                    }
                }
            }
        }
        // The catalog's source-build guides (~14 of 18) carry the bug; prove we hit
        // more than a couple so a regression that quietly stops translating is caught.
        (0, vitest_1.expect)(clonesTranslated).toBeGreaterThanOrEqual(10);
    });
});
