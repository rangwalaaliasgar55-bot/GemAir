"use strict";
/**
 * replay-engine.ts
 *
 * Ported from `iris-macos/leanring-buddy/RecipeReplayEngine.swift`, with Tier
 * B's forced-tool-call adapter (`iris-macos/leanring-buddy/MaintainFixAdapter.swift`,
 * not separately assigned a Windows module in the porting spec) folded in
 * here rather than into its own file, since nothing else needs it.
 *
 * Tier A of the fix ladder: someone else already fixed this exact break, and
 * their recipe is in the pool. Replaying it costs zero tokens — the entire
 * economic argument for maintain mode, and the only fix path the funded tier
 * ever gets. Tier B is one constrained, forced BYO model call that re-anchors
 * a stale pooled diff when the exact one no longer applies; absent a key (or
 * absent the adapter entirely, i.e. `fixAdapter === undefined`), stale is the
 * honest end of the road — same as Swift's `nil` adapter.
 *
 * Three recipe families, three behaviors:
 *
 *   workaround / config_change / update_app
 *       Steps for a person. The engine surfaces them; it runs nothing.
 *
 *   patch_pr (a diff against a recorded base)
 *       For a source-clone install only (the D4 gate — see
 *       `install-provenance.ts`), the engine applies it with `git apply
 *       --3way` — three-way merge against the recorded base tolerates drift
 *       honestly, leaving conflict markers rather than mis-applying — then
 *       hands the tree to the verification harness and files the outcome
 *       either way. A clean apply that fails verification is REVERTED and
 *       reported as a failure: leaving a half-working patch in someone's
 *       tree because it merged cleanly is exactly the "textual merge is not
 *       a working merge" trap.
 *
 * Every outcome reaches the pool with this install's pseudonymous id, so
 * promotion counts distinct machines, not retries.
 *
 * ============================================================================
 * CROSS-MODULE CONTRACT — this file is one of several `services/maintain/`
 * modules being ported in parallel by separate tasks. Every import below is
 * a sibling module owned by another task in the same porting effort; none of
 * them are guessed shapes — each one was verified directly against that
 * module's compiled output at `iris-windows/dist/services/maintain/*.js`
 * (the recovered prior attempt — see the porting spec's §0) before this file
 * was written, so the imports below should resolve exactly once the sibling
 * `.ts` sources land:
 *
 *   ./trace                 maintainTrace(message): void
 *   ./break-signature       BreakAppStack (type) = "tauri" | "electron" | "nextjs" | "swift-macos" | "other"
 *   ./release-version       compareReleaseVersions(a, b): "older" | "same" | "newer" | "cannotBeCompared"
 *   ./pool-client           class MaintainPoolClient { fileRecipeOutcome(recipeId, succeeded, installId?): Promise<void> }
 *                           type PooledFixRecipe { id, appSlug, recipeType, recipe, diagnosis, patchSpecific, applicability, ... }
 *   ./install-provenance    class InstallProvenanceStore {
 *                             localPatchingIsPermitted(appSlug): boolean;
 *                             provenanceForAppSlug(appSlug): RecordedInstallProvenance | null;
 *                           }
 *   ./patch-queue           class PatchQueue { record(patch: QueuedPatch): void }
 *                           type QueuedPatch { ..., baseCommit?: string, appliedAt: string (ISO 8601) }
 *   ./maintain-shell-runner interface MaintainShellRunner { repoRootPath; run(command, opts?): Promise<MaintainCommandResult> }
 *                           tryRun(runner, command, opts?): Promise<MaintainCommandResult | undefined>
 *   ./verification-harness  verifyAppliedPatch(runner, commands, reproCommand): Promise<VerificationOutcome>
 *                           earnsCleanApply(outcome): boolean
 *                           type VerificationCommands, type VerificationOutcome
 *                           (VerificationCommands lives HERE, not in a separate
 *                           `verification-commands.ts` — the sibling task folded
 *                           it in, mirroring Swift keeping the two in one file;
 *                           `incoming-fix-reviewer.ts` folds the per-stack
 *                           defaults table in similarly, as its own header says)
 *
 * `getCurrentInstallId` and `createShellRunner` are constructor-injected
 * functions rather than raw imports of the modules that build them
 * (`install-identity.ts`'s `MaintainInstallIdentity.currentInstallId()`,
 * `main/maintain/maintain-shell-runner-windows.ts`) — this keeps
 * `RecipeReplayEngine` decoupled from exactly how those seams are composed,
 * the same way `AutopilotRunner` takes `platform` rather than reading
 * `process.platform` itself. `verificationCommandsForStack` is injected for
 * the same reason (real composition: a per-stack table living wherever the
 * caller wires this engine up — today that is `incoming-fix-reviewer.ts`'s
 * `defaultVerificationCommandsForStack`). The real composition of all three
 * is `main/maintain/controller.ts`'s job, not this file's.
 * ============================================================================
 *
 * PowerShell, not zsh: Swift's shell one-liners (`cmd1 && cmd2 || cmd3`,
 * `2>/dev/null`) are valid in the zsh login shell `MaintainShellRunner.swift`
 * drives, but the real Windows implementation of `MaintainShellRunner` runs
 * commands through `powershell.exe` (Windows PowerShell 5.1, matching
 * `main/powershell-session.ts` — no `&&`/`||`, and single-quote escaping is
 * doubling (`''`), not the POSIX `'\''` trick). This file writes PowerShell-
 * correct command text and issues each git step as its own `runner.run` call
 * instead of chaining with `&&`/`||`/redirects — behavior parity with Swift,
 * not literal translation, per the porting ground rules.
 */
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
exports.RecipeReplayEngine = exports.OpenCodePatchAdapter = exports.AnthropicPatchAdapter = void 0;
exports.recipeApplicabilityMatches = recipeApplicabilityMatches;
exports.extractRecipeGuidanceSteps = extractRecipeGuidanceSteps;
const maintain_shell_runner_1 = require("./maintain-shell-runner");
const release_version_1 = require("./release-version");
const trace_1 = require("./trace");
const verification_harness_1 = require("./verification-harness");
const assistant_transport_1 = require("../assistant-transport");
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
// ---------------------------------------------------------------------------
// Applicability (OSV-shaped typed ranges, fail-closed)
// ---------------------------------------------------------------------------
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.every((entry) => typeof entry === "string") ? value : undefined;
}
function decodeVersionRanges(value) {
    if (!Array.isArray(value))
        return undefined;
    const ranges = [];
    for (const entry of value) {
        if (!isPlainObject(entry))
            return undefined;
        const introduced = typeof entry.introduced === "string" ? entry.introduced : undefined;
        const fixed = typeof entry.fixed === "string" ? entry.fixed : undefined;
        ranges.push({ introduced, fixed });
    }
    return ranges;
}
/**
 * The pooled shape: `{"app_version":[{"introduced":"1.0","fixed":"1.4"}],
 * "arch":["arm64"]}`. Absent field = no constraint. Malformed JSON = NO
 * match — a recipe whose applicability cannot be read must not run, same
 * fail-closed rule as unknown install provenance.
 *
 * `applicability` is `unknown` here (not a typed dictionary, unlike Swift's
 * already-`Codable`-decoded `[String: AnyDecodableJSON]?`) because the wire
 * type `pool-client.ts`'s `PooledFixRecipe.applicability` carries is
 * `unknown` — this function does the defensive shape-checking Swift's
 * `Codable` layer did for free.
 */
