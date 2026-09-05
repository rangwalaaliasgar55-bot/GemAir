# Production Readiness

## Web deployment

GemAir web is a static renderer plus serverless `api/` handlers. Deploy the repository with Vercel and set `ALLOWED_ORIGINS` to the production host if it is not `gemair.vercel.app`.

The `/download` route serves `download.html`. It queries the public GitHub Releases API and only labels a platform as a direct download when the matching asset exists.

## AI connections

- Browser chat can use live keyless tools without a model key.
- General browser model answers require a configured server provider or the optional local WebGPU model.
- Desktop ChatGPT uses the PKCE OAuth bridge and encrypted local storage. It requires the OAuth client and provider authorization to remain valid.
- Desktop Gemini uses Google OAuth and the official Generative Language API. Set `GEMAIR_GEMINI_CLIENT_ID` and, when required by the OAuth client, `GEMAIR_GEMINI_CLIENT_SECRET`.
- ChatGPT OAuth can return `invalid_authorize_request` when the configured client ID is not approved for the requested redirect or scope. The built-in placeholder client is not a production credential; configure `GEMAIR_CHATGPT_CLIENT_ID` with an approved client.
- Gemini requires a Google OAuth Desktop client with `http://127.0.0.1:8766/callback` registered. Without it, the UI reports configuration guidance and does not claim Gemini is connected.
- A browser deployment cannot safely capture desktop cookies or local OAuth callbacks without a server-side callback, encrypted session store, CSRF protection, and a configured provider client. The web UI therefore does not claim browser account connections that are not configured.

## Signing and notarization

The release workflow currently builds unsigned Electron artifacts. Before calling a release signed or production-distributed, configure:

- Windows certificate secrets for electron-builder signing.
- Apple Developer ID certificate, provisioning, notarization credentials, and hardened runtime.
- Linux package signing if repository trust verification is required.

The workflow publishes `SHA256SUMS.txt` for the generated assets. Checksums prove file integrity, not publisher identity.

## Desktop commander

The desktop build exposes real commander tools through the same validated tool registry used by model calls. Safe actions such as opening apps/sites, listing windows, weather/search, modes, and telemetry can run directly. Sensitive actions such as shell commands, file writes/moves, closing applications, messaging, and mouse/keyboard control remain gated by Settings permissions and/or confirmation dialogs. There is no unrestricted arbitrary-action mode by design.

Updates are metadata-only by design: users click `DOWNLOAD UPDATE`, choose the published release asset, close GemAir, and run the installer. This avoids silent replacement and keeps the user in control.

## Verification

Run local deterministic checks:

```bash
npm test
npm run verify:release
```

Run live release verification after publishing a tag:

```bash
VERIFY_RELEASE=1 npm run verify:release
```

Browser screenshot automation is intentionally not claimed by the repository until Playwright or another browser runner is installed in CI. The static product smoke test still checks the key DOM contracts and interaction wiring.
