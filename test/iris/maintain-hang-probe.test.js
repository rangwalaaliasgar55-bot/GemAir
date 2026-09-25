"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const hang_probe_1 = require("../../lib/iris/services/maintain/hang-probe");
/**
 * `HangProbe`'s decision logic — consecutive-failure counting, the N-of-M
 * escalation threshold, forget-on-recovery, the one-probe-in-flight-per-pid
 * guard — must match `HangProbe.swift` exactly, even though the mechanism
 * answering "is it responding" is completely different (Get-Process vs. an
 * AX timeout). Then the real Windows call gets its own coverage, entirely
 * offline via a fake child process, per the file header's "even the real
 * half stays testable everywhere" claim.
 */
function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
}
(0, vitest_1.describe)("HangProbe — the pure state machine", () => {
    (0, vitest_1.it)("reports unresponsiveButBelowThreshold with an increasing count, below the threshold", async () => {
        const verdicts = [];
        const checkResponsive = async () => false;
        const probe = new hang_probe_1.HangProbe({ checkResponsive, onVerdict: (_, v) => verdicts.push(v) });
        await probe.probe(100);
        await probe.probe(100);
        await probe.probe(100);
        (0, vitest_1.expect)(verdicts).toEqual([
            { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 1 },
            { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 2 },
            { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 3 },
        ]);
    });
    (0, vitest_1.it)("confirms a hang on the Nth consecutive failure, with unresponsiveSeconds from the injected clock", async () => {
        const verdicts = [];
        let now = 0;
        const checkResponsive = async () => false;
        const probe = new hang_probe_1.HangProbe({ checkResponsive, nowEpochMs: () => now, onVerdict: (_, v) => verdicts.push(v) });
        for (let i = 0; i < hang_probe_1.HANG_PROBE_CONSECUTIVE_FAILURES_BEFORE_CONFIRMING - 1; i += 1) {
            await probe.probe(200);
            now += 1_000;
        }
        now = 9_000; // first failure was at t=0
        await probe.probe(200);
        (0, vitest_1.expect)(verdicts.at(-1)).toEqual({ kind: "confirmedHang", unresponsiveSeconds: 9 });
    });
    (0, vitest_1.it)("respects a lower injected threshold", async () => {
        const verdicts = [];
        const checkResponsive = async () => false;
        const probe = new hang_probe_1.HangProbe({
            checkResponsive,
            consecutiveFailuresBeforeConfirming: 2,
            onVerdict: (_, v) => verdicts.push(v),
        });
        await probe.probe(300);
        await probe.probe(300);
        (0, vitest_1.expect)(verdicts).toEqual([
            { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 1 },
            { kind: "confirmedHang", unresponsiveSeconds: 0 },
        ]);
    });
    (0, vitest_1.it)("resets the counter on a responsive answer, so a later run of failures starts over from one", async () => {
        const verdicts = [];
        const answers = [false, false, true, false];
        let index = 0;
        const checkResponsive = async () => answers[index++] ?? false;
        const probe = new hang_probe_1.HangProbe({
            checkResponsive,
            consecutiveFailuresBeforeConfirming: 3,
            onVerdict: (_, v) => verdicts.push(v),
        });
        await probe.probe(400); // fail 1
        await probe.probe(400); // fail 2
        await probe.probe(400); // responsive — resets
        await probe.probe(400); // fail 1 again, not fail 3
        (0, vitest_1.expect)(verdicts).toEqual([
            { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 1 },
            { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 2 },
            { kind: "responsive" },
            { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 1 },
        ]);
    });
    (0, vitest_1.it)("delivers processDisappeared when checkResponsive answers undefined, and forgets that pid's counters", async () => {
        const verdicts = [];
        let disappeared = false;
        const checkResponsive = async () => (disappeared ? undefined : false);
        const probe = new hang_probe_1.HangProbe({ checkResponsive, onVerdict: (_, v) => verdicts.push(v) });
        await probe.probe(500);
        disappeared = true;
        await probe.probe(500);
        (0, vitest_1.expect)(verdicts).toEqual([
            { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 1 },
            { kind: "processDisappeared" },
        ]);
    });
    (0, vitest_1.it)("never runs two probes for the same pid concurrently — the second call is a no-op while one is in flight", async () => {
        const { promise, resolve } = deferred();
        let callCount = 0;
        const checkResponsive = async () => {
            callCount += 1;
            return promise;
        };
        const probe = new hang_probe_1.HangProbe({ checkResponsive });
        const first = probe.probe(600);
        const second = probe.probe(600); // fired before the first resolves
        resolve(true);
        await Promise.all([first, second]);
        (0, vitest_1.expect)(callCount).toBe(1);
    });
    (0, vitest_1.it)("tracks independent pids without cross-contamination", async () => {
        const verdicts = [];
        const checkResponsive = async (pid) => pid !== 701;
        const probe = new hang_probe_1.HangProbe({ checkResponsive, onVerdict: (pid, verdict) => verdicts.push({ pid, verdict }) });
        await probe.probe(700);
        await probe.probe(701);
        (0, vitest_1.expect)(verdicts).toEqual([
            { pid: 700, verdict: { kind: "responsive" } },
            { pid: 701, verdict: { kind: "unresponsiveButBelowThreshold", consecutiveFailures: 1 } },
        ]);
    });
    (0, vitest_1.it)("forget() clears counters so a manual reset (app left the gate) starts the count over", async () => {
        const verdicts = [];
        const checkResponsive = async () => false;
        const probe = new hang_probe_1.HangProbe({
            checkResponsive,
            consecutiveFailuresBeforeConfirming: 3,
            onVerdict: (_, v) => verdicts.push(v),
        });
        await probe.probe(800);
        probe.forget(800);
        await probe.probe(800);
        await probe.probe(800);
        // Three total failed probes across the gap, but forget() reset the
        // counter after the first, so only two consecutive failures accumulate —
        // never reaching the threshold of three.
        (0, vitest_1.expect)(verdicts.every((v) => v.kind === "unresponsiveButBelowThreshold")).toBe(true);
    });
});
(0, vitest_1.describe)("buildGetProcessResponsiveCommand / parseGetProcessResponsiveOutput — pure PowerShell glue", () => {
    (0, vitest_1.it)("builds the bare Get-Process one-liner for a given pid", () => {
        (0, vitest_1.expect)((0, hang_probe_1.buildGetProcessResponsiveCommand)(4821)).toBe("(Get-Process -Id 4821 -ErrorAction SilentlyContinue) | Select-Object -ExpandProperty Responding");
    });
    vitest_1.it.each([
        ["True\r\n", true],
        ["True", true],
        ["False\r\n", false],
        ["", undefined],
        ["   \n", undefined],
        ["WARNING: some locale-specific noise", false],
    ])("parses %j -> %j", (stdout, expected) => {
        (0, vitest_1.expect)((0, hang_probe_1.parseGetProcessResponsiveOutput)(stdout)).toBe(expected);
    });
});
(0, vitest_1.describe)("checkProcessResponsiveViaPowerShell — the real check, exercised entirely offline", () => {
    class FakeSpawnedProcess {
        dataListeners = [];
        closeListeners = [];
        errorListeners = [];
        killCallCount = 0;
        stdout = {
            on: (event, listener) => {
                if (event === "data")
                    this.dataListeners.push(listener);
            },
        };
        stderr = { on: () => { } };
        on(event, listener) {
            if (event === "error")
                this.errorListeners.push(listener);
            else
                this.closeListeners.push(listener);
        }
        kill() {
            this.killCallCount += 1;
        }
        emitStdout(chunk) {
            for (const listener of this.dataListeners)
                listener(chunk);
        }
        emitClose(exitCode) {
            for (const listener of this.closeListeners)
                listener(exitCode);
        }
        emitError(error) {
            for (const listener of this.errorListeners)
                listener(error);
        }
    }
    (0, vitest_1.it)("resolves true when the command prints True and closes cleanly", async () => {
        const fake = new FakeSpawnedProcess();
        const promise = (0, hang_probe_1.checkProcessResponsiveViaPowerShell)(123, { spawnPowerShellOneLiner: () => fake });
        fake.emitStdout("True\r\n");
        fake.emitClose(0);
        await (0, vitest_1.expect)(promise).resolves.toBe(true);
    });
    (0, vitest_1.it)("resolves undefined when the command prints nothing — the process is gone", async () => {
        const fake = new FakeSpawnedProcess();
        const promise = (0, hang_probe_1.checkProcessResponsiveViaPowerShell)(123, { spawnPowerShellOneLiner: () => fake });
        fake.emitClose(0);
        await (0, vitest_1.expect)(promise).resolves.toBeUndefined();
    });
    (0, vitest_1.it)("resolves false when the child process errors (e.g. powershell.exe not found)", async () => {
        const fake = new FakeSpawnedProcess();
        const promise = (0, hang_probe_1.checkProcessResponsiveViaPowerShell)(123, { spawnPowerShellOneLiner: () => fake });
        fake.emitError(new Error("ENOENT"));
        await (0, vitest_1.expect)(promise).resolves.toBe(false);
    });
    (0, vitest_1.it)("resolves false and kills the child if the probe never closes within its timeout", async () => {
        const fake = new FakeSpawnedProcess();
        const promise = (0, hang_probe_1.checkProcessResponsiveViaPowerShell)(123, {
            spawnPowerShellOneLiner: () => fake,
            timeoutMs: 10,
        });
        await (0, vitest_1.expect)(promise).resolves.toBe(false);
        (0, vitest_1.expect)(fake.killCallCount).toBe(1);
    });
    (0, vitest_1.it)("never spawns anything for a non-positive or non-integer pid", async () => {
        const spawnPowerShellOneLiner = vitest_1.vi.fn(() => new FakeSpawnedProcess());
        await (0, vitest_1.expect)((0, hang_probe_1.checkProcessResponsiveViaPowerShell)(0, { spawnPowerShellOneLiner })).resolves.toBeUndefined();
        await (0, vitest_1.expect)((0, hang_probe_1.checkProcessResponsiveViaPowerShell)(-5, { spawnPowerShellOneLiner })).resolves.toBeUndefined();
        await (0, vitest_1.expect)((0, hang_probe_1.checkProcessResponsiveViaPowerShell)(1.5, { spawnPowerShellOneLiner })).resolves.toBeUndefined();
        (0, vitest_1.expect)(spawnPowerShellOneLiner).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("passes the exact Get-Process one-liner for the given pid to the spawn seam", async () => {
        let commandSeen;
        const fake = new FakeSpawnedProcess();
        const promise = (0, hang_probe_1.checkProcessResponsiveViaPowerShell)(4821, {
            spawnPowerShellOneLiner: (command) => {
                commandSeen = command;
                return fake;
            },
        });
        fake.emitStdout("False");
        fake.emitClose(0);
        await promise;
        (0, vitest_1.expect)(commandSeen).toBe((0, hang_probe_1.buildGetProcessResponsiveCommand)(4821));
    });
});