function recipeApplicabilityMatches(options) {
    const { applicability, appVersion, architecture } = options;
    if (applicability === null || applicability === undefined) {
        return true;
    }
    if (!isPlainObject(applicability)) {
        (0, trace_1.maintainTrace)("maintain: recipe applicability was not readable JSON — refusing to match");
        return false;
    }
    if ("arch" in applicability) {
        const allowedArchitectures = decodeStringArray(applicability.arch);
        if (allowedArchitectures === undefined) {
            return false; // unreadable arch list -> fail closed
        }
        if (allowedArchitectures.length > 0 && !allowedArchitectures.includes(architecture)) {
            return false;
        }
    }
    if ("app_version" in applicability) {
        if (appVersion === null) {
            return false;
        }
        const versionRanges = decodeVersionRanges(applicability.app_version);
        if (versionRanges === undefined) {
            return false; // unreadable version ranges -> fail closed
        }
        const isInSomeRange = versionRanges.some((range) => {
            // `cannotBeCompared` fails the range, not an earlier guard: an
            // unparseable version is outside every proven range.
            const isAfterIntroduced = range.introduced === undefined ||
                ["newer", "same"].includes((0, release_version_1.compareReleaseVersions)(appVersion, range.introduced));
            const isBeforeFixed = range.fixed === undefined || (0, release_version_1.compareReleaseVersions)(appVersion, range.fixed) === "older";
            return isAfterIntroduced && isBeforeFixed;
        });
        if (!isInSomeRange) {
            return false;
        }
    }
    return true;
}
// ---------------------------------------------------------------------------
// Guidance extraction
// ---------------------------------------------------------------------------
/**
 * A guidance recipe's jsonb is guide-steps shaped: `{"steps":[{"title":...,
 * "body":..., "command":...}]}`. Extracts readable lines; an unreadable
 * recipe yields one honest line instead of nothing. Ported from Swift's
 * `RecipeGuidanceSteps.extract(fromRecipeJSON:)`.
 */
