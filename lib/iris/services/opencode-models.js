"use strict";
/**
 * opencode-models.js
 *
 * The free-model catalogue, and the gate that keeps GemAir on it.
 *
 * GemAir's Iris-derived assistant (companion chat, autopilot fix ladder,
 * maintain mode's Tier-C fixer) speaks to exactly one family of providers:
 * OpenCode. Two routes, both free to the person using them:
 *
 *   zen     POST https://opencode.ai/zen/v1/chat/completions   (hosted gateway)
 *   cli     the reader's own `opencode` binary                 (no HTTP here)
 *   server  POST http://127.0.0.1:<port>/v1/chat/completions   (`opencode serve`)
 *
 * THE PROPERTY THIS FILE EXISTS TO PROTECT: GemAir never spends anybody's
 * money. Upstream Iris had a metered route (publik API), a paid BYO route
 * (Anthropic) and a balance/top-up flow; all three are gone. What replaces the
 * "is there credit left" question is a much simpler one asked earlier — is this
 * model free? — and it is answered here, before a request is built, rather than
 * by a gateway after the fact.
 *
 * A model counts as free when either:
 *   1. its id ends in `-free`, which is OpenCode Zen's own marker, or
 *   2. it is named in `CURATED_FREE_MODEL_IDS` below — the ids OpenCode
 *      publishes as free that do not carry the suffix.
 *
 * Rule 1 is the durable one: Zen's free set rotates (promotional ids come and
 * go), so a hardcoded list alone would rot. Rule 2 exists because the most
 * capable free id of the moment — `big-pickle` — carries no suffix.
 * `refreshFreeModelIds` folds a live `GET /models` response into the set so a
 * new promotional id works the day it ships, and the catalogue that endpoint
 * returns carries ids only (no prices), which is exactly why rule 1 is what the
 * refresh leans on.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPENCODE_ZEN_HOST = void 0;
exports.OPENCODE_ZEN_BASE_URL = void 0;
exports.OPENCODE_PUBLIC_TOKEN = void 0;
exports.CURATED_FREE_MODEL_IDS = void 0;
exports.DEFAULT_FREE_MODEL = void 0;
exports.DEFAULT_FREE_VISION_MODEL = void 0;
exports.isFreeModelId = isFreeModelId;
exports.assertFreeModelId = assertFreeModelId;
exports.freeModelIdsFromCatalogue = freeModelIdsFromCatalogue;
exports.refreshFreeModelIds = refreshFreeModelIds;
exports.knownFreeModelIds = knownFreeModelIds;
exports.describeModel = describeModel;
exports.FreeModelRefusal = void 0;

/** The one host a GemAir OpenCode key may ever reach. */
const OPENCODE_ZEN_HOST = "opencode.ai";
exports.OPENCODE_ZEN_HOST = OPENCODE_ZEN_HOST;

/** OpenCode Zen's OpenAI-compatible base. */
const OPENCODE_ZEN_BASE_URL = `https://${OPENCODE_ZEN_HOST}/zen/v1`;
exports.OPENCODE_ZEN_BASE_URL = OPENCODE_ZEN_BASE_URL;

/**
 * The bearer token Zen accepts for its free ids when the reader has not signed
 * in and pasted one of their own. It is not a secret — it is the literal word
 * `public`, documented as such — so it is a constant here rather than anything
 * `secrets.js` needs to hold.
 */
const OPENCODE_PUBLIC_TOKEN = "public";
exports.OPENCODE_PUBLIC_TOKEN = OPENCODE_PUBLIC_TOKEN;

/**
 * Free ids that do not carry the `-free` suffix. Kept short on purpose: every
 * entry is a promise that this id costs the reader nothing, and a wrong entry
 * is the one bug this module exists to prevent.
 */
const CURATED_FREE_MODEL_IDS = Object.freeze([
  // Verified against https://opencode.ai/docs/zen/ (the pricing table lists it
  // as Free/Free) and https://opencode.ai/zen/v1/models on 2026-09-25. Every
  // other free id on Zen today carries the `-free` suffix and is admitted by
  // rule 1 without being named here.
  "big-pickle",
]);
exports.CURATED_FREE_MODEL_IDS = CURATED_FREE_MODEL_IDS;

/**
 * What chat asks for when nothing else is configured: a free, fast, multimodal
 * id served on the OpenAI-compatible `/chat/completions` endpoint. Multimodal
 * matters even for plain chat here, because the same model answers the
 * screenshot questions — see `DEFAULT_FREE_VISION_MODEL`.
 */
const DEFAULT_FREE_MODEL = "mimo-v2.6-flash-free";
exports.DEFAULT_FREE_MODEL = DEFAULT_FREE_MODEL;

/**
 * What the pointing pipeline asks for, because it sends screenshots. A
 * text-only model answers a screenshot prompt with an apology, which reads as
 * "the eye is broken" rather than "this model cannot see".
 */
const DEFAULT_FREE_VISION_MODEL = "mimo-v2.6-flash-free";
exports.DEFAULT_FREE_VISION_MODEL = DEFAULT_FREE_VISION_MODEL;

/**
 * Free ids that are NOT plain chat models, and so must never be offered as one.
 * They are free — the gate says yes to them, correctly — but they answer on a
 * different endpoint (`/systemone` for Jev's typed-question API, `/responses`
 * for the Muse Spark contributor ids), so picking one in the model field would
 * produce a confusing failure rather than an answer. `chatCapableFreeModelIds`
 * is what the picker shows; `isFreeModelId` deliberately still admits these,
 * because the question it answers is "does this cost money", not "can chat use
 * it".
 */
