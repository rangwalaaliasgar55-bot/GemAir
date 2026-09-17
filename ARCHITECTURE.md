# GemAir — Architecture

How Gem thinks, remembers, acts and stays alive. This is the reference for
*why* the code is shaped the way it is.

- **Product:** GemAir — a free, open-source, JARVIS-style command centre.
- **The AI:** **Gem** — the persona the user actually talks to.
- **Version:** 1.0

---

## 1. The shape of the system

GemAir runs as **two products from one codebase**:

| | Desktop (Electron) | Web (Vercel) |
|---|---|---|
| Entry | `main.js` → `renderer/index.html` | `renderer/index.html` (static) |
| Bridge | `preload.js` → `window.gemair` | absent — mock bridge in `app.js` |
| Memory | JSON files in `userData` | `localStorage` + optional Supabase |
| AI key | user's key, stored locally | server-side key in `api/chat.js` |
| Hands | real OS control | web tools only |

The renderer never knows which one it is running in. It talks to a single
`api` object at the top of `renderer/app.js`; every method checks
`window.gemair` and either forwards over IPC or runs a browser equivalent.

```
             ┌──────────────────── renderer/ ────────────────────┐
             │  index.html   app.js   avatar.js   store.js  css   │
             └───────────────┬───────────────────┬───────────────┘
                             │ window.gemair     │ fetch('/api/*')
                   ┌─────────┴────────┐   ┌──────┴───────────┐
                   │ preload.js (IPC) │   │ Vercel functions │
                   └─────────┬────────┘   └──────┬───────────┘
                             │                   │
                   ┌─────────┴────────┐   ┌──────┴───────────┐
                   │ main.js  (Node)  │   │ Supabase (RLS)   │
                   │ files·apps·shell │   │ cross-device mem │
                   └──────────────────┘   └──────────────────┘
```

**Design rule:** the renderer is a pure client. Anything privileged — the file
system, shell commands, secret keys — lives behind `preload.js` or behind a
serverless function. `contextIsolation` is on and `nodeIntegration` is off.

---

## 2. The message pipeline

Everything the user types or says enters one funnel. `sendMessage()` is a thin
wrapper that only manages the avatar's "thinking" state; `handleMessage()` is
the real pipeline.

```
 input (typed / spoken)
   │
   ├─ 0. onboarding?        first run → capture the user's name, stop
   │
   ├─ 1. emotion analysis   analyzeEmotion() → {emotion, valence, intensity}
   │                        persisted as a mood point when it is meaningful
   │
   ├─ 2. language detect    en / hi / ur / hinglish → Gem replies in kind
   │
   ├─ 3. crisis + support    distress signals bypass tools entirely and
   │                        answer with empathy first
   │
   ├─ 4. agent routing      "@Alice do X" → that agent's own brain
   │
   ├─ 5. brain selection
   │      ├─ LLM available  → tool-calling loop (§3)
   │      └─ no key         → offline brain (§4)
   │
   ├─ 6. render             typewriter output, code blocks, citations
   │
   └─ 7. remember           transcript append + automatic fact extraction
```

Each stage is deliberately skippable. A missing API key degrades to the
offline brain; a failed web tool degrades to a plain answer. **No stage can
throw and take the app down** — that was the class of bug that made the old
build feel dead.

---

## 3. The tool-calling loop & Risk Policy (when an LLM key is present)

Gem runs a parallel, risk-aware agent loop:

1. Build the system prompt (§5) and append running chat history.
2. Send to provider with tool schema (`TOOLS`).
3. If model returns `tool_calls`, categorize each tool by risk (`TOOL_RISK`):
   - **Safe / Read-only**: (`get_weather`, `web_search`, `calculate`, `get_current_time`, `search_memory`) -> auto-approved.
   - **Sensitive / Write**: (`run_command`, `write_file`, `control_system`, `send_email`) -> requires permission policy or explicit consent.
