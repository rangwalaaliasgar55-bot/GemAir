"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("./vitest-shim");
const install_provenance_1 = require("../../lib/iris/services/maintain/install-provenance");
/**
 * The D4 gate: unknown provenance, a signed download, or a guide-source clone
 * whose `.git` has since vanished, must all fail closed. `localPatchingIsPermitted`
 * is the one function every downstream maintain-mode module checks before
 * touching a file, so it gets the most direct coverage here.
 */
(0, vitest_1.describe)("decideInstallProvenance — the pure install-finish decision", () => {
    (0, vitest_1.it)("records a guide-source clone for a desktop app that cloned, carrying repo + commit + clone path", () => {
        (0, vitest_1.expect)((0, install_provenance_1.decideInstallProvenance)({
            outputType: "desktop_app",
            clonedARepo: true,
            clonePath: "C:\\Users\\test\\demoapp",
            canonicalRepo: "gemair-demo/demoapp",
            pinnedCommit: "a53a359b985b1d2d666266062936cc186f02340b",
        })).toEqual({
            kind: "guide_source_clone",
            clonePath: "C:\\Users\\test\\demoapp",
            canonicalRepo: "gemair-demo/demoapp",
            pinnedCommit: "a53a359b985b1d2d666266062936cc186f02340b",
        });
    });
    (0, vitest_1.it)("records a signed download for a desktop app that did not clone", () => {
        (0, vitest_1.expect)((0, install_provenance_1.decideInstallProvenance)({
            outputType: "desktop_app",
            clonedARepo: false,
            clonePath: undefined,
            canonicalRepo: undefined,
            pinnedCommit: undefined,
        })).toEqual({ kind: "signed_app_download" });
    });
    (0, vitest_1.it)("fails closed to a signed download when a clone is claimed but no clone path landed", () => {
        // A guide_source_clone whose path we cannot pin is unpatchable — the D4
        // gate's "unknown = signed = don't touch it" instinct applies here too.
        (0, vitest_1.expect)((0, install_provenance_1.decideInstallProvenance)({
            outputType: "desktop_app",
            clonedARepo: true,
            clonePath: undefined,
            canonicalRepo: "gemair-demo/demoapp",
            pinnedCommit: "abc",
        })).toEqual({ kind: "signed_app_download" });
    });
    (0, vitest_1.it)("nulls a missing repo/commit rather than recording undefined", () => {
        (0, vitest_1.expect)((0, install_provenance_1.decideInstallProvenance)({
            outputType: "desktop_app",
            clonedARepo: true,
            clonePath: "C:\\clone",
            canonicalRepo: undefined,
            pinnedCommit: undefined,
        })).toEqual({ kind: "guide_source_clone", clonePath: "C:\\clone", canonicalRepo: null, pinnedCommit: null });
    });
    (0, vitest_1.it)("records nothing for a local_web install — a dev server has no binary to patch", () => {
        (0, vitest_1.expect)((0, install_provenance_1.decideInstallProvenance)({
            outputType: "local_web",
            clonedARepo: true,
            clonePath: "C:\\Users\\test\\OpenASCII",
            canonicalRepo: "Blueturboguy07/OpenASCII",
            pinnedCommit: "8fc32ce",
        })).toEqual({ kind: "none" });
    });
    (0, vitest_1.it)("records nothing for a credential or none install", () => {
        (0, vitest_1.expect)((0, install_provenance_1.decideInstallProvenance)({ outputType: "credential", clonedARepo: false, clonePath: undefined, canonicalRepo: undefined, pinnedCommit: undefined })).toEqual({ kind: "none" });
        (0, vitest_1.expect)((0, install_provenance_1.decideInstallProvenance)({ outputType: "none", clonedARepo: false, clonePath: undefined, canonicalRepo: undefined, pinnedCommit: undefined })).toEqual({ kind: "none" });
    });
});
(0, vitest_1.describe)("recording provenance", () => {
    (0, vitest_1.it)("records a guide-source clone with every field the guide-completion moment supplies", () => {
        const store = new install_provenance_1.InstallProvenanceStore({
            persistence: new install_provenance_1.InMemoryInstallProvenancePersistence(),
            nowIso: () => "2026-08-15T00:00:00.000Z",
        });
        store.recordGuideSourceClone({
            appSlug: "cue",
            clonePath: "C:\\Users\\test\\gemair-apps\\cue",
            pinnedCommit: "abc123",
            canonicalRepo: "Blueturboguy07/cue",
        });
        (0, vitest_1.expect)(store.provenanceForAppSlug("cue")).toEqual({
            appSlug: "cue",
            provenance: "guide_source_clone",
            clonePath: "C:\\Users\\test\\gemair-apps\\cue",
            pinnedCommit: "abc123",
            canonicalRepo: "Blueturboguy07/cue",
            recordedAt: "2026-08-15T00:00:00.000Z",
        });
    });
    (0, vitest_1.it)("records a signed download with null clone/commit/repo fields", () => {
        const store = new install_provenance_1.InstallProvenanceStore({
            persistence: new install_provenance_1.InMemoryInstallProvenancePersistence(),
            nowIso: () => "2026-08-15T00:00:00.000Z",
        });
        store.recordSignedDownload("cue");
        (0, vitest_1.expect)(store.provenanceForAppSlug("cue")).toEqual({
            appSlug: "cue",
            provenance: "signed_app_download",
            clonePath: null,
            pinnedCommit: null,
            canonicalRepo: null,
            recordedAt: "2026-08-15T00:00:00.000Z",
        });
    });
    (0, vitest_1.it)("overwrites an older record for the same app slug on a re-install, rather than merging", () => {
        const store = new install_provenance_1.InstallProvenanceStore({ persistence: new install_provenance_1.InMemoryInstallProvenancePersistence() });
        store.recordGuideSourceClone({ appSlug: "cue", clonePath: "C:\\old", pinnedCommit: "old-sha", canonicalRepo: "x/y" });
        store.recordSignedDownload("cue");
        (0, vitest_1.expect)(store.provenanceForAppSlug("cue")?.provenance).toBe("signed_app_download");
        (0, vitest_1.expect)(store.provenanceForAppSlug("cue")?.clonePath).toBeNull();
    });
    (0, vitest_1.it)("returns null for an app with no recorded provenance", () => {
        const store = new install_provenance_1.InstallProvenanceStore({ persistence: new install_provenance_1.InMemoryInstallProvenancePersistence() });
        (0, vitest_1.expect)(store.provenanceForAppSlug("never-installed")).toBeNull();
    });
});
(0, vitest_1.describe)("localPatchingIsPermitted — the D4 gate, fails closed on every path", () => {
    (0, vitest_1.it)("refuses when there is no record at all", () => {
        const store = new install_provenance_1.InstallProvenanceStore({ persistence: new install_provenance_1.InMemoryInstallProvenancePersistence() });
        (0, vitest_1.expect)(store.localPatchingIsPermitted("cue")).toBe(false);
    });
    (0, vitest_1.it)("refuses a signed download unconditionally, even if a git check would somehow say yes", () => {
        const store = new install_provenance_1.InstallProvenanceStore({
            persistence: new install_provenance_1.InMemoryInstallProvenancePersistence(),
            checkGitDirectoryExists: () => true,
        });
        store.recordSignedDownload("cue");
        (0, vitest_1.expect)(store.localPatchingIsPermitted("cue")).toBe(false);
    });
    (0, vitest_1.it)("permits a guide-source clone whose .git the check confirms still exists", () => {
        const store = new install_provenance_1.InstallProvenanceStore({
            persistence: new install_provenance_1.InMemoryInstallProvenancePersistence(),
            checkGitDirectoryExists: (clonePath) => clonePath === "C:\\Users\\test\\cue",
        });
        store.recordGuideSourceClone({
            appSlug: "cue",
            clonePath: "C:\\Users\\test\\cue",
            pinnedCommit: "abc",
            canonicalRepo: "x/y",
        });
        (0, vitest_1.expect)(store.localPatchingIsPermitted("cue")).toBe(true);
    });
    (0, vitest_1.it)("refuses a guide-source clone whose .git the check says is gone — the record outlived the folder", () => {
        const store = new install_provenance_1.InstallProvenanceStore({
            persistence: new install_provenance_1.InMemoryInstallProvenancePersistence(),
            checkGitDirectoryExists: () => false,
        });
        store.recordGuideSourceClone({ appSlug: "cue", clonePath: "C:\\deleted", pinnedCommit: "abc", canonicalRepo: "x/y" });
        (0, vitest_1.expect)(store.localPatchingIsPermitted("cue")).toBe(false);
    });
    (0, vitest_1.it)("refuses a guide-source clone record with an empty clone path without ever calling the git check", () => {
        let checkWasCalled = false;
        const store = new install_provenance_1.InstallProvenanceStore({
            persistence: new install_provenance_1.InMemoryInstallProvenancePersistence(),
            checkGitDirectoryExists: () => {
                checkWasCalled = true;
                return true;
            },
        });
        store.recordGuideSourceClone({ appSlug: "cue", clonePath: "", pinnedCommit: null, canonicalRepo: null });
        (0, vitest_1.expect)(store.localPatchingIsPermitted("cue")).toBe(false);
        (0, vitest_1.expect)(checkWasCalled).toBe(false);
    });
});
(0, vitest_1.describe)("gitDirectoryExists — the real, default git check", () => {
    let tempDir;
    (0, vitest_1.afterEach)(() => {
        if (tempDir)
            (0, node_fs_1.rmSync)(tempDir, { recursive: true, force: true });
        tempDir = undefined;
    });
    (0, vitest_1.it)("is true for a clone with a real .git directory", () => {
        tempDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "gemair-maintain-provenance-"));
        const clonePath = (0, node_path_1.join)(tempDir, "cue");
        (0, node_fs_1.mkdirSync)((0, node_path_1.join)(clonePath, ".git"), { recursive: true });
        (0, vitest_1.expect)((0, install_provenance_1.gitDirectoryExists)(clonePath)).toBe(true);
    });
    (0, vitest_1.it)("is true for a git worktree, whose .git is a plain file, not a directory — matching Swift's fileExists check", () => {
        tempDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "gemair-maintain-provenance-"));
        const clonePath = (0, node_path_1.join)(tempDir, "worktree");
        (0, node_fs_1.mkdirSync)(clonePath, { recursive: true });
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(clonePath, ".git"), "gitdir: ../main/.git/worktrees/worktree\n");
        (0, vitest_1.expect)((0, install_provenance_1.gitDirectoryExists)(clonePath)).toBe(true);
    });
    (0, vitest_1.it)("is false when the clone path does not exist at all", () => {
        tempDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "gemair-maintain-provenance-"));
        (0, vitest_1.expect)((0, install_provenance_1.gitDirectoryExists)((0, node_path_1.join)(tempDir, "never-existed"))).toBe(false);
    });
    (0, vitest_1.it)("is false, not throwing, for an unreadable/invalid path", () => {
        (0, vitest_1.expect)((0, install_provenance_1.gitDirectoryExists)("\0invalid")).toBe(false);
    });
});
