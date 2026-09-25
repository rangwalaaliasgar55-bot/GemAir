"use strict";
/**
 * maintain-feature-requests.ts
 *
 * The Windows port of `iris-macos/leanring-buddy/MaintainFeatureRequests.swift`.
 *
 * The feature half of maintain mode. Bugs are found by watching; features are
 * found by LISTENING — the highest-signal, lowest-cost trigger is the user
 * simply saying what they wish an app did, while that app is in front. This
 * file does two small, honest things:
 *
 *   - recognizes a wish in a chat message ("I wish cue could…", "it should
 *     really…", "why can't this…") and pools it as a demand signal, keyed to
 *     a normalized signature so the same wish from many people adds up.
 *   - answers "what do people most want for this app" from the pool, so GemAir
 *     can proactively suggest a top request — but only at k>=5, enforced
 *     SERVER-side (`app/api/iris/feature-requests/route.ts`'s
 *     `MINIMUM_INSTALLS_FOR_PUBLIC`), so a suggestion is never one person's
 *     wish echoed back. This file does not re-enforce that floor locally —
 *     duplicating a server invariant client-side is how the two quietly drift.
 *
 * It never implements anything itself: a wish the user asks GemAir to build
 * runs through the SAME Tier C harness a novel fix does — jailed, bounded,
 * verified, forked. This file only turns talk into a pooled, ranked signal.
 *
 * The wire calls (`POST`/`GET /api/iris/feature-requests`) are NOT
 * reimplemented here — `pool-client.ts`'s `MaintainPoolClient.poolFeatureWish`
 * / `.topFeatureRequests` already own that HTTP round trip, error-swallowing
 * included, and its own header comments name this file as the one that
 * supplies the regex heuristics and the templated `request` text. This module
 * is the thin layer above that: recognize a wish, normalize it, compute the
 * signature the pool buckets it by, and hand the result to the pool client.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintainFeatureRequests = void 0;
exports.messageLooksLikeAFeatureWish = messageLooksLikeAFeatureWish;
exports.normalizedRequest = normalizedRequest;
const node_crypto_1 = require("node:crypto");
const break_signature_1 = require("./break-signature");
const pool_client_1 = require("./pool-client");
const trace_1 = require("./trace");
// ---------------------------------------------------------------------------
// Recognizing a wish
// ---------------------------------------------------------------------------
/**
 * Phrasings that mark a message as a feature wish rather than a question or a
 * bug report. Deliberately conservative — a false positive pools noise, and
 * the user is never interrupted by this, only offered. A byte-for-byte port
 * of Swift's `wishPatterns`: same seven shapes, same order, tested against
 * the RAW message (before normalization), matching Swift exactly.
 */
const WISH_PATTERNS = [
    /\bi wish (it|this|the app|\w+) (could|would|had)\b/i,
    /\bit should (really )?(be able to|have|let me|support)\b/i,
    /\bwhy (can't|cant|doesn't|doesnt) (it|this|the app)\b/i,
    /\bcan (it|this|you) (add|support|do)\b/i,
    /\bwould be (great|nice|amazing) if\b/i,
    /\b(please )?add (a|an|support for)\b/i,
    /\bfeature request\b/i,
];
/** True when a message reads like a feature wish about the app in front. */
function messageLooksLikeAFeatureWish(message) {
    return WISH_PATTERNS.some((pattern) => pattern.test(message));
}
/**
 * The wish-framing prefixes stripped from a normalized message, in the exact
 * order Swift's `normalizedRequest` tries them — only the FIRST matching
 * prefix is stripped (Swift's loop `break`s on the first hit), so ordering
 * here is a behavioral property, not incidental.
 */
