"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const install_provenance_1 = require("../../lib/iris/services/maintain/install-provenance");
const maintain_shell_runner_1 = require("../../lib/iris/services/maintain/maintain-shell-runner");
const patch_queue_1 = require("../../lib/iris/services/maintain/patch-queue");
const pool_client_1 = require("../../lib/iris/services/maintain/pool-client");
const opencode_models_1 = require("../../lib/iris/services/opencode-models");
const replay_engine_1 = require("../../lib/iris/services/maintain/replay-engine");
/**
 * `replay-engine.ts` — Tier A (replay a pooled recipe verbatim) and Tier B
 * (one forced BYO call to re-anchor a stale diff). Three layers of tests:
 *
 *   - `recipeApplicabilityMatches` / `extractRecipeGuidanceSteps`: pure
 *     functions, tested directly against the fail-closed rules the porting
 *     spec documents.
 *   - `AnthropicPatchAdapter`: network-mocked, same key-isolation stance as
 *     `maintain-model-provider.test.ts`.
 *   - `RecipeReplayEngine.replay`: the shared apply-verify-commit spine,
 *     driven against `MockMaintainShellRunner` and real (in-memory-backed)
 *     collaborator classes — `InstallProvenanceStore`, `PatchQueue`, and
 *     `MaintainPoolClient` are concrete classes with private fields, so a
 *     duck-typed fake cannot stand in for them; each test constructs the
 *     real thing over an in-memory store or a scripted fetch instead.
 *
 *     One wrinkle the mock cannot paper over: `applyVerifyAndCommit` writes
 *     the recipe's patch text to a REAL file under `clonePath` with plain
 *     `node:fs` (`.gemair-replay-<recipeId>.patch`) before ever touching the
 *     injected shell runner, and removes it again in a `finally`. Only the
 *     `git`/build/test *commands* are faked — the patch file itself is real
 *     I/O. So `clonePath` cannot be an opaque placeholder string the way it
 *     can in, say, `maintain-patch-queue.test.ts`'s in-memory-only tests: it
 *     has to be a real, writable directory, or the write throws and every
 *     apply attempt reports `patchDidNotApply` before a single shell command
 *     runs. `engineFor` below therefore roots every engine it builds at a
 *     real `mkdtempSync` directory, the same pattern
 *     `maintain-verification-harness.test.ts`'s real-repo section uses.
 */
