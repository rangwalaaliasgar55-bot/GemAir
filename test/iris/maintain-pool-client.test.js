"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const pool_client_1 = require("../../lib/iris/services/maintain/pool-client");
/** A scripted fetch that records every call it saw and answers with a queued
 *  response (or throws, for the network-failure cases). Mirrors the
 *  `tokenResponder` fixture shape in `tests/account-service.test.ts`. */
function scriptedFetch(responder) {
    const calls = [];
    const fetchImplementation = async (url, init) => {
        const call = {
            url,
            method: init.method,
            headers: init.headers ?? {},
            body: init.body,
        };
        calls.push(call);
        const outcome = responder(call);
        if (outcome === "throw")
            throw new Error("simulated network failure");
        return {
            ok: outcome.status >= 200 && outcome.status < 300,
            status: outcome.status,
            text: async () => outcome.body,
        };
    };
    return { fetchImplementation, calls };
}
/** GemAir ships with NO pool (`DEFAULT_MAINTAIN_POOL_BASE_URL` is empty, which
 *  disables the client outright), so every wire-shape test here points at the
 *  self-hosted base URL a reader would configure. */
const A_SELF_HOSTED_POOL = "http://127.0.0.1:8788";
function clientWith(responder) {
    const { fetchImplementation, calls } = scriptedFetch(responder);
    return {
        client: new pool_client_1.MaintainPoolClient({ fetchImplementation, poolBaseUrl: A_SELF_HOSTED_POOL }),
        calls,
    };
}
(0, vitest_1.describe)("MaintainPoolClient construction", () => {
    (0, vitest_1.it)("has no pool by default — no base URL, and not one call goes out", async () => {
        // The GemAir divergence: upstream defaulted to publik's routing API, so
        // every install shared one company's server. GemAir adopts nobody's
        // server silently; with no base URL the client answers exactly as an
        // unreachable pool does, and the fix ladder falls through.
        (0, vitest_1.expect)(pool_client_1.DEFAULT_MAINTAIN_POOL_BASE_URL).toBe("");
        const { fetchImplementation, calls } = scriptedFetch(() => ({
            status: 200,
            body: JSON.stringify({ recipes: [], matchedBy: null }),
        }));
        const defaultClient = new pool_client_1.MaintainPoolClient({ fetchImplementation });
        (0, vitest_1.expect)(await defaultClient.lookupRecipes({ appSlug: "cue" })).toEqual({ recipes: [], matchedBy: null });
        (0, vitest_1.expect)(calls).toHaveLength(0);
    });
    (0, vitest_1.it)("strips a trailing slash from a self-hosted base URL", async () => {
        const { fetchImplementation, calls } = scriptedFetch(() => ({
            status: 200,
            body: JSON.stringify({ recipes: [], matchedBy: null }),
        }));
        const overridden = new pool_client_1.MaintainPoolClient({
            fetchImplementation,
            poolBaseUrl: "https://pool.example.com///",
        });
        await overridden.lookupRecipes({ appSlug: "cue" });
        (0, vitest_1.expect)(calls[0].url.startsWith("https://pool.example.com/api/gemair/recipes?")).toBe(true);
    });
});
(0, vitest_1.describe)("lookupRecipes — the hot path", () => {
    (0, vitest_1.it)("sends app/signature/fs/fl as the query and passes a 200 payload through", async () => {
        const pooledRecipe = { id: "r1", appSlug: "cue", recipeType: "guidance" };
        const { client, calls } = clientWith(() => ({
            status: 200,
            body: JSON.stringify({ recipes: [pooledRecipe], matchedBy: "fingerprint_strict" }),
        }));
        const answer = await client.lookupRecipes({
            appSlug: "cue",
            signatureId: "sig-123",
            fingerprintStrict: "fs-abc",
            fingerprintLoose: "fl-xyz",
        });
        const url = new URL(calls[0].url);
        (0, vitest_1.expect)(calls[0].method).toBe("GET");
        (0, vitest_1.expect)(url.pathname).toBe("/api/gemair/recipes");
        (0, vitest_1.expect)(url.searchParams.get("app")).toBe("cue");
        (0, vitest_1.expect)(url.searchParams.get("signature")).toBe("sig-123");
        (0, vitest_1.expect)(url.searchParams.get("fs")).toBe("fs-abc");
        (0, vitest_1.expect)(url.searchParams.get("fl")).toBe("fl-xyz");
        (0, vitest_1.expect)(answer).toEqual({ recipes: [pooledRecipe], matchedBy: "fingerprint_strict" });
    });
    (0, vitest_1.it)("omits null/undefined optional fields from the query rather than sending the literal string 'undefined'", async () => {
        const { client, calls } = clientWith(() => ({ status: 200, body: JSON.stringify({ recipes: [], matchedBy: null }) }));
        await client.lookupRecipes({ appSlug: "cue", signatureId: null, fingerprintStrict: null, fingerprintLoose: null });
        const url = new URL(calls[0].url);
        (0, vitest_1.expect)(url.searchParams.has("signature")).toBe(false);
        (0, vitest_1.expect)(url.searchParams.has("fs")).toBe(false);
        (0, vitest_1.expect)(url.searchParams.has("fl")).toBe(false);
    });
    vitest_1.it.each([
        ["a non-200 status", { status: 404, body: "not found" }],
        ["a 200 with an unparseable body", { status: 200, body: "not json" }],
        ["a 200 body missing the recipes array", { status: 200, body: JSON.stringify({ matchedBy: "signature" }) }],
    ])("treats %s as a clean miss, never a throw", async (_label, response) => {
        const { client } = clientWith(() => response);
        await (0, vitest_1.expect)(client.lookupRecipes({ appSlug: "cue" })).resolves.toEqual({ recipes: [], matchedBy: null });
    });
    (0, vitest_1.it)("treats a network failure as a miss, not a throw", async () => {
        const { client } = clientWith(() => "throw");
        await (0, vitest_1.expect)(client.lookupRecipes({ appSlug: "cue" })).resolves.toEqual({ recipes: [], matchedBy: null });
    });
    (0, vitest_1.it)("collapses an unrecognized matchedBy value to null rather than passing it through", async () => {
        const { client } = clientWith(() => ({
            status: 200,
            body: JSON.stringify({ recipes: [], matchedBy: "something_new_the_client_does_not_know" }),
        }));
        const answer = await client.lookupRecipes({ appSlug: "cue" });
        (0, vitest_1.expect)(answer.matchedBy).toBeNull();
    });
});
(0, vitest_1.describe)("searchRecipes — cold, human-facing search", () => {
    (0, vitest_1.it)("maps the query fields to q/app/stack/kind/type/file", async () => {
        const { client, calls } = clientWith(() => ({ status: 200, body: JSON.stringify({ recipes: [], count: 0 }) }));
        await client.searchRecipes({
            query: "crashes on launch",
            appSlug: "cue",
            stack: "electron",
            kind: "native-crash",
            recipeType: "tier_b_patch",
            touchesFile: "src/main.ts",
        });
        const url = new URL(calls[0].url);
        (0, vitest_1.expect)(url.pathname).toBe("/api/gemair/recipes/search");
        (0, vitest_1.expect)(url.searchParams.get("q")).toBe("crashes on launch");
        (0, vitest_1.expect)(url.searchParams.get("app")).toBe("cue");
        (0, vitest_1.expect)(url.searchParams.get("stack")).toBe("electron");
        (0, vitest_1.expect)(url.searchParams.get("kind")).toBe("native-crash");
        (0, vitest_1.expect)(url.searchParams.get("type")).toBe("tier_b_patch");
        (0, vitest_1.expect)(url.searchParams.get("file")).toBe("src/main.ts");
    });
    (0, vitest_1.it)("falls back to recipes.length when the server omits count", async () => {
        const { client } = clientWith(() => ({
            status: 200,
            body: JSON.stringify({ recipes: [{ id: "a" }, { id: "b" }] }),
        }));
        const answer = await client.searchRecipes();
        (0, vitest_1.expect)(answer.count).toBe(2);
    });
    (0, vitest_1.it)("treats a failure as an empty result set, never a throw", async () => {
        const { client } = clientWith(() => "throw");
        await (0, vitest_1.expect)(client.searchRecipes()).resolves.toEqual({ recipes: [], count: 0 });
    });
});
(0, vitest_1.describe)("fileConfirmedBreak", () => {
    const filing = {
        appSlug: "cue",
        signature: "sig-123",
        appStack: "electron",
        signatureKind: "native-crash",
        algoVersion: 1,
        fingerprintStrict: "fs",
        fingerprintLoose: "fl",
        title: "Cue crashes on launch",
        protoSignature: "proto",
        topFrames: [{ module: "cue.exe", function: "main", file: "", is_app_frame: true }],
    };
    (0, vitest_1.it)("serializes the filing verbatim, including the deliberately snake_case is_app_frame key", async () => {
        const { client, calls } = clientWith(() => ({
            status: 201,
            body: JSON.stringify({ breakId: "break-1", recipeId: null }),
        }));
        await client.fileConfirmedBreak(filing);
        (0, vitest_1.expect)(calls[0].method).toBe("POST");
        (0, vitest_1.expect)(calls[0].headers["Content-Type"]).toBe("application/json");
        const sentBody = JSON.parse(calls[0].body ?? "{}");
        (0, vitest_1.expect)(sentBody).toEqual(filing);
        (0, vitest_1.expect)(sentBody.topFrames[0].is_app_frame).toBe(true);
        (0, vitest_1.expect)(Object.keys(sentBody.topFrames[0])).toContain("is_app_frame");
    });
    (0, vitest_1.it)("returns the break id, and a null recipe id when the response has none", async () => {
        const { client } = clientWith(() => ({ status: 201, body: JSON.stringify({ breakId: "break-1" }) }));
        await (0, vitest_1.expect)(client.fileConfirmedBreak(filing)).resolves.toEqual({ breakId: "break-1", recipeId: null });
    });
    (0, vitest_1.it)("returns the recipe id when a fix rode along and the server minted one", async () => {
        const { client } = clientWith(() => ({
            status: 201,
            body: JSON.stringify({ breakId: "break-1", recipeId: "recipe-9" }),
        }));
        await (0, vitest_1.expect)(client.fileConfirmedBreak(filing)).resolves.toEqual({ breakId: "break-1", recipeId: "recipe-9" });
    });
    vitest_1.it.each([
        ["the intake refuses with a non-201 status", { status: 422, body: "{}" }],
        ["the 201 body has no breakId", { status: 201, body: "{}" }],
    ])("returns null, staged for the caller to retry later, when %s", async (_label, response) => {
        const { client } = clientWith(() => response);
        await (0, vitest_1.expect)(client.fileConfirmedBreak(filing)).resolves.toBeNull();
    });
    (0, vitest_1.it)("returns null rather than throwing on a network failure", async () => {
        const { client } = clientWith(() => "throw");
        await (0, vitest_1.expect)(client.fileConfirmedBreak(filing)).resolves.toBeNull();
    });
});
(0, vitest_1.describe)("fileRecipeOutcome — fire and forget", () => {
    (0, vitest_1.it)("includes installId in the body when supplied", async () => {
        const { client, calls } = clientWith(() => ({ status: 200, body: "{}" }));
        await client.fileRecipeOutcome("recipe-1", true, "install-abc");
        (0, vitest_1.expect)(calls[0].url).toContain("/api/gemair/recipes/recipe-1/outcome");
        (0, vitest_1.expect)(JSON.parse(calls[0].body ?? "{}")).toEqual({ succeeded: true, installId: "install-abc" });
    });
    (0, vitest_1.it)("omits installId entirely when not supplied, rather than sending it as undefined/null", async () => {
        const { client, calls } = clientWith(() => ({ status: 200, body: "{}" }));
        await client.fileRecipeOutcome("recipe-1", false);
        const sentBody = JSON.parse(calls[0].body ?? "{}");
        (0, vitest_1.expect)(sentBody).toEqual({ succeeded: false });
        (0, vitest_1.expect)("installId" in sentBody).toBe(false);
    });
    (0, vitest_1.it)("URL-encodes the recipe id in the path", async () => {
        const { client, calls } = clientWith(() => ({ status: 200, body: "{}" }));
        await client.fileRecipeOutcome("recipe/with slash", true);
        (0, vitest_1.expect)(calls[0].url).toContain(encodeURIComponent("recipe/with slash"));
    });
    (0, vitest_1.it)("swallows a network failure silently — nothing to return, nothing thrown", async () => {
        const { client } = clientWith(() => "throw");
        await (0, vitest_1.expect)(client.fileRecipeOutcome("recipe-1", true)).resolves.toBeUndefined();
    });
});
(0, vitest_1.describe)("flagRecipe", () => {
    (0, vitest_1.it)("reports alreadyFlaggedToday on 429, distinct from a generic failure", async () => {
        const { client } = clientWith(() => ({ status: 429, body: JSON.stringify({ error: "already_flagged" }) }));
        await (0, vitest_1.expect)(client.flagRecipe("recipe-1")).resolves.toEqual({ kind: "alreadyFlaggedToday" });
    });
    (0, vitest_1.it)("reports the recorded flag count on success", async () => {
        const { client, calls } = clientWith(() => ({
            status: 200,
            body: JSON.stringify({ status: "flagged", flagCount: 3 }),
        }));
        await (0, vitest_1.expect)(client.flagRecipe("recipe-1")).resolves.toEqual({ kind: "recorded", status: "flagged", flagCount: 3 });
        (0, vitest_1.expect)(calls[0].body).toBe("{}");
    });
    vitest_1.it.each([
        ["a non-ok, non-429 status", { status: 500, body: "{}" }],
        ["a 200 with a malformed body", { status: 200, body: JSON.stringify({ status: "flagged" }) }],
    ])("reports requestFailed when %s", async (_label, response) => {
        const { client } = clientWith(() => response);
        await (0, vitest_1.expect)(client.flagRecipe("recipe-1")).resolves.toEqual({ kind: "requestFailed" });
    });
    (0, vitest_1.it)("reports requestFailed rather than throwing on a network failure", async () => {
        const { client } = clientWith(() => "throw");
        await (0, vitest_1.expect)(client.flagRecipe("recipe-1")).resolves.toEqual({ kind: "requestFailed" });
    });
});
(0, vitest_1.describe)("recordFixLog — fire and forget", () => {
    (0, vitest_1.it)("posts appSlug/title/repo and swallows any failure", async () => {
        const { client, calls } = clientWith(() => ({ status: 201, body: "{}" }));
        await client.recordFixLog("cue", "Fixed the launch crash", "Blueturboguy07/cue");
        (0, vitest_1.expect)(calls[0].url).toContain("/api/gemair/fix-log");
        (0, vitest_1.expect)(JSON.parse(calls[0].body ?? "{}")).toEqual({
            appSlug: "cue",
            title: "Fixed the launch crash",
            repo: "Blueturboguy07/cue",
        });
        const { client: throwingClient } = clientWith(() => "throw");
        await (0, vitest_1.expect)(throwingClient.recordFixLog("cue", "x", "y/z")).resolves.toBeUndefined();
    });
});
(0, vitest_1.describe)("poolFeatureWish", () => {
    (0, vitest_1.it)("returns the created request id on 201", async () => {
        const { client, calls } = clientWith(() => ({ status: 201, body: JSON.stringify({ requestId: "req-1" }) }));
        const result = await client.poolFeatureWish({
            appSlug: "cue",
            signature: "sig-1",
            request: "wants dark mode",
            installId: "install-1",
        });
        (0, vitest_1.expect)(result).toEqual({ requestId: "req-1" });
        (0, vitest_1.expect)(JSON.parse(calls[0].body ?? "{}").installId).toBe("install-1");
    });
    (0, vitest_1.it)("returns null, staged for retry, on refusal or network failure", async () => {
        const { client: refused } = clientWith(() => ({ status: 400, body: "{}" }));
        await (0, vitest_1.expect)(refused.poolFeatureWish({ appSlug: "cue", signature: "s", request: "r", installId: "i" })).resolves.toBeNull();
        const { client: failed } = clientWith(() => "throw");
        await (0, vitest_1.expect)(failed.poolFeatureWish({ appSlug: "cue", signature: "s", request: "r", installId: "i" })).resolves.toBeNull();
    });
});
(0, vitest_1.describe)("topFeatureRequests", () => {
    (0, vitest_1.it)("returns the pooled requests for an app", async () => {
        const requests = [{ id: "req-1", request: "dark mode", installs: 7, implementedCount: 0, referenceForkUrl: null }];
        const { client, calls } = clientWith(() => ({ status: 200, body: JSON.stringify({ requests }) }));
        await (0, vitest_1.expect)(client.topFeatureRequests("cue")).resolves.toEqual(requests);
        (0, vitest_1.expect)(new URL(calls[0].url).searchParams.get("app")).toBe("cue");
    });
    (0, vitest_1.it)("returns an empty list on a miss or a network failure, never a throw", async () => {
        const { client: missing } = clientWith(() => ({ status: 404, body: "{}" }));
        await (0, vitest_1.expect)(missing.topFeatureRequests("cue")).resolves.toEqual([]);
        const { client: failed } = clientWith(() => "throw");
        await (0, vitest_1.expect)(failed.topFeatureRequests("cue")).resolves.toEqual([]);
    });
});
