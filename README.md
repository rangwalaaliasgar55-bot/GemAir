<div align="center">

# GemAir 🪐

### The free, open-source, emotionally intelligent personal AI

**Meet Gem** — the intelligence inside GemAir. A free, open-source, emotionally intelligent personal AI that turns your PC into a sci-fi command center. It understands how you feel, helps with your **life, career, studies and wellbeing**, remembers you **forever**, and runs on **your own AI key** — or entirely **free, with no key at all**.

No subscription, no license fee, no cloud lock-in. **Yours. Forever.**

[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Windows-macOS-Linux-2b7a78?style=for-the-badge)]()
[![Built with Electron](https://img.shields.io/badge/Built_with-Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

</div>

---

## 📥 Download

| Platform | Installer |
| --- | --- |
| **Windows** 10 / 11 | `GemAir-Setup.exe` (from [Releases](https://github.com/rangwalaaliasgar55-bot/GemAir/releases/latest)) |
| **macOS** (Apple Silicon & Intel) | `GemAir.dmg` |
| **Linux** | `GemAir.AppImage` / `.deb` |

Or run from source:

```bash
git clone https://github.com/rangwalaaliasgar55-bot/GemAir.git
cd GemAir
npm install
npm start
```

> Full walkthrough: **[GUIDE.md](GUIDE.md)** — architecture, every module, teaching GemAir, extending it, and the build/deploy guide.
> How it all works: **[ARCHITECTURE.md](ARCHITECTURE.md)** — the message pipeline, the tool-calling loop, the memory model, and how Gem's 3D avatar is rendered.

---

## ✨ Features

| Module | What it does |
| --- | --- |
| 🎙️ **Voice Assistant** | Speak naturally or type. Live streaming replies, animated particle orb, wake word ("Hey GemAir"), speech recognition + spoken replies in a smooth natural voice (free, or your OS's offline voice). |
| ⌨️ **Human-like typing** | Replies stream and type out in real time, with code blocks and a save-to-file action. |
| 👋 **Personalized** | Greets you by name and time of day, and remembers who you are forever. |
| 🧠 **AI Brain (free out of the box)** | Runs on a free server-side AI core — no key, no card. Power users plug in their own provider with one-click presets: **ChatGPT (OpenAI) · Gemini · Claude** · Groq / OpenRouter / local Ollama, in Settings → AI Brain. |
| 💾 **Long-term memory (never lost)** | Automatically extracts durable facts about you (name, preferences, projects, goals), stores them on disk forever, and injects them into every conversation. Full chat history is persisted and restored on launch. |
| 🛠️ **Tool-calling (50+ tools)** | **Web**: weather, real web search, fetch & read any page, Wikipedia, YouTube search, translate, dictionary, crypto prices, currency conversion, AI image generation. **Computer**: open apps, files, clipboard, volume, screenshots, system control, email drafts, WhatsApp, to-dos, file-organizing missions, optional shell commands with confirmation. **Mind & life**: quotes, breathing exercises, weekly reports, emotional support. |
| 🌍 **World clock** | Time in any city, 12-hour format, live UTC clock. |
| ⌨️ **Command palette** | `Ctrl/Cmd+K` to ask or navigate from anywhere; `Ctrl/Cmd+L` focuses chat; `Ctrl/Cmd+,` opens settings. |
| ❤️ **Emotional intelligence** | Detects **17 emotions** in real time, adapts tone, voice and empathy, and responds with structured compassion when you're low, guilty or anxious (crisis-aware, with real helplines). |
| 🌐 **Multilingual** | English, Hindi, Urdu (incl. Roman/Hinglish), Spanish and French. |
| 📅 **Daily briefing** | Greets you by name, shows live weather, your top goal and a rotating quote. |
| 🌬️ **Guided breathing** | A 4-7-8 calming exercise with an animated circle — tap "Breathe" when anxious. |
| 📈 **Weekly report** | One-tap life report built from your mood, goals, tasks and memory (works offline, no key). |
| ⏱️ **Focus timer** | A Pomodoro timer in Life Companion. |
| 💬 **Proactive check-in** | If your mood has been low for a few days, GemAir gently reaches out on launch. |
| 💾 **Backup & restore** | Export your whole memory (memories, notes, goals, mood) as JSON and import it back. |
| 🤝 **Life & Career companion** | Career decisions, study plans, relationships, health, finances, self-improvement and emotional support — a friend, mentor and coach. |
| 📊 **Mood tracking** | Visual mood graph, one-tap check-ins, affirmations and wellness tips (focus, stress, sleep, energy, motivation). |
| 🎯 **Goals** | Persistent life/career/study/finance/health goals with categories and progress. |
| 🎨 **3D dashboard** | Live 3D starfield, rotating wireframe polyhedron, parallax background, particle orb, boot sequence and animated HUD. |
| 🌈 **RGB effects** | RGB while you speak, RGB while the AI speaks, RGB chat messages, and a full Rainbow theme that cycles every accent color live. |
| 🔔 **Reminders** | Persistent, with native OS notifications + spoken alerts. |
| 📝 **Notes** | A persistent notebook — save, view, delete. |
| 🖥️ **System Core** | Live CPU / memory gauges, hostname, uptime, load average; Memory / Notes / Reminders / Soul tabs. |
| 🏢 **Agent Town** | A living pixel-art office: Alice, Bob, Carol and Dave wander between desks, the whiteboard, the server rack and the coffee machine. Each agent has its own brain (role + personality) — type `@Alice` to route a task to them. |
| 🗂️ **Desktop automation ("missions")** | `organize_folder`, `find_duplicates`, `rename_files`, `archive_old_files` — multi-step workflows with a full Mission Log of every action (transparency). |
| 🛡️ **System guardian** | "What's slowing my PC down?" — live scan of CPU, RAM and top processes with one-line advice. |
| 👁️ **Screen awareness** | `see_screen` captures your screen so the AI is aware of what's on it. |
| 🌐 **World Monitor** | A living 3D globe with pulsing hotspots, a 2D command map, live UTC clock and a streaming headlines feed (free). |
| 🎭 **HUD Themes (string system)** | Crimson, Emerald, Cyan, Violet, Amber + RGB Rainbow. Every theme is a plain string token table (`renderer/themes.js`) — pick one from the top bar, `Ctrl+K`, or Settings → HUD THEMES and the **entire interface** re-skins: DOM, canvases, glows. Choice is saved and applies everywhere. |
| 🔒 **Local-first** | Profile, memories, notes, reminders and settings live on your disk. No telemetry. |

---

## 🔌 AI brains: ChatGPT, Gemini, Claude & more

Every brain speaks one protocol — the OpenAI-compatible `chat/completions` endpoint — so the **same streaming + tool-calling engine** drives all of them. One-click presets in **Settings → AI BRAIN**:

| Brain | Where to get a key | Example model |
| --- | --- | --- |
| **ChatGPT / OpenAI** | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-4o-mini` |
| **Google Gemini** (free tier) | [aistudio.google.com](https://aistudio.google.com/apikey) | `gemini-2.5-flash` |
| **Claude** | [console.anthropic.com](https://console.anthropic.com) | `claude-sonnet-4-20250514` |
| **Groq** (free tier) | console.groq.com | `llama-3.3-70b-versatile` |
| **OpenRouter** | openrouter.ai | any of 200+ models |
| **Ollama** (fully local) | — none — | `llama3` |

Keys are stored only on your machine (Electron) or your browser storage (web); the app also runs **100% free with no key at all** (serverless core, then the offline brain). The complete walkthrough — how the ChatGPT and Gemini connections work under the hood, how Stonic's "sign in with your ChatGPT account" differs, Gemini Live voice, the tool loop, and the string-driven theme system — lives in **[AI-FRAMEWORK.md](AI-FRAMEWORK.md)**.

---

## 🧠 The memory that doesn't go away

Most AI clones forget you the moment they close. GemAir doesn't:

- **Automatic memory extraction** — after each exchange, GemAir asks your AI to list durable facts worth keeping and saves them permanently.
- **Recency-weighted recall** — recent and important memories rank higher in every prompt.
- **Auto-consolidation** — long conversations are summarized into durable long-term memory so context never overflows.
- **Memory search** — the AI can query its own memory on demand via a `search_memory` tool.
- **Persistent transcript** — every message is written to disk and restored on launch.
- **Injected context** — your memories are fed into every prompt, so GemAir always knows you.
- **Your data, your disk** — everything is a local JSON file (`gemair-memory.json` in the app's data folder).

Memory works even **offline** (simple heuristics) and becomes much smarter once you connect a key.

### ✅ Truth & verified answers

- **Never fabricates** — the system prompt forbids making up facts, quotes, statistics or citations.
- **Search-first** — for anything factual or current it calls `web_search` / `fetch_webpage` and **cites its sources inline**.
- **`verify_claim` tool** — ask "is it true that…?" and it fact-checks against real sources and reports *supported / unverified / no evidence* with links.
- **Says "I don't know"** — when it can't verify something, it tells you plainly instead of guessing.

### 🎓 Skills & instructions in memory

Teach GemAir and it remembers forever: **Skills** ("teach me to…") and **Standing Rules** ("always be concise", "call me Boss", "reply in Hindi") are injected into every prompt and stored in your never-lost memory.

---

## 🚀 Contributing

Found a bug or have an idea? Open an [Issue](https://github.com/rangwalaaliasgar55-bot/GemAir/issues) using the templates, or submit a [Pull Request](https://github.com/rangwalaaliasgar55-bot/GemAir/pulls). See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT — see [LICENSE](LICENSE). Free to use, modify and distribute.