4. Execute non-conflicting tool calls in parallel using `Promise.all`. Append results as `role: "tool"` messages and pass back to the provider.
5. Repeat until model answers in prose or iteration cap (`TOOL_LOOP = 6`) trips.
6. Stream final response token-by-token with audio lip-sync and visual timeline indicators.

Tool families: time & date · web search · page fetch · Wikipedia · YouTube ·
translate · dictionary · crypto · currency · weather · file read/write ·
app launch · clipboard · volume · screenshots · reminders · notes · to-dos ·
goals · mood · affirmations · wellness.

**Truthfulness is enforced at the prompt layer.** Gem is instructed to call
`web_search` / `verify_claim` for anything factual or time-sensitive and to
cite inline, and to say "I don't know" rather than guess. Fabrication is the
one failure mode a personal assistant cannot recover from.

---

## 4. The offline brain (no key, still useful)

Without any API key GemAir is still a working assistant, because the *tools*
are free — they need no model at all. `offlineBrain()` is an intent router:

| Intent | Route |
|---|---|
| greeting / identity | canned persona replies |
| weather | `/api/weather` → Open-Meteo |
| search / "who is" | `/api/search` → DuckDuckGo + Wikipedia |
| translate | `/api/translate` → MyMemory |
| define | `/api/dictionary` |
| price / crypto / currency | `/api/crypto`, `/api/currency` |
| news | `/api/headlines` → Hacker News |
| maths | local expression evaluator |
| memory ops | notes, goals, reminders, facts |

Every one of these APIs is free and keyless. That is the whole point: the
free tier is not a demo.

---

## 5. Memory — how Gem "remembers everything about you"

Memory is **local-first**, then mirrored. Nine live collections:

| Collection | Meaning |
|---|---|
| `facts` | durable truths about the user (name, job, preferences) |
| `transcript` | rolling conversation log, capped at 2000 turns |
| `notes` | the notebook |
| `reminders` | time-triggered, fired by the main-process scheduler |
| `todos` | task list |
| `mood` | emotional history with valence, drives the check-in |
| `goals` | life / career / study / health / finance |
| `skills` | abilities Gem has learned and can reuse |
| `instructions` | standing rules the user set, always obeyed |

**Write path:** every mutation writes to the local store first (file or
`localStorage`) and *then* fires a best-effort Supabase upsert. The UI never
waits on the network, and going offline loses nothing.

**Caps without amnesia (2.12):** the hot collections are bounded (facts 300,
transcript 2000, action log 200, mood 500) — but since 2.12 every eviction is
archived before it trims, into `lib/memory-archive.js`
(`<userData>/gemair-memory-archive.json`): an append-only cold store with
redaction-on-write and checkpoint rotation. `search_memory` falls back to it
automatically (answers marked `archived: true`), and GemCore's scoped
`MemoryStore` does the same per-scope with `remember()` reporting what it
evicted. The earlier "capped blob that silently deleted the oldest entries"
failure mode (documented upstream in Mark-LII/LIII) is explicitly designed
out: memory is a lookup-on-demand store, not a shrinking blob.

**Read path on startup:** load local; if a collection is empty and Supabase is
connected, seed it from the cloud.

**Automatic extraction:** after each exchange, `memoryExtract()` mines the
turn for durable facts and de-duplicates them against what is already stored,
so Gem accumulates a model of the user without being asked to.

**Privacy:** Supabase rows carry `user_id uuid default auth.uid()` and every
table has an RLS policy of `auth.uid() = user_id`. Anonymous sign-in gives
each browser a stable identity with no login screen, and the policy makes
cross-user reads impossible even with the public anon key.

---

## 6. Gem's presence — `renderer/avatar.js` & Audio Engine

Gem's portrait is rendered on a high-performance 2D/2.5D canvas with real-time Web Audio API frequency analysis and dynamic lip-sync.