// ---------------------------------------------------------------------------
// recipeApplicabilityMatches
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("recipeApplicabilityMatches — fail-closed OSV-shaped ranges", () => {
    (0, vitest_1.it)("matches everything when applicability is absent", () => {
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({ applicability: null, appVersion: "1.0.0", architecture: "x64" })).toBe(true);
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({ applicability: undefined, appVersion: null, architecture: "x64" })).toBe(true);
    });
    (0, vitest_1.it)("refuses rather than guesses when applicability is not readable JSON", () => {
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({ applicability: "not-an-object", appVersion: "1.0.0", architecture: "x64" })).toBe(false);
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({ applicability: ["arm64"], appVersion: "1.0.0", architecture: "x64" })).toBe(false);
    });
    vitest_1.it.each([
        [{ arch: ["arm64", "x64"] }, "x64", true],
        [{ arch: ["arm64"] }, "x64", false],
        [{ arch: [] }, "x64", true], // an empty list constrains nothing
        [{ arch: "x64" }, "x64", false], // unreadable (not an array) -> fail closed
    ])("arch constraint %j against %s -> %s", (applicability, architecture, expected) => {
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({ applicability, appVersion: "1.0.0", architecture })).toBe(expected);
    });
    (0, vitest_1.it)("refuses when app_version is constrained but the installed version is unknown", () => {
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({
            applicability: { app_version: [{ introduced: "1.0.0" }] },
            appVersion: null,
            architecture: "x64",
        })).toBe(false);
    });
    (0, vitest_1.it)("refuses when the version ranges are not readable", () => {
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({
            applicability: { app_version: "1.0.0" },
            appVersion: "1.0.0",
            architecture: "x64",
        })).toBe(false);
    });
    vitest_1.it.each([
        ["1.3.9", true], // inside [1.0.0, 1.4.0)
        ["0.9.0", false], // before introduced
        ["1.4.0", false], // at fixed (fixed is exclusive)
        ["2.0.0", false], // past fixed
    ])("app_version %s against [1.0.0, 1.4.0) -> %s", (appVersion, expected) => {
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({
            applicability: { app_version: [{ introduced: "1.0.0", fixed: "1.4.0" }] },
            appVersion,
            architecture: "x64",
        })).toBe(expected);
    });
    (0, vitest_1.it)("an open-ended range (introduced only) matches everything at or after it", () => {
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({
            applicability: { app_version: [{ introduced: "2.0.0" }] },
            appVersion: "9.9.9",
            architecture: "x64",
        })).toBe(true);
    });
    (0, vitest_1.it)("requires every constrained dimension to pass — arch alone cannot rescue a version miss", () => {
        (0, vitest_1.expect)((0, replay_engine_1.recipeApplicabilityMatches)({
            applicability: { arch: ["x64"], app_version: [{ fixed: "1.0.0" }] },
            appVersion: "1.0.0",
            architecture: "x64",
        })).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// extractRecipeGuidanceSteps
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("extractRecipeGuidanceSteps", () => {
    (0, vitest_1.it)("renders title+command, title-only, and command-only lines", () => {
        const steps = (0, replay_engine_1.extractRecipeGuidanceSteps)({
            steps: [
                { title: "Clear the cache", command: "rm -rf .cache" },
                { title: "Restart the app" },
                { command: "npm install" },
                { neitherTitleNorCommand: true },
                "not even an object",
            ],
        });
        (0, vitest_1.expect)(steps).toEqual([
            "Clear the cache: `rm -rf .cache`",
            "Restart the app",
            "Run `npm install`",
        ]);
    });
    (0, vitest_1.it)("falls back to one honest line for unreadable or empty recipe JSON", () => {
        const fallback = ["A fix is known for this break, but its steps could not be read — open the app's guide in GemAir and run the install again."];
        (0, vitest_1.expect)((0, replay_engine_1.extractRecipeGuidanceSteps)(null)).toEqual(fallback);
        (0, vitest_1.expect)((0, replay_engine_1.extractRecipeGuidanceSteps)("a string, not an object")).toEqual(fallback);
        (0, vitest_1.expect)((0, replay_engine_1.extractRecipeGuidanceSteps)({ steps: [] })).toEqual(fallback);
        (0, vitest_1.expect)((0, replay_engine_1.extractRecipeGuidanceSteps)({ noStepsKey: true })).toEqual(fallback);
    });
});
function recordingFetch(response) {
    const calls = [];
    const fetchImplementation = async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return {
            ok: response.ok ?? true,
            status: response.status ?? 200,
            text: async () => response.body ?? "{}",
            headers: { get: () => null },
        };
    };
    return { fetchImplementation, calls };
}
const AN_ADAPT_REQUEST = {
    diagnosis: "the config key was renamed",
    stalePatch: "--- a/config.json\n+++ b/config.json\n@@ -1 +1 @@\n-old\n+new\n",
    localFileExcerpts: "=== config.json ===\ncurrent contents",
    appSlug: "cue",
};
/** The OpenAI-compatible envelope OpenCode Zen answers a forced tool call in. */
function toolCallBody(input) {
    return JSON.stringify({
        choices: [
            {
                message: {
                    role: "assistant",
                    tool_calls: [{ id: "call-1", type: "function", function: { name: "adapt_patch", arguments: JSON.stringify(input) } }],
                },
            },
        ],
    });
}
(0, vitest_1.describe)("OpenCodePatchAdapter", () => {
    // GemAir's Tier-B adapter is a free OpenCode Zen model rather than upstream's
    // bring-your-own Anthropic key, so "no key" is no longer a refusal: the
    // public token reaches the free models. `AnthropicPatchAdapter` remains
    // exported as an alias so ported callers keep working.
    (0, vitest_1.it)("is the same class the Iris-era name still points at", () => {
        (0, vitest_1.expect)(replay_engine_1.AnthropicPatchAdapter).toBe(replay_engine_1.OpenCodePatchAdapter);
    });
    (0, vitest_1.it)("declines with noBringYourOwnKeyAvailable, calling fetch zero times, when it has no usable fetch at all", async () => {
        const { calls } = recordingFetch({});
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => null, null);
        (0, vitest_1.expect)(await adapter.adaptPatch(AN_ADAPT_REQUEST)).toEqual({ type: "noBringYourOwnKeyAvailable" });
        (0, vitest_1.expect)(calls).toHaveLength(0);
    });
    (0, vitest_1.it)("NEVER reaches a publik host, and returns the adapted diff on a valid forced tool call", async () => {
        const adaptedDiff = "--- a/config.json\n+++ b/config.json\n@@ -1 +1 @@\n-old\n+renamed\n";
        const { fetchImplementation, calls } = recordingFetch({ body: toolCallBody({ unified_diff: adaptedDiff }) });
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => null, fetchImplementation);
        const result = await adapter.adaptPatch(AN_ADAPT_REQUEST);
        (0, vitest_1.expect)(result).toEqual({ type: "adaptedPatch", unifiedDiff: adaptedDiff });
        (0, vitest_1.expect)(calls).toHaveLength(1);
        (0, vitest_1.expect)(new URL(calls[0].url).hostname).toBe("opencode.ai");
        (0, vitest_1.expect)(calls[0].headers.Authorization).toBe(`Bearer ${opencode_models_1.OPENCODE_PUBLIC_TOKEN}`);
        (0, vitest_1.expect)(JSON.stringify(calls[0])).not.toContain("publikhq.com");
        (0, vitest_1.expect)(JSON.stringify(calls[0])).not.toContain("anthropic.com");
        const sentBody = JSON.parse(calls[0].body);
        (0, vitest_1.expect)(sentBody.tool_choice).toEqual({ type: "function", function: { name: "adapt_patch" } });
        (0, vitest_1.expect)((0, opencode_models_1.isFreeModelId)(sentBody.model)).toBe(true);
        (0, vitest_1.expect)(sentBody.messages.at(-1).content).toContain(AN_ADAPT_REQUEST.diagnosis);
    });
    (0, vitest_1.it)("sends the reader's own OpenCode key when they have signed in for one", async () => {
        const { fetchImplementation, calls } = recordingFetch({ body: toolCallBody({ cannot_adapt: "no" }) });
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => "oc-reader-key", fetchImplementation);
        await adapter.adaptPatch(AN_ADAPT_REQUEST);
        (0, vitest_1.expect)(calls[0].headers.Authorization).toBe("Bearer oc-reader-key");
    });
    (0, vitest_1.it)("honors an explicit cannot_adapt decline as the reason, not as a diff", async () => {
        const { fetchImplementation } = recordingFetch({ body: toolCallBody({ cannot_adapt: "the file was deleted upstream" }) });
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => null, fetchImplementation);
        (0, vitest_1.expect)(await adapter.adaptPatch(AN_ADAPT_REQUEST)).toEqual({
            type: "modelCouldNotAdapt",
            reason: "the file was deleted upstream",
        });
    });
    (0, vitest_1.it)("treats a response with no adapt_patch call and no JSON in the text as a decline", async () => {
        const { fetchImplementation } = recordingFetch({
            body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }),
        });
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => null, fetchImplementation);
        const result = await adapter.adaptPatch(AN_ADAPT_REQUEST);
        (0, vitest_1.expect)(result).toEqual({ type: "modelCouldNotAdapt", reason: "no adapt_patch call in the response" });
    });
    (0, vitest_1.it)("still reads the arguments when a free model answers in text instead of a tool call", async () => {
        // Free models honour `tool_choice` unevenly; a correct fix must not be
        // thrown away over the envelope it arrived in.
        const adaptedDiff = "--- a/config.json\n+++ b/config.json\n@@ -1 +1 @@\n-old\n+renamed\n";
        const { fetchImplementation } = recordingFetch({
            body: JSON.stringify({
                choices: [{ message: { role: "assistant", content: `Here you go:\n${JSON.stringify({ unified_diff: adaptedDiff })}` } }],
            }),
        });
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => null, fetchImplementation);
        (0, vitest_1.expect)(await adapter.adaptPatch(AN_ADAPT_REQUEST)).toEqual({ type: "adaptedPatch", unifiedDiff: adaptedDiff });
    });
    (0, vitest_1.it)("refuses a diff missing the --- / +++ markers rather than trusting it blindly", async () => {
        const { fetchImplementation } = recordingFetch({ body: toolCallBody({ unified_diff: "not a real diff" }) });
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => null, fetchImplementation);
        const result = await adapter.adaptPatch(AN_ADAPT_REQUEST);
        (0, vitest_1.expect)(result).toEqual({ type: "modelCouldNotAdapt", reason: "response carried no usable diff" });
    });
    (0, vitest_1.it)("wraps a non-2xx response into modelCouldNotAdapt with the status code", async () => {
        const { fetchImplementation } = recordingFetch({ ok: false, status: 529, body: "{}" });
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => null, fetchImplementation);
        (0, vitest_1.expect)(await adapter.adaptPatch(AN_ADAPT_REQUEST)).toEqual({
            type: "modelCouldNotAdapt",
            reason: "HTTP 529",
        });
    });
    (0, vitest_1.it)("wraps a thrown network error into modelCouldNotAdapt", async () => {
        const throwingFetchImplementation = async () => {
            throw new Error("connection reset");
        };
        const adapter = new replay_engine_1.OpenCodePatchAdapter(() => null, throwingFetchImplementation);
        (0, vitest_1.expect)(await adapter.adaptPatch(AN_ADAPT_REQUEST)).toEqual({
            type: "modelCouldNotAdapt",
            reason: "connection reset",
        });
    });
    (0, vitest_1.it)("refuses to be built on a model that is not free", () => {
        (0, vitest_1.expect)(() => new replay_engine_1.OpenCodePatchAdapter(() => null, async () => ({}), "claude-opus-5")).toThrow();
    });
});
// ---------------------------------------------------------------------------
// RecipeReplayEngine — the shared apply-verify-commit spine
// ---------------------------------------------------------------------------
function aRecipe(overrides = {}) {
    return {
        id: "recipe-1",
        breakId: "break-1",
        appSlug: "cue",
        recipeType: "patch_pr",
        modelTier: "tierA",
        recipe: { steps: [] },
        status: "active",
        signatureId: "abcdef0123456789abcdef0123456789",
        diagnosis: "the config key was renamed",
        patchSpecific: "--- a/config.json\n+++ b/config.json\n@@ -1 +1 @@\n-old\n+new\n",
        patchBaseSha: null,
        patchGeneral: null,
        patchFormat: null,
        applicability: null,
        parentRecipeId: null,
        reviewStatus: "approved",
        verifiedFixes: 3,
        cleanApplies: 5,
        distinctInstallsAttempted: 5,
        score: 1,
        ...overrides,
    };
}
function poolClientRecordingOutcomes() {
    const outcomeCalls = [];
    const fetchImplementation = async (url, init) => {
        if (url.includes("/outcome")) {
            outcomeCalls.push(JSON.parse(init.body ?? "{}"));
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: "recorded" }) };
    };
    // GemAir has no default pool (see `pool-client.js`), so outcome filing only
    // happens against a base URL the reader configured — one is given here.
    return {
        poolClient: new pool_client_1.MaintainPoolClient({ fetchImplementation, poolBaseUrl: "http://127.0.0.1:8788" }),
        outcomeCalls,
    };
}
const NO_BUILD_OR_TEST = {};
const AN_APP_STACK = "other";
// `applyVerifyAndCommit` writes the patch file for real (see the file header
// above) — every test in the `RecipeReplayEngine` sections below gets a real,
// writable scratch directory to root its engine at, torn down afterward, the
// same `mkdtempSync`/`rmSync` pattern `maintain-verification-harness.test.ts`
// uses for its real-git-repo section.
let realClonePath;
(0, vitest_1.beforeEach)(() => {
    realClonePath = fs.mkdtempSync(path.join(os.tmpdir(), "gemair-maintain-replay-"));
});
(0, vitest_1.afterEach)(() => {
    fs.rmSync(realClonePath, { recursive: true, force: true });
});
function engineFor(options) {
    const clonePath = options.clonePath ?? realClonePath;
    const provenanceStore = new install_provenance_1.InstallProvenanceStore({
        persistence: new install_provenance_1.InMemoryInstallProvenancePersistence(),
        checkGitDirectoryExists: () => true,
    });
    provenanceStore.recordGuideSourceClone({
        appSlug: "cue",
        clonePath,
        pinnedCommit: "deadbeef",
        canonicalRepo: "publikhq/cue",
    });
    const patchQueue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
    const engine = new replay_engine_1.RecipeReplayEngine({
        provenanceStore,
        poolClient: options.poolClient,
        getCurrentInstallId: () => "install-abc-123",
        patchQueue,
        createShellRunner: options.createShellRunner ?? (() => options.runner),
        verificationCommandsForStack: options.verificationCommandsForStack ?? (() => NO_BUILD_OR_TEST),
        fixAdapter: options.fixAdapter,
    });
    return { engine, provenanceStore, patchQueue };
}
(0, vitest_1.describe)("RecipeReplayEngine.replay — early exits", () => {
    (0, vitest_1.it)("refuses a recipe outside its applicability range without touching the shell", async () => {
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const { poolClient } = poolClientRecordingOutcomes();
        const { engine } = engineFor({ runner, poolClient });
        const recipe = aRecipe({ applicability: { arch: ["arm64"] } });
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "outsideApplicabilityRange" });
        (0, vitest_1.expect)(runner.commandsRun).toHaveLength(0);
    });
    (0, vitest_1.it)("surfaces a non-patch recipe as guidance and runs nothing", async () => {
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const { poolClient } = poolClientRecordingOutcomes();
        const { engine } = engineFor({ runner, poolClient });
        const recipe = aRecipe({
            recipeType: "workaround",
            recipe: { steps: [{ title: "Clear the cache", command: "rm -rf .cache" }] },
        });
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "guidanceToShow", steps: ["Clear the cache: `rm -rf .cache`"] });
        (0, vitest_1.expect)(runner.commandsRun).toHaveLength(0);
    });
    (0, vitest_1.it)("refuses to patch when the D4 gate has not permitted local patching for this app", async () => {
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const { poolClient } = poolClientRecordingOutcomes();
        const provenanceStore = new install_provenance_1.InstallProvenanceStore({ persistence: new install_provenance_1.InMemoryInstallProvenancePersistence() });
        // No recordGuideSourceClone call — the app is unknown provenance, fail closed.
        const patchQueue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        const engine = new replay_engine_1.RecipeReplayEngine({
            provenanceStore,
            poolClient,
            getCurrentInstallId: () => "install-1",
            patchQueue,
            createShellRunner: () => runner,
            verificationCommandsForStack: () => NO_BUILD_OR_TEST,
        });
        const recipe = aRecipe();
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "patchingNotPermittedForThisInstall" });
        (0, vitest_1.expect)(runner.commandsRun).toHaveLength(0);
    });
    (0, vitest_1.it)("treats an empty patchSpecific as patchDidNotApply without touching the shell", async () => {
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const { poolClient } = poolClientRecordingOutcomes();
        const { engine } = engineFor({ runner, poolClient });
        const recipe = aRecipe({ patchSpecific: "" });
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "patchDidNotApply" });
        (0, vitest_1.expect)(runner.commandsRun).toHaveLength(0);
    });
    (0, vitest_1.it)("reports patchingNotPermittedForThisInstall when a shell runner cannot be constructed", async () => {
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const { poolClient } = poolClientRecordingOutcomes();
        const { engine } = engineFor({ runner, poolClient, createShellRunner: () => undefined });
        const recipe = aRecipe();
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "patchingNotPermittedForThisInstall" });
    });
});
(0, vitest_1.describe)("RecipeReplayEngine.replay — Tier A apply-verify-commit", () => {
    (0, vitest_1.it)("applies, verifies clean, commits on an gemair/fix-<sig>-<date> branch, and files a success outcome twice", async () => {
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const { poolClient, outcomeCalls } = poolClientRecordingOutcomes();
        const { engine, patchQueue } = engineFor({ runner, poolClient });
        const recipe = aRecipe();
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result.type).toBe("patchAppliedAndVerified");
        if (result.type !== "patchAppliedAndVerified")
            throw new Error("unreachable");
        (0, vitest_1.expect)(result.branchName).toMatch(/^gemair\/fix-abcdef012345-\d{8}$/);
        // The apply, then the commit — never chained with && or ||, PowerShell-safe.
        (0, vitest_1.expect)(runner.commandsRun.some((c) => c.includes("git apply --check --3way"))).toBe(true);
        (0, vitest_1.expect)(runner.commandsRun.some((c) => c.includes("git apply --3way") && !c.includes("--check"))).toBe(true);
        (0, vitest_1.expect)(runner.commandsRun.some((c) => c.startsWith("git commit -m"))).toBe(true);
        (0, vitest_1.expect)(runner.commandsRun.some((c) => c.includes("&&") || c.includes("||"))).toBe(false);
        // Two fire-and-forget outcomes: one for "applied", one for "verified".
        (0, vitest_1.expect)(outcomeCalls).toEqual([{ succeeded: true, installId: "install-abc-123" }, { succeeded: true, installId: "install-abc-123" }]);
        const queued = patchQueue.patchesForAppSlug("cue");
        (0, vitest_1.expect)(queued).toHaveLength(1);
        (0, vitest_1.expect)(queued[0]).toMatchObject({
            recipeId: "recipe-1",
            signatureId: recipe.signatureId,
            appSlug: "cue",
            branchName: result.branchName,
            patchText: recipe.patchSpecific,
        });
    });
    (0, vitest_1.it)("does not apply a patch that fails even the --3way dry-run, and files exactly one failed outcome", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([{ succeeded: false, exitCode: 1, outputTail: "patch does not apply" }]);
        const { poolClient, outcomeCalls } = poolClientRecordingOutcomes();
        const { engine, patchQueue } = engineFor({ runner, poolClient });
        const recipe = aRecipe();
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "patchDidNotApply" });
        (0, vitest_1.expect)(runner.commandsRun).toEqual([vitest_1.expect.stringContaining("git apply --check --3way")]);
        (0, vitest_1.expect)(outcomeCalls).toEqual([{ succeeded: false, installId: "install-abc-123" }]);
        (0, vitest_1.expect)(patchQueue.patchesForAppSlug("cue")).toHaveLength(0);
    });
    (0, vitest_1.it)("reverts and reports patchRevertedAfterFailedVerification when the build fails after a clean apply", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "" }, // 1: git apply --check --3way
            { succeeded: true, exitCode: 0, outputTail: "deadbeef\n" }, // 2: git rev-parse HEAD
            { succeeded: true, exitCode: 0, outputTail: "" }, // 3: git apply --3way
            { succeeded: true, exitCode: 0, outputTail: "" }, // 4: git diff --numstat HEAD (diff-scope gate)
            { succeeded: true, exitCode: 0, outputTail: "" }, // 5: git ls-files --others --exclude-standard
            { succeeded: false, exitCode: 1, outputTail: "error: missing dependency" }, // 6: the build command itself
        ]);
        const { poolClient, outcomeCalls } = poolClientRecordingOutcomes();
        const { engine, patchQueue } = engineFor({
            runner,
            poolClient,
            verificationCommandsForStack: () => ({ buildCommand: "npm run build" }),
        });
        const recipe = aRecipe();
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "patchRevertedAfterFailedVerification", blockedStage: "build" });
        (0, vitest_1.expect)(runner.commandsRun).toContain("git checkout -- .");
        (0, vitest_1.expect)(runner.commandsRun).toContain("git clean -fd --quiet");
        (0, vitest_1.expect)(runner.commandsRun.some((c) => c.startsWith("git commit"))).toBe(false);
        // "applied" outcome (true) then "verified" outcome (false) — a clean apply
        // that fails verification is reported as a failure, never as a half-success.
        (0, vitest_1.expect)(outcomeCalls).toEqual([
            { succeeded: true, installId: "install-abc-123" },
            { succeeded: false, installId: "install-abc-123" },
        ]);
        (0, vitest_1.expect)(patchQueue.patchesForAppSlug("cue")).toHaveLength(0);
    });
});
(0, vitest_1.describe)("RecipeReplayEngine.replay — Tier B, the stale-recipe adapt retry", () => {
    (0, vitest_1.it)("falls back to patchDidNotApply when there is no fixAdapter at all", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([{ succeeded: false, exitCode: 1, outputTail: "stale" }]);
        const { poolClient } = poolClientRecordingOutcomes();
        const { engine } = engineFor({ runner, poolClient }); // no fixAdapter passed
        const recipe = aRecipe();
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "patchDidNotApply" });
    });
    (0, vitest_1.it)("retries with the adapted diff and succeeds when the adapter re-anchors it", async () => {
        // Only the FIRST call (Tier A's dry-run) is scripted to fail; every call
        // after that (the retried dry-run, apply, diff-scope gate, commit steps)
        // falls through to MockMaintainShellRunner's default success.
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([{ succeeded: false, exitCode: 1, outputTail: "stale" }]);
        const { poolClient, outcomeCalls } = poolClientRecordingOutcomes();
        let adaptPatchCallCount = 0;
        const adaptedDiff = "--- a/config.json\n+++ b/config.json\n@@ -1 +1 @@\n-old\n+renamed\n";
        const scriptedAdapter = {
            async adaptPatch() {
                adaptPatchCallCount += 1;
                return { type: "adaptedPatch", unifiedDiff: adaptedDiff };
            },
        };
        const { engine, patchQueue } = engineFor({ runner, poolClient, fixAdapter: scriptedAdapter });
        const recipe = aRecipe();
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(adaptPatchCallCount).toBe(1);
        (0, vitest_1.expect)(result.type).toBe("patchAppliedAndVerified");
        // The Tier A failure filed one outcome (false); the Tier B success spine
        // filed two more (applied=true, verified=true).
        (0, vitest_1.expect)(outcomeCalls).toEqual([
            { succeeded: false, installId: "install-abc-123" },
            { succeeded: true, installId: "install-abc-123" },
            { succeeded: true, installId: "install-abc-123" },
        ]);
        const queued = patchQueue.patchesForAppSlug("cue");
        (0, vitest_1.expect)(queued).toHaveLength(1);
        (0, vitest_1.expect)(queued[0].patchText).toBe(adaptedDiff);
    });
    (0, vitest_1.it)("gives up as patchDidNotApply when the adapter itself declines", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([{ succeeded: false, exitCode: 1, outputTail: "stale" }]);
        const { poolClient } = poolClientRecordingOutcomes();
        const decliningAdapter = {
            async adaptPatch() {
                return { type: "modelCouldNotAdapt", reason: "the file was deleted upstream" };
            },
        };
        const { engine } = engineFor({ runner, poolClient, fixAdapter: decliningAdapter });
        const recipe = aRecipe();
        const result = await engine.replay({
            recipe,
            appSlug: "cue",
            appStack: AN_APP_STACK,
            installedAppVersion: "1.0.0",
            signatureId: recipe.signatureId,
            machineArchitecture: "x64",
        });
        (0, vitest_1.expect)(result).toEqual({ type: "patchDidNotApply" });
    });
});
