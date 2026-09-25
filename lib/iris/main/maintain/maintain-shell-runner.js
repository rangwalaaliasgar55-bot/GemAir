"use strict";
/**
 * main/maintain/maintain-shell-runner.js
 *
 * The `createShellRunner` seam `replay-engine.js` and `tier-c-fixer.js` take,
 * picked for the platform this copy of GemAir is running on.
 *
 * Upstream only had the Windows half (`maintain-shell-runner-windows.js`,
 * kept beside this file unchanged) because that build only ran on Windows. The
 * macOS client was Swift and had its own. GemAir ships one Electron app on both,
 * so maintain mode would have been silently dead on a Mac — `createShellRunner`
 * would hand back a PowerShell runner whose every `run()` failed to spawn, and
 * the replay engine would read that as "the fix did not apply" rather than "this
 * machine cannot run the fix". A wrong answer, not a missing one.
 *
 * The POSIX half below is the same shape as the Windows one: one short-lived
 * non-interactive login shell per `run()`, rooted at `repoRootPath`, nothing
 * shared between calls but the working tree itself. It deliberately does NOT
 * reuse `PosixShellSession` — that class threads a working directory forward
 * across commands for the autopilot's animated terminal, and a fix runner must
 * start every command at the repo root.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PosixMaintainShellRunner = void 0;
exports.createMaintainShellRunner = createMaintainShellRunner;
exports.createPosixMaintainShellRunner = createPosixMaintainShellRunner;

const { spawn } = require("node:child_process");
const path = require("node:path");
const { createWindowsMaintainShellRunner } = require("./maintain-shell-runner-windows");
const { wrapPosixCommand } = require("../posix-shell-session");
const { parseRun } = require("../powershell-session");

const DEFAULT_DEADLINE_MS = 300000;
const MAX_OUTPUT_TAIL = 16 * 1024;
const LOGIN_SHELL = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/zsh";
// corepack would otherwise stop to ask before downloading pnpm on first use,
// which a non-interactive fix run cannot answer.
const SHELL_ENV = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", GIT_TERMINAL_PROMPT: "0" };

class PosixMaintainShellRunner {
  constructor(repoRootPath) {
    this.repoRootPath = repoRootPath;
  }

  async run(command, opts) {
    const cwd =
      opts?.inSubdirectory !== undefined
        ? path.join(this.repoRootPath, opts.inSubdirectory)
        : this.repoRootPath;
    const collected = await spawnScript(wrapPosixCommand(command, cwd), opts?.deadlineMs ?? DEFAULT_DEADLINE_MS);
    if (collected === "timed_out") {
      return { succeeded: false, exitCode: -1, outputTail: "(timed out)" };
    }
    if (collected.spawnFailed) {
      return { succeeded: false, exitCode: -1, outputTail: `(could not start ${LOGIN_SHELL})` };
    }
    const parsed = parseRun(collected.stdout, collected.stderr);
    const exitCode = parsed.exitCode ?? 1;
    return {
      succeeded: exitCode === 0,
      exitCode,
      outputTail: parsed.output.slice(-MAX_OUTPUT_TAIL),
    };
  }
}
exports.PosixMaintainShellRunner = PosixMaintainShellRunner;

function spawnScript(script, deadlineMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(LOGIN_SHELL, ["-l", "-c", script], { env: SHELL_ENV, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ stdout: "", stderr: "", spawnFailed: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish("timed_out");
    }, deadlineMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => finish({ stdout, stderr, spawnFailed: true }));
    child.on("close", () => finish({ stdout, stderr, spawnFailed: false }));
  });
}

/** A POSIX runner rooted at `repoRootPath`, refusing an unusable path up front
 *  exactly as the Windows factory does. */
function createPosixMaintainShellRunner(repoRootPath) {
  if (repoRootPath.trim().length === 0 || !path.isAbsolute(repoRootPath)) return undefined;
  return new PosixMaintainShellRunner(repoRootPath);
}

/** The factory the controller injects: PowerShell on Windows, a login shell
 *  everywhere else. */
function createMaintainShellRunner(repoRootPath) {
  return process.platform === "win32"
    ? createWindowsMaintainShellRunner(repoRootPath)
    : createPosixMaintainShellRunner(repoRootPath);
}