const NON_CHAT_FREE_MODEL_IDS = Object.freeze([
  "jev-1.13-free",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
]);
exports.NON_CHAT_FREE_MODEL_IDS = NON_CHAT_FREE_MODEL_IDS;

/**
 * The free ids this build knows about without asking the network — the picker's
 * offline contents, and the fallback when a catalogue refresh fails. Snapshot
 * of Zen's free line-up on 2026-09-25; the list is promotional and expected to
 * rot, which is what `refreshFreeModelIds` is for.
 */
const KNOWN_FREE_CHAT_MODEL_IDS = Object.freeze([
  "big-pickle",
  "space-bunny-free",
  "mimo-v2.6-flash-free",
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "deepseek-v4-flash-free",
]);
exports.KNOWN_FREE_CHAT_MODEL_IDS = KNOWN_FREE_CHAT_MODEL_IDS;

/** Ids learned from a live `GET /models`, folded in by `refreshFreeModelIds`. */
const learnedFreeModelIds = new Set();

/**
 * True when this id costs the reader nothing.
 *
 * Case- and whitespace-insensitive, and tolerant of a provider prefix
 * (`opencode/grok-code`, `zen/big-pickle`) because that is how OpenCode's own
 * config files spell a model.
 */
function isFreeModelId(candidate) {
  const id = normalizeModelId(candidate);
  if (!id) return false;
  if (id.endsWith("-free")) return true;
  if (CURATED_FREE_MODEL_IDS.includes(id)) return true;
  if (KNOWN_FREE_CHAT_MODEL_IDS.includes(id)) return true;
  return learnedFreeModelIds.has(id);
}

function normalizeModelId(candidate) {
  if (typeof candidate !== "string") return "";
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) return "";
  const lastSegment = trimmed.split("/").pop();
  return lastSegment || "";
}

/**
 * Thrown before a request is built when something asked for a model GemAir
 * cannot promise is free. Deliberately a refusal rather than a silent
 * substitution: quietly swapping a reader's chosen model for another one is how
 * a "free" app ends up billing somebody.
 */
class FreeModelRefusal extends Error {
  constructor(modelId) {
    super(
      `GemAir only uses free OpenCode models, and "${modelId}" is not one of them. ` +
        `Pick a free model — its id ends in "-free", or it is one of: ${CURATED_FREE_MODEL_IDS.join(", ")}. ` +
        `"${DEFAULT_FREE_MODEL}" is the one GemAir uses by default.`
    );
    this.name = "FreeModelRefusal";
    this.modelId = modelId;
  }
}
exports.FreeModelRefusal = FreeModelRefusal;

/** The gate every request builder goes through. Returns the id it approved. */
function assertFreeModelId(candidate) {
  if (!isFreeModelId(candidate)) throw new FreeModelRefusal(String(candidate ?? ""));
  return normalizeModelId(candidate);
}

/**
 * Reads a `GET /models` body (OpenAI's `{ data: [{ id, ... }] }`) and returns
 * the ids in it that are free. A model is free in the catalogue when it says so
 * — `"free": true`, a zero price, or the `-free` suffix — and anything
 * ambiguous is treated as paid, because the cost of a false positive here is
 * somebody's card.
 */
function freeModelIdsFromCatalogue(rawBody) {
  let parsed;
  try {
    parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray(parsed.data)
      ? parsed.data
      : [];

  const free = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const id = normalizeModelId(entry.id ?? entry.name ?? entry.model);
    if (!id) continue;
    if (id.endsWith("-free") || CURATED_FREE_MODEL_IDS.includes(id) || KNOWN_FREE_CHAT_MODEL_IDS.includes(id)) {
      free.push(id);
      continue;
    }
    if (entry.free === true) {
      free.push(id);
      continue;
    }
    const cost = entry.cost ?? entry.pricing ?? null;
    if (cost && typeof cost === "object") {
      const numbers = Object.values(cost).filter((value) => typeof value === "number");
      if (numbers.length > 0 && numbers.every((value) => value === 0)) free.push(id);
    }
  }
  return Array.from(new Set(free));
}

/** Folds a live catalogue into the gate. Returns the ids it learned. */
function refreshFreeModelIds(rawBody) {
  const learned = freeModelIdsFromCatalogue(rawBody);
  for (const id of learned) learnedFreeModelIds.add(id);
  return learned;
}

/** Everything the gate would say yes to right now. */
function knownFreeModelIds() {
  return Array.from(
    new Set([...CURATED_FREE_MODEL_IDS, ...KNOWN_FREE_CHAT_MODEL_IDS, ...learnedFreeModelIds])
  ).sort();
}

/**
 * What the model picker offers: everything free, minus the free ids that are
 * not chat models. The default is listed first so it is the obvious choice;
 * the rest are alphabetical.
 */
function chatCapableFreeModelIds() {
  const offered = knownFreeModelIds().filter((id) => !NON_CHAT_FREE_MODEL_IDS.includes(id));
  return [
    ...offered.filter((id) => id === DEFAULT_FREE_MODEL),
    ...offered.filter((id) => id !== DEFAULT_FREE_MODEL),
  ];
}
exports.chatCapableFreeModelIds = chatCapableFreeModelIds;

/** How a model is named to a reader: the id, and that it is free. */
function describeModel(modelId) {
  const id = normalizeModelId(modelId);
  return id ? `${id} (free)` : "a free OpenCode model";
}
