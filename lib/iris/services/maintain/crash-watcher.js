"use strict";
/**
 * crash-watcher.ts
 *
 * The Windows port of `iris-macos/leanring-buddy/CrashArtifactWatcher.swift` —
 * the always-on, zero-cost layer of maintain mode. Nothing here polls,
 * screenshots, or spends a token; Windows Error Reporting does the work of
 * writing a crash report, and this file only notices when one shows up for an
 * installed catalog app.
 *
 * ## Two directories, two different jobs (porting spec §2.1)
 *
 * `%ProgramData%\Microsoft\Windows\WER\ReportArchive` is the PRIMARY signal —
 * the direct Windows analog of Swift's kqueue watch on
 * `~/Library/Logs/DiagnosticReports`. A new subdirectory appearing there means
 * WER finished writing a `Report.wer`; this file reads it with
 * `break-signature.ts`'s already-built `parseWerReportForSignature` and, if the
 * crashed process matches an installed catalog app, delivers a
 * `DetectedCrashArtifact`.
 *
 * `%LOCALAPPDATA%\CrashDumps` (minidumps, written only if the target opted
 * into the `LocalDumps` registry key — most catalog apps will not have this
 * set) is CORROBORATION ONLY, never a required signal, exactly like Swift's
 * `correlatedWithTermination`. Its presence within the correlation window is
 * surfaced as `corroboratedByCrashDumpSighting` — a bonus timing fact for
 * whoever reviews a pooled crash, never something this file requires before
 * delivering an artifact.
 *
 * This file does NOT build the "fast path" (an `EventLogWatcher` on Event ID
 * 1000/1002, the analog of Swift's private `com.apple.ReportCrash.crash`
 * distributed notification) — that lives in a separate module
 * (`main/maintain/wer-crash-watcher.ts` + `wer-report.ts`, per the porting
 * spec's module table) because it needs inline C# (`Add-Type`) and Electron
 * process wiring this file deliberately stays free of. The ReportArchive
 * watch below is the "sure path" on its own: slower than an event-log
 * subscription, but public, stable, and sufficient by itself if the fast path
 * is ever added later — same relationship Swift's kqueue watch has to its own
 * notification path.
 *
 * ## Correlation with process exit — a deliberate divergence from Swift
 *
 * Swift listens to `NSWorkspace.didTerminateApplicationNotification`, a
 * system-wide "an app just quit" event it can simply subscribe to. Windows has
 * no equivalent global termination notification without WMI/ETW — heavier
 * machinery than a watcher this small should carry. Instead, `noteProcessExited`
 * is an explicit method: whoever spawns or tracks a catalog app's process
 * (autopilot's `PowerShellSession`, a future direct-launch path) calls it when
 * that process exits, and this file does the correlation-window bookkeeping
 * Swift does internally. The math (`correlatedWithTermination`) is unchanged;
 * only how the timing fact arrives is different, and that difference is
 * exactly the porting spec's "BEHAVIOR parity, not literal translation" rule.
 *
 * ## Pure decision logic vs. fs calls (ground rule: testable on any OS)
 *
 * Every piece of real I/O — listing a directory, reading a `Report.wer`,
 * watching a directory for changes, sleeping between a read retry — is an
 * injected function on `CrashArtifactWatcherOptions`, defaulting to a real
 * `node:fs` implementation exported from this same file. `node:fs` is not
 * in itself a Windows-only API (see `install-provenance.ts`'s
 * `gitDirectoryExists` and `patch-queue.ts`'s `FileSystemPatchQueueStorage`
 * for the same convention already established in this package) — the
 * Windows-specific parts are only the *paths* (`%ProgramData%\...`,
 * `%LOCALAPPDATA%\...`) and the shape of what gets parsed, both of which are
 * plain data, not platform-gated code. That means the whole class, including
 * its real default I/O, is exercised for real by the vitest suite (against a
 * temp directory) on the Mac dev machine and on windows-latest CI alike — the
 * fs-watch based "watch" itself is still worth injecting so a test can drive
 * change notifications deterministically instead of racing a real
 * `fs.watch` debounce window.
 *
 * ## App matching is caller-supplied, on purpose (porting spec §2.1, §5.4)
 *
 * There is no Windows analog of `AppInventoryService` in this repo yet, and
 * `app/api/iris/apps/route.ts` carries no Windows-exe field — only
 * `macBundleId`. Rather than hand-roll a slug→exe-name table inside this file
 * (which would silently go stale the moment the catalog changes, and would be
 * exactly the kind of gap the ground rules say to flag, not paper over),
 * `CrashArtifactAppMatching` is injected, mirroring Swift's own
 * `CrashArtifactAppMatching` protocol being backed by `AppInventoryService`
 * rather than hardcoded into `CrashArtifactWatcher`. Whoever wires the real
 * controller supplies the real table; this file only knows how to ask it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrashArtifactWatcher = void 0;
exports.defaultReportArchiveDirectoryPath = defaultReportArchiveDirectoryPath;
exports.defaultCrashDumpsDirectoryPath = defaultCrashDumpsDirectoryPath;
exports.listDirectoryEntries = listDirectoryEntries;
exports.readReportWerText = readReportWerText;
exports.watchDirectoryForChanges = watchDirectoryForChanges;
exports.processNameFromCrashDumpFileName = processNameFromCrashDumpFileName;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const break_signature_1 = require("./break-signature");
const trace_1 = require("./trace");
// ---------------------------------------------------------------------------
// Real default I/O — plain `node:fs`, not Windows-specific code (see the file
// header). Exported individually so a test can exercise each in isolation
// against a temp directory, the same pattern `install-provenance.ts` uses for
// `gitDirectoryExists`.
// ---------------------------------------------------------------------------
/** `%ProgramData%\Microsoft\Windows\WER\ReportArchive` — falls back to the
 *  well-known default location if the environment variable is unset (never
 *  true on a real Windows machine, but keeps this callable on the Mac dev
 *  machine without throwing). */
