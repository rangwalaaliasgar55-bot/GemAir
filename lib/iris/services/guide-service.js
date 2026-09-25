"use strict";
/**
 * guide-service.js
 *
 * Loads an install guide. Ported from
 * `iris-windows/src/services/guide-service.ts`, with the server taken out.
 *
 * Upstream fetched `GET {publik}/api/iris/guides/{slug}?version=n`: guides were
 * a company's reviewed content, delivered over HTTP, and four different HTTP
 * statuses meant four different things to a reader. GemAir has no such server,
 * so guides ship WITH the app — `lib/iris/guides/*.json`, reviewed in the repo,
 * versioned by the file itself, readable offline and diffable in a pull
 * request.
 *
 * The error vocabulary is kept exactly, because it is what the panel renders
 * and the distinctions are still real:
 *
 *   invalidGuideSlug                  the link is malformed
 *   guideNotFound                     no guide ships by that slug
 *   guideVersionIsNoLongerAvailable   the link named a version this build
 *                                     does not carry — "restart, the guide
 *                                     moved" rather than silently following
 *                                     steps written for something else
 *   guideIsNotPublished               the guide is in the tree but marked
 *                                     `review`, so it is not offered
 *   apiBaseIsNotAllowed               a source outside the bundled catalogue
 *                                     and loopback
 *
 * A loopback source is still honoured, because writing a guide means running a
 * local server and watching the panel render it.
 */
Object.defineProperty(exports, "__esModule", { value: true });

const fs = require("node:fs");
const path = require("node:path");
const { isValidGuideSlug } = require("./deep-link-parser");

/** Where guides come from when nothing else is configured: this app. */
const DEFAULT_GUIDE_API_BASE = "bundled:";
exports.DEFAULT_GUIDE_API_BASE = DEFAULT_GUIDE_API_BASE;

/** The bundled catalogue on disk. */
const BUNDLED_GUIDE_DIRECTORY = path.join(__dirname, "..", "guides");
exports.BUNDLED_GUIDE_DIRECTORY = BUNDLED_GUIDE_DIRECTORY;

class GuideServiceError extends Error {
  constructor(detail) {
    super(guideErrorMessage(detail));
    this.name = "GuideServiceError";
    this.detail = detail;
  }
}
exports.GuideServiceError = GuideServiceError;

function guideErrorMessage(detail) {
  switch (detail.kind) {
    case "invalidGuideSlug":
      return "That guide link is invalid. Open a guide from GemAir's install list.";
    case "invalidGuideVersionRequest":
      return "That guide link asks for a version GemAir cannot read.";
    case "guideIsNotPublished":
      return "This guide is still in review, so GemAir will not run it yet.";
    case "guideNotFound":
      return "GemAir does not ship a guide for this app yet.";
    case "guideVersionIsNoLongerAvailable":
      return `Guide version ${detail.requestedVersion} is no longer available — this build ships a newer one.`;
    case "apiBaseIsNotAllowed":
      return "GemAir only loads guides that ship with the app, or from a guide server on this machine.";
    case "unexpectedResponseStatus":
      return `Guide source returned ${detail.statusCode}.`;
    case "responseCouldNotBeDecoded":
      return `GemAir could not read that guide: ${detail.reason}`;
    case "guideHasNoBranches":
      return "This guide has no reviewed desktop steps.";
    case "transportFailure":
      return `GemAir could not read that guide: ${detail.reason}`;
    default:
      return "GemAir could not load that guide.";
  }
}
exports.guideErrorMessage = guideErrorMessage;

/**
 * The only sources GemAir will read a guide from: the bundled catalogue, and a
 * loopback server for guide authors. A tampered config cannot point the client
 * at somebody else's server.
 */
