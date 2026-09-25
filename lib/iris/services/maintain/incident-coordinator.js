"use strict";
/**
 * incident-coordinator.ts
 *
 * The Windows port of `iris-macos/leanring-buddy/MaintainIncidentCoordinator.swift`.
 *
 * The ladder that turns raw signals into (at most) one careful question:
 *
 *     L1  a native crash artifact arrives      (CrashArtifactWatcher, free)
 *     L2  a launch failure is detected         (an autopilot-adjacent watch, free — NEW, §2.3 below)
 *     L3  a hang is confirmed                  (HangProbe, near-free)
 *     L5  signature + recipe cache lookup      (one HTTP GET, zero tokens)
 *     L6  ask the user                         (rate-limited, mutable, honest)
 *     —   on "yes": file to the pool           (the D2 filing)
 *     —   on "yes": Tier A/B replay, else Tier C if the user brought a key
 *
 * The ask is the accuracy layer, not a courtesy — a detector that acts on its
 * own suspicion becomes a nag nobody trusts. So: only a crash, a launch
 * failure, and a confirmed hang may raise an ask in v1, matching the three
 * public entry points below (`handleNativeCrash`, `handleLaunchFailure`,
 * `handleConfirmedHang`) — there is no fourth one, on purpose, mirroring
 * Swift's own comment that "crashes and confirmed hangs may ask; nothing else
 * in v1." No model call happens before a "yes" — there is no model call
 * anywhere in this file; Tier B/C fix work is downstream, behind
 * `RecipeReplayEngine`/the injected `attemptNovelFix` closure, and BYO-gated.
 *
 * ## `handleLaunchFailure` is genuinely new surface, not a Swift parity item
 *
 * Per the porting spec §2.3: `MaintainIncidentCoordinator.swift` has exactly
 * two live entry points (`handleCrashArtifact`, `handleConfirmedHang`) — there
 * is no Swift launch-failure *watcher* to port, because macOS has no analogous
 * "the process exited within a few seconds of being spawned" signal that isn't
 * already covered by the crash-artifact path. `launchFailureSignature` already
 * exists in `break-signature.ts` (shared vocabulary with the pool's
 * `signatures.signature_kind` check constraint), but nothing called it until
 * this file added `handleLaunchFailure`. Shaped identically to the other two
 * entry points for consistency: the caller (an autopilot/direct-launch path
 * noticing a spawn failure or an immediate non-zero exit) has already decided
 * this IS the signal — no polling, no diagnosis performed here, matching how
 * the other two entry points are event-driven rather than scanned.
 *
 * ## Continuous state, not discrete events
 *
 * Unlike `autopilot/runner.ts`'s `AutopilotRunner` — a *pumped* machine whose
 * caller drains a queue of discrete events — this coordinator holds
 * continuously-observed state (Swift's `@Published var pendingAsk`,
 * `fixStatusLine`, ...) that can change on its own, mid-flight, when a
 * background recipe lookup or a background replay/Tier-C attempt completes.
 * That needs a push, not a pull, so the constructor takes an optional
 * `onStateChanged: (snapshot) => void` callback — the same idiom
 * `GitHubForkService.connect(onStateChange)` already uses in this package for
 * exactly the same reason (a device-flow poll transitions state without the
 * caller calling anything). `currentSnapshot()` is also exposed for a plain
 * pull (an IPC handler answering "what's the state right now").
 *
 * ## Windows signal sources — not this file's job
 *
 * `handleNativeCrash`/`handleLaunchFailure`/`handleConfirmedHang` are the
 * coordinator's whole surface for *arriving* signals; where those signals
 * come from is deliberately out of scope here, matching the porting spec's
 * module boundary: `services/maintain/crash-watcher.ts` (the WER report +
 * Application-Error event log watcher, §2.1) and `services/maintain/hang-probe.ts`
 * (the pure state machine plus the real `Get-Process ... Responding` call,
 * §2.2) already exist as this repo's siblings of this file, but this
 * coordinator does not import either of them — it does not assume anything
 * about how or when its three `handle*` methods get called, so wiring a real
 * watcher up to them is additive, not a change to this file. As of this
 * writing `main/maintain/controller.ts` (this task's own composition root)
 * does not yet call a real crash/hang watcher either: there is no Windows
 * catalog app with a known `.exe` launch target anywhere in this repo yet (see
 * `services/autopilot/recipes.ts` — its one built-in recipe, OpenASCII, is a
 * `local_web` app with no exe at all), so a live `CrashArtifactWatcher` would
 * have zero real entries to match against — see the porting spec §5 gap 4.
 * `main/maintain/controller.ts` instead exposes the same-shaped
 * `reportNativeCrash`/`reportConfirmedHang`/`reportLaunchFailure` methods a
 * real watcher will call once one exists, plus a narrow, env-var-gated manual
 * trigger for demoing/proving the ladder end to end today, the same way
 * `GEMAIR_AUTOPILOT_DEMO` proves the autopilot end to end with no real guide
 * click.
 *
 * ## Persistence
 *
 * The mute list, the suppressed-signature set, the per-app last-ask
 * timestamp, and the per-day incident counts are one read-all/write-all seam
 * (`MaintainIncidentGatePersistence`), matching the shape
 * `install-provenance.ts`'s `InstallProvenancePersistence` and
 * `install-identity.ts`'s `InstallIdentityPersistence` already established in
 * this package. The real implementation (`main/maintain/state-store.ts`)
 * backs all three seams with one `userData/maintain.json` file; this file
 * only depends on the narrow interface below, never on `electron` or that
 * file directly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintainIncidentCoordinator = exports.MINIMUM_MS_BETWEEN_ASKS_PER_APP = exports.MAXIMUM_INCIDENTS_PER_APP_PER_DAY = exports.InMemoryMaintainIncidentGatePersistence = exports.EMPTY_MAINTAIN_INCIDENT_GATE_STATE = void 0;
const node_crypto_1 = require("node:crypto");
const break_signature_1 = require("./break-signature");
const install_identity_1 = require("./install-identity");
const trace_1 = require("./trace");
const EMPTY_SNAPSHOT = {
    pendingAsk: null,
    recipesForPendingAsk: [],
    fixStatusLine: null,
    fixGuidanceSteps: [],
};
exports.EMPTY_MAINTAIN_INCIDENT_GATE_STATE = {
    mutedAppSlugs: [],
    suppressedSignatureIds: [],
    lastAskEpochMsByAppSlug: {},
    incidentCountsByDayAndApp: {},
};
/** In-memory implementation for tests and for any caller without a real
 *  `userData`-backed store wired up — mirrors `InMemoryInstallProvenancePersistence`
 *  and `InMemoryInstallIdentityPersistence` in this package. */
