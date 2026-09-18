# Security & Local Privacy

GemAir is a **local-first** desktop app. Nearly everything it knows about you
lives on your machine, in plain files under your OS user-data directory. This
document is the honest inventory of that posture — what stays local, what
leaves, when, and what to do when something goes wrong.

## What never leaves your machine

| Data | Where it lives | Protection |
| --- | --- | --- |
| AI provider API keys (Gemini, Groq, OpenRouter, OpenAI-compatible…) | Electron `safeStorage` blobs in the app user-data dir | Encrypted at rest with the OS credential store (Windows DPAPI / macOS Keychain / Linux libsecret) |
| ChatGPT account tokens (bearer / refresh / ID) | Main process only, encrypted at rest | Never written to renderer-readable storage; loopback-only sidecars cannot read them |
| Memory (facts, transcripts, notes, reminders, mood, goals) | `<userData>/gemair-memory.json` | Plain JSON **on your machine only** |
| Memory cold archive (evicted hot-memory entries) | `<userData>/gemair-memory-archive.json` | Plain JSON, redaction applied on write |
| Profile & settings | `<userData>/gemair-profile.json` | Plain JSON on your machine only |
| Wake-word processing | In-process WASM recognizer | **No audio leaves the process while asleep** — the wake model detects "Hey Gem" locally and only then does a session open |

## What leaves, and only while you use it

- **AI calls.** When you chat, the text of that conversation goes to whichever
  provider you configured (ChatGPT account path, Gemini, Groq, Ollama-local,
  OpenRouter, …). Picking a local provider (Ollama) keeps even this on-device.
- **Live voice.** While a Gemini Live session is open, your microphone audio
  (and any screen/camera frames you explicitly share) streams to Google's
  Live API. It stops the moment you stop the session, mute, or close the app.
- **Free web tools.** Search, weather, news and similar tools call their own
  free public endpoints with your query — never with your keys or memory.
- **Optional anonymous sidecars** (FreeGPT35-compatible, OpenJarvis) run on
  loopback-only addresses and do not receive provider credentials.

There is **no GemAir telemetry server, no analytics SDK, and no account
system.** The only network calls are the ones the feature you are using
requires.

## The `.gitignore` contract (for forks and clones)

Running from a source checkout? The repo's `.gitignore` blocks the usual
leak paths:

```
.env.*        **/api_keys.json    **/*.pem  **/*.crt  **/*.key  **/*.p12
config/certs/ memory-backup*.json gemair-memory*.json gemair-profile*.json
```

This only protects **untracked** files. At startup, GemAir runs a local
guard (`lib/local-secret-check.js`): if it detects any secrets-shaped file
that is *already tracked* by git in your checkout, it warns you in the chat
panel and in the logs.

> ⚠️ **If you ever commit and push a real key or certificate:**
> deleting the file in a later commit does not remove it from git history.
> The credential is burned — **revoke and rotate it immediately**,
> then clean history (e.g. `git filter-repo`) before pushing again. Un-tracking
> without rotating (`git rm --cached file`) is only safe for keys that were
> never pushed anywhere.

## Plugin security model

Drop-in plugins are Node.js files you consciously place in `plugins/` —
GemAir never downloads plugin code. Plugins run inside the app process, so:

- install plugins only from sources you trust (they are code, not data);
- skills marked `risk: 'sensitive'` trigger a human confirmation dialog each
  time the AI tries to call them, exactly like built-in sensitive tools;
- plugins receive a deliberately small context surface (home dir, platform,
  app version, your saved display name, and a notify helper) — never provider
  keys, tokens, or other plugins' state.

## Reporting

Found a security issue in GemAir? Open a private security advisory on the
GitHub repository rather than a public issue, and do not include real
credentials in the report.
