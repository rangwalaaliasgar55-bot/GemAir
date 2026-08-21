# Changelog

All notable changes to GemAir are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [2.4.0] — 2026-08-21

Round 5 v2.4 "CONNECTED DESKTOP AGENT" — three leaps at once: true account connect like Stonic (no API keys ever), opencode-style agentic desktop management, user-defined MODES that arrange the whole desktop from one sentence.

### Added — Section 0 Recon

- **CONNECTIONS.md** with full Stonic research (home, /jarvis-ai-for-pc, /features/*, /about, /changelog v1.0.0→v1.0.55, /guide, every blog post esp. "I Built Iron Man's JARVIS", founder Inventor Usman YouTube/Instagram/TikTok demos) and mermaid architecture diagram of ChatGPT-connect flow: embedded login → session capture → consumer backend → tool layer → voice. Marked confirmed vs inferred.

### Added — Section C Connect ChatGPT (session-based, Stonic-style)

- **Connections hub** in Settings → CONNECTIONS with big CONNECT CHATGPT button → embedded real chatgpt.com login (email/Google SSO). Capture session token post-login via Electron session.cookies, encrypt on disk via safeStorage (never plaintext, never renderer-visible). Shows email + plan badge.
- **Consumer backend routing:** chats routed through ChatGPT's consumer web backend with that session, streaming into chat UI. Research picked **openai-oauth Codex OAuth** (app_EMoamEEZ73f0CkXaXp7hrann, https://auth.openai.com/oauth/token, https://chatgpt.com/backend-api/codex) as most stable 2026 path, with legacy backend-api/conversation fallback.
- **Adapter layer:** consumer backends lack function-calling schemas. Inject TOOLS as JSON-in-prompt, parse tool-calls from plain text replies via <<TOOL_CALL>> markers, feed SAME executeTool loop — all ~60 tools work over connected accounts.
- **Resilience:** token refresh check, bot-check handling with friendly reconnect dialog, disconnect button, one-time experimental warning at connect ("unofficial method, may break, small account risk"). Session dies mid-chat → instant FREE CORE fallback, never dead air.

### Added — Section D Connect Gemini

- Same pattern: CONNECT GEMINI button → Google login embedded → capture Gemini web session (__Secure-1PSID + __Secure-1PSIDTS) → route through consumer backend with identical adapter, fallback and warning. Research stable open-source Gemini-web clients (HanaokaYuzu/Gemini-API, qutek/gemini-web-api). If pure session capture too unstable, fallback UX: one tap opens AI Studio, user signs in with Google inside it, app reads credential locally — still zero key copy-paste.

### Added — Section H Connection Hub UI

- One card rows CHATGPT | GEMINI | FREE CORE: live dots (CONNECTED green / EXPERIMENTAL amber / FALLBACK blue), account email, plan, today usage, priority picker for which brain answers first. Chain: accounts → free core → offline brain. MEDIA LINK card + status chips show ACTIVE brain name live.

### Added — Section A Agentic Desktop Management

- **Plan-Act loops:** big requests ("set up my workspace for editing") decomposed into numbered steps, executed sequentially with live progress checklist, per-step retry once, final spoken+written summary. Show plan before executing (dry-run chip: SHOW PLAN / RUN).
- **New window/desktop tools:** launch_app(name,args), focus_app(name), snap_window(left|right|quarter|max), minimize_all(), next_virtual_desktop(), open_site(url,browser) — open URL in SPECIFIC browser, list_windows() returns titles+apps so Gem sees desktop state. Cross-platform where possible, graceful no-op with clear message where not.
- **Context awareness:** track focused app/window (cheap polling IPC every 2.5s) so follow-ups work: "open it there too", "move this to the right".
- **Safety:** everything destructive stays behind existing confirmAction HITL; every step logged to action log (undo available).

### Added — Section M Modes

- Mode = named bundle of apps to launch, websites (+which browser), volume level, HUD theme, DND, optional playlist URL. Built-in starters: WORK (chrome+vscode+slack, gmail+calendar+github, vol30, cyan, DND), GAMING (steam+discord, vol70, crimson, DND, optimize_gaming), CHILL (spotify, lofi playlist, vol40, violet), STUDY (notepad, lofi, vol20, emerald, DND).
- **Mode Designer UI** in Settings → DESKTOP & MODES: add/remove apps and sites rows, pick browser per site, volume slider, theme picker, save. Modes sync into profile and persist via gemair-modes.json.
- **Voice triggers:** "chill mode", "play soft music" (opens lofi playlist + sets volume), "gaming setup" → optimize_gaming + mode. Palette entries + few-shot system prompt examples so Gem chains correctly: launch apps → open sites → set volume → apply theme → confirm spoken.
- **Cinematic transition:** quick screen sweep using themes.js tokens; topbar shows current mode chip; switching announces via TTS.

### Changed — Section U UI Upgrades

- **U1 Topbar:** quick-mode chips (WORK/GAMING/CHILL/STUDY) + active-brain indicator (dot + name) + current mode chip.
- **U2 Dashboard NOW card:** current mode, active brain, next reminder, battery.
- **U3 Settings reorg:** CONNECTIONS / BRAIN / VOICE / DESKTOP & MODES / APPEARANCE sub-sections with settings search box filtering fieldsets.
- **U4 Command palette:** modes, connections status row, recent missions section.
- **U5 Glass depth pass:** all panels via themes.js tokens (panel, panel-border, error, info, sweep) — new tokens added to themes.js single source; existing panels now use var(--panel) etc. with backdrop-filter blur + saturate + inset glow.

### Verification — Section V

- npm run check green every commit; extended selfcheck for new ids/selectors (C1, D, H, A, M, U). Final test matrix: connect chatgpt → streamed reply voiced via Edge TTS → run 3 tools over connected brain → disconnect → free-core fallback → gemini connect → create CHILL mode → voice trigger launches apps+sites+volume+sweep → restart persists sessions and modes → disconnect clears encrypted storage.

## [2.2.0] — 2026-08-21

Round 4 — "Perfect and Powerful". A two-sided audit of the merged 2.1 tree found
that several headline features were not actually working. This release fixes
those first, then turns the audit's list of dead code into real features.

### Fixed — confirmed bugs (Section R)

- **Streamed replies were never voiced.** `skipFinalSpeak` was assigned and read in `sendMessage()` without ever being declared; under strict mode the write threw (swallowed) and the read threw a `ReferenceError` before `speak(reply)`. Now declared. (R1)
- **Edge TTS could never play.** The binary frame parser read a **4-byte** header length, but the Edge Read-Aloud protocol uses a **2-byte big-endian** length with audio starting at `2 + headerLen` — so every synthesis resolved `no-audio` and silently fell through to the robotic system voice. Also added the `Sec-MS-GEC` / `Sec-MS-GEC-Version` params Microsoft now requires on the handshake. (R2)
- **Barge-in did not stop the voice.** `stopSpeaking()` cancelled `speechSynthesis` but never `window.ttsEngine.stop()`, so Gem kept talking over the user from an `<audio>` element while the avatar mouth froze. It now stops the engine and drains the pending streaming-speech queue. (R3)
- **The 3-column layout lost its flex rule.** A block comment in `style.css` was missing its opening `/*`, which discarded the `.stx-left/.stx-center/.stx-right` rule. Also fixed an invalid `1px border-dashed` shorthand. (R4)
- **The gaming optimizer made gaming worse.** `powercfg /setactive SCHEME_MIN` is the **Power Saver** GUID; it is now `SCHEME_MAX` (High Performance), with an Ultimate Performance fallback. (R5)
- **RGB theme broke every chart.** `hexToRgba()` assumed `#rrggbb`, so an `hsl()` accent produced `rgba(NaN…)` and `addColorStop` threw — killing the weekly sparklines, mood chart and command map. All accents now route through one tolerant hex/rgb/hsl parser. (R6)
- **Google neural TTS almost always failed.** `speakNeural` ignored its generation token (stale chunks played after a cancel) and set `crossOrigin="anonymous"` against `translate.google.com`, which sends no CORS headers. Generation is honoured between chunks and `crossOrigin` is gone. (R7)
- **TEST CONNECTION gave a false OK.** A bogus key silently fell back to the free core and reported success. It now fails visibly and states that the free core was *not* used. (R8)
- **Folder-tree path traversal.** `createFolderTree` only rejected a *leading* `..`; absolute paths, drive letters, UNC paths and any `..` segment are now rejected, with a resolved-path re-check against the base directory. (R9)
- **Free-core API hardening.** `AbortController` timeouts (~20 s) on every provider fetch, removal of a pointless byte-identical "retry without tools", an Origin/Referer allow-check, and per-IP throttling so random internet clients cannot burn the shared free provider keys. (R10)

### Added — dead code became real features (Section S)

- **SAT-LINK FEED** tabs are no longer cosmetic: TODAY (live headlines), RAP (RainViewer rain radar for your city), SEARCH (working web search box), ALERTS (advisories derived from the Open-Meteo forecast, clearly labelled as derived). (S1)
- **ACTIVE PROCESSES** shows real name/PID/CPU/RAM from the OS with a filter and an END button behind the existing HITL confirm, refusing protected processes. (S2)
- **Tasks panel** in System Core (add / complete / delete) — `memory.todos` finally has a UI, so the weekly tasks-per-day sparkline reflects real data. (S3)
- **Complete Hindi and Urdu dictionaries**, a language picker in Settings, and RTL layout switching. (S4)
- **Reactive listening aura and word-boundary visemes** — `setMicAnalyser` and `onViseme` existed but were never called. (S5)
- **HUD dock auto-open rules**: weather on rain/storm questions, the weekly report on Friday evening, the focus timer when you mention focusing or pomodoro. (S6)
- **Workflow gallery**: the 12 recipes render as one-click cards in the Agent Town side panel instead of hiding in palette search. (S7)
- **WebGPU offline brain tier** (opt-in): the unused `checkWebGPU` probe is now a real in-browser model tier in the fallback chain. (S8)
- **Local extractive summarizer** so context compaction works in the free/no-key mode GemAir advertises. (S9)
- **Quick-command editor** behind the expert-panel ＋, which had no handler at all. (S10)

### Added — remaining Stonic gaps (Section T)

- **Supabase Google OAuth** alongside the anonymous identity, enabling genuine cross-device sync and binding fair use to a real account. (T1)
- **Visible reasoning stream**: a collapsible strip above each reply, fed by planner and tool events. (T2)
- **In-app star rating** after N successful missions, stored locally and exportable. (T3)
- **Multi-monitor window memory**: bounds saved per display set and clamped back on-screen when a monitor disappears. (T4)
- **Ambient score** volume slider and two track choices with instant audible preview. (T5)

### Changed — polish (Section U)

- Deleted the dead parallel TTS stack in `app.js` (~90 unreachable lines); a single engine path through `tts-engine.js`. Deduplicated voice sentinels, Edge voice lists, agent colours and theme hues — `themes.js` remains the single token source. (U1)
- Honest statuses: the SYS chip reports degraded subsystems, the Agent Town head state reflects real agent activity, fallback headlines and weather are badged **SIMULATED**, and the briefing weather no longer sits on "Loading…" forever. (U2)
- One `DEFAULTS` constant resolves the Mumbai/Dubai, crimson/cyan and edge/neural contradictions. (U3)
- Accessibility: `role="dialog"`, `aria-modal`, focus traps and Escape on **all** modals; aria-labels on icon buttons; platform-correct Ctrl/⌘ hints. (U4)
- Layout: wrapping topbar below 1000px, viewport-relative panel heights, a responsive core grid, and the nonexistent `--dim` token replaced with `--text-dim`. (U5)
- Voice polish: the sentence splitter no longer breaks on `3.14` or `v2.1`, recognition restarts with exponential backoff when offline, the wake word arms exactly once at boot, turning the AI loop off also silences speech, and the skills circuit is derived from `memory.skills` instead of a painted 85%. (U6)

### Verification (Section V)

- `scripts/workflow-test.js` rewritten: fair use and throttling are now genuinely measured (the old test require()d the module twice and got the same cached instance), source slices validate their anchors instead of silently misranging, the system-prompt window is resolved from the real function bounds, and every Section R fix has a regression guard.
- `scripts/selfcheck.js` extended with the new ids, selectors, modal ARIA and CSS-token checks, and now prints a 22-row manual test matrix.

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
