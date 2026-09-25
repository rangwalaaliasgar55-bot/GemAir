"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const watch_1 = require("../../lib/iris/services/autopilot/watch");
function makeFakeSeams(script = {}) {
    const calls = {
        isToolInstalled: 0,
        readForegroundProcess: 0,
        readForegroundBrowserHost: 0,
        isAxElementPresent: 0,
        captureScreenshotJpegBase64: 0,
        evaluateVisualCheck: 0,
        captureScreenFingerprint: 0,
    };
    const secondsAtEachVisualCheck = [];
    const toolsAskedAbout = [];
    let clockSeconds = 0;
    const seams = {
        async isToolInstalled(tool) {
            calls.isToolInstalled += 1;
            toolsAskedAbout.push(tool);
            if (script.toolInstalled !== undefined)
                return script.toolInstalled(tool);
            return script.toolInstalledByName?.[tool] ?? false;
        },
        async readForegroundProcess() {
            calls.readForegroundProcess += 1;
            return script.foregroundProcessName === undefined
                ? undefined
                : { pid: 1234, processName: script.foregroundProcessName };
        },
        async readForegroundBrowserHost() {
            calls.readForegroundBrowserHost += 1;
            return script.foregroundBrowserHost;
        },
        async isAxElementPresent() {
            calls.isAxElementPresent += 1;
            return script.axElementPresent ?? false;
        },
        async captureScreenshotJpegBase64() {
            calls.captureScreenshotJpegBase64 += 1;
            return script.screenshot ?? "ZmFrZS1qcGVn";
        },
        async evaluateVisualCheck() {
            calls.evaluateVisualCheck += 1;
            secondsAtEachVisualCheck.push(clockSeconds);
            return script.visualVerdict;
        },
        async captureScreenFingerprint() {
            const index = calls.captureScreenFingerprint;
            calls.captureScreenFingerprint += 1;
            if (script.fingerprints === undefined)
                return undefined; // unwired
            return script.fingerprints[Math.min(index, script.fingerprints.length - 1)];
        },
        nowInSeconds() {
            return clockSeconds;
        },
        async waitForMilliseconds() {
            clockSeconds += script.secondsAdvancedPerPoll ?? 0;
        },
    };
    return { seams, calls, secondsAtEachVisualCheck, toolsAskedAbout };
}
function watchOf(expect, sensitive = false) {
    return { sensitive, expect };
}
// ---------------------------------------------------------------------------
// Cheapest-first ordering
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("orderExpectationsCheapestFirst", () => {
    (0, vitest_1.it)("orders toolVersion → foregroundApp → urlHost → axElement → visual", () => {
        const authored = [
            { type: "visual", prompt: "looks done?" },
            { type: "axElement", roleLabel: "Finish" },
            { type: "urlHost", host: "example.com" },
            { type: "foregroundApp", bundleId: "com.electron.ollama" },
            { type: "toolVersion", tool: "git" },
        ];
        (0, vitest_1.expect)((0, watch_1.orderExpectationsCheapestFirst)(authored).map((e) => e.type)).toEqual([
            "toolVersion",
            "foregroundApp",
            "urlHost",
            "axElement",
            "visual",
        ]);
    });
    (0, vitest_1.it)("is stable for two expectations of the same cost", () => {
        const authored = [
            { type: "toolVersion", tool: "git" },
            { type: "toolVersion", tool: "node" },
        ];
        (0, vitest_1.expect)((0, watch_1.orderExpectationsCheapestFirst)(authored).map((e) => e.tool)).toEqual([
            "git",
            "node",
        ]);
    });
    (0, vitest_1.it)("does not mutate its input", () => {
        const authored = [
            { type: "visual", prompt: "?" },
            { type: "toolVersion", tool: "git" },
        ];
        (0, watch_1.orderExpectationsCheapestFirst)(authored);
        (0, vitest_1.expect)(authored[0].type).toBe("visual");
    });
});
// ---------------------------------------------------------------------------
// Cheapest-first short-circuit + each side signal verifying
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("the executor's cheapest-first evaluation", () => {
    (0, vitest_1.it)("stops at the first (cheapest) expectation that verifies and never reaches the costlier ones", async () => {
        // Authored with visual FIRST, but toolVersion is cheaper and verifies, so
        // the screenshot/model rung is never touched.
        const fake = makeFakeSeams({ toolInstalled: () => true });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([
            { type: "visual", prompt: "?" },
            { type: "toolVersion", tool: "git" },
        ]));
        (0, vitest_1.expect)(outcome).toEqual({ kind: "verified", verifiedBy: "toolVersion" });
        (0, vitest_1.expect)(fake.calls.captureScreenshotJpegBase64).toBe(0);
        (0, vitest_1.expect)(fake.calls.evaluateVisualCheck).toBe(0);
    });
    (0, vitest_1.it)("verifies a foregroundApp by mapping the guide identity to a Windows exe", async () => {
        const fake = makeFakeSeams({ foregroundProcessName: "ollama app.exe" });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "foregroundApp", bundleId: "com.electron.ollama" }]));
        (0, vitest_1.expect)(outcome).toEqual({ kind: "verified", verifiedBy: "foregroundApp" });
    });
    (0, vitest_1.it)("verifies a urlHost when the frontmost tab is a subdomain of the expected host", async () => {
        const fake = makeFakeSeams({ foregroundBrowserHost: "console.anthropic.com" });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "urlHost", host: "anthropic.com" }]), { maximumPolls: 1 });
        (0, vitest_1.expect)(outcome).toEqual({ kind: "verified", verifiedBy: "urlHost" });
    });
    (0, vitest_1.it)("verifies an axElement when UIA reports it present", async () => {
        const fake = makeFakeSeams({ axElementPresent: true });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "axElement", roleLabel: "Finish setup" }]), { maximumPolls: 1 });
        (0, vitest_1.expect)(outcome).toEqual({ kind: "verified", verifiedBy: "axElement" });
    });
    (0, vitest_1.it)("never asks about a tool that is not on the allowlist", async () => {
        const fake = makeFakeSeams({ toolInstalled: () => true });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "evilprogram" }]), { maximumPolls: 1 });
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        (0, vitest_1.expect)(fake.calls.isToolInstalled).toBe(0);
        (0, vitest_1.expect)(fake.toolsAskedAbout).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// Visual budget + spacing
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("the visual model budget", () => {
    (0, vitest_1.it)("never runs more than the per-step ceiling of visual checks", async () => {
        // Spacing always allows (clock jumps 100s per poll), the model always says
        // not-yet, and there are far more polls than the ceiling.
        const fake = makeFakeSeams({ visualVerdict: { kind: "notYet" }, secondsAdvancedPerPoll: 100 });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "visual", prompt: "looks done?" }]), { maximumPolls: 40 });
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        (0, vitest_1.expect)(fake.calls.evaluateVisualCheck).toBe(watch_1.MAXIMUM_VISUAL_CHECKS_PER_STEP);
    });
    (0, vitest_1.it)("keeps every pair of visual checks at least the minimum interval apart", async () => {
        // Each poll advances the clock 3s; spacing must hold checks ≥ 10s apart.
        const fake = makeFakeSeams({ visualVerdict: { kind: "notYet" }, secondsAdvancedPerPoll: 3 });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        await executor.awaitStepCompletion(watchOf([{ type: "visual", prompt: "?" }]), {
            maximumPolls: 20,
        });
        const timestamps = fake.secondsAtEachVisualCheck;
        (0, vitest_1.expect)(timestamps.length).toBeGreaterThan(1);
        for (let i = 1; i < timestamps.length; i += 1) {
            (0, vitest_1.expect)(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(watch_1.MINIMUM_SECONDS_BETWEEN_VISUAL_CHECKS);
        }
    });
    (0, vitest_1.it)("verifies as soon as one visual check comes back completed", async () => {
        const fake = makeFakeSeams({ visualVerdict: { kind: "completed" }, secondsAdvancedPerPoll: 100 });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "visual", prompt: "?" }]), { maximumPolls: 5 });
        (0, vitest_1.expect)(outcome).toEqual({ kind: "verified", verifiedBy: "visual" });
        (0, vitest_1.expect)(fake.calls.evaluateVisualCheck).toBe(1);
    });
});
// ---------------------------------------------------------------------------
// Sensitive suppression
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("a sensitive watch", () => {
    (0, vitest_1.it)("never captures a screenshot and never calls the model", async () => {
        const fake = makeFakeSeams({ visualVerdict: { kind: "completed" }, secondsAdvancedPerPoll: 100 });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "visual", prompt: "the key is pasted?" }], /* sensitive */ true), { maximumPolls: 5 });
        // A sensitive step's only expectation is the forbidden one, so it cannot
        // verify from pixels — it times out rather than ever capturing.
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        (0, vitest_1.expect)(fake.calls.captureScreenshotJpegBase64).toBe(0);
        (0, vitest_1.expect)(fake.calls.evaluateVisualCheck).toBe(0);
    });
    (0, vitest_1.it)("still settles a sensitive step from a pixel-free side signal", async () => {
        const fake = makeFakeSeams({ foregroundProcessName: "ollama app.exe" });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([
            { type: "foregroundApp", bundleId: "com.electron.ollama" },
            { type: "visual", prompt: "?" },
        ], true));
        (0, vitest_1.expect)(outcome).toEqual({ kind: "verified", verifiedBy: "foregroundApp" });
        (0, vitest_1.expect)(fake.calls.captureScreenshotJpegBase64).toBe(0);
    });
});
// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("the timeout", () => {
    (0, vitest_1.it)("times out when nothing verifies within the poll budget", async () => {
        const fake = makeFakeSeams({ toolInstalled: () => false });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }]), { maximumPolls: 3 });
        (0, vitest_1.expect)(outcome).toEqual({ kind: "timedOut" });
    });
    (0, vitest_1.it)("carries the last stuck hint the model produced into the timeout", async () => {
        const fake = makeFakeSeams({
            visualVerdict: { kind: "userStuck", hint: "A dialog is blocking the window." },
            secondsAdvancedPerPoll: 100,
        });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "visual", prompt: "?" }]), { maximumPolls: 3 });
        (0, vitest_1.expect)(outcome).toEqual({ kind: "timedOut", stuckHint: "A dialog is blocking the window." });
    });
});
// ---------------------------------------------------------------------------
// AND semantics across a step's side signals (finding 1)
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("multiple side signals verify with AND, not OR", () => {
    (0, vitest_1.it)("does NOT settle a two-tool check when only the first tool is present", async () => {
        // The `check-tools` step shared across the Windows guides:
        // expect [toolVersion git, toolVersion node]. git is installed, node is not.
        // The step must keep waiting — verifying here would march into an npm step
        // with node still missing.
        const fake = makeFakeSeams({ toolInstalledByName: { git: true, node: false } });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([
            { type: "toolVersion", tool: "git" },
            { type: "toolVersion", tool: "node" },
        ]), { maximumPolls: 3 });
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
    });
    (0, vitest_1.it)("settles the two-tool check only once BOTH tools are present", async () => {
        const fake = makeFakeSeams({ toolInstalledByName: { git: true, node: true } });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([
            { type: "toolVersion", tool: "git" },
            { type: "toolVersion", tool: "node" },
        ]), { maximumPolls: 3 });
        // Verified, and named by the strongest (last, most-expensive) side signal —
        // here both are toolVersion, so node (authored second).
        (0, vitest_1.expect)(outcome).toEqual({ kind: "verified", verifiedBy: "toolVersion" });
    });
    (0, vitest_1.it)("short-circuits the AND on the first unsatisfied signal, never spawning the costlier probe", async () => {
        // toolVersion (git) is absent, so the costlier urlHost probe below it must
        // never be read: one failed cheap check already means "not all satisfied".
        const fake = makeFakeSeams({
            toolInstalledByName: { git: false },
            foregroundBrowserHost: "example.com",
        });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([
            { type: "toolVersion", tool: "git" },
            { type: "urlHost", host: "example.com" },
        ]), { maximumPolls: 2 });
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        (0, vitest_1.expect)(fake.calls.readForegroundBrowserHost).toBe(0);
    });
    (0, vitest_1.it)("falls to the visual rung when a side signal is unsatisfied but a visual is declared", async () => {
        // node missing (side signal not all satisfied) AND a visual is declared:
        // macOS `localSignalsCannotTell` → consult the model, which says completed.
        const fake = makeFakeSeams({
            toolInstalledByName: { node: false },
            visualVerdict: { kind: "completed" },
            secondsAdvancedPerPoll: 100,
        });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([
            { type: "toolVersion", tool: "node" },
            { type: "visual", prompt: "does it look done?" },
        ]), { maximumPolls: 3 });
        (0, vitest_1.expect)(outcome).toEqual({ kind: "verified", verifiedBy: "visual" });
        (0, vitest_1.expect)(fake.calls.evaluateVisualCheck).toBeGreaterThan(0);
    });
});
// ---------------------------------------------------------------------------
// The perceptual-diff rung — "free unless the screen changed" (finding 4)
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("the screen-diff gate", () => {
    (0, vitest_1.it)("reads the side signals every poll when no fingerprint seam is wired (the shipped default)", async () => {
        // fingerprints absent → capture returns undefined → the gate is inert and
        // every poll reads the (never-satisfied) side signal.
        const fake = makeFakeSeams({ toolInstalledByName: { git: false } });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }]), {
            maximumPolls: 4,
        });
        // Four polls, four side-signal reads — nothing gated them.
        (0, vitest_1.expect)(fake.calls.isToolInstalled).toBe(4);
    });
    (0, vitest_1.it)("skips the side-signal read on an unchanged screen once a fingerprint seam is wired", async () => {
        // A steady screen (same fingerprint every capture): the baseline poll reads
        // the side signal, every unchanged poll after it reads nothing.
        const fake = makeFakeSeams({
            toolInstalledByName: { git: false },
            fingerprints: [0n], // one value, repeats — the screen never changes
        });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }]), {
            maximumPolls: 5,
        });
        // Only the baseline frame read the side signal; the four unchanged polls were
        // free. This is the rung that makes the common case cost nothing.
        (0, vitest_1.expect)(fake.calls.isToolInstalled).toBe(1);
        (0, vitest_1.expect)(fake.calls.captureScreenFingerprint).toBeGreaterThan(1);
    });
    (0, vitest_1.it)("reads the side signals again on a meaningfully-changed screen", async () => {
        // Baseline 0n, then a value far enough away to clear the Hamming threshold on
        // the second poll, then steady — so exactly two side-signal reads happen.
        const changed = (1n << BigInt(watch_1.MINIMUM_HAMMING_DISTANCE_THAT_COUNTS)) - 1n; // >= threshold bits set
        const fake = makeFakeSeams({
            toolInstalledByName: { git: false },
            fingerprints: [0n, changed, changed, changed],
        });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }]), {
            maximumPolls: 5,
        });
        // Baseline (poll 0) + the changed frame (poll 1) both read; the steady polls
        // after that do not.
        (0, vitest_1.expect)(fake.calls.isToolInstalled).toBe(2);
    });
    (0, vitest_1.it)("never fingerprints a sensitive step", async () => {
        const fake = makeFakeSeams({
            toolInstalledByName: { git: false },
            fingerprints: [0n],
        });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }], /* sensitive */ true), { maximumPolls: 3 });
        (0, vitest_1.expect)(fake.calls.captureScreenFingerprint).toBe(0);
    });
});
// ---------------------------------------------------------------------------
// Progress-aware timeout (finding 3)
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("the progress-aware timeout", () => {
    (0, vitest_1.it)("keeps watching a still-changing screen well past the no-progress ceiling", async () => {
        // The screen changes every poll (each fingerprint clears the threshold vs the
        // last), so a slow-but-live step is never handed back at the ceiling. With a
        // no-progress ceiling of 3 and 12 always-changing polls, it does NOT time out
        // early — it runs to the poll budget the test caps it at.
        const everChanging = [];
        for (let i = 0; i < 12; i += 1) {
            // Alternate between two distant fingerprints so consecutive frames always
            // differ by more than the threshold.
            everChanging.push(i % 2 === 0 ? 0n : 0xffffffffffffffffn);
        }
        const fake = makeFakeSeams({
            toolInstalledByName: { git: false },
            fingerprints: everChanging,
        });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }]), { maximumPolls: 3 });
        // It polled far more than the no-progress ceiling of 3 because every change
        // reset the counter — evidence the step is still progressing.
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        (0, vitest_1.expect)(fake.calls.captureScreenFingerprint).toBeGreaterThan(3);
    });
    (0, vitest_1.it)("times out at the no-progress ceiling when the screen sits still", async () => {
        const fake = makeFakeSeams({
            toolInstalledByName: { git: false },
            fingerprints: [7n], // steady
        });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }]), { maximumPolls: 3 });
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        // Baseline + 2 unchanged polls = 3 no-progress polls, then it gives up.
        (0, vitest_1.expect)(fake.calls.captureScreenFingerprint).toBe(3);
    });
});
// ---------------------------------------------------------------------------
// Abort cancels an in-flight watch promptly (finding 2)
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("shouldAbort", () => {
    (0, vitest_1.it)("returns aborted promptly and stops polling when the escape hatch fires", async () => {
        let aborted = false;
        const fake = makeFakeSeams({ toolInstalledByName: { git: false } });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        // Abort after the first poll's side-signal read.
        const originalIsToolInstalled = fake.seams.isToolInstalled.bind(fake.seams);
        fake.seams.isToolInstalled = async (tool) => {
            aborted = true;
            return originalIsToolInstalled(tool);
        };
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }]), { maximumPolls: 90, shouldAbort: () => aborted });
        (0, vitest_1.expect)(outcome).toEqual({ kind: "aborted" });
        // It did NOT poll its whole budget after the abort — one side-signal read,
        // then it noticed the abort and returned.
        (0, vitest_1.expect)(fake.calls.isToolInstalled).toBe(1);
    });
    (0, vitest_1.it)("returns aborted before doing any work when already aborted", async () => {
        const fake = makeFakeSeams({ toolInstalledByName: { git: true } });
        const executor = new watch_1.WatchStepExecutor(fake.seams);
        const outcome = await executor.awaitStepCompletion(watchOf([{ type: "toolVersion", tool: "git" }]), { maximumPolls: 5, shouldAbort: () => true });
        (0, vitest_1.expect)(outcome).toEqual({ kind: "aborted" });
        (0, vitest_1.expect)(fake.calls.isToolInstalled).toBe(0);
    });
});
// ---------------------------------------------------------------------------
// The Hamming helper + the production seam plumbing (findings 4 and 7)
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("hammingDistanceBetweenFingerprints", () => {
    (0, vitest_1.it)("counts the differing bits of two 64-bit hashes", () => {
        (0, vitest_1.expect)((0, watch_1.hammingDistanceBetweenFingerprints)(0n, 0n)).toBe(0);
        (0, vitest_1.expect)((0, watch_1.hammingDistanceBetweenFingerprints)(0n, 1n)).toBe(1);
        (0, vitest_1.expect)((0, watch_1.hammingDistanceBetweenFingerprints)(10n, 5n)).toBe(4);
        (0, vitest_1.expect)((0, watch_1.hammingDistanceBetweenFingerprints)(0n, 0xffffffffffffffffn)).toBe(64);
    });
});
(0, vitest_1.describe)("defaultWatchSeams", () => {
    (0, vitest_1.it)("wires the toolVersion rung through an injected isToolInstalled instead of the false default", async () => {
        // The production wiring (main/index.ts) hands in a real checker; without an
        // override the seam answers false forever, which is the bug finding 7 fixes.
        const asked = [];
        const wired = (0, watch_1.defaultWatchSeams)({
            isToolInstalled: async (tool) => {
                asked.push(tool);
                return tool === "cargo";
            },
        });
        (0, vitest_1.expect)(await wired.isToolInstalled("cargo")).toBe(true);
        (0, vitest_1.expect)(await wired.isToolInstalled("git")).toBe(false);
        (0, vitest_1.expect)(asked).toEqual(["cargo", "git"]);
        // The unwired default is false (not "wired"): a fingerprint capture and a
        // tool check both answer the inert value until a host supplies them.
        const bare = (0, watch_1.defaultWatchSeams)();
        (0, vitest_1.expect)(await bare.isToolInstalled("cargo")).toBe(false);
        (0, vitest_1.expect)(await bare.captureScreenFingerprint()).toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("windowsExecutableForForegroundIdentity", () => {
    (0, vitest_1.it)("maps the reviewed catalog bundle id to its Windows exe", () => {
        (0, vitest_1.expect)((0, watch_1.windowsExecutableForForegroundIdentity)("com.electron.ollama")).toBe("ollama app");
    });
    (0, vitest_1.it)("takes an identity that already names an exe", () => {
        (0, vitest_1.expect)((0, watch_1.windowsExecutableForForegroundIdentity)("SomeApp.exe")).toBe("someapp");
    });
    (0, vitest_1.it)("resolves a reviewed catalog slug to its exe", () => {
        (0, vitest_1.expect)((0, watch_1.windowsExecutableForForegroundIdentity)("ollama")).toBe("ollama app");
    });
    (0, vitest_1.it)("returns undefined for an unknown identity", () => {
        (0, vitest_1.expect)((0, watch_1.windowsExecutableForForegroundIdentity)("com.example.unknown")).toBeUndefined();
        (0, vitest_1.expect)((0, watch_1.windowsExecutableForForegroundIdentity)("")).toBeUndefined();
    });
});
(0, vitest_1.describe)("foregroundProcessSatisfiesIdentity", () => {
    (0, vitest_1.it)("matches case-insensitively and tolerates a missing .exe", () => {
        (0, vitest_1.expect)((0, watch_1.foregroundProcessSatisfiesIdentity)("ollama app", "com.electron.ollama")).toBe(true);
        (0, vitest_1.expect)((0, watch_1.foregroundProcessSatisfiesIdentity)("OLLAMA APP.EXE", "com.electron.ollama")).toBe(true);
    });
    (0, vitest_1.it)("does not match a different process", () => {
        (0, vitest_1.expect)((0, watch_1.foregroundProcessSatisfiesIdentity)("explorer.exe", "com.electron.ollama")).toBe(false);
    });
});
(0, vitest_1.describe)("hostMatchesExpectedHost", () => {
    (0, vitest_1.it)("matches the host itself and any subdomain, but not a lookalike", () => {
        (0, vitest_1.expect)((0, watch_1.hostMatchesExpectedHost)("anthropic.com", "anthropic.com")).toBe(true);
        (0, vitest_1.expect)((0, watch_1.hostMatchesExpectedHost)("console.anthropic.com", "anthropic.com")).toBe(true);
        (0, vitest_1.expect)((0, watch_1.hostMatchesExpectedHost)("evilanthropic.com", "anthropic.com")).toBe(false);
        (0, vitest_1.expect)((0, watch_1.hostMatchesExpectedHost)(undefined, "anthropic.com")).toBe(false);
    });
});
(0, vitest_1.describe)("hostFromAddressBarText", () => {
    (0, vitest_1.it)("reads the host out of a full URL, a bare host, and a host with a path", () => {
        (0, vitest_1.expect)((0, watch_1.hostFromAddressBarText)("https://console.anthropic.com/settings/keys")).toBe("console.anthropic.com");
        (0, vitest_1.expect)((0, watch_1.hostFromAddressBarText)("example.com")).toBe("example.com");
        (0, vitest_1.expect)((0, watch_1.hostFromAddressBarText)("github.com/gemair-demo/demoapp")).toBe("github.com");
        (0, vitest_1.expect)((0, watch_1.hostFromAddressBarText)("   ")).toBeUndefined();
    });
});
(0, vitest_1.describe)("parseActiveBrowserUrlOutput", () => {
    (0, vitest_1.it)("reads the last URL| line into a host and ignores noise", () => {
        (0, vitest_1.expect)((0, watch_1.parseActiveBrowserUrlOutput)("noise\nURL|https://example.com/x\n")).toBe("example.com");
        (0, vitest_1.expect)((0, watch_1.parseActiveBrowserUrlOutput)("nothing here")).toBeUndefined();
    });
});
(0, vitest_1.describe)("parseAxElementPresenceOutput", () => {
    (0, vitest_1.it)("is true only when the AX|1 marker is present", () => {
        (0, vitest_1.expect)((0, watch_1.parseAxElementPresenceOutput)("AX|1")).toBe(true);
        (0, vitest_1.expect)((0, watch_1.parseAxElementPresenceOutput)("some\nAX|1\nmore")).toBe(true);
        (0, vitest_1.expect)((0, watch_1.parseAxElementPresenceOutput)("nope")).toBe(false);
    });
});
(0, vitest_1.describe)("the PowerShell command builders", () => {
    (0, vitest_1.it)("read the address bar over UI Automation from the foreground window", () => {
        const command = (0, watch_1.buildActiveBrowserUrlCommand)();
        (0, vitest_1.expect)(command).toContain("GetForegroundWindow");
        (0, vitest_1.expect)(command).toContain("UIAutomationClient");
        (0, vitest_1.expect)(command).toContain("URL|");
    });
    (0, vitest_1.it)("escape a role label so it can never become code", () => {
        const command = (0, watch_1.buildAxElementQueryCommand)("Finish'; Remove-Item C:\\");
        // The single quote is doubled (PowerShell single-quoted-string escaping), so
        // the label stays a string literal rather than closing the quote.
        (0, vitest_1.expect)(command).toContain("Finish''; Remove-Item");
        (0, vitest_1.expect)(command).toContain("AX|1");
    });
});
(0, vitest_1.describe)("verdictFromVisualModelAnswer", () => {
    (0, vitest_1.it)("reads COMPLETED / NOT_YET / STUCK and treats anything else as learned-nothing", () => {
        (0, vitest_1.expect)((0, watch_1.verdictFromVisualModelAnswer)("COMPLETED", [])).toEqual({ kind: "completed" });
        (0, vitest_1.expect)((0, watch_1.verdictFromVisualModelAnswer)("NOT_YET", [])).toEqual({ kind: "notYet" });
        (0, vitest_1.expect)((0, watch_1.verdictFromVisualModelAnswer)("NOT YET, still building", [])).toEqual({ kind: "notYet" });
        (0, vitest_1.expect)((0, watch_1.verdictFromVisualModelAnswer)("STUCK: an error dialog is up", [])).toEqual({
            kind: "userStuck",
            hint: "an error dialog is up",
        });
        (0, vitest_1.expect)((0, watch_1.verdictFromVisualModelAnswer)("banana", [])).toBeUndefined();
    });
    (0, vitest_1.it)("falls back to the author's first hint when STUCK carries none", () => {
        (0, vitest_1.expect)((0, watch_1.verdictFromVisualModelAnswer)("STUCK:", ["try re-running it"])).toEqual({
            kind: "userStuck",
            hint: "try re-running it",
        });
        (0, vitest_1.expect)((0, watch_1.verdictFromVisualModelAnswer)("STUCK:", [])).toEqual({ kind: "notYet" });
    });
});
(0, vitest_1.describe)("the visual prompt shape", () => {
    (0, vitest_1.it)("asks for exactly one of the three answers and names the step and command", () => {
        const systemPrompt = (0, watch_1.visualCheckSystemPrompt)(["reopen the terminal"]);
        (0, vitest_1.expect)(systemPrompt).toContain("COMPLETED");
        (0, vitest_1.expect)(systemPrompt).toContain("NOT_YET");
        (0, vitest_1.expect)(systemPrompt).toContain("STUCK:");
        (0, vitest_1.expect)(systemPrompt).toContain("reopen the terminal");
        const userPrompt = (0, watch_1.visualCheckUserPrompt)({
            stepTitle: "Start the app",
            visualPrompt: "is the window open?",
            context: { frontmostApplicationName: "ollama", commandTheStepAsksFor: "pnpm dev" },
        });
        (0, vitest_1.expect)(userPrompt).toContain('"Start the app"');
        (0, vitest_1.expect)(userPrompt).toContain("pnpm dev");
        (0, vitest_1.expect)(userPrompt).toContain("is the window open?");
    });
});
(0, vitest_1.describe)("a watch that can never verify hands back at once (finding: no ~3-minute silent stall)", () => {
    /** Minimal seams with call counters, and a fixed screenshot value (undefined =
     *  the capture seam is not wired). The fingerprint seam is always unwired, the
     *  production default. */
    function countingSeams(screenshot) {
        let waits = 0;
        let captures = 0;
        const seams = {
            async isToolInstalled() {
                return false;
            },
            async readForegroundProcess() {
                return undefined;
            },
            async readForegroundBrowserHost() {
                return undefined;
            },
            async isAxElementPresent() {
                return false;
            },
            async captureScreenshotJpegBase64() {
                captures += 1;
                return screenshot;
            },
            async captureScreenFingerprint() {
                return undefined;
            },
            async evaluateVisualCheck() {
                return undefined; // the model never confirms
            },
            nowInSeconds() {
                return 0;
            },
            async waitForMilliseconds() {
                waits += 1;
            },
        };
        return { seams, counts: () => ({ waits, captures }) };
    }
    (0, vitest_1.it)("hands a sensitive visual-only step back immediately, never capturing and never polling", async () => {
        const { seams, counts } = countingSeams("a-frame");
        const outcome = await new watch_1.WatchStepExecutor(seams).awaitStepCompletion(watchOf([{ type: "visual", prompt: "the key is pasted?" }], /* sensitive */ true), { maximumPolls: 90 });
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        (0, vitest_1.expect)(counts().captures).toBe(0); // a sensitive step is never looked at
        (0, vitest_1.expect)(counts().waits).toBe(0); // and does not burn the 90-poll budget
    });
    (0, vitest_1.it)("hands a non-sensitive visual-only step back once it learns the capture seam is unwired", async () => {
        const { seams, counts } = countingSeams(undefined); // capture not wired
        const outcome = await new watch_1.WatchStepExecutor(seams).awaitStepCompletion(watchOf([{ type: "visual", prompt: "looks done?" }]), { maximumPolls: 90 });
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        (0, vitest_1.expect)(counts().captures).toBe(1); // it tried once, learned the rung is dead
        (0, vitest_1.expect)(counts().waits).toBe(0); // then gave up instead of polling ~3 minutes
    });
    (0, vitest_1.it)("still polls a visual-only step to its budget when capture IS wired (unchanged)", async () => {
        const { seams, counts } = countingSeams("a-frame"); // wired; model keeps saying not-yet
        const outcome = await new watch_1.WatchStepExecutor(seams).awaitStepCompletion(watchOf([{ type: "visual", prompt: "looks done?" }]), { maximumPolls: 3 });
        (0, vitest_1.expect)(outcome.kind).toBe("timedOut");
        (0, vitest_1.expect)(counts().waits).toBeGreaterThan(0); // it genuinely watched, no fast-fail
    });
});
