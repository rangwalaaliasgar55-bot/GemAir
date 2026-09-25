"use strict";
//
// Local fixes against a moving upstream, without divergence hell. A fix GemAir
// applied is not "the diff currently on disk" — it is a NAMED patch keyed to
// its recipe and signature, recorded here the moment it lands, so that when
// the app updates the queue can be popped, upstream pulled, and every named
// patch replayed one at a time. A conflict then belongs to ONE patch, not to
// an opaque merge — quilt's model, because forty years of distro packaging
// found nothing better.
//
// Two rules the replay honors, both paid for elsewhere first:
//   - a clean textual merge proves nothing; the verification gate re-runs
//     after every replay, unconditionally (the caller's job, not this file's —
//     see `verification-harness.ts`).
//   - when upstream lands its own version of a patch, the local one is
//     DROPPED and the supersession reported to the pool — fork hygiene and a
//     high-value signal ("stop proposing this, it's upstream now").
//
// Ported from `PatchQueue.swift`. Swift talks to `FileManager` directly, with
// only the base directory injected; this port keeps that shape but names the
// seam (`PatchQueueStorage`) rather than reaching for `node:fs` inline, so the
// class matches this codebase's "every OS-touching capability is an injected
// parameter with a real implementation and an explicit test fake" convention
// (see `autopilot/shell.ts`'s `ShellSession`/`MockShell`). `node:fs` is not a
// Windows-only API — it is used directly inside `FileSystemPatchQueueStorage`
// below, the same way `verification-commands.ts`'s real file-existence checks
// do — so this module still runs the real implementation on any host; the seam
// exists for testability and symmetry with the rest of `services/maintain/`,
// not because `fs` needs hiding from Windows.
//
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
exports.PatchQueue = exports.InMemoryPatchQueueStorage = exports.FileSystemPatchQueueStorage = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const trace_1 = require("./trace");
const maintain_shell_runner_1 = require("./maintain-shell-runner");
/// The real implementation: one JSON file per `(appSlug, recipeId)` under
/// `<baseDirectoryPath>/<appSlug>/<recipeId>.json`, matching Swift's
/// `Application Support/Iris/patch-queue` layout. The caller (`main/maintain/`)
/// passes `path.join(app.getPath("userData"), "patch-queue")` as the base —
/// this module never touches Electron itself, so it stays testable on any host
/// by pointing it at a temp directory.
class FileSystemPatchQueueStorage {
    baseDirectoryPath;
    constructor(baseDirectoryPath) {
        this.baseDirectoryPath = baseDirectoryPath;
    }
    list(appSlug) {
        const directory = path.join(this.baseDirectoryPath, appSlug);
        let entries;
        try {
            entries = fs.readdirSync(directory);
        }
        catch {
            return [];
        }
        return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
    }
    read(appSlug, recipeId) {
        try {
            const raw = fs.readFileSync(this.filePath(appSlug, recipeId), "utf-8");
            return JSON.parse(raw);
        }
        catch {
            return undefined;
        }
    }
    write(patch) {
        const directory = path.join(this.baseDirectoryPath, patch.appSlug);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(this.filePath(patch.appSlug, patch.recipeId), JSON.stringify(patch, null, 2), "utf-8");
    }
    remove(appSlug, recipeId) {
        try {
            fs.unlinkSync(this.filePath(appSlug, recipeId));
        }
        catch {
            // Already gone — removing a patch that was never queued is not an error.
        }
    }
    filePath(appSlug, recipeId) {
        return path.join(this.baseDirectoryPath, appSlug, `${recipeId}.json`);
    }
}
exports.FileSystemPatchQueueStorage = FileSystemPatchQueueStorage;
/// An in-memory fake for the vitest suite: no disk, so tests that only care
/// about queueing/sorting/removal logic never pay for real file I/O.
class InMemoryPatchQueueStorage {
    patchesByAppSlug = new Map();
    list(appSlug) {
        return Array.from(this.patchesByAppSlug.get(appSlug)?.keys() ?? []);
    }
    read(appSlug, recipeId) {
        return this.patchesByAppSlug.get(appSlug)?.get(recipeId);
    }
    write(patch) {
        const patchesForThisApp = this.patchesByAppSlug.get(patch.appSlug) ?? new Map();
        patchesForThisApp.set(patch.recipeId, patch);
        this.patchesByAppSlug.set(patch.appSlug, patchesForThisApp);
    }
    remove(appSlug, recipeId) {
        this.patchesByAppSlug.get(appSlug)?.delete(recipeId);
    }
}
exports.InMemoryPatchQueueStorage = InMemoryPatchQueueStorage;
class PatchQueue {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    // MARK: - Recording
    record(patch) {
        this.storage.write(patch);
        (0, trace_1.maintainTrace)(`patch queued for ${patch.appSlug} (recipe ${patch.recipeId})`);
    }
    /// Every patch queued for one app, oldest-applied first — the order replay
    /// walks the queue in.
    patchesForAppSlug(appSlug) {
        return this.storage
            .list(appSlug)
            .map((recipeId) => this.storage.read(appSlug, recipeId))
            .filter((patch) => patch !== undefined)
            .sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt));
    }
    remove(appSlug, recipeId) {
        this.storage.remove(appSlug, recipeId);
    }
    // MARK: - Replay across an upstream update
    /// Replays every queued patch for one app after its clone moved to a new
    /// upstream commit. The caller has already popped the working tree back to
    /// clean upstream state; this walks the queue oldest-first, exactly as
    /// `patchesForAppSlug` orders it.
    async replayAll(appSlug, runner) {
        const results = [];
        for (const patch of this.patchesForAppSlug(appSlug)) {
            const disposition = await this.replay(patch, runner);
            results.push({ patch, disposition });
        }
        return results;
    }
    async replay(patch, runner) {
        const patchFileName = `.gemair-replay-${patch.recipeId}.patch`;
        const patchFilePath = path.join(runner.repoRootPath, patchFileName);
        try {
            try {
                fs.writeFileSync(patchFilePath, patch.patchText, "utf-8");
            }
            catch {
                return "conflicted";
            }
            // Already upstream? `--reverse --check` succeeding means the tree
            // ALREADY CONTAINS the patch — upstream landed an equivalent change.
            const reverseCheck = await (0, maintain_shell_runner_1.tryRun)(runner, `git apply --reverse --check ${patchFileName}`, {
                deadlineMs: 60_000,
            });
            if (reverseCheck?.succeeded === true) {
                this.remove(patch.appSlug, patch.recipeId);
                (0, trace_1.maintainTrace)(`patch ${patch.recipeId} superseded by upstream — dropped`);
                return "supersededByUpstream";
            }
            const applied = await (0, maintain_shell_runner_1.tryRun)(runner, `git apply --3way ${patchFileName}`, { deadlineMs: 60_000 });
            if (applied?.succeeded === true) {
                return "replayed";
            }
            // Leave conflict markers out of the tree: a conflicted 3way can
            // half-land; reset so the tree stays honestly upstream.
            //
            // `git reset --hard HEAD`, not `git checkout -- .`: a failed `--3way`
            // apply leaves the conflicted path with THREE unmerged stages in the
            // index (`git apply --3way` implies `--index`), and `git checkout --
            // <path>` refuses to touch a path in that state ("error: path
            // 'feature.js' is unmerged") — it silently no-ops on exactly the file
            // this step exists to clean up, leaving the `<<<<<<< ours` / `=======`
            // / `>>>>>>> theirs` markers sitting in the working tree. This is a
            // real, proven divergence from the literal command text ported from
            // `PatchQueue.swift` / the recovered `dist/patch-queue.js`
            // (`"git checkout -- . && git clean -fd --quiet"`, byte-identical in
            // both) — caught by this file's own real-git-backed conflict test, not
            // a hypothetical. `git reset --hard HEAD` is the one command that
            // actually clears an unmerged index and restores the tracked file to
            // HEAD, so it is what the comment above (and Swift's own stated
            // intent — "the tree stays honestly upstream") actually requires. Per
            // the porting ground rules, this is BEHAVIOR parity: the documented
            // intent is preserved exactly; the literal command text is not.
            await (0, maintain_shell_runner_1.tryRun)(runner, "git reset --hard HEAD && git clean -fd --quiet", { deadlineMs: 120_000 });
            (0, trace_1.maintainTrace)(`patch ${patch.recipeId} conflicted on replay — kept queued, tree reset`);
            return "conflicted";
        }
        finally {
            try {
                fs.unlinkSync(patchFilePath);
            }
            catch {
                // Best-effort cleanup, mirrors Swift's `try? FileManager...removeItem`.
            }
        }
    }
}
exports.PatchQueue = PatchQueue;
