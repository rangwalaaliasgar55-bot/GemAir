"use strict";
/**
 * maintain-shell-runner-windows.ts
 *
 * The real, Windows-side implementation of
 * `services/maintain/maintain-shell-runner.ts`'s `MaintainShellRunner`
 * interface — the porting spec's `main/maintain/` module of the same name.
 *
 * Deliberately separate from `main/powershell-session.ts`'s `PowerShellSession`
 * (the autopilot's shell) — see `maintain-shell-runner.ts`'s own header and
 * the porting spec's decision 3: verification/replay/patch-queue commands are
 * code-authored constants (`"git diff --numstat HEAD"`, `"npm run build"`),
 * never guide/model text, and this runner is simpler than the autopilot's
 * because of it. `PowerShellSession` threads a persistent working directory
 * across calls because an install sequence's `cd repo` has to be felt by the
 * next step; every caller of `MaintainShellRunner` already passes an explicit
 * `inSubdirectory` (or runs at the repo root) instead, so each call is a
 * clean one-shot `powershell.exe -EncodedCommand` with no state carried
 * between them — reusing `wrapCommandScript`/`encodeForPowerShell` exported
 * from `powershell-session.ts` rather than re-deriving the marker-line parsing
 * convention, per the porting spec.
 *
 * This module spawns a process, so it lives in `main/`, not `services/` —
 * `services/maintain/*.ts` files must never import `child_process`. It is
 * exercised for real only on `windows-latest` CI; the pure logic layered on
 * top of `MaintainShellRunner` (`replay-engine.ts`, `verification-harness.ts`,
 * `patch-queue.ts`, `tier-c-fixer.ts`) is already proven against
 * `MockMaintainShellRunner` on any host — this file's own correctness, that
 * `powershell.exe -EncodedCommand` really runs the wrapped script and really
 * reports the exit code, can only be proven on real Windows.
 */
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
exports.WindowsMaintainShellRunner = void 0;
exports.createWindowsMaintainShellRunner = createWindowsMaintainShellRunner;
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const powershell_session_1 = require("../powershell-session");
const DEFAULT_DEADLINE_MS = 300_000;
const MAX_OUTPUT_TAIL = 16 * 1024;
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
const CODE_MARKER = "__IRIS_CODE__:";
const CWD_MARKER = "__IRIS_CWD__:";
/** One-shot `powershell.exe -EncodedCommand` per `run()` call, rooted at
 *  `repoRootPath`. No state survives between calls other than what git itself
 *  persisted to the working tree — see the file header for why this is a
 *  different shape than the autopilot's persistent pty-backed session. */
class WindowsMaintainShellRunner {
    repoRootPath;
    constructor(repoRootPath) {
        this.repoRootPath = repoRootPath;
    }
    async run(command, opts) {
        const cwd = opts?.inSubdirectory !== undefined ? path.join(this.repoRootPath, opts.inSubdirectory) : this.repoRootPath;
        const script = (0, powershell_session_1.wrapCommandScript)(command, cwd);
        const deadlineMs = opts?.deadlineMs ?? DEFAULT_DEADLINE_MS;
        const collected = await spawnEncodedScript(script, deadlineMs);
        if (collected === "timed_out") {
            return { succeeded: false, exitCode: -1, outputTail: "(timed out)" };
        }
        if (collected.spawnFailed) {
            return { succeeded: false, exitCode: -1, outputTail: "(could not start powershell.exe)" };
        }
        const parsed = parseMarkerLines(collected.stdout, collected.stderr);
        const exitCode = parsed.exitCode ?? 1;
        return {
            succeeded: exitCode === 0,
            exitCode,
            outputTail: parsed.output.slice(-MAX_OUTPUT_TAIL),
        };
    }
}
exports.WindowsMaintainShellRunner = WindowsMaintainShellRunner;
/** Builds a `WindowsMaintainShellRunner` rooted at `repoRootPath`, or
 *  `undefined` when the path is not usable — the real implementation of the
 *  `createShellRunner` seam `replay-engine.ts`/`tier-c-fixer.ts` take,
 *  mirroring Swift's `try? MaintainShellRunner(repoRootPath:)`. A relative or
 *  empty path is refused up front rather than failing confusingly on the
 *  first `run()` call. */
function createWindowsMaintainShellRunner(repoRootPath) {
    if (repoRootPath.trim().length === 0 || !path.isAbsolute(repoRootPath)) {
        return undefined;
    }
    return new WindowsMaintainShellRunner(repoRootPath);
}
// ---------------------------------------------------------------------------
// Small local helpers — deliberately duplicated rather than reaching into
// `PowerShellSession`'s private `spawnEncoded`/`parseRun` bodies (only the
// exported pure functions are reused, per the module header).
// ---------------------------------------------------------------------------
/** Strips the marker lines `wrapCommandScript` writes and reads the exit code
 *  back out — the same parsing convention `powershell-session.ts`'s own
 *  `parseRun` uses, duplicated narrowly here because this runner has no use
 *  for `parseRun`'s `cwd` tracking (every call already gets an explicit
 *  working directory; nothing here persists it forward). */
function parseMarkerLines(stdout, stderr) {
    let exitCode;
    const outputLines = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        if (rawLine.startsWith(CODE_MARKER)) {
            const parsed = Number.parseInt(rawLine.slice(CODE_MARKER.length).trim(), 10);
            exitCode = Number.isNaN(parsed) ? 1 : parsed;
        }
        else if (rawLine.startsWith(CWD_MARKER)) {
            // Emitted by `wrapCommandScript` but not tracked here — see the header.
            continue;
        }
        else {
            outputLines.push(rawLine);
        }
    }
    const combined = `${outputLines.join("\n")}\n${stderr}`.trim();
    return { exitCode, output: combined };
}
function spawnEncodedScript(script, deadlineMs) {
    return new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)("powershell.exe", [...POWERSHELL_ARGS, "-EncodedCommand", (0, powershell_session_1.encodeForPowerShell)(script)], {
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
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
