"use strict";
/**
 * external-links.ts
 *
 * The one canonical answer to "may a guide step send the reader here?".
 *
 * This list is the Windows copy of `allowed_external_host` in
 * `iris-desktop/src-tauri/src/main.rs` and of `SAFE_EXTERNAL_HOSTS` in
 * `iris-desktop/ui/app.js`. All three must stay in step with `lib/iris-guides.ts`;
 * a host missing from here is a step the reader cannot follow.
 *
 * The reason this module returns a *classification* rather than a boolean is the
 * bug iris-desktop 0.1.4 fixed. "Install BrowserOS" — step 2 of Astro's Windows
 * branch — pointed at files.browseros.com, which was not on the list, so the
 * button opened nothing at all. A control that does nothing when clicked reads
 * as a broken app, not as a blocked host. So a blocked host must surface as a
 * DISABLED control that names the host, and `classifyExternalLink` returns the
 * host precisely so the UI has something to name.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALLOWED_EXTERNAL_HOSTS = void 0;
exports.classifyExternalLink = classifyExternalLink;
exports.isAllowedExternalHost = isAllowedExternalHost;
exports.refusalMessage = refusalMessage;
/**
 * Every host a guide step, a recipe, or the settings panel may send the reader
 * to. Upstream's list was twenty-two entries, byte-for-byte the same set as
 * `allowed_external_host` in the Tauri client's main.rs; this is that list with
 * publik's own two hosts removed (GemAir has no publik) and the hosts GemAir's
 * own bundled guides link to added — the model route (opencode.ai), the two
 * package managers the recipes drive (brew.sh, winget's own docs live on
 * learn.microsoft.com, already present), and the three catalogue apps.
 *
 * A host that is not here is not a 404 — it is a DISABLED control naming the
 * host, which is the whole reason `classifyExternalLink` returns one.
 */
exports.ALLOWED_EXTERNAL_HOSTS = new Set([
    // GemAir's own model route and the page a reader signs in to for their own
    // free-tier key.
    "opencode.ai",
    "www.opencode.ai",
    // The bundled catalogue.
    "ollama.com",
    "www.ollama.com",
    "excalidraw.com",
    "code.visualstudio.com",
    "yarnpkg.com",
    "classic.yarnpkg.com",
    "brew.sh",
    "docs.brew.sh",
    "github.com",
    "docs.github.com",
    "git-scm.com",
    "nodejs.org",
    "www.python.org",
    "python.org",
    "rustup.rs",
    "docker.com",
    "www.docker.com",
    "docs.docker.com",
    "developer.apple.com",
    "learn.microsoft.com",
    // Toolchains and assets the current guides link to.
    "apps.apple.com",
    "developer.android.com",
    "huggingface.co",
    "visualstudio.microsoft.com",
    "cmake.org",
    "www.cmake.org",
    // Astro's Windows route. Missing here, "Install BrowserOS" opened nothing at
    // all in the desktop app, which reads as a dead button rather than a blocked
    // host.
    "files.browseros.com",
    "go.dev",
    // Added to the Tauri client on 2026-08-10 for the Hickeyfield, Nutcracker
    // and Dripwriter Origin guides and never propagated here. publik's guide
    // test validated links against the Tauri list, so four published steps
    // passed CI and opened nothing on this client. Propagated 2026-08-25;
    // publik's GEMAIR_ALLOWED_HOSTS is the source of truth.
    "fal.ai",
    "www.fal.ai",
    "nasm.us",
    "www.nasm.us",
    "chromewebstore.google.com",
    "docs.google.com",
    "blueturboguy07.github.io",
]);
/** Loopback: a local_web app the autopilot just built, and a guide author's own
 *  server when `guideSource` is pointed at one. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
function classifyExternalLink(candidate) {
    let url;
    try {
        url = new URL(String(candidate ?? ""));
    }
    catch {
        return { allowed: false, host: null, reason: "malformed" };
    }
    const host = url.hostname.toLowerCase();
    // A URL carrying credentials is never worth opening, and saying so before the
    // host check keeps `https://github.com@evil.tld` from reading as a github link.
    if (url.username !== "" || url.password !== "") {
        return { allowed: false, host, reason: "credentialsInUrl" };
    }
    const isAllowlistedHttps = url.protocol === "https:" && exports.ALLOWED_EXTERNAL_HOSTS.has(host);
    const isLoopback = (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(host);
    if (isAllowlistedHttps || isLoopback) {
        return { allowed: true, url: url.toString(), host };
    }
    // Distinguish "right host, wrong scheme" from "host we do not know", because
    // only the second is worth naming to the reader.
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { allowed: false, host, reason: "schemeNotAllowed" };
    }
    if (exports.ALLOWED_EXTERNAL_HOSTS.has(host)) {
        return { allowed: false, host, reason: "schemeNotAllowed" };
    }
    return { allowed: false, host, reason: "hostNotAllowlisted" };
}
/** Convenience for the main process, where only the verdict matters. */
function isAllowedExternalHost(host) {
    return exports.ALLOWED_EXTERNAL_HOSTS.has(host.toLowerCase());
}
/**
 * The sentence a disabled control shows instead of a button that would do
 * nothing. Naming the host is the point: the reader can go there themselves.
 */
function refusalMessage(classification) {
    if (classification.allowed)
        return null;
    switch (classification.reason) {
        case "malformed":
            return "GemAir blocked an invalid link.";
        case "credentialsInUrl":
            return "GemAir blocked a link that carried a username or password.";
        case "schemeNotAllowed":
            return classification.host
                ? `GemAir only opens https links. This step points at ${classification.host}.`
                : "GemAir only opens https links.";
        case "hostNotAllowlisted":
            return classification.host
                ? `GemAir cannot open ${classification.host} — it is not on GemAir's allowed list.`
                : "GemAir cannot open that host — it is not on GemAir's allowed list.";
    }
}
