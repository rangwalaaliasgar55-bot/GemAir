# Vendored third-party source

GemAir vendors the source of two open-source projects so its capabilities can
be audited and extended in-repo. Neither is built into the Electron app; each is a
reference + integration point (see the notes below and the license in each folder).

| Folder | Upstream | License | Why it's here |
| --- | --- | --- | --- |
| `computer-agent/` | [suitedaces/computer-agent](https://github.com/suitedaces/computer-agent) | Apache-2.0 | Desktop "computer-use" agent (Tauri + React + Rust). GemAir's keyless **Desktop Agent** (`lib/computer-agent.js`) is the JS port of its Rust input primitives, upgraded to run inside Electron with **no API key, no vendor**. |
| `opencode/` | [sst/opencode](https://github.com/sst/opencode) | MIT | Terminal AI coding agent (75+ providers, keyless via Ollama). GemAir's **Coding Agent** reuses its keyless provider config approach and can delegate to a user-installed `opencode` CLI. |
| `../renderer/vendor/vosk-browser/` | [ccoreilly/vosk-browser](https://github.com/ccoreilly/vosk-browser) | Apache-2.0 | WebAssembly build of the Kaldi/Vosk offline speech recognizer. Powers GemAir's **local Wake Word** engine (`renderer/wake-word.js`) — a concept port of Mark-LIII's ("Hey Jarvis") on-device wake gate: the mic is processed only on this machine, nothing streams anywhere until the phrase is heard. Shipped as a single built bundle (no build step needed at runtime); the small English model downloads once, opt-in, on first enable. |

Also concept-ported (reimplemented against GemAir's own tool-calling engine,
memory store, and risk-gating — no code copied) from
[FatihMakes/Mark-LIII](https://github.com/FatihMakes/Mark-LIII) (MIT):

| GemAir tool(s) | Mark-LIII origin | Notes |
| --- | --- | --- |
| `find_flights` | `actions/flight_finder.py` | Keyless: builds and opens a pre-filled live Google Flights search instead of scraping fares. |
| `update_game`, `list_installed_epic_games` | `actions/game_updater.py` | OS-native Steam/Epic deep links; no scraping, no API keys. |
| `add_topic_monitor`, `remove_topic_monitor`, `list_topic_monitors`, `check_topic_monitors` | `actions/background_monitor.py` | Daily per-topic headline watcher with a crypto/finance block-list and proactive, only-on-change alerts. |
| Local Wake Word (`renderer/wake-word.js`) | Mark-LIII's "Hey Jarvis" wake word + 2-minute auto-sleep | On-device Vosk/WASM recognizer gated on a grammar-restricted phrase; falls back to the existing cloud `SpeechRecognition` wake loop if unsupported. |

## Notes

- These folders are **excluded** from `electron-builder` (see the `files` list in
  `package.json`); they are reference source only.
- Full `opencode` is a separate Bun/TypeScript monorepo (~5,000 files). We vendor its
  LICENSE + README + the key agent/provider source and wire a keyless adapter, rather
  than pull the whole tree (which would bloat the repo and conflict with the Electron build).