function defaultReportArchiveDirectoryPath() {
    const programData = process.env.ProgramData ?? "C:\\ProgramData";
    return (0, node_path_1.join)(programData, "Microsoft", "Windows", "WER", "ReportArchive");
}
/** `%LOCALAPPDATA%\CrashDumps` — corroboration-only source; see the file
 *  header. Most catalog apps will not have written anything here, since it
 *  requires the target to have opted into the `LocalDumps` registry key. */
function defaultCrashDumpsDirectoryPath() {
    const localAppData = process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local";
    return (0, node_path_1.join)(localAppData, "CrashDumps");
}
/** Lists the entries directly under `directoryPath`. A missing directory
 *  (CrashDumps almost always is; ReportArchive may not exist on a machine
 *  that has never crashed) is not an error worth surfacing — it just has no
 *  entries yet. */
async function listDirectoryEntries(directoryPath) {
    try {
        return await (0, promises_1.readdir)(directoryPath);
    }
    catch {
        return [];
    }
}
/** Reads `<reportDirectoryPath>\Report.wer` as text, or `undefined` if it is
 *  not there yet (WER may still be flushing it — see `considerReport`'s retry)
 *  or cannot be read. */
async function readReportWerText(reportDirectoryPath) {
    try {
        return await (0, promises_1.readFile)((0, node_path_1.join)(reportDirectoryPath, "Report.wer"), "utf8");
    }
    catch {
        return undefined;
    }
}
/** Watches `directoryPath` for any change and calls `onChange` — debounced by
 *  nothing, deliberately: `scanForNewReports`/`scanForNewCrashDumps` are cheap
 *  and idempotent (dedupe means an extra scan costs nothing), so there is
 *  nothing to gain from coalescing events at this layer the way there would be
 *  for something expensive. Returns `undefined`, not a handle, when the
 *  directory does not exist — `fs.watch` throws synchronously in that case,
 *  and a directory that may never be created (CrashDumps, on a machine that
 *  never opted into `LocalDumps`) is an expected shape, not a startup failure. */
function watchDirectoryForChanges(directoryPath, onChange) {
    try {
        const watcher = (0, node_fs_1.watch)(directoryPath, { persistent: false }, () => onChange());
        watcher.on("error", () => {
            // A watch that errors mid-flight (the directory was removed, a AV
            // product briefly locked it) is not fatal — the sure path just goes
            // quiet for this directory until the next `start()`. Traced so it is
            // diagnosable rather than silently invisible.
            (0, trace_1.maintainTrace)(`crash-watcher: directory watch for ${directoryPath} errored and stopped`);
        });
        return { close: () => watcher.close() };
    }
    catch {
        return undefined;
    }
}
/** Windows' `LocalDumps` convention names a minidump
 *  `<processName>.<pid>.dmp` (e.g. `cue.exe.4821.dmp`). Pulls the process name
 *  back out, or `undefined` for anything that doesn't match the shape — a
 *  pure, directly testable piece of an otherwise I/O-heavy file. */
function processNameFromCrashDumpFileName(fileName) {
    const match = /^(.+)\.\d+\.dmp$/i.exec(fileName);
    return match?.[1];
}
/** ReportCrash may still be flushing when the directory first appears; a
 *  half-written `Report.wer` reads as garbage or is not there yet. One short
 *  retry covers it — the direct port of Swift's `considerReport`'s
 *  `asyncAfter(deadline: .now() + 1.5)` retry. */
const RETRY_DELAY_MS = 1500;
/** How long a termination or a crash-dump sighting stays "recent" enough to
 *  corroborate a crash report. Matches Swift's
 *  `terminationCorrelationWindow: TimeInterval = 20`. */