const WISH_FRAMINGS = [
    "i wish it could ",
    "i wish this could ",
    "i wish the app could ",
    "it should really ",
    "it should ",
    "would be great if ",
    "would be nice if ",
    "please add ",
    "add support for ",
    "add a ",
    "add an ",
    "can you add ",
    "why can't it ",
    "why cant it ",
];
/**
 * Normalizes a wish to its identity: lowercased, stripped of the wish framing
 * and punctuation, so "I wish it could export to PDF" and "please add PDF
 * export" pool near each other. Reuses `break-signature.ts`'s `normalizeMessage`
 * for the PII/path/number stripping (the "reuse the break normalizer" this
 * module exists to cash out) — `normalizeMessage` already lowercases, so the
 * (lowercase) framing prefixes below match reliably regardless of the
 * message's original casing.
 */
function normalizedRequest(message) {
    let text = (0, break_signature_1.normalizeMessage)(message);
    for (const framing of WISH_FRAMINGS) {
        if (text.startsWith(framing)) {
            text = text.slice(framing.length);
            break;
        }
    }
    // Truncate THEN trim, matching Swift's `String(text.prefix(300)).trimmingCharacters(...)`
    // order exactly — `normalizeMessage` already caps at 300, so this second cap
    // only ever bites after the framing strip shortened things further.
    return text.slice(0, 300).trim();
}
/**
 * A stable 32-hex identity for one wish on one app — the pool's bucketing
 * key. Same shape as `lib/break-signature.ts`'s `computeBreakSignature`
 * (sha256, hex, first 32 chars) but over `"<appSlug>|feature|<normalized>"`,
 * matching Swift's private `MaintainFeatureRequests.signature(appSlug:
 * normalizedRequest:)` exactly. This is the wish's OWN signature, not an
 * existing break's — a feature wish need not follow a crash at all.
 */
function featureWishSignature(appSlug, normalizedRequestText) {
    return (0, node_crypto_1.createHash)("sha256")
        .update(`${appSlug}|feature|${normalizedRequestText}`)
        .digest("hex")
        .slice(0, 32);
}
// ---------------------------------------------------------------------------
// Pooling
// ---------------------------------------------------------------------------
/**
 * The feature-demand half of maintain mode. Owns wish recognition and
 * normalization; delegates every byte on the wire to an injected
 * `MaintainPoolClient` (defaults to a real one) and the install identity to
 * an injected `MaintainInstallIdentity` (required — mirrors Swift's
 * `init(installIdentity:)`, which has no default either).
 */
class MaintainFeatureRequests {
    poolClient;
    installIdentity;
    constructor(options) {
        this.poolClient = options.poolClient ?? new pool_client_1.MaintainPoolClient();
        this.installIdentity = options.installIdentity;
    }
    /**
     * Files a wish to the demand pool. Fire and forget, matching Swift's
     * `_ = try? await urlSession.data(for: request)`: a lost request costs the
     * pool one signal, nothing more — `MaintainPoolClient.poolFeatureWish`
     * already never throws, so there is nothing to catch here. Returns the
     * normalized text (even on a network failure) so the caller can acknowledge
     * it ("noted — I'll add your voice to the N people who want that"); `null`
     * only when the message normalized to nothing worth pooling.
     */
    async poolWish(message, appSlug) {
        const normalized = normalizedRequest(message);
        if (normalized.length === 0) {
            return null;
        }
        await this.poolClient.poolFeatureWish({
            appSlug,
            signature: featureWishSignature(appSlug, normalized),
            request: normalized,
            installId: this.installIdentity.currentInstallId(),
        });
        (0, trace_1.maintainTrace)(`pooled a feature wish for ${appSlug}`);
        return normalized;
    }
    /**
     * The top requests for an app, k>=5-gated server-side (see the file
     * header). For a proactive "most people who run this also wanted…"
     * suggestion. A miss and a network failure both read as an empty list —
     * `MaintainPoolClient.topFeatureRequests` already carries that contract.
     */
    async topRequests(appSlug) {
        return this.poolClient.topFeatureRequests(appSlug);
    }
}
exports.MaintainFeatureRequests = MaintainFeatureRequests;
