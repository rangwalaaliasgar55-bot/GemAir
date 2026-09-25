"use strict";
//
// The watch-expectation executor — the Windows port of the macOS adaptive
// `WatchLoop` (`iris-macos/leanring-buddy/WatchLoop.swift` + `WatchVisualCheck.swift`),
// scoped to what the autopilot runner needs: given a step's `watch` block, block
// until one of its expectations verifies, then let the step advance on its own.
//
// It is the piece that makes a `verify` step (and a reader step that carries a
// watch) settle without the reader tapping "done". macOS runs this on a 2-second
// timer; the Windows autopilot is a *pumped* state machine, so this is an
// awaitable executor the runner calls inline and awaits — bounded, so it always
// returns (verified, or timed out and handed back to the reader).
//
// THE LADDER, cheapest-first (matching the porting spec's stated order for
// Windows). Every poll evaluates the step's expectations in this order and stops
// at the first that verifies, so the expensive rungs are never reached once a
// cheap one settles the step:
//
//   0. toolVersion  — a tool is on PATH (`services/tool-versions.ts`). Free-ish.
//   1. foregroundApp — the app is in front (PowerShell `GetForegroundWindow` →
//      process name, the seam `services/maintain/app-inventory.ts` already owns).
//   2. urlHost      — the frontmost browser tab's host (PowerShell UI Automation
//      of the address bar, with a window-title fallback — see below).
//   3. axElement    — a UI Automation element on the foreground window.
//   4. visual       — a screenshot judged by a model. Budgeted (≤ 8 per step,
//      ≥ 10 s apart) and NEVER taken for a `sensitive` watch.
//
// PURITY / TESTABILITY. Every OS call — every PowerShell spawn, the screenshot,
// the model call, the clock, the delay between polls — is an injected seam with a
// real default, exactly the convention `app-inventory.ts` uses. So the whole
// executor runs in the vitest suite on this Mac with faked seams, and the real
// seams only do anything meaningful on Windows.
//
// PRIVACY. A `sensitive` watch is never captured: the visual rung is skipped
// outright, and the step settles from the pixel-free side signals or is handed
// back. The screenshot the visual rung does take exists only as the argument of
// the one model call it is passed to — this module never stores it.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.WatchStepExecutor = exports.ABSOLUTE_MAXIMUM_POLLS = exports.DEFAULT_MAXIMUM_POLLS = exports.MILLISECONDS_BETWEEN_POLLS = exports.MINIMUM_SECONDS_BETWEEN_VISUAL_CHECKS = exports.MAXIMUM_VISUAL_CHECKS_PER_STEP = exports.MINIMUM_HAMMING_DISTANCE_THAT_COUNTS = exports.VISUAL_STUCK_ANSWER_PREFIX = exports.VISUAL_NOT_YET_ANSWER = exports.VISUAL_COMPLETED_ANSWER = void 0;
exports.visualCheckSystemPrompt = visualCheckSystemPrompt;
exports.visualCheckUserPrompt = visualCheckUserPrompt;
exports.verdictFromVisualModelAnswer = verdictFromVisualModelAnswer;
exports.orderExpectationsCheapestFirst = orderExpectationsCheapestFirst;
exports.windowsExecutableForForegroundIdentity = windowsExecutableForForegroundIdentity;
exports.foregroundProcessSatisfiesIdentity = foregroundProcessSatisfiesIdentity;
exports.hostMatchesExpectedHost = hostMatchesExpectedHost;
exports.hostFromAddressBarText = hostFromAddressBarText;
exports.buildActiveBrowserUrlCommand = buildActiveBrowserUrlCommand;
exports.parseActiveBrowserUrlOutput = parseActiveBrowserUrlOutput;
exports.buildAxElementQueryCommand = buildAxElementQueryCommand;
exports.parseAxElementPresenceOutput = parseAxElementPresenceOutput;
exports.hammingDistanceBetweenFingerprints = hammingDistanceBetweenFingerprints;
exports.defaultWatchSeams = defaultWatchSeams;
exports.defaultWatchExecutor = defaultWatchExecutor;
const node_child_process_1 = require("node:child_process");
const app_inventory_1 = require("../maintain/app-inventory");
const tool_versions_1 = require("../tool-versions");
exports.VISUAL_COMPLETED_ANSWER = "COMPLETED";
exports.VISUAL_NOT_YET_ANSWER = "NOT_YET";
exports.VISUAL_STUCK_ANSWER_PREFIX = "STUCK:";
/// The system prompt for the visual check, ported line-for-line from
/// `WatchVisualCheck.systemPrompt` so the Windows loop judges a step against the
/// same words the macOS loop does.
function visualCheckSystemPrompt(hintsTheStepAuthorWrote) {
    let systemPrompt = "You are helping somebody follow an install guide on their own computer. " +
        "You are shown one screenshot and asked whether the current step is done.\n\n" +
        "Answer with exactly one line and nothing else:\n" +
        `${exports.VISUAL_COMPLETED_ANSWER} — the step is visibly finished.\n` +
        `${exports.VISUAL_NOT_YET_ANSWER} — the step is not finished, and nothing looks wrong.\n` +
        `${exports.VISUAL_STUCK_ANSWER_PREFIX} <one short sentence> — the step is not finished AND ` +
        "something on screen suggests they have gone off the rails: an error, a " +
        "dialog they did not expect, or the wrong window in front.\n\n" +
        `Prefer ${exports.VISUAL_NOT_YET_ANSWER} when you are unsure. Saying a step is done when it ` +
        "is not sends somebody on to a step that cannot work.\n\n" +
        "The screenshot is usually the reader's whole screen. If you can see more " +
        "than one window, judge only the one the question names: another window " +
        "being busy, idle or full of errors is not evidence about this step. A dialog " +
        "or alert sitting on top of the reader's work is the one thing worth looking " +
        `away for, and is worth a ${exports.VISUAL_STUCK_ANSWER_PREFIX} answer.\n\n` +
        "When the question names a command, it is there to catch exactly one " +
        "mistake and nothing else. Guides run several commands in a row, so if the " +
        "window plainly shows a different command as the most recent thing run, with " +
        "its own output beneath it and no sign of the named one, this step has not " +
        `started — answer ${exports.VISUAL_NOT_YET_ANSWER}.\n\n` +
        "In every other case ignore the command and answer the question exactly as " +
        "it is asked. Terminals scroll, so a long install pushes its own command off " +
        "the top of the window; that is normal and means nothing. Do not talk " +
        "yourself out of evidence you can actually see.";
    if (hintsTheStepAuthorWrote.length > 0) {
        systemPrompt += "\n\nThe guide's author suggested these hints for somebody who is stuck:\n";
        for (const hint of hintsTheStepAuthorWrote) {
            systemPrompt += `- ${hint}\n`;
        }
    }
    return systemPrompt;
}
/// The user prompt for the visual check, ported from `WatchVisualCheck.userPrompt`.
function visualCheckUserPrompt(options) {
    const context = options.context ?? {};
    let userPrompt = `The step is titled "${options.stepTitle}".`;
    const describesAWindow = (context.frontmostApplicationName?.length ?? 0) > 0 ||
        (context.focusedWindowTitle?.length ?? 0) > 0;
    if (describesAWindow) {
        userPrompt += "\n\nJudge this window and ignore every other window on the screen:";
        if (context.frontmostApplicationName && context.frontmostApplicationName.length > 0) {
            userPrompt += `\n- Application: ${context.frontmostApplicationName}`;
        }
        if (context.focusedWindowTitle && context.focusedWindowTitle.length > 0) {
            userPrompt += `\n- Window title: ${context.focusedWindowTitle}`;
        }
    }
    if (context.commandTheStepAsksFor && context.commandTheStepAsksFor.length > 0) {
        userPrompt +=
            "\n\nThis step asked the reader to run this command:\n" +
                `${context.commandTheStepAsksFor}\n\n` +
                "If a different command is plainly the most recent thing run, this step " +
                "has not started. Otherwise answer the question as asked.";
    }
    userPrompt += `\n\nThe question to answer about the screenshot is: ${options.visualPrompt}`;
    return userPrompt;
}
/// Reads the one-line answer back. Anything unrecognized is `undefined` — "the
/// loop learned nothing" — which must never collapse into `notYet`. Ported from
/// `WatchVisualCheck.verdict(fromModelAnswer:)`.
function verdictFromVisualModelAnswer(modelAnswer, hintsTheStepAuthorWrote) {
    const firstLine = (modelAnswer.split("\n")[0] ?? "").trim();
    const normalized = firstLine.toUpperCase();
    if (normalized.startsWith(exports.VISUAL_STUCK_ANSWER_PREFIX)) {
        const hintFromTheModel = firstLine.slice(exports.VISUAL_STUCK_ANSWER_PREFIX.length).trim();
        if (hintFromTheModel.length > 0) {
            return { kind: "userStuck", hint: hintFromTheModel };
        }
        // A stuck verdict with no hint is useless, so the author's own first hint
        // stands in rather than an empty banner.
        const authoredHint = hintsTheStepAuthorWrote[0];
        return authoredHint !== undefined ? { kind: "userStuck", hint: authoredHint } : { kind: "notYet" };
    }
    if (normalized.startsWith(exports.VISUAL_COMPLETED_ANSWER)) {
        return { kind: "completed" };
    }
    if (normalized.startsWith(exports.VISUAL_NOT_YET_ANSWER) || normalized.startsWith("NOT YET")) {
        return { kind: "notYet" };
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Cheapest-first ordering.
// ---------------------------------------------------------------------------
/// The relative cost of confirming each expectation, cheapest first. The
/// executor evaluates a step's expectations in this order and stops at the first
/// that verifies, so a step that a tool-version check settles never spends a
/// model call.
const EXPECTATION_COST_RANK = {
    toolVersion: 0,
    foregroundApp: 1,
    urlHost: 2,
    axElement: 3,
    visual: 4,
};
/// Orders a step's expectations cheapest-first without mutating the input. A
/// stable sort by cost rank, so two expectations of the same type keep their
/// authored order.
function orderExpectationsCheapestFirst(expectations) {
    return expectations
        .map((expectation, indexInAuthoredOrder) => ({ expectation, indexInAuthoredOrder }))
        .sort((left, right) => {
        const rankDifference = EXPECTATION_COST_RANK[left.expectation.type] - EXPECTATION_COST_RANK[right.expectation.type];
        return rankDifference !== 0 ? rankDifference : left.indexInAuthoredOrder - right.indexInAuthoredOrder;
    })
        .map((entry) => entry.expectation);
}
// ---------------------------------------------------------------------------
// foregroundApp: mapping the guide's identity to a Windows executable name.
// ---------------------------------------------------------------------------
/// The reviewed map from a guide's foreground identity (a macOS bundle id) to
/// the Windows executable name, for catalog apps whose Windows exe has been
/// established. It exists for the same reason `WINDOWS_CATALOG_APPS` does:
/// `/api/iris/apps` carries a `macBundleId` and nothing that names a Windows
/// `.exe`, so a guide written with a `foregroundApp` bundle id has to be mapped
/// by hand to the exe a foreground read reports. Only entries verified against a
/// real build appear here; an unknown identity is simply not matched, which is
/// the honest answer. Keyed by lowercased bundle id.
const FOREGROUND_BUNDLE_ID_TO_WINDOWS_EXE = {
    // Only entries verified against a real build appear here. Ollama is the one
    // catalog app GemAir installs that has a verified Windows exe name (see
    // `WINDOWS_CATALOG_APPS`), so its macOS bundle identity maps to that exe.
    "com.electron.ollama": "ollama app.exe",
    "ai.ollama.ollama": "ollama app.exe",
    // VS Code, for a guide step that asks the reader to bring the editor forward.
    "com.microsoft.vscode": "code.exe",
};
/// Normalizes an exe-shaped name to lowercase and strips one trailing `.exe`, so
/// `"publikclip-app.exe"`, `"publikclip-app"`, and `"PUBLIKCLIP-APP.EXE"` all
/// compare equal — a foreground read may report either shape and neither is
/// case-authoritative on Windows. Mirrors `app-inventory.ts`'s private
/// `normalizeExeName`.
function normalizeExecutableName(name) {
    const lowered = name.trim().toLowerCase();
    return lowered.endsWith(".exe") ? lowered.slice(0, -".exe".length) : lowered;
}
/// The Windows executable name a `foregroundApp` expectation's identity resolves
/// to, or `undefined` when GemAir cannot map it. An identity that already looks
/// like an exe is taken as-is; a known bundle id is mapped through the reviewed
/// table; a slug that names a reviewed catalog app uses that app's exe. Pure and
/// directly tested.
function windowsExecutableForForegroundIdentity(identity) {
    const trimmedIdentity = identity.trim();
    if (trimmedIdentity.length === 0)
        return undefined;
    if (trimmedIdentity.toLowerCase().endsWith(".exe")) {
        return normalizeExecutableName(trimmedIdentity);
    }
    const mappedExe = FOREGROUND_BUNDLE_ID_TO_WINDOWS_EXE[trimmedIdentity.toLowerCase()];
    if (mappedExe !== undefined) {
        return normalizeExecutableName(mappedExe);
    }
    const catalogAppForSlug = app_inventory_1.WINDOWS_CATALOG_APPS.find((app) => app.slug === trimmedIdentity);
    if (catalogAppForSlug !== undefined) {
        return normalizeExecutableName(catalogAppForSlug.exeName);
    }
    return undefined;
}
/// Whether a foreground process (as a read reports it) satisfies a
/// `foregroundApp` expectation. Case-insensitive and `.exe`-suffix tolerant.
function foregroundProcessSatisfiesIdentity(foregroundProcessName, expectedIdentity) {
    const expectedExecutable = windowsExecutableForForegroundIdentity(expectedIdentity);
    if (expectedExecutable === undefined)
        return false;
    return normalizeExecutableName(foregroundProcessName) === expectedExecutable;
}
// ---------------------------------------------------------------------------
// urlHost: matching, and the PowerShell that reads the address bar.
// ---------------------------------------------------------------------------
/// `console.anthropic.com` matches itself and any subdomain of itself, and
/// nothing else. A plain suffix test would let `evilconsole.anthropic.com`
/// through, exactly the match a signal like this must never make. Ported from
/// `WatchLoop.host(_:matchesExpectedHost:)`.
function hostMatchesExpectedHost(actualHost, expectedHost) {
    if (actualHost === undefined)
        return false;
    const normalizedActualHost = actualHost.trim().toLowerCase();
    const normalizedExpectedHost = expectedHost.trim().toLowerCase();
    if (normalizedActualHost.length === 0 || normalizedExpectedHost.length === 0)
        return false;
    if (normalizedActualHost === normalizedExpectedHost)
        return true;
    return normalizedActualHost.endsWith(`.${normalizedExpectedHost}`);
}
/// Pulls the host out of whatever the address-bar read returned — a full URL, a
/// bare host, or a host with a path. Returns `undefined` for anything with no
/// readable host. Pure and directly tested; used by both the real seam's parse
/// and the window-title fallback.
function hostFromAddressBarText(addressBarText) {
    const trimmed = addressBarText.trim();
    if (trimmed.length === 0)
        return undefined;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const host = new URL(withScheme).hostname.toLowerCase();
        return host.length > 0 ? host : undefined;
    }
    catch {
        return undefined;
    }
}
/// The PowerShell that reads the frontmost browser window's address-bar value
/// over UI Automation. It finds the foreground window, then the first Edit/Text
/// automation element whose name looks like an address bar (Chrome/Edge label
/// their omnibox "Address and search bar"; Firefox uses "Search with … or enter
/// address"), and prints its `ValuePattern` value on one line.
///
/// UI Automation genuinely reads the live tab URL, which the window title cannot
/// — so this is the accurate path and the title heuristic below is only the
/// fallback. Exported and pure so a test can assert the command without spawning.
function buildActiveBrowserUrlCommand() {
    return [
        "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes;",
        "Add-Type -Namespace IrisFg -Name Win -MemberDefinition '",
        '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' + "' ;",
        "$h = [IrisFg.Win]::GetForegroundWindow();",
        "if ($h -ne [System.IntPtr]::Zero) {",
        "  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h);",
        "  if ($root) {",
        "    $editCondition = New-Object System.Windows.Automation.PropertyCondition(",
        "      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,",
        "      [System.Windows.Automation.ControlType]::Edit);",
        "    $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition);",
        "    foreach ($edit in $edits) {",
        "      $name = $edit.Current.Name;",
        '      if ($name -match "address" -or $name -match "search or enter" -or $name -match "enter address") {',
        "        $valuePattern = $null;",
        "        if ($edit.TryGetCurrentPattern(",
        "          [System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {",
        '          Write-Output ("URL|" + $valuePattern.Current.Value); break;',
        "        }",
        "      }",
        "    }",
        "  }",
        "}",
    ].join(" ");
}
/// Parses `buildActiveBrowserUrlCommand`'s stdout — the last `URL|<value>` line
/// — into a host, or `undefined` when it read nothing. Pure and directly tested.
function parseActiveBrowserUrlOutput(stdout) {
    const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("URL|"));
    const lastLine = lines[lines.length - 1];
    if (lastLine === undefined)
        return undefined;
    return hostFromAddressBarText(lastLine.slice("URL|".length));
}
// ---------------------------------------------------------------------------
// axElement: the PowerShell that searches the foreground window's UIA tree.
// ---------------------------------------------------------------------------
/// The PowerShell that searches the foreground window's UI Automation tree for
/// an element whose Name (or LocalizedControlType) contains `roleLabel`, and
/// prints `AX|1` when one is present. The label is passed as a here-string
/// literal and only ever compared with `-like`, never interpolated into code, so
/// a guide's `roleLabel` cannot become a command. Exported and pure so a test
/// can assert the command without spawning.
function buildAxElementQueryCommand(roleLabel) {
    // Single-quote-escape the label for a PowerShell single-quoted string literal
    // (double any embedded single quote), so it is data, never code.
    const escapedRoleLabel = roleLabel.replace(/'/g, "''");
    return [
        "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes;",
        "Add-Type -Namespace IrisFg -Name Win -MemberDefinition '",
        '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' + "' ;",
        `$needle = '${escapedRoleLabel}';`,
        "$h = [IrisFg.Win]::GetForegroundWindow();",
        "if ($h -ne [System.IntPtr]::Zero) {",
        "  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h);",
        "  if ($root) {",
        "    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,",
        "      [System.Windows.Automation.Condition]::TrueCondition);",
        "    foreach ($element in $all) {",
        "      $name = $element.Current.Name;",
        "      $type = $element.Current.LocalizedControlType;",
        '      if ($name -like ("*" + $needle + "*") -or $type -like ("*" + $needle + "*")) {',
        '        Write-Output "AX|1"; break;',
        "      }",
        "    }",
        "  }",
        "}",
    ].join(" ");
}
/// Whether `buildAxElementQueryCommand`'s stdout reported a match. Pure.
function parseAxElementPresenceOutput(stdout) {
    return stdout
        .split(/\r?\n/)
        .some((line) => line.trim() === "AX|1");
}
// ---------------------------------------------------------------------------
// The perceptual-diff rung (rung 2): "free unless the screen changed".
// ---------------------------------------------------------------------------
/// How many bits of a 64-bit difference hash must flip before a frame counts as
/// a meaningful change, ported verbatim from
/// `WatchLoop.minimumHammingDistanceThatCountsAsAMeaningfulChange`. A blinking
/// caret or a ticking clock moves one or two bits; opening a window or a terminal
/// filling with output moves far more than five.
exports.MINIMUM_HAMMING_DISTANCE_THAT_COUNTS = 5;
/// The Hamming distance between two 64-bit difference hashes — the count of bits
/// that differ. Pure and directly tested; the macOS analog is
/// `PerceptualFrameHash.hammingDistance`.
function hammingDistanceBetweenFingerprints(left, right) {
    // Non-negative fingerprints in practice; the mask keeps the XOR well-defined
    // even if a seam ever handed back a wider or signed value.
    let differingBits = (left ^ right) & 0xffffffffffffffffn;
    let count = 0;
    while (differingBits > 0n) {
        count += Number(differingBits & 1n);
        differingBits >>= 1n;
    }
    return count;
}
const DEFAULT_POWERSHELL_READ_TIMEOUT_MS = 4000;
/// Runs one PowerShell command and resolves its stdout, or "" on any failure (no
/// PowerShell, a blocked child, a timeout). Never throws — a signal that cannot
/// be read is "not verified", never an error that stops the loop. Mirrors
/// `app-inventory.ts`'s `readForegroundProcessViaPowerShell` plumbing.
function runPowerShellForStdout(command, timeoutMilliseconds = DEFAULT_POWERSHELL_READ_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let child;
        try {
            child = (0, node_child_process_1.spawn)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
        }
        catch {
            resolve("");
            return;
        }
        let stdout = "";
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
            finish("");
        }, timeoutMilliseconds);
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.on("error", () => finish(""));
        child.on("close", () => finish(stdout));
    });
}
/// The real Windows seams. `readForegroundProcess` is `app-inventory.ts`'s own
/// seam (reused, not re-implemented). Visual capture + evaluation default to
/// "not wired" — they return undefined — because they need `main/`'s screenshot
/// pipeline and a model transport a caller injects; until then side-signal
/// watching works and the visual rung is inert rather than broken.
function defaultWatchSeams(overrides = {}, readForegroundProcess = app_inventory_1.readForegroundProcessViaPowerShell) {
    return {
        isToolInstalled: overrides.isToolInstalled ?? (async () => false),
        readForegroundProcess: overrides.readForegroundProcess ?? (() => readForegroundProcess()),
        readForegroundBrowserHost: overrides.readForegroundBrowserHost ??
            (async () => parseActiveBrowserUrlOutput(await runPowerShellForStdout(buildActiveBrowserUrlCommand()))),
        isAxElementPresent: overrides.isAxElementPresent ??
            (async (roleLabel) => parseAxElementPresenceOutput(await runPowerShellForStdout(buildAxElementQueryCommand(roleLabel)))),
        captureScreenshotJpegBase64: overrides.captureScreenshotJpegBase64 ?? (async () => undefined),
        evaluateVisualCheck: overrides.evaluateVisualCheck ?? (async () => undefined),
        // Not wired by default (like the visual rung): a host supplies the fingerprint
        // capture from `main/`'s screenshot pipeline. Until then the perceptual-diff
        // gate is inert and the executor reads the side signals every poll.
        captureScreenFingerprint: overrides.captureScreenFingerprint ?? (async () => undefined),
        nowInSeconds: overrides.nowInSeconds ?? (() => Date.now() / 1000),
        waitForMilliseconds: overrides.waitForMilliseconds ??
            ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
}
// ---------------------------------------------------------------------------
// The executor.
// ---------------------------------------------------------------------------
/// The visual budget, straight out of `docs/iris-assistant-protocol.md` §7 and
/// the macOS `WatchLoop` constants.
exports.MAXIMUM_VISUAL_CHECKS_PER_STEP = 8;
exports.MINIMUM_SECONDS_BETWEEN_VISUAL_CHECKS = 10;
/// How long to wait between polls of a watched step. 2 s matches the macOS
/// loop's cadence.
exports.MILLISECONDS_BETWEEN_POLLS = 2000;
/// How many CONSECUTIVE polls with no observed progress may pass before a watch
/// that never verifies gives up and hands the step to the reader. ~90 polls
/// (~3 minutes) of nothing changing is the ceiling.
///
/// This is NOT a wall-clock cap: macOS's `WatchLoop` has no elapsed-time or
/// poll-count bound and watches a step for as long as it takes — only the model
/// budget is finite. The Windows executor is an awaitable a pumped runner calls
/// inline, so it must eventually return; the port keeps that faithful by counting
/// only polls where NOTHING happened. A meaningful screen change (rung 2) resets
/// the counter, so a genuinely-slow-but-live step — a large `npm install` still
/// spilling output — is watched well past three minutes instead of being handed
/// back as stalled. When no capture seam is wired there is no progress signal, so
/// every poll counts and the behaviour is the old fixed ~3-minute ceiling.
exports.DEFAULT_MAXIMUM_POLLS = 90;
/// The absolute safety ceiling on poll iterations, so `awaitStepCompletion`
/// always returns even if the screen changes forever (a video playing behind the
/// step). ~3 hours at the 2 s cadence — far beyond any real install, and the
/// escape hatch (`shouldAbort`) exits long before it in practice.
exports.ABSOLUTE_MAXIMUM_POLLS = 5400;
/// Blocks on a step's `watch` block until one expectation verifies, cheapest
/// first, or the bounded wait runs out. The Windows autopilot's answer to the
/// macOS `WatchLoop`, shaped as an awaitable the pumped runner calls inline.
class WatchStepExecutor {
    seams;
    constructor(seams) {
        this.seams = seams;
    }
    /// Polls the watch's expectations until the step is confirmed done or the
    /// no-progress budget runs out. Returns `verified` (with the strongest side
    /// signal that settled it, or `visual`), `timedOut` (with any stuck hint), or
    /// `aborted` (the reader hit 'Stop'). A `sensitive` watch never reaches the
    /// visual rung, nor is its screen ever fingerprinted.
    ///
    /// The ladder each poll, matching macOS `performOneWatchTick`:
    ///   rung 2  the perceptual diff — an unchanged screen (when capture is wired)
    ///           makes the poll free and there is nothing new to read.
    ///   rung 3  the local signals, AND across ALL declared side signals — the
    ///           step is done only when EVERY one is satisfied, not any single one
    ///           (macOS `evaluateLocalSignals`). Evaluated cheapest-first and
    ///           short-circuited on the first that is unsatisfied.
    ///   rung 4  the visual model check, reached only when the side signals could
    ///           not settle it and the step declares a non-sensitive `visual`.
    async awaitStepCompletion(watch, options = {}) {
        const orderedExpectations = orderExpectationsCheapestFirst(watch.expect);
        const sideSignalExpectations = orderedExpectations.filter((expectation) => expectation.type !== "visual");
        const visualExpectation = orderedExpectations.find((expectation) => expectation.type === "visual");
        const stepIsSensitive = watch.sensitive === true;
        // A sensitive step may never be looked at: no visual model call AND no
        // fingerprint capture, since both derive from pixels.
        const mayLookAtPixels = !stepIsSensitive;
        const mayUseVisual = mayLookAtPixels && visualExpectation !== undefined;
        const noProgressCeiling = options.maximumPolls ?? exports.DEFAULT_MAXIMUM_POLLS;
        // Nothing declared here can ever confirm the step — there is no pixel-free
        // side signal to check, and the visual rung is either forbidden (a sensitive
        // step is never captured) or not declared. Polling the full ~3-minute ceiling
        // to reach the identical timeout is a silent stall indistinguishable from a
        // hang, so hand back to the reader at once instead. This is the sensitive
        // visual-only case (5 shipped guides carry a visual-only `verify`/watch);
        // the non-sensitive visual-only-but-capture-unwired case is caught inside the
        // loop once a capture attempt proves the seam is not wired.
        if (sideSignalExpectations.length === 0 && !mayUseVisual) {
            return { kind: "timedOut" };
        }
        // The visual budget is per-step working state, fresh for each call, so no
        // step's spend can leak into the next one.
        let visualChecksUsedOnThisStep = 0;
        let secondsAtMostRecentVisualCheck;
        let mostRecentStuckHint;
        let previousFingerprint;
        let consecutivePollsWithoutProgress = 0;
        for (let pollIndex = 0; pollIndex < exports.ABSOLUTE_MAXIMUM_POLLS; pollIndex += 1) {
            if (options.shouldAbort?.() === true)
                return { kind: "aborted" };
            // Rung 2 — the perceptual diff. Only when a fingerprint seam is wired and
            // the step is not sensitive. The first frame is a baseline (read the
            // signals, but never spend a model call); an unchanged frame after that
            // costs nothing else and is the overwhelmingly common path.
            const fingerprint = mayLookAtPixels ? await this.seams.captureScreenFingerprint() : undefined;
            const fingerprintSeamIsWired = fingerprint !== undefined;
            let screenMeaningfullyChanged = true;
            let isBaselineFrame = false;
            if (fingerprintSeamIsWired) {
                if (previousFingerprint === undefined) {
                    isBaselineFrame = true;
                    screenMeaningfullyChanged = false;
                }
                else {
                    screenMeaningfullyChanged =
                        hammingDistanceBetweenFingerprints(previousFingerprint, fingerprint) >=
                            exports.MINIMUM_HAMMING_DISTANCE_THAT_COUNTS;
                }
                previousFingerprint = fingerprint;
            }
            // A wired, non-baseline, unchanged frame settles nothing new — the reader
            // is reading the step, not acting on it — so skip every signal read this
            // poll. This is the rung that makes the common case free.
            const nothingChangedSoNothingToRead = fingerprintSeamIsWired && !isBaselineFrame && !screenMeaningfullyChanged;
            if (!nothingChangedSoNothingToRead) {
                // Rung 3 — the local signals, AND across all of them.
                const sideSignalVerdict = await this.evaluateSideSignals(sideSignalExpectations);
                if (sideSignalVerdict.kind === "allSatisfied") {
                    return { kind: "verified", verifiedBy: sideSignalVerdict.strongestSatisfied };
                }
                // Rung 4 — the visual model check. Reached only when the side signals
                // could not settle it (`notAllSatisfied` or none declared) and the step
                // declares a non-sensitive visual. On a wired fingerprint seam a model
                // call is spent only when the screen actually changed — never on the
                // baseline — mirroring macOS paying for the model only after something
                // has happened; with no seam wired the visual rung is reachable every
                // poll, subject to its own budget/spacing.
                const visualIsAllowedThisPoll = mayUseVisual && (!fingerprintSeamIsWired || screenMeaningfullyChanged);
                if (visualIsAllowedThisPoll &&
                    visualExpectation !== undefined &&
                    visualChecksUsedOnThisStep < exports.MAXIMUM_VISUAL_CHECKS_PER_STEP) {
                    const nowInSeconds = this.seams.nowInSeconds();
                    const spacingAllowsAnotherCheck = secondsAtMostRecentVisualCheck === undefined ||
                        nowInSeconds - secondsAtMostRecentVisualCheck >= exports.MINIMUM_SECONDS_BETWEEN_VISUAL_CHECKS;
                    if (spacingAllowsAnotherCheck) {
                        // The budget is spent BEFORE the call, not after: a failed call
                        // still cost time and still hit a rate limit, and a loop that only
                        // counted successes would retry a broken model every poll. Mirrors
                        // macOS.
                        visualChecksUsedOnThisStep += 1;
                        secondsAtMostRecentVisualCheck = nowInSeconds;
                        const visualResult = await this.evaluateVisualExpectation(visualExpectation, options);
                        if (visualResult === "captureUnavailable") {
                            // The visual rung is the only thing that could confirm this step
                            // and the screenshot seam is not wired on this build, so it can
                            // never verify. With no side signal to fall back on, hand back to
                            // the reader NOW rather than burn the whole no-progress budget on
                            // polls that provably cannot settle — a silent stall reads exactly
                            // like a hang. Once a host wires the capture seam this branch is
                            // never taken. (Finding: the visual rung unwired in production.)
                            if (sideSignalExpectations.length === 0) {
                                return { kind: "timedOut", stuckHint: mostRecentStuckHint };
                            }
                            // With side signals present, keep polling those; the visual budget
                            // spent above simply bounds how many dead capture attempts happen.
                        }
                        else if (visualResult?.kind === "completed") {
                            return { kind: "verified", verifiedBy: "visual" };
                        }
                        else if (visualResult?.kind === "userStuck") {
                            mostRecentStuckHint = visualResult.hint;
                        }
                    }
                }
            }
            // Progress accounting: a meaningful, non-baseline screen change is the
            // evidence a step is still advancing, so it resets the no-progress
            // countdown. Without a wired capture seam there is no progress signal, so
            // every poll counts against the ceiling exactly as the fixed ceiling did.
            const observedProgress = fingerprintSeamIsWired && !isBaselineFrame && screenMeaningfullyChanged;
            if (observedProgress) {
                consecutivePollsWithoutProgress = 0;
            }
            else {
                consecutivePollsWithoutProgress += 1;
                if (consecutivePollsWithoutProgress >= noProgressCeiling) {
                    return { kind: "timedOut", stuckHint: mostRecentStuckHint };
                }
            }
            if (options.shouldAbort?.() === true)
                return { kind: "aborted" };
            await this.seams.waitForMilliseconds(exports.MILLISECONDS_BETWEEN_POLLS);
        }
        return { kind: "timedOut", stuckHint: mostRecentStuckHint };
    }
    /// Evaluates every declared side (pixel-free) signal with AND semantics: the
    /// step is `allSatisfied` only when EVERY one is satisfied. Cheapest-first and
    /// short-circuited — the first unsatisfied signal ends the round, so a costlier
    /// PowerShell probe is never spawned once a cheaper check has already failed.
    /// `strongestSatisfied` (when all pass) is the most expensive side signal, the
    /// one that best proves the step is done. Mirrors macOS `evaluateLocalSignals`
    /// (`everyLocalExpectationIsSatisfied`).
    async evaluateSideSignals(sideSignalExpectations) {
        if (sideSignalExpectations.length === 0)
            return { kind: "noneDeclared" };
        // `sideSignalExpectations` is already cheapest-first, so the last one to be
        // confirmed is the strongest.
        let strongestSatisfied = sideSignalExpectations[0].type;
        for (const expectation of sideSignalExpectations) {
            if (!(await this.isSideSignalSatisfied(expectation))) {
                return { kind: "notAllSatisfied" };
            }
            strongestSatisfied = expectation.type;
        }
        return { kind: "allSatisfied", strongestSatisfied };
    }
    /// A single pixel-free expectation. Never captures a screenshot.
    async isSideSignalSatisfied(expectation) {
        switch (expectation.type) {
            case "toolVersion":
                // A tool the allowlist does not know is refused, never asked about — the
                // same boundary `tool-versions.ts` draws (no command is built from guide
                // text). An unknown tool simply never verifies.
                if (!(0, tool_versions_1.isAllowlistedTool)(expectation.tool))
                    return false;
                return this.seams.isToolInstalled(expectation.tool);
            case "foregroundApp": {
                const foregroundProcess = await this.seams.readForegroundProcess();
                if (foregroundProcess === undefined)
                    return false;
                return foregroundProcessSatisfiesIdentity(foregroundProcess.processName, expectation.bundleId);
            }
            case "urlHost": {
                const foregroundBrowserHost = await this.seams.readForegroundBrowserHost();
                return hostMatchesExpectedHost(foregroundBrowserHost, expectation.host);
            }
            case "axElement":
                return this.seams.isAxElementPresent(expectation.roleLabel);
            case "visual":
                // Never a side signal. This case exists so a sixth expectation type is a
                // compile error rather than a silent pass.
                return false;
        }
    }
    /// Runs one visual model check, distinguishing three outcomes the caller must
    /// treat differently: `"captureUnavailable"` (no screenshot seam wired — the
    /// rung can NEVER verify, so an all-visual watch should give up now rather than
    /// stall), a `WatchVerdict` (the model answered), or `undefined` (a frame was
    /// captured but the model's answer could not be read — a real not-yet).
    async evaluateVisualExpectation(expectation, options) {
        const screenshotJpegBase64 = await this.seams.captureScreenshotJpegBase64();
        if (screenshotJpegBase64 === undefined || screenshotJpegBase64.length === 0) {
            return "captureUnavailable";
        }
        return this.seams.evaluateVisualCheck({
            screenshotJpegBase64,
            visualPrompt: expectation.prompt,
            stepTitle: options.stepTitle ?? "",
            context: options.context ?? { commandTheStepAsksFor: options.commandTheStepAsksFor },
            hintsTheStepAuthorWrote: options.hintsTheStepAuthorWrote ?? [],
        });
    }
}
exports.WatchStepExecutor = WatchStepExecutor;
/// Builds a `WatchStepExecutor` on the real Windows seams — reused by the
/// autopilot controller in production, and by any host wiring in the visual
/// capture/evaluation seams. Overrides let a host supply the visual pipeline
/// without re-stating the PowerShell seams.
function defaultWatchExecutor(overrides = {}) {
    return new WatchStepExecutor(defaultWatchSeams(overrides));
}
