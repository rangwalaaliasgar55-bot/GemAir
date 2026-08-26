# GemAir ↔ Stonic feature parity

GemAir already implements the Stonic Gen 2 experience surface. This document maps features and points at the code.

| Stonic concept | GemAir implementation |
|----------------|----------------------|
| HUD themes (Crimson / Emerald / Cyan …) | `renderer/themes.js` — string token table; top-bar swatches; full UI recolour |
| Agent Town (Alice, Bob, Carol, Dave) | Agent Town 2.0 in renderer + tool missions |
| System Core (Memory / Skills / Soul / Settings) | System Core panel — CPU/RAM, memory tabs, settings |
| Voice assistant | Edge neural TTS + wake loop + barge-in (`renderer/tts-engine.js`, `edge-tts.js`) |
| Desktop automation | 79 tools + missions (organize, files, apps) in main process |
| World Monitor | Globe / news hotspots |
| ChatGPT account connect (no API key paste) | `lib/connections.js` — encrypted store + session/OAuth capture |
| Gemini account connect | `lib/connections.js` — Gemini connection path |
| Free core fallback | Vercel serverless free provider chain |

## Account login (recommended)

In the app: **Settings → Connections** (or COST / AI Brain area depending on build).

- **ChatGPT**: Sign in with your ChatGPT account → tokens stored via Electron `safeStorage` (encrypted on disk).
- **Gemini**: Sign in / link Google session → same encrypted store.
- Priority: ChatGPT → Gemini → Free Core.

## Optional: OAuth PKCE helpers (SocialBot-compatible)

For CLI / headless tests, see:

- `lib/oauth-chatgpt-pkce.js` — Codex-style PKCE (same public client pattern as SocialBot)
- `lib/oauth-gemini-pkce.js` — Google OAuth Desktop client (requires `GEMAIR_GEMINI_CLIENT_ID`)

```bash
node scripts/oauth-login.js chatgpt
# Gemini needs: export GEMAIR_GEMINI_CLIENT_ID=….apps.googleusercontent.com
node scripts/oauth-login.js gemini
```

These do **not** bypass provider ToS. They sign in with **your** accounts and respect **your** plan limits.

## Legal boundary

No pirated accounts, stolen sessions, or third-party free rides. Free path = Free Core + your own free-tier accounts.
