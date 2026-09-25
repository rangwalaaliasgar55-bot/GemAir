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
const verification_harness_1 = require("../../lib/iris/services/maintain/verification-harness");
const maintain_shell_runner_1 = require("../../lib/iris/services/maintain/maintain-shell-runner");
const maintain_real_git_shell_runner_1 = require("./fixtures/maintain-real-git-shell-runner");
/**
 * The three-legged gate plus the diff-scope check that runs before it. Two
 * kinds of test here:
 *
 *   - scripted, against `MockMaintainShellRunner` — cheap, exercises every
 *     blocked-stage branch by dictating exactly what each git/build/test call
 *     returns.
 *   - against a REAL git repository (`RealGitShellRunner`) — proves the
 *     stash/pop-based leg mechanics and the numstat-based diff-scope reading
 *     actually work against real git, not just against a mock that agrees
 *     with whatever the code under test expects to see.
 */
const succeeds = { succeeded: true, exitCode: 0, outputTail: "" };
function fails(outputTail = "") {
    return { succeeded: false, exitCode: 1, outputTail };
}
const NO_COMMANDS = {};
(0, vitest_1.describe)("earnsVerifiedFix / earnsCleanApply", () => {
    vitest_1.it.each([
        [
            "every leg plus build and suite green",
            {
                reproFailedBeforePatch: true,
                reproPassedAfterPatch: true,
                reproFailedOnRevert: true,
                buildSucceeded: true,
                suitePassed: true,
            },
            true,
            true,
        ],
        [
            "replay mode: no legs, build+suite green",
            { buildSucceeded: true, suitePassed: true },
            false, // never earns the full standard without the legs
            true,
        ],
        [
            "leg 2 never passed",
            { reproFailedBeforePatch: true, reproPassedAfterPatch: false, buildSucceeded: true, suitePassed: true },
            false,
            // buildSucceeded is true and suitePassed !== false, and nothing set
            // blockedStage in this constructed outcome, so earnsCleanApply is
            // still true — it is deliberately independent of the legs.
            true,
        ],
        [
            "blocked at diff-scope",
            { buildSucceeded: false, blockedStage: "diff-scope" },
            false,
            false,
        ],
        [
            "build never ran a stage, but a block was recorded",
            { buildSucceeded: true, blockedStage: "suite" },
            false,
            false,
        ],
        [
            "suite explicitly failed",
            { buildSucceeded: true, suitePassed: false },
            false,
            false,
        ],
        [
            "suite stage absent (no test command for this stack) still counts as clean",
            { buildSucceeded: true },
            false,
            true,
        ],
    ])("%s", (_label, outcome, expectedVerified, expectedCleanApply) => {
        (0, vitest_1.expect)((0, verification_harness_1.earnsVerifiedFix)(outcome)).toBe(expectedVerified);
        (0, vitest_1.expect)((0, verification_harness_1.earnsCleanApply)(outcome)).toBe(expectedCleanApply);
    });
});
(0, vitest_1.describe)("verifyAppliedPatch — scripted against MockMaintainShellRunner", () => {
    (0, vitest_1.it)("runs diff-scope, all three legs, build, and suite, in that exact order", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "1\t1\tsrc/fix.ts" }, // git diff --numstat HEAD
            succeeds, // git ls-files --others
            succeeds, // git stash push (leg 1 setup)
            fails(), // leg 1 repro: fails on the pre-patch tree — correct
            succeeds, // git stash pop
            succeeds, // leg 2 repro: passes on the applied tree
            succeeds, // git stash push (leg 3 setup)
            fails(), // leg 3 repro: fails again on revert — correct
            succeeds, // git stash pop
            succeeds, // build
            succeeds, // suite
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, { buildCommand: "npm run build", testCommand: "npm test" }, "npm run repro");
        (0, vitest_1.expect)(outcome).toEqual({
            reproFailedBeforePatch: true,
            reproPassedAfterPatch: true,
            reproFailedOnRevert: true,
            buildSucceeded: true,
            suitePassed: true,
        });
        (0, vitest_1.expect)((0, verification_harness_1.earnsVerifiedFix)(outcome)).toBe(true);
        (0, vitest_1.expect)(runner.commandsRun).toEqual([
            "git diff --numstat HEAD",
            "git ls-files --others --exclude-standard",
            "git stash push --include-untracked --quiet",
            "npm run repro",
            "git stash pop --quiet",
            "npm run repro",
            "git stash push --include-untracked --quiet",
            "npm run repro",
            "git stash pop --quiet",
            "npm run build",
            "npm test",
        ]);
    });
    (0, vitest_1.it)("blocks at diff-scope, before a single stash or build runs, when too many files changed", async () => {
        const manyChangedLines = Array.from({ length: verification_harness_1.MAXIMUM_FILES_TOUCHED }, (_, i) => `1\t1\tsrc/file${i}.ts`).join("\n");
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: manyChangedLines },
            { succeeded: true, exitCode: 0, outputTail: "extra-untracked-file.ts" },
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, "npm run repro");
        (0, vitest_1.expect)(outcome.blockedStage).toBe("diff-scope");
        (0, vitest_1.expect)(outcome.blockedOutputTail).toContain(`over the ${verification_harness_1.MAXIMUM_FILES_TOUCHED}-file limit`);
        // Nothing past the two diff-scope reads ran.
        (0, vitest_1.expect)(runner.commandsRun).toEqual(["git diff --numstat HEAD", "git ls-files --others --exclude-standard"]);
    });
    (0, vitest_1.it)("blocks at diff-scope when a diff removes more test lines than it adds", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "1\t9\tsrc/feature.test.ts" },
            succeeds,
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, undefined);
        (0, vitest_1.expect)(outcome.blockedStage).toBe("diff-scope");
        (0, vitest_1.expect)(outcome.blockedOutputTail).toContain("weakens tests in src/feature.test.ts (-9/+1)");
    });
    (0, vitest_1.it)("does not block on a test file that grows (adds more than it deletes)", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "9\t1\tsrc/feature.test.ts" },
            succeeds,
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, undefined);
        (0, vitest_1.expect)(outcome.blockedStage).toBeUndefined();
    });
    (0, vitest_1.it)("fails closed on diff-scope when the diff itself cannot be read", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([fails("git: not a repository")]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, undefined);
        (0, vitest_1.expect)(outcome.blockedStage).toBe("diff-scope");
        (0, vitest_1.expect)(outcome.blockedOutputTail).toBe("could not read the diff to check its scope");
    });
    (0, vitest_1.it)("treats no changes at all as an open diff-scope gate", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "" },
            { succeeded: true, exitCode: 0, outputTail: "" },
            succeeds, // build
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, { buildCommand: "npm run build" }, undefined);
        (0, vitest_1.expect)(outcome.blockedStage).toBeUndefined();
        (0, vitest_1.expect)(outcome.buildSucceeded).toBe(true);
    });
    vitest_1.it.each([
        [
            "leg 1's repro passes before the patch (tautological test)",
            // stash push, leg1 repro (wrongly succeeds pre-patch — blocks right after the pop)
            [succeeds, succeeds, succeeds],
            "leg1-repro-passed-prepatch",
        ],
        [
            "leg 2's repro still fails after the patch",
            // stash push, leg1 repro (correctly fails pre-patch), stash pop, leg2 repro (fails again — blocks)
            [succeeds, fails(), succeeds, fails()],
            "leg2-repro-failed-postpatch",
        ],
    ])("blocks when %s", async (_label, outcomes, expectedStage) => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "" },
            { succeeded: true, exitCode: 0, outputTail: "" },
            ...outcomes,
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, "npm run repro");
        (0, vitest_1.expect)(outcome.blockedStage).toBe(expectedStage);
    });
    (0, vitest_1.it)("blocks when leg 3's repro passes again after reverting (the test was never real)", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "" }, // diff
            { succeeded: true, exitCode: 0, outputTail: "" }, // untracked
            succeeds, // stash (leg 1 setup)
            fails(), // leg 1: fails pre-patch — correct
            succeeds, // pop
            succeeds, // leg 2: passes post-patch — correct
            succeeds, // stash (leg 3 setup)
            succeeds, // leg 3: passes on revert — WRONG, blocks
            succeeds, // pop
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, "npm run repro");
        (0, vitest_1.expect)(outcome.blockedStage).toBe("leg3-repro-passed-on-revert");
        (0, vitest_1.expect)(outcome.reproFailedOnRevert).toBe(false);
    });
    (0, vitest_1.it)("blocks and stops immediately when a git stash fails", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "" },
            { succeeded: true, exitCode: 0, outputTail: "" },
            fails(), // git stash push fails
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, "npm run repro");
        (0, vitest_1.expect)(outcome.blockedStage).toBe("git-stash");
        (0, vitest_1.expect)(runner.commandsRun).toEqual([
            "git diff --numstat HEAD",
            "git ls-files --others --exclude-standard",
            "git stash push --include-untracked --quiet",
        ]);
    });
    (0, vitest_1.it)("blocks at build when the build command fails, and never reaches the suite", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "" },
            { succeeded: true, exitCode: 0, outputTail: "" },
            fails("compile error"),
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, { buildCommand: "cargo build" }, undefined);
        (0, vitest_1.expect)(outcome.blockedStage).toBe("build");
        (0, vitest_1.expect)(outcome.blockedOutputTail).toBe("compile error");
        (0, vitest_1.expect)(runner.commandsRun).toEqual(["git diff --numstat HEAD", "git ls-files --others --exclude-standard", "cargo build"]);
    });
    (0, vitest_1.it)("blocks at suite when the full test suite goes red after a green build", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "" },
            { succeeded: true, exitCode: 0, outputTail: "" },
            succeeds, // build
            fails("2 tests failed"),
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, { buildCommand: "npm run build", testCommand: "npm test" }, undefined);
        (0, vitest_1.expect)(outcome.buildSucceeded).toBe(true);
        (0, vitest_1.expect)(outcome.blockedStage).toBe("suite");
        (0, vitest_1.expect)((0, verification_harness_1.earnsCleanApply)(outcome)).toBe(false);
    });
    (0, vitest_1.it)("earns a clean apply, never a verified fix, in replay mode (no repro command)", async () => {
        const runner = new maintain_shell_runner_1.MockMaintainShellRunner([
            { succeeded: true, exitCode: 0, outputTail: "" },
            { succeeded: true, exitCode: 0, outputTail: "" },
            succeeds, // build
            succeeds, // suite
        ]);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, { buildCommand: "npm run build", testCommand: "npm test" }, undefined);
        (0, vitest_1.expect)((0, verification_harness_1.earnsCleanApply)(outcome)).toBe(true);
        (0, vitest_1.expect)((0, verification_harness_1.earnsVerifiedFix)(outcome)).toBe(false);
        // No stash calls at all — legs never run without a repro command.
        (0, vitest_1.expect)(runner.commandsRun).not.toContain("git stash push --include-untracked --quiet");
    });
});
(0, vitest_1.describe)("verifyAppliedPatch — against a real git repository", () => {
    let repoRootPath;
    (0, vitest_1.beforeEach)(() => {
        repoRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "gemair-maintain-vh-"));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(repoRootPath, { recursive: true, force: true });
    });
    function writeAddModule(buggy) {
        const body = buggy
            ? "module.exports = function add(a, b) {\n  return a + b + 1; // BUG: off by one\n};\n"
            : "module.exports = function add(a, b) {\n  return a + b;\n};\n";
        fs.writeFileSync(path.join(repoRootPath, "add.js"), body);
    }
    function writeReproScript() {
        fs.writeFileSync(path.join(repoRootPath, "repro.js"), 'const add = require("./add");\nprocess.exit(add(2, 2) === 4 ? 0 : 1);\n');
    }
    function writeScriptThatAlwaysExits(fileName, exitCode) {
        fs.writeFileSync(path.join(repoRootPath, fileName), `process.exit(${exitCode});\n`);
    }
    async function commitEverything(runner, message) {
        await runner.run("git add -A");
        await runner.run(`git commit --quiet -m "${message}"`);
    }
    (0, vitest_1.it)("earns a verified fix: leg1 fails, leg2 passes, leg3 fails again, and the tree ends up fixed", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        writeAddModule(/* buggy */ true);
        writeReproScript();
        await commitEverything(runner, "buggy base");
        // The "patch" — applied, uncommitted, exactly the contract
        // `verifyAppliedPatch` documents.
        writeAddModule(/* buggy */ false);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, "node repro.js");
        (0, vitest_1.expect)(outcome.reproFailedBeforePatch).toBe(true);
        (0, vitest_1.expect)(outcome.reproPassedAfterPatch).toBe(true);
        (0, vitest_1.expect)(outcome.reproFailedOnRevert).toBe(true);
        (0, vitest_1.expect)(outcome.blockedStage).toBeUndefined();
        (0, vitest_1.expect)((0, verification_harness_1.earnsVerifiedFix)(outcome)).toBe(true);
        // Left in the applied (fixed) state, as documented.
        const finalAddModule = fs.readFileSync(path.join(repoRootPath, "add.js"), "utf-8");
        (0, vitest_1.expect)(finalAddModule).not.toContain("BUG");
    }, 20_000);
    (0, vitest_1.it)("blocks at leg1 when the repro passes even before the patch (a tautological repro)", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        writeScriptThatAlwaysExits("repro.js", 0);
        await commitEverything(runner, "base");
        fs.writeFileSync(path.join(repoRootPath, "patch-marker.txt"), "the patch touched this file\n");
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, "node repro.js");
        (0, vitest_1.expect)(outcome.blockedStage).toBe("leg1-repro-passed-prepatch");
        (0, vitest_1.expect)((0, verification_harness_1.earnsVerifiedFix)(outcome)).toBe(false);
    }, 20_000);
    (0, vitest_1.it)("blocks on diff-scope, before any build or test runs, when a fix touches too many files", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        for (let i = 0; i < verification_harness_1.MAXIMUM_FILES_TOUCHED + 1; i += 1) {
            fs.writeFileSync(path.join(repoRootPath, `new-file-${i}.txt`), "junk");
        }
        writeScriptThatAlwaysExits("would-not-run.js", 0);
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, { buildCommand: "node would-not-run.js" }, undefined);
        (0, vitest_1.expect)(outcome.blockedStage).toBe("diff-scope");
        (0, vitest_1.expect)(outcome.blockedOutputTail).toContain(`over the ${verification_harness_1.MAXIMUM_FILES_TOUCHED}-file limit`);
        (0, vitest_1.expect)(outcome.buildSucceeded).toBe(false);
    }, 20_000);
    (0, vitest_1.it)("blocks on diff-scope when an uncommitted change deletes more test lines than it adds", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        const testFilePath = path.join(repoRootPath, "feature.test.js");
        fs.writeFileSync(testFilePath, `${Array.from({ length: 10 }, (_, i) => `assert(${i});`).join("\n")}\n`);
        await commitEverything(runner, "base with a real test file");
        fs.writeFileSync(testFilePath, "assert(0);\n");
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, NO_COMMANDS, undefined);
        (0, vitest_1.expect)(outcome.blockedStage).toBe("diff-scope");
        (0, vitest_1.expect)(outcome.blockedOutputTail).toContain("weakens tests in feature.test.js");
    }, 20_000);
    (0, vitest_1.it)("runs build and suite for real in replay mode, and blocks at suite on a real failure", async () => {
        const runner = await (0, maintain_real_git_shell_runner_1.initRealGitRepo)(repoRootPath);
        writeScriptThatAlwaysExits("build.js", 0);
        writeScriptThatAlwaysExits("test.js", 1); // the app's own suite is red
        await commitEverything(runner, "base with build+test scripts");
        fs.writeFileSync(path.join(repoRootPath, "patch-marker.txt"), "a queued patch landed here\n");
        const outcome = await (0, verification_harness_1.verifyAppliedPatch)(runner, { buildCommand: "node build.js", testCommand: "node test.js" }, undefined);
        (0, vitest_1.expect)(outcome.buildSucceeded).toBe(true);
        (0, vitest_1.expect)(outcome.blockedStage).toBe("suite");
        (0, vitest_1.expect)((0, verification_harness_1.earnsCleanApply)(outcome)).toBe(false);
    }, 20_000);
});
