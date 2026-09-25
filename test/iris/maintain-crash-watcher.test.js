"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("./vitest-shim");
const crash_watcher_1 = require("../../lib/iris/services/maintain/crash-watcher");
const wer_signature_fixture_1 = require("./fixtures/wer-signature-fixture");
/**
 * The always-on, zero-cost layer: notices a `Report.wer` for an installed
 * catalog app and nothing else, dedupes, ignores what was already there
 * before the watch started, and treats a matching process exit or crash-dump
 * sighting as corroboration only — never as a requirement to deliver.
 */
const REPORT_ARCHIVE = "/fake/report-archive";
const CRASH_DUMPS = "/fake/crash-dumps";
/** An in-memory "directory" a test can mutate between `start()` and
 *  triggering a watch callback, standing in for a real filesystem listing. */
class FakeDirectory {
    entries;
    constructor(entries = []) {
        this.entries = entries;
    }
    list = async () => [...this.entries];
}
/** Captures the `onChange` callback the watcher hands to `watchDirectory` for
 *  each path, so a test can fire a change deterministically instead of racing
 *  a real `fs.watch`. */
class CapturingWatcherFactory {
    handlersByPath = new Map();
    closedPaths = [];
    watchDirectory = (directoryPath, onChange) => {
        this.handlersByPath.set(directoryPath, onChange);
        return { close: () => this.closedPaths.push(directoryPath) };
    };
    trigger(directoryPath) {
        this.handlersByPath.get(directoryPath)?.();
    }
}
function alwaysMatchesCue() {
    return {
        catalogApp: (processName) => processName === "cue.exe" ? { slug: "cue", stack: "electron" } : undefined,
    };
}
function neverMatches() {
    return { catalogApp: () => undefined };
}
function buildHarness(options = {}) {
    const reportArchive = new FakeDirectory(options.reportArchiveEntries ?? []);
    const crashDumps = new FakeDirectory(options.crashDumpEntries ?? []);
    const watcherFactory = new CapturingWatcherFactory();
    const delivered = [];
    const readReportWerTextCalls = [];
    const sleepCalls = [];
    const werTextByPath = new Map();
    const state = { now: 0 };
    const watcher = new crash_watcher_1.CrashArtifactWatcher({
        appMatcher: options.appMatcher ?? alwaysMatchesCue(),
        reportArchiveDirectoryPath: REPORT_ARCHIVE,
        crashDumpsDirectoryPath: CRASH_DUMPS,
        maximumRememberedReports: options.maximumRememberedReports,
        listDirectoryEntries: (directoryPath) => directoryPath === REPORT_ARCHIVE ? reportArchive.list() : crashDumps.list(),
        readReportWerText: async (reportDirectoryPath) => {
            readReportWerTextCalls.push(reportDirectoryPath);
            return werTextByPath.get(reportDirectoryPath);
        },
        watchDirectory: watcherFactory.watchDirectory,
        sleepMs: async (ms) => {
            sleepCalls.push(ms);
        },
        nowEpochMs: () => state.now,
    });
    watcher.onCrashArtifactDetected = (artifact) => delivered.push(artifact);
    return {
        watcher,
        reportArchive,
        crashDumps,
        watcherFactory,
        delivered,
        readReportWerTextCalls,
        sleepCalls,
        get now() {
            return state.now;
        },
        set now(value) {
            state.now = value;
        },
        setReportWerText: (reportDirectoryPath, text) => werTextByPath.set(reportDirectoryPath, text),
    };
}
function reportDirectoryPathFor(entryName) {
    return (0, node_path_1.join)(REPORT_ARCHIVE, entryName);
}
(0, vitest_1.describe)("CrashArtifactWatcher — the sure path (ReportArchive)", () => {
    (0, vitest_1.it)("ignores a report directory present before start(), even once it is scanned", async () => {
        const h = buildHarness({ reportArchiveEntries: ["old-report"] });
        h.setReportWerText(reportDirectoryPathFor("old-report"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        await h.watcher.start();
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered).toHaveLength(0);
    });
    (0, vitest_1.it)("delivers a new catalog-app crash report, unmatched to any termination or crash dump", async () => {
        const h = buildHarness();
        await h.watcher.start();
        h.reportArchive.entries.push("new-report");
        h.setReportWerText(reportDirectoryPathFor("new-report"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered).toHaveLength(1);
        (0, vitest_1.expect)(h.delivered[0]).toMatchObject({
            reportDirectoryPath: reportDirectoryPathFor("new-report"),
            catalogAppSlug: "cue",
            catalogAppStack: "electron",
            correlatedWithTermination: false,
            corroboratedByCrashDumpSighting: false,
        });
        (0, vitest_1.expect)(h.delivered[0]?.report.appName).toBe("cue.exe");
    });
    (0, vitest_1.it)("ignores a crash report for a process that is not an installed catalog app", async () => {
        const h = buildHarness({ appMatcher: neverMatches() });
        await h.watcher.start();
        h.reportArchive.entries.push("stray-report");
        h.setReportWerText(reportDirectoryPathFor("stray-report"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered).toHaveLength(0);
    });
    (0, vitest_1.it)("dedupes: a report already considered is never re-read across repeated watch triggers", async () => {
        const h = buildHarness();
        await h.watcher.start();
        h.reportArchive.entries.push("new-report");
        h.setReportWerText(reportDirectoryPathFor("new-report"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered).toHaveLength(1);
        (0, vitest_1.expect)(h.readReportWerTextCalls.filter((p) => p === reportDirectoryPathFor("new-report"))).toHaveLength(1);
    });
    (0, vitest_1.it)("retries once after a half-written Report.wer, then delivers", async () => {
        const h = buildHarness();
        await h.watcher.start();
        h.reportArchive.entries.push("flushing-report");
        // First read: nothing there yet (WER still flushing). Set the real text
        // only after the first read has already been recorded, mirroring a file
        // that finishes writing between the two attempts.
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        // Let the first (failed) read happen before the text becomes available.
        await Promise.resolve();
        h.setReportWerText(reportDirectoryPathFor("flushing-report"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.sleepCalls).toEqual([1500]);
        (0, vitest_1.expect)(h.delivered).toHaveLength(1);
    });
    (0, vitest_1.it)("gives up quietly when the retry also finds nothing, without throwing", async () => {
        const h = buildHarness();
        await h.watcher.start();
        h.reportArchive.entries.push("never-flushed-report");
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.sleepCalls).toEqual([1500]);
        (0, vitest_1.expect)(h.delivered).toHaveLength(0);
    });
    (0, vitest_1.it)("marks correlatedWithTermination when noteProcessExited landed within the correlation window", async () => {
        const h = buildHarness();
        h.now = 0;
        await h.watcher.start();
        h.watcher.noteProcessExited("cue.exe", 0);
        h.now = 5_000; // 5s later, inside the 20s window
        h.reportArchive.entries.push("crash-after-exit");
        h.setReportWerText(reportDirectoryPathFor("crash-after-exit"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered[0]?.correlatedWithTermination).toBe(true);
    });
    (0, vitest_1.it)("does NOT mark correlatedWithTermination once the exit falls outside the correlation window", async () => {
        const h = buildHarness();
        h.now = 0;
        await h.watcher.start();
        h.watcher.noteProcessExited("cue.exe", 0);
        h.now = 25_000; // past the 20s window
        h.reportArchive.entries.push("crash-long-after-exit");
        h.setReportWerText(reportDirectoryPathFor("crash-long-after-exit"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered[0]?.correlatedWithTermination).toBe(false);
    });
    (0, vitest_1.it)("resets the bounded dedupe set once it exceeds the configured cap, without dropping or double-delivering", async () => {
        const h = buildHarness({ maximumRememberedReports: 2 });
        await h.watcher.start();
        for (const name of ["r1", "r2", "r3"]) {
            h.reportArchive.entries.push(name);
            h.setReportWerText(reportDirectoryPathFor(name), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
            h.watcherFactory.trigger(REPORT_ARCHIVE);
            await Promise.resolve();
            await Promise.resolve();
        }
        // Give the reset's own directory-listing refresh (unawaited by design) a
        // turn to land before proving the invariant it exists to protect.
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered.map((d) => d.reportDirectoryPath)).toEqual([
            reportDirectoryPathFor("r1"),
            reportDirectoryPathFor("r2"),
            reportDirectoryPathFor("r3"),
        ]);
        // r1 is still sitting in the fake directory listing (nothing removes
        // entries from it) — a repeat trigger must not re-read or re-deliver it,
        // proving the post-reset re-primed "present at start" set still covers it.
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered).toHaveLength(3);
    });
    (0, vitest_1.it)("stop() closes both the report-archive and crash-dumps watch handles", async () => {
        const h = buildHarness();
        await h.watcher.start();
        h.watcher.stop();
        (0, vitest_1.expect)(h.watcherFactory.closedPaths).toContain(REPORT_ARCHIVE);
        (0, vitest_1.expect)(h.watcherFactory.closedPaths).toContain(CRASH_DUMPS);
    });
});
(0, vitest_1.describe)("CrashArtifactWatcher — CrashDumps corroboration (never a requirement)", () => {
    (0, vitest_1.it)("marks corroboratedByCrashDumpSighting when a matching dump appeared after start(), within the window", async () => {
        const h = buildHarness();
        h.now = 0;
        await h.watcher.start();
        h.crashDumps.entries.push("cue.exe.4821.dmp");
        h.watcherFactory.trigger(CRASH_DUMPS);
        await Promise.resolve();
        h.now = 3_000;
        h.reportArchive.entries.push("crash-with-dump");
        h.setReportWerText(reportDirectoryPathFor("crash-with-dump"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered[0]?.corroboratedByCrashDumpSighting).toBe(true);
    });
    (0, vitest_1.it)("ignores a dump file that was already present before start() — old news, like a pre-existing report", async () => {
        const h = buildHarness({ crashDumpEntries: ["cue.exe.111.dmp"] });
        h.now = 0;
        await h.watcher.start();
        // Re-scan without anything new actually being added — a watch can fire
        // spuriously (AV touching the directory, etc.).
        h.watcherFactory.trigger(CRASH_DUMPS);
        await Promise.resolve();
        h.now = 1_000;
        h.reportArchive.entries.push("crash-without-fresh-dump");
        h.setReportWerText(reportDirectoryPathFor("crash-without-fresh-dump"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered[0]?.corroboratedByCrashDumpSighting).toBe(false);
    });
    (0, vitest_1.it)("never blocks delivery on the absence of a crash dump — corroboration only", async () => {
        const h = buildHarness();
        await h.watcher.start();
        h.reportArchive.entries.push("crash-no-dump-anywhere");
        h.setReportWerText(reportDirectoryPathFor("crash-no-dump-anywhere"), wer_signature_fixture_1.CUE_APPCRASH_WER_FIXTURE);
        h.watcherFactory.trigger(REPORT_ARCHIVE);
        await Promise.resolve();
        await Promise.resolve();
        (0, vitest_1.expect)(h.delivered).toHaveLength(1);
    });
});
(0, vitest_1.describe)("processNameFromCrashDumpFileName — the LocalDumps <name>.<pid>.dmp convention", () => {
    vitest_1.it.each([
        ["cue.exe.4821.dmp", "cue.exe"],
        ["my.app.exe.99.dmp", "my.app.exe"],
        ["notetion.exe.1.DMP", "notetion.exe"],
    ])("parses %s -> %s", (fileName, expected) => {
        (0, vitest_1.expect)((0, crash_watcher_1.processNameFromCrashDumpFileName)(fileName)).toBe(expected);
    });
    vitest_1.it.each(["not-a-dump.txt", "cue.exe.dmp", "cue.exe.notanumber.dmp", ""])("returns undefined for %s", (fileName) => {
        (0, vitest_1.expect)((0, crash_watcher_1.processNameFromCrashDumpFileName)(fileName)).toBeUndefined();
    });
});
(0, vitest_1.describe)("real default I/O helpers — plain node:fs, not Windows-specific (see file header)", () => {
    let tempDir;
    (0, vitest_1.afterEach)(() => {
        if (tempDir)
            (0, node_fs_1.rmSync)(tempDir, { recursive: true, force: true });
        tempDir = undefined;
    });
    (0, vitest_1.it)("listDirectoryEntries lists real entries and returns [] for a directory that does not exist", async () => {
        tempDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "gemair-maintain-crash-watcher-"));
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(tempDir, "one"), "");
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(tempDir, "two"), "");
        (0, vitest_1.expect)((await (0, crash_watcher_1.listDirectoryEntries)(tempDir)).sort()).toEqual(["one", "two"]);
        (0, vitest_1.expect)(await (0, crash_watcher_1.listDirectoryEntries)((0, node_path_1.join)(tempDir, "never-existed"))).toEqual([]);
    });
    (0, vitest_1.it)("readReportWerText reads a real Report.wer and returns undefined when it is missing", async () => {
        tempDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "gemair-maintain-crash-watcher-"));
        const reportDir = (0, node_path_1.join)(tempDir, "AppCrash_cue.exe_1");
        (0, node_fs_1.mkdirSync)(reportDir);
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(reportDir, "Report.wer"), (0, wer_signature_fixture_1.buildAppCrashWerText)({ applicationName: "cue.exe" }));
        (0, vitest_1.expect)(await (0, crash_watcher_1.readReportWerText)(reportDir)).toContain("cue.exe");
        (0, vitest_1.expect)(await (0, crash_watcher_1.readReportWerText)((0, node_path_1.join)(tempDir, "no-such-report"))).toBeUndefined();
    });
    (0, vitest_1.it)("watchDirectoryForChanges returns a handle for a real directory and undefined for a missing one", async () => {
        tempDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "gemair-maintain-crash-watcher-"));
        const handle = (0, crash_watcher_1.watchDirectoryForChanges)(tempDir, () => { });
        (0, vitest_1.expect)(handle).toBeDefined();
        handle?.close();
        (0, vitest_1.expect)((0, crash_watcher_1.watchDirectoryForChanges)((0, node_path_1.join)(tempDir, "missing"), () => { })).toBeUndefined();
    });
    (0, vitest_1.it)("defaultReportArchiveDirectoryPath and defaultCrashDumpsDirectoryPath end in the expected Windows folders", () => {
        (0, vitest_1.expect)((0, crash_watcher_1.defaultReportArchiveDirectoryPath)()).toMatch(/Microsoft[\\/]Windows[\\/]WER[\\/]ReportArchive$/);
        (0, vitest_1.expect)((0, crash_watcher_1.defaultCrashDumpsDirectoryPath)()).toMatch(/CrashDumps$/);
    });
});
