# GemAI

**A free, open-source, emotionally intelligent personal AI — far more than a JARVIS clone.** Turn your PC into a sci-fi command center that *understands how you feel*, helps with your **life, career, studies and wellbeing**, remembers you **forever**, and runs on **your own AI key**. No subscription, no $56 license, no cloud lock-in. **Yours. Forever.**

GemAI is a fully working desktop app (Windows · macOS · Linux) with: a voice assistant, a live system core, an agent town, a world monitor, **persistent long-term memory**, and **real tool-calling** (weather, web search, reminders, notes, volume, screenshots, system control) — all wrapped in a cinematic HUD you can re-skin in three themes.

> Built with **Electron** — runs entirely on your machine. Your data never leaves your PC (the only exception: the AI endpoint you choose to connect).

---

## ✨ Features

| Module | What it does |
| --- | --- |
| 🎙 **Voice Assistant** | Speak naturally or type. **Live streaming** replies (instant, JARVIS-fast), animated particle orb, START AI loop, **wake word ("Hey GemAI")**, speech recognition + spoken replies in a **smooth natural female voice** (neural, free — or your OS's voice, offline). |
| ⌨️ **Human-like typing** | Replies stream/type out in real time, with code blocks and a 💾 save-to-file action. |
| 👋 **Personalized** | Greets you by name and time of day (12-hour clock), and remembers who you are forever. |
| 🧠 **AI Brain (your key only)** | Paste a **free Groq key** (or OpenAI / OpenRouter / local Ollama). GemAI uses **that key and nothing else** — no silent fallback, no other provider. |
| 🧠 **Long-Term Memory (never lost)** | Automatically extracts durable facts about you (name, preferences, projects, goals) using your own model, stores them **on disk forever**, and injects them into every conversation. Full chat history is also persisted and restored on every launch. |
| 🛠 **Tool-calling (30+ tools)** | The AI can *do* things, not just chat. **Web**: live weather, web search, fetch & read any webpage, Wikipedia, YouTube search, translate, dictionary, crypto prices, currency conversion, **AI image generation**, open URLs. **Computer**: open any app, list/read/write/search files, clipboard, volume, screenshots, system control, email draft, WhatsApp, to-dos, and (optional) shell commands with per-command confirmation. |
| ⏰ **World clock** | Time in any city, 12-hour format, live UTC clock. |
| 🎹 **Command palette** | `Ctrl/Cmd+K` to ask or navigate from anywhere; `Ctrl/Cmd+L` focuses chat; `Ctrl/Cmd+,` opens settings. |
| 💛 **Emotional intelligence** | Detects your emotion in real time (joy, sadness, anxiety, anger, love…), adapts its tone and empathy to how you feel, and tracks your mood over time. |
| 🧭 **Life & Career Companion** | Helps with career decisions, study plans, relationships, health, finances, self-improvement and emotional support — like a friend, mentor and coach. |
| 📊 **Mood tracking** | Visual mood graph, one-tap check-ins, affirmations and wellness tips (focus, stress, sleep, energy, motivation). |
| 🎯 **Goals** | Persistent life/career/study/finance/health goals with categories and progress. |
| 🌌 **3D dashboard** | Live 3D starfield + rotating wireframe polyhedron, parallax background, 3D-tilting panels, particle orb, boot sequence and animated HUD. |
| ⏰ **Reminders** | Persistent, with native OS notifications + spoken alerts when they fire. |
| 📝 **Notes** | A persistent notebook — save, view, delete. |
| 🖥 **System Core** | Live CPU / memory gauges, hostname, uptime, load average; **Memory / Notes / Reminders / Soul** tabs. |
| ▦ **Agent Town** | A **living pixel-art office**: Alice, Bob, Carol and Dave wander between desks, the whiteboard, the server rack and the coffee machine, with status rings, thought bubbles, and a live activity feed. Click any agent to assign a task. |
| 🛠 **Desktop automation ("missions")** | `organize_folder` (scan → classify → create folders → move), `find_duplicates`, `rename_files` by pattern, `archive_old_files` — multi-step workflows with a full **Mission Log** of every action (transparency). |
| 🩺 **System guardian** | "What's slowing my PC down?" — live scan of CPU, RAM, and top processes, with one-line advice. |
| 👁 **Screen awareness** | `see_screen` captures your screen so the AI is aware of what's on it. |
| ◍ **World Monitor** | A living 3D globe with pulsing hotspots, a **2D command map**, live UTC clock, and a streaming headlines feed (free). |
| 🎨 **Themes** | Crimson, Emerald, and Cyan — re-skins the entire command center. |
| 🔒 **Local-first** | Profile, memories, notes, reminders and settings live on your disk. No telemetry. |

---

## 🧠 The memory that doesn't go away

Stonic clones forget you the moment they close. GemAI doesn't:

- **Automatic memory extraction** — after each exchange, GemAI asks your AI to list durable facts worth keeping ("user is a developer", "user prefers Python", "user's name is X") and saves them permanently.
- **Recency-weighted recall** — recent and important memories rank higher in every prompt.
- **Auto-consolidation** — when the conversation grows long, older messages are summarized into durable long-term memory automatically (so context never overflows).
- **Memory search** — the AI can query its own memory on demand via a `search_memory` tool.
- **Persistent transcript** — every message is written to disk and restored on launch, so you pick up exactly where you left off.
- **Injected context** — your memories are fed into every prompt, so GemAI always knows you.
- **Your data, your disk** — everything is a local JSON file (`gemai-memory.json` in the app's data folder). Delete it any time, or manage memories from the UI.

Memory works even **offline** (simple heuristics) and becomes much smarter once you connect a key.

### Emotional intelligence

GemAI reads how you feel, not just what you say:

- **Real-time emotion detection** — a built-in emotion engine classifies every message into joy, excitement, sadness, anxiety, anger, fear, love, gratitude, confidence, tiredness, boredom or curiosity (works offline, no key).
- **Empathetic responses** — the AI's system prompt is informed by your current emotional state and recent mood trend, so it acknowledges your feelings first and adapts its tone and length.
- **Mood history** — every meaningful exchange logs a mood point, charted on a live graph in the **Companion** panel, so you (and GemAI) can see how you've been trending.
- **Check-ins** — one-tap mood buttons, daily affirmations, and practical wellness tips for focus, stress, sleep, energy, productivity and motivation.

---

## 🚀 Run it

Requirements: **Node.js 18+**.

```bash
git clone https://github.com/rangwalaaliasgar55-bot/GemAI.git
cd GemAI
npm install
npm start
```

---

## 📦 Build a downloadable installer for your OS

GemAI ships with `electron-builder` pre-configured. Build an installer for your current OS:

```bash
npm run dist          # builds for your current OS
```

Or target a specific platform:

```bash
npm run dist:win      # Windows  (.exe NSIS installer)
npm run dist:mac      # macOS   (.dmg)
npm run dist:linux    # Linux   (.AppImage + .deb)
```

Your installers land in the **`release/`** folder — share them, put them on a flash drive, install on any computer.

> **Note (Windows):** to sign the installer you'd add a code-signing certificate. Unsigned builds are perfectly usable — Windows may show a "More info → Run anyway" prompt, which is normal for free/open-source apps.

---

## 🔌 Connecting your AI (Groq recommended — free & fast)

GemAI works out of the box with the **offline brain** (time, date, weather, web search, math, reminders, notes, app/system control — no key needed).

To unlock a full LLM brain, open **Settings → AI Brain**:

1. Get a **free Groq key** at [console.groq.com/keys](https://console.groq.com/keys) (no card needed, very fast).
2. Click the **Groq (free tier)** preset, paste your key, Save.

| Preset | Base URL | Needs key? |
| --- | --- | --- |
| **Groq (free tier)** ⚡ | `https://api.groq.com/openai/v1` | ✅ your key (free) |
| OpenAI | `https://api.openai.com/v1` | ✅ your key |
| OpenRouter | `https://openrouter.ai/api/v1` | ✅ your key (many free models) |
| **Ollama (local)** | `http://localhost:11434/v1` | ❌ free & private |

Any **OpenAI-compatible** endpoint works — and GemAI will use **only the endpoint you configure**. Your key is stored only on your own machine.

---

## 📁 Project structure

```
GemAI/
├── main.js            # Electron main process (AI + tool-calling, memory store,
│                      #   weather/web search, reminders scheduler, system control, IPC)
├── preload.js         # Secure context-bridge API
├── renderer/
│   ├── index.html     # UI structure (assistant / core / town / world)
│   ├── style.css      # Sci-fi HUD + themes
│   └── app.js         # App logic (orb, globe, voice, memory, agents…)
├── build/icon.png     # App icon
└── package.json       # Build config (electron-builder)
```

### Free, keyless services used
- **Weather** — [Open-Meteo](https://open-meteo.com/) (no key)
- **Web search** — [DuckDuckGo](https://duckduckgo.com/) Instant Answers (no key)
- **Web pages** — fetched directly from any URL
- **Wikipedia / Dictionary** — public APIs (no key)
- **Crypto prices** — [CoinGecko](https://www.coingecko.com/) (no key)
- **Currency** — [Frankfurter](https://frankfurter.app/) (no key)
- **Translation** — [MyMemory](https://mymemory.translated.net/) (no key)
- **Image generation** — [Pollinations](https://pollinations.ai/) (no key)
- **Headlines** — [Hacker News](https://news.ycombinator.com/) API (no key)
- **Voice** — Google neural TTS (free, female) with your OS voice as offline fallback

Everything else is fully local.

### Full computer access (opt-in)
By default GemAI can open apps, manage files, control volume, take screenshots and control the system. To let it run **arbitrary shell commands**, enable *Advanced → Allow shell commands* in Settings — every command is shown to you for confirmation first, and a few obviously dangerous patterns are blocked.

---

## 🧾 License

[MIT](LICENSE) — free to use, modify, and share.

---

*GemAI is an independent, free/open-source project. It is not affiliated with Stonic AI or any other product.*
