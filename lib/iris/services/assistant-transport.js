"use strict";
/**
 * assistant-transport.js
 *
 * Decides where a chat request goes, and is the single place in this subsystem
 * allowed to attach a credential to one.
 *
 * Ported from `iris-windows/src/services/assistant-transport.ts`, with every
 * paid and account-backed route removed. Upstream had three: publik's metered
 * gateway, the user's own Anthropic key, and the Codex CLI. GemAir has three
 * too, and all of them are free:
 *
 *   zen     ->  POST {base}/chat/completions   Authorization: Bearer <key|public>
 *               OpenCode Zen, free ids only (`opencode-models.js`).
 *   server  ->  POST {loopback}/chat/completions
 *               The reader's own `opencode serve`, on 127.0.0.1. No credential.
 *   cli     ->  the reader's own `opencode` binary. No network call from here.
 *
 * All three speak the OpenAI chat-completions wire format, so one response
 * parser (`model-chat.js`) serves all of them.
 *
 * THE TWO PROPERTIES THIS FILE PROTECTS:
 *
 *   1. A credential only ever reaches the host that issued it. An OpenCode key
 *      may reach opencode.ai and nothing else; the loopback route may carry no
 *      credential at all. Enforced structurally (each builder knows its own
 *      destination), by assertion (`validatedRequest` re-derives the pairing
 *      and refuses a mismatch), and by test.
 *
 *   2. Only free models are ever requested. `assertFreeModelId` runs while the
 *      request is being built, so "GemAir spent my money" is not a sentence
 *      this code can express. See `opencode-models.js`.
 */
Object.defineProperty(exports, "__esModule", { value: true });

const {
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_HOST,
  OPENCODE_PUBLIC_TOKEN,
  DEFAULT_FREE_MODEL,
  assertFreeModelId,
  FreeModelRefusal,
} = require("./opencode-models");

exports.OPENCODE_ZEN_HOST = OPENCODE_ZEN_HOST;
exports.OPENCODE_ZEN_BASE_URL = OPENCODE_ZEN_BASE_URL;
exports.DEFAULT_FREE_MODEL = DEFAULT_FREE_MODEL;

/** Hosts that belong to OpenCode. An OpenCode key may reach these and nothing else. */
const OPENCODE_HOSTS = new Set([OPENCODE_ZEN_HOST, `www.${OPENCODE_ZEN_HOST}`]);

function isOpenCodeHost(host) {
  return OPENCODE_HOSTS.has(String(host || "").toLowerCase());
}
exports.isOpenCodeHost = isOpenCodeHost;

/** Loopback, and only loopback: `opencode serve` is a local process. */
function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "[::1]";
}
exports.isLoopbackHost = isLoopbackHost;

/**
 * Every kind of credential this file can attach, and the only hosts each may
 * reach. `openCodeApiKey` is the reader's Zen key (or the public token).
 */
const PERMITTED_HOST_FOR_CREDENTIAL = {
  openCodeApiKey: (host) => isOpenCodeHost(host),
};

function credentialMayReachHost(credentialKind, host) {
  const rule = PERMITTED_HOST_FOR_CREDENTIAL[credentialKind];
  return typeof rule === "function" ? rule(String(host || "").toLowerCase()) : false;
}
exports.credentialMayReachHost = credentialMayReachHost;

/** Which provider the reader has chosen, as stored in settings. */
const PROVIDER_PREFERENCES = Object.freeze(["opencodeZen", "opencodeServer", "opencodeCli"]);
exports.PROVIDER_PREFERENCES = PROVIDER_PREFERENCES;

function isProviderPreference(candidate) {
  return PROVIDER_PREFERENCES.includes(candidate);
}
exports.isProviderPreference = isProviderPreference;

/** Every route picks its own model, so the field is always sent on HTTP routes. */
function shouldSendModelInRequestBody(transport) {
  return transport.tier === "zen" || transport.tier === "server";
}
exports.shouldSendModelInRequestBody = shouldSendModelInRequestBody;

/** The model to send when the caller has no better idea. */
function defaultModelForTransport(transport, configuredModel) {
  const candidate = configuredModel && configuredModel.trim() ? configuredModel.trim() : DEFAULT_FREE_MODEL;
  // A stale settings value naming a paid model must not become a paid request.
  return isFreeOrDefault(candidate);
}
exports.defaultModelForTransport = defaultModelForTransport;

