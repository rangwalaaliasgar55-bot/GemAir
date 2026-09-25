"use strict";
/**
 * secrets.ts
 *
 * The only code in this app that touches a secret at rest.
 *
 * Upstream kept every API key in `%APPDATA%/clicky-windows/settings.json` in
 * plain text, which its own notes called "acceptable for a local personal tool;
 * not appropriate for distributed binaries". GemAir is a distributed binary, so
 * secrets go through Electron `safeStorage`, which on Windows is DPAPI: the
 * ciphertext is bound to the Windows user account and is useless if the file is
 * copied off the machine.
 *
 * The secrets here match `iris-macos`'s `KeychainStore`:
 *   - the user's own Anthropic API key (BYO tier)
 *   - the publik API key this install was issued (`pk_live_…`), the default
 *     chat route since the funded tier was removed. It reaches publik's own
 *     gateway and nowhere else, which `services/assistant-transport.ts`
 *     enforces per-credential rather than per-header — see its top comment.
 *   - the Supabase refresh token
 *   - maintain mode's GitHub device-flow token pair (fork-backup), the Windows
 *     analog of the pair `iris-macos` keeps in the Keychain — see
 *     `main/maintain/github-token-storage.ts`. These reach api.github.com only,
 *     never a publik host, so they sit alongside the Anthropic BYO key rather
 *     than violating the key-isolation rule.
 *   - the user's own OpenAI API key, maintain mode's Tier C fixer BYO option
 *     (a founder decision, matching `iris-macos` parity — see `CLAUDE.md`).
 *     `services/maintain/model-provider.ts`'s `OpenAIMaintainProvider` sends
 *     it to api.openai.com only, never a publik host — same rationale as the
 *     GitHub pair above. This key is scoped to maintain-mode Tier C; the
 *     companion chat stays Anthropic-only and never reads it.
 *
 * The Supabase access token is deliberately NOT here: it lives in memory only,
 * per protocol section 4.
 *
 * Neither value is ever logged. `toString()` is overridden nowhere because
 * nothing in this module ever returns a wrapper — the raw string leaves only
 * through the two read functions, and their callers hand it straight to
 * `assistant-transport`.
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
exports.LEGACY_PLAINTEXT_KEY_NAMES = void 0;
exports.secretStorageIsAvailable = secretStorageIsAvailable;
exports.readSecret = readSecret;
exports.writeSecret = writeSecret;
exports.deleteSecret = deleteSecret;
const electron_1 = require("electron");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/** Kept beside settings.json but in its own file, so a settings dump that gets
 *  pasted into a bug report never contains ciphertext at all. */
function secretsFilePath() {
    const userDataPath = electron_1.app.isReady()
        ? electron_1.app.getPath("userData")
        : path.join(process.env.APPDATA || process.env.HOME || ".", "gemair");
    return path.join(userDataPath, "secrets.json");
}
function readSecretFile() {
    try {
        const filePath = secretsFilePath();
        if (!fs.existsSync(filePath))
            return {};
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        // A corrupt secrets file is treated as an empty one: the user re-enters the
        // key, which is recoverable. Throwing here would make the app unusable.
        return {};
    }
}
function writeSecretFile(contents) {
    const filePath = secretsFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(contents, null, 2), { mode: 0o600 });
}
/**
 * False on a machine where the OS refuses to provide encryption. The UI must
 * say so rather than silently falling back to plaintext — writing a secret in
 * the clear is never the helpful choice.
 */
function secretStorageIsAvailable() {
    try {
        return electron_1.safeStorage.isEncryptionAvailable();
    }
    catch {
        return false;
    }
}
function readSecret(secretName) {
    if (!secretStorageIsAvailable())
        return null;
    const encoded = readSecretFile()[secretName];
    if (!encoded)
        return null;
    try {
        return electron_1.safeStorage.decryptString(Buffer.from(encoded, "base64")) || null;
    }
    catch {
        // Ciphertext from another Windows account, or a rotated DPAPI key.
        return null;
    }
}
function writeSecret(secretName, secretValue) {
    if (!secretStorageIsAvailable())
        return false;
    try {
        const contents = readSecretFile();
        contents[secretName] = electron_1.safeStorage.encryptString(secretValue).toString("base64");
        writeSecretFile(contents);
        return true;
    }
    catch {
        return false;
    }
}
function deleteSecret(secretName) {
    try {
        const contents = readSecretFile();
        if (secretName in contents) {
            delete contents[secretName];
            writeSecretFile(contents);
        }
    }
    catch {
        // Nothing to clean up.
    }
}
/**
 * Upstream's plaintext keys, removed from settings.json on first run so a
 * pre-fork install does not leave a key sitting in the clear forever. The
 * Anthropic one is migrated into safeStorage; the providers GemAir dropped are
 * simply deleted.
 */
exports.LEGACY_PLAINTEXT_KEY_NAMES = [
    "anthropicApiKey",
    "openaiApiKey",
    "openrouterApiKey",
    "assemblyaiApiKey",
    "elevenlabsApiKey",
    "publikApiKey",
];
