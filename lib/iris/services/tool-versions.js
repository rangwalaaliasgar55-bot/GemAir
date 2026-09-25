"use strict";
/**
 * tool-versions.ts
 *
 * "Is git installed?" for the guide panel's verification steps.
 *
 * The allowlist is ported from `tool_spec` in
 * `iris-desktop/src-tauri/src/main.rs`. It exists so a guide — which is
 * server-served content and therefore not something a client release reviewed —
 * cannot name an arbitrary program for GemAir to run. A tool that is not on this
 * list is refused; there is no escape hatch, and no part of the command is ever
 * built from guide text.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolSpecFor = toolSpecFor;
exports.isAllowlistedTool = isAllowlistedTool;
exports.boundedCommandOutput = boundedCommandOutput;
/** Executable and arguments for each tool a guide may ask about. */
const TOOL_SPECS = new Map([
    ["git", ["git", ["--version"]]],
    ["node", ["node", ["--version"]]],
    ["npm", ["npm", ["--version"]]],
    ["pnpm", ["pnpm", ["--version"]]],
    ["bun", ["bun", ["--version"]]],
    ["python", ["python", ["--version"]]],
    ["python3", ["python3", ["--version"]]],
    ["uv", ["uv", ["--version"]]],
    ["cargo", ["cargo", ["--version"]]],
    ["rustc", ["rustc", ["--version"]]],
    ["docker", ["docker", ["--version"]]],
    ["java", ["java", ["--version"]]],
    ["adb", ["adb", ["version"]]],
    // The Windows package manager, probed by the setup-recovery detour to decide
    // whether the winget fast path is available before it falls back to a manual
    // download page. A safe version probe like every other entry.
    ["winget", ["winget", ["--version"]]],
    // Same entry as the macOS ToolVersionService: a guide watches for the
    // Ollama CLI before it types `ollama pull`.
    ["ollama", ["ollama", ["--version"]]],
    // GemAir's own brain, when the reader runs it locally. The `opencode` guide
    // verifies the install with this, and the settings panel probes it to decide
    // whether to offer the CLI route at all.
    ["opencode", ["opencode", ["--version"]]],
    // Yarn and Deno round out the JS toolchain the bundled source-build guides
    // reach for. Same safe shape: a version flag and nothing else.
    ["yarn", ["yarn", ["--version"]]],
    ["deno", ["deno", ["--version"]]],
    // VS Code's CLI, which the `vscode` recipe verifies with.
    ["code", ["code", ["--version"]]],
]);
function toolSpecFor(tool) {
    return TOOL_SPECS.get(tool) ?? null;
}
function isAllowlistedTool(tool) {
    return TOOL_SPECS.has(tool);
}
/** Version strings are short; anything longer is a program misbehaving. */
const MAX_VERSION_OUTPUT_LENGTH = 200;
function boundedCommandOutput(standardOutput, standardError) {
    const combined = (standardOutput.trim() || standardError.trim()).split(/\r?\n/)[0] ?? "";
    return combined.slice(0, MAX_VERSION_OUTPUT_LENGTH).trim();
}
