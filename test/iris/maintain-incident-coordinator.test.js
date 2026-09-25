"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const incident_coordinator_1 = require("../../lib/iris/services/maintain/incident-coordinator");
/**
 * incident-coordinator.ts is the accuracy layer of maintain mode — the ladder
 * that turns raw signals into AT MOST one careful, rate-limited question. The
 * audit flagged it as the only maintain-mode orchestrator with zero direct
 * tests; this is that file. Every collaborator is an injected seam, so the
 * whole ask gate can be driven deterministically off a fake clock.
 */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));
function makePoolClient(overrides = {}) {
    return {
        lookupRecipes: vitest_1.vi.fn(async () => ({ recipes: [], matchedBy: null })),
        fileConfirmedBreak: vitest_1.vi.fn(async () => ({ breakId: "break-1" })),
        ...overrides,
    };
}
function makeProvenanceStore(localPatchingIsPermitted = false) {
    return { localPatchingIsPermitted: vitest_1.vi.fn(() => localPatchingIsPermitted) };
}
function makeReplayEngine(replayResult = { type: "patchAppliedAndVerified", branchName: "gemair/fix-abc" }) {
    return { replay: vitest_1.vi.fn(async () => replayResult) };
}
function makeCoordinator(options = {}) {
    const persistence = new incident_coordinator_1.InMemoryMaintainIncidentGatePersistence();
    const clock = { now: 1_700_000_000_000 };
    const snapshots = [];
    const poolClient = options.poolClient ?? makePoolClient();
    let askCounter = 0;
    const coordinator = new incident_coordinator_1.MaintainIncidentCoordinator({
        poolClient,
        provenanceStore: options.provenanceStore ?? makeProvenanceStore(),
        replayEngine: options.replayEngine ?? makeReplayEngine(),
        persistence,
        generateAskId: () => `ask-${(askCounter += 1)}`,
        nowEpochMs: () => clock.now,
        onStateChanged: (snapshot) => snapshots.push(snapshot),
        resolveMachineArchitecture: () => "x64",
        ...options,
    });
    return { coordinator, persistence, clock, snapshots, poolClient };
}
function crash(coordinator, appSlug = "demo", appName = "Demo") {
    const parsedCrash = {
        appName: `${appSlug}.exe`,
        exceptionCode: "c0000005",
        faultingModuleName: `${appSlug}.exe`,
        faultingOffset: "0000000000001234",
    };
    coordinator.handleNativeCrash({ parsedCrash, appSlug, appName, appStack: "electron" });
}
(0, vitest_1.describe)("MaintainIncidentCoordinator — the ask gate", () => {
    (0, vitest_1.it)("raises exactly one ask on a native crash, with an evidence sentence and a fired state change", () => {
        const { coordinator, snapshots } = makeCoordinator();
        crash(coordinator);
        const snapshot = coordinator.currentSnapshot();
        (0, vitest_1.expect)(snapshot.pendingAsk).not.toBeNull();
        (0, vitest_1.expect)(snapshot.pendingAsk?.appSlug).toBe("demo");
        (0, vitest_1.expect)(snapshot.pendingAsk?.evidenceSentence).toBe("Demo quit unexpectedly a moment ago.");
        (0, vitest_1.expect)(snapshots.length).toBeGreaterThanOrEqual(1);
    });
    (0, vitest_1.it)("suppresses a second ask while one is already pending", () => {
        const { coordinator } = makeCoordinator();
        crash(coordinator, "demo", "Demo");
        const firstAskId = coordinator.currentSnapshot().pendingAsk?.id;
        crash(coordinator, "other", "Other");
        // Still the first app's ask; the second never displaced it.
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk?.id).toBe(firstAskId);
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk?.appSlug).toBe("demo");
    });
    (0, vitest_1.it)("does not ask about a muted app", () => {
        const { coordinator } = makeCoordinator();
        crash(coordinator);
        coordinator.answerPendingAsk("neverAskAboutThisApp");
        (0, vitest_1.expect)(coordinator.mutedApps()).toContain("demo");
        // A new crash more than 24h later would otherwise be allowed by the rate gate.
        const { coordinator: c2, clock, persistence } = makeCoordinator();
        crash(c2);
        c2.answerPendingAsk("neverAskAboutThisApp");
        clock.now += incident_coordinator_1.MINIMUM_MS_BETWEEN_ASKS_PER_APP + 1;
        crash(c2);
        (0, vitest_1.expect)(c2.currentSnapshot().pendingAsk).toBeNull();
        (0, vitest_1.expect)(persistence.readGateState().mutedAppSlugs).toContain("demo");
    });
    (0, vitest_1.it)("unmuteApp reverses a mute", () => {
        const { coordinator } = makeCoordinator();
        crash(coordinator);
        coordinator.answerPendingAsk("neverAskAboutThisApp");
        (0, vitest_1.expect)(coordinator.mutedApps()).toContain("demo");
        coordinator.unmuteApp("demo");
        (0, vitest_1.expect)(coordinator.mutedApps()).not.toContain("demo");
    });
    (0, vitest_1.it)('"thatWasMe" suppresses that signature so an identical later crash never asks', () => {
        const { coordinator, clock } = makeCoordinator();
        crash(coordinator);
        coordinator.answerPendingAsk("thatWasMe");
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk).toBeNull();
        // Past the 24h gate, an identical-signature crash is still silent (benign).
        clock.now += incident_coordinator_1.MINIMUM_MS_BETWEEN_ASKS_PER_APP + 1;
        crash(coordinator);
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk).toBeNull();
    });
    (0, vitest_1.it)("enforces the 24h minimum gap between unsolicited asks about the same app", () => {
        const { coordinator, clock } = makeCoordinator();
        crash(coordinator);
        coordinator.answerPendingAsk("somethingIsBroken");
        // One hour later: still inside the 24h window → suppressed.
        clock.now += 60 * 60 * 1000;
        crash(coordinator);
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk).toBeNull();
        // Just past 24h → allowed again.
        clock.now += incident_coordinator_1.MINIMUM_MS_BETWEEN_ASKS_PER_APP;
        crash(coordinator);
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk).not.toBeNull();
    });
    (0, vitest_1.it)("answerPendingAsk is a no-op when nothing is pending", () => {
        const { coordinator, snapshots } = makeCoordinator();
        const before = snapshots.length;
        coordinator.answerPendingAsk("somethingIsBroken");
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk).toBeNull();
        (0, vitest_1.expect)(snapshots.length).toBe(before);
    });
});
(0, vitest_1.describe)("MaintainIncidentCoordinator — on confirmation", () => {
    (0, vitest_1.it)("files the break and records the diagnosis title", async () => {
        const poolClient = makePoolClient();
        const { coordinator } = makeCoordinator({ poolClient });
        crash(coordinator);
        coordinator.answerPendingAsk("somethingIsBroken");
        await flushMicrotasks();
        (0, vitest_1.expect)(poolClient.fileConfirmedBreak).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(coordinator.currentLastConfirmedDiagnosisTitle()).toBe("Demo quit unexpectedly a moment ago.");
    });
    (0, vitest_1.it)("replays the top pooled recipe when one matched the signature", async () => {
        const recipe = { id: "r1" };
        const poolClient = makePoolClient({ lookupRecipes: vitest_1.vi.fn(async () => ({ recipes: [recipe], matchedBy: "fingerprintStrict" })) });
        const replayEngine = makeReplayEngine({ type: "patchAppliedAndVerified", branchName: "gemair/fix-xyz" });
        const { coordinator } = makeCoordinator({ poolClient, replayEngine });
        crash(coordinator);
        await flushMicrotasks(); // let the cache lookup land so recipesForPendingAsk fills
        (0, vitest_1.expect)(coordinator.currentSnapshot().recipesForPendingAsk).toHaveLength(1);
        coordinator.answerPendingAsk("somethingIsBroken");
        await flushMicrotasks();
        (0, vitest_1.expect)(replayEngine.replay).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(coordinator.currentSnapshot().fixStatusLine).toContain("gemair/fix-xyz");
    });
    (0, vitest_1.it)("falls back to Tier C when no recipe matched but a BYO key and a patchable clone exist", async () => {
        const attemptNovelFix = vitest_1.vi.fn(async () => "gemair/fix-novel");
        const { coordinator } = makeCoordinator({
            provenanceStore: makeProvenanceStore(true),
            attemptNovelFix,
        });
        crash(coordinator);
        await flushMicrotasks();
        coordinator.answerPendingAsk("somethingIsBroken");
        await flushMicrotasks();
        (0, vitest_1.expect)(attemptNovelFix).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(coordinator.currentSnapshot().fixStatusLine).toContain("gemair/fix-novel");
    });
    (0, vitest_1.it)("lands on the honest 'no known fix yet' status with no recipe and no BYO key", async () => {
        const { coordinator } = makeCoordinator(); // provenance denies patching, no attemptNovelFix
        crash(coordinator);
        await flushMicrotasks();
        coordinator.answerPendingAsk("somethingIsBroken");
        await flushMicrotasks();
        (0, vitest_1.expect)(coordinator.currentSnapshot().fixStatusLine).toContain("No known fix yet");
    });
    (0, vitest_1.it)("clearFixStatus dismisses the post-answer status", async () => {
        const { coordinator } = makeCoordinator();
        crash(coordinator);
        coordinator.answerPendingAsk("somethingIsBroken");
        await flushMicrotasks();
        (0, vitest_1.expect)(coordinator.currentSnapshot().fixStatusLine).not.toBeNull();
        coordinator.clearFixStatus();
        (0, vitest_1.expect)(coordinator.currentSnapshot().fixStatusLine).toBeNull();
        (0, vitest_1.expect)(coordinator.currentSnapshot()).toEqual({
            pendingAsk: null,
            recipesForPendingAsk: [],
            fixStatusLine: null,
            fixGuidanceSteps: [],
        });
    });
});
