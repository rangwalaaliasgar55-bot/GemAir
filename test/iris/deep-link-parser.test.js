"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const deep_link_parser_1 = require("../../lib/iris/services/deep-link-parser");
/**
 * The rules under test are ported from `parse_guide_deep_link` in
 * `gemair-desktop/src-tauri/src/main.rs` (lines 188-285). The governing property
 * is that an unknown query parameter is REJECTED, never ignored — so a link
 * cannot smuggle in a field a later version of the app might start reading.
 */
function expectRejected(url) {
    const result = (0, deep_link_parser_1.parseIrisDeepLink)(url);
    (0, vitest_1.expect)(result.ok, `expected ${url} to be rejected`).toBe(false);
    return result.ok ? "" : result.rejection;
}
(0, vitest_1.describe)("guide deep links — the one link that works", () => {
    (0, vitest_1.it)("accepts a complete, valid guide link and reads every field off it", () => {
        const result = (0, deep_link_parser_1.parseIrisDeepLink)("gemair://guide/cue?version=7&branch=windows:desktop&step=3");
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (!result.ok)
            return;
        (0, vitest_1.expect)(result.link.kind).toBe("guide");
        if (result.link.kind !== "guide")
            return;
        (0, vitest_1.expect)(result.link.guide).toEqual({
            slug: "cue",
            version: 7,
            branch: "windows:desktop",
            step: 3,
        });
    });
    (0, vitest_1.it)("accepts the minimum: a slug and a version", () => {
        const result = (0, deep_link_parser_1.parseIrisDeepLink)("gemair://guide/lunara?version=1");
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (!result.ok || result.link.kind !== "guide")
            return;
        (0, vitest_1.expect)(result.link.guide).toEqual({ slug: "lunara", version: 1, branch: null, step: null });
    });
    (0, vitest_1.it)("accepts step 0 and step 500, the exact boundaries", () => {
        for (const step of [0, 500]) {
            const result = (0, deep_link_parser_1.parseIrisDeepLink)(`gemair://guide/cue?version=1&step=${step}`);
            (0, vitest_1.expect)(result.ok, `step=${step} should be accepted`).toBe(true);
        }
    });
    vitest_1.it.each(["macos:ios", "macos:android", "macos:desktop", "windows:ios", "windows:android", "windows:desktop"])("accepts the known branch %s", (branch) => {
        (0, vitest_1.expect)((0, deep_link_parser_1.parseIrisDeepLink)(`gemair://guide/cue?version=1&branch=${branch}`).ok).toBe(true);
    });
});
(0, vitest_1.describe)("guide deep links — unknown query parameters are refused outright", () => {
    (0, vitest_1.it)("rejects a parameter the app has never heard of", () => {
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&admin=true")).toBe("unsupported GemAir guide parameter");
    });
    (0, vitest_1.it)("rejects a plausible-looking future parameter rather than ignoring it", () => {
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&apiBase=https://evil.tld")).toBe("unsupported GemAir guide parameter");
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&token=abc")).toBe("unsupported GemAir guide parameter");
    });
    (0, vitest_1.it)("rejects a duplicated known parameter", () => {
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&version=2")).toBe("GemAir guide links accept only one version parameter");
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&branch=macos:ios&branch=windows:ios")).toBe("GemAir guide links accept only one branch parameter");
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&step=1&step=2")).toBe("GemAir guide links accept only one step parameter");
    });
});
(0, vitest_1.describe)("guide deep links — bad versions", () => {
    vitest_1.it.each([
        ["gemair://guide/cue?version=0", "invalid GemAir guide version"],
        ["gemair://guide/cue?version=-1", "invalid GemAir guide version"],
        ["gemair://guide/cue?version=1.5", "invalid GemAir guide version"],
        ["gemair://guide/cue?version=abc", "invalid GemAir guide version"],
        ["gemair://guide/cue?version=", "invalid GemAir guide version"],
        ["gemair://guide/cue?version=99999999999999", "invalid GemAir guide version"],
        ["gemair://guide/cue", "missing GemAir guide version"],
        ["gemair://guide/cue?branch=macos:ios", "missing GemAir guide version"],
    ])("rejects %s", (url, expectedRejection) => {
        (0, vitest_1.expect)(expectRejected(url)).toBe(expectedRejection);
    });
});
(0, vitest_1.describe)("guide deep links — bad steps and branches", () => {
    (0, vitest_1.it)("rejects a step past 500", () => {
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&step=501")).toBe("invalid GemAir guide step");
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&step=100000")).toBe("invalid GemAir guide step");
    });
    (0, vitest_1.it)("rejects a negative or non-numeric step", () => {
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&step=-1")).toBe("invalid GemAir guide step");
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1&step=three")).toBe("invalid GemAir guide step");
    });
    vitest_1.it.each([
        "linux:desktop",
        "macos:windows",
        "windows:web",
        "macos",
        "macos:",
        ":ios",
        "MACOS:IOS",
        "macos:ios:extra",
    ])("rejects the unknown branch %s", (branch) => {
        (0, vitest_1.expect)(expectRejected(`gemair://guide/cue?version=1&branch=${encodeURIComponent(branch)}`)).toBe("invalid GemAir guide branch");
    });
});
(0, vitest_1.describe)("guide deep links — bad slugs and hosts", () => {
    (0, vitest_1.it)("rejects a link with no slug at all", () => {
        (0, vitest_1.expect)(expectRejected("gemair://guide?version=1")).toBe("missing guide slug");
        (0, vitest_1.expect)(expectRejected("gemair://guide/?version=1")).toBe("missing guide slug");
    });
    (0, vitest_1.it)("rejects more than one path segment", () => {
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue/extra?version=1")).toBe("GemAir guide links require exactly one slug");
    });
    vitest_1.it.each(["Cue", "-cue", "cue-", "cue_extra", "cue extra", "cue%2Fextra", "cue.exe", "a".repeat(65)])("rejects the invalid slug %s", (slug) => {
        (0, vitest_1.expect)(expectRejected(`gemair://guide/${slug}?version=1`)).toBe("invalid GemAir guide slug");
    });
    (0, vitest_1.it)("rejects a non-guide host", () => {
        (0, vitest_1.expect)(expectRejected("gemair://settings/cue?version=1")).toBe("unsupported GemAir link");
        (0, vitest_1.expect)(expectRejected("gemair://evil.tld/cue?version=1")).toBe("unsupported GemAir link");
        (0, vitest_1.expect)(expectRejected("gemair://guides/cue?version=1")).toBe("unsupported GemAir link");
    });
    (0, vitest_1.it)("rejects a non-gemair scheme even when the rest is perfect", () => {
        (0, vitest_1.expect)(expectRejected("https://guide/cue?version=1")).toBe("unsupported GemAir link");
        (0, vitest_1.expect)(expectRejected("file://guide/cue?version=1")).toBe("unsupported GemAir link");
    });
    (0, vitest_1.it)("rejects embedded credentials, ports, and fragments", () => {
        (0, vitest_1.expect)(expectRejected("gemair://user:pass@guide/cue?version=1")).toBe("unsupported GemAir link");
        (0, vitest_1.expect)(expectRejected("gemair://guide:8080/cue?version=1")).toBe("unsupported GemAir link");
        (0, vitest_1.expect)(expectRejected("gemair://guide/cue?version=1#fragment")).toBe("unsupported GemAir link");
    });
    (0, vitest_1.it)("rejects gibberish that is not a URL at all", () => {
        (0, vitest_1.expect)(expectRejected("not a url")).toBe("unsupported GemAir link");
        (0, vitest_1.expect)(expectRejected("")).toBe("unsupported GemAir link");
    });
});
(0, vitest_1.describe)("gemair://auth/callback is its own link, distinct from a guide link", () => {
    (0, vitest_1.it)("parses a complete sign-in callback", () => {
        const result = (0, deep_link_parser_1.parseIrisDeepLink)("gemair://auth/callback?state=abc123&code=xyz789");
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (!result.ok)
            return;
        (0, vitest_1.expect)(result.link.kind).toBe("authCallback");
        if (result.link.kind !== "authCallback")
            return;
        (0, vitest_1.expect)(result.link.authCallback).toEqual({
            authorizationCode: "xyz789",
            opaqueStateToken: "abc123",
        });
    });
    (0, vitest_1.it)("is not mistaken for a guide link, and a guide link is not mistaken for it", () => {
        const authResult = (0, deep_link_parser_1.parseIrisDeepLink)("gemair://auth/callback?state=a&code=b");
        const guideResult = (0, deep_link_parser_1.parseIrisDeepLink)("gemair://guide/cue?version=1");
        (0, vitest_1.expect)(authResult.ok && authResult.link.kind).toBe("authCallback");
        (0, vitest_1.expect)(guideResult.ok && guideResult.link.kind).toBe("guide");
    });
    (0, vitest_1.it)("rejects a code with no state — the shape a CSRF attempt takes", () => {
        (0, vitest_1.expect)(expectRejected("gemair://auth/callback?code=xyz789")).toBe("incomplete GemAir sign-in link");
        (0, vitest_1.expect)(expectRejected("gemair://auth/callback?state=abc123")).toBe("incomplete GemAir sign-in link");
        (0, vitest_1.expect)(expectRejected("gemair://auth/callback")).toBe("incomplete GemAir sign-in link");
    });
    (0, vitest_1.it)("rejects an unknown parameter on the callback too", () => {
        (0, vitest_1.expect)(expectRejected("gemair://auth/callback?state=a&code=b&next=https://evil.tld")).toBe("unsupported GemAir sign-in parameter");
    });
    (0, vitest_1.it)("rejects a duplicated callback parameter", () => {
        (0, vitest_1.expect)(expectRejected("gemair://auth/callback?state=a&code=b&code=c")).toBe("GemAir sign-in links accept each parameter only once");
    });
    (0, vitest_1.it)("rejects control characters in a code, which is how a crafted link breaks a log line", () => {
        const withNewline = `gemair://auth/callback?state=a&code=${encodeURIComponent("b\ninjected")}`;
        (0, vitest_1.expect)(expectRejected(withNewline)).toBe("invalid GemAir sign-in value");
    });
    (0, vitest_1.it)("rejects any auth path that is not exactly /callback", () => {
        (0, vitest_1.expect)(expectRejected("gemair://auth/callback/extra?state=a&code=b")).toBe("unsupported GemAir link");
        (0, vitest_1.expect)(expectRejected("gemair://auth/token?state=a&code=b")).toBe("unsupported GemAir link");
        (0, vitest_1.expect)(expectRejected("gemair://auth?state=a&code=b")).toBe("unsupported GemAir link");
    });
});
(0, vitest_1.describe)("slug and branch predicates", () => {
    vitest_1.it.each(["cue", "lunara", "nut-ai", "a", "a1", "1a", "no-scroll-2"])("accepts the valid slug %s", (slug) => {
        (0, vitest_1.expect)((0, deep_link_parser_1.isValidGuideSlug)(slug)).toBe(true);
    });
    vitest_1.it.each(["", "-a", "a-", "A", "aA", "a_b", "a/b", "a".repeat(65)])("rejects the invalid slug %s", (slug) => {
        (0, vitest_1.expect)((0, deep_link_parser_1.isValidGuideSlug)(slug)).toBe(false);
    });
    (0, vitest_1.it)("accepts exactly the six known branch keys and nothing else", () => {
        const platforms = ["macos", "windows"];
        const targets = ["ios", "android", "desktop"];
        let accepted = 0;
        for (const platform of platforms) {
            for (const target of targets) {
                (0, vitest_1.expect)((0, deep_link_parser_1.isValidBranchKey)(`${platform}:${target}`)).toBe(true);
                accepted++;
            }
        }
        (0, vitest_1.expect)(accepted).toBe(6);
        (0, vitest_1.expect)((0, deep_link_parser_1.isValidBranchKey)("linux:desktop")).toBe(false);
    });
});
