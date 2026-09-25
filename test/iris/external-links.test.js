"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("./vitest-shim");
const external_links_1 = require("../../lib/iris/services/external-links");
/**
 * The allowlist is the Windows copy of `allowed_external_host` in
 * `gemair-desktop/src-tauri/src/main.rs`. Two properties matter:
 *
 *   1. A lookalike host must not be mistaken for an allowed one. `github.com`
 *      being on the list must not let `github.com.evil.tld` through.
 *   2. A blocked host must be REPORTED, not silently dropped. That is the
 *      gemair-desktop 0.1.4 dead-button bug: a step pointing at a host nobody had
 *      allowlisted rendered a control that did nothing at all.
 */
(0, vitest_1.describe)("the allowlist itself", () => {
    (0, vitest_1.it)("has exactly the 37 hosts GemAir allows", () => {
        // Upstream's 29 minus the two publik hosts GemAir does not talk to, plus
        // the ten its own catalogue needs (OpenCode, Ollama, Excalidraw, VS Code,
        // Yarn, Homebrew).
        (0, vitest_1.expect)(external_links_1.ALLOWED_EXTERNAL_HOSTS.size).toBe(37);
    });
    (0, vitest_1.it)("does not allow the publik hosts GemAir never talks to", () => {
        (0, vitest_1.expect)((0, external_links_1.isAllowedExternalHost)("publikhq.com")).toBe(false);
        (0, vitest_1.expect)((0, external_links_1.isAllowedExternalHost)("www.publikhq.com")).toBe(false);
    });
    (0, vitest_1.it)("contains every host `allowed_external_host` names", () => {
        // A hand transcription — the fourth copy of this list — and it went stale
        // exactly as you would expect: seven hosts were added to the Tauri client
        // on 2026-08-10 for the Hickeyfield, Nutcracker and Dripwriter guides and
        // reached none of the other copies, so four published guide steps opened
        // nothing on any shipping client.
        //
        // The cross-client comparison lives in the repo root's
        // tests/client-parity.test.ts, which reads all three lists and fails when
        // they disagree. What is left here is a local sanity check.
        const hostsEveryClientAllows = [
            // GemAir's own catalogue, in place of upstream's publik hosts.
            "opencode.ai",
            "www.opencode.ai",
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
            "apps.apple.com",
            "developer.android.com",
            "huggingface.co",
            "visualstudio.microsoft.com",
            "cmake.org",
            "www.cmake.org",
            "files.browseros.com",
            "go.dev",
            "fal.ai",
            "www.fal.ai",
            "nasm.us",
            "www.nasm.us",
            "chromewebstore.google.com",
            "docs.google.com",
            "blueturboguy07.github.io",
        ];
        (0, vitest_1.expect)(hostsEveryClientAllows).toHaveLength(37);
        for (const host of hostsEveryClientAllows) {
            (0, vitest_1.expect)((0, external_links_1.isAllowedExternalHost)(host), `${host} should be allowlisted`).toBe(true);
        }
    });
    (0, vitest_1.it)("includes files.browseros.com, the host whose absence caused the dead button", () => {
        (0, vitest_1.expect)((0, external_links_1.isAllowedExternalHost)("files.browseros.com")).toBe(true);
    });
});
(0, vitest_1.describe)("accepting known hosts", () => {
    vitest_1.it.each([
        "https://github.com/Blueturboguy07/publik",
        "https://opencode.ai/auth",
        "https://docs.github.com/en/get-started",
        "https://files.browseros.com/download/win",
        "https://go.dev/dl/",
    ])("allows %s", (url) => {
        const classification = (0, external_links_1.classifyExternalLink)(url);
        (0, vitest_1.expect)(classification.allowed).toBe(true);
    });
    (0, vitest_1.it)("matches the host case-insensitively", () => {
        (0, vitest_1.expect)((0, external_links_1.classifyExternalLink)("https://GitHub.COM/publik").allowed).toBe(true);
    });
    (0, vitest_1.it)("allows loopback for a locally-run guide server", () => {
        (0, vitest_1.expect)((0, external_links_1.classifyExternalLink)("http://localhost:3000/cue").allowed).toBe(true);
        (0, vitest_1.expect)((0, external_links_1.classifyExternalLink)("http://127.0.0.1:3000/cue").allowed).toBe(true);
    });
});
(0, vitest_1.describe)("rejecting lookalikes", () => {
    vitest_1.it.each([
        "https://github.com.evil.tld/publik",
        "https://opencode.ai.evil.tld",
        "https://notgithub.com",
        "https://github.com.co",
        "https://evilgithub.com",
        "https://sub.github.com.attacker.io",
    ])("rejects the lookalike %s", (url) => {
        const classification = (0, external_links_1.classifyExternalLink)(url);
        (0, vitest_1.expect)(classification.allowed).toBe(false);
    });
    (0, vitest_1.it)("names the host it refused, so the UI can render a disabled control", () => {
        const classification = (0, external_links_1.classifyExternalLink)("https://github.com.evil.tld/publik");
        (0, vitest_1.expect)(classification.allowed).toBe(false);
        if (classification.allowed)
            return;
        (0, vitest_1.expect)(classification.host).toBe("github.com.evil.tld");
        (0, vitest_1.expect)(classification.reason).toBe("hostNotAllowlisted");
        // The refusal must be a sentence naming the host — never silence.
        (0, vitest_1.expect)((0, external_links_1.refusalMessage)(classification)).toContain("github.com.evil.tld");
    });
    (0, vitest_1.it)("is not fooled by credentials that make an allowed host appear in the userinfo", () => {
        // `https://github.com@evil.tld` has hostname evil.tld, not github.com.
        const classification = (0, external_links_1.classifyExternalLink)("https://github.com@evil.tld/x");
        (0, vitest_1.expect)(classification.allowed).toBe(false);
    });
    (0, vitest_1.it)("rejects a non-https scheme even on an allowed host", () => {
        const classification = (0, external_links_1.classifyExternalLink)("http://github.com/publik");
        (0, vitest_1.expect)(classification.allowed).toBe(false);
        if (classification.allowed)
            return;
        (0, vitest_1.expect)(classification.reason).toBe("schemeNotAllowed");
    });
    vitest_1.it.each(["file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)", "data:text/html,<h1>x"])("rejects the dangerous scheme in %s", (url) => {
        (0, vitest_1.expect)((0, external_links_1.classifyExternalLink)(url).allowed).toBe(false);
    });
    (0, vitest_1.it)("rejects nonsense without throwing", () => {
        for (const value of ["", "not a url", null, undefined, 42, {}]) {
            const classification = (0, external_links_1.classifyExternalLink)(value);
            (0, vitest_1.expect)(classification.allowed).toBe(false);
            (0, vitest_1.expect)((0, external_links_1.refusalMessage)(classification)).toBeTruthy();
        }
    });
});
(0, vitest_1.describe)("every refusal produces something a person can read", () => {
    (0, vitest_1.it)("returns null for an allowed link and a sentence for a blocked one", () => {
        (0, vitest_1.expect)((0, external_links_1.refusalMessage)((0, external_links_1.classifyExternalLink)("https://github.com"))).toBeNull();
        for (const url of ["https://evil.tld", "http://github.com", "javascript:x", "garbage"]) {
            const message = (0, external_links_1.refusalMessage)((0, external_links_1.classifyExternalLink)(url));
            (0, vitest_1.expect)(message, `${url} should produce a message`).toBeTruthy();
            (0, vitest_1.expect)(message.length).toBeGreaterThan(10);
        }
    });
});
