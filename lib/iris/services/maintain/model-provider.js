"use strict";
/**
 * model-provider.js
 *
 * Ported from `iris-windows/src/services/maintain/model-provider.ts` (itself a
 * port of `iris-macos/leanring-buddy/MaintainModelProvider.swift`).
 *
 * Tier C — and Tier B's patch adapter in `replay-engine.js` — runs on a model.
 * Upstream made the reader bring their own paid key (Anthropic or OpenAI) for
 * it, on the rule that a funded proxy must never pay for the fix loop. GemAir
 * has no funded proxy and no paid key: both providers below are free OpenCode
 * routes, and the free-model gate in `opencode-models.js` is what replaces the
 * "never spend the reader's money" rule that used to be enforced by refusing to
 * use anybody's credit.
 *
 *   zen   the hosted OpenCode Zen gateway, free ids only. Works with no
 *         configuration at all (the public token), and with the reader's own
 *         free-tier key when they have pasted one.
 *   cli   the reader's own `opencode` binary, which owns whatever they signed
 *         it into. No credential is read, written, or held here.
 *
 * The whole interface is one turn: a system prompt and a conversation history
 * in, one assistant text turn out. The ReAct loop that drives Tier C's actual
 * back-and-forth lives in `tier-c-fixer.js`, not here.
 *
 * WHY THIS FILE NEVER TOUCHES A SECRET AT REST: `main/secrets.js` is the only
 * code allowed to read one, and it lives in `main/` (Electron APIs, side
 * effects) — a layer `services/` must not depend on. So credential access here
 * is a plain `() => string | null` the caller injects, exactly like every other
 * OS-touching capability in this codebase.
 */
Object.defineProperty(exports, "__esModule", { value: true });

const { makeChatRequest, failureForStatusCode } = require("../assistant-transport");
const {
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_PUBLIC_TOKEN,
  DEFAULT_FREE_MODEL,
  assertFreeModelId,
} = require("../opencode-models");
const { readAssistantText } = require("../model-chat");

/**
 * The ceiling on how long one model call may take before it is abandoned. Every
 * other wait in the autopilot design is explicitly bounded; this was the one
 * unbounded await, sitting directly in the failure-recovery path a hung TCP
 * connection could freeze the whole fix ladder on.
 */
const DEFAULT_MAINTAIN_MODEL_REQUEST_TIMEOUT_MS = 120000;
exports.DEFAULT_MAINTAIN_MODEL_REQUEST_TIMEOUT_MS = DEFAULT_MAINTAIN_MODEL_REQUEST_TIMEOUT_MS;

class MaintainModelRequestTimeout extends Error {}

/**
 * Bounds `work` to `timeoutMilliseconds`. A non-positive/non-finite timeout
 * means "no bound". The timer is `unref`'d where the runtime supports it, so a
 * pending bound never by itself keeps the process alive.
 */
function withRequestTimeout(work, timeoutMilliseconds) {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) return work;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new MaintainModelRequestTimeout(
          `the model did not respond within ${timeoutMilliseconds}ms`
        )
      );
    }, timeoutMilliseconds);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** The `requestFailed` reason for a call that outran its timeout. */
function requestFailureReason(error) {
  if (error instanceof MaintainModelRequestTimeout) return "the model didn't respond in time";
  return error instanceof Error ? error.message : String(error);
}

class MaintainModelProviderFailure extends Error {
  constructor(detail) {
    super(
      detail.kind === "noCredential"
        ? "no free OpenCode route is available for this model provider"
        : `maintain-mode model request failed: ${detail.reason}`
    );
    this.name = "MaintainModelProviderFailure";
    this.detail = detail;
  }
}
exports.MaintainModelProviderFailure = MaintainModelProviderFailure;

/**
 * The model maintain mode asks Zen for. A coding-tuned free id, because every
 * caller of this interface is reading source and writing diffs.
 */
const MAINTAIN_FREE_MODEL_ID = DEFAULT_FREE_MODEL;
exports.MAINTAIN_FREE_MODEL_ID = MAINTAIN_FREE_MODEL_ID;

// ---------------------------------------------------------------------------
// OpenCode Zen (free ids, hosted)
// ---------------------------------------------------------------------------

class OpenCodeZenMaintainProvider {
  /**
   * @param {() => (string|null)} readOpenCodeApiKey the reader's Zen key, or null
   *        for the public token. Either way the route is free.
   * @param {Function} [fetchImplementation]
   * @param {number} [requestTimeoutMilliseconds]
   * @param {string} [modelId] a FREE model id
   */
  constructor(
    readOpenCodeApiKey,
    fetchImplementation = globalThis.fetch,
    requestTimeoutMilliseconds = DEFAULT_MAINTAIN_MODEL_REQUEST_TIMEOUT_MS,
    modelId = MAINTAIN_FREE_MODEL_ID
  ) {
    this.displayName = "OpenCode Zen (free)";
    this.readOpenCodeApiKey = readOpenCodeApiKey || (() => null);
    this.fetchImplementation = fetchImplementation;
    this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.modelId = assertFreeModelId(modelId);
  }

