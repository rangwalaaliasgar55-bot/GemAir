# ChatGPT account wiring in GemAir

The account connection is already integrated in GemAir 2.9.0. No patch or
`apply_oauth_*` script is required — and since 2.9.0 the old one-shot
`scripts/apply_oauth_*` patchers are gone from the repo entirely, because they
rewrote source with literal string matches and would corrupt the files they
target.

## Primary flow

1. The renderer invokes `connectionsOauthChatGPT()` after the user accepts the
   account-access disclosure.
2. Electron's main process requests an OpenAI device code through
   `@opencoredev/loginwithchatgpt-core` and opens OpenAI's verification page in
   the system browser.
3. The renderer displays only the one-time user code and polls through
   `connectionsPollChatGPT(loginId)` at a UI cadence; the main process enforces
   OpenAI's server cadence and permits only one network poll at a time.
4. Authorized access/refresh/ID tokens and the account id are stored by
   `lib/connections.js` with Electron `safeStorage`. They never cross preload.
5. The app discovers account models, then sends chat through the ChatGPT-backed
   Codex Responses transport with native function calls.

## Fallbacks

- **Import local Codex login** reads an existing `~/.codex/auth.json`, refreshes
  a recoverable expired access token, and uses the same Responses transport.
- **Browser fallback** and **Paste web session** are legacy compatibility paths.
  They remain on the old web transport because those sessions lack the account
  id required by Codex.
- Gemini and configured/local providers remain independent alternatives.

## Priority

The default connected-brain order is ChatGPT → Gemini → local/free fallback.
Users can change it with the Connection Hub priority selector. A credential that
OpenAI or Google definitively rejects is deleted and the current turn finishes
through the honest local fallback.

See [`docs/UPSTREAM-INTEGRATION.md`](docs/UPSTREAM-INTEGRATION.md) for the exact
upstream revisions, license analysis, security boundaries, and regression-test
mapping.
