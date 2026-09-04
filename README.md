<div align="center">

# GemAir 🪐

### The free, open-source, emotionally intelligent personal AI

**Meet Gem** — the intelligence inside GemAir. A free, open-source, emotionally intelligent personal AI that turns your PC into a sci-fi command center. It understands how you feel, helps with your **life, career, studies and wellbeing**, remembers you **forever**, and runs on **your own AI key** — or entirely **free, with no key at all**.

No subscription, no license fee, no cloud lock-in. **Yours. Forever.**

> **GemAir 2.2 — FREE FOREVER, and now genuinely working end to end.** Everything runs on a free, keyless service (see **Settings → COST** — the badge says **$0.00 FOREVER**) and the app boots fully working with **zero configuration**: the **FREE CORE** answers on Vercel serverless with a provider fallback chain (Groq → Gemini → OpenRouter free tiers), **Microsoft Edge neural voices** are the primary TTS engine at no cost, and **12 one-sentence workflows** run as tested tool chains — now surfaced as one-click cards in the **Workflow Gallery**. 2.2 is an audit release: Edge TTS actually plays (the binary frame parser read a 4-byte header where the protocol uses 2), streamed replies are actually voiced, barge-in actually cuts the audio, the gaming optimizer actually selects High Performance instead of Power Saver, and the RGB theme no longer breaks every chart. It also turns the tree's dead code into real features: live SAT-LINK feeds, a real process monitor, a Tasks panel, full Hindi/Urdu with RTL, a visible reasoning stream, Google sign-in, and an opt-in in-browser WebGPU brain. Keys remain optional under **"Power user"**.

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
| 🎙️ **Voice Assistant** | Speak naturally or type. Live streaming replies (sentence-by-sentence audio while the answer still types), “Hey Gem” interim wake loop, mic VU, instant speech barge-in, **Microsoft Edge neural voices** as the primary engine (real voice picker, incl. Hindi/Urdu), emotion-aware rate/pitch/volume, Gem/JARVIS/Nova presets, language quick-switch, and neural or offline OS fallbacks. |
| ⌨️ **Human-like typing** | Replies stream and type out in real time, with code blocks and a save-to-file action. |
| 👋 **Personalized** | Greets you by name and time of day, and remembers who you are forever. |
| 🧠 **AI Brain (free out of the box)** | Runs on a free server-side AI core — no key, no card. **Free models are surfaced in-app**: a FREE MODELS panel with one-click setup for 38 free-tier OpenAI-compatible models (Gemini, Groq, Cerebras, SambaNova, NVIDIA NIM, Together, Fireworks, xAI/Grok, GLM, Cohere, HuggingFace, DeepSeek, Mistral, OpenRouter…) plus a live local-Ollama list — all keyless. Power users can also add their own key. GemAir `/models`, `/providers`, `/use`, `/local` slash commands switch models in chat. |
| 💾 **Long-term memory (never lost)** | Automatically extracts durable facts about you (name, preferences, projects, goals), stores them on disk forever, and injects them into every conversation. Full chat history is persisted and restored on launch. |
| 🛠️ **Tool-calling (91 tools)** | **Web**: weather, real web search, fetch & read any page, Wikipedia, YouTube search, translate, dictionary, crypto prices, currency conversion, AI image generation. **Computer**: open apps, files, clipboard, volume, screenshots, system control, email drafts, WhatsApp, to-dos, file-organizing missions, optional shell commands with confirmation. **Mind & life**: quotes, breathing exercises, weekly reports, emotional support. |
| 🌍 **World clock** | Time in any city, 12-hour format, live UTC clock. |
| ⌨️ **Command palette** | Fuzzy `Ctrl/Cmd+K` search across views, themes, HUD panels, agents, memories and settings toggles, with recents; `Ctrl/Cmd+L` focuses chat. |
| ❤️ **Emotional intelligence** | Detects **17 emotions** in real time, adapts tone, voice and empathy, and responds with structured compassion when you're low, guilty or anxious (crisis-aware, with real helplines). |
| 🌐 **Multilingual** | English, Hindi, Urdu (incl. Roman/Hinglish), Spanish and French. |
| 📅 **Daily briefing** | Greets you by name, shows live weather, your top goal and a rotating quote. |
| 🌬️ **Guided breathing** | A 4-7-8 calming exercise with an animated circle — tap "Breathe" when anxious. |
| 📈 **Weekly report** | One-tap life report with canvas sparklines for mood, tasks completed per day and goal progress (works offline, no key). |
| ⏱️ **Focus timer** | A Pomodoro timer in Life Companion. |
| 💬 **Proactive check-in** | If your mood has been low for a few days, GemAir gently reaches out on launch. |
| 💾 **Backup & restore** | Export and restore a validated JSON backup of your entire profile, memories, notes, goals, mood, voice and settings. |
| 🤝 **Life & Career companion** | Career decisions, study plans, relationships, health, finances, self-improvement and emotional support — a friend, mentor and coach. |
| 📊 **Mood tracking** | Visual mood graph, one-tap check-ins, affirmations and wellness tips (focus, stress, sleep, energy, motivation). |
| 🎯 **Goals** | Persistent life/career/study/finance/health goals with categories and progress. |
| 🎨 **3D dashboard** | Live 3D starfield, rotating wireframe polyhedron, parallax background, particle orb, boot sequence and animated HUD. |
| 🌈 **RGB effects** | RGB while you speak, RGB while the AI speaks, RGB chat messages, and a full Rainbow theme that cycles every accent color live. |
| 🔔 **Reminders** | Persistent, with native OS notifications + spoken alerts. |
| 📝 **Notes** | A persistent notebook — save, view, delete. |
| 🖥️ **System Core** | Live CPU / memory gauges, hostname, uptime, load average; Memory / Notes / Reminders / Soul tabs. |
| 🤖 **Desktop Agent (Computer Use)** | **No API key, no Claude, no vendor.** Give Gem a task and it drives your real mouse, keyboard, screenshots and terminal — screenshot→decide→click/type→re-look, looping until done. Runs on a **local model (Ollama)** for full offline vision control, or your optional free-tier key; with no model it still handles screenshots, opening apps/sites, pressing keys and typing. Every mouse/keyboard action is approved by you unless you switch on auto-approve. Tools: `move_mouse`, `mouse_click`, `type_text`, `press_key`, `scroll_mouse`, `capture_agent_screen`, `describe_screen`, `get_screen_size`. |
| 👨‍💻 **Coding Agent** | **No API key, no Claude, no vendor.** GemAir's own local repo agent. Point it at a project folder and describe a change — it reads your repo (`list_directory`/`read_file`/`search_files`), plans, edits (`write_file`) and validates (`run_command`), using a **local model (Ollama)**. Optionally delegates to a user-installed local coding CLI (keyless via Ollama). Every edit is confirmed unless you turn on auto-approve. |
| 🏢 **Agent Town 2.0** | A time-lit pixel office where agents walk and collaborate with restricted real tools: Alice researches, Bob operates files, Carol verifies system health, and Dave opens communication drafts. Handoffs, actual results and every mission action stay visible. |
| 🗂️ **Desktop automation ("missions")** | `organize_folder`, `find_duplicates`, `rename_files`, `archive_old_files`, plus GemAir 2.1+'s `close_app`, `find_large_files`, `create_folder_tree`, `move_files`, `optimize_gaming` — multi-step workflows (12 command-palette recipes) with a full Mission Log of every action (transparency + undo). |
| 🛡️ **System guardian** | "What's slowing my PC down?" — live scan of CPU, RAM and top processes with one-line advice. |
| 👁️ **Screen awareness** | Optional active-session awareness compares privacy-preserving low-resolution fingerprints and describes meaningful screen changes without saving images. Explicit `see_screen` capture remains available. |
| 🌐 **World Monitor** | Interactive dotted/wireframe globe with clickable news hotspots, dedicated 2D command-map mode, multi-city UTC strip and tech/world/business feeds. |
| 🎭 **HUD Themes (string system)** | Crimson, Emerald, Cyan, Violet, Amber + RGB Rainbow. Every theme is a plain string token table (`renderer/themes.js`) — pick one from the top bar, `Ctrl+K`, or Settings → HUD THEMES and the **entire interface** re-skins: DOM, canvases, glows. Choice is saved and applies everywhere. |
| 🔒 **Local-first** | Profile, memories, notes, reminders and settings live on your disk. No telemetry. |

