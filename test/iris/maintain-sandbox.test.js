"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const sandbox_1 = require("../../lib/iris/services/maintain/sandbox");
const maintain_shell_runner_1 = require("../../lib/iris/services/maintain/maintain-shell-runner");
/**
 * The Windows Job Object jail's pure half: string-builders that describe real
 * Win32 machinery (a Job Object, a restricted token, a scoped firewall rule)
 * but never execute anything themselves — see `sandbox.ts`'s header for why.
 * Everything here is checkable by substring on any host; the actual
 * containment behavior can only be proven on real Windows, which is out of
 * this suite's scope per the porting spec's §3/§7.
 */
const SAMPLE_IDENTIFIERS = (0, sandbox_1.buildSandboxIdentifiers)("fixed-jail-id", "C:\\Temp");
(0, vitest_1.describe)("buildSandboxIdentifiers", () => {
    (0, vitest_1.it)("derives every name/path from the jail id and temp directory", () => {
        const identifiers = (0, sandbox_1.buildSandboxIdentifiers)("abc123", "C:\\Users\\reader\\AppData\\Local\\Temp");
        (0, vitest_1.expect)(identifiers.jailId).toBe("abc123");
        (0, vitest_1.expect)(identifiers.jobObjectName).toBe("gemair-jail-abc123");
        (0, vitest_1.expect)(identifiers.firewallRuleName).toBe("gemair-jail-abc123");
        (0, vitest_1.expect)(identifiers.copiedShellPath).toBe("C:\\Users\\reader\\AppData\\Local\\Temp\\gemair-jail-abc123-shell.exe");
        (0, vitest_1.expect)(identifiers.stdoutFilePath).toBe("C:\\Users\\reader\\AppData\\Local\\Temp\\gemair-jail-abc123-out.txt");
        (0, vitest_1.expect)(identifiers.stderrFilePath).toBe("C:\\Users\\reader\\AppData\\Local\\Temp\\gemair-jail-abc123-err.txt");
    });
    (0, vitest_1.it)("trims a trailing backslash off the temp directory rather than doubling it", () => {
        const withTrailingSlash = (0, sandbox_1.buildSandboxIdentifiers)("xyz", "C:\\Temp\\");
        const withoutTrailingSlash = (0, sandbox_1.buildSandboxIdentifiers)("xyz", "C:\\Temp");
        (0, vitest_1.expect)(withTrailingSlash).toEqual(withoutTrailingSlash);
        (0, vitest_1.expect)(withTrailingSlash.copiedShellPath).toBe("C:\\Temp\\gemair-jail-xyz-shell.exe");
    });
    (0, vitest_1.it)("always builds a Windows-flavored (backslash) path, regardless of host OS", () => {
        // The script this feeds only ever runs on Windows, so the identifiers
        // must describe a Windows path even when this test itself runs on the
        // Mac dev machine — using `node:path` here would silently use `/` and
        // produce a broken script. See the function's own header comment.
        const identifiers = (0, sandbox_1.buildSandboxIdentifiers)("id", "C:\\Temp");
        (0, vitest_1.expect)(identifiers.stdoutFilePath).not.toContain("/");
    });
});
(0, vitest_1.describe)("buildJailedPowerShellScript", () => {
    const script = (0, sandbox_1.buildJailedPowerShellScript)({
        command: "Get-ChildItem -Path .",
        repoRootPath: "C:\\repo",
        identifiers: SAMPLE_IDENTIFIERS,
        limits: sandbox_1.DEFAULT_WINDOWS_SANDBOX_LIMITS,
    });
    (0, vitest_1.it)("embeds the command as a single-quoted PowerShell literal", () => {
        (0, vitest_1.expect)(script).toContain("$innerCommandScript = 'Get-ChildItem -Path .'");
    });
    (0, vitest_1.it)("doubles an embedded single quote when escaping the command", () => {
        const withQuote = (0, sandbox_1.buildJailedPowerShellScript)({
            command: "Write-Output 'it''s a test'",
            repoRootPath: "C:\\repo",
            identifiers: SAMPLE_IDENTIFIERS,
            limits: sandbox_1.DEFAULT_WINDOWS_SANDBOX_LIMITS,
        });
        (0, vitest_1.expect)(withQuote).toContain("'Write-Output ''it''''s a test'''");
    });
    (0, vitest_1.it)("sets the child's working directory to repoRootPath", () => {
        (0, vitest_1.expect)(script).toContain("$repoRootPath = 'C:\\repo'");
        // Passed as CreateProcessAsUser's lpCurrentDirectory argument.
        (0, vitest_1.expect)(script).toContain("$repoRootPath, [ref]$startupInfo, [ref]$processInfo");
    });
    (0, vitest_1.it)("registers a firewall outbound-block rule scoped to the copied shell binary", () => {
        (0, vitest_1.expect)(script).toContain(`name="$firewallRuleName"`);
        (0, vitest_1.expect)(script).toContain("dir=out");
        (0, vitest_1.expect)(script).toContain("action=block");
        (0, vitest_1.expect)(script).toContain("Copy-Item -LiteralPath (Get-Command powershell.exe).Source -Destination $shellCopyPath");
    });
    (0, vitest_1.it)("removes the firewall rule unconditionally as part of its own cleanup", () => {
        (0, vitest_1.expect)(script).toContain('netsh advfirewall firewall delete rule name="$firewallRuleName"');
    });
    (0, vitest_1.it)("creates a Job Object with KILL_ON_JOB_CLOSE and the configured resource ceilings", () => {
        (0, vitest_1.expect)(script).toContain("CreateJobObject");
        (0, vitest_1.expect)(script).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
        (0, vitest_1.expect)(script).toContain("JOB_OBJECT_LIMIT_ACTIVE_PROCESS");
        (0, vitest_1.expect)(script).toContain("JOB_OBJECT_LIMIT_JOB_MEMORY");
        (0, vitest_1.expect)(script).toContain(`ActiveProcessLimit = [uint32]${sandbox_1.DEFAULT_WINDOWS_SANDBOX_LIMITS.maximumActiveProcesses}`);
        (0, vitest_1.expect)(script).toContain(`JobMemoryLimit = [UIntPtr]${sandbox_1.DEFAULT_WINDOWS_SANDBOX_LIMITS.maximumJobMemoryBytes}`);
    });
    (0, vitest_1.it)("closes the job's handle unconditionally, which is what reaps orphaned children", () => {
        (0, vitest_1.expect)(script).toContain("[GemAirJail.Native]::CloseHandle($job) | Out-Null");
    });
    (0, vitest_1.it)("derives a restricted token with DISABLE_MAX_PRIVILEGE from the caller's own token", () => {
        (0, vitest_1.expect)(script).toContain("CreateRestrictedToken");
        (0, vitest_1.expect)(script).toContain("DISABLE_MAX_PRIVILEGE");
        // Falls back to the unrestricted token rather than aborting if the
        // restricted-token creation fails — best-effort, per the module header.
        (0, vitest_1.expect)(script).toContain("$tokenForChild = if ($haveRestrictedToken) { $restrictedToken } else { $currentProcessToken }");
    });
    (0, vitest_1.it)("uses CreateProcessAsUser, never a plain Start-Process, to hand off the restricted token", () => {
        (0, vitest_1.expect)(script).toContain("CreateProcessAsUser($tokenForChild");
    });
    (0, vitest_1.it)("points HTTP_PROXY/HTTPS_PROXY/ALL_PROXY at a black hole for the child, and restores them after", () => {
        for (const variable of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
            (0, vitest_1.expect)(script).toContain(`SetEnvironmentVariable('${variable}', 'http://127.0.0.1:1', 'Process')`);
        }
        (0, vitest_1.expect)(script).toContain("$previousHttpProxy = [System.Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process')");
        (0, vitest_1.expect)(script).toContain("SetEnvironmentVariable('HTTP_PROXY', $previousHttpProxy, 'Process')");
    });
    (0, vitest_1.it)("never mentions Seatbelt-style filesystem containment — this jail does not provide it", () => {
        (0, vitest_1.expect)(script.toLowerCase()).not.toContain("seatbelt");
    });
    (0, vitest_1.it)("respects a caller-supplied resource ceiling rather than always emitting the default", () => {
        const customLimits = { maximumActiveProcesses: 4, maximumJobMemoryBytes: 123_456 };
        const customScript = (0, sandbox_1.buildJailedPowerShellScript)({
            command: "whoami",
            repoRootPath: "C:\\repo",
            identifiers: SAMPLE_IDENTIFIERS,
            limits: customLimits,
        });
        (0, vitest_1.expect)(customScript).toContain("ActiveProcessLimit = [uint32]4");
        (0, vitest_1.expect)(customScript).toContain("JobMemoryLimit = [UIntPtr]123456");
    });
});
(0, vitest_1.describe)("buildSandboxCleanupScript", () => {
    (0, vitest_1.it)("removes the firewall rule and every temp file this invocation created, tolerating absence", () => {
        const cleanupScript = (0, sandbox_1.buildSandboxCleanupScript)(SAMPLE_IDENTIFIERS);
        (0, vitest_1.expect)(cleanupScript).toContain(`netsh advfirewall firewall delete rule name='${SAMPLE_IDENTIFIERS.firewallRuleName}'`);
        (0, vitest_1.expect)(cleanupScript).toContain(`Remove-Item -LiteralPath '${SAMPLE_IDENTIFIERS.copiedShellPath}' -Force -ErrorAction SilentlyContinue`);
        (0, vitest_1.expect)(cleanupScript).toContain(`Remove-Item -LiteralPath '${SAMPLE_IDENTIFIERS.stdoutFilePath}' -Force -ErrorAction SilentlyContinue`);
        (0, vitest_1.expect)(cleanupScript).toContain(`Remove-Item -LiteralPath '${SAMPLE_IDENTIFIERS.stderrFilePath}' -Force -ErrorAction SilentlyContinue`);
    });
});
(0, vitest_1.describe)("WindowsJobObjectSandbox.isAvailable", () => {
    (0, vitest_1.it)("reports available on win32", () => {
        const sandbox = new sandbox_1.WindowsJobObjectSandbox({ platform: "win32" });
        (0, vitest_1.expect)(sandbox.isAvailable()).toEqual({ available: true });
    });
    (0, vitest_1.it)("reports unavailable, with a reason, on any non-Windows platform", () => {
        const sandbox = new sandbox_1.WindowsJobObjectSandbox({ platform: "darwin" });
        const availability = sandbox.isAvailable();
        (0, vitest_1.expect)(availability.available).toBe(false);
        (0, vitest_1.expect)(availability.reason).toMatch(/only available on Windows/);
    });
});
(0, vitest_1.describe)("WindowsJobObjectSandbox.jailedInvocation", () => {
    (0, vitest_1.it)("returns undefined for a blank or whitespace-only command — nothing to jail", () => {
        const sandbox = new sandbox_1.WindowsJobObjectSandbox({ platform: "win32" });
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        (0, vitest_1.expect)(sandbox.jailedInvocation({ command: "", repoRootPath: "C:\\repo", runner })).toBeUndefined();
        (0, vitest_1.expect)(sandbox.jailedInvocation({ command: "   ", repoRootPath: "C:\\repo", runner })).toBeUndefined();
    });
    (0, vitest_1.it)("builds a script embedding the given command and repo root, with a fresh id per call", () => {
        const sandbox = new sandbox_1.WindowsJobObjectSandbox({ platform: "win32", generateJailId: () => "deterministic-id" });
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const jailed = sandbox.jailedInvocation({ command: "git status", repoRootPath: "C:\\repo", runner });
        (0, vitest_1.expect)(jailed).toBeDefined();
        (0, vitest_1.expect)(jailed?.invocation).toContain("$innerCommandScript = 'git status'");
        (0, vitest_1.expect)(jailed?.invocation).toContain("$repoRootPath = 'C:\\repo'");
        (0, vitest_1.expect)(jailed?.invocation).toContain("gemair-jail-deterministic-id");
    });
    (0, vitest_1.it)("generates a new jail id (and therefore new identifiers) on every call by default", () => {
        const sandbox = new sandbox_1.WindowsJobObjectSandbox({ platform: "win32" });
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const first = sandbox.jailedInvocation({ command: "whoami", repoRootPath: "C:\\repo", runner });
        const second = sandbox.jailedInvocation({ command: "whoami", repoRootPath: "C:\\repo", runner });
        (0, vitest_1.expect)(first?.invocation).not.toBe(second?.invocation);
    });
    (0, vitest_1.it)("cleanup() runs the cleanup script through the caller's own runner", async () => {
        const sandbox = new sandbox_1.WindowsJobObjectSandbox({ platform: "win32", generateJailId: () => "cleanup-test-id" });
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const jailed = sandbox.jailedInvocation({ command: "git status", repoRootPath: "C:\\repo", runner });
        (0, vitest_1.expect)(jailed).toBeDefined();
        await jailed?.cleanup();
        (0, vitest_1.expect)(runner.commandsRun).toHaveLength(1);
        (0, vitest_1.expect)(runner.commandsRun[0]).toContain("gemair-jail-cleanup-test-id");
        (0, vitest_1.expect)(runner.commandsRun[0]).toContain("netsh advfirewall firewall delete rule");
    });
    (0, vitest_1.it)("respects a caller-supplied resource limit override end to end", () => {
        const sandbox = new sandbox_1.WindowsJobObjectSandbox({
            platform: "win32",
            limits: { maximumActiveProcesses: 2, maximumJobMemoryBytes: 999 },
        });
        const runner = maintain_shell_runner_1.MockMaintainShellRunner.alwaysSucceeds();
        const jailed = sandbox.jailedInvocation({ command: "whoami", repoRootPath: "C:\\repo", runner });
        (0, vitest_1.expect)(jailed?.invocation).toContain("ActiveProcessLimit = [uint32]2");
        (0, vitest_1.expect)(jailed?.invocation).toContain("JobMemoryLimit = [UIntPtr]999");
    });
});