**Web Audio Spectrum & Lip Sync.**
When speech audio plays (Google Neural TTS or Web Speech API), an `AudioContext` and `AnalyserNode` extract real-time frequency FFT spectra (64/128 bands):
- **Aperture (`mouth`)**: Scaled dynamically by real-time audio RMS volume.
- **Visemes (`mouthW`, `mouthR`)**: High vs. low frequency energy ratio maps mouth width, rounding, and vowel shapes.
- **Transcript-driven phonemes (2.12)**: word-boundary events (system voice `onboundary`, Edge `WordBoundary`) and the Gemini Live *output transcription* feed `visemesForWord` → `speakWord`, so the mouth articulates the actual words — bilabial closures on m/b/p (`MM`), spread on i (`EE`), rounding on u (`OO`), teeth-on-lip on f/v (`FV`) — not just a jaw tracking volume. Letter mapping is **Unicode-reduced**: NFD strips accents, Cyrillic and Greek letters map onto the same measured-shape rig (Greek ου → one rounded shape), and unmapped scripts fall back to a neutral open shape — one rule set articulates Latin, Cyrillic and Greek transcripts.
- **Micro-movements**: Micro head-nods and subtle eye tracking react to voice intensity surges.
- **Radial Audio Spectrum Ring**: An interactive circular frequency ring renders around Gem's head during speech and microphone input.

**Synthetic Web Audio SFX Engine.**
A zero-dependency Web Audio oscillator engine generates instant synthetic audio feedback for UI clicks (`click`), AI activation (`activate`), incoming responses (`message`), view switches (`swoosh`), and errors (`error`). Includes a topbar toggle (`🔊 SFX ON / 🔇 SFX OFF`).

**Emotion → face.** The emotion detected in §2 is pushed to `setEmotion()`. Seventeen emotions each map to eyebrow curves, eye openness, smile/frown curves, head tilt intensity, and glowing color tints that blend with the active theme (Crimson, Emerald, Cyan, Violet, Amber, RGB).

---

## 7. Agent Town

Four resident agents (Alice, Bob, Carol, Dave) with desks, roles and live
status, rendered on a canvas. They walk, work, meet and idle. `@Alice <task>`
routes the task to that agent's own brain via `ai:agentChat`, and the mission
log records who did what — the transparency principle: **every action Gem
takes is visible and auditable.**

---

## 8. Failure policy

Learned the hard way. `startBackground3D()` contained:

```js
w = canvas.clientWidth  = window.innerWidth;   // TypeError
h = canvas.clientHeight = window.innerHeight;
```

`clientWidth` / `clientHeight` are **read-only getters** on `Element`. Under
`'use strict'` assigning to them throws — so `resize()` threw, `boot()` threw,
`bindEvents()` never ran, and **every button in the app was dead** while the
interface looked perfectly fine.

Three barriers now make that class of failure survivable:

1. **Order.** `bindEvents()` runs *before* any decorative init. The controls
   are live before anything that can fail.
2. **Isolation.** Every remaining step goes through `safe()` / `safeAsync()`,
   which log, record the failure in `window.__gemairInitFailures`, show one
   "DEGRADED" toast, and return control. One broken component cannot cascade.
3. **Safety net.** `window.onerror` and `onunhandledrejection` call
   `ensureInteractive()`, which binds events if boot never got that far.
   `bindEvents()` is idempotent, so this can never double-bind.

And `npm run check` (`scripts/selfcheck.js`) fails the build on:
assignment to any read-only DOM geometry property, duplicate element ids,
`$('#id')` that resolves to null, dead `$$()` selectors, and — the important
one — **it boots the app in a fake DOM whose geometry properties are
getter-only, then asserts the key controls actually have listeners.**

Further rules:
4. **Degrade, don't disappear.** No key → offline brain. No network → local
   memory. No tray → the window still closes normally. Anonymous sign-ins off
   → memory stays local and Gem says so, rather than throwing.
5. **Guard every optional integration.** `avatar()` and `avatarEmotion()` are
   no-ops if `avatar.js` failed to load.
6. **Migrate, don't orphan.** The GemAI → GemAir rename copies old
   `localStorage` keys and old `userData` files forward on first run.

---

## 8b. GemCore — the hardened provider engine (`lib/gemcore/`)

