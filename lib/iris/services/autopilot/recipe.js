"use strict";
//
// The install-recipe model — the Windows autopilot's answer to a guide branch.
//
// A recipe is an ordered list of steps, most of them a PowerShell/winget command
// GemAir runs itself, a few of them things only the reader can do (sign in, grant a
// permission). Recipes are data, so the same runner drives every app and a new
// app is a new recipe rather than new code.
//
// This is a pure module (no Node/Electron/Windows APIs) so it runs in the vitest
// suite on any host. It mirrors the Rust reference core that was validated in the
// Tauri prototype, and aligns conceptually with the macOS `IrisGuideStep` model.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRunByIris = isRunByIris;
exports.isDoneOnceOpened = isDoneOnceOpened;
exports.needsTheReader = needsTheReader;
exports.advancesWithoutRunningAnything = advancesWithoutRunningAnything;
exports.totalSteps = totalSteps;
exports.commandForPlatform = commandForPlatform;
exports.workingDirectoryForPlatform = workingDirectoryForPlatform;
exports.cloneStepIndex = cloneStepIndex;
exports.recipeClonesARepo = recipeClonesARepo;
/// GemAir runs this step itself rather than handing it over.
function isRunByIris(kind) {
    return kind === "command";
}
/// Opening it is the entire step, so the autopilot advances with no tap.
function isDoneOnceOpened(kind) {
    return kind === "open";
}
/// Only the reader can finish it: float to it, instruct, and wait — never skip
/// it, because skipping is skipping the sign-in, the permission, the web action,
/// or the paste of a secret GemAir deliberately never types.
function needsTheReader(kind) {
    return (kind === "sign_in" ||
        kind === "permission" ||
        kind === "manual" ||
        kind === "web" ||
        kind === "paste");
}
/// GemAir neither runs a command, opens something, waits for the reader, nor
/// watches for a completion signal — the step is finished the instant it is
/// reached, so the install advances straight past it. This is the Windows answer
/// to macOS's "a guide step with no command succeeds in the drive loop": a prose
/// `noop` step. A `verify` step is NOT here — it is settled by the watch loop
/// (`services/autopilot/watch.ts`), which the runner consults before this
/// predicate. Kept a predicate (not inlined in the runner) so the set of
/// self-completing kinds lives in one place.
function advancesWithoutRunningAnything(kind) {
    return kind === "noop";
}
/// The step count the UI shows as the denominator ("3 of 8").
function totalSteps(recipe) {
    return recipe.steps.length;
}
/// The command to actually run for a step on this host. Windows uses `command`;
/// everywhere else prefers `posixCommand`, falling back to `command` — most steps
/// (git clone, npm ci) are identical across platforms.
function commandForPlatform(step, platform) {
    return platform === "win32" ? step.command : step.posixCommand ?? step.command;
}
/// The folder to put the shell in before running this step on this host, or
/// undefined when the step declares none and should run wherever the shell
/// already is. Same Windows/posix split as `commandForPlatform`, and an empty
/// string is treated as "declares none" so a renderer that fills the field in
/// with `""` cannot turn into a `cd ` with no argument.
function workingDirectoryForPlatform(step, platform) {
    const declared = platform === "win32"
        ? step.workingDirectory
        : step.posixWorkingDirectory ?? step.workingDirectory;
    return declared !== undefined && declared !== "" ? declared : undefined;
}
/// The first step whose command clones the repo. Every step from here on runs
/// somewhere the clone put on disk, so every one of them must say where — the
/// positional rule the web guides are held to (`checkGuideInvariants`), stated
/// once here so the recipe suite can hold the built-in recipes to the same bar.
/// -1 when the recipe clones nothing.
function cloneStepIndex(recipe) {
    return recipe.steps.findIndex((step) => (step.command?.includes("git clone") ?? false) ||
        (step.posixCommand?.includes("git clone") ?? false));
}
/// Whether running this recipe clones a source repo — the same test macOS's
/// `recordInstallProvenance` makes (`steps contains a "git clone" command`) to
/// tell a guide-source build, which maintain mode MAY patch, from a signed
/// download, which it never may. Checks both the Windows and the posix command
/// of every step so the answer does not depend on which host the recipe is
/// being examined on.
function recipeClonesARepo(recipe) {
    return recipe.steps.some((step) => (step.command?.includes("git clone") ?? false) || (step.posixCommand?.includes("git clone") ?? false));
}