class InMemoryMaintainIncidentGatePersistence {
    state = exports.EMPTY_MAINTAIN_INCIDENT_GATE_STATE;
    readGateState() {
        return this.state;
    }
    writeGateState(state) {
        this.state = state;
    }
}
exports.InMemoryMaintainIncidentGatePersistence = InMemoryMaintainIncidentGatePersistence;
/** UTC `yyyy-MM-dd` — `toISOString` is always UTC, matching Swift's explicit
 *  `TimeZone(identifier: "UTC")` formatter. */
function utcDateString(epochMs) {
    return new Date(epochMs).toISOString().slice(0, 10);
}
/** Drops every incident-count key that is not today's, so the persisted
 *  record cannot grow one entry per app per day forever. Mirrors Swift's
 *  `persistCounters`, which re-prunes on every save (mute/suppress/ask alike),
 *  not only when a day rolls over. */
function pruneIncidentCountsToToday(counts, todayDateString) {
    const pruned = {};
    const prefix = `${todayDateString}|`;
    for (const [key, value] of Object.entries(counts)) {
        if (key.startsWith(prefix)) {
            pruned[key] = value;
        }
    }
    return pruned;
}
// ---------------------------------------------------------------------------
// The budget latch — copied verbatim from Swift for parity (porting spec §3).
// ---------------------------------------------------------------------------
/** At most this many *incidents* (asks raised, not just confirmed) count
 *  against one app in one UTC day. */
exports.MAXIMUM_INCIDENTS_PER_APP_PER_DAY = 3;
/** The minimum gap between two unsolicited asks about the same app. */
exports.MINIMUM_MS_BETWEEN_ASKS_PER_APP = 24 * 60 * 60 * 1000;
/**
 * The ladder described in the module header. One instance per app lifetime:
 * it holds the pending ask (if any), the per-ask bookkeeping needed to answer
 * it, and the persisted ask-gate state.
 */
