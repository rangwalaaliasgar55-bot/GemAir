"use strict";
/**
 * incoming-fix-reviewer.ts
 *
 * The Windows port of `iris-macos/leanring-buddy/IncomingFixReviewer.swift`.
 *
 * The owner's side of "someone else's machine fixed my app." When a fix PR
 * lands on a repo the connected user owns (`github-fork-service.ts`'s
 * `incomingFixPullRequests`), their GemAir does NOT merge on trust — it re-runs
 * the same verification gate the fix already passed on the stranger's
 * machine, on the owner's own machine, against the owner's own clone, and
 * only then offers to merge. A verification that passed somewhere else is
 * evidence; a verification that passes HERE is proof for this repo.
 *
 * This is the concrete meaning of the founder's rule: "if it's someone
 * else's, GemAir needs to see that and decide whether to merge the PR." The
 * seeing is `GitHubForkService.incomingFixPullRequests`; the deciding is this
 * file's re-verification; the merge is the owner's tap (or, once trust is
 * earned, automatic — a later decision) via `mergeIncomingFixPR`.
 *
 * GAP THIS FILE FILLS LOCALLY, FLAGGED RATHER THAN SILENT: the porting
 * spec's module table assigns the per-app-stack build/test command table
 * (Swift's `VerificationCommands.defaults(for:repoRootPath:)`) to its own
 * `verification-commands.ts` module — a separate porting task that has not
 * landed as of this file (confirmed absent; `verification-harness.ts`, which
 * DID land, ships only the `VerificationCommands` interface and
 * `verifyAppliedPatch`, not the defaults table — see that file's own
 * header). Re-verifying a PR needs *some* answer to "what do I build and
 * test for this stack", so `defaultVerificationCommandsForStack` below is a
 * straight, self-contained port of Swift's `.defaults` table, injectable via
 * the constructor's `verificationCommandsFor` (mirrors the porting spec's own
 * `fileOps` seam so the file-existence checks are testable without a real
 * clone on disk — same shape as `install-provenance.ts`'s injected
 * `checkGitDirectoryExists`). If `verification-commands.ts` lands later with
 * an equivalent export, swapping the default here for that import is a
 * one-line change; nothing about `review()`'s own logic depends on where the
 * table comes from.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IncomingFixReviewer = exports.REAL_VERIFICATION_COMMAND_FILE_OPS = void 0;
exports.defaultVerificationCommandsForStack = defaultVerificationCommandsForStack;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const maintain_shell_runner_1 = require("./maintain-shell-runner");
const trace_1 = require("./trace");
const verification_harness_1 = require("./verification-harness");
/** The real implementation: plain `node:fs` reads. Not Windows-specific — the
 *  same reasoning `install-provenance.ts`'s `gitDirectoryExists` gives for
 *  keeping its real filesystem check here rather than pushed into `main/`. */
exports.REAL_VERIFICATION_COMMAND_FILE_OPS = {
    hasFile(repoRootPath, relativePath) {
        try {
            return (0, node_fs_1.existsSync)((0, node_path_1.join)(repoRootPath, relativePath));
        }
        catch {
            return false;
        }
    },
    packageJsonHasScript(repoRootPath, relativePath, scriptName) {
        try {
            const parsed = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(repoRootPath, relativePath), "utf-8"));
            return parsed.scripts !== undefined && Object.prototype.hasOwnProperty.call(parsed.scripts, scriptName);
        }
        catch {
            return false;
        }
    },
};
/**
 * The default build/test vocabulary per app stack, ported straight from
 * Swift's `VerificationCommands.defaults(for:repoRootPath:)`. An app whose
 * repo carries no test script gets an absent test command and the suite leg
 * is skipped — recorded as skipped by `verifyAppliedPatch`, never silently
 * counted as green.
 */
