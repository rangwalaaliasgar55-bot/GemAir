# GemAI — The Complete Guide

Everything you need to understand, use, and extend GemAI — your free, emotionally
intelligent personal AI.

---

## 🧭 What GemAI is

GemAI is a **JARVIS-style personal AI** for your computer (and the web). It's a
companion, not just a tool:

- It **understands how you feel** (emotion engine) and responds with empathy.
- It **never forgets** — memories, skills, rules, goals, mood and notes persist forever.
- It **tells the truth** — it searches real sources, cites them, and says "I don't know" instead of guessing.
- It **does real work** — 45+ tools covering the web, your files, apps, and system.
- It's **free** — no $56 license, no subscription, and most features need no AI key at all.

---

## 🏗 Architecture

```
GemAI/
├── main.js                  # Electron main process — the "brain & hands"
│   ├── AI chat + streaming  #   OpenAI-compatible (Groq/OpenAI/Ollama) + tool-calling
│   ├── TOOLS registry       #   MCP-style: 45+ typed functions (the "tool layer")
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
├── supabase/schema.sql      # optional cloud memory (RLS + anonymous auth)
└── build/icon.png
```

### The three layers (mirrors Stonic's design)

| Layer | Stonic | GemAI |
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
| **Voice Core** | Talk or type. The particle orb + START AI loop + streaming replies. |
| **Desktop Manager** | Live telemetry, **Memory / Notes / Reminders / Skills / Rules / Soul** tabs, file missions. |
| **Life Companion** | Mood graph, goals, affirmations, wellness tips, career prompts. |
| **Agent Town** | Assign tasks to Alice/Bob/Carol/Dave — each has its own brain. |
| **Global Intel** | 3D globe, 2D command map, live headlines. |

### Talking to agents (independent brains)
Prefix a message with an agent's name to route it to *that* agent's own role-brain:

```
@Alice  research the best laptops under $1000 and summarize
@Dave   plan my study schedule for the next 2 weeks
```

Each agent has its own specialty (Alice = research, Bob = system, Carol = creative,
Dave = planning) injected as its own system prompt.

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

### Teaching GemAI
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

GemAI detects **17 emotions** (joy, excitement, love, gratitude, confidence, hope,
relief, curiosity, boredom, tiredness, anxiety, sadness, fear, anger, guilt,
embarrassment, neutral) with valence, arousal and intensity.

- Its **tone and length adapt** to how you feel.
- Its **voice shifts** (rate/pitch) to match your emotion.
- If you're **feeling low, guilty, or anxious**, it responds with structured,
  non-judgmental compassion — acknowledge → validate → support → next step.
- **Crisis-aware**: if you mention self-harm, it responds gently and points to
  real helplines (iCall, Vandrevala, findahelpline.com), while staying with you.

> GemAI is a companion, **not a substitute for professional help** in a crisis.

---

## 🚀 Deploy to Vercel

```bash
npm i -g vercel
vercel        # auto-detects vercel.json (renderer/ static + api/ serverless)
```

Optional env vars (`.env.example`): `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
Everything works **without** any of them — the offline brain + real web search + tools are free.

### Supabase (recommended DB over Neon)
Run `supabase/schema.sql`, enable **Anonymous sign-ins**, add the two env vars.
Memory then syncs across devices with per-user Row-Level Security.

---

## 🛠 Extending GemAI (adding a tool)

Tools live in one registry — `TOOLS` in `main.js` (and the matching `executeTool` case):

1. Add a schema entry:
```js
{ type: 'function', function: { name: 'get_quote', description: 'Get a random quote.', parameters: { type: 'object', properties: {} } } }
```
2. Add a handler:
```js
case 'get_quote':
  return { quote: QUOTES[Math.floor(Math.random() * QUOTES.length)] };
```
3. (Optional) mention it in `buildSystemPrompt()` so the AI knows when to use it.

For the **web version**, add a matching `/api/<tool>.js` and call it from
`offlineBrain()` in `renderer/app.js` so it works keyless too.

### Adding an emotion
Add a word list to `EMOTION_LEXICON`, a valence in `EMOTION_VALENCE`, an emoji in
`MOOD_EMOJI`, a name in `updateMoodIndicator`, and (optionally) a support response
in `supportGuidance`. That's it.

---

## 🖥 Building the desktop installer

```bash
npm install
npm start              # run it
npm run dist:win       # Windows .exe (NSIS)
npm run dist:mac       # macOS .dmg
npm run dist:linux     # Linux .AppImage + .deb
```

---

## ❤️ Philosophy

1. **Free forever** — the web, weather, search, voice, memory and tools all work with no key.
2. **Local-first & private** — your data stays on your machine (or your own Supabase).
3. **Truthful** — never fabricate; always cite; admit uncertainty.
4. **Kind** — a companion that lifts you up, especially on hard days.
5. **Transparent** — every action is in the Mission Log; you hold the leash.
