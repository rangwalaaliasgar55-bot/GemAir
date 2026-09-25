"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const install_identity_1 = require("../../lib/iris/services/maintain/install-identity");
/**
 * The pseudonymous, 90-day-rotating install id. `nowEpochMs` and `generateUuid`
 * are both injected (per the porting spec's constructor-injection convention),
 * so the whole 90-day boundary is testable without a real clock.
 */
function fakeClock(startEpochMs) {
    let now = startEpochMs;
    return {
        now: () => now,
        advanceBy: (ms) => {
            now += ms;
        },
    };
}
function fakeUuidGenerator() {
    let count = 0;
    return () => `fake-uuid-${++count}`;
}
(0, vitest_1.describe)("MaintainInstallIdentity", () => {
    (0, vitest_1.it)("mints an id on first use and persists it", () => {
        const persistence = new install_identity_1.InMemoryInstallIdentityPersistence();
        const clock = fakeClock(1_000_000);
        const identity = new install_identity_1.MaintainInstallIdentity({ persistence, nowEpochMs: clock.now, generateUuid: fakeUuidGenerator() });
        const id = identity.currentInstallId();
        (0, vitest_1.expect)(id).toBe("fake-uuid-1");
        (0, vitest_1.expect)(persistence.readCurrentInstallIdentity()).toEqual({ installId: "fake-uuid-1", mintedAtEpochMs: 1_000_000 });
    });
    (0, vitest_1.it)("returns the same id on repeated calls inside the rotation window", () => {
        const persistence = new install_identity_1.InMemoryInstallIdentityPersistence();
        const clock = fakeClock(0);
        const generateUuid = fakeUuidGenerator();
        const identity = new install_identity_1.MaintainInstallIdentity({ persistence, nowEpochMs: clock.now, generateUuid });
        const first = identity.currentInstallId();
        clock.advanceBy(install_identity_1.INSTALL_ID_ROTATION_INTERVAL_MS - 1);
        const second = identity.currentInstallId();
        (0, vitest_1.expect)(second).toBe(first);
    });
    (0, vitest_1.it)("rotates to a fresh id once the 90-day window has fully elapsed", () => {
        const persistence = new install_identity_1.InMemoryInstallIdentityPersistence();
        const clock = fakeClock(0);
        const generateUuid = fakeUuidGenerator();
        const identity = new install_identity_1.MaintainInstallIdentity({ persistence, nowEpochMs: clock.now, generateUuid });
        const first = identity.currentInstallId();
        clock.advanceBy(install_identity_1.INSTALL_ID_ROTATION_INTERVAL_MS);
        const second = identity.currentInstallId();
        (0, vitest_1.expect)(second).not.toBe(first);
        (0, vitest_1.expect)(persistence.readCurrentInstallIdentity()?.installId).toBe(second);
    });
    (0, vitest_1.it)("keeps the existing id when the stored mint time is in the future (clock skew), rather than churning it", () => {
        const persistence = new install_identity_1.InMemoryInstallIdentityPersistence();
        persistence.writeCurrentInstallIdentity({ installId: "already-there", mintedAtEpochMs: 10_000 });
        // "now" is earlier than mintedAtEpochMs — a negative elapsed time is still
        // less than the rotation interval, so Swift's `Date().timeIntervalSince`
        // semantics keep the existing id rather than treating skew as staleness.
        const identity = new install_identity_1.MaintainInstallIdentity({ persistence, nowEpochMs: () => 5_000 });
        (0, vitest_1.expect)(identity.currentInstallId()).toBe("already-there");
    });
    (0, vitest_1.it)("defaults nowEpochMs and generateUuid when not supplied, producing a real-looking UUID", () => {
        const persistence = new install_identity_1.InMemoryInstallIdentityPersistence();
        const identity = new install_identity_1.MaintainInstallIdentity({ persistence });
        const id = identity.currentInstallId();
        (0, vitest_1.expect)(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        (0, vitest_1.expect)(identity.currentInstallId()).toBe(id);
    });
});
(0, vitest_1.describe)("machineArchitecture", () => {
    (0, vitest_1.it)("reports the running process's architecture", () => {
        (0, vitest_1.expect)((0, install_identity_1.machineArchitecture)()).toBe(process.arch);
        (0, vitest_1.expect)((0, install_identity_1.machineArchitecture)().length).toBeGreaterThan(0);
    });
});
