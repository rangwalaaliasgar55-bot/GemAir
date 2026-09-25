"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const model_provider_1 = require("../../lib/iris/services/maintain/model-provider");
const opencode_models_1 = require("../../lib/iris/services/opencode-models");
/**
 * The model maintain mode's Tier C (and Tier B's patch adapter) runs on.
 *
 * Upstream Iris made the reader bring a paid Anthropic or OpenAI key here, on
 * the rule that a funded proxy must never pay for the fix loop. GemAir has no
 * funded proxy and no paid key: both providers are free OpenCode routes, so
 * this file's tests keep upstream's properties — a provider that cannot run
 * says so instead of half-working, no credential is ever sent to a host it does
 * not belong to, every failure is wrapped rather than thrown raw, and one call
 * is bounded in time — against the two routes that actually exist.
 */
function recordingFetch(response = {}) {
    const calls = [];
    const fetchImplementation = async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body, method: init.method });
        return {
            ok: response.ok ?? true,
            status: response.status ?? 200,
            text: async () => response.body ?? JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
            headers: { get: () => response.retryAfter ?? null },
        };
    };
    return { fetchImplementation, calls };
}
const A_TURN = {
    systemPrompt: "you fix builds",
    conversation: [{ role: "user", text: "the build is red" }],
    maximumOutputTokens: 256,
};
(0, vitest_1.describe)("OpenCodeZenMaintainProvider", () => {
    (0, vitest_1.it)("is available to everybody, because the free route needs no key at all", () => {
        const { fetchImplementation } = recordingFetch();
        (0, vitest_1.expect)(new model_provider_1.OpenCodeZenMaintainProvider(() => null, fetchImplementation).isAvailable()).toBe(true);
        (0, vitest_1.expect)(new model_provider_1.OpenCodeZenMaintainProvider(() => "oc-key", fetchImplementation).isAvailable()).toBe(true);
    });
    (0, vitest_1.it)("is unavailable, and throws noCredential rather than pretending, with no fetch to call", async () => {
        const provider = new model_provider_1.OpenCodeZenMaintainProvider(() => null, null);
        (0, vitest_1.expect)(provider.isAvailable()).toBe(false);
        let thrown;
        try {
            await provider.respond(A_TURN);
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(model_provider_1.MaintainModelProviderFailure);
        (0, vitest_1.expect)(thrown.detail).toEqual({ kind: "noCredential" });
    });
    (0, vitest_1.it)("NEVER reaches a publik or Anthropic host — it posts to OpenCode Zen with a bearer token", async () => {
        const { fetchImplementation, calls } = recordingFetch();
        const provider = new model_provider_1.OpenCodeZenMaintainProvider(() => null, fetchImplementation);
        await provider.respond(A_TURN);
        (0, vitest_1.expect)(calls).toHaveLength(1);
        (0, vitest_1.expect)(new URL(calls[0].url).hostname).toBe("opencode.ai");
        (0, vitest_1.expect)(calls[0].headers.Authorization).toBe(`Bearer ${opencode_models_1.OPENCODE_PUBLIC_TOKEN}`);
        (0, vitest_1.expect)(JSON.stringify(calls[0])).not.toContain("publikhq.com");
        (0, vitest_1.expect)(JSON.stringify(calls[0])).not.toContain("anthropic.com");
    });
    (0, vitest_1.it)("sends the reader's own key when they have pasted one", async () => {
        const { fetchImplementation, calls } = recordingFetch();
        await new model_provider_1.OpenCodeZenMaintainProvider(() => "oc-reader-key", fetchImplementation).respond(A_TURN);
        (0, vitest_1.expect)(calls[0].headers.Authorization).toBe("Bearer oc-reader-key");
    });
    (0, vitest_1.it)("asks for a free model, and refuses to be built on one that is not", () => {
        (0, vitest_1.expect)((0, opencode_models_1.isFreeModelId)(model_provider_1.MAINTAIN_FREE_MODEL_ID)).toBe(true);
        (0, vitest_1.expect)(() => new model_provider_1.OpenCodeZenMaintainProvider(() => null, async () => ({}), 1000, "claude-opus-5")).toThrow();
    });
    (0, vitest_1.it)("sends the system prompt first and the conversation after it, in order", async () => {
        const { fetchImplementation, calls } = recordingFetch();
        await new model_provider_1.OpenCodeZenMaintainProvider(() => null, fetchImplementation).respond({
            systemPrompt: "you fix builds",
            conversation: [
                { role: "user", text: "first" },
                { role: "assistant", text: "second" },
                { role: "user", text: "third" },
            ],
            maximumOutputTokens: 64,
        });
        const body = JSON.parse(calls[0].body);
        (0, vitest_1.expect)((0, opencode_models_1.isFreeModelId)(body.model)).toBe(true);
        (0, vitest_1.expect)(body.max_tokens).toBe(64);
        (0, vitest_1.expect)(body.messages).toEqual([
            { role: "system", content: "you fix builds" },
            { role: "user", content: "first" },
            { role: "assistant", content: "second" },
            { role: "user", content: "third" },
        ]);
    });
    (0, vitest_1.it)("returns the assistant's text on a 200", async () => {
        const { fetchImplementation } = recordingFetch({
            body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "try clearing the cache" } }] }),
        });
        const answer = await new model_provider_1.OpenCodeZenMaintainProvider(() => null, fetchImplementation).respond(A_TURN);
        (0, vitest_1.expect)(answer).toBe("try clearing the cache");
    });
    (0, vitest_1.it)("wraps a non-2xx response into requestFailed with the status code and what it meant", async () => {
        const { fetchImplementation } = recordingFetch({ ok: false, status: 429, body: "{}" });
        let thrown;
        try {
            await new model_provider_1.OpenCodeZenMaintainProvider(() => null, fetchImplementation).respond(A_TURN);
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown.detail.kind).toBe("requestFailed");
        (0, vitest_1.expect)(thrown.detail.reason).toContain("429");
        (0, vitest_1.expect)(thrown.detail.reason).toContain("rateLimited");
    });
    (0, vitest_1.it)("wraps unparseable JSON into requestFailed rather than throwing a raw parse error", async () => {
        const { fetchImplementation } = recordingFetch({ body: "not json at all" });
        let thrown;
        try {
            await new model_provider_1.OpenCodeZenMaintainProvider(() => null, fetchImplementation).respond(A_TURN);
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(model_provider_1.MaintainModelProviderFailure);
        (0, vitest_1.expect)(thrown.detail.kind).toBe("requestFailed");
    });
    (0, vitest_1.it)("wraps a thrown network error into requestFailed", async () => {
        const provider = new model_provider_1.OpenCodeZenMaintainProvider(() => null, async () => {
            throw new Error("connection reset");
        });
        let thrown;
        try {
            await provider.respond(A_TURN);
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown.detail).toEqual({ kind: "requestFailed", reason: "connection reset" });
    });
    (0, vitest_1.it)("abandons a call that outruns its timeout instead of hanging the fix ladder", async () => {
        // Settles long after the 10ms bound (and keeps the loop alive meanwhile),
        // so the bound is what ends the call rather than the response.
        const slowFetch = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, text: async () => "{}" }), 400));
        const provider = new model_provider_1.OpenCodeZenMaintainProvider(() => null, slowFetch, 10);
        let thrown;
        try {
            await provider.respond(A_TURN);
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown.detail.kind).toBe("requestFailed");
        (0, vitest_1.expect)(thrown.detail.reason).toContain("didn't respond in time");
    });
    (0, vitest_1.it)("bounds the wait by default rather than leaving it open-ended", () => {
        (0, vitest_1.expect)(model_provider_1.DEFAULT_MAINTAIN_MODEL_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    });
});
(0, vitest_1.describe)("OpenCodeCliMaintainProvider", () => {
    (0, vitest_1.it)("is available only when there is both a backend to build and a CLI that probes true", () => {
        const backend = { respond: async () => "from the cli" };
        (0, vitest_1.expect)(new model_provider_1.OpenCodeCliMaintainProvider({ probeAvailability: () => true, createBackend: () => backend }).isAvailable()).toBe(true);
        (0, vitest_1.expect)(new model_provider_1.OpenCodeCliMaintainProvider({ probeAvailability: () => false, createBackend: () => backend }).isAvailable()).toBe(false);
        (0, vitest_1.expect)(new model_provider_1.OpenCodeCliMaintainProvider({ probeAvailability: () => true }).isAvailable()).toBe(false);
        (0, vitest_1.expect)(new model_provider_1.OpenCodeCliMaintainProvider().isAvailable()).toBe(false);
    });
    (0, vitest_1.it)("throws noCredential rather than spawning anything when the CLI is not there", async () => {
        let spawned = false;
        const provider = new model_provider_1.OpenCodeCliMaintainProvider({
            probeAvailability: () => false,
            createBackend: () => {
                spawned = true;
                return { respond: async () => "" };
            },
        });
        await (0, vitest_1.expect)(provider.respond(A_TURN)).rejects.toThrow();
        (0, vitest_1.expect)(spawned).toBe(false);
    });
    (0, vitest_1.it)("hands the turn to the backend in the backend's own shape", async () => {
        let seen;
        const provider = new model_provider_1.OpenCodeCliMaintainProvider({
            probeAvailability: () => true,
            createBackend: () => ({
                respond: async (request) => {
                    seen = request;
                    return "from the cli";
                },
            }),
        });
        (0, vitest_1.expect)(await provider.respond(A_TURN)).toBe("from the cli");
        (0, vitest_1.expect)(seen).toEqual({
            system: "you fix builds",
            messages: [{ role: "user", content: "the build is red" }],
            maxTokens: 256,
        });
    });
    (0, vitest_1.it)("wraps a backend failure into requestFailed", async () => {
        const provider = new model_provider_1.OpenCodeCliMaintainProvider({
            probeAvailability: () => true,
            createBackend: () => ({
                respond: async () => {
                    throw new Error("opencode exited 1");
                },
            }),
        });
        let thrown;
        try {
            await provider.respond(A_TURN);
        }
        catch (error) {
            thrown = error;
        }
        (0, vitest_1.expect)(thrown.detail).toEqual({ kind: "requestFailed", reason: "opencode exited 1" });
    });
});
(0, vitest_1.describe)("firstAvailableMaintainProvider", () => {
    (0, vitest_1.it)("prefers the reader's own CLI — their machine, their model, no network from here", () => {
        const provider = (0, model_provider_1.firstAvailableMaintainProvider)({
            probeOpenCodeCli: () => true,
            createOpenCodeCliBackend: () => ({ respond: async () => "" }),
            readOpenCodeApiKey: () => null,
            fetchImplementation: async () => ({}),
        });
        (0, vitest_1.expect)(provider).toBeInstanceOf(model_provider_1.OpenCodeCliMaintainProvider);
    });
    (0, vitest_1.it)("falls to the free Zen route when there is no CLI — the state upstream called 'no key' barely exists here", () => {
        const provider = (0, model_provider_1.firstAvailableMaintainProvider)({
            probeOpenCodeCli: () => false,
            readOpenCodeApiKey: () => null,
            fetchImplementation: async () => ({}),
        });
        (0, vitest_1.expect)(provider).toBeInstanceOf(model_provider_1.OpenCodeZenMaintainProvider);
    });
    (0, vitest_1.it)("returns undefined only when neither route can run at all", () => {
        (0, vitest_1.expect)((0, model_provider_1.firstAvailableMaintainProvider)({
            probeOpenCodeCli: () => false,
            readOpenCodeApiKey: () => null,
            fetchImplementation: null,
        })).toBeUndefined();
    });
});