function isFreeOrDefault(candidate) {
  try {
    return assertFreeModelId(candidate);
  } catch {
    return DEFAULT_FREE_MODEL;
  }
}

/** For UI that wants to name the route without pattern-matching on a secret. */
function tierDescription(transport) {
  switch (transport.tier) {
    case "zen":
      return "OpenCode Zen (free models)";
    case "server":
      return "your local opencode server";
    case "cli":
      return "your opencode CLI";
    default:
      return "an OpenCode route";
  }
}
exports.tierDescription = tierDescription;

/**
 * The Zen route.
 *
 * It takes a base URL because a reader may be pointed at a Zen mirror, and the
 * base is checked against the key's permitted hosts BEFORE the header is
 * written — so a hostile base URL cannot be used to exfiltrate the key.
 */
function zenChatRequest(apiKey, apiBaseUrl) {
  const base = openCodeBaseAllowedForAnOpenCodeKey(apiBaseUrl);
  return {
    url: `${base}/chat/completions`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey || OPENCODE_PUBLIC_TOKEN}`,
    },
    credentialKind: "openCodeApiKey",
  };
}

/**
 * The local-server route. It carries no credential at all, which is why it is
 * allowed a caller-supplied URL — but only a loopback one: a "local server"
 * pointed at the internet is just an unaudited proxy.
 */
function localServerChatRequest(baseUrl) {
  let host;
  let normalizedBase;
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    normalizedBase = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    throw new AssistantTransportFailure({
      kind: "transportFailure",
      reason: "the local opencode server address is not a valid URL",
    });
  }
  if (!isLoopbackHost(host)) {
    throw new AssistantTransportFailure({
      kind: "transportFailure",
      reason: "the local opencode server must be on 127.0.0.1",
    });
  }
  return {
    url: `${normalizedBase}/chat/completions`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentialKind: null,
  };
}

function openCodeBaseAllowedForAnOpenCodeKey(apiBaseUrl) {
  let destinationHost;
  try {
    destinationHost = new URL(apiBaseUrl).hostname;
  } catch {
    throw new AssistantTransportFailure({
      kind: "transportFailure",
      reason: "the OpenCode address is not a valid URL",
    });
  }
  if (!credentialMayReachHost("openCodeApiKey", destinationHost)) {
    throw new AssistantTransportFailure({
      kind: "credentialWouldLeaveItsHost",
      credentialKind: "openCodeApiKey",
      attemptedHost: destinationHost || "an unknown host",
    });
  }
  return String(apiBaseUrl).replace(/\/+$/, "");
}

/** `GET {base}/models`, so the free-model gate can learn today's free ids. */
function makeModelCatalogueRequest(transport) {
  if (transport.tier === "zen") {
    const base = openCodeBaseAllowedForAnOpenCodeKey(transport.apiBaseUrl || OPENCODE_ZEN_BASE_URL);
    return validatedRequest({
      url: `${base}/models`,
      method: "GET",
      headers: { Authorization: `Bearer ${transport.apiKey || OPENCODE_PUBLIC_TOKEN}` },
      credentialKind: "openCodeApiKey",
    });
  }
  if (transport.tier === "server") {
    const request = localServerChatRequest(transport.apiBaseUrl);
    return validatedRequest({
      url: request.url.replace(/\/chat\/completions$/, "/models"),
      method: "GET",
      headers: {},
      credentialKind: null,
    });
  }
  throw new AssistantTransportFailure({
    kind: "transportFailure",
    reason: "the opencode CLI route has no model catalogue endpoint",
  });
}
exports.makeModelCatalogueRequest = makeModelCatalogueRequest;

/**
 * Refuses any request whose credential and destination do not match.
 *
 * This duplicates what the builders above already guarantee, and that is the
 * point: a later refactor that merges them, adds a fourth route, or
 * "helpfully" copies headers between requests trips this instead of silently
 * shipping a key to a server that should never see it.
 */
function validatedRequest(candidate) {
  let destinationHost;
  try {
    destinationHost = new URL(candidate.url).hostname.toLowerCase();
  } catch {
    throw new AssistantTransportFailure({ kind: "transportFailure", reason: "malformed request URL" });
  }

  // Header lookup is case-insensitive: a refactor that writes "authorization"
  // must not be able to walk past this gate.
  const carriesAKeyHeader = Object.keys(candidate.headers || {}).some((headerName) => {
    const lowered = headerName.toLowerCase();
    return lowered === "authorization" || lowered === "x-api-key";
  });

  if (!candidate.credentialKind) {
    if (carriesAKeyHeader) {
      throw new AssistantTransportFailure({
        kind: "credentialWouldLeaveItsHost",
        credentialKind: "openCodeApiKey",
        attemptedHost: destinationHost || "an unknown host",
      });
    }
    return candidate;
  }

  if (!credentialMayReachHost(candidate.credentialKind, destinationHost)) {
    throw new AssistantTransportFailure({
      kind: "credentialWouldLeaveItsHost",
      credentialKind: candidate.credentialKind,
      attemptedHost: destinationHost || "an unknown host",
    });
  }

  return candidate;
}
exports.validatedRequest = validatedRequest;

/**
 * Produces the URL and headers for one chat request. The caller supplies the
 * body — identical on every HTTP route apart from `model`.
 *
 * `cli` has no prepared request: it runs a local binary rather than making an
 * HTTP call, so asking for one is a programming error rather than a user-facing
 * state.
 */
async function makeChatRequest(transport) {
  switch (transport.tier) {
    case "zen":
      return validatedRequest(
        zenChatRequest(transport.apiKey, transport.apiBaseUrl || OPENCODE_ZEN_BASE_URL)
      );
    case "server":
      return validatedRequest(localServerChatRequest(transport.apiBaseUrl));
    case "cli":
      throw new AssistantTransportFailure({
        kind: "transportFailure",
        reason: "the opencode CLI route does not make HTTP requests",
      });
    default:
      throw new AssistantTransportFailure({ kind: "noCredentialsAvailable" });
  }
}
exports.makeChatRequest = makeChatRequest;

/**
 * Picks the route for the current state of the app.
 *
 * An explicit preference is honoured even when another provider would work, and
 * a chosen provider that has become unusable is reported as ITSELF rather than
 * quietly falling through to a different one.
 *
 * With no preference stored the order is: a running local `opencode serve`
 * (fastest, most private), then the reader's `opencode` CLI, then Zen. Zen is
 * last and is always available — the public token means a fresh install can
 * answer a question before the reader has configured anything at all.
 */
function selectTransport(options) {
  const zenTransport = () => ({
    tier: "zen",
    apiKey: options.storedOpenCodeApiKey || OPENCODE_PUBLIC_TOKEN,
    apiBaseUrl: options.openCodeBaseUrl || OPENCODE_ZEN_BASE_URL,
  });

  const serverTransport = () =>
    options.localServerBaseUrl ? { tier: "server", apiBaseUrl: options.localServerBaseUrl } : null;

  const cliTransport = () => (options.cliIsAvailable ? { tier: "cli" } : null);

  if (options.preference) {
    const chosen =
      options.preference === "opencodeZen"
        ? zenTransport()
        : options.preference === "opencodeServer"
          ? serverTransport()
          : cliTransport();
    if (chosen) return chosen;
    throw new AssistantTransportFailure({
      kind: "chosenProviderUnavailable",
      preference: options.preference,
    });
  }

  const firstUsable = serverTransport() ?? cliTransport() ?? zenTransport();
  if (firstUsable) return firstUsable;

  throw new AssistantTransportFailure({ kind: "noCredentialsAvailable" });
}
exports.selectTransport = selectTransport;

// MARK: - Failures

class AssistantTransportFailure extends Error {
  constructor(detail) {
    super(userFacingMessage(detail));
    this.name = "AssistantTransportFailure";
    this.detail = detail;
  }
}
exports.AssistantTransportFailure = AssistantTransportFailure;

/** How each provider is named to a reader. */
function preferenceDescription(preference) {
  switch (preference) {
    case "opencodeZen":
      return "OpenCode Zen";
    case "opencodeServer":
      return "your local opencode server";
    case "opencodeCli":
      return "your opencode CLI";
    default:
      return "that provider";
  }
}
exports.preferenceDescription = preferenceDescription;

/**
 * What the panel shows. Lowercase to match the assistant's own voice in the
 * system prompt, which is what the same text area displays.
 */
function userFacingMessage(detail) {
  switch (detail.kind) {
    case "noCredentialsAvailable":
      return "i need a way to reach a model first — opencode zen is free and needs nothing, so turn it on in settings.";
    case "chosenProviderUnavailable":
      return `${preferenceDescription(detail.preference)} isn't working right now, and i won't quietly switch to something else. fix it in settings, or pick a different option there.`;
    case "modelIsNotFree":
      return `gemair only uses free opencode models, and "${detail.modelId}" isn't one. pick a free model in settings.`;
    case "openCodeKeyRejected":
      return "opencode turned that key down. check it in settings, or clear it — the free models work without one.";
    case "rateLimited":
      return `you've hit the free-tier limit for now. ${retryPhrase(detail.retryAfterSeconds)} or switch to your local opencode server in settings.`;
    case "assistantUnavailable":
      return "opencode is unavailable right now. this one isn't you — try again in a bit, or run `opencode serve` locally.";
    case "requestFailed":
      return "hm, something went wrong reaching the assistant. check your connection and try again.";
    case "cliUnavailable":
      return `i couldn't use your opencode cli: ${detail.reason}`;
    case "transportFailure":
      return "i couldn't reach the assistant. check your connection and try again.";
    case "credentialWouldLeaveItsHost":
      return "gemair stopped that request: a key was about to go somewhere it shouldn't.";
    default:
      return "something went wrong reaching the assistant.";
  }
}
exports.userFacingMessage = userFacingMessage;