---

## 🔌 AI brains: ChatGPT, Gemini, Claude & more

Every brain speaks one protocol — the OpenAI-compatible `chat/completions` endpoint — so the **same streaming + tool-calling engine** drives all of them. One-click presets in **Settings → AI BRAIN**:

| Brain | Where to get a key | Example model |
| --- | --- | --- |
| **Google Gemini** (free tier) | [aistudio.google.com](https://aistudio.google.com/apikey) | `gemini-2.5-flash` |
| **Groq** (free tier) | [console.groq.com/keys](https://console.groq.com/keys) | `llama-3.3-70b-versatile` |
| **Cerebras** (free tier) | [cloud.cerebras.ai](https://cloud.cerebras.ai) | `llama-3.3-70b` |
| **SambaNova** (free tier) | [cloud.sambanova.ai](https://cloud.sambanova.ai) | `Meta-Llama-3.3-70B-Instruct` |
| **NVIDIA NIM** (free credits) | [build.nvidia.com](https://build.nvidia.com) | `meta/llama-3.3-70b-instruct` |
| **Together AI** | [api.together.xyz](https://api.together.xyz/settings/api-keys) | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| **Fireworks AI** | [fireworks.ai](https://fireworks.ai/login) | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| **xAI (Grok)** | [console.x.ai](https://console.x.ai) | `grok-3-mini` |
| **Z.AI (GLM)** | [z.ai/glm](https://z.ai/glm) | `glm-4-flash` |
| **Cohere** | [cohere.com/api-key](https://cohere.com/api-key) | `command-r-plus` |
| **Hugging Face** | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) | `meta-llama/Llama-3.3-70B-Instruct` |
| **DeepSeek** | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) | `deepseek-chat` |
| **Mistral** (free Experiment plan) | [console.mistral.ai](https://console.mistral.ai) | `mistral-small-latest` |
| **OpenRouter** | openrouter.ai/keys | any of 300+ models |
| **ChatGPT / OpenAI** (optional, paid) | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-4o-mini` |
| **Ollama** (fully local, keyless) | — none — | `llama3` |

> **🆓 Free models are shown in the app.** Settings → AI BRAIN shows a **FREE MODELS**
> panel with one-click setup for 38 free-tier OpenAI-compatible models and a live
> list of any local Ollama models — no credit card required. You can also switch models
> from chat with GemAir slash commands: `/providers`, `/models`, `/use <model>`, `/local`.

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

## 🤖 Desktop Agent — Computer Use (keyless, no Claude)

Like an AI that takes over your screen: describe a task and Gem screenshots your desktop, decides where to move/click/type, does it, then re-looks until it's done.

**Zero keys. Zero vendors. Local-first.**

1. **Enable it** — Settings → **DESKTOP & MODES → Desktop Agent** → tick **Enable Desktop Agent**. Optionally **Auto-approve desktop actions** and pick a max-step count (1–20).
2. **Open the Desktop Agent panel** — Settings → Global UI, or `Ctrl/Cmd+K` → "Open Desktop Agent", or add the Agent Town → Desktop Agent shortcut.
3. **Type a task** — e.g. `Open Chrome, go to example.com, and take a screenshot`, or `Open the calculator and type 2+2=4`. Hit **RUN AGENT**.

### Which brain drives it?

| Brain | Requires | What it can do |
| --- | --- | --- |
| **Local Ollama** (auto-detected at `localhost:11434`) | none — fully offline, keyless | Full **vision** control: sees the screenshot, clicks by pixel, types, presses keys |
| Your own optional free-tier key (Groq/Gemini/OpenRouter) | optional key | Vision tool-calling if the model supports it; otherwise keyboard-first |
| **No model at all** | none — deterministic fallback | Screenshots, opens apps/sites, presses keys, types — no vision |

### The tools

`move_mouse(x,y)` · `mouse_click(x,y,button,double)` · `type_text(text)` · `press_key(key)` · `scroll_mouse(direction,amount)` · `capture_agent_screen()` · `describe_screen()` · `get_screen_size()` — implemented 100% on-device via OS-native calls (PowerShell / AppleScript / `xdotool`). No native Node addons, no rebuild, no API.

### Safety

- Everything is **OFF until you enable** Desktop Agent.
- Each mouse/keyboard action is **confirmed by you** unless you turn on auto-approve.
- The agent is instructed to **never type secrets**, never perform destructive actions, and to **stop and ask** when unsure.
- `press_key` only accepts safe key tokens (letters/digits/modifiers) — a model can't inject shell.
- The deterministic fallback and the loop both respect the same `allowComputerUse` gate.

### Setup for the best (fully offline) experience

```bash
# install a local, keyless model (no account, no key)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llava           # vision-capable model
# then just run the agent — GemAir auto-detects Ollama at localhost:11434
```

---

## 👨‍💻 Coding Agent — keyless

GemAir ships its own local coding agent. It needs **no API key and no vendor** — it runs on the same keyless brain (local Ollama first) and edits real code in a folder you choose.

1. **Enable it** — Settings → **DESKTOP & MODES → Coding Agent** → tick **Enable Coding Agent**. Optionally **Auto-approve file edits** and set max steps.
2. **Open the panel** — `Ctrl/Cmd+K` → "Open Coding Agent".
3. **Pick a project folder + task** — e.g. `~/my-app` and `Add a /healthz endpoint to the router and a test`, then hit **RUN CODING AGENT**.

It uses the same tools you already have (`list_directory`, `read_file`, `write_file`, `search_files`, `run_command`) plus a `run_coding_cli` tool that delegates to a user-installed local coding CLI when available (also keyless via Ollama). Every edit is confirmed by you unless you enable auto-approve.

## 📦 Vendored upstream source

GemAir vendors the source of two open-source projects so its capabilities stay auditable and extensible in-repo (see `vendor/README.md`):

| Folder | Upstream | License | Purpose |
| --- | --- | --- | --- |
| `vendor/computer-agent/` | [suitedaces/computer-agent](https://github.com/suitedaces/computer-agent) | Apache-2.0 | The "computer-use" desktop agent. GemAir's Desktop Agent (`lib/computer-agent.js`) is its JS port, upgraded to run inside Electron — no API key, no vendor. |
| `vendor/opencode/` | [sst/opencode](https://github.com/sst/opencode) | MIT | The terminal coding agent. GemAir's Coding Agent reuses its keyless (Ollama) config approach and can delegate to the `opencode` CLI. |

Both are reference-only and excluded from the packaged app.

## 🚀 Contributing

Found a bug or have an idea? Open an [Issue](https://github.com/rangwalaaliasgar55-bot/GemAir/issues) using the templates, or submit a [Pull Request](https://github.com/rangwalaaliasgar55-bot/GemAir/pulls). See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT — see [LICENSE](LICENSE). Free to use, modify and distribute.