function defaultVerificationCommandsForStack(appStack, repoRootPath, fileOps = exports.REAL_VERIFICATION_COMMAND_FILE_OPS) {
    switch (appStack) {
        case "tauri": {
            const hasUiPackageJson = fileOps.hasFile(repoRootPath, "ui/package.json");
            return {
                buildCommand: hasUiPackageJson
                    ? "cd ui && npm run build --if-present && cd .. && cargo build --release --quiet"
                    : "cargo build --release --quiet",
                testCommand: "cargo test --quiet",
            };
        }
        case "electron":
        case "nextjs": {
            const hasBuildScript = fileOps.packageJsonHasScript(repoRootPath, "package.json", "build");
            const hasTestScript = fileOps.packageJsonHasScript(repoRootPath, "package.json", "test");
            return {
                buildCommand: hasBuildScript ? "npm run build" : undefined,
                testCommand: hasTestScript ? "npm test" : undefined,
            };
        }
        // "swift-macos" is shared wire vocabulary (see `break-signature.ts`'s
        // header) that this Windows client never actually receives a PR for;
        // "other" genuinely has no vocabulary. Both skip build and test.
        case "swift-macos":
        case "other":
            return {};
    }
}
class IncomingFixReviewer {
    provenanceStore;
    createShellRunner;
    verificationCommandsFor;
    constructor(options) {
        this.provenanceStore = options.provenanceStore;
        this.createShellRunner = options.createShellRunner;
        this.verificationCommandsFor = options.verificationCommandsFor ?? defaultVerificationCommandsForStack;
    }
    /**
     * Re-verify one incoming fix PR against the owner's local clone. The PR
     * head is fetched into a detached worktree so the owner's own working tree
     * and branch are never touched; the worktree is torn down whatever
     * happens. Nothing is merged from this method — it only produces the
     * verdict the owner (or `github-fork-service.ts`'s `mergeIncomingFixPR`,
     * once they act on it) uses.
     */
    async review(pr, appSlug, appStack) {
        const record = this.provenanceStore.provenanceForAppSlug(appSlug);
        if (record === null || record.clonePath === null) {
            return { pr, reVerifiedHere: false, blockedStage: "no local clone to verify against" };
        }
        const clonePath = record.clonePath;
        const runner = this.createShellRunner(clonePath);
        // Fetch the PR head and add a detached worktree under the clone (the
        // runner's own boundary), so the owner's tree and branch are never
        // disturbed. Two separate commands, not one chained with a pipe, so a
        // failure is attributable to the step that actually failed.
        const fetchResult = await (0, maintain_shell_runner_1.tryRun)(runner, `git fetch ${singleQuoteForShell(pr.headRepoCloneUrl)} ${singleQuoteForShell(pr.headBranch)}`, { deadlineMs: 120_000 });
        if (fetchResult === undefined || !fetchResult.succeeded) {
            return { pr, reVerifiedHere: false, blockedStage: "could not fetch the PR" };
        }
        // From here on, a teardown attempt always runs before `review()` returns
        // — matching Swift's `defer`, which is registered right after the
        // (there, combined) fetch+add command, so even a worktree that only
        // half-formed gets a cleanup pass. A failed *fetch* above is the one
        // exception: nothing was ever created, so there is nothing to clean up,
        // and Swift's own cleanup in that case is already a harmless no-op
        // against a worktree name that was never added.
        const worktreeName = `.gemair-review-${pr.number}`;
        try {
            const addResult = await (0, maintain_shell_runner_1.tryRun)(runner, `git worktree add --detach ${singleQuoteForShell(worktreeName)} FETCH_HEAD`, {
                deadlineMs: 60_000,
            });
            if (addResult === undefined || !addResult.succeeded) {
                return { pr, reVerifiedHere: false, blockedStage: "could not create a review worktree" };
            }
            const worktreePath = (0, node_path_1.join)(clonePath, worktreeName);
            const worktreeRunner = this.createShellRunner(worktreePath);
            const commands = this.verificationCommandsFor(appStack, worktreePath);
            // `reproCommand: undefined` — the PR carries no repro test (its
            // evidence came from the stranger's machine), so the replay standard
            // applies: legs 1-3 are skipped, and only `earnsCleanApply` (build +
            // suite green) is ever offered here, never `earnsVerifiedFix`.
            const outcome = await (0, verification_harness_1.verifyAppliedPatch)(worktreeRunner, commands, undefined);
            const reVerifiedHere = (0, verification_harness_1.earnsCleanApply)(outcome);
            (0, trace_1.maintainTrace)(`github: re-verified PR #${pr.number} here — clean=${reVerifiedHere} blocked=${outcome.blockedStage ?? "none"}`);
            return { pr, reVerifiedHere, blockedStage: outcome.blockedStage ?? null };
        }
        finally {
            // Best-effort teardown, mirrors Swift's `try? ... worktree remove`.
            // Unlike Swift's fire-and-forget `Task { ... }` inside `defer`, this is
            // awaited: the caller only sees `review()` resolve once the worktree is
            // gone, which is strictly more deterministic (useful for tests) and no
            // less safe — either way cleanup is best-effort and never changes the
            // verdict already computed above.
            await (0, maintain_shell_runner_1.tryRun)(runner, `git worktree remove --force ${singleQuoteForShell(worktreeName)}`, { deadlineMs: 60_000 });
        }
    }
}
exports.IncomingFixReviewer = IncomingFixReviewer;
/** Quotes a value as a single-quoted shell literal (doubling embedded single
 *  quotes) — the same local copy `github-fork-service.ts` carries, kept
 *  duplicated rather than imported cross-file for the same reason: neither
 *  file may depend on `main/powershell-session.ts` (it imports
 *  `child_process` at module scope), and a two-line escaping helper is not
 *  worth inventing a third shared module to avoid repeating. */
function singleQuoteForShell(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
