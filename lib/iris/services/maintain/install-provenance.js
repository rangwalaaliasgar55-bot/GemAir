"use strict";
/**
 * install-provenance.ts
 *
 * The Windows port of
 * `iris-macos/leanring-buddy/InstallProvenanceStore.swift`.
 *
 * How did this app get onto this machine? Maintain mode's whole permission to
 * touch code hangs on the answer: a guide-built source clone may be patched
 * locally (the user already runs an unsigned local build — patching changes
 * nothing about the trust boundary), a signed download is NEVER patched (GemAir
 * invalidating a notarized/signed binary would be vandalism), and unknown
 * provenance is treated as signed, because failing closed is the only honest
 * default for a question this consequential.
 *
 * Provenance is RECORDED at guide completion, not inferred later — the same
 * "never guess" invariant the macOS `AppInventoryService` holds for bundle
 * identity, and the same one this file holds for install identity.
 *
 * INTERLOCK (now wired — the gap the porting spec §5, gap 2 flagged is closed):
 * recording a `guide_source_clone` provenance needs `canonicalRepo` and the
 * pinned commit at recipe completion. `services/autopilot/recipe.ts`'s
 * `InstallRecipe` now carries both (`canonicalRepo`/`pinnedCommit`), and
 * `main/autopilot-controller.ts`'s `onFinished` now hands the finished install
 * — its output kind, whether it cloned, and the shell's clone path — to
 * `main/maintain/controller.ts`'s `recordInstallProvenance`, which runs the
 * pure `decideInstallProvenance` below and calls `recordGuideSourceClone` or
 * `recordSignedDownload` accordingly. Nothing in this file assumes any
 * particular caller drives it; before an install finishes for a given app,
 * `localPatchingIsPermitted` still returns false for it — an honest degrade
 * (replay/Tier-C simply never fires until provenance is recorded), not a
 * crash.
 *
 * This file is pure: like `install-identity.ts`, it never imports `electron`.
 * The one filesystem check it needs — "does `<clonePath>/.git` exist?" — is a
 * plain `node:fs` call, which is not Electron-specific and already runs
 * identically on the Mac dev machine and on windows-latest CI, so it is
 * provided here as the real default rather than pushed into `main/`; it is
 * still injectable (mirroring `checkResponsive` in the porting spec's
 * `hang-probe.ts`) so a test can fake a repo that was deleted out from under a
 * recorded provenance without touching a real disk.
 *
 * NAMING NOTE (porting spec §3): `InstallProvenance`'s two wire values are
 * local-only — `RecordedInstallProvenance` is written to `userData/maintain.json`
 * and never appears on any `/api/iris/*` wire body. This file uses
 * `"guide_source_clone" | "signed_app_download"` (snake_case), diverging from
 * Swift's raw `"guideSourceClone"`/`"signedAppDownload"` (camelCase). That
 * divergence is harmless precisely because nothing cross-client reads this
 * value — there is no wire contract to violate, so this is kept as-is rather
 * than "fixed" to match Swift.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstallProvenanceStore = exports.InMemoryInstallProvenancePersistence = void 0;
exports.gitDirectoryExists = gitDirectoryExists;
exports.decideInstallProvenance = decideInstallProvenance;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const trace_1 = require("./trace");
/** Small in-memory implementation for tests and for any caller without a
 *  real `userData`-backed store wired up yet — mirrors `MockShell` in
 *  `services/autopilot/shell.ts` and `InMemoryInstallIdentityPersistence` in
 *  `install-identity.ts`. */
class InMemoryInstallProvenancePersistence {
    records = {};
    readAllProvenanceRecords() {
        return this.records;
    }
    writeAllProvenanceRecords(records) {
        this.records = { ...records };
    }
}
exports.InMemoryInstallProvenancePersistence = InMemoryInstallProvenancePersistence;
/**
 * Does `<clonePath>/.git` exist? The real, default implementation of the
 * injected check `InstallProvenanceStore.localPatchingIsPermitted` needs.
 *
 * Named to match the porting spec's table (`gitDirectoryExists(path):
 * boolean`), but — matching Swift's own `FileManager.default.fileExists`
 * check exactly — this only tests *existence*, not that `.git` is a
 * directory. A git worktree's `.git` is a plain file (a `gitdir: ...`
 * pointer), and Swift's `fileExists(atPath:isDirectory:)` call treats that as
 * present too: the `isDirectory` out-parameter is populated but never
 * inspected by the caller. Reproducing that here, rather than "fixing" it to
 * require a directory, keeps this a real behavioral port rather than an
 * accidental tightening of the D4 gate.
 */
