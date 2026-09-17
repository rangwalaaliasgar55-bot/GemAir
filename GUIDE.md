# GemAir — The Complete Guide

Everything you need to understand, use, and extend GemAir — your free, emotionally
intelligent personal AI.

---

## 🧭 What GemAir is

GemAir is a **JARVIS-style personal AI** for your computer (and the web). It's a
companion, not just a tool:

- It **understands how you feel** (emotion engine) and responds with empathy.
- It **never forgets** — memories, skills, rules, goals, mood and notes persist forever.
- It **tells the truth** — it searches real sources, cites them, and says "I don't know" instead of guessing.
- It **does real work** — 79 tools covering the web, your files, apps, and system.
- It's **free** — no $56 license, no subscription, and most features need no AI key at all.

---

## 🏗 Architecture

```
GemAir/
├── main.js                  # Electron main process — the "brain & hands"
│   ├── AI chat + streaming  #   OpenAI-compatible (Groq/OpenAI/Ollama) + tool-calling
│   ├── TOOLS registry       #   MCP-style: 79 typed functions (the "tool layer")
│   ├── emotion engine       #   17 emotions + valence/arousal/intensity
│   ├── support engine       #   compassionate responses + crisis detection
│   ├── memory store         #   local JSON (facts/transcript/notes/reminders/…)
│   ├── agents               #   per-agent brains (Alice/Bob/Carol/Dave)
│   └── system/automation    #   files, processes, volume, screenshots, control
├── preload.js               # secure contextBridge API (renderer ↔ main)
├── renderer/
│   ├── index.html           # UI structure (5 modules)
│   ├── style.css            # sci-fi HUD + 3 themes + glassmorphism
│   ├── app.js               # UI logic, streaming, voice, emotion, 3D
│   └── store.js             # browser memory (localStorage + optional Supabase)
├── api/                     # Vercel serverless functions (free web tools + chat proxy)
├── supabase/migrations/     # cloud memory schema, auto-applied on merge to main
└── build/icon.png
```

### The three layers (mirrors Stonic's design)

| Layer | Stonic | GemAir |
| --- | --- | --- |
| **Shell** | Electron (Windows app) | Electron (Win/macOS/Linux) |
| **Agent Town** | Phaser 3 pixel RPG | Hand-built canvas pixel office (no deps) |
| **Multi-agent** | Hermes runtime + MCP servers + WebSocket | Per-agent brains + MCP-style `TOOLS` registry + streaming |
| **Voice** | LiveKit + Gemini realtime ("Charon") | Web Speech STT + neural TTS + emotional prosody |
| **Backend** | Flask + Socket.IO | Electron IPC + Vercel serverless (web) |
| **Local-first** | ✅ transparent logs | ✅ local JSON + Mission Log |

---

## 🎙 Using the modules

| Module | What it's for |
| --- | --- |
| **Voice Core** | Talk or type. Particle orb + 2.5D Audio Spectrum Avatar with real-time FFT lip-sync + START AI loop + streaming replies. |
| **Desktop Manager** | Live telemetry gauges, **Memory / Processes / Notes / Reminders / Skills / Rules / Soul** tabs. |
| **Life Companion** | Mood graph, habits & goals checklist, Pomodoro focus timer, affirmations, wellness tips, life compass prompts. |
| **Agent Town** | Assign tasks to Alice/Bob/Carol/Dave — each has its own brain. |
| **Global Intel** | 3D globe, 2D command map, live crypto ticker, world weather, and headlines. |

### Themes & Sound FX
Choose between 6 dynamic theme presets (Crimson, Emerald, Cyan, Violet, Amber, Rainbow RGB) and toggle synthetic Web Audio sound effects (`🔊 SFX ON / 🔇 SFX OFF`).

### Talking to agents (independent brains)
Prefix a message with an agent's name to route it to *that* agent's own role-brain:

```
@Alice  research the best laptops under $1000 and summarize
@Dave   plan my study schedule for the next 2 weeks
```

Each agent has its own specialty (Alice = research, Bob = system, Carol = creative,
Dave = planning) injected as its own system prompt.

---

## 🧩 Plugins — one file, one skill (2.12)

Drop a single `.js` file into the app's `plugins/` folder and Gem learns a new
tool on next launch — no restart wiring, no registry edits. Copy
`plugins/_template.js` to start; every plugin is just:

```js
module.exports = {
  PLUGIN: {
    name: 'my_skill',                 // lowercase snake_case, unique
    description: 'When to call this and with what arguments.',
    parameters: { type: 'object', properties: { /* JSON Schema */ } },
    risk: 'safe'                      // or 'sensitive' → user confirms each run
  },
  async run(args, context) {
    return { /* any JSON-serializable result, sent back to the model */ };
  }
};
```

- Files whose name starts with `_` (like the template) are documentation and
  never load; nested folders are ignored. GemAir **never downloads plugin
  code** — only files you consciously place there run.
