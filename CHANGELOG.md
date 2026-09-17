# Changelog

## [2.13.0] — 2026-09-17

**The "take it back" release.** A second deep pass over FatihMakes/Mark-LIV lands the features that make an assistant feel accountable: a shared **undo stack** for every file it touches, **clipboard intelligence** with a floating Translate/Summarise/Explain/Fix panel, **push-to-talk**, a **self-echo guard** (it no longer answers its own voice ringing in the room), **runtime self-knowledge** assembled live (including honest limits), **instant acknowledgment** in your language, **auto-start at login**, and two transport-hardening fixes straight off Mark-LIV's fix list. Original implementations on GemAir's own engine — no upstream code (Mark is CC BY-NC; see `THIRD_PARTY_NOTICES.md`).

### Added — ↩️ Undo (`lib/undo-stack.js` + tools)
- Say **"undo"** and GemAir reverses its own most recent reversible action: file writes (created files removed only while unchanged — your later edits are never destroyed; overwrites roll back to an exact ≤1 MB snapshot), batch organizes, batch renames, moves, archive sweeps, and folder trees (folders removed only while still empty).
- **It does not guess**: files over 1 MB report "undo snapshots skip this" instead of quiet hoarding; move-backs refuse when the origin is occupied; failed undos stay on the stack and say why, and you can retry them.
- New tools: `undo_last` (human-confirmed — reversal is still a state change), `list_undoable`. Live stack capped at 25 with evictions archived — the record of what it did is never silently forgotten.
- `write_file`, `organize_folder`, `rename_files`, `move_files`, `archive_old_files`, `create_folder_tree` now journal their reversal at the moment they act and report `reversible` back to the model.

### Added — 📋 Clipboard intelligence (`lib/clipboard-intel.js` + floating panel)
- Opt-in (Settings): copy any text and a card floats up with **TRANSLATE / SUMMARISE / EXPLAIN / FIX** — one click stages the prompt; nothing sends itself.
- **Secret quarantine**: copies that look like API keys/tokens are stored **redacted at rest**, never open the panel, and fire a lock toast instead.
- History ring of 30 with `list_clipboard_entries` / `recall_clipboard_entry` tools; evictions flow to the memory archive; the watcher only polls while enabled — off means genuinely off.

### Added — 🎚️ Push-to-talk
- Hold **Ctrl+Space** (⌘Space on macOS) and the mic opens; release sends. Repeat-guarded, text-field safe (with a chat-input exception), and force-releases on window blur or tab hide — the mic can never stay open in the background. Halts the wake loop while held.
- Honest scope: bound to the app window on every platform (there is no dependency-free global key-read outside Windows native code), and the Settings hint says so — Mark's approach (global on Windows only, windowed elsewhere, logged) adapted to Electron without native dependencies.

### Added — 🔇 Self-echo guard (`renderer/echo-guard.js`)
- After Gem speaks, its own last sentence is still "in the room" for a moment. `echoGuard` normalizes and matches fresh STT text against the tail of Gem's own voice: exact and partial echoes — even shot through a real-time buffer — are dropped; an echo **prefix + your continuation** is trimmed to just your words. The microphone is never muted; the window expires in 8s so coincidence never silences real speech.

### Added — 🪪 Runtime self-knowledge (`lib/self-knowledge.js`)
- "What it is, and what it isn't", assembled at boot and after every plugin reload from the *live* registry: identity/version/machine, the tools actually registered (plugins included the moment they load, broken ones disclaimed), session capability state, memory+archive counts — and the honest limits ("sight is a frame on demand, not a feed", "acts on this machine only").
- Injected into every system prompt as `RUNTIME SELF-KNOWLEDGE` (trust-this-over-older-text), plus a `get_assistant_capabilities` tool for mid-session freshness.

### Added — ⚡ Instant acknowledgment (`renderer/instant-ack.js`)
- When a gap-prone tool **starts** (long desktop tasks, searches, file sweeps, system scans), the shell speaks one short line in your language — en/hi/tr/es/de/fr/ru/uk/el/pt with deliberate conservatism (unknowns fall back to English), task-kind routed, rotation guaranteed no repeats back-to-back. If Gem is mid-sentence it toasts instead of talking over the answer. The model keeps its "never narrate tool use" contract — the ack comes from the app, not the model.

### Added — ⚡ Auto-start at login (`lib/autostart.js`)
- Settings toggle registers launch-at-login natively: Windows Run key, macOS Login Item, Linux XDG autostart `.desktop` — the row reads its state **back from the OS** on open, never starts hidden, and the Linux hint is honest about dev-mode vs packaged installs.

### Fixed — Gemini Live transport hardening (from Mark-LIV's own fix list)
- **Transcript tail de-dup**: the Live API re-sends the tail of a transcript across the turn-completes a tool call produces, so answers could be logged and spoken twice. Now suppressed at both chunk and flush level (verbatim, clipped-suffix, tail-resend, long-containment; bounded 600-char window).
- **Rejected resumption handles are dropped after one replay**: an expired handle can no longer be re-offered on every retry and block the reconnect it exists to protect.
- **Socket-epoch guard**: a previous socket's asynchronous close can no longer consume a new attempt's settlement (watchdog theft) or poison the resume handle — a race the first two fixes surfaced while testing.

### Changed
- Version bumped 2.12.0 → 2.13.0 single-sourced across `package.json`, `package-lock.json`, `VERSION`, `api/_lib/http.js`, `renderer/index.html`, `renderer/app.js` fallback, `renderer/sw.js` (`gemair-shell-v2.13.0-release`), `download.html`, and `scripts/selfcheck.js`.

### Tests & docs
- New suites in `npm run check`: `undo-stack-test.js`, `clipboard-intel-test.js`, `self-knowledge-test.js`, `autostart-test.js`, `echo-guard-test.js`, `instant-ack-test.js`, `push-to-talk-test.js`; `gemini-live-test.js` extended (+2: transcript de-dup, rejected-handle drop).
- `GUIDE.md` gains the undo/clipboard/PTT/ack sections; `ARCHITECTURE.md` §9b extended with the undo stack, echo guard, and self-knowledge pipeline.

## [2.12.0] — 2026-09-17

**The JARVIS-grade voice release.** GemAir studied what makes FatihMakes/Mark-LIV feel like a real-time voice Jarvis and closed the gap on its own stack — a hardened long-horizon Gemini Live loop, screen+camera fused into the same conversation, a drop-in single-file plugin system with a template, a proactive engine that remembers last session exactly once, a memory model that never silently forgets, local-privacy hardening with a startup git-leak guard, and a one-command OS-aware installer. Everything ships end-to-end (main → IPC → preload → renderer → tests → docs), no stubs. Concepts were reimplemented on GemAir's own engine — no upstream code copied (Mark-LIV is CC BY-NC; see `THIRD_PARTY_NOTICES.md`).

