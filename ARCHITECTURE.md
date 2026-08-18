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

## 3. The tool-calling loop (when an LLM key is present)

Gem is not a chatbot with a search box bolted on. She runs an agent loop:

1. Build the system prompt (§5) and append the running chat history.
2. Send it to the provider with a **tool schema** describing every capability.
3. If the model returns `tool_calls`, execute them **in the main process**,
   append the results as `role: "tool"` messages, and send the conversation
   back.
4. Repeat until the model answers in prose, or a hard iteration cap trips
   (`TOOL_LOOP`) — which prevents infinite tool ping-pong.
5. Stream the final answer token-by-token to the renderer over
   `ai:chunk` / `ai:streamEnd`.

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

## 6. Gem's presence — `renderer/avatar.js`

A software 3D renderer on a 2D canvas. No WebGL, no three.js, no CDN — so it
works offline in Electron and adds zero bytes of dependency.

**Geometry.** The head is *not* a deformed sphere (that reads as an egg). It
is built from an explicit anatomical profile: a `WIDTH` table and a `DEPTH`
table sampled with smoothstep down the skull, giving a real cranium, temples,
cheekbones, jaw and a rounded chin. `surface(y, phi)` then adds a brow ridge,
a nose ridge, a muzzle and a chin projection. Facial features are placed with
`facePoint()`, which solves for the front surface so eyes, nose and mouth sit
*on* the face at any rotation. Proportions follow the classical thirds —
brow ≈ +0.16, nose base ≈ −0.44, mouth ≈ −0.62, chin = −1.

**Animation.** Every driver is a smoothed value updated with a frame-rate
independent `approach()`, so the motion is identical at 30fps and 144fps:

| Driver | Source |
|---|---|
| `mouth` | syllable envelope, re-triggered by real speech word boundaries |
| `eyeOpen` | blink scheduler (random 2.2–6.7s) × emotion openness |
| `smile`, `browRaise` | the emotion table |
| `gazeX/Y` | saccades — the eyes drift, then flick |
| `rotX/rotY` | idle sway + pointer parallax |
| `breath` | slow sine, faster while speaking |
| `glow` | speaking > thinking > listening > standby |

**Emotion → face.** The emotion detected in §2 is pushed straight to
`setEmotion()`. Seventeen emotions each map to a smile curve, brow angle, eye
openness and a colour tint that blends with the active theme accent.

---

## 7. Agent Town

Four resident agents (Alice, Bob, Carol, Dave) with desks, roles and live
status, rendered on a canvas. They walk, work, meet and idle. `@Alice <task>`
routes the task to that agent's own brain via `ai:agentChat`, and the mission
log records who did what — the transparency principle: **every action Gem
takes is visible and auditable.**

---

## 8. Failure policy

Learned from a build where one bad line killed every button:

1. **Never let init throw.** `boot()` wires listeners early; anything that can
   fail (tray, Supabase, avatar, version lookup) is wrapped.
2. **Degrade, don't disappear.** No key → offline brain. No network → local
   memory. No tray → the window still closes normally.
3. **Guard every optional integration.** `avatar()` and `avatarEmotion()` are
   no-ops if `avatar.js` failed to load.
4. **Migrate, don't orphan.** The GemAI → GemAir rename copies old
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