- Broken plugins can't break the app: invalid declarations show up in
  Settings → **Plugins** with the exact reason, and run-time throws become
  clean tool errors instead of crashes.
- `context` is deliberately small: `homeDir`, `platform`, app `version`, your
  saved `userName`, and `notify(title, body)`. Plugins never receive API keys
  or other plugins' state.
- The Plugins settings panel also shows the **memory archive** stats (below).

## 👁 Live vision — "what's on my screen?" mid-call (2.12)

In Settings → Siri & Voice, the Live voice card has two toggles:
**SHARE SCREEN** and **SHARE CAMERA**. While a Gemini Live voice session is
running they stream ~1 fps JPEG frames into the *same* conversation as your
voice, so you can ask "what error is on my screen?" or "what's this cable I'm
holding?" in the middle of talking — no screenshot dance, no separate feature.
Screen sharing follows the same **Screen Awareness** permission as the
`see_screen` tool and stops the instant you hang up, untoggle, or the socket
closes. While the wake word sleeps, nothing is captured or sent at all.

The Live loop itself got the long-horizon treatment in 2.12: session
resumption handles ride through reconnects, sliding-window compression keeps
one conversation alive for hours, server interruptions flush playback
instantly, and Gem's own transcript drives the avatar's mouth — phoneme by
phoneme, even in Cyrillic and Greek, thanks to Unicode-reduced visemes.

## 🌅 Proactive Gem (2.12)

On launch, Gem greets you with the time of day, any reminders due in the next
24 hours, the topic monitors that found something new overnight — and, from
the second launch onward, a natural recall of what you last worked on,
mentioned **once** and then consumed, so it never repeats itself. Long
sessions optionally get rotation-aware idle check-ins (`profile.proactiveCheckIns`,
Settings); they are rate-limited to one per 3 hours and stay quiet from
22:00 to 07:00.

---

## ⚡ GemCore Engine (any provider, hardened)

GemCore is the engine layer under **Settings → ⚡ GemCore Engine**. It lets you connect
**any OpenAI-compatible provider** — Gemini, Groq, Cerebras, OpenRouter, NVIDIA, OpenAI,
a local **Ollama**, or a custom endpoint — and routes every request through one hardened
pipeline:

- **Honest errors** — a failed key says *invalid key*, a dead model says *model not found*,
  an empty account says *quota exhausted*. Secrets are scrubbed from every detail.
- **Timeouts, retries with backoff, and a circuit breaker** per provider — one bad
  endpoint can't hang or spam.
- **Layered recovery** — if a provider fails, your other connected providers take over
  automatically.
- **Context compaction** — when a conversation outgrows a model's window, older turns are
  summarized instead of the request dying.
- **Model registry** — per-provider model lists with defaults; retired defaults fall back
  instead of stranding you.

### Multi-AI Team (⚡ in the chat box)

Press the **⚡ button** in the chat composer and describe a job. A director drafts a plan,
then specialist agents (architect → developer → reviewer → …) work it as a dependency
graph — each agent builds on the previous agents' outputs, live in the team modal.

### Scoped memory, audit trail, and permissions

- **Scoped memory** — *User* (preferences, cross-session), *Task* (current task), and
  *Long-term* (only when you ask). Everything is secret-redacted before it touches disk.
- **Audit trail** — every gated tool call, memory change, and permission grant is appended
  to a tamper-evident, hash-chained log you can verify with one click.
- **Impact tiers** — tools are gated LOW / MODERATE / HIGH / CRITICAL. High-impact actions
  ask first; you can approve a tier for a whole session if you want fewer prompts.
- **Reasoning trace** — every request is classified (reflex / heuristic / deliberate /
  deep) and traced, so you can see *how* Gem thought.
- **Emotion-aware voice** — Gem's tone adapts to yours: frustration gets an apologetic,
  careful voice; good news gets celebrated. Seven new dialogue states (attentive,
  deliberate, concerned, apologetic, curious, celebratory, stern) extend the TTS engine.

Run the engine tests with `npm run test:gemcore`.

---

## 🧠 Memory that never goes away

| Type | Where | How it helps |
| --- | --- | --- |
| **Facts** | auto-extracted | Your name, preferences, projects, goals — injected into every prompt |
| **Skills** | you teach it | "teach me to…" → reused forever |
| **Standing Rules** | you set them | "always be concise" / "reply in Hindi" → always followed |
| **Transcript** | every message | Restores your full conversation on launch |
| **Mood** | every meaningful message | The AI sees how you've been trending |
| **Goals / Notes / Todos / Reminders** | explicit | Life & career management |
| **Cold archive** | automatic | When hot collections hit their caps, evicted entries move to `<userData>/gemair-memory-archive.json` instead of being silently deleted. `search_memory` searches it automatically; Settings → Plugins shows the counts. Nothing Gem learns is ever dropped without being recoverable. |

### Teaching GemAir
```
teach me to always start reports with a one-line summary
remember that I prefer Python over JavaScript
always call me Boss
reply in Hindi
```