function normalizedApiBase(candidate) {
  if (!candidate || candidate === DEFAULT_GUIDE_API_BASE || candidate === "bundled") {
    return DEFAULT_GUIDE_API_BASE;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1";
  if ((url.protocol === "http:" || url.protocol === "https:") && isLoopback) {
    return url.origin.replace(/\/+$/, "");
  }
  return null;
}
exports.normalizedApiBase = normalizedApiBase;

/** Turns one HTTP status from a loopback guide server into its own failure. */
function guideFailureForStatusCode(statusCode, requestedVersion) {
  switch (statusCode) {
    case 400:
      return { kind: "invalidGuideVersionRequest" };
    case 403:
      return { kind: "guideIsNotPublished" };
    case 404:
      return { kind: "guideNotFound" };
    case 409:
      return {
        kind: "guideVersionIsNoLongerAvailable",
        requestedVersion: requestedVersion ?? 0,
      };
    default:
      return { kind: "unexpectedResponseStatus", statusCode };
  }
}
exports.guideFailureForStatusCode = guideFailureForStatusCode;

/** Builds the request URL for a loopback guide server. */
function guideRequestUrl(options) {
  const base = normalizedApiBase(options.apiBase);
  if (!base) throw new GuideServiceError({ kind: "apiBaseIsNotAllowed" });
  if (base === DEFAULT_GUIDE_API_BASE) {
    return `${DEFAULT_GUIDE_API_BASE}${options.slug}`;
  }
  const versionQuery =
    options.version === null || options.version === undefined
      ? ""
      : `?version=${encodeURIComponent(String(options.version))}`;
  return `${base}/api/gemair/guides/${encodeURIComponent(options.slug)}${versionQuery}`;
}
exports.guideRequestUrl = guideRequestUrl;

/** Every guide that ships with this build, newest first by app name. */
function bundledGuideSlugs(directory = BUNDLED_GUIDE_DIRECTORY) {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}
exports.bundledGuideSlugs = bundledGuideSlugs;

/** A one-line summary of every bundled guide, for the install list. */
function bundledGuideSummaries(directory = BUNDLED_GUIDE_DIRECTORY) {
  const summaries = [];
  for (const slug of bundledGuideSlugs(directory)) {
    try {
      const guide = JSON.parse(fs.readFileSync(path.join(directory, `${slug}.json`), "utf-8"));
      summaries.push({
        slug: guide.appSlug || slug,
        appName: guide.appName || slug,
        version: guide.version || 1,
        status: guide.status || "approved",
        outputType: guide.outputType || "desktop_app",
        estimatedMinutes: guide.estimatedMinutes ?? null,
        summary: guide.summary || "",
        platforms: Array.isArray(guide.branches)
          ? Array.from(new Set(guide.branches.map((branch) => branch.platform)))
          : [],
      });
    } catch {
      // A guide file that cannot be parsed is left out of the list rather than
      // breaking the list. `loadBundledGuide` reports it properly if asked for.
    }
  }
  return summaries;
}
exports.bundledGuideSummaries = bundledGuideSummaries;

/** Reads one guide out of the bundled catalogue, applying every guide rule. */
function loadBundledGuide(slug, version = null, directory = BUNDLED_GUIDE_DIRECTORY) {
  if (!isValidGuideSlug(slug)) throw new GuideServiceError({ kind: "invalidGuideSlug" });
  if (version !== null && version !== undefined && version < 1) {
    throw new GuideServiceError({ kind: "invalidGuideVersionRequest" });
  }

  let rawGuide;
  try {
    rawGuide = fs.readFileSync(path.join(directory, `${slug}.json`), "utf-8");
  } catch {
    throw new GuideServiceError({ kind: "guideNotFound" });
  }

  let guide;
  try {
    guide = JSON.parse(rawGuide);
  } catch (error) {
    throw new GuideServiceError({
      kind: "responseCouldNotBeDecoded",
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return validatedGuide(guide, version ?? null);
}
exports.loadBundledGuide = loadBundledGuide;

/** The checks upstream applied to a fetched guide, applied to any guide. */
function validatedGuide(guide, version) {
  if (!Array.isArray(guide?.branches)) {
    throw new GuideServiceError({
      kind: "responseCouldNotBeDecoded",
      reason: "guide has no branch list",
    });
  }
  if (guide.status === "review") {
    throw new GuideServiceError({ kind: "guideIsNotPublished" });
  }
  if (guide.branches.length === 0) {
    throw new GuideServiceError({ kind: "guideHasNoBranches" });
  }
  // Asking for a version and being handed a different one means the source did
  // not enforce it; refusing here keeps the reader off steps they did not ask
  // for, which is the same thing upstream's 409 protected against.
  if (version !== null && typeof guide.version === "number" && guide.version !== version) {
    throw new GuideServiceError({
      kind: "guideVersionIsNoLongerAvailable",
      requestedVersion: version,
    });
  }
  return guide;
}
exports.validatedGuide = validatedGuide;

/**
 * The one entry point the panel and the autopilot both use.
 *
 * Bundled by default and offline always; a loopback base is fetched over HTTP
 * for guide authors, with the same four status meanings upstream defined.
 */
async function fetchGuide(options) {
  const base = normalizedApiBase(options.apiBase ?? DEFAULT_GUIDE_API_BASE);
  if (!base) throw new GuideServiceError({ kind: "apiBaseIsNotAllowed" });

  if (base === DEFAULT_GUIDE_API_BASE) {
    return loadBundledGuide(options.slug, options.version ?? null, options.directory);
  }

  if (!isValidGuideSlug(options.slug)) {
    throw new GuideServiceError({ kind: "invalidGuideSlug" });
  }
  if (options.version !== null && options.version !== undefined && options.version < 1) {
    throw new GuideServiceError({ kind: "invalidGuideVersionRequest" });
  }

  const url = guideRequestUrl({
    apiBase: base,
    slug: options.slug,
    version: options.version ?? null,
  });

  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  let response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  } catch (error) {
    throw new GuideServiceError({
      kind: "transportFailure",
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (!response.ok) {
    throw new GuideServiceError(
      guideFailureForStatusCode(response.status, options.version ?? null)
    );
  }

  let guide;
  try {
    guide = JSON.parse(await response.text());
  } catch (error) {
    throw new GuideServiceError({
      kind: "responseCouldNotBeDecoded",
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return validatedGuide(guide, options.version ?? null);
}
exports.fetchGuide = fetchGuide;