A self-contained, dependency-free engine suite (ported from the ALTREX provider
engine and AERA agent systems) that sits beside the existing brains:

| Module | Role |
| --- | --- |
| `provider-registry.js` | Catalog of OpenAI-compatible providers with pinned base URLs and an allowlist for every external link the app may open. |
| `provider-errors.js` | Classifies raw HTTP failures into honest categories (invalid key / model not found / rate limited / quota exhausted / tools unsupported…) with secrets scrubbed. |
| `request-manager.js` | The pipeline every provider request goes through: per-attempt timeouts, deadline, exponential backoff honoring `retry-after`, per-provider circuit breaker, abort-safe SSE parsing, context compaction, storage redaction. |
| `model-registry.js` | Persistent per-provider model lists: defaults, disables, removals, live status, fallback resolution. |
| `model-router.js` | Routes each request between a reasoning tier (deliberate, tool-heavy) and a direct tier (fast chat). |
| `provider-service.js` | Provider lifecycle: connect with a live validation call, discover models, disconnect, health status, diagnostics, and layered recovery across configured providers. |
| `task-budget.js` | Per-task token / tool-call / duration budgets so a runaway loop can't burn quota forever. |
| `tool-broker.js` | Impact-tiered tool gating (LOW/MODERATE/HIGH/CRITICAL), per-task and per-session approvals, path-traversal defense, audit records. |
| `agent-runner.js` | The provider-facing agent loop (batch + streaming): rounds of completion → tool calls → observations with compaction, budgets, and honest system-error recovery messages. |
| `multi-ai.js` | The Director: validates team plans (DAG, no cycles), runs specialist agents in dependency order, passes upstream outputs downstream, marks dependents of failed agents honestly. |
| `memory-store.js` | Scoped memory (user / task / long-term) with secret redaction, dedup, keyed updates, and relevance-ranked recall. |
| `audit.js` | Append-only, hash-chained local audit log with hygiene (prune + re-tighten the chain). |
| `reasoning.js` | Reasoning levels (reflex / heuristic / deliberate / deep), scaffold prompts, and a session trace. |
| `emotion-profiles.js` | Voice emotion superset in the TTS engine's own delta format (7 new dialogue states), text→emotion classification, and user-sentiment adaptation. |

Wiring: `main.js` builds the stack once (`createGemCore(userDataDir)`), exposes
33 `gemcore:*` IPC channels, and `preload.js` bridges them as `window.gemcore`
(the block sits before the `air` bridge so the attention-contract test's
extraction stays scoped). `renderer/gemcore-ui.js` owns the settings section,
the Multi-AI team modal, and the TTS emotion extension. Tests:
`npm run test:gemcore` (part of `npm run check`).

---

## 9. Deploying

**Web.** `vercel.json` uses modern `rewrites` + `headers`. Do not reintroduce
`routes` alongside `headers` — Vercel rejects that combination outright and
*every* deploy fails while the URL keeps serving a stale build.

**Database.** Migrations live in `supabase/migrations/` with timestamped
names; the Supabase GitHub integration applies them automatically on merge to
`main`. They are idempotent (drop-then-create policies), so a repeated deploy
cannot fail with "policy already exists".

**Desktop.** `scripts/release-workflow.yml` (move it to
`.github/workflows/release.yml` to activate) builds Windows, macOS and Linux
installers on a `v*` tag and attaches them to a GitHub Release. The in-app
Download dialog reads that release from the GitHub API, so publishing a tag is
all it takes for "Get the app" to go live.

---

## 9b. The 2.12 voice-loop & autonomy layer

**Long-horizon Gemini Live (`renderer/gemini-live.js`).** One WebSocket
carries mic PCM upstream, model PCM downstream, typed turns, and — new in
2.12 — video frames (`realtimeInput.video`) and long-horizon session state:

- `session_resumption`: handles from `sessionResumptionUpdate` are stashed and
  re-attached on every reconnect path (drop, goAway, manual reconnect).
