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

Memory is **local-first**, then mirrored. Nine collections:

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

## 10. Where to add things

| I want to… | Touch |
|---|---|
| add a free web tool | `api/<name>.js` + a branch in `offlineBrain()` |
| add an LLM tool | tool schema + handler in `main.js` |
| change Gem's personality | `buildSystemPrompt()` in `app.js` |
| change how Gem looks | `renderer/avatar.js` |
| add a memory collection | `store.js`, `main.js`, a new migration |
| add a view | a `<section class="view">` + a `.nav-btn[data-view]` |