function gitDirectoryExists(clonePath) {
    try {
        return (0, node_fs_1.existsSync)((0, node_path_1.join)(clonePath, ".git"));
    }
    catch {
        return false;
    }
}
/**
 * The pure mirror of macOS `CompanionManager.recordInstallProvenance`: decides
 * WHICH provenance a finished install writes, without touching the store, so
 * the decision is testable on its own.
 *
 * Two gates, in the same order as Swift:
 *   1. Only a `desktop_app` install records provenance at all. macOS guards
 *      `guard guide.outputType == .desktopApp else { return }` first — a
 *      `local_web` app (OpenASCII) is a dev server the reader runs, not a built
 *      binary on disk with a trust boundary, so there is nothing to record and
 *      nothing maintain mode would ever patch.
 *   2. Within a desktop app: a build that cloned source (and left the shell in
 *      that clone, so `clonePath` is in hand) is a `guide_source_clone` GemAir
 *      may patch; anything else is a `signed_app_download` it never may. A
 *      recipe that reports it cloned but somehow left no usable clone path
 *      fails CLOSED to `signed_app_download` rather than recording a
 *      `guide_source_clone` whose path cannot be patched — the same
 *      "unknown = signed = don't touch it" instinct the D4 gate holds.
 */
function decideInstallProvenance(facts) {
    if (facts.outputType !== "desktop_app") {
        return { kind: "none" };
    }
    if (facts.clonedARepo && facts.clonePath !== undefined && facts.clonePath.length > 0) {
        return {
            kind: "guide_source_clone",
            clonePath: facts.clonePath,
            pinnedCommit: facts.pinnedCommit ?? null,
            canonicalRepo: facts.canonicalRepo ?? null,
        };
    }
    return { kind: "signed_app_download" };
}
/**
 * Where an install came from, and the fail-closed D4 gate
 * (`localPatchingIsPermitted`) that everything downstream in maintain mode
 * checks before touching a single file on disk.
 */
class InstallProvenanceStore {
    persistence;
    checkGitDirectoryExists;
    nowIso;
    constructor(options) {
        this.persistence = options.persistence;
        this.checkGitDirectoryExists = options.checkGitDirectoryExists ?? gitDirectoryExists;
        this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    }
    /**
     * Called from guide completion, the one moment every fact is in hand.
     * Overwrites an older record for the same app: a re-install is a new
     * provenance, not an update to the old one.
     */
    recordGuideSourceClone(options) {
        this.write(options.appSlug, {
            appSlug: options.appSlug,
            provenance: "guide_source_clone",
            clonePath: options.clonePath,
            pinnedCommit: options.pinnedCommit,
            canonicalRepo: options.canonicalRepo,
            recordedAt: this.nowIso(),
        });
        (0, trace_1.maintainTrace)(`provenance recorded: ${options.appSlug} is a guide-source clone at ${options.clonePath}`);
    }
    recordSignedDownload(appSlug) {
        this.write(appSlug, {
            appSlug,
            provenance: "signed_app_download",
            clonePath: null,
            pinnedCommit: null,
            canonicalRepo: null,
            recordedAt: this.nowIso(),
        });
        (0, trace_1.maintainTrace)(`provenance recorded: ${appSlug} is a signed download — local patching stays off`);
    }
    provenanceForAppSlug(appSlug) {
        return this.persistence.readAllProvenanceRecords()[appSlug] ?? null;
    }
    /**
     * The D4 gate, in one place. Unknown = signed = no local patching. Fails
     * closed on every path: no record, wrong provenance, a `guide_source_clone`
     * record missing its clone path, or a clone path whose `.git` no longer
     * exists (the record can outlive the clone — the user deleted the folder,
     * or a wipe took it — at which point a recorded path that no longer holds a
     * git repo is unknown provenance again, exactly like Swift).
     */
    localPatchingIsPermitted(appSlug) {
        const record = this.provenanceForAppSlug(appSlug);
        if (record === null || record.provenance !== "guide_source_clone" || !record.clonePath) {
            return false;
        }
        const permitted = this.checkGitDirectoryExists(record.clonePath);
        if (!permitted) {
            (0, trace_1.maintainTrace)(`local patching blocked for ${appSlug}: recorded clone at ${record.clonePath} has no .git anymore`);
        }
        return permitted;
    }
    write(appSlug, record) {
        const all = { ...this.persistence.readAllProvenanceRecords() };
        all[appSlug] = record;
        this.persistence.writeAllProvenanceRecords(all);
    }
}
exports.InstallProvenanceStore = InstallProvenanceStore;
