"use strict";
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
exports.SettingsStore = void 0;
const electron_1 = require("electron");
const { DEFAULT_FREE_MODEL } = require("../services/opencode-models");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const secrets_1 = require("./secrets");
/**
 * Everything GemAir's assistant subsystem remembers between launches — and
 * nothing secret. Secrets live in `secrets.js` behind `safeStorage`; this file
 * is plain JSON and is safe to paste into a bug report.
 *
 * Upstream carried eleven publik fields here: an install id, a claim state, a
 * balance in micros, a top-up URL, a "has the paid card been shown" gate. All
 * of them are gone with the metering. What replaces them is three lines — which
 * OpenCode route, which free model, and where a local server is — because free
 * has no billing state to remember.
 */
const defaults = {
    /** `opencodeZen`, `opencodeServer`, `opencodeCli`, or "" for "work it out". */
    providerPreference: "",
    /** A FREE OpenCode model id. Anything else is refused by the gate in
     *  `services/opencode-models.js` before a request is built. */
    openCodeModel: DEFAULT_FREE_MODEL,
    /** The Zen gateway. Overridable for a mirror; still host-checked. */
    openCodeBaseUrl: "https://opencode.ai/zen/v1",
    /** Where `opencode serve` listens, when the reader runs one. */
    openCodeServerPort: "4096",
    /** Where guides come from: the bundled catalogue, or a loopback authoring
     *  server. Nothing else is allowed (`services/guide-service.js`). */
    guideSource: "bundled:",
    // UI
    alwaysOnTop: false,
    cursorBuddyEnabled: true,
    /** The one-time "Let GemAir take control of your PC?" grant. Once true, the
     *  autopilot runs a vetted install hands-off (no per-command taps, only the
     *  catastrophe floor in `services/autopilot/risk.js`), and it is remembered
     *  across every future install until the reader turns it off. */
    autopilotAutonomyGranted: false,
    /** Whether maintain mode watches for crashes and hangs at all. */
    maintainEnabled: false,
    /** The last guide the reader opened, so the panel can offer to resume it. */
    lastGuideSlug: "",
    /** False until the first-run flow has been completed once. */
    hasCompletedFirstRun: false,
};
/**
 * Simple JSON file settings store. Avoids electron-store's ESM issues, and keeps
 * the file readable so a user can see exactly what GemAir remembers.
 */
class SettingsStore {
    data;
    filePath;
    constructor() {
        const userDataPath = electron_1.app.isReady()
            ? electron_1.app.getPath("userData")
            : path.join(process.env.APPDATA || process.env.HOME || ".", "gemair");
        // A file of its own, beside GemAir's other state rather than on top of
        // it: the rest of the app owns `settings.json`.
        this.filePath = path.join(userDataPath, "assist-settings.json");
        this.data = { ...defaults };
        let rawParsed = {};
        try {
            if (fs.existsSync(this.filePath)) {
                rawParsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
                this.data = { ...defaults, ...rawParsed };
            }
        }
        catch {
            // Use defaults on any read error.
        }
        this.migrateLegacyPlaintextSecrets(rawParsed);
    }
    /**
     * A pre-fork install has API keys sitting in settings.json in the clear. Move
     * the one GemAir still uses into safeStorage and drop the rest, so upgrading
     * actually improves the user's position instead of leaving a plaintext key on
     * disk forever.
     */
    migrateLegacyPlaintextSecrets(rawParsed) {
        let foundAnythingToRewrite = false;
        for (const legacyKeyName of secrets_1.LEGACY_PLAINTEXT_KEY_NAMES) {
            const legacyValue = rawParsed[legacyKeyName];
            if (typeof legacyValue !== "string" || legacyValue.length === 0)
                continue;
            // Nothing is migrated: every key GemAir might find in an old plaintext
            // settings file belongs to a provider this app does not use. They are
            // dropped rather than carried forward, which is the improvement.
            foundAnythingToRewrite = true;
        }
        // Also drop settings this fork no longer honours, so a stale
        // `aiProvider: "openai"` cannot be mistaken for a live option.
        for (const storedKeyName of Object.keys(rawParsed)) {
            if (!(storedKeyName in defaults))
                foundAnythingToRewrite = true;
        }
        // `this.data` was built from `defaults` plus known keys only, so saving it
        // is what actually removes the legacy fields from the file.
        if (foundAnythingToRewrite)
            this.save();
    }
    get(key) {
        const value = this.data[key];
        return value === undefined ? defaults[key] : value;
    }
    set(key, value) {
        this.data[key] = value;
        this.save();
    }
    getAll() {
        return { ...this.data };
    }
    // MARK: - Secrets (never stored in this file)
    /**
     * The reader's own OpenCode Zen key, if they pasted one.
     *
     * Optional by design: Zen's free ids answer to the public token, so GemAir
     * works with no key at all. A reader pastes one only to get their own
     * free-tier rate limit rather than the shared one.
     */
    getOpenCodeApiKey() {
        return (0, secrets_1.readSecret)("openCodeApiKey");
    }
    setOpenCodeApiKey(apiKey) {
        if (!apiKey) {
            (0, secrets_1.deleteSecret)("openCodeApiKey");
            return true;
        }
        return (0, secrets_1.writeSecret)("openCodeApiKey", apiKey);
    }
    /** The GitHub token maintain mode uses to open a fix PR. Never a model key. */
    getGitHubToken() {
        return (0, secrets_1.readSecret)("githubAccessToken");
    }
    setGitHubToken(token) {
        if (!token) {
            (0, secrets_1.deleteSecret)("githubAccessToken");
            return true;
        }
        return (0, secrets_1.writeSecret)("githubAccessToken", token);
    }
    /**
     * True when GemAir has some way to reach a model.
     *
     * Always true in practice, and that is the point: the Zen free tier needs no
     * credential, so there is no first-run wall. The parameters exist so a caller
     * can ask the narrower question "would this work offline?".
     */
    isConfigured(cliIsAvailable = false, localServerIsUp = false) {
        const preference = this.get("providerPreference");
        if (preference === "opencodeCli")
            return cliIsAvailable;
        if (preference === "opencodeServer")
            return localServerIsUp;
        return true;
    }
    save() {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        }
        catch {
            // Silent fail on write error — a settings write is never worth a crash.
        }
    }
}
exports.SettingsStore = SettingsStore;