class MaintainIncidentCoordinator {
    static MAXIMUM_INCIDENTS_PER_APP_PER_DAY = exports.MAXIMUM_INCIDENTS_PER_APP_PER_DAY;
    static MINIMUM_MS_BETWEEN_ASKS_PER_APP = exports.MINIMUM_MS_BETWEEN_ASKS_PER_APP;
    // MARK: - Observed state (mirrors Swift's @Published properties)
    pendingAsk = null;
    recipesForPendingAsk = [];
    fixStatusLine = null;
    fixGuidanceSteps = [];
    /** The evidence sentence of the most recent confirmed break — the fix's
     *  human title for the commit, the PR, and the fix log. */
    lastConfirmedDiagnosisTitle = null;
    // MARK: - Per-ask bookkeeping, kept out of the published snapshot so the UI
    // layer never holds signature/frame data.
    signaturesByAskId = new Map();
    appVersionsByAskId = new Map();
    /** The frozen, scrubbed crash evidence per ask — Tier C's only bug
     *  description. Consumed (and deleted) the moment an ask is answered,
     *  whichever way it was answered — see `answerPendingAsk`. */
    evidenceByAskId = new Map();
    // MARK: - Collaborators
    poolClient;
    provenanceStore;
    replayEngine;
    persistence;
    installedVersionLookup;
    backUpFixBranch;
    attemptNovelFix;
    resolveMachineArchitecture;
    generateAskId;
    nowEpochMs;
    onStateChanged;
    gateState;
    constructor(options) {
        this.poolClient = options.poolClient;
        this.provenanceStore = options.provenanceStore;
        this.replayEngine = options.replayEngine;
        this.persistence = options.persistence;
        this.installedVersionLookup = options.installedVersionLookup;
        this.backUpFixBranch = options.backUpFixBranch;
        this.attemptNovelFix = options.attemptNovelFix;
        this.resolveMachineArchitecture = options.resolveMachineArchitecture ?? install_identity_1.machineArchitecture;
        this.generateAskId = options.generateAskId ?? node_crypto_1.randomUUID;
        this.nowEpochMs = options.nowEpochMs ?? (() => Date.now());
        this.onStateChanged = options.onStateChanged;
        this.gateState = this.persistence.readGateState();
    }
    // MARK: - Signal entry points
    /**
     * A native crash for one of ours. The only path that may ask immediately
     * (besides `handleLaunchFailure`) — a crash is unambiguous evidence
     * something ended wrong. Windows analog of Swift's `handleCrashArtifact`:
     * there is no walked stack, so the evidence sentence and the frozen Tier-C
     * evidence are built from `nativeCrashSignature`'s single synthetic frame
     * instead of a stack walk — see `break-signature.ts`'s header for why that
     * is a deliberate parity behavior, not a gap.
     */
    handleNativeCrash(options) {
        const { parsedCrash, appSlug, appName, appStack } = options;
        const signature = (0, break_signature_1.nativeCrashSignature)(parsedCrash, appSlug, appStack);
        const evidenceLines = [`Exception: ${parsedCrash.exceptionCode ?? "unknown"}`, `Signature: ${signature.protoSignature}`];
        for (const frame of signature.topFrames) {
            evidenceLines.push(`  at ${frame.module}!${frame.function}`);
        }
        this.considerAsking({
            signature,
            appSlug,
            appName,
            appVersion: parsedCrash.appVersion,
            evidenceSentence: `${appName} quit unexpectedly a moment ago.`,
            frozenEvidence: evidenceLines.join("\n"),
        });
    }
    /**
     * A launch that failed immediately — see the file header's "genuinely new
     * surface" section. `daemon` names what was being launched (an exe name);
     * `reason` is the caller's free-text explanation (a non-zero exit code, an
     * `ENOENT` spawn failure, ...), normalized by `launchFailureSignature`
     * itself.
     */
    handleLaunchFailure(options) {
        const { appSlug, appName, appStack, daemon, reason } = options;
        const signature = (0, break_signature_1.launchFailureSignature)(appSlug, appStack, daemon, reason);
        this.considerAsking({
            signature,
            appSlug,
            appName,
            appVersion: undefined,
            evidenceSentence: `${appName} didn't start just now.`,
            // No stack to hand Tier C, same reasoning as a hang: the pool/replay
            // path is where a launch failure gets fixed, not novel derivation from
            // a bare exit code.
            frozenEvidence: `Launch failure: ${signature.protoSignature} (daemon: ${daemon}, reason: ${reason})`,
        });
    }
    /**
     * A hang that recovered or ended — asked about after the fact, never
     * mid-hang. The probe's gating (`hang-probe.ts`'s
     * `HANG_PROBE_CONSECUTIVE_FAILURES_BEFORE_CONFIRMING`) already required N
     * consecutive `not_responding` reads before calling this. Straight port of
     * Swift's `handleConfirmedHang`.
     */
    handleConfirmedHang(options) {
        const { appSlug, appName, appStack, unresponsiveSeconds } = options;
        const signature = (0, break_signature_1.hangSignature)(appSlug, appStack, null);
        this.considerAsking({
            signature,
            appSlug,
            appName,
            appVersion: undefined,
            evidenceSentence: `${appName} stopped responding for about ${unresponsiveSeconds} seconds.`,
            // A hang has no stack to hand Tier C; the pool/replay path is where a
            // hang gets fixed, not novel derivation.
            frozenEvidence: `Hang: ${signature.protoSignature} (unresponsive ~${unresponsiveSeconds}s)`,
        });
    }
    // MARK: - The ask gate
    considerAsking(options) {
        const { signature, appSlug, appName, appVersion, evidenceSentence, frozenEvidence } = options;
        if (this.pendingAsk !== null) {
            (0, trace_1.maintainTrace)("maintain: ask suppressed (one already pending)");
            return;
        }
        if (this.gateState.mutedAppSlugs.includes(appSlug)) {
            (0, trace_1.maintainTrace)(`maintain: ask suppressed (${appSlug} muted)`);
            return;
        }
        if (this.gateState.suppressedSignatureIds.includes(signature.signatureId)) {
            (0, trace_1.maintainTrace)("maintain: ask suppressed (signature marked benign by the user)");
            return;
        }
        const nowMs = this.nowEpochMs();
        const lastAskEpochMs = this.gateState.lastAskEpochMsByAppSlug[appSlug];
        if (lastAskEpochMs !== undefined && nowMs - lastAskEpochMs < exports.MINIMUM_MS_BETWEEN_ASKS_PER_APP) {
            (0, trace_1.maintainTrace)(`maintain: ask suppressed (${appSlug} asked within 24h)`);
            return;
        }
        const dayKey = `${utcDateString(nowMs)}|${appSlug}`;
        const incidentCountToday = this.gateState.incidentCountsByDayAndApp[dayKey] ?? 0;
        if (incidentCountToday >= exports.MAXIMUM_INCIDENTS_PER_APP_PER_DAY) {
            (0, trace_1.maintainTrace)(`maintain: ask suppressed (${appSlug} at daily incident cap)`);
            return;
        }
        this.updateGateState((current) => ({
            ...current,
            lastAskEpochMsByAppSlug: { ...current.lastAskEpochMsByAppSlug, [appSlug]: nowMs },
            incidentCountsByDayAndApp: pruneIncidentCountsToToday({ ...current.incidentCountsByDayAndApp, [dayKey]: incidentCountToday + 1 }, utcDateString(nowMs)),
        }));
        const askId = this.generateAskId();
        const ask = { id: askId, appSlug, appName, evidenceSentence, signatureId: signature.signatureId };
        this.signaturesByAskId.set(askId, signature);
        if (appVersion !== undefined) {
            this.appVersionsByAskId.set(askId, appVersion);
        }
        this.evidenceByAskId.set(askId, frozenEvidence);
        this.pendingAsk = ask;
        this.recipesForPendingAsk = [];
        this.fixStatusLine = null;
        this.fixGuidanceSteps = [];
        (0, trace_1.maintainTrace)(`maintain: ASK raised for ${appSlug} (${signature.kind} ${signature.signatureId})`);
        this.emitStateChanged();
        // The cache lookup starts now (zero tokens, one GET) so a "yes" can show
        // a known fix immediately instead of a spinner.
        void this.poolClient
            .lookupRecipes({
            appSlug,
            signatureId: signature.signatureId,
            fingerprintStrict: signature.fingerprintStrict,
            fingerprintLoose: signature.fingerprintLoose,
        })
            .then((answer) => {
            // The ask may already have been answered by the time this lands — a
            // pending ask blocks a new one, so it can never have been superseded,
            // but matching Swift's own defensive re-check costs nothing.
            if (this.pendingAsk?.id !== askId)
                return;
            this.recipesForPendingAsk = answer.recipes;
            if (answer.matchedBy !== null) {
                (0, trace_1.maintainTrace)(`maintain: cache HIT via ${answer.matchedBy} — ${answer.recipes.length} recipe(s)`);
            }
            this.emitStateChanged();
        });
    }
    // MARK: - Answers
    /**
     * The user answered the pending ask. A no-op when there is none pending
     * (mirrors Swift's `guard let ask = pendingAsk else { return }`).
     */
    answerPendingAsk(answer) {
        const ask = this.pendingAsk;
        if (ask === null)
            return;
        const signature = this.signaturesByAskId.get(ask.id);
        this.signaturesByAskId.delete(ask.id);
        const appVersion = this.appVersionsByAskId.get(ask.id);
        this.appVersionsByAskId.delete(ask.id);
        const frozenEvidence = this.evidenceByAskId.get(ask.id) ?? signature?.protoSignature ?? "";
        this.evidenceByAskId.delete(ask.id);
        const recipes = this.recipesForPendingAsk;
        this.pendingAsk = null;
        this.recipesForPendingAsk = [];
        switch (answer) {
            case "somethingIsBroken": {
                (0, trace_1.maintainTrace)(`maintain: user CONFIRMED break for ${ask.appSlug}`);
                this.lastConfirmedDiagnosisTitle = ask.evidenceSentence;
                if (signature === undefined)
                    break;
                this.fileConfirmedBreak(ask, signature, appVersion);
                // Tier A/B: a pooled recipe exists — replay or adapt it. No recipe
                // -> Tier C if the user brought a model key and this is a patchable
                // source clone; otherwise the honest funded-tier dead end.
                const bestRecipe = recipes.length > 0 ? recipes[0] : undefined;
                if (bestRecipe !== undefined) {
                    this.runReplay(bestRecipe, ask, signature, appVersion);
                }
                else if (this.attemptNovelFix !== undefined && this.provenanceStore.localPatchingIsPermitted(ask.appSlug)) {
                    this.runNovelFix(ask, signature, frozenEvidence);
                }
                else {
                    this.fixStatusLine = "Filed. No known fix yet — when one lands in the pool, GemAir will offer it.";
                }
                break;
            }
            case "thatWasMe": {
                // A labeled negative: this signature is benign on this machine (an
                // app that exits non-zero on quit, a kill the user meant).
                if (signature !== undefined) {
                    this.updateGateState((current) => current.suppressedSignatureIds.includes(signature.signatureId)
                        ? current
                        : { ...current, suppressedSignatureIds: [...current.suppressedSignatureIds, signature.signatureId] });
                }
                (0, trace_1.maintainTrace)("maintain: user said benign — signature suppressed");
                break;
            }
            case "neverAskAboutThisApp": {
                this.updateGateState((current) => current.mutedAppSlugs.includes(ask.appSlug)
                    ? current
                    : { ...current, mutedAppSlugs: [...current.mutedAppSlugs, ask.appSlug] });
                (0, trace_1.maintainTrace)(`maintain: ${ask.appSlug} permanently muted by the user`);
                break;
            }
        }
        this.emitStateChanged();
    }
    /** The D2 filing: consent was collected at signup; a confirmed break files
     *  without a second prompt. Publishing a FIX under the user's name stays a
     *  separate explicit ask downstream (the fork-backup connect flow). */
    fileConfirmedBreak(ask, signature, appVersion) {
        const topFrames = signature.topFrames.map((frame) => ({
            module: frame.module,
            function: frame.function,
            file: frame.sourceFile ?? "",
            is_app_frame: frame.isApplicationFrame,
        }));
        const filing = {
            appSlug: ask.appSlug,
            signature: signature.signatureId,
            appStack: signature.appStack,
            signatureKind: signature.kind,
            algoVersion: signature.algoVersion,
            fingerprintStrict: signature.fingerprintStrict,
            fingerprintLoose: signature.fingerprintLoose,
            title: ask.evidenceSentence,
            appVersion,
            protoSignature: signature.protoSignature,
            topFrames,
        };
        void this.poolClient.fileConfirmedBreak(filing).then((result) => {
            (0, trace_1.maintainTrace)(`maintain: filed break → ${result?.breakId ?? "FAILED, staged for retry"}`);
        });
    }
    /** The Tier-A/B replay, narrated honestly to the card at each stage.
     *  Straight port of Swift's `runReplay`. */
    runReplay(recipe, ask, signature, appVersion) {
        this.fixStatusLine = "Applying a known fix…";
        this.fixGuidanceSteps = [];
        this.emitStateChanged();
        void this.replayEngine
            .replay({
            recipe,
            appSlug: ask.appSlug,
            appStack: signature.appStack,
            installedAppVersion: appVersion ?? this.installedVersionLookup?.(ask.appSlug) ?? null,
            signatureId: signature.signatureId,
            machineArchitecture: this.resolveMachineArchitecture(),
        })
            .then(async (result) => {
            switch (result.type) {
                case "guidanceToShow":
                    this.fixStatusLine = "A known fix exists — here's what to do:";
                    this.fixGuidanceSteps = result.steps;
                    break;
                case "patchAppliedAndVerified": {
                    let line = `Fixed and rebuilt (branch ${result.branchName}). Relaunch ${ask.appName} to pick it up.`;
                    const summary = await this.backUpFixBranch?.(result.branchName, ask.appSlug);
                    if (summary !== undefined)
                        line = `${line} ${summary}.`;
                    this.fixStatusLine = line;
                    break;
                }
                case "patchRevertedAfterFailedVerification":
                    this.fixStatusLine = `The known fix applied but failed verification (${result.blockedStage}) — reverted, nothing changed.`;
                    break;
                case "patchDidNotApply":
                    this.fixStatusLine = "The known fix doesn't fit your version. Filed, so a refreshed fix can pool.";
                    break;
                case "patchingNotPermittedForThisInstall":
                    this.fixStatusLine = "A code fix exists, but this install isn't a source build GemAir may patch.";
                    break;
                case "outsideApplicabilityRange":
                    this.fixStatusLine = "A fix exists for other versions, but not yours yet. Filed.";
                    break;
            }
            this.emitStateChanged();
        });
    }
    /** Tier C: no pooled recipe fit, but the user has a model key and this is a
     *  source clone. Derive a fix from scratch, jailed and bounded, then
     *  through the same verification gate. Filing already happened. Straight
     *  port of Swift's `runNovelFix`. */
    runNovelFix(ask, signature, evidence) {
        const attemptNovelFix = this.attemptNovelFix;
        if (attemptNovelFix === undefined)
            return;
        this.fixStatusLine = "No known fix — GemAir is trying to work one out under your model key…";
        this.fixGuidanceSteps = [];
        this.emitStateChanged();
        void attemptNovelFix(ask.appSlug, signature.appStack, signature.signatureId, evidence).then(async (branchName) => {
            if (branchName !== undefined) {
                let line = `Worked out a fix and verified it (branch ${branchName}). Relaunch ${ask.appName} to pick it up.`;
                const summary = await this.backUpFixBranch?.(branchName, ask.appSlug);
                if (summary !== undefined)
                    line = `${line} ${summary}.`;
                this.fixStatusLine = line;
            }
            else {
                this.fixStatusLine = "GemAir couldn't work out a fix this time. It's filed, so a pooled fix can still reach you.";
            }
            this.emitStateChanged();
        });
    }
    /** The card's dismiss for the post-answer status. */
    clearFixStatus() {
        this.fixStatusLine = null;
        this.fixGuidanceSteps = [];
        this.emitStateChanged();
    }
    // MARK: - Settings surface
    /** The mute list, readable and reversible. */
    mutedApps() {
        return [...this.gateState.mutedAppSlugs].sort();
    }
    unmuteApp(appSlug) {
        this.updateGateState((current) => ({
            ...current,
            mutedAppSlugs: current.mutedAppSlugs.filter((slug) => slug !== appSlug),
        }));
    }
    // MARK: - Reads
    currentSnapshot() {
        if (this.pendingAsk === null && this.fixStatusLine === null && this.fixGuidanceSteps.length === 0) {
            return EMPTY_SNAPSHOT;
        }
        return {
            pendingAsk: this.pendingAsk,
            recipesForPendingAsk: this.recipesForPendingAsk,
            fixStatusLine: this.fixStatusLine,
            fixGuidanceSteps: this.fixGuidanceSteps,
        };
    }
    /** The evidence sentence of the most recent confirmed break — the fix's
     *  human title for the commit, the PR, and the fix log. */
    currentLastConfirmedDiagnosisTitle() {
        return this.lastConfirmedDiagnosisTitle;
    }
    // MARK: - Persistence + notification plumbing
    updateGateState(mutate) {
        this.gateState = mutate(this.gateState);
        this.persistence.writeGateState(this.gateState);
    }
    emitStateChanged() {
        this.onStateChanged?.(this.currentSnapshot());
    }
}
exports.MaintainIncidentCoordinator = MaintainIncidentCoordinator;
