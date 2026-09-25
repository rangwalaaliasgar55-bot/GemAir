"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const guide_service_1 = require("../../lib/iris/services/guide-service");
/**
 * The guides route answers with four different failures and they mean four
 * different things to the reader, so each must stay distinguishable all the way
 * to the panel. The Tauri panel this UI is transplanted from collapsed
 * 400/403/409 into "Guide service returned N"; this suite is what keeps the
 * Windows client from doing the same.
 *
 * Every test injects its own fetch. Nothing here touches the network.
 */
function respondWith(options) {
    const calls = [];
    const fetchImplementation = async (url) => {
        calls.push(url);
        return {
            ok: options.status >= 200 && options.status < 300,
            status: options.status,
            text: async () => options.body ?? "",
        };
    };
    return { fetchImplementation, calls };
}
const A_VALID_GUIDE = JSON.stringify({
    appSlug: "cue",
    appName: "Cue",
    version: 7,
    status: "published",
    branches: [{ platform: "windows", target: "desktop", steps: [] }],
});
(0, vitest_1.describe)("status codes map to four distinct failures", () => {
    vitest_1.it.each([
        [400, "invalidGuideVersionRequest"],
        [403, "guideIsNotPublished"],
        [404, "guideNotFound"],
        [409, "guideVersionIsNoLongerAvailable"],
    ])("maps HTTP %i to %s", async (status, expectedKind) => {
        const { fetchImplementation } = respondWith({ status });
        await (0, vitest_1.expect)((0, guide_service_1.fetchGuide)({ apiBase: "http://127.0.0.1:8787", slug: "cue", version: 7, fetchImplementation })).rejects.toThrowError(guide_service_1.GuideServiceError);
        try {
            await (0, guide_service_1.fetchGuide)({
                apiBase: "http://127.0.0.1:8787",
                slug: "cue",
                version: 7,
                fetchImplementation,
            });
        }
        catch (error) {
            (0, vitest_1.expect)(error.detail.kind).toBe(expectedKind);
        }
    });
    (0, vitest_1.it)("gives each of the four a different sentence", () => {
        const messages = [400, 403, 404, 409].map((status) => (0, guide_service_1.guideErrorMessage)((0, guide_service_1.guideFailureForStatusCode)(status, 7)));
        (0, vitest_1.expect)(new Set(messages).size).toBe(4);
    });
    (0, vitest_1.it)("carries the requested version into the 409 message, because that is the actionable part", () => {
        const detail = (0, guide_service_1.guideFailureForStatusCode)(409, 7);
        (0, vitest_1.expect)(detail).toEqual({ kind: "guideVersionIsNoLongerAvailable", requestedVersion: 7 });
        (0, vitest_1.expect)((0, guide_service_1.guideErrorMessage)(detail)).toContain("7");
    });
    (0, vitest_1.it)("falls back to a generic failure for a status the route does not document", () => {
        for (const status of [418, 500, 502, 503]) {
            (0, vitest_1.expect)((0, guide_service_1.guideFailureForStatusCode)(status, null)).toEqual({
                kind: "unexpectedResponseStatus",
                statusCode: status,
            });
        }
    });
});
(0, vitest_1.describe)("request building", () => {
    (0, vitest_1.it)("builds the documented URL and includes the version when there is one", () => {
        (0, vitest_1.expect)((0, guide_service_1.guideRequestUrl)({ apiBase: "http://127.0.0.1:8787", slug: "cue", version: 7 })).toBe("http://127.0.0.1:8787/api/gemair/guides/cue?version=7");
        (0, vitest_1.expect)((0, guide_service_1.guideRequestUrl)({ apiBase: "http://127.0.0.1:8787", slug: "cue", version: null })).toBe("http://127.0.0.1:8787/api/gemair/guides/cue");
    });
    (0, vitest_1.it)("actually sends that URL", async () => {
        const { fetchImplementation, calls } = respondWith({ status: 200, body: A_VALID_GUIDE });
        await (0, guide_service_1.fetchGuide)({
            apiBase: "http://127.0.0.1:8787",
            slug: "cue",
            version: 7,
            fetchImplementation,
        });
        (0, vitest_1.expect)(calls).toEqual(["http://127.0.0.1:8787/api/gemair/guides/cue?version=7"]);
    });
    (0, vitest_1.it)("only loads guides that ship with the app or come from a guide server on this machine", () => {
        (0, vitest_1.expect)((0, guide_service_1.normalizedApiBase)("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
        (0, vitest_1.expect)((0, guide_service_1.normalizedApiBase)("http://localhost:8787/")).toBe("http://localhost:8787");
        (0, vitest_1.expect)((0, guide_service_1.normalizedApiBase)("http://localhost:3000")).toBe("http://localhost:3000");
        (0, vitest_1.expect)((0, guide_service_1.normalizedApiBase)("https://evil.tld")).toBeNull();
        (0, vitest_1.expect)((0, guide_service_1.normalizedApiBase)("https://publikhq.com")).toBeNull();
        (0, vitest_1.expect)((0, guide_service_1.normalizedApiBase)("not a url")).toBeNull();
    });
    (0, vitest_1.it)("refuses a base URL that is neither bundled nor loopback", async () => {
        const { fetchImplementation, calls } = respondWith({ status: 200, body: A_VALID_GUIDE });
        await (0, vitest_1.expect)((0, guide_service_1.fetchGuide)({ apiBase: "https://evil.tld", slug: "cue", version: 7, fetchImplementation })).rejects.toThrowError(guide_service_1.GuideServiceError);
        // And crucially, never made the request.
        (0, vitest_1.expect)(calls).toEqual([]);
    });
});
(0, vitest_1.describe)("input validation happens before any request", () => {
    (0, vitest_1.it)("rejects an invalid slug without calling the network", async () => {
        const { fetchImplementation, calls } = respondWith({ status: 200, body: A_VALID_GUIDE });
        await (0, vitest_1.expect)((0, guide_service_1.fetchGuide)({
            apiBase: "http://127.0.0.1:8787",
            slug: "Cue/../etc",
            version: null,
            fetchImplementation,
        })).rejects.toThrowError(guide_service_1.GuideServiceError);
        (0, vitest_1.expect)(calls).toEqual([]);
    });
    (0, vitest_1.it)("rejects version 0 as a bad request rather than sending it", async () => {
        const { fetchImplementation, calls } = respondWith({ status: 200, body: A_VALID_GUIDE });
        try {
            await (0, guide_service_1.fetchGuide)({
                apiBase: "http://127.0.0.1:8787",
                slug: "cue",
                version: 0,
                fetchImplementation,
            });
            vitest_1.expect.unreachable("version 0 should be refused");
        }
        catch (error) {
            (0, vitest_1.expect)(error.detail.kind).toBe("invalidGuideVersionRequest");
        }
        (0, vitest_1.expect)(calls).toEqual([]);
    });
});
(0, vitest_1.describe)("the happy path and the shapes that are not quite right", () => {
    (0, vitest_1.it)("returns the decoded guide on 200", async () => {
        const { fetchImplementation } = respondWith({ status: 200, body: A_VALID_GUIDE });
        const guide = await (0, guide_service_1.fetchGuide)({
            apiBase: "http://127.0.0.1:8787",
            slug: "cue",
            version: 7,
            fetchImplementation,
        });
        (0, vitest_1.expect)(guide.appSlug).toBe("cue");
        (0, vitest_1.expect)(guide.version).toBe(7);
    });
    (0, vitest_1.it)("reports an undecodable body distinctly from an HTTP failure", async () => {
        const { fetchImplementation } = respondWith({ status: 200, body: "<html>oops</html>" });
        try {
            await (0, guide_service_1.fetchGuide)({
                apiBase: "http://127.0.0.1:8787",
                slug: "cue",
                version: null,
                fetchImplementation,
            });
            vitest_1.expect.unreachable("a non-JSON body should fail");
        }
        catch (error) {
            (0, vitest_1.expect)(error.detail.kind).toBe("responseCouldNotBeDecoded");
        }
    });
    (0, vitest_1.it)("reports a guide with no reviewed branches as its own state", async () => {
        const { fetchImplementation } = respondWith({
            status: 200,
            body: JSON.stringify({ appSlug: "cue", appName: "Cue", version: 1, branches: [] }),
        });
        try {
            await (0, guide_service_1.fetchGuide)({
                apiBase: "http://127.0.0.1:8787",
                slug: "cue",
                version: null,
                fetchImplementation,
            });
            vitest_1.expect.unreachable("an empty branch list should fail");
        }
        catch (error) {
            (0, vitest_1.expect)(error.detail.kind).toBe("guideHasNoBranches");
        }
    });
    (0, vitest_1.it)("treats a version the server silently swapped as a 409 in disguise", async () => {
        // Asking for v7 and being handed v9 is exactly what the 409 exists to
        // prevent; if the route ever stops enforcing it, the client still does.
        const { fetchImplementation } = respondWith({
            status: 200,
            body: JSON.stringify({
                appSlug: "cue",
                appName: "Cue",
                version: 9,
                branches: [{ platform: "windows" }],
            }),
        });
        try {
            await (0, guide_service_1.fetchGuide)({
                apiBase: "http://127.0.0.1:8787",
                slug: "cue",
                version: 7,
                fetchImplementation,
            });
            vitest_1.expect.unreachable("a swapped version should fail");
        }
        catch (error) {
            (0, vitest_1.expect)(error.detail.kind).toBe("guideVersionIsNoLongerAvailable");
        }
    });
    (0, vitest_1.it)("reports a network failure as a transport failure, not as a status", async () => {
        const fetchImplementation = vitest_1.vi.fn(async () => {
            throw new Error("ECONNREFUSED 127.0.0.1:8787");
        });
        try {
            await (0, guide_service_1.fetchGuide)({
                apiBase: "http://127.0.0.1:8787",
                slug: "cue",
                version: null,
                fetchImplementation,
            });
            vitest_1.expect.unreachable("a thrown fetch should fail");
        }
        catch (error) {
            const detail = error.detail;
            (0, vitest_1.expect)(detail.kind).toBe("transportFailure");
            (0, vitest_1.expect)((0, guide_service_1.guideErrorMessage)(detail)).toContain("could not read that guide");
        }
    });
});