### Added — long-horizon duplex voice loop (`renderer/gemini-live.js`)
- **Session resumption**: the Live setup now offers `session_resumption`; server `sessionResumptionUpdate` handles are stashed, reported via `onResumption`, and re-attached automatically on reconnect, manual reconnect, and voice-change — a dropped socket no longer wipes the conversation.
- **Sliding-window context compression**: `context_window_compression: { sliding_window: {} }` is on by default, so one live conversation can run for hours without dying on a full context window.
- **Graceful capability degradation**: if a live model refuses the enhanced setup (closes the socket before `setupComplete`), the session retries exactly once with the plain setup and flags itself degraded — Mark's `_enhanced_live` fallback, applied to the same session instead of a reload.
- **GoAway pre-emption**: the server's `goAway.timeLeft` warning triggers an early, resumption-attached reconnect plus a UI toast — no audible dead-air gap.
- **True interruption handling**: `serverContent.interrupted` now flushes the playback queue instantly and fires `onInterrupted`, complementing the existing VAD barge-in.
- **Output transcription stream**: `output_audio_transcription` feeds `onOutputTranscript` — captions and the avatar's phoneme lip-sync now work on the native-audio voice too; input transcription is opt-in.
- **Voice/prompt passthrough**: `startVoice` accepts `voiceName` and a `systemPrompt` so the live voice matches the configured identity.

### Added — fused live vision (screen + camera in the same call)
- Two toggles in the Live voice card — **SHARE SCREEN** and **SHARE CAMERA** — stream ~1 fps JPEG frames into the running voice session as `realtimeInput.video`, so "what's on my screen right now?" and "what am I holding up?" work mid-call instead of being a separate screenshot feature.
- Screen frames come from a new `vision:screenFrame` IPC: `desktopCapturer`-based, **gated on the existing Screen Awareness permission**, throttled main-side, JPEG-compressed, honest errors (`SCREEN_AWARENESS_OFF` / `THROTTLED` / `CAPTURE_FAILED`), never a second socket. Camera frames use `getUserMedia` in the renderer with full track release on hang-up, stop, or error.

### Added — drop-in plugins (`plugins/` + `lib/plugin-loader.js`)
- **One file = one skill.** Any top-level `.js` file in `plugins/` exporting a `PLUGIN` declaration (`name`, `description`, JSON-Schema `parameters`, `risk`) plus an async `run(args, context)` becomes a callable tool on next launch — or instantly via Settings → Plugins → RELOAD.
- Declarations merge into the model-facing catalog at every call site (`getAllTools()`); dispatch runs inside the existing permission gates — `risk: 'sensitive'` plugins get a human confirmation dialog like built-in sensitive tools.
- Broken files, bad names, name collisions with built-ins, and throws at load- or run-time degrade to reported errors, never crashes. `_`-prefixed files are documentation; GemAir never downloads plugin code.
- Ships `plugins/_template.js` (a validating canonical example) and a Settings → Plugins panel listing live skills, skipped files with reasons, and hot-memory archive stats.

### Added — proactive engagement (`lib/proactive.js`)
- **Once-per-launch greeting**: time-of-day aware (morning/afternoon/evening/late-night), mentions reminders due in the next 24h, names the topic monitors that found new headlines overnight, and — when a previous session exists — recalls its topics naturally and then marks them **consumed**, so it is said exactly once, never repeated.
- **Optional idle check-ins** (`profile.proactiveCheckIns`): rotation-aware (never the same angle twice in a row), rate-limited to one per 3 hours, silent 22:00–07:00, and can mirror to an OS notification (`proactiveNotifications`).
- **Session memory**: quitting records a distilled topic summary (`before-quit`), guarded against clobbering an un-consumed summary after a crash.

### Added — memory cold archive (the end of silent forgetting)
- New `lib/memory-archive.js`: an append-only, redaction-on-write cold store at `<userData>/gemair-memory-archive.json` with bounded rotation that folds the oldest half into per-kind **checkpoints** — the raw lines rotate, the evidence of what was learned never disappears.
- Every hot-memory cap now archives before it trims: facts (300, importance-sorted), transcript (2000), action log (200), mood (500). `search_memory` automatically falls back to the archive (results marked `archived: true`).
- GemCore's scoped `MemoryStore` reports evictions on `remember()`, archives them, and `recall()` merges archived hits (marked) after hot results — the documented fix for Mark-LII/LIII's capped-blob memory that deleted the oldest entries without telling anyone.
- New IPC: `memory:archiveStats`, `memory:searchArchive`; stats surface in Settings → Plugins → MEMORY ARCHIVE.

### Added — local-privacy hardening
- `SECURITY.md`: the local-first inventory (what never leaves, what leaves while you use it, the `.gitignore` contract) and the blunt rule — **if you ever push a key, revoke and rotate it; deleting the file later does not remove it from git history.**
- `lib/local-secret-check.js`: a startup guard that, inside source checkouts, asks `git ls-files` whether any secrets-shaped file (`.env*`, `api_keys.json`, certs, keys, memory exports…) is *tracked* — `.gitignore` cannot protect a tracked file — and warns in chat + logs with the untrack command. Missing git, non-git folders, and timeouts all degrade to silence.
- `.gitignore` hardened: `.env.*` (`!.env.example`), `**/api_keys.json`, cert/key extensions, `config/certs/`, memory/profile export patterns, `plugins/local/`.

### Added — one-command OS-aware setup (`scripts/setup.js`)
- `npm run setup` validates Node ≥ 22.12 **before** npm runs (a wrong interpreter exits with one sentence, not a wall of engine warnings), checks the checkout is complete, installs only what the current OS needs, and prints per-OS notes (Electron system libraries on Linux, Xcode CLT on macOS, nothing extra on Windows).
- `--with-browser` additionally installs the Playwright Chromium browser-automation engine; `--check` validates without installing (CI-friendly).

### Added — wake-word one-click model install
- Settings → Avatar & Voice gains **INSTALL ON-DEVICE WAKE MODEL**: `GemWakeWord.installModel()` precaches the ~40 MB on-device recognizer model **without opening the microphone**, with a live status line (`modelStatus()`), so enabling "Hey Gem" later starts instantly. The automatic download-on-first-enable path still works.

### Changed
- **Phoneme lip-sync goes language-free**: the avatar's `visemesForWord` now derives mouth shapes by Unicode reduction — NFD strips accents (à→a, ü→u) and Cyrillic/Greek letters map onto the same measured-shape rig (м/μπ→closure, у/ου→round, и/ι→spread), so non-Latin transcripts articulate instead of falling silent. CJK and other unmapped scripts fall back cleanly.
- **Live voice captions + lip-sync**: the Live loop drives the avatar word-by-word from output transcription (a 120 ms word pump) instead of volume-only jaw motion. Transcripts also update the live caption.
- **Reminder notifications**: OS-native reminders now carry the due time in the body and focus the GemAir window when clicked.
- **Background monitor integration**: monitor alerts now set an `alertPending` flag the next-launch greeting consumes, completing the "tell me overnight changes when I come back" loop.
- Version bumped 2.11.0 → 2.12.0 across `package.json`, `package-lock.json`, `VERSION`, `api/_lib/http.js`, `renderer/index.html`, `renderer/app.js` fallback, `renderer/sw.js` (`gemair-shell-v2.12.0-release`), `download.html`, and `scripts/selfcheck.js`.

### Tests & docs
- New suites in `npm run check`: `plugin-system-test.js`, `proactive-test.js`, `memory-archive-test.js`, `privacy-local-files-test.js`, `setup-script-test.js`, `avatar-viseme-test.js`, `live-vision-test.js`, `personalization-ritual-test.js`; extended `gemini-live-test.js` (+6: resumption/compression/degradation/goAway/interruption/video frames) and `wake-word-test.js` (+installModel/modelStatus + Settings wiring).
- `GUIDE.md` gains the plugins/proactive/live-vision/memory-archive sections; `ARCHITECTURE.md` documents the new modules and the long-horizon live loop.

