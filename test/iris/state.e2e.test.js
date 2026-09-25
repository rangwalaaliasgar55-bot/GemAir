"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_module_1 = require("node:module");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const vitest_1 = require("./vitest-shim");
/**
 * What GemAir Assist writes down, and what it refuses to write down.
 *
 * Three promises are checked here against a real filesystem and a fake
 * Electron: settings survive a restart, a secret is NEVER written in the clear,
 * and a legacy plaintext key left behind by a pre-fork install is removed from
 * disk rather than carried forward. The last two are the sort of thing a unit
 * test can assert an intention about but only a file on disk can actually
 * prove, so this file reads the bytes back.
 */
const FAKE_ELECTRON_PATH = require.resolve("./fixtures/fake-electron.js");
const originalResolveFilename = node_module_1.Module._resolveFilename;
node_module_1.Module._resolveFilename = function resolveWithFakeElectron(request, ...rest) {
    if (request === "electron")
        return FAKE_ELECTRON_PATH;
    return originalResolveFilename.call(this, request, ...rest);
};
const electron = require(FAKE_ELECTRON_PATH);
const settings_1 = require("../../lib/iris/main/settings");
const secrets_1 = require("../../lib/iris/main/secrets");
const THE_SECRET = "sk-a-real-looking-key-000111222";
function userDataFile(name) {
    return (0, node_path_1.join)(electron.app.getPath("userData"), name);
}
function settingsOnDisk() {
    const path = userDataFile("assist-settings.json");
    return (0, node_fs_1.existsSync)(path) ? JSON.parse((0, node_fs_1.readFileSync)(path, "utf8")) : null;
}
/** Every byte of every file the subsystem keeps in userData, as one string. */
function everythingWrittenToDisk() {
    const directory = electron.app.getPath("userData");
    return (0, node_fs_1.readdirSync)(directory)
        .map((name) => {
        const path = (0, node_path_1.join)(directory, name);
        return (0, node_fs_1.statSync)(path).isFile() ? (0, node_fs_1.readFileSync)(path, "utf8") : "";
    })
        .join("\n");
}
(0, vitest_1.afterAll)(() => {
    node_module_1.Module._resolveFilename = originalResolveFilename;
});
(0, vitest_1.describe)("settings", () => {
    (0, vitest_1.it)("starts from defaults on a machine that has never run it", () => {
        const settings = new settings_1.SettingsStore();
        (0, vitest_1.expect)(typeof settings.getAll()).toBe("object");
        (0, vitest_1.expect)(settings.get("providerPreference")).toBeDefined();
    });
    (0, vitest_1.it)("survives a restart", () => {
        new settings_1.SettingsStore().set("cursorBuddyEnabled", true);
        (0, vitest_1.expect)(new settings_1.SettingsStore().get("cursorBuddyEnabled")).toBe(true);
        new settings_1.SettingsStore().set("cursorBuddyEnabled", false);
        (0, vitest_1.expect)(new settings_1.SettingsStore().get("cursorBuddyEnabled")).toBe(false);
    });
    (0, vitest_1.it)("keeps its own file instead of writing into GemAir's settings.json", () => {
        new settings_1.SettingsStore().set("maintainEnabled", false);
        (0, vitest_1.expect)(settingsOnDisk()).toBeDefined();
        (0, vitest_1.expect)((0, node_fs_1.existsSync)(userDataFile("settings.json"))).toBe(false);
    });
    (0, vitest_1.it)("needs no credential to be usable, because the free route needs none", () => {
        const settings = new settings_1.SettingsStore();
        settings.set("providerPreference", "auto");
        (0, vitest_1.expect)(settings.isConfigured()).toBe(true);
        // ...but a reader who PINNED a route they do not have is told the truth.
        settings.set("providerPreference", "opencodeCli");
        (0, vitest_1.expect)(settings.isConfigured(false, false)).toBe(false);
        (0, vitest_1.expect)(settings.isConfigured(true, false)).toBe(true);
        settings.set("providerPreference", "auto");
    });
});
(0, vitest_1.describe)("secrets, when the OS offers no encryption", () => {
    (0, vitest_1.it)("reports that it cannot store one", () => {
        electron.safeStorage.available = false;
        (0, vitest_1.expect)((0, secrets_1.secretStorageIsAvailable)()).toBe(false);
    });
    (0, vitest_1.it)("refuses the write rather than falling back to plaintext", () => {
        electron.safeStorage.available = false;
        (0, vitest_1.expect)(new settings_1.SettingsStore().setOpenCodeApiKey(THE_SECRET)).toBe(false);
        // The refusal is the feature: nothing on disk may contain the key.
        (0, vitest_1.expect)(everythingWrittenToDisk()).not.toContain(THE_SECRET);
    });
    (0, vitest_1.it)("reads back nothing, rather than a stale or guessed value", () => {
        electron.safeStorage.available = false;
        (0, vitest_1.expect)(new settings_1.SettingsStore().getOpenCodeApiKey()).toBeNull();
    });
});
(0, vitest_1.describe)("secrets, when the OS does encrypt", () => {
    (0, vitest_1.it)("stores the key, and stores it encrypted", () => {
        electron.safeStorage.available = true;
        const settings = new settings_1.SettingsStore();
        (0, vitest_1.expect)(settings.setOpenCodeApiKey(THE_SECRET)).toBe(true);
        (0, vitest_1.expect)(settings.getOpenCodeApiKey()).toBe(THE_SECRET);
        // Ciphertext on disk, not the key — and never inside the settings file.
        (0, vitest_1.expect)(everythingWrittenToDisk()).not.toContain(THE_SECRET);
        (0, vitest_1.expect)(JSON.stringify(settingsOnDisk())).not.toContain(THE_SECRET);
    });
    (0, vitest_1.it)("keeps the GitHub token in the same place, separately", () => {
        electron.safeStorage.available = true;
        const settings = new settings_1.SettingsStore();
        (0, vitest_1.expect)(settings.setGitHubToken("ghp_000111222333")).toBe(true);
        (0, vitest_1.expect)(settings.getGitHubToken()).toBe("ghp_000111222333");
        (0, vitest_1.expect)(settings.getOpenCodeApiKey()).toBe(THE_SECRET);
        (0, vitest_1.expect)(everythingWrittenToDisk()).not.toContain("ghp_000111222333");
    });
    (0, vitest_1.it)("forgets a key when the reader clears it", () => {
        electron.safeStorage.available = true;
        const settings = new settings_1.SettingsStore();
        (0, vitest_1.expect)(settings.setOpenCodeApiKey("")).toBe(true);
        (0, vitest_1.expect)(settings.getOpenCodeApiKey()).toBeNull();
        (0, vitest_1.expect)(settings.getGitHubToken()).toBe("ghp_000111222333");
        settings.setGitHubToken("");
    });
});
(0, vitest_1.describe)("upgrading from an install that kept keys in the clear", () => {
    (0, vitest_1.it)("drops every legacy plaintext key from the file on first read", () => {
        const legacy = { anthropicApiKey: "sk-ant-legacy", openaiApiKey: "sk-openai-legacy", aiProvider: "openai" };
        (0, node_fs_1.writeFileSync)(userDataFile("assist-settings.json"), JSON.stringify(legacy, null, 2));
        // Constructing the store is what performs the migration.
        const settings = new settings_1.SettingsStore();
        const onDisk = settingsOnDisk();
        for (const name of secrets_1.LEGACY_PLAINTEXT_KEY_NAMES) {
            (0, vitest_1.expect)(name in onDisk).toBe(false);
        }
        // Including the ones belonging to providers this fork does not have.
        (0, vitest_1.expect)("aiProvider" in onDisk).toBe(false);
        (0, vitest_1.expect)(JSON.stringify(onDisk)).not.toContain("sk-ant-legacy");
        (0, vitest_1.expect)(JSON.stringify(onDisk)).not.toContain("sk-openai-legacy");
        // And the store itself never serves them to anything else.
        (0, vitest_1.expect)(settings.getAll().anthropicApiKey).toBeUndefined();
    });
    (0, vitest_1.it)("names publik's key among the ones it clears out", () => {
        // GemAir has no publik tier at all, so a key left over from one is dead
        // weight on disk and is removed rather than migrated.
        (0, vitest_1.expect)(secrets_1.LEGACY_PLAINTEXT_KEY_NAMES).toContain("publikApiKey");
    });
});
