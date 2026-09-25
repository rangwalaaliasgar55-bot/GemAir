"use strict";
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
const vitest_1 = require("./vitest-shim");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const patch_queue_1 = require("../../lib/iris/services/maintain/patch-queue");
const maintain_shell_runner_1 = require("../../lib/iris/services/maintain/maintain-shell-runner");
const maintain_real_git_shell_runner_1 = require("./fixtures/maintain-real-git-shell-runner");
/**
 * Quilt semantics: named patches, replayed oldest-applied-first, a clean
 * reverse-apply meaning "upstream already has this" (drop + report), and a
 * conflicted 3-way leaving the tree exactly as clean upstream left it. The
 * storage round-trip (both the in-memory fake and the real filesystem
 * implementation) is scripted; the replay disposition logic is proven against
 * a real git repository, because "did the 3-way apply actually conflict" is
 * not something a mock can honestly answer.
 */
function patch(overrides = {}) {
    return {
        recipeId: "recipe-1",
        signatureId: "sig-1",
        appSlug: "demo-app",
        branchName: "gemair/fix-sig1-20260101",
        patchText: "--- a/x\n+++ b/x\n",
        appliedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}
(0, vitest_1.describe)("InMemoryPatchQueueStorage", () => {
    (0, vitest_1.it)("round-trips write/read/list/remove, scoped per appSlug", () => {
        const storage = new patch_queue_1.InMemoryPatchQueueStorage();
        storage.write(patch({ appSlug: "app-a", recipeId: "r1" }));
        storage.write(patch({ appSlug: "app-a", recipeId: "r2" }));
        storage.write(patch({ appSlug: "app-b", recipeId: "r1" }));
        (0, vitest_1.expect)(storage.list("app-a").sort()).toEqual(["r1", "r2"]);
        (0, vitest_1.expect)(storage.list("app-b")).toEqual(["r1"]);
        (0, vitest_1.expect)(storage.list("app-c")).toEqual([]);
        (0, vitest_1.expect)(storage.read("app-a", "r1")?.recipeId).toBe("r1");
        (0, vitest_1.expect)(storage.read("app-a", "does-not-exist")).toBeUndefined();
        storage.remove("app-a", "r1");
        (0, vitest_1.expect)(storage.list("app-a")).toEqual(["r2"]);
        // Removing an app-b patch never touches app-a's.
        (0, vitest_1.expect)(storage.list("app-b")).toEqual(["r1"]);
    });
    (0, vitest_1.it)("removing a patch that was never queued is not an error", () => {
        const storage = new patch_queue_1.InMemoryPatchQueueStorage();
        (0, vitest_1.expect)(() => storage.remove("nobody-queued-here", "r1")).not.toThrow();
    });
});
(0, vitest_1.describe)("FileSystemPatchQueueStorage", () => {
    let baseDirectoryPath;
    (0, vitest_1.beforeEach)(() => {
        baseDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "gemair-maintain-pq-"));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(baseDirectoryPath, { recursive: true, force: true });
    });
    (0, vitest_1.it)("writes one JSON file per (appSlug, recipeId), and list() strips the .json suffix", () => {
        const storage = new patch_queue_1.FileSystemPatchQueueStorage(baseDirectoryPath);
        storage.write(patch({ appSlug: "demo-app", recipeId: "r1" }));
        const writtenPath = path.join(baseDirectoryPath, "demo-app", "r1.json");
        (0, vitest_1.expect)(fs.existsSync(writtenPath)).toBe(true);
        (0, vitest_1.expect)(storage.list("demo-app")).toEqual(["r1"]);
        const readBack = storage.read("demo-app", "r1");
        (0, vitest_1.expect)(readBack).toEqual(patch({ appSlug: "demo-app", recipeId: "r1" }));
    });
    (0, vitest_1.it)("creates the app subdirectory on first write; list() on an unknown app is empty, not a throw", () => {
        const storage = new patch_queue_1.FileSystemPatchQueueStorage(baseDirectoryPath);
        (0, vitest_1.expect)(storage.list("never-written")).toEqual([]);
        (0, vitest_1.expect)(storage.read("never-written", "r1")).toBeUndefined();
    });
    (0, vitest_1.it)("remove() deletes the file and is a no-op the second time", () => {
        const storage = new patch_queue_1.FileSystemPatchQueueStorage(baseDirectoryPath);
        storage.write(patch({ appSlug: "demo-app", recipeId: "r1" }));
        storage.remove("demo-app", "r1");
        (0, vitest_1.expect)(storage.list("demo-app")).toEqual([]);
        (0, vitest_1.expect)(() => storage.remove("demo-app", "r1")).not.toThrow();
    });
    (0, vitest_1.it)("survives a corrupt JSON file by treating it as unreadable, not by throwing", () => {
        const storage = new patch_queue_1.FileSystemPatchQueueStorage(baseDirectoryPath);
        fs.mkdirSync(path.join(baseDirectoryPath, "demo-app"), { recursive: true });
        fs.writeFileSync(path.join(baseDirectoryPath, "demo-app", "r1.json"), "{ not valid json");
        (0, vitest_1.expect)(storage.read("demo-app", "r1")).toBeUndefined();
        // The corrupt file is still enumerable by list() — reading it is what
        // fails, not listing it.
        (0, vitest_1.expect)(storage.list("demo-app")).toEqual(["r1"]);
    });
});
(0, vitest_1.describe)("PatchQueue — recording and ordering", () => {
    (0, vitest_1.it)("orders patchesForAppSlug oldest-applied-first, regardless of write order", () => {
        const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        queue.record(patch({ recipeId: "newest", appliedAt: "2026-03-01T00:00:00.000Z" }));
        queue.record(patch({ recipeId: "oldest", appliedAt: "2026-01-01T00:00:00.000Z" }));
        queue.record(patch({ recipeId: "middle", appliedAt: "2026-02-01T00:00:00.000Z" }));
        (0, vitest_1.expect)(queue.patchesForAppSlug("demo-app").map((p) => p.recipeId)).toEqual(["oldest", "middle", "newest"]);
    });
    (0, vitest_1.it)("keeps queues for different apps independent", () => {
        const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        queue.record(patch({ appSlug: "app-a", recipeId: "r1" }));
        queue.record(patch({ appSlug: "app-b", recipeId: "r1" }));
        (0, vitest_1.expect)(queue.patchesForAppSlug("app-a")).toHaveLength(1);
        (0, vitest_1.expect)(queue.patchesForAppSlug("app-b")).toHaveLength(1);
    });
    (0, vitest_1.it)("remove() takes a patch out of future replay ordering", () => {
        const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        queue.record(patch({ recipeId: "r1" }));
        queue.remove("demo-app", "r1");
        (0, vitest_1.expect)(queue.patchesForAppSlug("demo-app")).toEqual([]);
    });
    (0, vitest_1.it)("replayAll walks the queue oldest-first and reports one disposition per patch", async () => {
        // `PatchQueue.replay` writes/unlinks a real scratch patch file beside the
        // repo regardless of whether the git commands themselves are mocked —
        // `repoRootPath` has to be a real, writable directory for that reason,
        // even though every git command outcome here is scripted.
        const scratchRepoRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "gemair-maintain-pq-mock-"));
        try {
            const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
            queue.record(patch({ recipeId: "newest", appliedAt: "2026-03-01T00:00:00.000Z" }));
            queue.record(patch({ recipeId: "oldest", appliedAt: "2026-01-01T00:00:00.000Z" }));
            const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds(scratchRepoRootPath);
            const results = await queue.replayAll("demo-app", runner);
            (0, vitest_1.expect)(results.map((r) => r.patch.recipeId)).toEqual(["oldest", "newest"]);
            // Every replay attempted a reverse-check first; since the mock says every
            // command "succeeds", the reverse-check itself succeeding is read as
            // "already upstream" — exercising the supersession branch for real is
            // the real git suite's job below, this one just proves the walk order
            // and that every queued patch gets exactly one disposition.
            (0, vitest_1.expect)(results.every((r) => r.disposition === "supersededByUpstream")).toBe(true);
        }
        finally {
            fs.rmSync(scratchRepoRootPath, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)("replayAll on an empty queue does nothing and returns no results", async () => {
        const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const results = await queue.replayAll("never-queued-anything", runner);
        (0, vitest_1.expect)(results).toEqual([]);
        (0, vitest_1.expect)(runner.commandsRun).toEqual([]);
    });
});
(0, vitest_1.describe)("PatchQueue.replayAll — against a real git repository", () => {
    let repoRootPath;
    (0, vitest_1.beforeEach)(() => {
        repoRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "gemair-maintain-pq-git-"));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(repoRootPath, { recursive: true, force: true });
    });
    const FEATURE_FILE = "feature.js";
    const BASE_LINES = ["const label = \"start\";", "const value = 1;", "const trailer = \"end\";", ""].join("\n");
    const FIXED_LINES = ["const label = \"start\";", "const value = 2;", "const trailer = \"end\";", ""].join("\n");
    const UPSTREAM_DIVERGED_LINES = [
        "const label = \"start\";",
        "const value = 999; // upstream changed this a completely different way",
        "const trailer = \"end\";",
        "",
    ].join("\n");
    async function commitEverything(runner, message) {
        await runner.run("git add -A");
        await runner.run(`git commit --quiet -m "${message}"`);
    }
    /// Writes the base file, commits it, edits it to the fixed version
    /// (uncommitted), captures the real `git diff` as the patch text, then
    /// restores the working tree to the clean base commit — leaving the repo
    /// exactly where `PatchQueue.replay` expects to find it: clean, at some
    /// known commit, with a named patch queued but not applied.
    async function buildPatchAgainstCleanBase(runner) {
        fs.writeFileSync(path.join(repoRootPath, FEATURE_FILE), BASE_LINES);
        await commitEverything(runner, "base");
        fs.writeFileSync(path.join(repoRootPath, FEATURE_FILE), FIXED_LINES);
        const diff = await runner.run("git diff");
        await runner.run("git checkout -- .");
        return diff.outputTail;
    }
    (0, vitest_1.it)("replays a patch cleanly against a base that does not yet contain the fix", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        const patchText = await buildPatchAgainstCleanBase(runner);
        const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        queue.record(patch({ patchText }));
        const results = await queue.replayAll("demo-app", runner);
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results[0]?.disposition).toBe("replayed");
        (0, vitest_1.expect)(fs.readFileSync(path.join(repoRootPath, FEATURE_FILE), "utf-8")).toBe(FIXED_LINES);
        // A successfully replayed patch stays queued — only supersession drops it.
        (0, vitest_1.expect)(queue.patchesForAppSlug("demo-app")).toHaveLength(1);
        // The scratch patch file never survives its own replay.
        (0, vitest_1.expect)(fs.existsSync(path.join(repoRootPath, `.gemair-replay-${patch().recipeId}.patch`))).toBe(false);
    }, 20_000);
    (0, vitest_1.it)("detects upstream supersession — a reverse-apply that succeeds means the fix already landed", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        const patchText = await buildPatchAgainstCleanBase(runner);
        // Simulate upstream having merged the identical fix on its own.
        fs.writeFileSync(path.join(repoRootPath, FEATURE_FILE), FIXED_LINES);
        await commitEverything(runner, "upstream landed the same fix");
        const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        queue.record(patch({ patchText }));
        const results = await queue.replayAll("demo-app", runner);
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results[0]?.disposition).toBe("supersededByUpstream");
        // Dropped from the queue — re-proposing an already-upstream fix is pure noise.
        (0, vitest_1.expect)(queue.patchesForAppSlug("demo-app")).toEqual([]);
        // The tree is untouched by the (failed, by design) forward apply attempt.
        (0, vitest_1.expect)(fs.readFileSync(path.join(repoRootPath, FEATURE_FILE), "utf-8")).toBe(FIXED_LINES);
    }, 20_000);
    (0, vitest_1.it)("reports a conflicted replay and resets the tree to clean upstream, keeping the patch queued", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        const patchText = await buildPatchAgainstCleanBase(runner);
        // Upstream changed the very same line in an incompatible way.
        fs.writeFileSync(path.join(repoRootPath, FEATURE_FILE), UPSTREAM_DIVERGED_LINES);
        await commitEverything(runner, "upstream diverged on the same line");
        const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        queue.record(patch({ patchText }));
        const results = await queue.replayAll("demo-app", runner);
        (0, vitest_1.expect)(results).toHaveLength(1);
        (0, vitest_1.expect)(results[0]?.disposition).toBe("conflicted");
        // Still queued — a conflict is surfaced, never silently dropped.
        (0, vitest_1.expect)(queue.patchesForAppSlug("demo-app")).toHaveLength(1);
        // No half-merged conflict markers left behind: the tree is reset to
        // exactly what upstream committed.
        (0, vitest_1.expect)(fs.readFileSync(path.join(repoRootPath, FEATURE_FILE), "utf-8")).toBe(UPSTREAM_DIVERGED_LINES);
        const status = await runner.run("git status --porcelain");
        (0, vitest_1.expect)(status.outputTail.trim()).toBe("");
    }, 20_000);
    (0, vitest_1.it)("replays every queued patch for an app oldest-first against a real repo", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        fs.writeFileSync(path.join(repoRootPath, "a.txt"), "a\n");
        fs.writeFileSync(path.join(repoRootPath, "b.txt"), "b\n");
        await commitEverything(runner, "base");
        fs.writeFileSync(path.join(repoRootPath, "a.txt"), "a-fixed\n");
        const patchA = (await runner.run("git diff -- a.txt")).outputTail;
        await runner.run("git checkout -- a.txt");
        fs.writeFileSync(path.join(repoRootPath, "b.txt"), "b-fixed\n");
        const patchB = (await runner.run("git diff -- b.txt")).outputTail;
        await runner.run("git checkout -- b.txt");
        const queue = new patch_queue_1.PatchQueue(new patch_queue_1.InMemoryPatchQueueStorage());
        // Recorded out of order; replay must still walk oldest-applied-first.
        queue.record(patch({ recipeId: "b", patchText: patchB, appliedAt: "2026-02-01T00:00:00.000Z" }));
        queue.record(patch({ recipeId: "a", patchText: patchA, appliedAt: "2026-01-01T00:00:00.000Z" }));
        const results = await queue.replayAll("demo-app", runner);
        (0, vitest_1.expect)(results.map((r) => r.patch.recipeId)).toEqual(["a", "b"]);
        (0, vitest_1.expect)(results.every((r) => r.disposition === "replayed")).toBe(true);
        (0, vitest_1.expect)(fs.readFileSync(path.join(repoRootPath, "a.txt"), "utf-8")).toBe("a-fixed\n");
        (0, vitest_1.expect)(fs.readFileSync(path.join(repoRootPath, "b.txt"), "utf-8")).toBe("b-fixed\n");
    }, 20_000);
});
