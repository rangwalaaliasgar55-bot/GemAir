"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const powershell_session_1 = require("../../lib/iris/main/powershell-session");
/**
 * The PowerShell session spawns real processes and only runs on Windows CI, but
 * its parsing and quoting are pure — and they are where a subtle bug (a
 * misparsed exit code, a path that breaks out of Set-Location) would do real
 * damage. So those are pinned down here, on any host.
 */
(0, vitest_1.describe)("PowerShell command wrapping", () => {
    (0, vitest_1.it)("single-quotes a path and doubles embedded quotes", () => {
        (0, vitest_1.expect)((0, powershell_session_1.psSingleQuote)("C:\\Users\\me")).toBe("'C:\\Users\\me'");
        (0, vitest_1.expect)((0, powershell_session_1.psSingleQuote)("C:\\it's here")).toBe("'C:\\it''s here'");
    });
    (0, vitest_1.it)("pins the location and appends the exit-code and cwd markers", () => {
        const script = (0, powershell_session_1.wrapCommandScript)("git status", "C:\\repo");
        (0, vitest_1.expect)(script).toContain("Set-Location -LiteralPath 'C:\\repo'");
        (0, vitest_1.expect)(script).toContain("& { git status }");
        (0, vitest_1.expect)(script).toContain("__IRIS_CODE__:");
        (0, vitest_1.expect)(script).toContain("__IRIS_CWD__:");
    });
    (0, vitest_1.it)("refreshes PATH from the registry before the command, so a just-installed tool is seen", () => {
        const script = (0, powershell_session_1.wrapCommandScript)("git status", "C:\\repo");
        // The refresh must come BEFORE the command runs, or the command would still
        // be blind to a tool the previous step installed.
        (0, vitest_1.expect)(script).toContain(powershell_session_1.REFRESH_PATH_FROM_REGISTRY);
        (0, vitest_1.expect)(script.indexOf(powershell_session_1.REFRESH_PATH_FROM_REGISTRY)).toBeLessThan(script.indexOf("& { git status }"));
        // It reads both the machine and the user Path values — an installer writes
        // to one or the other depending on whether it ran elevated.
        (0, vitest_1.expect)(script).toContain("'Path','Machine'");
        (0, vitest_1.expect)(script).toContain("'Path','User'");
    });
    (0, vitest_1.it)("silences progress records before anything runs, so no CLIXML reaches the reader", () => {
        const script = (0, powershell_session_1.wrapCommandScript)("git status", "C:\\repo");
        (0, vitest_1.expect)(script).toContain("$ProgressPreference = 'SilentlyContinue'");
        (0, vitest_1.expect)(script.indexOf("$ProgressPreference")).toBeLessThan(script.indexOf(powershell_session_1.REFRESH_PATH_FROM_REGISTRY));
    });
    (0, vitest_1.it)("encodes a script as UTF-16LE base64 that round-trips", () => {
        const encoded = (0, powershell_session_1.encodeForPowerShell)("Write-Output 'hi'");
        (0, vitest_1.expect)(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Write-Output 'hi'");
    });
});
(0, vitest_1.describe)("parsing a completed run", () => {
    (0, vitest_1.it)("pulls the exit code and new directory, and strips the marker lines", () => {
        const stdout = ["Cloning into 'x'...", "done.", "__IRIS_CWD__:C:\\Users\\me\\x", "__IRIS_CODE__:0"].join("\r\n");
        const parsed = (0, powershell_session_1.parseRun)(stdout, "");
        (0, vitest_1.expect)(parsed.exitCode).toBe(0);
        (0, vitest_1.expect)(parsed.cwd).toBe("C:\\Users\\me\\x");
        (0, vitest_1.expect)(parsed.output).toBe("Cloning into 'x'...\ndone.");
        (0, vitest_1.expect)(parsed.output).not.toContain("__IRIS_");
    });
    (0, vitest_1.it)("reports a non-zero exit and folds stderr into the output", () => {
        const stdout = ["npm ERR! missing script: build", "__IRIS_CWD__:C:\\repo", "__IRIS_CODE__:1"].join("\n");
        const parsed = (0, powershell_session_1.parseRun)(stdout, "some stderr noise");
        (0, vitest_1.expect)(parsed.exitCode).toBe(1);
        (0, vitest_1.expect)(parsed.output).toContain("npm ERR!");
        (0, vitest_1.expect)(parsed.output).toContain("some stderr noise");
    });
    (0, vitest_1.it)("keeps the END of a long output — where a build prints its error — not the start", () => {
        const filler = Array.from({ length: 2000 }, (_, i) => `   Compiling crate-${i} v0.1.0`).join("\n");
        const stdout = [filler, "error[E0432]: unresolved import `nope`", "__IRIS_CWD__:C:\\repo", "__IRIS_CODE__:101"].join("\n");
        const parsed = (0, powershell_session_1.parseRun)(stdout, "");
        (0, vitest_1.expect)(parsed.exitCode).toBe(101);
        (0, vitest_1.expect)(parsed.output.length).toBeLessThanOrEqual(8 * 1024);
        (0, vitest_1.expect)(parsed.output).toContain("error[E0432]");
        (0, vitest_1.expect)(parsed.output).not.toContain("Compiling crate-0 ");
    });
    (0, vitest_1.it)("treats missing markers as a failed run rather than a silent success", () => {
        // If PowerShell died before printing the markers, there is no code to read —
        // the caller defaults that to a failure, never a pass.
        const parsed = (0, powershell_session_1.parseRun)("partial output with no markers", "");
        (0, vitest_1.expect)(parsed.exitCode).toBeUndefined();
    });
});
