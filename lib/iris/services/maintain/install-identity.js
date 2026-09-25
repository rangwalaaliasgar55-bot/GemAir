"use strict";
/**
 * install-identity.ts
 *
 * The Windows port of `iris-macos/leanring-buddy/MaintainInstallIdentity.swift`.
 *
 * The pseudonymous id the pool counts distinct installs by. It is a random
 * UUID, never an account id or a hardware id, and it ROTATES every 90 days —
 * so the pool can tell "three machines" from "one machine three times"
 * without ever holding a stable cross-year identifier for anyone. Rotation
 * costs a little statistical fidelity (a long-lived install counts fresh each
 * quarter) and buys that no pooled row links back further than a season.
 * That trade is the point, ported unchanged.
 *
 * This file is pure: it never touches `electron` or the filesystem itself.
 * Where the id actually lives on disk — `userData/maintain.json`, the same
 * file `main/maintain/state-store.ts` (a separate porting task) owns for
 * every other piece of maintain-mode state — is supplied to
 * `MaintainInstallIdentity` as an injected `InstallIdentityPersistence`,
 * exactly the way `ShellSession` is injected into the autopilot runner and
 * `FetchLike` into `claude.ts`. That keeps the 90-day rotation math testable
 * with an in-memory fake on any OS, on the Mac dev machine and on
 * windows-latest CI alike, with no real clock and no real disk required.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintainInstallIdentity = exports.InMemoryInstallIdentityPersistence = exports.INSTALL_ID_ROTATION_INTERVAL_MS = void 0;
exports.machineArchitecture = machineArchitecture;
const node_crypto_1 = require("node:crypto");
const trace_1 = require("./trace");
/** 90 days, in milliseconds — `Date.now()` is ms-based in JS, unlike Swift's
 *  `TimeInterval` (seconds), so the constant is converted here rather than at
 *  every call site. */
exports.INSTALL_ID_ROTATION_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
/** Small in-memory implementation for tests and for any caller that does not
 *  yet have a real `userData`-backed store wired up. Mirrors `MockShell` in
 *  `services/autopilot/shell.ts`: a real seam implementation kept beside the
 *  interface it satisfies, not hidden inside a test file, so every test that
 *  needs one gets the same behavior. */
class InMemoryInstallIdentityPersistence {
    record = null;
    readCurrentInstallIdentity() {
        return this.record;
    }
    writeCurrentInstallIdentity(record) {
        this.record = record;
    }
}
exports.InMemoryInstallIdentityPersistence = InMemoryInstallIdentityPersistence;
/**
 * Mints and rotates the pseudonymous install id. One instance per app
 * lifetime is enough — `currentInstallId()` is cheap and idempotent within
 * the rotation window.
 */
class MaintainInstallIdentity {
    persistence;
    generateUuid;
    nowEpochMs;
    constructor(options) {
        this.persistence = options.persistence;
        this.generateUuid = options.generateUuid ?? node_crypto_1.randomUUID;
        this.nowEpochMs = options.nowEpochMs ?? (() => Date.now());
    }
    /**
     * The current install id, minting (or re-minting, on rotation) as a side
     * effect exactly like Swift's `currentInstallId` computed property. A
     * `mintedAtEpochMs` in the future (clock skew) is treated the same way
     * Swift's `Date().timeIntervalSince(mintedAt) < rotationInterval` treats it
     * — a negative elapsed time is still less than the rotation interval, so
     * the existing id is kept rather than being churned by a clock that jumped
     * backward.
     */
    currentInstallId() {
        const existing = this.persistence.readCurrentInstallIdentity();
        if (existing !== null && this.nowEpochMs() - existing.mintedAtEpochMs < exports.INSTALL_ID_ROTATION_INTERVAL_MS) {
            return existing.installId;
        }
        const fresh = {
            installId: this.generateUuid(),
            mintedAtEpochMs: this.nowEpochMs(),
        };
        this.persistence.writeCurrentInstallIdentity(fresh);
        (0, trace_1.maintainTrace)(existing === null ? "install id minted (first run)" : "install id rotated (90-day window elapsed)");
        return fresh.installId;
    }
}
exports.MaintainInstallIdentity = MaintainInstallIdentity;
/**
 * arm64/x64 — an applicability dimension for recipe matching, not an identity
 * one. Trivial on Windows: `process.arch` needs no Windows primitive, unlike
 * Swift's `uname()` call (there is no cross-platform vocabulary requirement
 * here either, since this value is never compared against the macOS client's
 * own `machineArchitecture`).
 */
function machineArchitecture() {
    return process.arch || "unknown";
}
