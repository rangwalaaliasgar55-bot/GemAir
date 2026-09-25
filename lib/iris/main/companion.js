"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompanionManager = void 0;
const electron_1 = require("electron");
const screenshot_1 = require("./screenshot");
const model_chat_1 = require("../services/model-chat");
const assistant_transport_1 = require("../services/assistant-transport");
const opencode_session_1 = require("./opencode-session");
const coordinates_1 = require("../services/coordinates");
/**
 * companion.ts
 *
 * The pipeline: typed message -> screenshot -> model -> optional two-pass point
 * refinement -> overlay. Mirrors `CompanionManager` in the macOS app.
 *
 * The refinement pass and the three coordinate spaces are inherited from
 * upstream and are the part most likely to break; all of the arithmetic now
 * lives in `services/coordinates.ts` where it is covered by tests.
 */
const MAX_CONVERSATION_TURNS = 10;
/**
 * ~300 IMAGE-space pixels: small enough to disambiguate neighbouring similar
 * elements, large enough to keep context. At native DPI this is a much sharper
 * patch than cropping the downsampled pass-1 image would give.
 */
const REFINEMENT_CROP_SIZE_IN_IMAGE_SPACE = 300;
class CompanionManager {
    settings;
    screenCapture = new screenshot_1.ScreenCapture();
    conversationHistory = [];
    overlayWindows;
    /** Probed rather than assumed; see `refreshCliAvailability`. */
    cliAvailable = false;
    /** The loopback base of a running `opencode serve`, or null. Probed, never
     *  assumed: a local server that went away must not keep being chosen. */
    localServerBaseUrl = null;
    latestChatFailure = null;
    constructor(settings, overlayWindows) {
        this.settings = settings;
        this.overlayWindows = overlayWindows;
    }
    setOverlayWindows(overlayWindows) {
        this.overlayWindows = overlayWindows;
    }
    broadcastStage(stage, label) {
        for (const window of electron_1.BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send("companion:stage", { stage, label });
            }
        }
    }
    /**
     * Builds the model client for the current credentials. Which tier is in play
     * is decided fresh on every message, because the user can sign in, sign out,
     * or paste a key between one message and the next.
     */
    createChatService() {
        const transport = this.currentTransport();
        const model = (0, assistant_transport_1.defaultModelForTransport)(transport, this.settings.get("openCodeModel"));
        return new model_chat_1.ModelChatService({
            transport,
            model,
            // The CLI answers by running the reader's own binary, so it replaces the
            // HTTP send rather than configuring one.
            chatBackend: transport.tier === "cli" ? new opencode_session_1.OpenCodeChatBackend({ model }) : undefined,
        });
    }
    /** Upstream's name for the same thing, kept so ported callers still work. */
    createClaudeService() {
        return this.createChatService();
    }
    /** The route the next message will take. Throws, like `selectTransport`,
     *  when no provider can answer. */
    currentTransport() {
        const storedPreference = this.settings.get("providerPreference");
        return (0, assistant_transport_1.selectTransport)({
            preference: (0, assistant_transport_1.isProviderPreference)(storedPreference) ? storedPreference : null,
            storedOpenCodeApiKey: this.settings.getOpenCodeApiKey(),
            openCodeBaseUrl: this.settings.get("openCodeBaseUrl"),
            localServerBaseUrl: this.localServerBaseUrl,
            cliIsAvailable: this.cliIsAvailable(),
        });
    }
    /** Which route answers right now, for the tray and the settings panel. */
    currentRouteDescription() {
        try {
            return (0, assistant_transport_1.tierDescription)(this.currentTransport());
        }
        catch {
            return "no provider";
        }
    }
    lastChatFailure() {
        return this.latestChatFailure;
    }
    /**
     * Whether the reader has a usable `opencode`. Probed once and cached: the
     * answer changes only when they install or remove the CLI, and a spawn on
     * every message would add latency to the two routes that do not need it.
     */
    cliIsAvailable() {
        return this.cliAvailable;
    }
    /** Upstream's name, kept so ported callers still work. */
    codexIsAvailable() {
        return this.cliIsAvailable();
    }
    /** Called at startup, and again whenever the reader picks the CLI in settings. */
    async refreshCliAvailability() {
        (0, opencode_session_1.invalidateOpenCodeProbe)();
        this.cliAvailable = (0, opencode_session_1.openCodeIsAvailable)();
        return this.cliAvailable;
    }
    /** Called at startup and on a settings change: is `opencode serve` up? */
    async refreshLocalServer() {
        const configuredPort = Number.parseInt(this.settings.get("openCodeServerPort"), 10);
        const port = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 4096;
        this.localServerBaseUrl = await (0, opencode_session_1.probeLocalOpenCodeServer)(port);
        return this.localServerBaseUrl;
    }
    /**
     * Process one typed message. Returns the text to show the user, with POINT
     * tags already stripped.
     */
    async processQuery(userMessage) {
        this.latestChatFailure = null;
        try {
            this.broadcastStage("capturing", "Reading screen...");
            const screenshots = await this.screenCapture.captureAllScreens();
            const cursorPosition = this.screenCapture.getCursorPosition();
            this.conversationHistory.push({ role: "user", content: userMessage });
            this.broadcastStage("querying", "Analyzing...");
            const chat = this.createChatService();
            const response = await chat.query({
                userMessage,
                screenshots,
                cursorPosition,
                conversationHistory: this.conversationHistory,
            });
            this.conversationHistory.push({ role: "assistant", content: response.text });
            if (this.conversationHistory.length > MAX_CONVERSATION_TURNS * 2) {
                this.conversationHistory = this.conversationHistory.slice(-MAX_CONVERSATION_TURNS * 2);
            }
            const pointTagsInImageSpace = (0, coordinates_1.parsePointTags)(response.text);
            if (pointTagsInImageSpace.length > 0) {
                this.broadcastStage("refining", "Refining points...");
                const displayPoints = await this.resolvePointTags(pointTagsInImageSpace, screenshots, chat);
                this.sendPointsToOverlays(displayPoints);
            }
            return (0, coordinates_1.stripPointTags)(response.text);
        }
        catch (error) {
            if (error instanceof assistant_transport_1.AssistantTransportFailure) {
                // A transport failure is a sentence the user can act on, never a status
                // code and never the server's own body.
                const message = (0, assistant_transport_1.userFacingMessage)(error.detail);
                this.latestChatFailure = {
                    message,
                    // Upstream carried a top-up link here for a 402. Every GemAir route
                    // is free, so there is never anything to buy; the field stays so the
                    // chat window's ported renderer keeps working, and is always null.
                    addCreditUrl: null,
                    requiresSetup: (0, assistant_transport_1.requiresSetup)(error.detail),
                };
                throw new Error(message);
            }
            const unexpected = error instanceof Error ? error : new Error(String(error));
            this.latestChatFailure = { message: unexpected.message, addCreditUrl: null, requiresSetup: false };
            throw unexpected;
        }
        finally {
            this.broadcastStage("done", "");
        }
    }
    /**
     * Point the eye at the on-screen control a reader needs to clear an autopilot
     * gate — the sign-in field, the permission button — so a non-technical person
     * is shown *where* to act, not just told. Reuses the same capture -> model ->
     * POINT -> overlay pipeline as a chat answer, with a located-control prompt and
     * no conversation history (a gate is not part of the chat).
     *
     * Best-effort by design: any failure (no credentials, the control off-screen,
     * the model declining to point) is swallowed, because the written instruction
     * in the terminal tray is always the fallback and a missing glow must never
     * block the install.
     */
    async pointAtGate(target) {
        try {
            this.broadcastStage("capturing", "Finding it on screen...");
            const screenshots = await this.screenCapture.captureAllScreens();
            const cursorPosition = this.screenCapture.getCursorPosition();
            const chat = this.createChatService();
            const response = await chat.query({
                userMessage: `Point at the exact on-screen control the person should use in order to: ${target}. ` +
                    `If it is a field they must type into, point at the field; if it is a button, point at the button. ` +
                    `Reply with only a POINT tag and nothing else.`,
                screenshots,
                cursorPosition,
                conversationHistory: [],
            });
            const pointTagsInImageSpace = (0, coordinates_1.parsePointTags)(response.text);
            if (pointTagsInImageSpace.length === 0)
                return;
            const displayPoints = await this.resolvePointTags(pointTagsInImageSpace, screenshots, chat);
            this.sendPointsToOverlays(displayPoints);
        }
        catch {
            // The instruction in the tray is the fallback; the glow is a bonus.
        }
        finally {
            this.broadcastStage("done", "");
        }
    }
    /**
     * Second pass, then the IMAGE -> DISPLAY conversion. Refinement failures fall
     * back to the first-pass estimate rather than dropping the point entirely.
     */
    async resolvePointTags(tags, screenshots, chat) {
        return Promise.all(tags.map(async (tag) => {
            const shot = screenshots[tag.screen] ?? screenshots[0];
            if (!shot)
                return tag;
            try {
                const crop = (0, screenshot_1.cropScreenshotRegion)(shot, { x: tag.x, y: tag.y }, REFINEMENT_CROP_SIZE_IN_IMAGE_SPACE);
                const refined = await chat.refinePoint({
                    cropBase64: crop.data,
                    cropWidth: crop.cropSize.width,
                    cropHeight: crop.cropSize.height,
                    label: tag.label,
                });
                const displayPoint = (0, coordinates_1.resolvePointForOverlay)({
                    imagePoint: { x: tag.x, y: tag.y },
                    imageDimensions: shot.imageDimensions,
                    displayBounds: shot.bounds,
                    refinement: refined ? { pointInCropSpace: refined, cropPlan: crop.plan } : undefined,
                });
                return { ...tag, x: displayPoint.x, y: displayPoint.y };
            }
            catch {
                // Refinement is an optimisation; losing it must not lose the point.
                const displayPoint = (0, coordinates_1.resolvePointForOverlay)({
                    imagePoint: { x: tag.x, y: tag.y },
                    imageDimensions: shot.imageDimensions,
                    displayBounds: shot.bounds,
                });
                return { ...tag, x: displayPoint.x, y: displayPoint.y };
            }
        }));
    }
    /** Route each tag to the overlay for its own display. */
    sendPointsToOverlays(tags) {
        if (tags.length === 0 || this.overlayWindows.length === 0)
            return;
        const tagsByScreen = new Map();
        for (const tag of tags) {
            const list = tagsByScreen.get(tag.screen) ?? [];
            list.push(tag);
            tagsByScreen.set(tag.screen, list);
        }
        for (const [screenIndex, tagsForScreen] of tagsByScreen) {
            if (screenIndex < 0 || screenIndex >= this.overlayWindows.length) {
                console.warn(`[gemair] POINT tag screen=${screenIndex} is out of range ` +
                    `(have ${this.overlayWindows.length} overlay windows); routing to the primary display.`);
            }
            const window = this.overlayWindows[screenIndex] ?? this.overlayWindows[0];
            if (window && !window.isDestroyed()) {
                window.webContents.send("overlay:point", tagsForScreen);
            }
        }
    }
    clearHistory() {
        this.conversationHistory = [];
    }
}
exports.CompanionManager = CompanionManager;