---

## 🔎 Truth & verified answers

- **Never fabricates** — the system prompt forbids inventing facts/quotes/stats.
- **Search-first** — factual/current questions trigger real `web_search`/`fetch_webpage`.
- **Citations** — replies show a **SOURCES** footer with clickable links.
- **Fact-check** — "is it true that…" runs `verify_claim` and reports *supported / unverified / no evidence*.
- **Says "I don't know"** when it can't verify.

---

## 💛 Emotional intelligence & support

GemAir detects **17 emotions** (joy, excitement, love, gratitude, confidence, hope,
relief, curiosity, boredom, tiredness, anxiety, sadness, fear, anger, guilt,
embarrassment, neutral) with valence, arousal and intensity.

- Its **tone and length adapt** to how you feel.
- Its **voice shifts** (rate/pitch) to match your emotion.
- If you're **feeling low, guilty, or anxious**, it responds with structured,
  non-judgmental compassion — acknowledge → validate → support → next step.
- **Crisis-aware**: if you mention self-harm, it responds gently and points to
  real helplines (iCall, Vandrevala, findahelpline.com), while staying with you.

> GemAir is a companion, **not a substitute for professional help** in a crisis.

---

## 🌐 The website is a storefront — the app is desktop-only

GemAir is a **desktop application**. The website exists to show it off and hand
you the installer — nothing more. `vercel.json` enforces this:

| URL | Serves | Why |
| --- | --- | --- |
| `/` , `/download` | `download.html` | Showcase + download page |
| `/app`, `/index.html`, `/renderer/*` | `desktop-only.html` | "Get the desktop app" notice |

Even if someone fetches the app files directly, `renderer/web-gate.js` (loaded
first in `renderer/index.html`) detects the missing desktop bridge
(`window.gemair`), hides the UI, and shows a download card — and `app.js`
refuses to boot behind it. `scripts/web-desktop-only-test.js` pins this whole
contract and runs in `npm run check`.

```bash
npm i -g vercel
vercel        # deploys the download-only site
```

Optional env vars (`.env.example`): `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
Everything works **without** any of them — the offline brain + real web search + tools are free.

### Supabase (recommended DB over Neon)
Connect the repo under Supabase → **Integrations → GitHub** (production branch
`main`). Migrations in `supabase/migrations/` are applied automatically on merge.
Then enable **Anonymous sign-ins** and add the two env vars.
Memory syncs across devices with per-user Row-Level Security.

---

## 🖥 Building the desktop installer

Development and packaging require **Node.js 22.12 or newer**.

```bash
npm install
npm start              # run it
npm run dist:win       # Windows .exe (NSIS)
npm run dist:mac       # macOS .dmg
npm run dist:linux     # Linux .AppImage + .deb
```

---

## ⬆️ Updates: silent, automatic, and on every push

- **Every push to `main`** runs the full test chain, then
  `.github/workflows/nightly.yml` rebuilds Windows/macOS/Linux installers and
  overwrites the rolling **`nightly`** pre-release (installers, blockmaps,
  `latest*.yml`, `SHA256SUMS.txt`).
- **Bump `package.json` version** on `main` and `auto-release.yml` tags
  `v<version>`, which triggers `release.yml` to publish the stable release.
- **The app updates itself silently** (default on, toggle in Settings →
  Connections → App Updates): stable builds use `electron-updater` to download
  in the background and install on quit — no prompts. Where the updater engine
  is unavailable, GemAir pre-downloads the NSIS installer and applies it with
  `/S` on quit. Turn the toggle off to be asked first; **Check Now** always
  works for the impatient.

---

## ⧉ Pairing the browser extension (exact website awareness)

The island can tell exactly which site you're on — but only through the
companion extension talking to a loopback bridge (`127.0.0.1:8677`):

1. GemAir → **Gem Air** tab → *Browser link* → **Open extension folder**
   (or **Copy folder path**).
2. Chrome/Edge → `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select that folder.
3. Back in GemAir, **Generate pairing code**, type it into the extension's
   popup, done.

The extension reports the active tab on navigation, on window focus, and on a
15-second heartbeat (so a suspended service worker never leaves the island
with a stale site), enforces block policy in the browser, and reports blocked
attempts back to the app. Without it, GemAir falls back to inferring the site
from window titles.

---

## ❤️ Philosophy

1. **Free forever** — the web, weather, search, voice, memory and tools all work with no
   key. General model answers need a brain: your own free provider key, a connected
   ChatGPT/Gemini account (Desktop), local Ollama, or a deployment whose `/api/chat`
   proxy has provider keys configured.
2. **Local-first & private** — your data stays on your machine (or your own Supabase).
3. **Truthful** — never fabricate; always cite; admit uncertainty.
4. **Kind** — a companion that lifts you up, especially on hard days.
5. **Transparent** — every action is in the Mission Log; you hold the leash.
