"use strict";
/**
 * pool-client.ts
 *
 * The Windows port of `iris-macos/leanring-buddy/MaintainPoolClient.swift`. This
 * is maintain mode's window onto the shared recipe pool: one GET that must
 * answer before any model token is spent, plus the POSTs that file what a user
 * confirmed, record an outcome, flag a bad recipe, log a fix, and pool a
 * feature wish.
 *
 * All of it speaks to publik's routing API — the same base URL every other
 * publik call in this app uses (`assistant-transport.ts`'s
 * `DEFAULT_PUBLIK_BASE_URL`, overridable exactly the way that module's caller
 * overrides it). No credentials ride along on any of these calls: every route
 * under `/api/iris/*` is CORS-open and rate-limited server-side by IP, not by
 * a bearer token. The BYO Anthropic key and the Supabase session never appear
 * in this file, or anywhere near it.
 *
 * Wire shapes are copied verbatim from `app/api/iris/*` (read directly, not
 * inferred) — no invented fields, no dropped validation. Every route in this
 * app's own JSON bodies is already camelCase (the server is Next.js, not a
 * snake_case backend), so unlike `account-service.ts` (which talks to
 * Supabase) there is no camelCase/snake_case boundary to cross here, with the
 * one deliberate exception of `topFrames[].is_app_frame`, which is left
 * snake_case because that is the literal key the intake route expects on the
 * wire — see `app/api/iris/breaks/route.ts`.
 *
 * Every network call in this file is not-throwing by design, matching the
 * Swift original's stance exactly: a pool lookup that fails is treated as a
 * pool that had nothing ("could not check" == "nothing found," because both
 * lead to the same next rung of the fix ladder), and a fire-and-forget POST
 * (outcome, fix-log) that fails costs the pool one data point, never the user
 * an error. `fetchImplementation` is injected (mirrors `FetchLike` in
 * `claude.ts` and `TokenFetchLike` in `account-service.ts`), so the whole file
 * is testable without a network and runs identically in the vitest suite on
 * macOS and on windows-latest CI.
 *
 * Build order (porting spec §6, tier 3): this file has exactly two internal
 * dependencies, `assistant-transport.ts` (for `DEFAULT_PUBLIK_BASE_URL`) and
 * `trace.ts`. It deliberately does NOT import `break-signature.ts` — the wire
 * vocabulary types below (`MaintainBreakAppStack`, `MaintainBreakSignatureKind`)
 * are declared locally instead. TypeScript's structural typing means
 * `break-signature.ts`'s own equivalents satisfy these without either file
 * importing the other, which keeps this transport layer buildable and testable
 * on its own, ahead of the signature/incident layers that depend on it. The
 * *strings* are the real contract (see the note on those types below), not the
 * type names.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintainPoolClient = exports.DEFAULT_MAINTAIN_POOL_BASE_URL = void 0;
const trace_1 = require("./trace");
/**
 * GemAir ships with NO recipe pool, and that is the whole difference from
 * upstream here.
 *
 * Iris pointed this client at publik's routing API, so every install shared one
 * company's server. GemAir has no such server and will not silently adopt
 * somebody else's: the default base URL is empty, which disables the client
 * entirely (every method then answers exactly as it does for an unreachable
 * pool — "nothing there"), and the fix ladder falls through to the rungs that
 * need no pool at all.
 *
 * A reader who wants a pool can self-host the same six routes and pass its base
 * URL in `poolBaseUrl`; nothing else in this file changes.
 */
exports.DEFAULT_MAINTAIN_POOL_BASE_URL = "";
/**
 * HTTP client for the shared maintain-mode recipe pool. Every method takes no
 * credential and needs none — see the file header. Construct one per app
 * lifetime; it holds nothing but the base URL and the fetch seam.
 */