## [2.11.0] — 2026-09-14

**Release pipeline fix + stable installers.** v2.10.0 was tagged correctly but the Build & Release workflow never ran for that tag — GitHub Actions does not trigger other workflows when a tag is created via `GITHUB_TOKEN` in some runners, leaving the GitHub Release empty with no Setup.exe. This release re-publishes the full artifact set and hardens the release flow.

### Added — release hardening
- **Release verification in CI**: `scripts/release-verification.js` now checks that `package.json`, `VERSION`, `api/_lib/http.js`, `renderer/index.html`, and `download.html` all carry the same version. `npm run verify:release` is run before every `dist` job in `release.yml` and `nightly.yml`.
- **Manual tag re-push trigger**: documented fallback — if auto-release creates a tag that doesn't trigger Build & Release, deleting and re-pushing the tag via PAT triggers the workflow (push tag events always trigger). Added to `DOWNLOAD.md` publish notes.
- **Download page live asset resolution**: `download.html` now queries GitHub Releases API for real installer URLs and file sizes, with fallback to `/releases/latest`. Windows card points to `GemAir Setup *.exe`, macOS to `.dmg`, Linux to `.AppImage`/`.deb`, plus SHA256SUMS.txt.
- **Version single-sourcing**: bumped `CACHE_VERSION` in `renderer/sw.js` to `gemair-shell-v2.11.0-release` so PWA clients pick up the new shell.

### Fixed — release artifacts
- **v2.10.0 installers missing**: re-pushed tag `v2.10.0` via git to trigger Build & Release — now publishes `GemAir.Setup.2.10.0.exe` + `.blockmap`, `.dmg`, `.zip`, `.AppImage`, `.deb`, `latest.yml`/`latest-mac.yml`/`latest-linux.yml`, and `SHA256SUMS.txt`.
- **v2.11.0 full release**: this version publishes the same complete set for `v2.11.0` across Windows, macOS, and Linux runners.

### Changed
- Version bumped `2.10.0` → `2.11.0` across `package.json`, `package-lock.json`, `VERSION`, `api/_lib/http.js`, `renderer/index.html`, `renderer/app.js` fallback, `renderer/sw.js`, `download.html`, and `scripts/selfcheck.js`.

## [2.10.0] — 2026-09-14

The island got tab awareness, the desktop agent got real autonomy, and the connection paths got an end-to-end test that runs them instead of describing them.

### Added — Gem Air island knows what you are on
- `lib/attention/service.js` keeps an in-memory **tab ledger**: every focus change opens an entry with the window or browser-tab title, its measured dwell time (open → left, not a poll count), and **where the reading came from** — `extension` when the browser extension is paired and live, `window-title` when it is inferred. The pill used to answer "Work"; you asked what you were on, so the title now leads and the category moved to the meta line.
- The expanded sheet has a **Tabs** card: the current tab large, the tabs just left with per-tab dwell, and each row is a button that raises that window through `windowTools.focusApp` — "back to what I was doing" without an Alt-Tab hunt.
- `source` is displayed rather than assumed. A title read from the extension and a guess from a window title are not equally trustworthy, and the UI says which one you are looking at.
- The island also shows **which GemAir tab you are in** (`air:setAppView`, reported by `switchView`), so one glance covers both senses of "what tab am I on".
- Extension tab titles are now actually used: `onBrowserTab` carried the title and the classifier dropped it, so the island showed a hostname where it had the real tab name.
- Expanded island height 520 → 612 for the new card. The ledger is deliberately memory-only — nothing written to disk per poll sample, and idle samples never create a tab.
- New `air:` surface (`setAppView`, `tabs`, `focusTab`) registered in `lib/attention/ipc.js`, `preload.js`, the preview shim and the preview harness; the harness answers `focusTab` with an honest "cannot focus OS windows" rather than pretending.