  /**
   * Always true when there is a fetch to make the call with. This is the
   * substantive difference from upstream: the free route needs no credential,
   * so maintain mode is available to everybody rather than only to readers who
   * brought a paid key.
   */
  isAvailable() {
    return typeof this.fetchImplementation === "function";
  }

  async respond(options) {
    if (!this.isAvailable()) {
      throw new MaintainModelProviderFailure({ kind: "noCredential" });
    }

    const transport = {
      tier: "zen",
      apiKey: this.readOpenCodeApiKey() || OPENCODE_PUBLIC_TOKEN,
      apiBaseUrl: OPENCODE_ZEN_BASE_URL,
    };

    let preparedRequest;
    try {
      preparedRequest = await makeChatRequest(transport);
    } catch (error) {
      throw new MaintainModelProviderFailure({
        kind: "requestFailed",
        reason: requestFailureReason(error),
      });
    }

    const body = {
      model: this.modelId,
      max_tokens: options.maximumOutputTokens,
      messages: [
        { role: "system", content: options.systemPrompt },
        ...options.conversation.map((turn) => ({
          role: turn.role === "assistant" ? "assistant" : "user",
          content: turn.text,
        })),
      ],
      stream: false,
    };

    let response;
    try {
      response = await withRequestTimeout(
        this.fetchImplementation(preparedRequest.url, {
          method: preparedRequest.method,
          headers: preparedRequest.headers,
          body: JSON.stringify(body),
        }),
        this.requestTimeoutMilliseconds
      );
    } catch (error) {
      throw new MaintainModelProviderFailure({
        kind: "requestFailed",
        reason: requestFailureReason(error),
      });
    }

    let rawBody;
    try {
      rawBody = await withRequestTimeout(response.text(), this.requestTimeoutMilliseconds);
    } catch (error) {
      throw new MaintainModelProviderFailure({
        kind: "requestFailed",
        reason: requestFailureReason(error),
      });
    }

    if (!response.ok) {
      const detail = failureForStatusCode({
        statusCode: response.status,
        rawBody,
        retryAfterHeaderValue: response.headers?.get?.("Retry-After") ?? null,
        tier: "zen",
      });
      throw new MaintainModelProviderFailure({
        kind: "requestFailed",
        reason: `HTTP ${response.status} (${detail.kind})`,
      });
    }

    try {
      return readAssistantText(rawBody);
    } catch (error) {
      throw new MaintainModelProviderFailure({
        kind: "requestFailed",
        reason: requestFailureReason(error),
      });
    }
  }
}
exports.OpenCodeZenMaintainProvider = OpenCodeZenMaintainProvider;

// ---------------------------------------------------------------------------
// The reader's own `opencode` CLI
// ---------------------------------------------------------------------------

/**
 * The CLI, behind the same one-turn interface. The backend is injected rather
 * than imported, because `main/opencode-session.js` spawns a process and this
 * file must stay reachable from a unit suite with no child processes in it.
 */
class OpenCodeCliMaintainProvider {
  constructor(options = {}) {
    this.displayName = "opencode CLI (your machine)";
    this.probeAvailability = options.probeAvailability || (() => false);
    this.createBackend = options.createBackend || null;
    this.requestTimeoutMilliseconds =
      options.requestTimeoutMilliseconds ?? DEFAULT_MAINTAIN_MODEL_REQUEST_TIMEOUT_MS;
  }

  isAvailable() {
    return Boolean(this.createBackend) && this.probeAvailability() === true;
  }

  async respond(options) {
    if (!this.isAvailable()) {
      throw new MaintainModelProviderFailure({ kind: "noCredential" });
    }
    const backend = this.createBackend();
    try {
      return await withRequestTimeout(
        backend.respond({
          system: options.systemPrompt,
          messages: options.conversation.map((turn) => ({
            role: turn.role,
            content: turn.text,
          })),
          maxTokens: options.maximumOutputTokens,
        }),
        this.requestTimeoutMilliseconds
      );
    } catch (error) {
      throw new MaintainModelProviderFailure({
        kind: "requestFailed",
        reason: requestFailureReason(error),
      });
    }
  }
}
exports.OpenCodeCliMaintainProvider = OpenCodeCliMaintainProvider;

/**
 * The first provider that can answer, in preference order: the reader's own CLI
 * (their machine, their model, no network from here), then Zen.
 *
 * Returns `undefined` only when neither can run — on a host with no `fetch` and
 * no CLI. Upstream could return `undefined` because the reader had brought no
 * key; here that state effectively does not exist, which is the point.
 */
function firstAvailableMaintainProvider(options) {
  const cliProvider = new OpenCodeCliMaintainProvider({
    probeAvailability: options.probeOpenCodeCli,
    createBackend: options.createOpenCodeCliBackend,
    requestTimeoutMilliseconds: options.requestTimeoutMilliseconds,
  });
  if (cliProvider.isAvailable()) return cliProvider;

  const zenProvider = new OpenCodeZenMaintainProvider(
    options.readOpenCodeApiKey,
    options.fetchImplementation,
    options.requestTimeoutMilliseconds,
    options.modelId || MAINTAIN_FREE_MODEL_ID
  );
  if (zenProvider.isAvailable()) return zenProvider;

  return undefined;
}
exports.firstAvailableMaintainProvider = firstAvailableMaintainProvider;
