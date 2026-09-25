"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const crash_watcher_1 = require("../../lib/iris/services/maintain/crash-watcher");
const app_inventory_1 = require("../../lib/iris/services/maintain/app-inventory");
const incident_coordinator_1 = require("../../lib/iris/services/maintain/incident-coordinator");
const wer_signature_fixture_1 = require("./fixtures/wer-signature-fixture");
/**
 * The item-4 end-to-end: a REAL Windows crash artifact for the ollama
 * recipe's installed exe (`ollama app.exe`) flows through the real
 * `CrashArtifactWatcher` → the real `WindowsAppInventory` matcher → the real
 * `MaintainIncidentCoordinator`, which raises exactly one ask attributed to
 * ollama. This is the whole "live detection self-triggers for the recipe's
 * app" claim, proven with injected filesystem seams (no real WER directory, no
 * Windows API) so it runs on the Mac and on windows-latest alike.
 */
const REPORT_ARCHIVE = "/fake/report-archive";
const CRASH_DUMPS = "/fake/crash-dumps";
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));
function makeCoordinator() {
    const poolClient = {
        lookupRecipes: vitest_1.vi.fn(async () => ({ recipes: [], matchedBy: null })),
        fileConfirmedBreak: vitest_1.vi.fn(async () => ({ breakId: "break-1" })),
    };
    const provenanceStore = { localPatchingIsPermitted: vitest_1.vi.fn(() => false) };
    const replayEngine = { replay: vitest_1.vi.fn() };
    const coordinator = new incident_coordinator_1.MaintainIncidentCoordinator({
        poolClient,
        provenanceStore,
        replayEngine,
        persistence: new incident_coordinator_1.InMemoryMaintainIncidentGatePersistence(),
        generateAskId: () => "ask-1",
        nowEpochMs: () => 1_700_000_000_000,
        resolveMachineArchitecture: () => "x64",
    });
    return { coordinator, poolClient };
}
(0, vitest_1.describe)("live crash detection self-triggers for the ollama recipe's app", () => {
    (0, vitest_1.it)("attributes an ollama app.exe crash artifact and raises an Ollama ask", async () => {
        const { coordinator, poolClient } = makeCoordinator();
        const inventory = new app_inventory_1.WindowsAppInventory();
        // A realistic AppCrash Report.wer whose Application Name is the recipe's
        // installed exe — exactly what Windows Error Reporting writes.
        const reportDirectoryName = "ollama_crash_0001";
        const werText = (0, wer_signature_fixture_1.buildAppCrashWerText)({
            applicationName: "ollama app.exe",
            applicationVersion: "0.1.0.0",
            faultModuleName: "ollama app.exe",
            exceptionCode: "c0000005",
            exceptionOffset: "000000000004a1b0",
            reportIdentifier: "abcdef01-2345-6789-abcd-ef0123456789",
        });
        // The report directory is not present at start (old news is ignored); it
        // appears after the watch is hooked, and the watch fires.
        const reportArchiveEntries = [];
        let fireReportArchiveChange;
        const watcher = new crash_watcher_1.CrashArtifactWatcher({
            appMatcher: inventory,
            reportArchiveDirectoryPath: REPORT_ARCHIVE,
            crashDumpsDirectoryPath: CRASH_DUMPS,
            listDirectoryEntries: async (path) => (path === REPORT_ARCHIVE ? [...reportArchiveEntries] : []),
            readReportWerText: async (dir) => (dir.endsWith(reportDirectoryName) ? werText : undefined),
            watchDirectory: (path, onChange) => {
                if (path === REPORT_ARCHIVE)
                    fireReportArchiveChange = onChange;
                return { close: () => undefined };
            },
            sleepMs: async () => undefined,
        });
        // The whole wire: a detected artifact becomes a native-crash signal to the
        // coordinator, with the display name resolved from the inventory — the same
        // hook `main/maintain/controller.ts` installs.
        watcher.onCrashArtifactDetected = (artifact) => {
            coordinator.handleNativeCrash({
                parsedCrash: artifact.report,
                appSlug: artifact.catalogAppSlug,
                appName: inventory.appNameForSlug(artifact.catalogAppSlug),
                appStack: artifact.catalogAppStack,
            });
        };
        await watcher.start();
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk).toBeNull(); // nothing yet
        // ollama crashes: WER writes the report, the archive changes.
        reportArchiveEntries.push(reportDirectoryName);
        fireReportArchiveChange?.();
        await flushMicrotasks();
        const ask = coordinator.currentSnapshot().pendingAsk;
        (0, vitest_1.expect)(ask).not.toBeNull();
        (0, vitest_1.expect)(ask?.appSlug).toBe("ollama");
        (0, vitest_1.expect)(ask?.appName).toBe("Ollama");
        (0, vitest_1.expect)(ask?.evidenceSentence).toBe("Ollama quit unexpectedly a moment ago.");
        // The cache lookup fired for ollama's signature — the zero-token first
        // rung of the fix ladder.
        (0, vitest_1.expect)(poolClient.lookupRecipes).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ appSlug: "ollama", signatureId: ask?.signatureId }));
    });
    (0, vitest_1.it)("ignores a crash artifact for a process that is not one of ours", async () => {
        const { coordinator } = makeCoordinator();
        const inventory = new app_inventory_1.WindowsAppInventory();
        const reportArchiveEntries = [];
        let fireChange;
        const watcher = new crash_watcher_1.CrashArtifactWatcher({
            appMatcher: inventory,
            reportArchiveDirectoryPath: REPORT_ARCHIVE,
            crashDumpsDirectoryPath: CRASH_DUMPS,
            listDirectoryEntries: async (path) => (path === REPORT_ARCHIVE ? [...reportArchiveEntries] : []),
            readReportWerText: async () => (0, wer_signature_fixture_1.buildAppCrashWerText)({ applicationName: "notepad.exe", exceptionCode: "c0000005" }),
            watchDirectory: (path, onChange) => {
                if (path === REPORT_ARCHIVE)
                    fireChange = onChange;
                return { close: () => undefined };
            },
            sleepMs: async () => undefined,
        });
        watcher.onCrashArtifactDetected = (artifact) => coordinator.handleNativeCrash({
            parsedCrash: artifact.report,
            appSlug: artifact.catalogAppSlug,
            appName: inventory.appNameForSlug(artifact.catalogAppSlug),
            appStack: artifact.catalogAppStack,
        });
        await watcher.start();
        reportArchiveEntries.push("notepad_crash");
        fireChange?.();
        await flushMicrotasks();
        // Not a catalog app → no artifact delivered → no ask.
        (0, vitest_1.expect)(coordinator.currentSnapshot().pendingAsk).toBeNull();
    });
});