/** True when the right response is to put the setup options back in front of
 *  the reader rather than just showing them a message. */
function requiresSetup(detail) {
  return (
    detail.kind === "noCredentialsAvailable" ||
    detail.kind === "chosenProviderUnavailable" ||
    detail.kind === "openCodeKeyRejected" ||
    detail.kind === "modelIsNotFree"
  );
}
exports.requiresSetup = requiresSetup;

/**
 * Upstream Iris answered a 402 with a top-up link. GemAir has no such state:
 * every route is free, so there is nothing to buy. Kept as a function that
 * always says no, so callers ported from upstream keep compiling and nobody
 * reintroduces a paywall by accident.
 */
function shouldOfferTopUp() {
  return false;
}
exports.shouldOfferTopUp = shouldOfferTopUp;

function retryPhrase(retryAfterSeconds) {
  if (retryAfterSeconds === null || retryAfterSeconds === undefined || retryAfterSeconds <= 0) {
    return "try again shortly,";
  }
  if (retryAfterSeconds < 90) return `try again in ${retryAfterSeconds} seconds,`;
  const retryAfterMinutes = Math.ceil(retryAfterSeconds / 60);
  if (retryAfterMinutes < 90) return `try again in about ${retryAfterMinutes} minutes,`;
  return `try again in about ${Math.ceil(retryAfterMinutes / 60)} hours,`;
}

