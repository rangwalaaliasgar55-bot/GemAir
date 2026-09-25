"use strict";
/**
 * controller.ts
 *
 * The composition root for maintain mode's main-process side. Mirrors
 * `main/autopilot-controller.ts`'s shape: it owns the pure
 * `MaintainIncidentCoordinator`, wires the real (Windows-only)
 * implementations of every seam the coordinator and its collaborators need,
 * forwards state changes to the renderer through an injected `MaintainHost`,
 * and answers the IPC-driven `answerAsk`/`clearFixStatus` calls
 * `main/index.ts` routes to it.
 *
 * ## What this file wires today, and what it deliberately does not
 *
 * Wired for real: the recipe pool (`MaintainPoolClient` over `fetch`), the
 * ask-gate/provenance/install-identity persistence (`MaintainStateStore`, one
 * `userData/maintain.json`), the patch queue (`PatchQueue` over
 * `userData/patch-queue/`), the Tier A/B replay engine (`RecipeReplayEngine`
 * over the platform's real maintain shell runner and the free OpenCode patch
 * adapter), and Tier C (`MaintainTierCFixer` over the same shell runner, the
 * real `WindowsJobObjectSandbox`, and whichever free OpenCode route is
 * reachable).
 *
 * NOW WIRED (the gap the porting spec §5 gap 4 flagged is closed): real
 * crash + hang SIGNAL SOURCES self-trigger. `startDetection()` constructs and
 * starts `services/maintain/crash-watcher.ts`'s `CrashArtifactWatcher` against
 * `services/maintain/app-inventory.ts`'s `WindowsAppInventory` (the matcher +
 * frontmost tracker + slug→stack dict), and runs a ~2s hang-probe tick over
 * whatever catalog app is frontmost, buffering a confirmed hang until it
 * recovers/exits before asking (the `confirmedHangByPid` latch, mirroring
 * macOS's `CompanionManager.startMaintainMode`). This became wireable once a
 * Windows catalog app with a known exe exists: `services/autopilot/recipes.ts`
 * now carries GemAir's own catalogue (Ollama, VS Code), whose installed
 * executables `WindowsAppInventory` recognizes. `reportNativeCrash`/
 * `reportConfirmedHang`/`reportLaunchFailure` remain the seam the watchers call
 * (and the env-gated `triggerDemoIncidentIfConfigured` still exercises the
 * whole ladder with no real crash). The hang TICK is gated to Windows —
 * `checkProcessResponsiveViaPowerShell` and the foreground read both need
 * `powershell.exe` — so the Mac dev build does not spawn a failing probe every
 * two seconds; the crash watcher itself starts everywhere (it watches Windows
 * paths that simply do not exist on the Mac, so it stays quiet there).
 *
 * STILL not wired here, flagged rather than silently skipped (porting spec §5):
 *
 *   - Launch-failure detection has no watcher yet — `reportLaunchFailure`
 *     exists for an autopilot/direct-launch path to call, but nothing calls it
 *     automatically (there is no Windows "process died seconds after spawn"
 *     signal source in this repo).
 *   - `installedVersionLookup`. There is no Windows analog of macOS's
 *     `AppInventoryService` in this repo yet, so a pooled recipe's
 *     `applicability.app_version` range is matched against whatever version
 *     the crash/hang signal itself carried (`ParsedWindowsCrash.appVersion`),
 *     never a separately-looked-up installed version. Wiring a real
 *     `installedVersionLookup` closure through here is additive once that
 *     service exists.
 *   - PAID BYO KEYS ARE GONE. Upstream ran Tier C and Tier B's patch adapter on
 *     the reader's own paid credential — Anthropic preferred, OpenAI as a
 *     fallback — on the rule that publik's funded proxy must never pay for the
 *     fix loop, and skipped Tier C entirely when neither key was set. GemAir has
 *     no funded proxy and no paid route at all: both now run on the free
 *     OpenCode routes (`services/maintain/model-provider.js`), the reader's own
 *     `opencode` binary first and the hosted free gateway second. The rule the
 *     BYO requirement existed to enforce is now enforced structurally, by the
 *     free-model gate in `services/opencode-models.js`, which refuses a paid
 *     model id before a request is built. Tier C is therefore no longer gated on
 *     the reader having configured anything.
 *     (The GitHub device-flow token pair, by contrast, was already persisted
 *     through `safeStorage` — see `github-token-storage.ts` — so a connected
 *     fork-backup survives relaunch, matching macOS's Keychain pair.)
 *
 * Install provenance IS now recorded on a real autopilot install finish:
 * `main/autopilot-controller.ts`'s `onFinished` hands the finished install to
 * this file's `recordInstallProvenance`, which runs the pure
 * `decideInstallProvenance` and calls `recordGuideSourceClone` /
 * `recordSignedDownload`. `InstallRecipe` now carries `canonicalRepo` and
 * `pinnedCommit`, closing the interlock `install-provenance.ts`'s header flagged.
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
exports.MaintainController = void 0;
const electron_1 = require("electron");
const path = __importStar(require("node:path"));
const secrets_1 = require("../secrets");
const maintain_shell_runner_1 = require("./maintain-shell-runner");
const opencode_session_1 = require("../opencode-session");
const state_store_1 = require("./state-store");
const incident_coordinator_1 = require("../../services/maintain/incident-coordinator");
const crash_watcher_1 = require("../../services/maintain/crash-watcher");
const hang_probe_1 = require("../../services/maintain/hang-probe");
const app_inventory_1 = require("../../services/maintain/app-inventory");
const incoming_fix_reviewer_1 = require("../../services/maintain/incoming-fix-reviewer");
const install_identity_1 = require("../../services/maintain/install-identity");
const install_provenance_1 = require("../../services/maintain/install-provenance");
const github_fork_service_1 = require("../../services/maintain/github-fork-service");
const github_token_storage_1 = require("./github-token-storage");
const model_provider_1 = require("../../services/maintain/model-provider");
const patch_queue_1 = require("../../services/maintain/patch-queue");
const pool_client_1 = require("../../services/maintain/pool-client");
const replay_engine_1 = require("../../services/maintain/replay-engine");
const sandbox_1 = require("../../services/maintain/sandbox");
const tier_c_fixer_1 = require("../../services/maintain/tier-c-fixer");
const trace_1 = require("../../services/maintain/trace");
/** How often the hang probe ticks over the frontmost catalog app — the direct
 *  port of macOS's `Timer.scheduledTimer(withTimeInterval: 2, ...)`. Four
 *  consecutive failed probes at this cadence is ~8–10s of confirmed silence
 *  before anything escalates (see `hang-probe.ts`). */
