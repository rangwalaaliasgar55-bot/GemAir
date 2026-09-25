"use strict";
//
// The strict-typed shape of a guide as `GET /api/iris/guides/{slug}` serves it,
// and a total, lenient decoder for it.
//
// This mirrors `iris-macos/leanring-buddy/IrisGuideModels.swift` field for field
// (which itself mirrors `publik/lib/iris-guides.ts`), so the two desktop clients
// read the same wire the same way. The decoder follows the SAME lenient rules the
// Swift `init(from:)` decoders follow:
//
//   - An unknown step `kind` falls back to `terminal` (Swift's `?? .terminal`).
//   - An unknown step expectation `type` is DROPPED, not fatal — a newer website
//     teaching GemAir a signal an older client cannot evaluate costs that client
//     one signal, not the whole step (Swift's `LenientlyDecodedStepExpectation`).
//   - An unknown `shell` falls back to `terminal`.
//   - Extra fields are ignored, never fatal.
//
// It goes further than Swift in one deliberate way: the decoder is TOTAL — it
// never throws. Where Swift would throw on a missing required scalar, this coerces
// to a safe default (a missing title/body becomes `""`, a step with no usable
// `id` is dropped, a branch whose `platform` is neither `macos` nor `windows` is
// dropped). The autopilot must degrade to "this guide has no Windows steps"
// rather than crash a shell-driving run on one malformed field, and the resolver
// falls back to a built-in recipe when a decode yields nothing usable.
//
// Pure module (no Node/Electron), so the whole thing runs in the vitest suite.
//
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeIrisGuide = decodeIrisGuide;
exports.branchKeyFor = branchKeyFor;
exports.branchMatchingKey = branchMatchingKey;
// ── Decoding helpers (total: every one has a safe answer for a bad value) ──────
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function asStringOrEmpty(value) {
    return typeof value === "string" ? value : "";
}
function asStringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function asFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
const KNOWN_STEP_KINDS = new Set([
    "check",
    "terminal",
    "open",
    "permission",
    "verify",
    "web",
    "paste",
]);
function decodeStepKind(value) {
    // An unknown kind falls back to `terminal`, exactly like the Swift and Tauri
    // clients — losing one step's styling beats a reader seeing no guide at all.
    const candidate = asString(value);
    return candidate !== undefined && KNOWN_STEP_KINDS.has(candidate)
        ? candidate
        : "terminal";
}
function decodeShell(value) {
    return value === "powershell" ? "powershell" : "terminal";
}
function decodeTool(value) {
    return value === "git" || value === "node" ? value : undefined;
}
function decodeExpectation(value) {
    const record = asRecord(value);
    switch (record.type) {
        case "foregroundApp": {
            const bundleId = asString(record.bundleId);
            return bundleId !== undefined ? { type: "foregroundApp", bundleId } : undefined;
        }
        case "urlHost": {
            const host = asString(record.host);
            return host !== undefined ? { type: "urlHost", host } : undefined;
        }
        case "toolVersion": {
            const tool = asString(record.tool);
            return tool !== undefined ? { type: "toolVersion", tool } : undefined;
        }
        case "axElement": {
            const roleLabel = asString(record.roleLabel);
            return roleLabel !== undefined ? { type: "axElement", roleLabel } : undefined;
        }
        case "visual": {
            const prompt = asString(record.prompt);
            return prompt !== undefined ? { type: "visual", prompt } : undefined;
        }
        default:
            // Unrecognized expectation type: drop it, do not fail the step.
            return undefined;
    }
}
function decodeWatch(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = asRecord(value);
    const rawExpectations = Array.isArray(record.expect) ? record.expect : [];
    const expect = rawExpectations
        .map((expectation) => decodeExpectation(expectation))
        .filter((expectation) => expectation !== undefined);
    // Absent means not sensitive; anything that is not explicitly `false` leaves
    // capture off, the cautious reading of a malformed value (matches Swift).
    const sensitive = record.sensitive === undefined ? false : record.sensitive !== false;
    return { expect, sensitive, hints: asStringArray(record.hints) };
}
function decodePoint(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = asRecord(value);
    const descriptor = asString(record.descriptor);
    if (descriptor === undefined)
        return undefined;
    const inApp = asString(record.inApp);
    const isWindow = typeof record.isWindow === "boolean" ? record.isWindow : undefined;
    return { descriptor, ...(inApp !== undefined ? { inApp } : {}), ...(isWindow !== undefined ? { isWindow } : {}) };
}
/// Decodes one step, or `undefined` when it has no usable `id` (a step with no
/// identity cannot be tracked, so it is dropped rather than carried as a blank).
function decodeStep(value) {
    const record = asRecord(value);
    const id = asString(record.id);
    if (id === undefined || id === "")
        return undefined;
    return {
        id,
        kind: decodeStepKind(record.kind),
        title: asStringOrEmpty(record.title),
        body: asStringOrEmpty(record.body),
        tool: decodeTool(record.tool),
        command: asString(record.command),
        href: asString(record.href),
        actionLabel: asString(record.actionLabel),
        verifierLabel: asString(record.verifierLabel),
        watch: decodeWatch(record.watch),
        point: decodePoint(record.point),
        workingDirectory: asString(record.workingDirectory),
    };
}
function decodeSteps(value) {
    return Array.isArray(value)
        ? value.map((step) => decodeStep(step)).filter((step) => step !== undefined)
        : [];
}
function decodeUnsupported(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = asRecord(value);
    const headline = asString(record.headline);
    const reason = asString(record.reason);
    if (headline === undefined || reason === undefined)
        return undefined;
    return { headline, reason, alternatives: asStringArray(record.alternatives) };
}
/// Decodes one branch, or `undefined` when its platform is neither `macos` nor
/// `windows` (a branch GemAir cannot place is dropped, not carried).
function decodeBranch(value) {
    const record = asRecord(value);
    const platform = record.platform;
    if (platform !== "macos" && platform !== "windows")
        return undefined;
    const target = record.target === "ios" || record.target === "android" ? record.target : undefined;
    const label = asString(record.label) ?? (platform === "windows" ? "Windows" : "macOS");
    return {
        platform,
        ...(target !== undefined ? { target } : {}),
        label,
        shell: decodeShell(record.shell),
        setupSteps: decodeSteps(record.setupSteps),
        steps: decodeSteps(record.steps),
        unsupported: decodeUnsupported(record.unsupported),
    };
}
function decodeStatus(value) {
    return value === "pilot" || value === "approved" || value === "review" ? value : "review";
}
function decodeOutputType(value) {
    return value === "desktop_app" || value === "local_web" || value === "mobile_app" || value === "credential"
        ? value
        : "local_web";
}
/// Turns the parsed JSON body of the guides route into a strict `IrisGuide`,
/// applying the lenient rules above. TOTAL: it never throws — a wholly malformed
/// payload decodes to a guide with an empty branch list, which the resolver reads
/// as "no Windows steps" and answers with a built-in fallback.
function decodeIrisGuide(value) {
    const record = asRecord(value);
    const rawBranches = Array.isArray(record.branches) ? record.branches : [];
    const branches = rawBranches
        .map((branch) => decodeBranch(branch))
        .filter((branch) => branch !== undefined);
    return {
        appSlug: asStringOrEmpty(record.appSlug),
        appName: asStringOrEmpty(record.appName),
        version: asFiniteNumber(record.version) ?? 0,
        status: decodeStatus(record.status),
        sourceOwner: asStringOrEmpty(record.sourceOwner),
        sourceRepo: asStringOrEmpty(record.sourceRepo),
        sourceCommit: asString(record.sourceCommit),
        outputType: decodeOutputType(record.outputType),
        estimatedMinutes: asFiniteNumber(record.estimatedMinutes),
        readmeSectionIds: asStringArray(record.readmeSectionIds),
        reviewNote: asString(record.reviewNote),
        branches,
    };
}
/// The branch identity used as the `branch` parameter of an `gemair://` handoff and
/// for progress storage — `platform:target`, with a desktop/local branch reading
/// as `…:desktop`. Equivalent to `branchKey()` in `lib/iris-guides.ts` and
/// `IrisGuide.branchKey(for:)` in Swift.
function branchKeyFor(branch) {
    return `${branch.platform}:${branch.target ?? "desktop"}`;
}
/// The branch a `platform:target` key names, or `undefined` when the guide has no
/// such branch — what makes a stale link land somewhere real, not somewhere wrong.
function branchMatchingKey(guide, branchKey) {
    return guide.branches.find((branch) => branchKeyFor(branch) === branchKey);
}
