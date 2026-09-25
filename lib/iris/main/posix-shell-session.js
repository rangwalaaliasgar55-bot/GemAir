"use strict";
//
// The macOS/Linux shell the autopilot runs approved commands in — the POSIX twin
// of `powershell-session.ts`, so the exact same runner, no-click flow, and
// animated terminal can drive a real install when GemAir is run on a Mac for
// testing (the shipped Windows product uses the PowerShell session).
//
// Same design: one short-lived login shell per command, threading the working
// directory forward on a marker line, so `cd` in one step persists to the next.
// A login shell (`zsh -l`) is used so a developer's PATH (brew, node, corepack)
// is present exactly as it is in their Terminal.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.PosixShellSession = void 0;
exports.wrapPosixCommand = wrapPosixCommand;
const node_child_process_1 = require("node:child_process");
const shell_1 = require("../services/autopilot/shell");
const powershell_session_1 = require("./powershell-session");
const MAX_OUTPUT = 8 * 1024;
/// The script GemAir wraps every command in: pin the location, run the command,
/// then print the exit code and resulting directory on the same marker lines the
/// PowerShell session uses, so `parseRun` reads both the same way.
function wrapPosixCommand(command, cwd) {
    const quotedCwd = `'${cwd.replace(/'/g, `'\\''`)}'`;
    return [
        `cd ${quotedCwd} 2>/dev/null || true`,
        command,
        "__iris_code=$?",
        `printf '__IRIS_CWD__:%s\\n' "$PWD"`,
        `printf '__IRIS_CODE__:%s\\n' "$__iris_code"`,
    ].join("\n");
}
const LOGIN_SHELL = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/zsh";
// corepack would otherwise stop to ask before downloading pnpm on first use,
// which a non-interactive install cannot answer.
const SHELL_ENV = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
class PosixShellSession {
    cwd;
    servers = [];
    // The login shell running the current foreground command, tracked so the red
    // 'Stop' can kill it mid-flight. Null between commands.
    currentChild = null;
    constructor(startingDirectory = process.env.HOME ?? "/") {
        this.cwd = startingDirectory;
    }
    currentDirectory() {
        return this.cwd;
    }
    async run(command, deadlineMs) {
        const collected = await this.spawnScript(wrapPosixCommand(command.text, this.cwd), deadlineMs);
        if (collected === "timed_out")
            return { kind: "timed_out" };
        if (collected.spawnFailed)
            return { kind: "session_failed" };
        const parsed = (0, powershell_session_1.parseRun)(collected.stdout, collected.stderr);
        if (parsed.cwd !== undefined)
            this.cwd = parsed.cwd;
        const exitCode = parsed.exitCode ?? 1;
        return exitCode === 0
            ? { kind: "succeeded", output: parsed.output }
            : { kind: "failed", exitCode, output: parsed.output };
    }
    async runLongRunning(command, readyMarker, graceMs) {
        const quotedCwd = `'${this.cwd.replace(/'/g, `'\\''`)}'`;
        const child = (0, node_child_process_1.spawn)(LOGIN_SHELL, ["-l", "-c", `cd ${quotedCwd}; ${command.text}`], {
            env: SHELL_ENV,
        });
        this.servers.push(child);
        return new Promise((resolve) => {
            let settled = false;
            let output = "";
            const done = (outcome) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(outcome);
            };
            const succeed = () => done({ kind: "succeeded", output: output.slice(0, MAX_OUTPUT), servedUrl: (0, shell_1.detectServedUrl)(output) });
            const timer = setTimeout(succeed, graceMs);
            const onData = (chunk) => {
                if (output.length < MAX_OUTPUT)
                    output += chunk;
                if (readyMarker !== undefined && output.includes(readyMarker))
                    succeed();
            };
            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("error", () => done({ kind: "session_failed" }));
            child.on("exit", (code) => done(code === 0 ? { kind: "succeeded", output } : { kind: "failed", exitCode: code ?? 1, output }));
        });
    }
    /// The red 'Stop' on the dev/testing path. SIGKILLs the running command's
    /// login shell and any dev servers. This is best-effort about descendants —
    /// the shipped product is the PowerShell session, whose `taskkill /T` walks
    /// the whole tree; the POSIX twin exists so a Mac can drive the flow at all.
    abort() {
        this.killTree(this.currentChild);
        this.currentChild = null;
        for (const server of this.servers)
            this.killTree(server);
        this.servers.length = 0;
    }
    killTree(child) {
        if (!child || child.pid === undefined)
            return;
        try {
            child.kill("SIGKILL");
        }
        catch {
            // Already dead.
        }
    }
    /// Asked of the processes themselves — see the interface note. A server
    /// that died after `runLongRunning` resolved is visible here and nowhere
    /// else.
    longRunningStillAlive() {
        return this.servers.some((server) => server.exitCode === null && !server.killed);
    }
    dispose() {
        for (const server of this.servers)
            server.kill();
        this.servers.length = 0;
        this.currentChild = null;
    }
    spawnScript(script, deadlineMs) {
        return new Promise((resolve) => {
            const child = (0, node_child_process_1.spawn)(LOGIN_SHELL, ["-l", "-c", script], { env: SHELL_ENV });
            this.currentChild = child;
            let stdout = "";
            let stderr = "";
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                if (this.currentChild === child)
                    this.currentChild = null;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => {
                child.kill();
                finish("timed_out");
            }, deadlineMs);
            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", (chunk) => {
                stdout += chunk;
            });
            child.stderr?.on("data", (chunk) => {
                stderr += chunk;
            });
            child.on("error", () => finish({ stdout, stderr, spawnFailed: true }));
            child.on("close", () => finish({ stdout, stderr, spawnFailed: false }));
        });
    }
}
exports.PosixShellSession = PosixShellSession;
