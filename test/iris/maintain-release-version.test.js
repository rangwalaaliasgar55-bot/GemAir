"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const release_version_1 = require("../../lib/iris/services/maintain/release-version");
/**
 * release-version.ts is the module the whole fix ladder leans on to decide
 * whether a pooled recipe's app_version range covers the machine attempting a
 * replay (`recipeApplicabilityMatches`). A wrong direction here is actively
 * harmful — it would offer a patch that no longer matches the code — so the
 * comparator gets its own exhaustive table rather than being exercised only
 * indirectly through replay-engine. The audit flagged it as having no dedicated
 * tests; this is that file.
 */
(0, vitest_1.describe)("compareReleaseVersions", () => {
    (0, vitest_1.it)("orders by numeric value, not string order — the 1.10 vs 1.9 trap", () => {
        // The entire reason this module exists: `"1.10.0" < "1.9.0"` as strings.
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.10.0", "1.9.0")).toBe("newer");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.9.0", "1.10.0")).toBe("older");
    });
    (0, vitest_1.it)("compares component by component", () => {
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("2.0.0", "1.9.9")).toBe("newer");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.3", "1.2.4")).toBe("older");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.3", "1.2.3")).toBe("same");
    });
    (0, vitest_1.it)("tolerates a leading v or V when a digit follows it", () => {
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("v1.2.3", "1.2.3")).toBe("same");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("V1.2.3", "v1.2.3")).toBe("same");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("v2.0.0", "v1.9.9")).toBe("newer");
    });
    (0, vitest_1.it)("treats a missing trailing component as zero, so 1.2 and 1.2.0 are the same release", () => {
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2", "1.2.0")).toBe("same");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.0.0", "1.2")).toBe("same");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.1", "1.2")).toBe("newer");
    });
    (0, vitest_1.it)("ignores build metadata for precedence, per semver", () => {
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.0+build.7", "1.2.0")).toBe("same");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.0+build.7", "1.2.0+build.99")).toBe("same");
    });
    (0, vitest_1.it)("sorts a pre-release below the release it leads up to", () => {
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.0-beta", "1.2.0")).toBe("older");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.0", "1.2.0-beta")).toBe("newer");
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.0-beta", "1.2.0-beta")).toBe("same");
    });
    (0, vitest_1.it)("orders pre-release identifiers: numeric numerically, numeric below alphanumeric, more identifiers later", () => {
        // numeric identifiers compared numerically, not as strings
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe("older");
        // a numeric identifier ranks below an alphanumeric one
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.0.0-1", "1.0.0-alpha")).toBe("older");
        // when all shared identifiers match, the one with more identifiers is later
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.2.0-beta", "1.2.0-beta.1")).toBe("older");
        // alphanumeric identifiers compare in ASCII order
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.0.0-alpha", "1.0.0-beta")).toBe("older");
    });
    (0, vitest_1.it)("compares alphanumeric identifiers in ASCII order, not locale order (uppercase before lowercase)", () => {
        // 'B' (0x42) sorts before 'a' (0x61) in ASCII — locale order could disagree.
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.0.0-Beta", "1.0.0-beta")).toBe("older");
    });
    (0, vitest_1.it)('returns "cannotBeCompared" rather than guessing when a side is not a version', () => {
        for (const unreadable of ["nightly", "latest", "1.x.3", "", "   ", "v", "version", "1.2.0-", "1.2..0", "1.-2.0"]) {
            (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)(unreadable, "1.0.0")).toBe("cannotBeCompared");
            (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.0.0", unreadable)).toBe("cannotBeCompared");
        }
    });
    (0, vitest_1.it)('rejects non-ASCII decimal digits (they parse differently than they look) as "cannotBeCompared"', () => {
        // Arabic-Indic digits ٥ (5). `/^\d+$/` unanchored would accept these.
        (0, vitest_1.expect)((0, release_version_1.compareReleaseVersions)("1.٥.0", "1.5.0")).toBe("cannotBeCompared");
    });
    (0, vitest_1.it)("keeps the leading token when the char after v/V is not a digit, so 'version' stays unreadable", () => {
        // If the `v` were dropped unconditionally this would parse as "ersion".
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("version")).toBeUndefined();
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("vNext")).toBeUndefined();
    });
});
(0, vitest_1.describe)("parseReleaseVersion", () => {
    (0, vitest_1.it)("parses release components and pre-release identifiers, discarding build metadata", () => {
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("v1.2.3")).toEqual({ numericComponents: [1, 2, 3], preReleaseIdentifiers: [] });
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("1.2.0-beta.1")).toEqual({
            numericComponents: [1, 2, 0],
            preReleaseIdentifiers: ["beta", "1"],
        });
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("1.2.0-beta.1+build.7")).toEqual({
            numericComponents: [1, 2, 0],
            preReleaseIdentifiers: ["beta", "1"],
        });
    });
    (0, vitest_1.it)("returns undefined for anything with a non-numeric release component", () => {
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("1.x.3")).toBeUndefined();
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("latest")).toBeUndefined();
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("")).toBeUndefined();
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("1.2.0-")).toBeUndefined();
        (0, vitest_1.expect)((0, release_version_1.parseReleaseVersion)("1.2.0-beta.")).toBeUndefined();
    });
});
(0, vitest_1.describe)("compareParsedReleaseVersions", () => {
    (0, vitest_1.it)("lets a caller parse once and compare against several ranges", () => {
        const current = (0, release_version_1.parseReleaseVersion)("1.4.0");
        const lower = (0, release_version_1.parseReleaseVersion)("1.0.0");
        const upper = (0, release_version_1.parseReleaseVersion)("2.0.0");
        (0, vitest_1.expect)(current).toBeDefined();
        (0, vitest_1.expect)(lower).toBeDefined();
        (0, vitest_1.expect)(upper).toBeDefined();
        if (current && lower && upper) {
            (0, vitest_1.expect)((0, release_version_1.compareParsedReleaseVersions)(current, lower)).toBe("newer");
            (0, vitest_1.expect)((0, release_version_1.compareParsedReleaseVersions)(current, upper)).toBe("older");
            (0, vitest_1.expect)((0, release_version_1.compareParsedReleaseVersions)(current, current)).toBe("same");
        }
    });
});