function extractRecipeGuidanceSteps(recipeJson) {
    const fallback = [
        "A fix is known for this break, but its steps could not be read — open the app's guide in GemAir and run the install again.",
    ];
    if (!isPlainObject(recipeJson))
        return fallback;
    const steps = recipeJson.steps;
    if (!Array.isArray(steps) || steps.length === 0)
        return fallback;
    const lines = [];
    for (const step of steps) {
        if (!isPlainObject(step))
            continue;
        const title = typeof step.title === "string" ? step.title : undefined;
        const command = typeof step.command === "string" ? step.command : undefined;
        if (title !== undefined && command !== undefined) {
            lines.push(`${title}: \`${command}\``);
        }
        else if (title !== undefined) {
            lines.push(title);
        }
        else if (command !== undefined) {
            lines.push(`Run \`${command}\``);
        }
    }
    return lines;
}
// ---------------------------------------------------------------------------
// Tier B: the forced-tool-call patch adapter
// ---------------------------------------------------------------------------
/** A fixed pipeline, not an agent: no loop, no exploration, no shell access,
 *  hard output cap. Matches Swift's `MaintainFixAdapter.maximumOutputTokensPerAdaptCall`. */
const MAXIMUM_OUTPUT_TOKENS_PER_ADAPT_CALL = 1500;
/** Matches `model-provider.ts`'s own constant — kept as a separate local copy
 *  rather than an import, since the two files are independently portable
 *  pieces of the same fan-out and this is the Windows app's one existing
 *  default model (`src/main/settings.ts`), not shared wire vocabulary. */
const opencode_models_1 = require("../opencode-models");
const { MAINTAIN_FREE_MODEL_ID } = require("./model-provider");
const ADAPT_PATCH_SYSTEM_PROMPT = "You adapt a known bug fix to a slightly different version of the same " +
    "codebase. The fix below was verified on other machines; its line " +
    "anchors no longer match this machine's files. Produce the SAME change " +
    "re-anchored to the code as it looks now — never a different fix, never " +
    "additional changes, never touched files the original did not touch. " +
    "If the code has changed so much that the original fix no longer makes " +
    "sense, say so via cannot_adapt instead of guessing.\n" +
    "Call adapt_patch exactly once.";
const ADAPT_PATCH_TOOL = {
    type: "function",
    function: {
        name: "adapt_patch",
        description: "Return the known fix re-anchored to this machine's code, or decline.",
        parameters: {
        type: "object",
        properties: {
            unified_diff: {
                type: "string",
                description: "The adapted fix as a unified diff against the files shown, same change, new anchors.",
            },
            cannot_adapt: {
                type: "string",
                description: "Set INSTEAD of unified_diff when the code has diverged past honest re-anchoring — one sentence why.",
            },
        },
        },
    },
};
/**
 * Tier B's patch adapter, on a FREE OpenCode model.
 *
 * Upstream built this transport as `{ tier: "byo", anthropicApiKey }` so that
 * the fix loop could never reach publik's funded proxy — an absent key was a
 * terminal `noBringYourOwnKeyAvailable`, not a fallback. GemAir keeps the
 * structure and changes what it points at: the transport is structurally
 * OpenCode-only and the model id goes through the free-model gate, so this call
 * cannot cost the reader anything. The `noBringYourOwnKeyAvailable` result
 * survives for the one case that is still real — no way to reach a model at all.
 */
