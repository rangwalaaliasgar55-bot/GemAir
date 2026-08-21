# Changelog

All notable changes to GemAir are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [2.1.0] — 2026-08-21

### Added — FREE FOREVER

- **Key-free by default.** The app boots fully working with zero configuration. Settings shows **FREE CORE CONNECTED**; API-key fields moved into an optional collapsed **“Power user”** section. No modal, hint or error ever demands an API key.
- **Hardened FREE CORE** (`api/chat.js`): server-side provider fallback chain (Groq free tier → Gemini free tier → OpenRouter free models), automatic 429/rate-limit retry with provider rotation, SSE streaming passthrough, and per-identity fair-use limits via Supabase anonymous auth.
- **Settings → COST panel**: every feature mapped to its free `$0` service, with a big **“$0.00 FOREVER”** badge.
- **Stonic-grade voice at $0**: Microsoft Edge neural voices are now the primary TTS engine (free endpoint), with existing engines as fallbacks; the voice picker lists real Edge voice names; emotional voice intelligence v2 drives rate/pitch/volume + sentence-level pauses across 12 emotion mappings; sentence-by-sentence streaming speech starts audio while the reply is still generating; Urdu (`ur-PK`/`ur-IN`) and Hindi (`hi-IN`) Edge voices wired to the STT language switcher; Gem / JARVIS / Nova presets bound to tuned Edge voices.
- **12 one-sentence workflows** as tested tool chains (Stonic roadmap parity): organize Downloads by type, gather this week’s screenshots, find files > 500 MB unused for 6 months, scaffold a project folder tree, morning app stack launch, close everything except X, focus block, open-and-search a site instantly, multi-open tabs, spoken RAM/performance check, optimize PC for gaming, hands-free WhatsApp message. New tools: `close_app`, `find_large_files`, `create_folder_tree`, `move_files`, `optimize_gaming`. Each is a command-palette recipe plus few-shot examples in the system prompt; multi-step missions show checkpoint progress and support undo via the action log.
- **Errorless mandate**: every new feature wrapped in guards, a scripted dry-run test for all 12 workflows through the tool loop, and graceful offline degradation.

### Changed

- Upgraded the desktop and web application version to 2.1.0.
- Documented the Stonic “connect your ChatGPT account — no API key” proxy pattern in `AI-FRAMEWORK.md`.

## [2.0.0] — 2026-08-21

### Added

- Cinematic, skippable BIOS-to-HUD startup sequence and an optional synthesized ambient score.
- Fuzzy `Ctrl+K` command palette covering views, themes, HUD panels, resident agents, settings toggles, memories, and recent commands.
- Agent Town 2.0 with restricted real tools: Alice researches the web, Bob operates files, Carol verifies system health, and Dave opens communication drafts.
- Multi-agent research → file → verification missions with visible desk handoffs, actual tool outputs, and a transparent mission log.
- Local-time office lighting, coffee walks, an interactive dotted wireframe globe, clickable news hotspots, 2D command-map mode, live UTC clocks, and technology/world/business feeds.
- “Hey Gem” interim wake-word loop, microphone VU meter, speech barge-in, Gem/JARVIS/Nova voice presets, and top-bar STT language switching.
- Real estimated-token context meter, automatic transcript compaction, numbered execution plans, and opt-in privacy-preserving screen-change awareness.
- Weekly mood/task/goal sparklines, unified memory browser, and full profile + memory JSON backup/restore.
- View-aware animation scheduling, bounded/recycled chat DOM, reduced-motion policy, English i18n registry ready for Urdu and Hindi, and a filterable action audit viewer.
- Konami RGB burst and the “I am Iron Man” voice/chat easter egg.
- Windows ICO, macOS iconset, and Linux multi-resolution icons generated from the GemAir renderer logo.

### Changed

- Upgraded the desktop and web application version to 2.0.0.
- Improved tool safety with human-in-the-loop confirmations for writes, folder organization, and communication drafts.
- Upgraded live headlines to category-aware RSS with resilient local fallbacks.

## [1.0.0] — 2026-08-18

### Added

- Initial public GemAir command center with voice assistant, local-first memory, system telemetry, Agent Town, World Monitor, HUD themes, provider presets, tool calling, Mermaid rendering, and desktop packaging.

[2.0.0]: https://github.com/rangwalaaliasgar55-bot/GemAir/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/rangwalaaliasgar55-bot/GemAir/releases/tag/v1.0.0
