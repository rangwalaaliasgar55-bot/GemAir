# GemAir ↔ Stonic feature parity

GemAir already implements the Stonic Gen 2 experience surface. This document maps features and points at the code.

| Stonic concept | GemAir implementation |
|----------------|----------------------|
| HUD themes (Crimson / Emerald / Cyan …) | `renderer/themes.js` — string token table; top-bar swatches; full UI recolour |
| Agent Town (Alice, Bob, Carol, Dave) | Agent Town 2.0 in renderer + tool missions |
| System Core (Memory / Skills / Soul / Settings) | System Core panel — CPU/RAM, memory tabs, settings |
| Voice assistant | Edge neural TTS + wake loop + barge-in (`renderer/tts-engine.js`, `edge-tts.js`) |
| Desktop automation | 98 tools + missions (organize, files, apps) in main process |
| World Monitor | Globe / news hotspots |
| ChatGPT account connect (no API key paste) | OpenAI device authorization + account model discovery + Codex Responses; encrypted store in `lib/connections.js` |
| Gemini account connect | `lib/connections.js` — Gemini connection path |
| Free core fallback | Vercel serverless free provider chain |

## Account login (recommended)

In the app: **Settings → Connections** (or COST / AI Brain area depending on build).

- **ChatGPT**: press Connect, finish OpenAI's one-time device flow in the system browser, then choose a model discovered from your account. Tokens remain main-process-only and encrypted via Electron `safeStorage`.
- **Gemini**: Sign in / link Google session → same encrypted store.
- Priority: ChatGPT → Gemini → Free Core.

## Optional: legacy OAuth helpers

The desktop UI uses the device flow in `lib/chatgpt-codex.js`. For compatibility or headless diagnostics, see:

- `lib/oauth-chatgpt-pkce.js` — legacy loopback Codex-style PKCE
- `lib/oauth-gemini-pkce.js` — Google OAuth Desktop client (requires `GEMAIR_GEMINI_CLIENT_ID`)

```bash
node scripts/oauth-login.js chatgpt
# Gemini needs: export GEMAIR_GEMINI_CLIENT_ID=….apps.googleusercontent.com
node scripts/oauth-login.js gemini
```

These do **not** bypass provider ToS. They sign in with **your** accounts and respect **your** plan limits.

## Legal boundary

No pirated accounts, stolen sessions, or third-party free rides. Free path = Free Core + your own free-tier accounts.
