"use strict";
//
// The setup-recovery detour and the missing-tool self-heal helpers — the Windows
// port of macOS's `enterSetupRecoveryIfAPrerequisiteIsMissing`
// (GuideSessionController.swift) and
// `installTheMissingToolTheGuideInstallsItself` (GuideAutopilotRunner.swift).
//
// Two related jobs, one module because they share the same idea — a recipe both
// declares the tools it needs and carries the steps that install them, so a
// missing tool is never a dead end:
//
//   1. BEFORE the recipe's first step, check the prerequisites the recipe checks
//      but does not itself install (git, node). Anything missing is either
//      installed by winget (under the autonomy grant) or the reader is sent to
//      the tool's download page, and GemAir polls until the tool appears and then
//      carries on — no "I did it" tap, mirroring the macOS re-check.
//
//   2. MID-recipe, a command that dies because a program is not on the PATH is
//      matched against the recipe's OWN earlier install step for that program;
//      the runner re-runs that step once and retries, before any model ladder.
//
// This module is pure (no Node/Electron/Windows APIs). Tool probing and the wall
// clock are injected seams, so the whole flow is driven by fakes in the vitest
// suite on any host. The real seams live in `main/setup-detour-host.ts`.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREREQUISITE_POLL_DEADLINE_MS = exports.PREREQUISITE_POLL_INTERVAL_MS = void 0;
exports.firstProgramToken = firstProgramToken;
exports.programsEachLineWouldRun = programsEachLineWouldRun;
exports.prerequisitesFor = prerequisitesFor;
exports.recipeInstallStepForTool = recipeInstallStepForTool;
exports.wingetInstallCommand = wingetInstallCommand;
exports.wingetInstallDecision = wingetInstallDecision;
exports.runSetupDetour = runSetupDetour;
exports.isCommandNotFound = isCommandNotFound;
exports.selfHealStepForFailure = selfHealStepForFailure;
const recipe_1 = require("./recipe");
const risk_1 = require("./risk");
const shell_1 = require("./shell");
/// How often GemAir re-checks for a tool while the reader installs it (ms). Short
/// enough that a finished install is picked up promptly, long enough not to spin.
exports.PREREQUISITE_POLL_INTERVAL_MS = 3_000;
/// How long GemAir waits for a prerequisite to appear before it gives up and hands
/// the reader the wheel (ms). Fifteen minutes covers a slow download + installer
/// without waiting forever on an install that was abandoned.
exports.PREREQUISITE_POLL_DEADLINE_MS = 15 * 60 * 1_000;
/// How to obtain each prerequisite GemAir can heal. Deliberately just git and node
/// — the two tools every source-build recipe checks and none of them install
/// (pnpm/rust/uv are installed by their own recipe steps, so a missing one of
/// those is the self-heal's job, not the detour's).
const PREREQUISITE_CATALOG = new Map([
    ["git", { downloadHref: "https://git-scm.com/download/win", wingetId: "Git.Git" }],
    ["node", { downloadHref: "https://nodejs.org/en/download", wingetId: "OpenJS.NodeJS.LTS" }],
]);
/// The first program a command line would run, normalized to the bare tool name:
/// the first whitespace-delimited token, unquoted, with a `.cmd`/`.exe`/`.bat`
/// suffix and any path prefix stripped, lowercased. `"npm.cmd install -g pnpm"`
/// → `"npm"`, `"git --version"` → `"git"`. Used both to tell a recipe's verify
/// steps from its install steps and to name the tool a failed command reached
/// for. Mirrors the leading half of macOS `programsEachLineWouldRun`.
function firstProgramToken(command) {
    const firstToken = command.trim().split(/\s+/)[0] ?? "";
    const unquoted = firstToken.replace(/^["']|["']$/g, "");
    const bareName = unquoted.split(/[\\/]/).pop() ?? unquoted;
    return bareName.replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
}
/// The bare tool name every LINE of a command would run first — the full macOS
/// `programsEachLineWouldRun`, not just the leading token. A guide's check step
/// is often multi-line (`git --version\nnode --version`), and a tool it runs on
/// ANY line cannot be a tool that same step installs. Splitting on both newlines
/// and PowerShell/POSIX statement separators (`;`, `&&`, `|`) keeps the rule
/// honest for a `winget … ; refreshenv`-style line.
function programsEachLineWouldRun(command) {
    const programs = new Set();
    for (const line of command.split(/\r?\n|;|&&|\|/)) {
        const trimmed = line.trim();
        if (trimmed === "")
            continue;
        programs.add(firstProgramToken(trimmed));
    }
    return programs;
}
/// Whether a step verifies a tool rather than installing it — a `command` step
/// whose `tool_version` check names the same tool its command runs first
/// (`git --version` checks git and runs git). The setup detour treats these as
/// the prerequisites: the tool has to be there already, because the step does
/// not put it there.
function stepVerifiesTool(step, platform) {
    if (step.kind !== "command" || step.check?.type !== "tool_version")
        return undefined;
    const command = (0, recipe_1.commandForPlatform)(step, platform);
    if (command === undefined)
        return undefined;
    return programsEachLineWouldRun(command).has(step.check.tool) ? step.check.tool : undefined;
}
/// Every tool a step INSTALLS rather than verifies — the tools it names as a
/// completion signal (its `tool_version` check AND every `toolVersion` in its
/// `watch.expect`) that its own command does NOT run on any line
/// (`npm.cmd install -g pnpm` watches pnpm but runs npm ⇒ installs pnpm;
/// `git --version\nnode --version` watches git+node and runs both ⇒ installs
/// neither). This is the crux of the self-heal: real guides carry the install
/// signal in `watch.expect`, not `check`, so consulting only `check` (the old
/// behaviour) left the self-heal inert for every guide-derived recipe. Mirrors
/// macOS `commandsThisGuidePublishesToInstallEachToolItWatchesFor`, which scans
/// every step's watch expectations, plus its "a command that begins by running
/// the tool cannot install it" guard.
function toolsInstalledByStep(step, platform) {
    if (step.kind !== "command")
        return [];
    const command = (0, recipe_1.commandForPlatform)(step, platform);
    if (command === undefined)
        return [];
    const programsRun = programsEachLineWouldRun(command);
    const named = new Set();
    if (step.check?.type === "tool_version")
        named.add(step.check.tool);
    for (const expectation of step.watch?.expect ?? []) {
        if (expectation.type === "toolVersion")
            named.add(expectation.tool);
    }
    return [...named].filter((tool) => !programsRun.has(tool));
}
/// Resolves one prerequisite tool name (with an optional download page and
/// install command the guide named for it) into a `PrerequisiteTool` the detour
/// can act on, filling in the winget id and a fallback download page from the
/// built-in catalog. Returns undefined only when there is genuinely no way to
/// obtain the tool — no winget id, no page, no command — so the detour never
/// lists a prerequisite it cannot heal.
function prerequisiteToolFor(tool, hrefFromGuide, installCommand) {
    const known = PREREQUISITE_CATALOG.get(tool);
    const downloadHref = hrefFromGuide ?? known?.downloadHref ?? "";
    const wingetId = known?.wingetId;
    if (downloadHref === "" && wingetId === undefined && installCommand === undefined) {
        return undefined;
    }
    return {
        tool,
        downloadHref,
        ...(wingetId !== undefined ? { wingetId } : {}),
        ...(installCommand !== undefined ? { installCommand } : {}),
    };
}
/// The prerequisites this recipe requires but does not install — the tools it
/// needs on PATH before its first step can run, and that GemAir knows how to fetch
/// (git, node). Two sources, because a recipe declares them two ways:
///
///   - A guide-derived recipe carries them in `recipe.prerequisites`, mapped
///     from the guide branch's `setupSteps` (this is where every real published
///     guide puts git/node). Reading ONLY the step-based source below left the
///     detour inert for all 16 guide-derived apps — the bug this fixes.
///   - A hand-authored built-in recipe embeds them as ordinary `command` steps
///     whose `tool_version` check names the tool the command runs (`git
///     --version` checks and runs git), which `stepVerifiesTool` recognises.
///
/// Order preserved (prerequisites first, then step-declared), de-duplicated by
/// tool name. Mirrors macOS `prerequisiteToolNames(declaredBy:)`, which reads
/// `branch.setupSteps` directly.
function prerequisitesFor(recipe, platform) {
    const seen = new Set();
    const prerequisites = [];
    const consider = (tool, hrefFromGuide, installCommand) => {
        if (seen.has(tool))
            return;
        const resolved = prerequisiteToolFor(tool, hrefFromGuide, installCommand);
        if (resolved === undefined)
            return;
        seen.add(tool);
        prerequisites.push(resolved);
    };
    // The guide-derived source: the branch's setupSteps, carried onto the recipe.
    for (const prerequisite of recipe.prerequisites ?? []) {
        if (prerequisite.tool !== undefined) {
            consider(prerequisite.tool, prerequisite.href, prerequisite.command);
        }
    }
    // The hand-authored source: `tool_version` check steps that verify a tool.
    for (const step of recipe.steps) {
        const tool = stepVerifiesTool(step, platform);
        if (tool !== undefined)
            consider(tool, undefined, undefined);
    }
    return prerequisites;
}
/// The recipe's own command for installing `tool`, drawn from an earlier install
/// step (index strictly before `beforeIndex`). Undefined when the recipe has no
/// such step — the situation where the self-heal steps aside and the ordinary
/// failure path (or, later, the model ladder) takes over. Mirrors macOS
/// `theGuidesOwnInstallCommandForAToolThisCommandRuns`.
function recipeInstallStepForTool(recipe, tool, beforeIndex, platform) {
    for (let index = 0; index < beforeIndex && index < recipe.steps.length; index += 1) {
        const step = recipe.steps[index];
        if (toolsInstalledByStep(step, platform).includes(tool))
            return step;
    }
    return undefined;
}
/// The winget line GemAir runs to install a prerequisite through the fast path.
/// The agreement flags stop it pausing for a source/package prompt;
/// `--disable-interactivity` forbids the installer's OWN interactive prompts, so
/// this fully-unattended detour install (run before the recipe's first step,
/// with no one to answer a dialog) FAILS FAST and falls back to the download
/// page rather than hanging on input nobody will supply. It deliberately does
/// NOT force `--scope user`: git and node ship machine-scope manifests, and
/// pinning user scope would make winget error "no applicable installer" and
/// break the detour outright — an OS-level UAC elevation prompt is a separate
/// hazard winget cannot suppress without admin, and the timeout path now reaps
/// the whole process tree (`PowerShellSession` deadline → `killTree`).
function wingetInstallCommand(wingetId) {
    return `winget install --id ${wingetId} -e --accept-source-agreements --accept-package-agreements --disable-interactivity`;
}
/// Runs a prerequisite's winget install through the risk gate and reports how the
/// detour should treat it. The autonomy grant is the pivot: WITH it, the install
/// runs hands-off (`auto`); WITHOUT it, installing software is exactly the kind of
/// action that should wait for one deliberate tap, so it is reported as
/// `needs_confirm` — and since the pre-flight detour has no per-step confirm UI,
/// the caller then routes to the manual download page instead. The catastrophe
/// floor is consulted first and still gets the last word (a hallucinated
/// destructive argument is refused even under the grant), which is why this asks
/// the risk gate rather than reading `autonomyGranted` alone.
function wingetInstallDecision(command, autonomyGranted) {
    if ((0, risk_1.assess)(command, "vetted_recipe", autonomyGranted).tier === "refused_outright") {
        return "refused";
    }
    return autonomyGranted ? "auto" : "needs_confirm";
}
/// Runs the setup-recovery detour for a recipe, before its first step.
///
/// Checks every prerequisite the recipe declares; if all are present it returns
/// `ready` having emitted nothing. Otherwise it emits one `setupDetour` event
/// listing what is missing, then for each missing tool tries the winget fast
/// path (under the grant) and falls back to opening the download page, polling
/// `tool-versions` until the tool appears — no reader tap — or the deadline
/// passes, at which point it surfaces.
async function runSetupDetour(recipe, shell, deps) {
    const prerequisites = prerequisitesFor(recipe, deps.platform);
    if (prerequisites.length === 0)
        return { kind: "ready" };
    if (deps.shouldCancel?.())
        return { kind: "cancelled" };
    // Only a prerequisite the probe positively reports ABSENT counts as missing.
    // A `couldNotBeChecked` (a probe that timed out or failed to spawn) is left
    // alone: GemAir does not know it is missing, so it does not divert the reader
    // into installing something they may already have.
    const missing = [];
    for (const prerequisite of prerequisites) {
        if ((await deps.probe.probe(prerequisite.tool)) === "notInstalled")
            missing.push(prerequisite);
    }
    if (missing.length === 0)
        return { kind: "ready" };
    deps.emit({
        type: "setupDetour",
        missing: missing.map((tool) => ({ tool: tool.tool, downloadHref: tool.downloadHref })),
    });
    const wingetAvailable = await deps.probe.isWingetAvailable();
    for (const prerequisite of missing) {
        if (deps.shouldCancel?.())
            return { kind: "cancelled" };
        const resolved = await resolveOnePrerequisite(prerequisite, wingetAvailable, shell, deps);
        if (resolved.kind === "surfaced" || resolved.kind === "cancelled")
            return resolved;
    }
    return { kind: "ready" };
}
async function resolveOnePrerequisite(prerequisite, wingetAvailable, shell, deps) {
    // The guide's OWN install command first, when its setup step named one, then
    // the winget fast path. Either only runs under the grant, and a run that the
    // tool probe then confirms ends this prerequisite with no download page.
    const installCommands = [];
    if (prerequisite.installCommand !== undefined)
        installCommands.push(prerequisite.installCommand);
    if (wingetAvailable && prerequisite.wingetId !== undefined) {
        installCommands.push(wingetInstallCommand(prerequisite.wingetId));
    }
    for (const command of installCommands) {
        if (deps.shouldCancel?.())
            return { kind: "cancelled" };
        if (wingetInstallDecision(command, deps.autonomyGranted) !== "auto")
            continue;
        const approved = (0, risk_1.approve)(command, "vetted_recipe", deps.autonomyGranted);
        if (approved === undefined)
            continue;
        deps.emit({ type: "commandStarted", text: command, friendlyLabel: "Installing a tool it needs…" });
        const outcome = await shell.run(approved, shell_1.DEFAULT_COMMAND_TIMEOUT_MS);
        deps.emit({
            type: "commandFinished",
            exitCode: outcome.kind === "succeeded" ? 0 : outcome.kind === "failed" ? outcome.exitCode : 1,
            output: outcome.kind === "succeeded" || outcome.kind === "failed" ? outcome.output : "",
        });
        if (deps.shouldCancel?.())
            return { kind: "cancelled" };
        // Even a clean install may not be visible until the PATH is re-read; the
        // probe does that itself, so a confirming check is enough. Only a positive
        // "installed" ends the prerequisite — a probe that could not be run does not.
        if (outcome.kind === "succeeded" && (await deps.probe.probe(prerequisite.tool)) === "installed") {
            return { kind: "ready" };
        }
    }
    // Manual fallback: open the download page and wait for the tool to appear.
    // With no page to send the reader to, there is nothing left to try but to hand
    // the wheel back with a clear reason.
    if (deps.shouldCancel?.())
        return { kind: "cancelled" };
    if (prerequisite.downloadHref === "") {
        return {
            kind: "surfaced",
            reason: `GemAir couldn't install ${prerequisite.tool} for you and has no download page for it. ` +
                `Install it yourself, then start the install again.`,
        };
    }
    deps.emit({ type: "openRequested", href: prerequisite.downloadHref });
    const appeared = await pollUntilInstalled(prerequisite.tool, deps);
    if (appeared === "cancelled")
        return { kind: "cancelled" };
    return appeared === "installed"
        ? { kind: "ready" }
        : {
            kind: "surfaced",
            reason: `GemAir waited for ${prerequisite.tool} to be installed but it didn't show up. ` +
                `Install it from ${prerequisite.downloadHref}, then start the install again.`,
        };
}
async function pollUntilInstalled(tool, deps) {
    const startedAt = deps.clock.now();
    for (;;) {
        if (deps.shouldCancel?.())
            return "cancelled";
        if ((await deps.probe.probe(tool)) === "installed")
            return "installed";
        if (deps.clock.now() - startedAt >= exports.PREREQUISITE_POLL_DEADLINE_MS)
            return "timedOut";
        await deps.clock.sleep(exports.PREREQUISITE_POLL_INTERVAL_MS);
        // One more check after the last sleep so a tool that appears right at the
        // deadline is still caught rather than reported missing.
        if (deps.clock.now() - startedAt >= exports.PREREQUISITE_POLL_DEADLINE_MS) {
            if (deps.shouldCancel?.())
                return "cancelled";
            return (await deps.probe.probe(tool)) === "installed" ? "installed" : "timedOut";
        }
    }
}
/// Whether a failed command's outcome is the "program not on the PATH" shape —
/// the Windows analog of exit 127. PowerShell reports a `CommandNotFoundException`
/// as a generic non-zero exit with a distinctive message rather than code 127, so
/// the text is matched too; a POSIX login shell (GemAir on a Mac) does exit 127.
function isCommandNotFound(exitCode, output) {
    if (exitCode === 127)
        return true;
    return /is not recognized as (?:the name of a cmdlet|an internal or external command)|command not found|CommandNotFoundException/i.test(output);
}
/// The self-heal decision for a failed command: the recipe's own earlier step
/// that installs the tool the command reached for, or undefined when this is not
/// a missing-tool failure the recipe can fix itself. `currentIndex` is the step
/// that just failed, so only steps strictly before it count as its prerequisite
/// install. Mirrors macOS `installTheMissingToolTheGuideInstallsItself`'s guard.
function selfHealStepForFailure(recipe, currentIndex, failedCommand, exitCode, output, platform) {
    if (!isCommandNotFound(exitCode, output))
        return undefined;
    const missingTool = firstProgramToken(failedCommand);
    return recipeInstallStepForTool(recipe, missingTool, currentIndex, platform);
}
