# GemAI

**A free, open-source JARVIS-style desktop assistant — more advanced than the typical Stonic clone.** Turn your PC into a sci-fi command center — it talks, it moves, it remembers you **forever**, and it runs on **your own AI key**. No subscription, no $56 license, no cloud lock-in. **Yours. Forever.**

GemAI is a fully working desktop app (Windows · macOS · Linux) with: a voice assistant, a live system core, an agent town, a world monitor, **persistent long-term memory**, and **real tool-calling** (weather, web search, reminders, notes, volume, screenshots, system control) — all wrapped in a cinematic HUD you can re-skin in three themes.

> Built with **Electron** — runs entirely on your machine. Your data never leaves your PC (the only exception: the AI endpoint you choose to connect).

---

## ✨ Features

| Module | What it does |
| --- | --- |
| 🎙 **Voice Assistant** | Speak naturally or type. Animated particle orb, START AI loop, speech recognition + spoken replies in a **smooth natural female voice** (neural, free — or your OS's voice, offline). |
| ⌨️ **Human-like typing** | Replies type out character-by-character, with code blocks and a 💾 save-to-file action. |
| 👋 **Personalized** | Greets you by name and time of day, and remembers who you are forever. |
| 🧠 **AI Brain (your key only)** | Paste a **free Groq key** (or OpenAI / OpenRouter / local Ollama). GemAI uses **that key and nothing else** — no silent fallback, no other provider. |
| 🧠 **Long-Term Memory (never lost)** | Automatically extracts durable facts about you (name, preferences, projects, goals) using your own model, stores them **on disk forever**, and injects them into every conversation. Full chat history is also persisted and restored on every launch. |
| 🛠 **Tool-calling** | The AI can *do* things, not just chat. **Full web access**: live weather, web search, fetch & read any webpage, Wikipedia, YouTube search, open URLs. **Full computer access**: open any app, list/read/write/search files, clipboard, volume, screenshots, system control (lock/sleep/restart), and (optional) shell commands with per-command confirmation. |
| ⏰ **Reminders** | Persistent, with native OS notifications + spoken alerts when they fire. |
| 📝 **Notes** | A persistent notebook — save, view, delete. |
| 🖥 **System Core** | Live CPU / memory gauges, hostname, uptime, load average; **Memory / Notes / Reminders / Soul** tabs. |
| ▦ **Agent Town** | Four resident agents (Alice, Bob, Carol, Dave) at their desks with roles and live status. |
| ◍ **World Monitor** | A living 3D globe with pulsing hotspots, live UTC clock, streaming headlines feed (free). |
| 🎨 **Themes** | Crimson, Emerald, and Cyan — re-skins the entire command center. |
| 🔒 **Local-first** | Profile, memories, notes, reminders and settings live on your disk. No telemetry. |

---

## 🧠 The memory that doesn't go away

Stonic clones forget you the moment they close. GemAI doesn't:

- **Automatic memory extraction** — after each exchange, GemAI asks your AI to list durable facts worth keeping ("user is a developer", "user prefers Python", "user's name is X") and saves them permanently.
- **Persistent transcript** — every message is written to disk and restored on launch, so you pick up exactly where you left off.
- **Injected context** — your memories are fed into every prompt, so GemAI always knows you.
- **Your data, your disk** — everything is a local JSON file (`gemai-memory.json` in the app's data folder). Delete it any time, or manage memories from the UI.

Memory works even **offline** (simple heuristics) and becomes much smarter once you connect a key.

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
- **Wikipedia** — public API (no key)
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
