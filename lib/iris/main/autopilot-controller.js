"use strict";
//
// The bridge between the pure autopilot runner and the Electron app.
//
// It owns the runner + the shell for one install, pumps the runner, and turns
// the events it produces into the two side-effects only the app can do: opening
// a URL/app, and floating the eye to a gate the reader must handle. Everything
// the app provides is behind `AutopilotHost`, so this whole class is unit-tested
// with a fake host and a `MockShell` on any host — the Electron glue in
// `index.ts` stays a thin adaptor.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutopilotController = void 0;
exports.openTargetForOutput = openTargetForOutput;
const recipes_1 = require("../services/autopilot/recipes");
const recipe_1 = require("../services/autopilot/recipe");
const runner_1 = require("../services/autopilot/runner");
const setup_detour_1 = require("../services/autopilot/setup-detour");
const watch_1 = require("../services/autopilot/watch");
const powershell_session_1 = require("./powershell-session");
const posix_shell_session_1 = require("./posix-shell-session");
/// The real shell for this host: PowerShell on Windows (the shipped product),
/// a zsh login shell on macOS/Linux (running GemAir on a Mac to test the flow).
function defaultShell() {
    return process.platform === "win32" ? new powershell_session_1.PowerShellSession() : new posix_shell_session_1.PosixShellSession();
}
class AutopilotController {
    host;
    makeShell;
    resolveRecipe;
    makeFixLadder;
    detourSeams;
    makeWatchExecutor;
    runner;
    shell;
    /// The recipe the current install is running, kept so `onFinished` can report
    /// the finished install's identity (slug, canonical repo, pinned commit) and
    /// whether it cloned. Cleared by `dispose`.
    recipe;
    constructor(host, makeShell = defaultShell, 
    // Injected so tests can drive recipes the built-in set does not carry. In
    // production it is the guide-backed resolver (fetch the publik guide, derive
    // a recipe, fall back to the built-in table only when the fetch fails), so it
    // may answer asynchronously; a synchronous resolver (the built-in table, the
    // test doubles) is still accepted unchanged because `await` passes a plain
    // value straight through.
    resolveRecipe = recipes_1.recipeForSlug, 
    // Builds the self-repair ladder for one install, or undefined when the app
    // has no model key to power it — the ladder then degrades to "surface
    // immediately". Injected so `index.ts` can wire the reader's own model
    // provider and the OS strings while this class stays testable with none; the
    // default gives no ladder, so a failed command surfaces exactly as before.
    makeFixLadder = () => undefined, 
    // The setup-recovery detour's seams (tool probing + wall clock). Present in
    // production (wired in `main/index.ts`); absent in unit tests that are not
    // exercising the detour, in which case the detour is skipped entirely so a
    // recipe's prerequisite checks never shell out in the suite.
    detourSeams = undefined, 
    // Builds the watch executor a `verify`/watched step blocks on. The default
    // runs the real Windows PowerShell side signals; the visual rung stays inert
    // until a host wires screenshot capture + a model evaluator into it. Injected
    // (and one-per-install) so tests can hand in a fake with no OS calls.
    makeWatchExecutor = () => (0, watch_1.defaultWatchExecutor)()) {
        this.host = host;
        this.makeShell = makeShell;
        this.resolveRecipe = resolveRecipe;
        this.makeFixLadder = makeFixLadder;
        this.detourSeams = detourSeams;
        this.makeWatchExecutor = makeWatchExecutor;
    }
    /// Whether GemAir knows how to install this app on Windows. Async because the
    /// production resolver answers from the fetched guide.
    async canInstall(slug) {
        return (await this.resolveRecipe(slug)) !== undefined;
    }
    /// Begins an install and pumps it to the first thing that needs a human (or to
    /// the end). Throws only if the slug has no recipe.
    async start(slug) {
        const recipe = await this.resolveRecipe(slug);
        if (recipe === undefined) {
            throw new Error(`GemAir has no Windows recipe for '${slug}'.`);
        }
        // The one-time "Let GemAir take control?" consent, remembered across installs.
        // Asked before any shell is started; a decline stops here rather than
        // running an install the reader did not agree to.
        const autonomyGranted = await this.host.ensureAutonomyGranted();
        if (!autonomyGranted) {
            return {
                type: "surfaced",
                stepIndex: 0,
                reason: "GemAir needs your go-ahead to run installs on your PC. Start it again when you're ready.",
            };
        }
        this.dispose();
        this.shell = this.makeShell();
        this.recipe = recipe;
        // Captured so the detour, and the resume after it, can tell whether `abort()`
        // ran while they were suspended: `abort()` disposes the controller, which
        // nulls `this.shell`, so `this.shell !== installShell` is the abort signal.
        const installShell = this.shell;
        // Before the recipe's first step, walk the setup-recovery detour: check the
        // prerequisites the recipe needs but does not install (git, node), and if
        // any is missing, install it (winget under the grant) or send the reader to
        // its download page and wait for it to appear. A detour that gives up
        // surfaces here rather than marching into a recipe whose first step would
        // fail on a missing tool. Skipped when the detour seams are not wired
        // (unit tests that are not exercising it).
        if (this.detourSeams !== undefined) {
            const detour = await (0, setup_detour_1.runSetupDetour)(recipe, installShell, {
                probe: this.detourSeams.probe,
                clock: this.detourSeams.clock,
                platform: process.platform,
                autonomyGranted: true,
                emit: (event) => this.forwardEvent(event),
                // The red 'Stop' disposes this controller (nulling `this.shell`); once it
                // has, the detour must stop rather than keep installing tools and opening
                // pages behind a folded-away window. It also stops the resume below from
                // handing a disposed shell to the runner.
                shouldCancel: () => this.shell !== installShell,
            });
            // The abort raced the detour to completion: the shell it would run on is
            // gone. End here without building the runner — the crash the old code hit
            // was `runUntilBlocked(undefined)` after exactly this.
            if (detour.kind === "cancelled" || this.shell !== installShell) {
                return { type: "aborted", stepIndex: 0 };
            }
            if (detour.kind === "surfaced") {
                const status = { type: "surfaced", stepIndex: 0, reason: detour.reason };
                this.host.emitEvent({ type: "surfaced", reason: detour.reason });
                this.dispose();
                return status;
            }
        }
        // Granted, so the runner runs the whole vetted install hands-off (only the
        // catastrophe floor can still stop a command). The fix ladder, when the
        // reader has a model key, lets a failed command self-repair before it ever
        // reaches them; the watch executor lets a `verify`/watched step confirm
        // itself and advance without a tap. Both are undefined-tolerant.
        this.runner = new runner_1.AutopilotRunner(recipe, process.platform, true, this.makeFixLadder(recipe), this.makeWatchExecutor(), 
        // Live event sink: forward each event the instant the runner emits it —
        // exactly as the setup detour above already does — so a `handedToReader`
        // ("your turn") or a chained run reaches the renderer as it happens, not
        // batched when `runUntilBlocked` finally resolves after a multi-minute
        // watch. `pump`'s `drainEvents` then returns empty, so nothing is
        // double-sent.
        (event) => this.forwardEvent(event));
        // `installShell`, not `this.shell`: the guard above proved they are the same
        // object here, and the local is provably non-undefined, so a resume never
        // hands the runner a shell an abort disposed.
        return this.pump(await this.runner.runUntilBlocked(installShell));
    }
    /// The reader tapped "run it" / "skip" on a confirm-tier command.
    async confirm(approved) {
        if (this.runner === undefined || this.shell === undefined) {
            throw new Error("No install is running.");
        }
        return this.pump(await this.runner.confirmCurrentCommand(approved, this.shell));
    }
    /// The reader finished a sign-in / permission / manual step.
    async readerFinished() {
        if (this.runner === undefined || this.shell === undefined) {
            throw new Error("No install is running.");
        }
        return this.pump(await this.runner.readerFinishedCurrentStep(this.shell));
    }
    /// The reader chose "Try again" on a surfaced step — re-run it from the top.
    async retry() {
        if (this.runner === undefined || this.shell === undefined) {
            throw new Error("No install is running.");
        }
        return this.pump(await this.runner.retryCurrentStep(this.shell));
    }
    /// The reader chose "Continue past it" on a surfaced step — skip it and go on.
    async continuePast() {
        if (this.runner === undefined || this.shell === undefined) {
            throw new Error("No install is running.");
        }
        return this.pump(await this.runner.continuePastCurrentStep(this.shell));
    }
    /// The red 'Stop' escape hatch. Kills the running step's process tree, marks
    /// the run terminal (no further step runs), streams the `aborted` event to the
    /// terminal, and folds the window away via the host. Unconditional and
    /// idempotent — safe when nothing is running, mirroring macOS
    /// `abortOrCloseAutopilotFromTheEscapeHatch`, so the button is never dead.
    abort() {
        const status = this.runner ? this.runner.abort() : { type: "aborted", stepIndex: 0 };
        // Forward the `aborted` event (and anything else queued) before the runner
        // is torn down, so the terminal shows the run ending.
        for (const event of this.runner?.drainEvents() ?? []) {
            this.host.emitEvent(event);
        }
        // Kill the running command's whole process tree, then tear the session down.
        this.shell?.abort();
        this.dispose();
        this.host.onAborted?.();
        return status;
    }
    dispose() {
        this.shell?.dispose();
        this.shell = undefined;
        this.runner = undefined;
        this.recipe = undefined;
    }
    /// Drains the runner's events, forwards each to the renderer, and performs the
    /// app-only side effects — opening an `open` step's link, floating to a gate,
    /// and opening the finished app.
    pump(status) {
        for (const event of this.runner?.drainEvents() ?? []) {
            this.forwardEvent(event);
        }
        if (status.type === "finished") {
            // Capture the clone path (the shell's cwd) BEFORE dispose tears the
            // session down — after a cloning recipe cd's into its clone, this is the
            // clone directory maintain mode may later patch.
            this.host.onFinished(this.buildFinishedInstall(status.output));
            this.dispose();
        }
        return status;
    }
    /// Streams one event to the renderer and performs the app-only side effect it
    /// implies. Shared by the runner pump and the setup detour so an `openRequested`
    /// from either one opens its URL the same way.
    forwardEvent(event) {
        this.host.emitEvent(event);
        if (event.type === "openRequested") {
            this.host.openExternal(event.href);
        }
        else if (event.type === "handedToReader") {
            this.host.floatToGate(event.instruction, event.href);
        }
    }
    /// Assembles the `FinishedInstall` handed to `onFinished` from the recipe the
    /// install ran and the shell's current directory. `recipe` is always set at a
    /// `finished` status (it is set in `start` before the first pump), but the
    /// fallbacks keep this total rather than asserting.
    buildFinishedInstall(output) {
        const recipe = this.recipe;
        return {
            slug: recipe?.slug ?? "",
            appName: recipe?.appName ?? "",
            output,
            canonicalRepo: recipe?.canonicalRepo,
            pinnedCommit: recipe?.pinnedCommit,
            clonedARepo: recipe !== undefined ? (0, recipe_1.recipeClonesARepo)(recipe) : false,
            clonePath: this.shell?.currentDirectory(),
        };
    }
}
exports.AutopilotController = AutopilotController;
/// Opens whatever a finished recipe produced — the "once it's done the app just
/// opens" behaviour. Returns the URL to open, or undefined when there is nothing
/// to open (a credential flow, or a desktop app the caller launches differently).
function openTargetForOutput(output) {
    switch (output.type) {
        case "local_web":
            return output.url;
        case "desktop_app":
            return output.launch.via === "path" ? output.launch.path : undefined;
        default:
            return undefined;
    }
}