### Added — autonomous desktop execution
- **`run_desktop_task`** tool: hand the whole objective to the desktop agent instead of the chat model chaining one `mouse_click` per turn. It drives the real mouse and keyboard (the user's actual input path — `lib/computer-agent.js` over OS-native PowerShell / AppleScript / `xdotool`), re-reading the screen between actions, and reports the actions taken. Routed through the existing `computer` permission tier, so `allowComputerUse` still decides everything.
- **Consent is now per task, not per action.** Eight prompts for an eight-step job was why people enabled the *global* auto-approve and lost the gate entirely; the dialog now states the task and the capability surface once, `grantComputerRun` scopes the approval to that run with an action budget (`RUN_BUDGET_EXHAUSTED` stops a runaway loop), and `releaseComputerRunGrant()` runs in `finally` so a throw cannot leave the agent approved. Nothing is remembered globally.
- **Perception**: every step is told the focused window, the open window list, the screen size and its own action history — a model that cannot see what it already tried repeats the click that failed, which is what "dumb" looked like.
- **Anti-loop guards**: an identical action twice triggers a "screen did not change, change approach" nudge instead of a third attempt; two consecutive failures end the run with the reason; a model that answers with no tool call is reported as a capability problem ("the connected brain may not support tool calling") rather than silent nothing.
- The tool router now offers the agent for multi-step physical intents (`fill`, `set up`, `clean up`, `toggle`, …) and *not* for weather or reminders; the chat system prompt tells Gem to use it for sequences and to keep single actions on the direct tools.

### Fixed
- `refreshChatGPTAccessToken` built its own SDK config and so ignored `GEMAIR_CHATGPT_ISSUER`/client-version overrides that the Codex transport honours — an operator pointing the issuer at another host got a connection that authenticated and then refreshed against `auth.openai.com` and died. It now shares `chatgpt-codex.sdkConfig`. Found by the new mock harness, not by the contract tests.

### Added — tests
- `scripts/connection-mock-e2e-test.js`: runs the **real** SDK, encrypted store, Codex transport, Gemini client and hub status against local mock OpenAI and Google servers — device-code pending → authorize → store → model discovery → streamed turn → plan-rejected model rotation → token refresh, plus Gemini key storage, retired-model healing, header-only auth, live-only model tagging, and "a captured browser session must never reach the network". 21 checks, offline, deterministic, no credentials.
- `scripts/desktop-autonomy-test.js` (both wired into `npm run check` and `npm test`): grant scoping and release, perception/anti-loop structure, router precision, and tab-ledger dwell/source/app-view behaviour.

## [2.9.0] — 2026-09-13

**The connection release.** Chat and both account connections were failing for real users, and no test caught it: the suite verified GemAir's code against GemAir's own assumptions while the *upstream* facts went stale. Model identifiers age out constantly — Groq shut down `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` on **2026-08-16**, Google retired the whole Gemini 2.0 family on **2026-06-01**, xAI retired the Grok 3/4 line on **2026-05-15**, SambaNova removed `Meta-Llama-3.1-8B-Instruct` on **2026-04-14**, Cerebras replaced its standing free tier with a card-required trial on **2026-07-21**. Every one of those ids was hard-coded in GemAir, so a healthy install was answering 404s everywhere while reporting "connected".

### Fixed — provider catalog and self-healing chain
- Rebuilt the provider catalog (`renderer/providers.js`) against each provider's current deprecation notices: Groq → `openai/gpt-oss-120b`/`-20b`/`qwen/qwen3.6-27b`, Gemini → `gemini-3.5-flash`/`gemini-3.1-flash-lite`/`2.5-flash`/`2.5-flash-lite`/`gemma-4-31b-it`, Z.ai → `glm-4.7-flash`/`glm-4.5-flash`, SambaNova → `Meta-Llama-3.3-70B-Instruct`/`DeepSeek-V3.1`/`gpt-oss-120b`, Cerebras → `gpt-oss-120b`, OpenRouter → explicit `:free` route ids (the bare ids bill against credits), Grok → `grok-4.1-fast`/`grok-4.20`, OpenAI → GPT-5.6 tiers, Anthropic → `claude-sonnet-5`/`claude-opus-5`. Free-tier claims that no longer exist (Cerebras, xAI, Together, Fireworks, DeepSeek, Novita, DeepInfra) are labelled as trials/credits instead of "free".
- **New `renderer/model-currency.js`**: one ledger of retired ids and their live replacements, shared by the browser catalog, the serverless free chain, and the desktop profile. `repairModelId()` heals stale settings on load — an existing user's dead `llama-3.1-8b-instant` now self-repairs with a notice instead of failing every message forever. Scoped `PROVIDER_MODEL_ALIASES` covers provider *policy* (OpenRouter `:free`, SambaNova/Cerebras removals) without rewriting the same id where it is still alive.
- `api/chat.js` now asks every configured provider which models its own key can actually serve (`GET /models`, cached 6 h success / 10 min failure) and chains only those. A retired built-in id now costs one cached round-trip instead of breaking the product. Discovery can never disable a provider: any failure falls back to the repaired catalog.
- `AI_BASE_URL` without `AI_MODEL` used to default to a retired Groq id — guaranteed failure. It now discovers the gateway's own model list.
- The free core says what is wrong and what to do: `NO_PROVIDERS_CONFIGURED` gains `useDirectProvider`, a user-facing message and `nextSteps`, and `/api/health` reports `chatReady` + `providersConfigured` + `catalogRevision` so "deployed" and "able to answer" are finally different states. `NO_MODELS_AVAILABLE` distinguishes a key that cannot serve any chat model.
- The renderer switches to the user's own key when the deployment has none, presets read the catalog instead of a second hard-coded table (that duplicate is what kept offering retired models in Settings), and `directClientChat` defaults come from the catalog too.
- Search failure states are now distinguishable: DuckDuckGo's anti-bot page (a 200 with no results) is detected, `lite.duckduckgo.com` is tried as a second endpoint, and `upstreamBlocked`/`blockedReason`/`hint` stop "the web has nothing about that" from being a lie about a rate limit.

### Fixed — Gemini connection
- Credentials are classified by **value**, not by storage slot. A captured `__Secure-1PSID` cookie was being sent to the REST API as a Bearer token (guaranteed 401, which then flipped the hub to "disconnected" and deleted a still-working login); an AI Studio key scraped by the capture fallback was stored in the cookie slot and sent as Bearer too — a working credential failing by construction. `resolveGeminiAuth` now returns `key` / `bearer` / `web-session` / `none`, web sessions never reach the network, and AIza-shaped values are promoted to keys.
- A linked-but-unusable session is reported honestly: the hub dot distinguishes CONNECTED from ATTENTION, the row says "needs an API key" with a click that focuses the key field, and brain selection refuses an unusable connection instead of picking it and failing every turn.
- `callGeminiWeb` heals retired model ids, authenticates with the `x-goog-api-key` **header** (no more keys in URLs, logs or crash text — same in `renderer/tts-engine.js` and `gemini-live.js` model discovery), rotates through the current free lineup on a 404, keeps multi-part "thinking" replies instead of discarding them as empty, reports `GEMINI_BLOCKED` distinctly from a transport failure, and marks quota/5xx as retryable so a blip is not a dead session.
- `GEMINI_OAUTH_SCOPE_MISSING`: an identity-only Google token now explains that sign-in proves *who* you are and not *whether you may generate*, and points at the free key path. `loginGeminiViaPkce` probes the token before declaring success.
- OAuth loopback hardening: `EADDRINUSE` on 8766 no longer escapes as an uncaught exception in the Electron main process (a second Connect click could close the app), timers and the callback server are released on every early exit (cancel, state mismatch, no code), cancellation gets its own code, and the token exchange reports Google's real error with a redirect-URI hint. The same single-settle/timer fixes were applied to the ChatGPT PKCE flow.

### Fixed — repository hazards (removed)
- `lib/agent.js`, `lib/auto-ask.js`, `lib/stealth-login.js`, `lib/start-agent.sh` are deleted. They were unreferenced leftovers of an experiment, but they shipped inside the packaged app (`files: ["lib/**/*"]`). What they contained: an unbounded autonomous loop with no kill switch (`SIGINT`/`SIGTERM` handlers that log and ignore), self-immortalisation via `chmod 0444` plus a respawn watchdog "to block deletion", rewriting its own source from model output and re-execing it, spawning `stealth-login.js` — a puppeteer-extra-plugin-stealth bot-detection evader that scraped an OpenAI token out of browser storage into a plaintext file while advising the user to disable 2FA — and a hard dependency on the retired `chat.openai.com` endpoint plus an undeclared `undici` require. It also required a module that does not exist (`lib/computer-use-agent.js`), so it could never have run. Nothing in the app, tests, or docs referenced them; `docs/UPSTREAM-INTEGRATION.md` and `THIRD_PARTY_NOTICES.md` remain accurate.
- Deleted the one-shot source mutators that had already served their purpose and would now corrupt files they patch: `scripts/_patch-dead.js`, `scripts/_patch-topbar.js`, `scripts/apply_oauth_ipc.js`, `scripts/apply_oauth_preload.js`.

### Added — tests that can see reality
- `scripts/catalog-currency-test.js` (wired into `npm run check` and `npm test`) fails when a retired model id appears in any shipped source, when the catalog contradicts the ledger, when the serverless chain and the browser catalog disagree, when a repair is not idempotent, when a provider's own alias table rewrites one of its entries, when a `free: true` label is contradicted by its note, and when the ledger has not been reconciled in 120 days. Writing it immediately caught four more retired ids and a false-positive bug in the repair heuristic.
- `chat-transport-test.js` now derives the chain under test from `api/chat.js` instead of pinning retired model names, and covers live model discovery end-to-end. `connection-surface-test.js` covers cookie-vs-key classification, "never send a web session to the network", key-in-URL prohibition, and retired-Gemini-model healing.

## [2.8.2] — 2026-09-13

Reliability release: ChatGPT turns survive transient provider blips instead of failing with `CODEX_EMPTY_RESPONSE`, the anonymous fallback backs off honestly when OpenAI rate-limits it, the optional OpenJarvis brief skips silently when its runtime is down, and the Gem Air island + app shell get an Apple-grade visual refresh.

### Fixed — ChatGPT connection
- Codex transport now accepts completion-shaped SSE events (`output_text.done`, `content_part.done`), records `incomplete` reasons and refusals as distinct retryable errors, and attaches actionable guidance to empty turns instead of a bare code.
- Request timeouts scale with reasoning effort (30s–180s) so high/xhigh turns no longer die mid-reasoning and read as empty responses.
- `callConnectedBrain` retries transient failures once in-process with backoff; empty turns, timeouts, rate limits, and 5xx never wipe the stored session or pop the reconnect modal.
- `isSessionExpiredError` explicitly excludes transient signatures (`CODEX_EMPTY_RESPONSE`, `CODEX_INCOMPLETE`, timeouts, 408/409/425/429/5xx, `FREEGPT35_*`).

### Fixed — anonymous fallback
- FreeGPT35 403 "unusual activity" and 429 responses now enter a 10-minute cooldown with a clear message (instead of hammering a blocked endpoint every turn); 502/503/504 retry once automatically.
- Failed turns report `retryable`, and the chat UI shows "Temporary hiccup" copy with a one-tap ↻ Retry button for transient failures.

### Fixed — OpenJarvis noise
- The advisory `openjarvis_plan` step reports `skipped` (not `error`) when the sidecar is unavailable, and no longer stamps an inline ✗ chip on every turn. Status stays visible in the expert-panel feed and Connections panel.

### Changed — Gem Air island redesign
- Rebuilt the island as a Dynamic-Island-grade pill: pure-black capsule with a glowing status orb, two-line status + live timer, spring expand/collapse, frosted detail sheet with staggered card entrances, focus-block progress bar, dismissible teach-me card, icon quick actions, and toast confirmations.
- Full keyboard support (Enter/Space toggle, Esc collapse), ARIA roles/labels, loading shimmer, and reduced-motion support. Window sizes updated to 372×68 compact / 440×520 expanded.

### Changed — Apple refinement layer
- New `renderer/apple-refresh.css` (loaded last, cached by the PWA shell): SF system type, softer frosted cards, macOS-style sidebar pills, springy buttons/inputs, focus-visible rings, overlay scrollbars, view transitions, toast/chip animations, small-window responsive fixes, and high-contrast + reduced-motion support.
- New `porcelain` (Apple-clean light) and `midnight` (Apple-dark) HUD themes; added missing first-paint theme fallbacks for graphite/ocean.
- Voice: engine-level emotion presets (`ttsEngine.EMOTIONS`), six new Edge neural voices (Ava, Brian, Natasha/William AU, Clara/Liam CA) with `voiceLabel`/`voicesForGender` helpers; avatar gains a `pulse()` micro-interaction fired on message send.

## [2.8.1] — 2026-09-13

Workspace interface redesign: clearer navigation, calmer panels, and a guided empty state. No behavior changes — all existing IDs, state classes, and actions are preserved.

### Changed
- Renamed nav: Voice Core → Assistant, Desktop Manager → Workspace, Life Companion → Tasks & Goals, Agent Town → Automations, Global Intel → Discover.
- Added workspace header with command-palette search, new welcome cards (plan / explore / capture), and streamlined chat composer copy.
- Reworked `renderer/reference.css` into a light/dark workspace theme; dropped `depth.css` from the page; added `renderer/interface.js` (search shortcut, welcome-prompt fill, welcome restore on clear).
- Bumped PWA cache to `gemair-shell-v2.8.1-interface2` and precached `interface.js`.
- Updated `download.html` footer to 2.8.1.

## [2.8.0] — 2026-09-12

Anonymous chat and opt-in local reasoning sidecars, implemented after a source and license review of FreeGPT35 and OpenJarvis. GemAir's Electron host, existing JavaScript tool executor, and permission gates remain authoritative.

### Added — FreeGPT35-compatible anonymous chat
- Added a separately licensed, source-available AGPL-3.0 sidecar pinned to FreeGPT35 revision `3bf421eecee954a5361677ec225f61348684f6bc`. It preserves the upstream anonymous session and proof-token flow, OpenAI-compatible `/v1/chat/completions` request shape, and streaming/non-streaming semantics.
- Keyless desktop conversations use anonymous chat by default and clearly identify the responding provider/model. Connected ChatGPT or Gemini turns may fall back only before provider output starts; once text is emitted, failures stay visible instead of splicing providers.
- The local boundary is hardened relative to upstream: random bearer authentication, loopback-only binding, no CORS, bounded input/output/concurrency/deadlines, and normal TLS verification. The upstream TLS-certificate bypass was deliberately not copied.

### Added — OpenJarvis reasoning runtime
- Bundled pinned Apache-2.0 OpenJarvis source at revision `b1055c983b25b298c7e97723847d215df18de4a8` behind an explicit app-private Python install. Setup reports progress, supports cancellation, and optionally builds the included PyO3/Rust workspace when Cargo is available.
- Added optional orchestrator/ReAct planning, deep research, conversation-memory digests, memory search, prompt-injection guardrails, direct `/jarvis` reasoning, capability reporting, and sandbox-runtime detection. `/plan`, `/research`, `/memory-search`, and `/jarvis` expose the main workflows.
- Added an opt-in loopback HTTP(S) MCP connection with tool discovery. Only tools that declare themselves read-only and non-destructive are eligible for non-interactive reasoning; remote endpoints, embedded credentials, command transports, and mutating MCP tools remain blocked.

### Security, privacy, and packaging
- OpenJarvis telemetry and PostHog analytics are disabled in both environment and generated configuration. The private policy is default-deny, while file writes, code execution, system administration, and channel sends remain outside the reasoning sidecar.
- Sidecar source, revision records, upstream notices, and license files ship as unpacked application resources. FreeGPT35 remains an AGPL-separated process; GemAir core remains MIT and OpenJarvis remains Apache-2.0.
- Added network-isolated FreeGPT35 integration tests plus OpenJarvis configuration, bridge, guardrail, cancellation, capability, and optional MCP-discovery coverage to the normal test suite.

## [2.7.0] — 2026-09-12

ChatGPT account connection overhaul, based on a full source/license review of `opencoredev/login-with-chatgpt`, `missuo/FreeGPT35`, `isair/jarvis`, and `open-jarvis/OpenJarvis`.

### Added — OpenAI device sign-in
- `@opencoredev/loginwithchatgpt-core` 0.2.0 is now a pinned runtime dependency. **CONNECT CHATGPT** requests an OpenAI one-time device code, opens OpenAI's own verification page, and polls at the server-provided cadence.
- OAuth device secrets and all access/refresh/ID tokens remain in the Electron main process. The renderer receives only the short user code plus public email, plan, and model metadata; credentials are encrypted at rest with `safeStorage`.
- Added cancellation and 15-minute expiry handling, actionable errors, refresh-token rotation, and a single-flight refresh guard.

### Added — ChatGPT Codex Responses transport
- Refreshable account sessions now use `chatgpt.com/backend-api/codex/responses` with the required account header, current client-version model gate, stateless request normalization, SSE streaming, and encrypted reasoning continuity.
- Settings now discovers models from the signed-in account and provides account-model, reasoning-effort, and service-tier selectors. Model/tier availability remains controlled by the user's ChatGPT plan.
- Local `~/.codex/auth.json` import understands nested access/refresh/ID token fields, derives account metadata, refreshes a recoverable expired access token, and uses the same Responses path.

### Added — Native tools and context routing
- ChatGPT account models receive native Responses function definitions and return `function_call` items. Results feed the existing permission-gated `executeTool` path as `function_call_output`, for up to six bounded rounds.
- New original `lib/tool-router.js` ranks the 98-tool catalog against the current turn, keeps a utility core, applies intent hints, and sends at most 24 relevant tools to reduce context rot.

### Security and compatibility
- Replaced the old import-time `lib/free-chatgpt.js` scraper/CLI with a side-effect-free compatibility facade. It no longer writes plaintext tokens, scrapes cookies, starts a Windows shell, or disables transport boundaries.
- Legacy browser-session capture and pasted session JSON remain clearly labeled fallbacks; only those sessions use the old web conversation route.
- Provider-rejected account credentials are deleted immediately and the interrupted turn finishes through the honest local fallback. On Linux, GemAir refuses Electron's insecure `basic_text` credential backend.
- Added `THIRD_PARTY_NOTICES.md` and `docs/UPSTREAM-INTEGRATION.md`. No AGPL FreeGPT35 code or non-commercial `isair/jarvis` code was copied. OpenJarvis architecture was compared but not vendored.
- Added network-free regression coverage for device login state, token privacy, account model preferences, refresh request shape/rotation, Codex request normalization, UTF-8 SSE, native tool rounds, encrypted reasoning carryover, and tool routing.
- Updated the desktop runtime to Electron 44.3.0 and packaging to electron-builder 26.15.3; removed the unused `@vercel/node` development dependency. `npm audit` reports zero known vulnerabilities. Development now requires Node.js 22.12 or newer.

## [2.6.0] — 2026-09-11

Concept-ported four features from [Mark-LIII](https://github.com/FatihMakes/Mark-LIII) into GemAir's own keyless, sandboxed architecture — no code copied, no new dependencies on Mark-LIII's Python/Gemini stack, no new frontend surface for the backend tools. Tool count: 91 → 98.

### Added — Local, offline wake-word engine ("Hey Gem")
- `renderer/wake-word.js` adds a real on-device wake-word detector using [vosk-browser](https://github.com/ccoreilly/vosk-browser) (Vosk/Kaldi compiled to WebAssembly, vendored at `renderer/vendor/vosk-browser/`). Mic audio is processed entirely on-device through a grammar-restricted recognizer (the wake phrase plus a catch-all token) for fast, accurate detection — nothing is sent anywhere until the phrase is heard. The small English model (~40 MB) downloads once, opt-in, on first use, and is cached by the browser engine afterward.
- Mirrors Mark-LIII's "Hey Jarvis" behavior: after a wake-triggered conversation goes quiet for 2 minutes, GemAir automatically stops listening and re-arms the wake word (`armWakeAutoSleep`/`resetWakeAutoSleep` in `renderer/app.js`), so voice mode costs nothing while idle.
- If the local engine can't load (unsupported browser, model fetch failure, mic permission denied), GemAir automatically falls back to its existing cloud-based `SpeechRecognition` wake loop — voice wake-up never breaks, it just degrades gracefully.
- Regression-covered by `scripts/wake-word-test.js` (API shape, privacy contract, grammar restriction, full resource teardown, app wiring, auto-sleep timing).

### Added — Keyless flight search tool
- New `find_flights` tool (`lib/flight-finder.js`) builds a pre-filled Google Flights search URL from natural origin/destination/date input and opens it — no scraping, no Gemini/API-key dependency, unlike Mark-LIII's browser-scrape-and-parse approach.

### Added — Game update tools (Steam & Epic)
- New `update_game` and `list_installed_epic_games` tools (`lib/game-updater.js`) detect installed Steam libraries (via `libraryfolders.vdf`/`appmanifest_*.acf`) and trigger updates or launches through OS-native `steam://` and `com.epicgames.launcher://` deep links — no screenshot-based UI automation, no scraping.

### Added — Background topic monitoring
- New `add_topic_monitor`, `remove_topic_monitor`, `list_topic_monitors`, and `check_topic_monitors` tools (`lib/background-monitor.js`) let GemAir watch a news topic and proactively alert only when the top headline changes, once per day per topic. Ships with the same crypto/finance topic block-list as Mark-LIII's `background_monitor.py`. A new hourly scheduler in `main.js` runs the check automatically and surfaces alerts through a new `monitor:alert` IPC event.
- All seven new tools are registered like GemAir's other 91 tools — same OpenAI-compatible tool-calling loop, same input validation/risk gating (`'safe'` risk level), callable from voice or chat with no UI changes.
- Regression-covered by `scripts/mark3-ports-test.js`.

## [2.5.3] — 2026-09-07

Apple HIG interface overhaul (original CSS only, no third-party assets): translucent menu bar with traffic lights, Finder-style sidebar, grouped cards, iOS switches and segmented controls, iMessage chat bubbles, sheet modals, Spotlight command palette, iOS-style Control Center with live network/battery readings, macOS System Settings layout with Apple & System section, calm Siri-style orb, Notification Center toasts, and PWA precache for the new Apple layer. Gemini Live model picker now filters to exact free-catalog IDs only.

## [2.5.2] — 2026-09-05

Production answer routing, honest provider status, real Gemini OAuth generation, minimal dark UI, and release-ready desktop distribution.

All notable changes to GemAir are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed — Gemini error transparency, voice close codes
- Gemini REST failures now include Google's own error text (bad key vs disabled API vs unknown model), and voice-socket drops report the WebSocket close code — so the next failure message identifies its cause instead of a bare status.
- ChatGPT authorize URL verified parameter-by-parameter against the published v2 package; only the redirect URI differs now (see report).

### Fixed — ChatGPT authorize URL, Gemini model discovery
- ChatGPT OAuth authorize URL now sends the two flags the working Codex CLI flow requires (`id_token_add_organizations`, `codex_cli_simplified_flow`), verified against the published v2 package — this was the `missing_required_parameter` rejection.
- Gemini settings gain one-click model discovery: the app asks Google what your own key can use and fills the picker, so retired model IDs stop causing `GEMINI_HTTP_404`. Desktop chat uses the same picked ID, and 404s now explain retired-model vs disabled-API.

### Added — Guided Codex login (no terminal needed)
- The ChatGPT row's Import button is now a full guided flow: if no Codex login exists, one click opens the visible login console, watches for the token file for 5 minutes, and imports it automatically on success. Missing Node.js and timeouts are reported honestly.
- The silent import path itself still never downloads or executes anything (regression-guarded).

### Fixed — Gemini OAuth invalid_scope + key-based generation
- Google sign-in now requests identity scopes only (`openid email profile`); the `generative-language` scope was rejected with `invalid_scope` and blocked login entirely.
- Fixed a latent crash in `setGeminiConnection` that referenced an undefined variable, failing every Gemini store write.
- Desktop Gemini generation now prefers the user's AI Studio API key (same field as the Live dialog) with the OAuth token as fallback, and reports `GEMINI_KEY_REQUIRED` with setup steps when neither exists.

### Added — Proactive OpenAI token refresh (desktop)
- Stored ChatGPT sessions now refresh 5 minutes before expiry via `grant_type=refresh_token` (no `code_verifier`, per OAuth rules), with refreshed tokens written back to the encrypted store and the next refresh rescheduled.
- Dead sessions (401/`invalid_grant`) surface the exact message "ChatGPT session expired — re-import Codex login" through the existing expiry channel; transient failures retry in 10 minutes.
- `scripts/chatgpt-refresh-test.js` covers request shape, failure mapping, refresh policy, scheduler window, and messaging.

### Added — Gemini Live full audio pipeline (voice dialog)
- `renderer/gemini-live.js` now runs real-time voice: 16-bit PCM 16 kHz mono mic capture in 100 ms frames over `realtimeInput.audio`, 24 kHz spoken answers played through Web Audio, AnalyserNode level meters, and VAD barge-in that cuts playback the moment you speak.
- Settings → Voice shows live connection state, mic/Gem level meters, START/STOP voice, and reconnect on drop. No new dependencies — native WebSocket + Web Audio only, everything stays in the renderer.
- `scripts/gemini-live-test.js` covers PCM conversion, 100 ms framing, base64 round trip, setup/text round trip, and disconnect recovery.

### Added — Expanded AI providers + free-model catalog (model switching)

- New **AI provider & free-model catalog** (`renderer/providers.js`, single source of truth): 21 providers, **38 free-tier OpenAI-compatible models** across Gemini, Groq, Cerebras, SambaNova, NVIDIA NIM, Together AI, Fireworks, xAI (Grok), Z.AI (GLM), Cohere, HuggingFace, DeepSeek, Mistral, OpenRouter, Hyperbolic, DeepInfra, SiliconFlow, Novita, plus local Ollama.
- **FREE MODELS panel in Settings → AI BRAIN**: one-click setup (fills base URL + model), auto-opens the provider's key page, "FREE" badges, plus a live list of any **local Ollama models** (keyless).
- **GemAir slash commands** in chat: `/providers`, `/models [filter]`, `/use <model>`, `/local` — switch the active model without opening settings.
- `detectProvider()` / `PROVIDER_NAMES` upgraded to recognize all new providers; `applyPreset()` now covers all of them.
- **Serverless FREE CORE fallback chain** (`api/chat.js`) broadened: it now tries Cerebras, SambaNova, Together, NVIDIA NIM, xAI, Z.AI, HuggingFace, DeepSeek, DeepInfra alongside Groq/Gemini/OpenRouter — so the cloud brain keeps answering even if a provider rate-limits.
- New IPC/preload `ai:listLocalModels` to discover keyless local Ollama models.
- `scripts/computer-agent-test.js` extended with catalog + wiring assertions.

### Added — Vendored upstream + GemAir Coding Agent

- **Vendored upstream source** — `vendor/computer-agent/` (suitedaces/computer-agent, Apache-2.0) and `vendor/opencode/` (sst/opencode, MIT) are now in-repo for auditability and extension. Both are reference-only and excluded from the packaged app (see `vendor/README.md`).
- **Coding Agent (GemAir, keyless)** — a local repo-coding agent: point it at a project folder and it reads your repo, plans, edits files and validates, using the keyless brain (local Ollama first). New tool `run_coding_cli` (delegates to a user-installed local coding CLI, keyless via Ollama); the agent runs on the existing `list_directory`/`read_file`/`write_file`/`search_files`/`run_command` tools.
- Coding Agent is gated on the new `allowCodingAgent` preference, with `codingAgentAuto` (skip per-edit confirms) and `codingAgentMaxSteps`. New `agent:codingUse*` IPC, preload bridge, renderer modal (folder + task + live step log) and command-palette entry.
- `scripts/computer-agent-test.js` extended to verify the Coding Agent wiring.

### Added — Desktop Agent / Computer Use (keyless)

- **Computer-Use agent** — a real desktop agent that drives your mouse, keyboard, screenshots and terminal to carry out a task you describe. **No API key, no Claude, no vendor.**
- New keyless input primitives in `lib/computer-agent.js`, all on-device via OS-native calls (PowerShell on Windows, AppleScript/cliclick on macOS, `xdotool` on Linux). No native Node addons, no rebuild.
- New tools registered in `main.js` `TOOLS`: `get_screen_size`, `capture_agent_screen`, `describe_screen`, `move_mouse`, `mouse_click`, `type_text`, `press_key`, `scroll_mouse` — all gated on the new `allowComputerUse` preference and human-in-the-loop confirmation (or opt-in auto-approve).
- `computerUseAgent` loop: screenshot → vision model decides → tool executes → re-look, up to N steps. Prefers a **keyless local Ollama** (auto-detected at `localhost:11434`), then the user's optional free-tier key, then a deterministic no-model `offlineComputerUse` fallback.
- Safety: every mouse/keyboard action is OFF until enabled, confirmed per-action unless auto-approved, and `press_key` accepts only validated key tokens (no shell injection). The agent is instructed to never type secrets or perform destructive actions.
- Renderer: new **Desktop Agent** modal (task input, run/stop, live step log, screen size chip, auto-approve toggle), Settings toggles, command-palette entry, and `agent:computerUse*` IPC bridge.
- Test: `scripts/computer-agent-test.js` (auto-run in `npm run check`) verifies the module loads keyless, safe builders reject shell input, and the tool/IPC/preload/renderer wiring is intact.

## [2.5.0] — 2026-08-22

Round 6 v2.5 "ANYWHERE & HARDENED" — the free core survives real scale, the web build installs anywhere as a PWA, and every API endpoint shares one guarded, timeouted HTTP layer.

### Changed — Topbar cleanup

- **Topbar slimmed**: SFX toggle, theme swatches + name tag, and Get App button removed from header — all live in Settings where they belong (APPEARANCE section now has a DOWNLOAD GEMAIR button). Header is now: brand → clock → mode chips → brain chip → settings gear. Compact 8px padding, smaller brand orb (32px), smaller heading.
- **Settings gear icon fixed**: replaced the corrupted SVG path (broken arc coordinates `4.6 15`) with a clean gear character that renders correctly.
- **Clock modernized**: thinner mono weight (500), tighter letter-spacing (3px), slightly smaller (17px) for a sleeker digital look.
- **Dead code cleaned**: removed all JS handlers for the removed elements (theme-btn swatches, sfxBtn toggle, downloadBtn open) and matching CSS — zero dangling references.

### Changed — Interface polish pass

- **Command-centre tightening**: panels are now 14×16px padding with 12px radius and subtler backdrop blur; grid gap dropped to 12px; left column narrowed to 278px, right column widened to 340–420px for tool I/O; topbar compact (10px padding, smaller clock, static accent line); headings tightened to 11.5px/2px spacing; scrollbars styled; footer dimmed to 55% opacity; news items, briefing chips, satellite tabs, expert tabs, chat input, toasts, town preview — all tighter.
- **Orb panel hero treatment**: subtle inner accent glow, refined shadow, tighter padding.
- **Mobile responsive**: tighter topbar and panel padding at ≤600px.

### Changed — Stonic-exact interface cleanup

- **3D panel tilt removed** — panels no longer bend/perspective-shift on hover; the HUD is rock-steady like the reference.
- **Avatar removed** — the center column is now the pure Stonic composition: MEMORY/SKILLS/SOUL/SETTING circuits wired into the particle sphere with START AI (the spoken-voice gender switch stays).
- **MEDIA LINK panel removed** from the left column — the dashboard is now NOW card + SAT-LINK feed + numbered headlines + briefing, matching Stonic's tighter composition.
- **"1 degraded component" toast suppressed** in web mode — a single desktop-only subsystem failing to initialise is no longer alarming; the toast only fires in Electron or when ≥2 components fail.
- **First-run onboarding trimmed to welcome → name → voice** — theme selection lives in Settings → HUD THEMES where it belongs.
- **DEMO VIDEO / FEEDBACK topbar pills removed.**
- **Fixed a silent onboarding breaker**: four multi-element selectors had been mangled to single-element lookups, so the wizard's CONTINUE/voice buttons never wired at runtime. All repaired.

### Added — Local voice commands (Stonic pitch, fully free)

- **Natural desktop control with zero AI keys**: typed or spoken phrases now execute REAL actions locally through the existing desktop bridge — "open premiere", "switch to spotify", "volume to 40", "mute", "battery", "ram", "disk space", "system status", "snap window left", "close all windows", "next desktop", "search AI news on youtube", plus hands-free notes ("note that…"), reminders ("remind me to… in 20 minutes") and tasks ("add task …"). Precision-first matching (whitelisted app names + clear patterns) so normal conversation is never hijacked; anything unmatched still flows to the AI brains where all 79 tools remain available behind HITL confirms.
- **Stonic-style topbar**: ▶ DEMO VIDEO and 💬 FEEDBACK pills beside the logo; headlines are now numbered (01, 02, 03…) exactly like the reference interface; chat input placeholder matches the "Type instruction or / command" convention.

### Added — Stonic-parity interface upgrades

- **Cinematic first-run onboarding**: a four-step wizard (welcome → your name → live HUD theme picker → voice choice with instant sample) over the ambient score, exactly matching Stonic v1.0.55's redesigned onboarding. Theme cards are generated from `themes.js` so new themes appear automatically; the ambient score plays only during the wizard and your saved preference is restored afterwards. Re-runnable anytime via Settings → IDENTITY → **REPLAY FIRST-RUN INTRO**, or `gemair.onboardReplay()` in the console. The classic chat-based ask remains as an automatic fallback if the wizard cannot run.
- **Dynamic HUD navigation** (Stonic v1.0.33 parity): Gem can now drive the interface itself — "open Agent Town", "show World Monitor", "go to System Core", "open settings", "open themes" work typed or spoken, in every runtime (Electron, web, offline brain).
- **Honest Plan-Act reporting**: mission steps without a mapped tool are now marked **skipped** (strikethrough, excluded from success count) instead of silently faking success.
- Boot BIOS line no longer hardcodes a version number (was still reading 2.4.0).

### Added — Remote access from anywhere

- **PWA install**: `renderer/manifest.webmanifest` + `renderer/sw.js` service worker + guarded registration. The hosted web build now installs on phones/tablets/desktops (standalone window, maskable icon, offline app shell). Navigations are network-first with a cached fallback; static assets use stale-while-revalidate; `/api/*` is network-only with a graceful offline JSON so the UI degrades to the offline brain instead of throwing.
- **LAN access**: `npm run serve` now binds `0.0.0.0`, prints phone/tablet URLs from your LAN interfaces, and serves the correct `.webmanifest` MIME type.
- **REMOTE.md**: the complete guide — hosted web (anywhere), LAN, and Tailscale/Cloudflare Tunnel options for reaching a home desktop install, plus how Supabase sync keeps memory following you across devices.

### Added — Scale-proof free tier

- **Shared fair-use & throttle counters**: when `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel KV / any Upstash-compatible REST endpoint) are configured, daily fair-use and per-minute throttling count across ALL serverless instances via plain `fetch` — no SDK, ~one round-trip per message. Any KV failure silently degrades to per-instance counting. The old per-instance Maps remain the zero-config default.
- **Health endpoint upgraded** (`api/health.js`): per-provider key booleans (groq/gemini/openrouter/openai/override), Supabase status, shared-limiter status, uptime — never any secret values.

### Hardened — One guarded API layer

- New **`api/_lib/http.js`**: single-source origin allow-list, precise CORS (echoes exactly the allowed caller origin), OPTIONS handling, JSON helpers, and `AbortController` deadlines for every upstream fetch.
- All endpoints (`weather`, `search`, `headlines`, `crypto`, `currency`, `dictionary`, `translate`, `config`, `health`) now run through the shared guard; previously only the chat proxy checked origins and several upstream calls had no timeout at all.
- **Wildcard CORS removed** from `vercel.json` — it let any website burn the shared free provider keys from a browser. A selfcheck guard now fails the build if it ever comes back.
- Input clamping/sanitization on query params (`coin`, `word`, `text`, currency codes); unknown crypto coins now answer honestly instead of returning a stale fake price; simulated fallbacks stay clearly badged.
- Version is single-sourced in `api/_lib/http.js` and asserted equal to `package.json` by selfcheck.

### Fixed

- **WEB SEARCH WAS BROKEN — now fixed and live-verified.** It relied on DuckDuckGo's *Instant Answers* API, which returns EMPTY results for most queries (it is not a general search engine). Both runtimes now scrape **DDG HTML organic results** (free, keyless, ads filtered via the `y.js` redirect check) with a Wikipedia → Instant-Answers fallback chain; the web endpoint adds a Hacker News Algolia supplement for sparse queries and reports which sources were used. Verified live: "best laptops 2026" returns 8 real results (PCMag/CNET/Tom's Hardware).
- Every network fetch in the desktop tool layer (`web_search`, `get_weather`, `fetch_webpage`, `search_wikipedia`) now carries an AbortController deadline — a hung endpoint can no longer pin a tool call.
- **Plan-Act volume steps were a hardcoded fake success** (`control_volume` did nothing but report ok). Steps now route through the real tool over IPC (`desktop:setVolume` → `executeTool('control_volume')`), so HITL policy and the action log apply exactly as for AI-initiated calls. Preload exposes `desktopSetVolume`.
- Plan-Act retry path now retries volume/gaming/snap steps too (it silently skipped them before).
- Removed the dead line and duplicated battery write in `updateNowCard()`.
- Documentation drift: the tool registry is exactly **79 tools**; README/GUIDE/AI-FRAMEWORK now all say 79.

### Improved — Interface

- **Code blocks gained a COPY button** next to SAVE TO FILE (clipboard write with ✓ feedback and graceful fallback when clipboard is blocked).
- The SAVE/COPY buttons are actually styled for the first time (they shipped as unstyled default browser buttons) — themed borders, hover glow in the active accent, press feedback.
- Accessibility: visible `:focus-visible` keyboard focus rings themed to the active HUD accent.
- Themed slim scrollbars across the app.
- Smoother message entrance animation that respects `prefers-reduced-motion`.

## [2.4.0] — 2026-08-21

Round 5 v2.4 "CONNECTED DESKTOP AGENT" — three leaps at once: true account connect like Stonic (no API keys ever), agentic desktop management, user-defined MODES that arrange the whole desktop from one sentence.

### Added — Section 0 Recon

- **CONNECTIONS.md** with full product research (home, /jarvis-ai-for-pc, /features/*, /about, /changelog v1.0.0→v1.0.55, /guide, product blog) and mermaid architecture diagram of ChatGPT-connect flow: embedded login → session capture → consumer backend → tool layer → voice. Marked confirmed vs inferred.

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