/**
 * Turns one HTTP failure into the state the reader sees.
 *
 * The same status means different things on the two HTTP routes — a 401 from
 * Zen is "that key is bad", a 401 from a loopback server is a misconfigured
 * local proxy — so the route is part of the question, not something inferred
 * later.
 */
function failureForStatusCode(options) {
  const parsed = options.retryAfterHeaderValue
    ? Number.parseInt(String(options.retryAfterHeaderValue).trim(), 10)
    : Number.NaN;
  const retryAfterSeconds = Number.isFinite(parsed) ? parsed : null;
  const isZen = options.tier === "zen";

  switch (options.statusCode) {
    case 401:
    case 403:
      return isZen
        ? { kind: "openCodeKeyRejected" }
        : { kind: "requestFailed", statusCode: options.statusCode };
    case 402:
      // A free route answering "payment required" means the model was not free
      // after all. Say that, rather than offering to sell something.
      return { kind: "modelIsNotFree", modelId: modelIdFromBody(options.rawBody) };
    case 429:
      return { kind: "rateLimited", retryAfterSeconds };
    case 502:
    case 503:
    case 504:
      return { kind: "assistantUnavailable" };
    default:
      return { kind: "requestFailed", statusCode: options.statusCode };
  }
}
exports.failureForStatusCode = failureForStatusCode;

function modelIdFromBody(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const model = parsed?.error?.model ?? parsed?.model;
    return typeof model === "string" && model ? model : "that model";
  } catch {
    return "that model";
  }
}

exports.FreeModelRefusal = FreeModelRefusal;