class OpenCodePatchAdapter {
    readOpenCodeApiKey;
    fetchImplementation;
    modelId;
    constructor(readOpenCodeApiKey = () => null, fetchImplementation = globalThis.fetch, modelId = MAINTAIN_FREE_MODEL_ID) {
        this.readOpenCodeApiKey = readOpenCodeApiKey;
        this.fetchImplementation = fetchImplementation;
        this.modelId = (0, opencode_models_1.assertFreeModelId)(modelId);
    }
    async adaptPatch(options) {
        if (typeof this.fetchImplementation !== "function") {
            return { type: "noBringYourOwnKeyAvailable" };
        }
        const report = [
            `App: ${options.appSlug}`,
            "Root-cause diagnosis from the known recipe:",
            options.diagnosis ?? "(none recorded)",
            "",
            "The verified-but-stale unified diff:",
            "```",
            options.stalePatch.slice(0, 8000),
            "```",
            "",
            "The touched files as they look on THIS machine today:",
            "```",
            options.localFileExcerpts.slice(0, 12000),
            "```",
        ].join("\n");
        const transport = {
            tier: "zen",
            apiKey: this.readOpenCodeApiKey() || opencode_models_1.OPENCODE_PUBLIC_TOKEN,
            apiBaseUrl: opencode_models_1.OPENCODE_ZEN_BASE_URL,
        };
        let preparedRequest;
        try {
            preparedRequest = await (0, assistant_transport_1.makeChatRequest)(transport);
        }
        catch (error) {
            return { type: "modelCouldNotAdapt", reason: error instanceof Error ? error.message : String(error) };
        }
        const body = {
            model: this.modelId,
            max_tokens: MAXIMUM_OUTPUT_TOKENS_PER_ADAPT_CALL,
            messages: [
                { role: "system", content: ADAPT_PATCH_SYSTEM_PROMPT },
                { role: "user", content: report },
            ],
            tools: [ADAPT_PATCH_TOOL],
            tool_choice: { type: "function", function: { name: "adapt_patch" } },
            stream: false,
        };
        let response;
        try {
            response = await this.fetchImplementation(preparedRequest.url, {
                method: preparedRequest.method,
                headers: preparedRequest.headers,
                body: JSON.stringify(body),
            });
        }
        catch (error) {
            return { type: "modelCouldNotAdapt", reason: error instanceof Error ? error.message : String(error) };
        }
        const rawResponseBody = await response.text();
        if (!response.ok) {
            return { type: "modelCouldNotAdapt", reason: `HTTP ${response.status}` };
        }
        const input = readAdaptPatchCall(rawResponseBody);
        if (input === undefined) {
            return { type: "modelCouldNotAdapt", reason: "no adapt_patch call in the response" };
        }
        const cannotAdapt = input.cannot_adapt;
        if (typeof cannotAdapt === "string" && cannotAdapt.length > 0) {
            return { type: "modelCouldNotAdapt", reason: cannotAdapt };
        }
        const unifiedDiff = input.unified_diff;
        if (typeof unifiedDiff !== "string" || !unifiedDiff.includes("--- ") || !unifiedDiff.includes("+++ ")) {
            return { type: "modelCouldNotAdapt", reason: "response carried no usable diff" };
        }
        return { type: "adaptedPatch", unifiedDiff };
    }
}
exports.OpenCodePatchAdapter = OpenCodePatchAdapter;
/** Back-compatible alias for callers ported from Iris. */
exports.AnthropicPatchAdapter = OpenCodePatchAdapter;
/**
 * Reads the `adapt_patch` arguments out of a chat-completions body.
 *
 * Tool calling is the contract, but free models vary in how reliably they honour
 * `tool_choice`, so a reply that instead put the JSON object in the message text
 * is read rather than discarded — the alternative is throwing away a correct fix
 * because of the envelope it arrived in.
 */