const TERMINATION_CORRELATION_WINDOW_MS = 20 * 1000;
const DEFAULT_MAXIMUM_REMEMBERED_REPORTS = 512;
/**
 * Watches for Windows crash artifacts belonging to installed catalog apps.
 * See the file header for the full design; this class owns only the
 * bookkeeping (dedupe, ignore-pre-existing, correlation) — every real I/O
 * call is the injected seam above.
 */
class CrashArtifactWatcher {
    /** New artifacts land here. The incident coordinator owns what happens
     *  next (ask the user, never act on its own) — this callback only
     *  delivers, exactly like Swift's `onCrashArtifactDetected`. */
    onCrashArtifactDetected;
    appMatcher;
    reportArchiveDirectoryPath;
    crashDumpsDirectoryPath;
    listDirectoryEntriesImpl;
    readReportWerTextImpl;
    watchDirectoryImpl;
    sleepMsImpl;
    nowEpochMsImpl;
    maximumRememberedReports;
    /** Report directory names delivered already, so the periodic scan cannot
     *  double-report one crash. Bounded — see `rememberDelivered`. */
    deliveredReportDirectoryNames = new Set();
    /** Report directory names present before `start()` — old news, per the
     *  file header. */
    reportDirectoriesPresentAtStart = new Set();
    /** Crash-dump file names present before `start()` — same reasoning, kept
     *  separate because it is a distinct directory with its own listing. */
    crashDumpFilesPresentAtStart = new Set();
    crashDumpFilesAlreadySighted = new Set();
    recentTerminationsByProcessName = new Map();
    recentCrashDumpSightingsByProcessName = new Map();
    reportArchiveWatchHandle;
    crashDumpsWatchHandle;
    constructor(options) {
        this.appMatcher = options.appMatcher;
        this.reportArchiveDirectoryPath = options.reportArchiveDirectoryPath ?? defaultReportArchiveDirectoryPath();
        this.crashDumpsDirectoryPath = options.crashDumpsDirectoryPath ?? defaultCrashDumpsDirectoryPath();
        this.listDirectoryEntriesImpl = options.listDirectoryEntries ?? listDirectoryEntries;
        this.readReportWerTextImpl = options.readReportWerText ?? readReportWerText;
        this.watchDirectoryImpl = options.watchDirectory ?? watchDirectoryForChanges;
        this.sleepMsImpl = options.sleepMs ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.nowEpochMsImpl = options.nowEpochMs ?? (() => Date.now());
        this.maximumRememberedReports = options.maximumRememberedReports ?? DEFAULT_MAXIMUM_REMEMBERED_REPORTS;
    }
    /** Snapshots what already exists in both directories (old news), then hooks
     *  a watch on each. Mirrors Swift's `start()` ordering exactly: list first,
     *  watch second. */
    async start() {
        this.reportDirectoriesPresentAtStart = new Set(await this.listDirectoryEntriesImpl(this.reportArchiveDirectoryPath));
        this.crashDumpFilesPresentAtStart = new Set(await this.listDirectoryEntriesImpl(this.crashDumpsDirectoryPath));
        this.reportArchiveWatchHandle = this.watchDirectoryImpl(this.reportArchiveDirectoryPath, () => {
            void this.scanForNewReports();
        });
        this.crashDumpsWatchHandle = this.watchDirectoryImpl(this.crashDumpsDirectoryPath, () => {
            void this.scanForNewCrashDumps();
        });
    }
    stop() {
        this.reportArchiveWatchHandle?.close();
        this.reportArchiveWatchHandle = undefined;
        this.crashDumpsWatchHandle?.close();
        this.crashDumpsWatchHandle = undefined;
    }
    /** Called by whoever spawned or is tracking a catalog app's process, the
     *  moment it exits — see the file header's "Correlation with process exit"
     *  section for why this is a method here rather than a subscription. */
    noteProcessExited(processName, exitedAtEpochMs = this.nowEpochMsImpl()) {
        this.recentTerminationsByProcessName.set(processName, exitedAtEpochMs);
        this.pruneOldEntries(this.recentTerminationsByProcessName);
    }
    // -- Report-archive scan (the primary signal) ----------------------------
    async scanForNewReports() {
        const entries = await this.listDirectoryEntriesImpl(this.reportArchiveDirectoryPath);
        for (const entryName of entries) {
            if (this.reportDirectoriesPresentAtStart.has(entryName) || this.deliveredReportDirectoryNames.has(entryName)) {
                continue;
            }
            await this.considerReport(entryName);
        }
    }
    async considerReport(entryName) {
        if (this.deliveredReportDirectoryNames.has(entryName) || this.reportDirectoriesPresentAtStart.has(entryName)) {
            return;
        }
        // Marked delivered before the read/parse even resolves — same as Swift's
        // `rememberDelivered` call ordering — so a second scan racing this one
        // (the watch can fire again before this finishes) cannot double-consider
        // the same entry.
        this.rememberDelivered(entryName);
        const reportDirectoryPath = (0, node_path_1.join)(this.reportArchiveDirectoryPath, entryName);
        let text = await this.readReportWerTextImpl(reportDirectoryPath);
        if (text === undefined || text.length === 0) {
            // WER may still be writing it. One short wait, one retry, then give up
            // quietly — matching Swift's single-retry shape exactly.
            await this.sleepMsImpl(RETRY_DELAY_MS);
            text = await this.readReportWerTextImpl(reportDirectoryPath);
            if (text === undefined || text.length === 0) {
                (0, trace_1.maintainTrace)(`crash-watcher: gave up reading ${entryName}'s Report.wer after one retry`);
                return;
            }
        }
        const parsed = (0, break_signature_1.parseWerReportForSignature)(text);
        this.deliverIfCatalogApp(parsed, reportDirectoryPath);
    }
    deliverIfCatalogApp(report, reportDirectoryPath) {
        const match = this.appMatcher.catalogApp(report.appName);
        if (match === undefined) {
            // Traced, not stored: everything on this machine crashes sometimes;
            // only our apps are maintain mode's business, and the report itself
            // stays unread past what `parseWerReportForSignature` already pulled
            // out of it. Matches Swift's `deliverIfCatalogApp` reasoning verbatim.
            (0, trace_1.maintainTrace)(`crash-watcher: crash artifact ignored (${report.appName} is not an installed catalog app)`);
            return;
        }
        const now = this.nowEpochMsImpl();
        const correlatedWithTermination = this.isRecentEnough(this.recentTerminationsByProcessName.get(report.appName), now);
        const corroboratedByCrashDumpSighting = this.isRecentEnough(this.recentCrashDumpSightingsByProcessName.get(report.appName), now);
        (0, trace_1.maintainTrace)(`crash-watcher: crash artifact for ${match.slug} correlatedWithTermination=${correlatedWithTermination} ` +
            `corroboratedByCrashDumpSighting=${corroboratedByCrashDumpSighting}`);
        this.onCrashArtifactDetected?.({
            reportDirectoryPath,
            report,
            catalogAppSlug: match.slug,
            catalogAppStack: match.stack,
            correlatedWithTermination,
            corroboratedByCrashDumpSighting,
        });
    }
    rememberDelivered(entryName) {
        this.deliveredReportDirectoryNames.add(entryName);
        if (this.deliveredReportDirectoryNames.size > this.maximumRememberedReports) {
            // Matches Swift's bounded-memory reset: a session that sees this many
            // crashes has bigger problems than this set's memory, so it is simply
            // cleared and re-primed from a fresh listing rather than grown
            // unbounded.
            this.deliveredReportDirectoryNames.clear();
            void this.listDirectoryEntriesImpl(this.reportArchiveDirectoryPath).then((entries) => {
                this.reportDirectoriesPresentAtStart = new Set(entries);
            });
        }
    }
    // -- CrashDumps scan (corroboration only) --------------------------------
    async scanForNewCrashDumps() {
        const entries = await this.listDirectoryEntriesImpl(this.crashDumpsDirectoryPath);
        for (const fileName of entries) {
            if (this.crashDumpFilesPresentAtStart.has(fileName) || this.crashDumpFilesAlreadySighted.has(fileName)) {
                continue;
            }
            this.crashDumpFilesAlreadySighted.add(fileName);
            const processName = processNameFromCrashDumpFileName(fileName);
            if (processName === undefined) {
                continue;
            }
            this.recentCrashDumpSightingsByProcessName.set(processName, this.nowEpochMsImpl());
            this.pruneOldEntries(this.recentCrashDumpSightingsByProcessName);
        }
    }
    // -- Shared correlation-window helpers ------------------------------------
    isRecentEnough(recordedAtEpochMs, now) {
        if (recordedAtEpochMs === undefined) {
            return false;
        }
        return now - recordedAtEpochMs < TERMINATION_CORRELATION_WINDOW_MS;
    }
    /** Matches Swift's `pruneOldTerminations`, generalized to both correlation
     *  maps: entries older than twice the correlation window are dropped so
     *  neither map grows for the lifetime of a long-running session. */
    pruneOldEntries(entries) {
        const cutoff = this.nowEpochMsImpl() - TERMINATION_CORRELATION_WINDOW_MS * 2;
        for (const [key, recordedAtEpochMs] of entries) {
            if (recordedAtEpochMs <= cutoff) {
                entries.delete(key);
            }
        }
    }
}
exports.CrashArtifactWatcher = CrashArtifactWatcher;
