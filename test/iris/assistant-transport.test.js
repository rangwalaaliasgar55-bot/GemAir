"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const assistant_transport_1 = require("../../lib/iris/services/assistant-transport");
const opencode_models_1 = require("../../lib/iris/services/opencode-models");
/**
 * The transport layer, GemAir's version of it.
 *
 * Upstream Iris had four tiers — publik's funded gateway, a bring-your-own
 * Anthropic key, a Codex route and a local one — and most of that file's tests
 * were about keeping those credentials apart. GemAir has exactly one family of
 * routes (OpenCode Zen's free models, a local `opencode serve`, the `opencode`
 * CLI) and no paid tier at all, so the tests here keep the PROPERTIES upstream
 * cared about and drop the tiers that no longer exist:
 *
 *   1. A credential may only reach the host it belongs to, and the gate is
 *      checked before the header is written, not after.
 *   2. A chosen provider that stops working is reported as itself — GemAir
 *      never quietly switches the reader to a different one.
 *   3. Every route is free. A 402 means "that model was not free", never "buy
 *      something".
 */
(0, vitest_1.describe)("which credential may reach which host", () => {
    (0, vitest_1.it)("lets an OpenCode key reach OpenCode and nothing else", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.credentialMayReachHost)("openCodeApiKey", "opencode.ai")).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.credentialMayReachHost)("openCodeApiKey", "www.opencode.ai")).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.credentialMayReachHost)("openCodeApiKey", "api.anthropic.com")).toBe(false);
        (0, vitest_1.expect)((0, assistant_transport_1.credentialMayReachHost)("openCodeApiKey", "publikhq.com")).toBe(false);
        (0, vitest_1.expect)((0, assistant_transport_1.credentialMayReachHost)("openCodeApiKey", "opencode.ai.evil.tld")).toBe(false);
    });
    (0, vitest_1.it)("is case-insensitive about the host", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.credentialMayReachHost)("openCodeApiKey", "OpenCode.AI")).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.isOpenCodeHost)("OPENCODE.AI")).toBe(true);
    });
    (0, vitest_1.it)("knows a credential kind it has never heard of reaches nowhere", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.credentialMayReachHost)("anthropicApiKey", "api.anthropic.com")).toBe(false);
        (0, vitest_1.expect)((0, assistant_transport_1.credentialMayReachHost)("publikKey", "publikhq.com")).toBe(false);
    });
    (0, vitest_1.it)("counts only real loopback as local", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.isLoopbackHost)("127.0.0.1")).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.isLoopbackHost)("localhost")).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.isLoopbackHost)("127.0.0.1.evil.tld")).toBe(false);
        (0, vitest_1.expect)((0, assistant_transport_1.isLoopbackHost)("192.168.1.10")).toBe(false);
    });
});
(0, vitest_1.describe)("the Zen route", () => {
    (0, vitest_1.it)("posts to OpenCode Zen's chat/completions and nowhere else", async () => {
        const request = await (0, assistant_transport_1.makeChatRequest)({ tier: "zen", apiKey: "oc-key" });
        (0, vitest_1.expect)(request.url).toBe(`${opencode_models_1.OPENCODE_ZEN_BASE_URL}/chat/completions`);
        (0, vitest_1.expect)(new URL(request.url).hostname).toBe("opencode.ai");
        (0, vitest_1.expect)(request.method).toBe("POST");
    });
    (0, vitest_1.it)("attaches the key as a bearer token and declares which credential it is", async () => {
        const request = await (0, assistant_transport_1.makeChatRequest)({ tier: "zen", apiKey: "oc-key" });
        (0, vitest_1.expect)(request.headers.Authorization).toBe("Bearer oc-key");
        (0, vitest_1.expect)(request.credentialKind).toBe("openCodeApiKey");
    });
    (0, vitest_1.it)("falls back to the public token, because the free models need no account", async () => {
        const request = await (0, assistant_transport_1.makeChatRequest)({ tier: "zen" });
        (0, vitest_1.expect)(request.headers.Authorization).toBe(`Bearer ${opencode_models_1.OPENCODE_PUBLIC_TOKEN}`);
    });
    (0, vitest_1.it)("normalises a base URL that carries a trailing slash", async () => {
        const request = await (0, assistant_transport_1.makeChatRequest)({
            tier: "zen",
            apiKey: "oc-key",
            apiBaseUrl: "https://opencode.ai/zen/v1///",
        });
        (0, vitest_1.expect)(request.url).toBe("https://opencode.ai/zen/v1/chat/completions");
    });
    (0, vitest_1.it)("refuses a base URL that is not OpenCode's BEFORE writing the key", async () => {
        let thrown;
        try {
            await (0, assistant_transport_1.makeChatRequest)({ tier: "zen", apiKey: "oc-key", apiBaseUrl: "https://evil.tld/v1" });
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(assistant_transport_1.AssistantTransportFailure);
        (0, vitest_1.expect)(thrown.detail).toEqual({
            kind: "credentialWouldLeaveItsHost",
            credentialKind: "openCodeApiKey",
            attemptedHost: "evil.tld",
        });
        // And nothing about the key reached the message a reader sees.
        (0, vitest_1.expect)(thrown.message).not.toContain("oc-key");
    });
    (0, vitest_1.it)("refuses a base URL that is not a URL at all", async () => {
        await (0, vitest_1.expect)((0, assistant_transport_1.makeChatRequest)({ tier: "zen", apiBaseUrl: "not a url" })).rejects.toThrow();
    });
});
(0, vitest_1.describe)("the local-server route", () => {
    (0, vitest_1.it)("posts to the loopback server and carries no credential at all", async () => {
        const request = await (0, assistant_transport_1.makeChatRequest)({ tier: "server", apiBaseUrl: "http://127.0.0.1:4096/v1" });
        (0, vitest_1.expect)(request.url).toBe("http://127.0.0.1:4096/v1/chat/completions");
        (0, vitest_1.expect)(request.credentialKind).toBeNull();
        (0, vitest_1.expect)(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("authorization");
    });
    (0, vitest_1.it)("refuses a 'local server' that is actually on the internet", async () => {
        let thrown;
        try {
            await (0, assistant_transport_1.makeChatRequest)({ tier: "server", apiBaseUrl: "https://someone-elses-proxy.tld/v1" });
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(assistant_transport_1.AssistantTransportFailure);
        (0, vitest_1.expect)(thrown.detail.kind).toBe("transportFailure");
        (0, vitest_1.expect)(thrown.detail.reason).toContain("127.0.0.1");
    });
});
(0, vitest_1.describe)("the CLI route", () => {
    (0, vitest_1.it)("has no HTTP request to prepare, and says so rather than inventing one", async () => {
        await (0, vitest_1.expect)((0, assistant_transport_1.makeChatRequest)({ tier: "cli" })).rejects.toThrow();
        (0, vitest_1.expect)(() => (0, assistant_transport_1.makeModelCatalogueRequest)({ tier: "cli" })).toThrow();
    });
});
(0, vitest_1.describe)("validatedRequest — the second gate", () => {
    (0, vitest_1.it)("stops a credential-bearing request aimed at the wrong host", () => {
        (0, vitest_1.expect)(() => (0, assistant_transport_1.validatedRequest)({
            url: "https://evil.tld/v1/chat/completions",
            method: "POST",
            headers: { Authorization: "Bearer oc-key" },
            credentialKind: "openCodeApiKey",
        })).toThrow();
    });
    (0, vitest_1.it)("stops a request that claims to carry no credential while carrying a key header", () => {
        // Case-insensitive: a refactor that writes `authorization` must not walk past.
        (0, vitest_1.expect)(() => (0, assistant_transport_1.validatedRequest)({
            url: "http://127.0.0.1:4096/v1/chat/completions",
            method: "POST",
            headers: { authorization: "Bearer oc-key" },
            credentialKind: null,
        })).toThrow();
        (0, vitest_1.expect)(() => (0, assistant_transport_1.validatedRequest)({
            url: "http://127.0.0.1:4096/v1/chat/completions",
            method: "POST",
            headers: { "X-Api-Key": "oc-key" },
            credentialKind: null,
        })).toThrow();
    });
    (0, vitest_1.it)("lets the legitimate destination through the same gate", () => {
        const request = {
            url: `${opencode_models_1.OPENCODE_ZEN_BASE_URL}/chat/completions`,
            method: "POST",
            headers: { Authorization: "Bearer oc-key" },
            credentialKind: "openCodeApiKey",
        };
        (0, vitest_1.expect)((0, assistant_transport_1.validatedRequest)(request)).toBe(request);
    });
});
(0, vitest_1.describe)("the model catalogue request", () => {
    (0, vitest_1.it)("GETs Zen's /models with the key, so the free-model gate can refresh itself", () => {
        const request = (0, assistant_transport_1.makeModelCatalogueRequest)({ tier: "zen", apiKey: "oc-key" });
        (0, vitest_1.expect)(request.url).toBe(`${opencode_models_1.OPENCODE_ZEN_BASE_URL}/models`);
        (0, vitest_1.expect)(request.method).toBe("GET");
        (0, vitest_1.expect)(request.headers.Authorization).toBe("Bearer oc-key");
    });
    (0, vitest_1.it)("GETs the local server's /models with no credential", () => {
        const request = (0, assistant_transport_1.makeModelCatalogueRequest)({ tier: "server", apiBaseUrl: "http://localhost:4096/v1" });
        (0, vitest_1.expect)(request.url).toBe("http://localhost:4096/v1/models");
        (0, vitest_1.expect)(request.credentialKind).toBeNull();
    });
});
(0, vitest_1.describe)("picking a route", () => {
    (0, vitest_1.it)("prefers a running local server, then the CLI, then Zen", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.selectTransport)({ localServerBaseUrl: "http://127.0.0.1:4096/v1", cliIsAvailable: true }).tier).toBe("server");
        (0, vitest_1.expect)((0, assistant_transport_1.selectTransport)({ cliIsAvailable: true }).tier).toBe("cli");
        (0, vitest_1.expect)((0, assistant_transport_1.selectTransport)({}).tier).toBe("zen");
    });
    (0, vitest_1.it)("always has Zen to fall back on — a fresh install can answer before anything is configured", () => {
        const transport = (0, assistant_transport_1.selectTransport)({});
        (0, vitest_1.expect)(transport.apiKey).toBe(opencode_models_1.OPENCODE_PUBLIC_TOKEN);
        (0, vitest_1.expect)(transport.apiBaseUrl).toBe(opencode_models_1.OPENCODE_ZEN_BASE_URL);
    });
    vitest_1.it.each(["opencodeZen", "opencodeServer", "opencodeCli"])("honours %s when the reader has chosen it", (preference) => {
        const chosen = (0, assistant_transport_1.selectTransport)({
            preference,
            localServerBaseUrl: "http://127.0.0.1:4096/v1",
            cliIsAvailable: true,
        });
        (0, vitest_1.expect)(chosen.tier).toBe(preference === "opencodeZen" ? "zen" : preference === "opencodeServer" ? "server" : "cli");
    });
    (0, vitest_1.it)("reports a chosen provider that has stopped working as ITSELF, never switching quietly", () => {
        let thrown;
        try {
            // The CLI is chosen but gone — Zen would work, and is deliberately not used.
            (0, assistant_transport_1.selectTransport)({ preference: "opencodeCli", cliIsAvailable: false });
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(assistant_transport_1.AssistantTransportFailure);
        (0, vitest_1.expect)(thrown.detail).toEqual({ kind: "chosenProviderUnavailable", preference: "opencodeCli" });
        (0, vitest_1.expect)((0, assistant_transport_1.requiresSetup)(thrown.detail)).toBe(true);
    });
    (0, vitest_1.it)("offers exactly the three OpenCode providers and nothing paid", () => {
        (0, vitest_1.expect)(assistant_transport_1.PROVIDER_PREFERENCES).toEqual(["opencodeZen", "opencodeServer", "opencodeCli"]);
        for (const preference of assistant_transport_1.PROVIDER_PREFERENCES) {
            (0, vitest_1.expect)((0, assistant_transport_1.isProviderPreference)(preference)).toBe(true);
        }
        (0, vitest_1.expect)((0, assistant_transport_1.isProviderPreference)("publik")).toBe(false);
        (0, vitest_1.expect)((0, assistant_transport_1.isProviderPreference)("anthropic")).toBe(false);
    });
});
(0, vitest_1.describe)("the model a route sends", () => {
    (0, vitest_1.it)("defaults to a free model", () => {
        const model = (0, assistant_transport_1.defaultModelForTransport)({ tier: "zen" });
        (0, vitest_1.expect)(model).toBe(opencode_models_1.DEFAULT_FREE_MODEL);
        (0, vitest_1.expect)((0, opencode_models_1.isFreeModelId)(model)).toBe(true);
    });
    (0, vitest_1.it)("keeps a configured free model", () => {
        const free = (0, opencode_models_1.chatCapableFreeModelIds)()[0];
        (0, vitest_1.expect)((0, assistant_transport_1.defaultModelForTransport)({ tier: "zen" }, free)).toBe(free);
    });
    (0, vitest_1.it)("will not let a stale paid model in settings become a paid request", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.defaultModelForTransport)({ tier: "zen" }, "claude-opus-5")).toBe(opencode_models_1.DEFAULT_FREE_MODEL);
        (0, vitest_1.expect)((0, assistant_transport_1.defaultModelForTransport)({ tier: "zen" }, "   ")).toBe(opencode_models_1.DEFAULT_FREE_MODEL);
    });
    (0, vitest_1.it)("sends the model on both HTTP routes", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.shouldSendModelInRequestBody)({ tier: "zen" })).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.shouldSendModelInRequestBody)({ tier: "server" })).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.shouldSendModelInRequestBody)({ tier: "cli" })).toBe(false);
    });
});
(0, vitest_1.describe)("what an HTTP failure means", () => {
    (0, vitest_1.it)("reads a 401 from Zen as a rejected key and from a local server as a plain failure", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.failureForStatusCode)({ tier: "zen", statusCode: 401 })).toEqual({ kind: "openCodeKeyRejected" });
        (0, vitest_1.expect)((0, assistant_transport_1.failureForStatusCode)({ tier: "server", statusCode: 401 })).toEqual({
            kind: "requestFailed",
            statusCode: 401,
        });
    });
    (0, vitest_1.it)("reads a 402 as 'that model was not free', and NEVER offers to sell anything", () => {
        const detail = (0, assistant_transport_1.failureForStatusCode)({
            tier: "zen",
            statusCode: 402,
            rawBody: JSON.stringify({ error: { model: "claude-opus-5" } }),
        });
        (0, vitest_1.expect)(detail).toEqual({ kind: "modelIsNotFree", modelId: "claude-opus-5" });
        (0, vitest_1.expect)((0, assistant_transport_1.shouldOfferTopUp)()).toBe(false);
        (0, vitest_1.expect)((0, assistant_transport_1.userFacingMessage)(detail)).toContain("free opencode models");
        (0, vitest_1.expect)((0, assistant_transport_1.userFacingMessage)(detail)).not.toContain("top up");
    });
    (0, vitest_1.it)("names no model when the 402 body carries none", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.failureForStatusCode)({ tier: "zen", statusCode: 402, rawBody: "not json" })).toEqual({
            kind: "modelIsNotFree",
            modelId: "that model",
        });
    });
    (0, vitest_1.it)("carries Retry-After through a 429, and copes when it is missing or nonsense", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.failureForStatusCode)({ tier: "zen", statusCode: 429, retryAfterHeaderValue: "45" })).toEqual({
            kind: "rateLimited",
            retryAfterSeconds: 45,
        });
        (0, vitest_1.expect)((0, assistant_transport_1.failureForStatusCode)({ tier: "zen", statusCode: 429 })).toEqual({
            kind: "rateLimited",
            retryAfterSeconds: null,
        });
        (0, vitest_1.expect)((0, assistant_transport_1.failureForStatusCode)({ tier: "zen", statusCode: 429, retryAfterHeaderValue: "soon" })).toEqual({
            kind: "rateLimited",
            retryAfterSeconds: null,
        });
    });
    vitest_1.it.each([502, 503, 504])("reads %s as the assistant being down, not the reader's fault", (statusCode) => {
        const detail = (0, assistant_transport_1.failureForStatusCode)({ tier: "zen", statusCode });
        (0, vitest_1.expect)(detail).toEqual({ kind: "assistantUnavailable" });
        (0, vitest_1.expect)((0, assistant_transport_1.userFacingMessage)(detail)).toContain("this one isn't you");
    });
});
(0, vitest_1.describe)("what the reader is told", () => {
    (0, vitest_1.it)("phrases the rate limit with the wait when there is one", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.userFacingMessage)({ kind: "rateLimited", retryAfterSeconds: 30 })).toContain("30 seconds");
        (0, vitest_1.expect)((0, assistant_transport_1.userFacingMessage)({ kind: "rateLimited", retryAfterSeconds: 600 })).toContain("10 minutes");
        (0, vitest_1.expect)((0, assistant_transport_1.userFacingMessage)({ kind: "rateLimited", retryAfterSeconds: null })).toContain("shortly");
    });
    (0, vitest_1.it)("names the provider the reader chose when it is the thing that broke", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.userFacingMessage)({ kind: "chosenProviderUnavailable", preference: "opencodeServer" })).toContain("local opencode server");
        (0, vitest_1.expect)((0, assistant_transport_1.preferenceDescription)("opencodeZen")).toBe("OpenCode Zen");
    });
    (0, vitest_1.it)("says which states put the setup options back in front of the reader", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.requiresSetup)({ kind: "noCredentialsAvailable" })).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.requiresSetup)({ kind: "openCodeKeyRejected" })).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.requiresSetup)({ kind: "modelIsNotFree", modelId: "x" })).toBe(true);
        (0, vitest_1.expect)((0, assistant_transport_1.requiresSetup)({ kind: "rateLimited", retryAfterSeconds: null })).toBe(false);
        (0, vitest_1.expect)((0, assistant_transport_1.requiresSetup)({ kind: "requestFailed", statusCode: 500 })).toBe(false);
    });
    (0, vitest_1.it)("never leaks a key or a host into the leak-prevention message itself", () => {
        const message = (0, assistant_transport_1.userFacingMessage)({
            kind: "credentialWouldLeaveItsHost",
            credentialKind: "openCodeApiKey",
            attemptedHost: "evil.tld",
        });
        (0, vitest_1.expect)(message).not.toContain("evil.tld");
        (0, vitest_1.expect)(message).toContain("stopped that request");
    });
    (0, vitest_1.it)("describes each route in words a reader can act on", () => {
        (0, vitest_1.expect)((0, assistant_transport_1.tierDescription)({ tier: "zen" })).toContain("free");
        (0, vitest_1.expect)((0, assistant_transport_1.tierDescription)({ tier: "server" })).toContain("local");
        (0, vitest_1.expect)((0, assistant_transport_1.tierDescription)({ tier: "cli" })).toContain("CLI");
    });
});