function readAdaptPatchCall(rawResponseBody) {
    let parsed;
    try {
        parsed = JSON.parse(rawResponseBody);
    }
    catch {
        return undefined;
    }
    const message = parsed?.choices?.[0]?.message;
    const toolCall = (message?.tool_calls ?? []).find((call) => call?.function?.name === "adapt_patch");
    if (toolCall) {
        try {
            const args = toolCall.function.arguments;
            return typeof args === "string" ? JSON.parse(args) : args;
        }
        catch {
            return undefined;
        }
    }
    const content = typeof message?.content === "string" ? message.content : "";
    if (!content)
        return undefined;
    const jsonBlock = content.match(/\{[\s\S]*\}/);
    if (!jsonBlock)
        return undefined;
    try {
        return JSON.parse(jsonBlock[0]);
    }
    catch {
        return undefined;
    }
}
// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------
/**
 * Quotes a value as a PowerShell single-quoted string (doubling embedded
 * quotes) — the same escaping `main/powershell-session.ts`'s `psSingleQuote`
 * uses, duplicated here rather than imported so this file stays free of a
 * `main/` dependency: `services/` must not depend on `main/`, matching the
 * layering `iris-windows/CLAUDE.md` documents.
 */
function powerShellSingleQuote(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
/**
 * The files a diff touches, as they look on THIS machine — the Tier B adapt
 * call's grounding. Paths come from the diff's own `+++` headers, resolved
 * under the clone only; anything escaping the root is skipped. Ported from
 * Swift's `RecipeReplayEngine.localFileExcerpts(forPatch:clonePath:)`.
 */
async function localFileExcerptsForPatch(patchText, clonePath) {
    const root = path.resolve(clonePath);
    const excerpts = [];
    for (const line of patchText.split("\n")) {
        if (!line.startsWith("+++ "))
            continue;
        let relativePath = line.slice(4).trim();
        if (relativePath.startsWith("b/"))
            relativePath = relativePath.slice(2);
        if (relativePath === "/dev/null" || relativePath.length === 0)
            continue;
        const fullPath = path.resolve(root, relativePath);
        if (fullPath !== root && !fullPath.startsWith(root + path.sep))
            continue; // escapes the clone root
        try {
            const contents = await fs.readFile(fullPath, "utf-8");
            excerpts.push(`=== ${relativePath} ===\n${contents.slice(0, 6000)}`);
        }
        catch {
            // Not present on this machine (new file, or already deleted) — nothing
            // to excerpt; the adapt call still sees the diff itself.
        }
    }
    return excerpts.join("\n\n");
}
/** UTC `yyyyMMdd`, matching Swift's `compactDateStamp()` (also UTC). */
function compactDateStamp(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    return `${year}${month}${day}`;
}
class RecipeReplayEngine {
    provenanceStore;
    poolClient;
    getCurrentInstallId;
    patchQueue;
    createShellRunner;
    verificationCommandsForStack;
    fixAdapter;
    constructor(options) {
        this.provenanceStore = options.provenanceStore;
        this.poolClient = options.poolClient;
        this.getCurrentInstallId = options.getCurrentInstallId;
        this.patchQueue = options.patchQueue;
        this.createShellRunner = options.createShellRunner;
        this.verificationCommandsForStack = options.verificationCommandsForStack;
        this.fixAdapter = options.fixAdapter;
    }
    async replay(options) {
        const { recipe, appSlug, appStack, installedAppVersion, signatureId, machineArchitecture } = options;
        if (!recipeApplicabilityMatches({
            applicability: recipe.applicability,
            appVersion: installedAppVersion,
            architecture: machineArchitecture,
        })) {
            (0, trace_1.maintainTrace)(`maintain: recipe ${recipe.id} refused — outside applicability range`);
            return { type: "outsideApplicabilityRange" };
        }
        // The non-patch families are guidance, never execution.
        if (recipe.recipeType !== "patch_pr") {
            return { type: "guidanceToShow", steps: extractRecipeGuidanceSteps(recipe.recipe) };
        }
        if (!this.provenanceStore.localPatchingIsPermitted(appSlug)) {
            return { type: "patchingNotPermittedForThisInstall" };
        }
        const record = this.provenanceStore.provenanceForAppSlug(appSlug);
        const clonePath = record?.clonePath;
        if (clonePath === undefined || clonePath === null) {
            return { type: "patchingNotPermittedForThisInstall" };
        }
        const patchText = recipe.patchSpecific;
        if (patchText === null || patchText === undefined || patchText.length === 0) {
            return { type: "patchDidNotApply" };
        }
        const runner = this.createShellRunner(clonePath);
        if (runner === undefined) {
            return { type: "patchingNotPermittedForThisInstall" };
        }
        // Tier A: the exact pooled diff.
        const exactResult = await this.applyVerifyAndCommit({
            patchText,
            recipe,
            appSlug,
            appStack,
            signatureId,
            runner,
            clonePath,
            wasAdapted: false,
        });
        if (exactResult.type !== "patchDidNotApply") {
            return exactResult;
        }
        // Tier B: the diff is stale for this version — one constrained BYO model
        // call re-anchors it, seeded with the pooled diagnosis. Absent an
        // adapter (or a key), stale is the honest end of the road.
        if (this.fixAdapter === undefined) {
            return { type: "patchDidNotApply" };
        }
        const localFileExcerpts = await localFileExcerptsForPatch(patchText, clonePath);
        const adaptation = await this.fixAdapter.adaptPatch({
            diagnosis: recipe.diagnosis,
            stalePatch: patchText,
            localFileExcerpts,
            appSlug,
        });
        if (adaptation.type !== "adaptedPatch") {
            if (adaptation.type === "modelCouldNotAdapt") {
                (0, trace_1.maintainTrace)(`maintain: adapt_patch declined — ${adaptation.reason}`);
            }
            return { type: "patchDidNotApply" };
        }
        (0, trace_1.maintainTrace)(`maintain: recipe ${recipe.id} adapted via BYO — retrying apply`);
        return this.applyVerifyAndCommit({
            patchText: adaptation.unifiedDiff,
            recipe,
            appSlug,
            appStack,
            signatureId,
            runner,
            clonePath,
            wasAdapted: true,
        });
    }
    /**
     * The shared spine both tiers ride: dry-run, apply, verify (revert on
     * failure), commit on a recipe-keyed branch, queue the patch, file the
     * outcome. `wasAdapted` only changes the bookkeeping words — ported from
     * Swift's `applyVerifyAndCommit`.
     */
    async applyVerifyAndCommit(options) {
        const { patchText, recipe, appSlug, appStack, signatureId, runner, clonePath, wasAdapted } = options;
        // Write the patch inside the repo (the runner's boundary); cleaned up
        // whatever happens below.
        const patchFileName = `.iris-replay-${recipe.id}.patch`;
        const patchFilePath = path.join(clonePath, patchFileName);
        try {
            await fs.writeFile(patchFilePath, patchText, "utf-8");
        }
        catch {
            return { type: "patchDidNotApply" };
        }
        try {
            // Dry-run first: --check answers "would this apply" without touching
            // the tree, so a stale recipe never leaves half a patch behind.
            const dryRun = await (0, maintain_shell_runner_1.tryRun)(runner, `git apply --check --3way ${powerShellSingleQuote(patchFileName)}`, {
                deadlineMs: 60_000,
            });
            if (dryRun?.succeeded !== true) {
                if (!wasAdapted) {
                    (0, trace_1.maintainTrace)(`maintain: recipe ${recipe.id} stale — did not apply (3way check failed)`);
                    await this.fileOutcome(recipe.id, false);
                }
                return { type: "patchDidNotApply" };
            }
            const headResult = await (0, maintain_shell_runner_1.tryRun)(runner, "git rev-parse HEAD", { deadlineMs: 30_000 });
            const baseCommit = headResult?.outputTail.trim() ?? "";
            const applied = await (0, maintain_shell_runner_1.tryRun)(runner, `git apply --3way ${powerShellSingleQuote(patchFileName)}`, {
                deadlineMs: 60_000,
            });
            if (applied?.succeeded !== true) {
                await this.fileOutcome(recipe.id, false);
                return { type: "patchDidNotApply" };
            }
            await this.fileOutcome(recipe.id, true);
            // Replay standard: build + suite. No repro test rode along, so the
            // three legs are structurally impossible here — and the outcome kind
            // stays 'applied', never 'verified', for exactly that reason.
            const commands = this.verificationCommandsForStack(appStack, clonePath);
            const verification = await (0, verification_harness_1.verifyAppliedPatch)(runner, commands, undefined);
            if (!(0, verification_harness_1.earnsCleanApply)(verification)) {
                // `&&` is not reliable in Windows PowerShell 5.1 — two separate
                // steps rather than Swift's `checkout -- . && clean -fd`.
                await (0, maintain_shell_runner_1.tryRun)(runner, "git checkout -- .", { deadlineMs: 120_000 });
                await (0, maintain_shell_runner_1.tryRun)(runner, "git clean -fd --quiet", { deadlineMs: 120_000 });
                await this.fileOutcome(recipe.id, false);
                return {
                    type: "patchRevertedAfterFailedVerification",
                    blockedStage: verification.blockedStage ?? "unknown",
                };
            }
            // Commit on a recipe-keyed branch — the fork service (a later
            // increment) pushes it.
            const dateStamp = compactDateStamp();
            const branchName = `iris/fix-${signatureId.slice(0, 12)}-${dateStamp}`;
            const provenanceWord = wasAdapted ? "adapted from" : "replayed";
            const commitMessage = `Apply pooled fix recipe ${recipe.id}\n\n` +
                `Break-Signature: ${signatureId}\n` +
                `Fix-Recipe-Match: ${recipe.id}${wasAdapted ? " (adapted)" : ""}\n` +
                `Verified: applied, build-green${verification.suitePassed === true ? ", suite-green" : ""}\n` +
                `Assisted-by: iris-maintain-mode/1\n` +
                `Modified-by: GemAir — ${provenanceWord} a pooled recipe`;
            // No `||`, either: check whether the branch exists first, then take
            // exactly one of create/switch — same outcome as Swift's
            // `checkout -b X 2>/dev/null || checkout X`, PowerShell-native.
            const branchExists = await (0, maintain_shell_runner_1.tryRun)(runner, `git rev-parse --verify --quiet ${powerShellSingleQuote(branchName)}`, { deadlineMs: 30_000 });
            if (branchExists?.succeeded === true) {
                await (0, maintain_shell_runner_1.tryRun)(runner, `git checkout ${powerShellSingleQuote(branchName)}`, { deadlineMs: 30_000 });
            }
            else {
                await (0, maintain_shell_runner_1.tryRun)(runner, `git checkout -b ${powerShellSingleQuote(branchName)}`, { deadlineMs: 30_000 });
            }
            await (0, maintain_shell_runner_1.tryRun)(runner, "git add -A", { deadlineMs: 60_000 });
            await (0, maintain_shell_runner_1.tryRun)(runner, `git commit -m ${powerShellSingleQuote(commitMessage)} --quiet`, {
                deadlineMs: 60_000,
            });
            try {
                this.patchQueue.record({
                    recipeId: recipe.id,
                    signatureId,
                    appSlug,
                    branchName,
                    patchText,
                    baseCommit: baseCommit.length > 0 ? baseCommit : undefined,
                    appliedAt: new Date().toISOString(),
                });
            }
            catch {
                // A patch that fails to queue still applied and verified; the branch
                // exists in the clone even if GemAir cannot track it for a future
                // upstream replay. Bookkeeping loss, not a fix failure.
            }
            await this.fileOutcome(recipe.id, true);
            (0, trace_1.maintainTrace)(`maintain: recipe ${recipe.id} ${provenanceWord} and committed on ${branchName}`);
            return { type: "patchAppliedAndVerified", branchName };
        }
        finally {
            try {
                await fs.rm(patchFilePath, { force: true });
            }
            catch {
                // Best-effort cleanup; a leftover `.iris-replay-*.patch` file is
                // harmless and gets overwritten by the next attempt.
            }
        }
    }
    /**
     * Records a recipe outcome with this install's pseudonymous id.
     * `MaintainPoolClient.fileRecipeOutcome` is itself not-throwing by design
     * (fire-and-forget, matches Swift's `_ = try? await ...`), so there is
     * nothing further to swallow here — this method exists only to fold the
     * `recipeId, succeeded, installId` call shape into one place.
     */
    async fileOutcome(recipeId, succeeded) {
        await this.poolClient.fileRecipeOutcome(recipeId, succeeded, this.getCurrentInstallId());
    }
}
exports.RecipeReplayEngine = RecipeReplayEngine;
