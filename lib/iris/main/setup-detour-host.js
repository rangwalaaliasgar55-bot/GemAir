"use strict";
//
// The real seams the setup-recovery detour runs against — the `main/` side of
// `services/autopilot/setup-detour.ts`, which is pure and only knows the
// `ToolProbe`/`DetourClock` interfaces.
//
// The one thing that matters here that a plain version check does not do: the
// probe re-reads the machine+user PATH from the registry before it looks for the
// tool, so a tool the autopilot installed moments ago (whose PATH entry a fresh
// `powershell.exe` would otherwise not inherit until GemAir restarts) is found.
// This is why the detour can install git with winget and then, on the very next
// poll, see it. Mirrors the PATH refresh `wrapCommandScript` does per command.
//
// This module spawns processes, so it lives in `main/`. Its behaviour on
// windows-latest is exercised by the packaged app on CI; the pure decision logic
// it serves is unit-tested with fakes.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealDetourClock = exports.RegistryRefreshingToolProbe = void 0;
const node_child_process_1 = require("node:child_process");
const tool_versions_1 = require("../services/tool-versions");
const powershell_session_1 = require("./powershell-session");
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
const PROBE_TIMEOUT_MS = 10_000;
/// What a `Get-Command <tool>`, run in a PowerShell whose PATH was just refreshed
/// from the registry, concludes: `installed` when it exits 0, `notInstalled` when
/// it exits 1 (Get-Command found nothing), and `couldNotBeChecked` when the probe
/// times out or the process fails to spawn — because a probe that never ran has
/// NOT established the tool is missing, and treating it as missing would march
/// the reader into an install they may not need. The tool name is only ever an
/// allowlisted one (guarded by the caller and again here), so it is safe to
/// interpolate — there is no guide text in this path.
function findsToolWithFreshPath(tool) {
    return new Promise((resolve) => {
        const script = [
            powershell_session_1.REFRESH_PATH_FROM_REGISTRY,
            `if (Get-Command ${tool} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
            "",
        ].join("\n");
        const child = (0, node_child_process_1.spawn)("powershell.exe", [...POWERSHELL_ARGS, "-EncodedCommand", (0, powershell_session_1.encodeForPowerShell)(script)], { windowsHide: true });
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill();
            finish("couldNotBeChecked");
        }, PROBE_TIMEOUT_MS);
        child.on("error", () => finish("couldNotBeChecked"));
        // A null exit code means the process was killed (e.g. the timeout above won
        // the race) rather than exiting on its own — not proof the tool is absent.
        child.on("exit", (code) => finish(code === 0 ? "installed" : code === null ? "couldNotBeChecked" : "notInstalled"));
    });
}
/// What the tool's allowlisted `--version` probe concludes — the check used when
/// GemAir runs on a Mac to exercise the flow (the login shell the POSIX session
/// drives already carries the developer's PATH, so no registry refresh applies).
/// Runs the exact executable+args `tool-versions.ts` sanctions, never anything
/// built from recipe text. A clean run is `installed`; a timeout/kill is
/// `couldNotBeChecked` (the probe did not finish); any other failure — the
/// executable is missing (ENOENT) or exited non-zero — is `notInstalled`.
function answersItsVersionProbe(tool) {
    const spec = (0, tool_versions_1.toolSpecFor)(tool);
    if (spec === null)
        return Promise.resolve("couldNotBeChecked");
    const [executable, args] = spec;
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)(executable, [...args], { windowsHide: true, timeout: PROBE_TIMEOUT_MS, shell: false }, (error) => {
            if (!error)
                return resolve("installed");
            const timedOut = error.killed === true;
            resolve(timedOut ? "couldNotBeChecked" : "notInstalled");
        });
    });
}
/// The production `ToolProbe`: a PowerShell `Get-Command` with a
/// freshly-refreshed PATH on Windows (so an install the detour just ran is seen),
/// and a plain version probe on macOS/Linux (the dev-testing host).
class RegistryRefreshingToolProbe {
    async probe(tool) {
        // A tool the allowlist does not know cannot be probed by name — that is a
        // "could not check", NOT a "definitely missing", so the detour leaves it be.
        if (!(0, tool_versions_1.isAllowlistedTool)(tool))
            return "couldNotBeChecked";
        return process.platform === "win32" ? findsToolWithFreshPath(tool) : answersItsVersionProbe(tool);
    }
    async isWingetAvailable() {
        return (await this.probe("winget")) === "installed";
    }
}
exports.RegistryRefreshingToolProbe = RegistryRefreshingToolProbe;
/// The production `DetourClock`: the wall clock and a real sleep.
class RealDetourClock {
    now() {
        return Date.now();
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.RealDetourClock = RealDetourClock;