- `context_window_compression: { sliding_window: {} }`: on by default —
  hours-long live conversations without the full-context death.
- Enhanced-vs-degraded setup: if the server closes the socket before
  `setupComplete`, the session retries once with the plain setup and flags
  `_degraded` (never loops the enhancement).
- `serverContent.interrupted` → immediate playback-queue flush + UI callback;
  `goAway.timeLeft` → early reconnect before the server walks away.
- Output transcription → captions + avatar visemes (see §6), input
  transcription opt-in.

**Fused live vision.** `vision:screenFrame` IPC (main): `desktopCapturer`
~1 fps JPEG, gated on the Screen Awareness permission, throttled, honest
error vocabulary. The renderer's Live card toggles stream screen/camera
frames into the *running* session as media chunks — one socket, so "what's
on my screen?" is answered in the same breath as everything else.

**Plugins (`plugins/` → `lib/plugin-loader.js`).** Single-file skills:
`{ PLUGIN: { name, description, parameters, risk }, run(args, context) }`
discovered at boot and merged into the model catalog via `getAllTools()` at
every call site. Dispatch happens before the built-in switch inside the same
risk gates; `risk: 'sensitive'` plugins prompt the human. Failures (invalid
shape, name collision, throw inside `run`) become tool errors, never crashes.
`plugins/_template.js` is the canonical, self-validating example; an
underscore prefix means "docs, don't load".

**Proactive engine (`lib/proactive.js`).** Pure functions over the memory
file: `recordSessionSummary` (quit-time topic distillation),
`buildGreeting` (once-per-launch, time-of-day/reminders/monitors/last-session,
consumed exactly once), `buildCheckIn` (opt-in, 3h rate limit, quiet
22:00–07:00, rotation-aware). The main process hosts a 5-minute scheduler
and pushes `proactive:greeting` / `proactive:checkin` to the renderer.

**Local-secret guard (`lib/local-secret-check.js`).** At startup in source
checkouts: `git ls-files` is scanned for secrets-shaped paths (`.env*`,
`api_keys.json`, certs/keys, memory exports). Hits warn in-chat with
`git rm --cached` guidance and the revoke-and-rotate rule from `SECURITY.md`.
Non-git installs skip silently.

**OS-aware installer (`scripts/setup.js`, `npm run setup`).** Interpreter
gate (Node ≥ 22.12 with a one-sentence failure), checkout completeness,
per-OS dependency plan + system notes, optional `--with-browser` Playwright
Chromium install, `--check` validation mode for CI.

---

## 9c. The 2.13 accountability layer

**Undo stack (`lib/undo-stack.js`).** One shared journal where every
reversible file tool registers its reversal at the moment it acts. Semantics
ported from Mark-LIV's `core/undo.py`: reversal runs only on demand; >1 MB
snapshots are refused with a note (no hoarding); created files are removed
only while byte-identical to what we wrote (user edits are never destroyed);
folders only while empty; move-backs refuse on collisions and stay on the
stack with their reason. `undo_last` still passes a human confirm — reversal
is itself a state change. Live cap 25; evictions go to the memory archive.

**Clipboard intelligence (`lib/clipboard-intel.js`).** An opt-in 1.2 s poll in
main (`electron.clipboard.readText` — the loop exists only while enabled).
Classification (url/secret/long/text), secrets redacted at rest via
`lib/privacy-redaction.js` and never shown in the floating panel, ring of 30
with archive-on-evict. Bridge: `clipIntel:list/recall/clear/stats` +
`clipIntel:new/secret` pushes; renderer card stages prompts, never sends.

**Self-echo guard (`renderer/echo-guard.js`).** Transcript-level echo
suppression: `speak()` registers normalized text; the SpeechRecognition
handler drops exact/partial echoes and strips echo prefixes, keeping genuine
continuations. 8 s expiry window, bounded 12-entry ring, mic never muted.