class MaintainPoolClient {
    poolBaseUrl;
    fetchImplementation;
    constructor(options = {}) {
        this.poolBaseUrl = (options.poolBaseUrl ?? options.publikBaseUrl ?? exports.DEFAULT_MAINTAIN_POOL_BASE_URL).replace(/\/+$/, "");
        const injectedFetch = options.fetchImplementation ?? globalThis.fetch;
        // No base URL means no pool. Rather than sprinkle an `isEnabled` check
        // through nine methods (and risk the tenth forgetting it), the seam
        // itself refuses: every method already treats a failed call as "the
        // pool had nothing", which is precisely the intended behaviour.
        this.fetchImplementation = this.poolBaseUrl
            ? injectedFetch
            : async () => {
                throw new Error("no maintain-mode recipe pool is configured");
            };
    }
    /**
     * The cache lookup — step one of every incident, zero tokens spent. A
     * network failure or non-200 response returns an empty answer rather than
     * throwing: the ladder treats "could not check the pool" exactly like "pool
     * had nothing," because both mean the same next step for the caller.
     */
    async lookupRecipes(key) {
        const query = this.searchParams({
            app: key.appSlug,
            signature: key.signatureId ?? undefined,
            fs: key.fingerprintStrict ?? undefined,
            fl: key.fingerprintLoose ?? undefined,
        });
        const empty = { recipes: [], matchedBy: null };
        try {
            const response = await this.fetchImplementation(`${this.poolBaseUrl}/api/gemair/recipes?${query}`, {
                method: "GET",
            });
            if (!response.ok) {
                (0, trace_1.maintainTrace)(`recipe lookup got HTTP ${response.status} — treating as miss`);
                return empty;
            }
            const parsed = await this.parseJson(response);
            if (parsed === null || !Array.isArray(parsed.recipes))
                return empty;
            const matchedBy = parsed.matchedBy;
            return {
                recipes: parsed.recipes,
                matchedBy: matchedBy === "signature" || matchedBy === "fingerprint_strict" || matchedBy === "fingerprint_loose"
                    ? matchedBy
                    : null,
            };
        }
        catch (error) {
            (0, trace_1.maintainTrace)(`recipe lookup failed (${errorMessage(error)}) — treating as miss`);
            return empty;
        }
    }
    /**
     * The cold, human-facing search over the pool ("have we seen anything like
     * this?"), distinct from the hot exact-match `lookupRecipes` path above. Not
     * on the client-side fix ladder for M0–M9, but included here for
     * completeness rather than left as a gap — same not-throwing stance as
     * `lookupRecipes`, so it is safe to wire in later without a second failure
     * mode to design.
     */
    async searchRecipes(query = {}) {
        const empty = { recipes: [], count: 0 };
        const searchParams = this.searchParams({
            q: query.query,
            app: query.appSlug,
            stack: query.stack,
            kind: query.kind,
            type: query.recipeType,
            file: query.touchesFile,
        });
        try {
            const response = await this.fetchImplementation(`${this.poolBaseUrl}/api/gemair/recipes/search?${searchParams}`, {
                method: "GET",
            });
            if (!response.ok) {
                (0, trace_1.maintainTrace)(`recipe search got HTTP ${response.status} — treating as empty`);
                return empty;
            }
            const parsed = await this.parseJson(response);
            if (parsed === null || !Array.isArray(parsed.recipes))
                return empty;
            return {
                recipes: parsed.recipes,
                count: typeof parsed.count === "number" ? parsed.count : parsed.recipes.length,
            };
        }
        catch (error) {
            (0, trace_1.maintainTrace)(`recipe search failed (${errorMessage(error)}) — treating as empty`);
            return empty;
        }
    }
    /**
     * Files a confirmed break. Returns the created break id (and a recipe id
     * when a fix rode along), or `null` when the intake refused the request or
     * the network failed — the caller stages the filing locally and retries on
     * the next incident rather than looping here, matching Swift's contract on
     * `fileConfirmedBreak`.
     */
    async fileConfirmedBreak(filing) {
        try {
            const response = await this.fetchImplementation(`${this.poolBaseUrl}/api/gemair/breaks`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(filing),
            });
            if (response.status !== 201) {
                (0, trace_1.maintainTrace)(`break filing got HTTP ${response.status}`);
                return null;
            }
            const parsed = await this.parseJson(response);
            if (parsed === null || typeof parsed.breakId !== "string")
                return null;
            return {
                breakId: parsed.breakId,
                recipeId: typeof parsed.recipeId === "string" ? parsed.recipeId : null,
            };
        }
        catch (error) {
            (0, trace_1.maintainTrace)(`break filing failed (${errorMessage(error)})`);
            return null;
        }
    }
    /**
     * Records a recipe outcome under this install's pseudonymous id — the
     * signal that promotes a recipe across DISTINCT machines. Fire and forget,
     * exactly like Swift's `_ = try? await urlSession.data(for: request)`: an
     * outcome that never lands costs the pool one data point, never the user an
     * error. `installId` is optional but load-bearing: an outcome without it
     * bumps counters but can never promote a recipe (promotion needs distinct-
     * install successes).
     */
    async fileRecipeOutcome(recipeId, succeeded, installId) {
        try {
            await this.fetchImplementation(`${this.poolBaseUrl}/api/gemair/recipes/${encodeURIComponent(recipeId)}/outcome`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(installId ? { succeeded, installId } : { succeeded }),
            });
        }
        catch (error) {
            (0, trace_1.maintainTrace)(`recipe outcome post failed (${errorMessage(error)}) — dropped, not retried`);
        }
    }
    /**
     * Flags a recipe as bad. Unlike the outcome/fix-log posts this one DOES
     * surface its result: the caller's UI has something specific to say for
     * "you already flagged this today" versus "flag recorded."
     */
    async flagRecipe(recipeId) {
        try {
            const response = await this.fetchImplementation(`${this.poolBaseUrl}/api/gemair/recipes/${encodeURIComponent(recipeId)}/flag`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            if (response.status === 429) {
                return { kind: "alreadyFlaggedToday" };
            }
            if (!response.ok) {
                (0, trace_1.maintainTrace)(`recipe flag got HTTP ${response.status}`);
                return { kind: "requestFailed" };
            }
            const parsed = await this.parseJson(response);
            if (parsed === null || typeof parsed.status !== "string" || typeof parsed.flagCount !== "number") {
                return { kind: "requestFailed" };
            }
            return { kind: "recorded", status: parsed.status, flagCount: parsed.flagCount };
        }
        catch (error) {
            (0, trace_1.maintainTrace)(`recipe flag failed (${errorMessage(error)})`);
            return { kind: "requestFailed" };
        }
    }
    /**
     * Records that a fix reached the canonical repo, for the public fix log —
     * the listing's "here's what we fixed" surface. Fire and forget, exactly
     * like Swift's `recordFixLog`: the break-status flip to "fixed in vX" is the
     * release webhook's job, this is only the human-readable companion.
     */
    async recordFixLog(appSlug, diagnosisTitle, repo) {
        try {
            await this.fetchImplementation(`${this.poolBaseUrl}/api/gemair/fix-log`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ appSlug, title: diagnosisTitle, repo }),
            });
        }
        catch (error) {
            (0, trace_1.maintainTrace)(`fix-log post failed (${errorMessage(error)}) — dropped, not retried`);
        }
    }
    /**
     * Pools one feature wish against a break signature. Returns the created
     * request id, or `null` on refusal/network failure — same staged-for-retry
     * contract as `fileConfirmedBreak`. This is only the wire call: the regex
     * heuristics that decide a message "looks like a feature wish" and the
     * templating that produces `request` live in `maintain-feature-requests.ts`
     * (a separate porting task), not here.
     */
    async poolFeatureWish(input) {
        try {
            const response = await this.fetchImplementation(`${this.poolBaseUrl}/api/gemair/feature-requests`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
            });
            if (response.status !== 201) {
                (0, trace_1.maintainTrace)(`feature-request post got HTTP ${response.status}`);
                return null;
            }
            const parsed = await this.parseJson(response);
            if (parsed === null || typeof parsed.requestId !== "string")
                return null;
            return { requestId: parsed.requestId };
        }
        catch (error) {
            (0, trace_1.maintainTrace)(`feature-request post failed (${errorMessage(error)})`);
            return null;
        }
    }
    /**
     * The top pooled feature requests for an app — what GemAir can surface as
     * "most people who run this app also wanted X." A miss and a failure read
     * the same to the caller: an empty list. The server enforces the k≥5 public
     * floor (`MINIMUM_INSTALLS_FOR_PUBLIC`) — this file does not re-implement
     * that floor client-side, per porting spec §4 ("duplicating a server
     * invariant is how the two drift").
     */
    async topFeatureRequests(appSlug) {
        try {
            const response = await this.fetchImplementation(`${this.poolBaseUrl}/api/gemair/feature-requests?${this.searchParams({ app: appSlug })}`, { method: "GET" });
            if (!response.ok) {
                (0, trace_1.maintainTrace)(`feature-request lookup got HTTP ${response.status} — treating as empty`);
                return [];
            }
            const parsed = await this.parseJson(response);
            if (parsed === null || !Array.isArray(parsed.requests))
                return [];
            return parsed.requests;
        }
        catch (error) {
            (0, trace_1.maintainTrace)(`feature-request lookup failed (${errorMessage(error)}) — treating as empty`);
            return [];
        }
    }
    /** Query-string builder that drops `undefined`/empty values, so an absent
     *  optional key is genuinely absent from the URL rather than sent as the
     *  literal string `"undefined"`. */
    searchParams(params) {
        const searchParams = new URLSearchParams();
        for (const [name, value] of Object.entries(params)) {
            if (value !== undefined && value.length > 0)
                searchParams.set(name, value);
        }
        return searchParams.toString();
    }
    /** A response body that is not valid JSON is treated as absent rather than
     *  thrown — every caller above already has a "miss" value ready. */
    async parseJson(response) {
        try {
            const raw = await response.text();
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
}
exports.MaintainPoolClient = MaintainPoolClient;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