const HANG_PROBE_TICK_INTERVAL_MS = 2000;
class MaintainController {
    host;
    stateStore;
    poolClient;
    provenanceStore;
    installIdentity;
    patchQueue;
    gitHubForkService;
    replayEngine;
    coordinator;
    // MARK: - Detection (the always-on signal sources)
    appInventory;
    crashArtifactWatcher;
    hangProbe;
    hangProbeInterval;
    /** Guards against a slow foreground read overlapping the next 2s tick. */
    hangTickInFlight = false;
    /** The catalog app the last tick probed — read by the hang-verdict handler
     *  to attribute a confirmed hang to a slug/pid (mirrors macOS reading
     *  `NSWorkspace.frontmostApplication` inside its verdict closure). */
    lastProbedFrontmostApp;
    /** The hang the probe is currently tracking per pid, so the ask fires ONCE
     *  on recovery/exit rather than every tick — the Windows analog of macOS's
     *  `confirmedHangByPid`. Mutable `seconds` so a still-hanging app updates its
     *  duration in place. */
    confirmedHangByPid = new Map();
    constructor(host) {
        this.host = host;
        this.stateStore = new state_store_1.MaintainStateStore();
        this.poolClient = new pool_client_1.MaintainPoolClient();
        this.provenanceStore = new install_provenance_1.InstallProvenanceStore({ persistence: this.stateStore });
        this.installIdentity = new install_identity_1.MaintainInstallIdentity({ persistence: this.stateStore });
        this.patchQueue = new patch_queue_1.PatchQueue(new patch_queue_1.FileSystemPatchQueueStorage(path.join(this.userDataPath(), "patch-queue")));
        this.gitHubForkService = new github_fork_service_1.GitHubForkService({
            // Persisted for real through `safeStorage` (DPAPI), the Windows analog of
            // the Keychain pair `iris-macos` keeps — so a connected fork-backup
            // survives relaunch. See `github-token-storage.ts`.
            tokenStorage: new github_token_storage_1.SecretsBackedGitHubTokenStorage(),
            openExternal: (url) => {
                void electron_1.shell.openExternal(url);
            },
        });
        this.replayEngine = new replay_engine_1.RecipeReplayEngine({
            provenanceStore: this.provenanceStore,
            poolClient: this.poolClient,
            getCurrentInstallId: () => this.installIdentity.currentInstallId(),
            patchQueue: this.patchQueue,
            createShellRunner: maintain_shell_runner_1.createMaintainShellRunner,
            verificationCommandsForStack: incoming_fix_reviewer_1.defaultVerificationCommandsForStack,
            // Tier B's patch adapter. Upstream read the reader's paid Anthropic
            // key here and refused to run without one; GemAir's adapter is
            // structurally OpenCode-only and its model id goes through the
            // free-model gate, so it runs on the reader's own free-tier key when
            // they pasted one and on the public token when they did not.
            fixAdapter: new replay_engine_1.OpenCodePatchAdapter(() => (0, secrets_1.readSecret)("openCodeApiKey")),
        });
        this.coordinator = new incident_coordinator_1.MaintainIncidentCoordinator({
            poolClient: this.poolClient,
            provenanceStore: this.provenanceStore,
            replayEngine: this.replayEngine,
            persistence: this.stateStore,
            backUpFixBranch: (branchName, appSlug) => this.backUpFixBranch(branchName, appSlug),
            attemptNovelFix: (appSlug, appStack, signatureId, evidence) => this.attemptNovelFix(appSlug, appStack, signatureId, evidence),
            onStateChanged: (snapshot) => this.host.emitSnapshot(snapshot),
        });
        // The always-on detection layer. Constructed here; started by
        // `startDetection()` from `main/index.ts` after the app is ready.
        this.appInventory = new app_inventory_1.WindowsAppInventory();
        this.crashArtifactWatcher = new crash_watcher_1.CrashArtifactWatcher({ appMatcher: this.appInventory });
        this.crashArtifactWatcher.onCrashArtifactDetected = (artifact) => this.onCrashArtifactDetected(artifact);
        this.hangProbe = new hang_probe_1.HangProbe({
            checkResponsive: (processId) => (0, hang_probe_1.checkProcessResponsiveViaPowerShell)(processId),
            onVerdict: (processId, verdict) => this.onHangVerdict(processId, verdict),
        });
    }
    // MARK: - Detection lifecycle
    /**
     * Starts the always-on signal sources: the crash-artifact watch (event-
     * driven, free) and — on Windows only — the ~2s hang-probe tick over the
     * frontmost catalog app. Called once from `main/index.ts`'s bootstrap.
     * Mirrors macOS `CompanionManager.startMaintainMode`; everything funnels into
     * the coordinator, whose only output is a question.
     */
    startDetection() {
        void this.appInventory.refreshCatalog();
        void this.crashArtifactWatcher.start();
        // The probe mechanism (`Get-Process ... Responding`) and the foreground
        // read are PowerShell — Windows only. The Mac dev build starts the crash
        // watcher (harmless on non-Windows paths) but not this tick, so it never
        // spawns a failing `powershell.exe` every two seconds.
        if (process.platform === "win32" && this.hangProbeInterval === undefined) {
            this.hangProbeInterval = setInterval(() => void this.hangProbeTick(), HANG_PROBE_TICK_INTERVAL_MS);
        }
    }
    /** Stops the detection layer. Not wired to a quit path today (GemAir is a tray
     *  app whose windows closing does not quit it), but symmetrical and used by
     *  tests. */
    stopDetection() {
        this.crashArtifactWatcher.stop();
        if (this.hangProbeInterval !== undefined) {
            clearInterval(this.hangProbeInterval);
            this.hangProbeInterval = undefined;
        }
    }
    /** A crash artifact for one of ours landed — hand it to the coordinator as a
     *  native crash, with the app's display name resolved from the inventory. */
    onCrashArtifactDetected(artifact) {
        this.reportNativeCrash({
            parsedCrash: artifact.report,
            appSlug: artifact.catalogAppSlug,
            appName: this.appInventory.appNameForSlug(artifact.catalogAppSlug),
            appStack: artifact.catalogAppStack,
        });
    }
    /** One 2s tick: probe whatever catalog app is frontmost, if any. A no-op
     *  when nothing of ours is in front. Guarded so a slow foreground read never
     *  overlaps the next tick. */
    async hangProbeTick() {
        if (this.hangTickInFlight)
            return;
        this.hangTickInFlight = true;
        try {
            const frontmost = await this.appInventory.frontmostCatalogApp();
            this.lastProbedFrontmostApp = frontmost;
            if (frontmost === undefined)
                return;
            await this.hangProbe.probe(frontmost.pid);
        }
        finally {
            this.hangTickInFlight = false;
        }
    }
    /**
     * Buffers a confirmed hang until it RECOVERS or EXITS, then asks — never
     * mid-hang, when a modal would land on someone already struggling. Straight
     * port of macOS's `hangProbe.onVerdict` closure and its `confirmedHangByPid`
     * bookkeeping. A `processDisappeared` also notes the exit to the crash
     * watcher, so a crash artifact that lands right after is corroborated.
     */
    onHangVerdict(processId, verdict) {
        switch (verdict.kind) {
            case "confirmedHang": {
                const alreadyTracking = this.confirmedHangByPid.get(processId);
                if (alreadyTracking !== undefined) {
                    alreadyTracking.seconds = verdict.unresponsiveSeconds;
                }
                else if (this.lastProbedFrontmostApp?.pid === processId) {
                    const frontmost = this.lastProbedFrontmostApp;
                    this.confirmedHangByPid.set(processId, {
                        slug: frontmost.slug,
                        appName: frontmost.appName,
                        stack: frontmost.stack,
                        exeName: (0, app_inventory_1.windowsCatalogAppForSlug)(frontmost.slug)?.exeName,
                        seconds: verdict.unresponsiveSeconds,
                    });
                }
                break;
            }
            case "responsive":
            case "processDisappeared": {
                const hang = this.confirmedHangByPid.get(processId);
                if (hang !== undefined) {
                    this.confirmedHangByPid.delete(processId);
                    this.reportConfirmedHang({
                        appSlug: hang.slug,
                        appName: hang.appName,
                        appStack: hang.stack,
                        unresponsiveSeconds: hang.seconds,
                    });
                }
                if (verdict.kind === "processDisappeared") {
                    const exeName = hang?.exeName ?? (0, app_inventory_1.windowsCatalogAppForSlug)(this.lastProbedFrontmostApp?.slug ?? "")?.exeName;
                    if (exeName !== undefined) {
                        this.crashArtifactWatcher.noteProcessExited(exeName);
                    }
                }
                break;
            }
            case "unresponsiveButBelowThreshold":
                break;
        }
    }
    // MARK: - Signal entry points (the future watchers' call shape — see the
    // module header for why nothing in this repo calls these for real yet)
    /** Called by a real crash watcher once one exists (see the module header).
     *  Exposed today so `triggerDemoIncidentIfConfigured` has a single,
     *  identical way in. */
    reportNativeCrash(options) {
        this.coordinator.handleNativeCrash(options);
    }
    /** Called by a real hang probe once one is wired to a live process id. */
    reportConfirmedHang(options) {
        this.coordinator.handleConfirmedHang(options);
    }
    /** Called by an autopilot/direct-launch path that notices a spawn failure
     *  or an immediate non-zero exit — see `incident-coordinator.ts`'s
     *  `handleLaunchFailure` header for why this is genuinely new surface, not
     *  a Swift parity item. */
    reportLaunchFailure(options) {
        this.coordinator.handleLaunchFailure(options);
    }
    /**
     * Proves the whole ladder end to end with no real crash — the maintain-mode
     * analog of `GEMAIR_AUTOPILOT_DEMO`. Reads `GEMAIR_MAINTAIN_DEMO_CRASH=<slug>`
     * (a catalog app slug) at startup; when set, raises a synthetic native-crash
     * ask for that app a few seconds after the app is ready, so the ask card,
     * the pool round trip, and the fix ladder are all visibly exercised without
     * waiting for a real Windows crash artifact or a catalog app with a known
     * exe to match against.
     */
    triggerDemoIncidentIfConfigured() {
        const demoSlug = process.env.GEMAIR_MAINTAIN_DEMO_CRASH;
        if (!demoSlug || demoSlug.length === 0)
            return;
        (0, trace_1.maintainTrace)(`maintain: GEMAIR_MAINTAIN_DEMO_CRASH=${demoSlug} — raising a synthetic ask in 3s`);
        setTimeout(() => {
            this.reportNativeCrash({
                appSlug: demoSlug,
                appName: demoSlug,
                appStack: "electron",
                parsedCrash: {
                    appName: `${demoSlug}.exe`,
                    exceptionCode: "c0000005",
                    faultingModuleName: `${demoSlug}.exe`,
                    faultingOffset: "0x00001234",
                },
            });
        }, 3000);
    }
    // MARK: - Install provenance (the D4 gate's ground truth)
    /**
     * Records how an app just got onto this machine, called from
     * `main/autopilot-controller.ts`'s `onFinished` — the one moment provenance
     * is knowable for certain. The Windows mirror of macOS
     * `CompanionManager.recordInstallProvenance`: a `desktop_app` build that
     * cloned source becomes a `guide_source_clone` maintain mode may patch; any
     * other `desktop_app` install a `signed_app_download` it never may; a
     * `local_web`/`credential` install records nothing (there is no built binary
     * with a trust boundary). The provenance decision itself is the pure
     * `decideInstallProvenance`; this method only dispatches it to the store.
     */
    recordInstallProvenance(finishedInstall) {
        const decision = (0, install_provenance_1.decideInstallProvenance)({
            outputType: finishedInstall.output.type,
            clonedARepo: finishedInstall.clonedARepo,
            clonePath: finishedInstall.clonePath,
            canonicalRepo: finishedInstall.canonicalRepo,
            pinnedCommit: finishedInstall.pinnedCommit,
        });
        switch (decision.kind) {
            case "guide_source_clone":
                this.provenanceStore.recordGuideSourceClone({
                    appSlug: finishedInstall.slug,
                    clonePath: decision.clonePath,
                    pinnedCommit: decision.pinnedCommit,
                    canonicalRepo: decision.canonicalRepo,
                });
                break;
            case "signed_app_download":
                this.provenanceStore.recordSignedDownload(finishedInstall.slug);
                break;
            case "none":
                (0, trace_1.maintainTrace)(`maintain: nothing to record for ${finishedInstall.slug || "install"} (${finishedInstall.output.type} install)`);
                break;
        }
    }
    // MARK: - IPC-driven surface (see `main/index.ts`'s `setupIPC`)
    currentSnapshot() {
        return this.coordinator.currentSnapshot();
    }
    answerAsk(answer) {
        this.coordinator.answerPendingAsk(answer);
        return this.coordinator.currentSnapshot();
    }
    clearFixStatus() {
        this.coordinator.clearFixStatus();
        return this.coordinator.currentSnapshot();
    }
    mutedApps() {
        return this.coordinator.mutedApps();
    }
    unmuteApp(appSlug) {
        this.coordinator.unmuteApp(appSlug);
    }
    // MARK: - The two coordinator-injected async closures
    /** Tier C: no pooled recipe fit, but the user brought a BYO key and this
     *  install is a patchable source clone (the D4 gate, already checked by
     *  the coordinator before this is ever called). */
    async attemptNovelFix(appSlug, appStack, signatureId, evidence) {
        const modelProvider = (0, model_provider_1.firstAvailableMaintainProvider)({
            // The reader's own `opencode` binary first: it needs no credential
            // from GemAir at all, and it is already signed in to whatever they
            // signed it into.
            probeOpenCodeCli: () => (0, opencode_session_1.openCodeIsAvailable)(),
            createOpenCodeCliBackend: (model) => new opencode_session_1.OpenCodeChatBackend({ model }),
            // Otherwise the hosted free gateway. Upstream required a paid BYO key
            // here (Anthropic preferred, OpenAI as a fallback) on the rule that a
            // funded proxy must never pay for the fix loop. GemAir has no funded
            // proxy and no paid route: the rule is kept by the free-model gate in
            // `services/opencode-models.js`, which refuses a paid model id before
            // a request is built, so Tier C cannot spend the reader's money even
            // if they have an account that could.
            readOpenCodeApiKey: () => (0, secrets_1.readSecret)("openCodeApiKey"),
        });
        if (modelProvider === undefined) {
            (0, trace_1.maintainTrace)("maintain: Tier C skipped — no model route is reachable");
            return undefined;
        }
        const record = this.provenanceStore.provenanceForAppSlug(appSlug);
        if (record === null || record.clonePath === null) {
            // Should not happen — the coordinator already checked
            // `localPatchingIsPermitted` before calling this — but this file fails
            // closed rather than handing `MaintainTierCFixer` a path it cannot use.
            return undefined;
        }
        const fixer = new tier_c_fixer_1.MaintainTierCFixer({
            provider: modelProvider,
            createShellRunner: maintain_shell_runner_1.createMaintainShellRunner,
            sandbox: new sandbox_1.WindowsJobObjectSandbox(),
            verificationCommandsForStack: incoming_fix_reviewer_1.defaultVerificationCommandsForStack,
        });
        const result = await fixer.attemptFix({
            clonePath: record.clonePath,
            appSlug,
            appStack,
            signatureId,
            crashEvidence: evidence,
        });
        if (result.type !== "fixedAndVerified") {
            (0, trace_1.maintainTrace)(`maintain: Tier C did not produce a fix (${result.type}: ${result.reason})`);
            return undefined;
        }
        return result.branchName;
    }
    /** Backs a verified fix branch up to the user's GitHub fork (or, if the
     *  connected user owns the canonical repo, merges it straight in) — the
     *  ownership-aware propagation `github-fork-service.ts`'s `propagateFix`
     *  already implements. Absence of a summary is never an error: the fix is
     *  safe locally either way, per that module's own contract. */
    async backUpFixBranch(branchName, appSlug) {
        const record = this.provenanceStore.provenanceForAppSlug(appSlug);
        if (record === null || record.clonePath === null || record.canonicalRepo === null) {
            return undefined;
        }
        const runner = (0, maintain_shell_runner_1.createMaintainShellRunner)(record.clonePath);
        if (runner === undefined) {
            return undefined;
        }
        const propagation = await this.gitHubForkService.propagateFix({
            branch: branchName,
            canonicalRepo: record.canonicalRepo,
            diagnosisTitle: this.coordinator.currentLastConfirmedDiagnosisTitle() ?? `Fix for ${appSlug}`,
            cloneRunner: runner,
        });
        switch (propagation.type) {
            case "merged_to_canonical":
                return `Merged straight into ${propagation.repo}`;
            case "pull_request_opened":
                return `Opened a fix PR (#${propagation.number}) on ${appSlug}'s repo for its owner to review`;
            case "backed_up_only":
                return `Backed up to your fork (${propagation.branch})`;
            case "not_connected":
            case "failed":
                // Not connected / a transient failure — no summary line, never an
                // error surfaced to the user. See the module header.
                return undefined;
        }
    }
    userDataPath() {
        return electron_1.app.isReady() ? electron_1.app.getPath("userData") : path.join(process.env.APPDATA || process.env.HOME || ".", "gemair");
    }
}
exports.MaintainController = MaintainController;