**Runtime self-knowledge (`lib/self-knowledge.js`).** `refreshSelfKnowledge()`
(main) snapshots the live registry after boot and every plugin reload — tool
names, plugin names+errors, capability flags, memory/archive counts — and the
honest limits, injected into every system prompt as
`RUNTIME SELF-KNOWLEDGE`. Tool: `get_assistant_capabilities` for
mid-session freshness.

**Instant acknowledgment (`renderer/instant-ack.js`).** `executeToolNow`
emits `tool:started` for the gap-prone set AFTER all confirm gates pass;
the picker renders one line in the user's language (10 locales shipped),
rotated, spoken unless Gem is already mid-sentence (then a toast).

**Auto-start (`lib/autostart.js`).** Electron `setLoginItemSettings` per-OS
(Run key / Login Item / XDG `.desktop`), state read back from the OS,
never hidden, dev-mode caveat on unpackaged Linux.

**Live-loop fixes.** Transcript-tail de-dup against a 600-char turn
accumulator (Live API re-sends tails across tool-call turn-completes);
rejected resumption handles dropped after exactly one replay; socket-epoch
guard so a previous socket's trailing close can't consume a new attempt's
settlement.

---

## 9d. The 2.14 honesty surface — devices, presence, labelled vision

**Audio device picking (`renderer/audio-devices.js`).** `listAudioDevices()`
wraps `enumerateDevices` with Chromium's label problem solved honestly:
names are hidden until the mic has been granted once, so it opens the mic
one time, re-enumerates, and stops every track — a denied grant returns
`{ok:false, error}` instead of a dead list. `filterDeviceList()` keeps the
picker short and truthful (dedupe by `deviceId`, default first, synthesized
names for empty labels, 48-char trim, 8 per kind). `resolveSaved()` treats
`''` as \"system default\" and reports `fellBack:true` with the lost
device's name when a saved pick has vanished — never a silent substitution.
`probeMic()` opens the candidate with `deviceId:{exact}` (the reported
track label must be truthful about *which* device answered), measures open
latency, and releases in `finally`. Capture sites (`app.js` mic meter,
`gemini-live.js`, `wake-word.js`) use `{ideal}` instead — unplugged
hardware degrades to default instead of erroring. Speaker routing flows
through `window.__gemSpeakerDeviceId` + guarded `setSinkId` on every
playback element; the UI note is explicit that the OS web-speech voice
cannot be routed at all.

**Avatar presence (`renderer/avatar.js`).** A pure `presenceFor(mode)` map
turns intent into physiology: `thinking` damps pointer tracking and slows
blinks; `listening` raises pointer damping so the eyes meet the cursor;
`sleeping` caps the eyelids low and the breath at a third rate; `glance`
leans gaze down. `currentPresenceMode()` resolves a total priority
(glance > sleeping > thinking > listening > base) from state the app
already knows, and `glance(ms)` is edge-triggered, clamped 250ms–2.5s, and
refuses to interrupt thought or sleep. The renderer drives it from real
events (auto-sleep timeout, wake-word re-arm, ai/system cards landing) —
the face is a status channel, not decoration.

**Source-labelled vision (`labelVisionSource` in `gemini-live.js`).**
Before the first frames of a screen share or camera share flow, one in-band
`clientContent` note declares the source — and the screen note names the
trap (\"may contain the GemAir window itself … never a photo of the
user\"). Both call sites are ordered before their send loops and the
one-shot `see_screen` tool annotates its result (`source:'screen'`) the
same way, so one-shot and streaming vision share the contract.

## 10. Where to add things

| I want to… | Touch |
|---|---|
| add a free web tool | `api/<name>.js` + a branch in `offlineBrain()` |
| add an LLM tool | tool schema + handler in `main.js` |
| **add a skill with zero core changes** | one file in `plugins/` (copy `_template.js`) |
| change Gem's personality | `buildSystemPrompt()` in `app.js` |
| change how Gem looks | `renderer/avatar.js` |
| add a memory collection | `store.js`, `main.js`, a new migration |
| add a view | a `<section class="view">` + a `.nav-btn[data-view]` |
