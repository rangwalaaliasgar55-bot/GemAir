"use strict";
/**
 * github-token-storage.ts
 *
 * The durable, `safeStorage`-backed home for maintain mode's GitHub
 * device-flow token pair — the Windows analog of the pair `iris-macos` keeps in
 * its Keychain (`GitHubForkService`'s `KeychainStore`-backed storage). It
 * implements the pure `GitHubTokenStorage` seam that `services/maintain/
 * github-fork-service.ts` defines, so the service itself stays testable against
 * `InMemoryGitHubTokenStorage` while the running app persists for real.
 *
 * This lives in `main/` rather than `services/` for the same reason `secrets.ts`
 * does: it touches Electron `safeStorage` (DPAPI). It is therefore not part of
 * the vitest suite — the pure fork-service logic is, and this is the two-line
 * durable-storage adapter under it.
 *
 * A memory cache rides in front of DPAPI so a session on a machine whose OS
 * refuses encryption (`safeStorage` unavailable → `writeSecret` returns false)
 * still stays connected until relaunch — the same honest degrade
 * `InMemoryGitHubTokenStorage` gave, rather than silently dropping a token the
 * instant it is written. When DPAPI is available the pair survives relaunch,
 * which is the whole point of moving off the in-memory stub.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretsBackedGitHubTokenStorage = void 0;
const secrets_1 = require("../secrets");
class SecretsBackedGitHubTokenStorage {
    // Seeded once from disk at construction; every write updates both the cache
    // and (best-effort) DPAPI. Reads answer from the cache so a failed encrypt
    // does not lose the live session's token.
    cachedAccessToken = (0, secrets_1.readSecret)("gitHubAccessToken");
    cachedRefreshToken = (0, secrets_1.readSecret)("gitHubRefreshToken");
    readAccessToken = () => this.cachedAccessToken;
    writeAccessToken = (value) => {
        this.cachedAccessToken = value;
        (0, secrets_1.writeSecret)("gitHubAccessToken", value);
    };
    readRefreshToken = () => this.cachedRefreshToken;
    writeRefreshToken = (value) => {
        this.cachedRefreshToken = value;
        (0, secrets_1.writeSecret)("gitHubRefreshToken", value);
    };
}
exports.SecretsBackedGitHubTokenStorage = SecretsBackedGitHubTokenStorage;
