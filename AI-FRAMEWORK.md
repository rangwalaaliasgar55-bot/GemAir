# GemAir — AI Connection Framework

How GemAir connects to AI brains (**ChatGPT / OpenAI · Google Gemini · Claude · Groq · OpenRouter · Ollama**), how the tool-calling engine works, and how the Stonic-style HUD theme system is built from plain strings.

---

## 0. Key-free capabilities and configured model providers

GemAir starts without an account or API key. Local memory, deterministic/offline
responses, browser-safe live tools, workflows, and permitted desktop tools remain
available. GemAir does **not** disguise those utilities as a hosted language model.

The web deployment's `api/chat.js` can use operator-configured free-tier providers
(Groq, Gemini, OpenRouter, Cerebras, and others). It forwards real SSE/JSON output,
rotates only across providers that are actually configured, applies bounded fair-use
and request limits, and returns a structured error when no model credential exists.
It never returns a fake model completion for absent credentials, provider rejection,
quota exhaustion, or a truncated stream.

Desktop users have three additional choices:

1. connect a ChatGPT account through the device flow in §3;
2. run a keyless local Ollama/WebGPU model; or
3. configure their own OpenAI-compatible provider key.

**Free-model catalog** — `renderer/providers.js` is the source of truth for provider
base URLs, model IDs and free-tier status (21 providers, 38 free-model entries). A
"free" entry means the vendor offers a free tier; it does not mean GemAir supplies an
account or guarantees ongoing quota. The UI renders this catalog, while `/models`,
`/providers`, `/use`, and `/local` switch configured/local models. The
`ai:listLocalModels` IPC discovers local Ollama models.

---

## 1. The big picture — four layers

Stonic's own blog describes their architecture as "an orchestra — four layers". GemAir follows the same shape, fully open-source:

| Layer | Stonic's words | In GemAir |
|---|---|---|
| **Listening** | "Speech recognition tuned for natural commands" | Web Speech API recognition (`tts-engine.js`, mic button, wake word) |
| **Reasoning** | "A language model interprets intent and breaks it into steps" | Any OpenAI-compatible brain — ChatGPT, Gemini, Claude, Groq, local Ollama |
| **Action** | "A modular tool system executes steps… every action is logged, critical actions ask" | `TOOLS[]` + `executeTool()` in `main.js` — 79 tools (weather, web search, files, shell, WhatsApp, memory, desktop windows, modes…) with a max-6-rounds loop |
| **Experience** | "A full cinematic interface — not a chat bubble" | The HUD: orb, circuits, Agent Town, Global Intel, themes, SFX |

---

## 2. How a message travels (data flow)

```
 You speak / type
      │
      ▼
 renderer/app.js  ── sendMessage() → handleMessage()
      │            emotion analysis, memory, system prompt
      │
      ├──────────────┬──────────────────────────┬───────────────────────┐
      ▼              ▼                          ▼                       ▼
 ELECTRON MODE   BROWSER DIRECT           VERCEL FREE CORE         OFFLINE BRAIN
 (npm start)     (web mode + your key)    (web mode, no key)       (no network at all)
      │              │                          │                       │
 IPC ai:chatStream  ai-client.js            api/chat.js          local intent parser
 (preload.js)       fetch() from browser    (Vercel serverless)  (regex brain)
      │              │                          │
      ▼              ▼                          ▼
 main.js           SAME PROTOCOL            SAME PROTOCOL
 aiChatStream()    POST /chat/completions   POST /chat/completions
      │              │  (browser CORS)       (key hidden on server,
      ▼              │                          model fallback chain,
 TOOL-LOOP ◄─────────┴──────────────────────── freeBrain() fallback)
 (see §4)
      │
      ▼
 Streamed tokens → typewriter on screen → TTS speaks → memory extracted
```

- **Electron mode** (`npm start`): the renderer sends IPC `ai:chatStream`; the main process owns the network call (key never enters the renderer) and streams deltas back over `ai:chunk` events.
- **Browser direct** (web mode): if you saved an API key, `renderer/ai-client.js` calls the provider straight from the page — Groq, OpenAI, Gemini, Claude and OpenRouter all expose browser-CORS OpenAI-compatible endpoints, so **zero backend is required**.
- **Vercel free core** (web mode, no key): `api/chat.js` runs on Vercel; the key lives in server env vars and the browser never sees it. If no key is configured at all it answers with a built-in free conversational brain, so you never get a dead end.
- **Offline brain**: regex intent parser — last-resort, fully local.

---

## 3. Connecting ChatGPT (OpenAI)

### 3.1 Recommended desktop path — sign in with your ChatGPT account

GemAir Desktop now uses the MIT-licensed
`@opencoredev/loginwithchatgpt-core` protocol implementation:

1. Open **Settings → AI & Connections → CONNECT CHATGPT**.
2. GemAir requests a short-lived device code and opens OpenAI's own
   `auth.openai.com/codex/device` page in the system browser.
3. Sign in only on OpenAI's page and approve the request. Enter the one-time
   code if OpenAI asks for it.
4. GemAir's **main process** polls at OpenAI's requested cadence, exchanges the
   authorization for tokens, and stores them through Electron `safeStorage`.
5. GemAir asks the account for its available models. Pick a model, reasoning
   effort and eligible service tier in the connection panel.

The renderer receives the one-time code, email/plan display values, and model
IDs. It never receives the access token, rotating refresh token, ID token,
ChatGPT account id, device authorization id, or authorization code. On Linux,
GemAir requires a real Secret Service backend and refuses to save account
tokens if Electron reports its insecure `basic_text` fallback.

Chat requests use the account-backed Codex Responses endpoint:

```text
POST https://chatgpt.com/backend-api/codex/responses?client_version=…
Authorization: Bearer <main-process-only token>
chatgpt-account-id: <main-process-only id>
OpenAI-Beta: responses=experimental
originator: gemair
```

The body is stateless (`store: false`), requests encrypted reasoning content
for continuity, and uses native Responses function calls. Tool calls execute
through GemAir's existing permission policy and audit path. The full output —
including encrypted reasoning items — is carried into the next tool round.

Access tokens refresh five minutes before expiry and synchronously after a
sleep/resume when necessary. Refresh is single-flight because OpenAI may rotate
refresh tokens.

> Account model access is controlled by OpenAI and the user's ChatGPT plan.
> GemAir cannot guarantee a model, fast tier, quota, or permanent endpoint
> stability. This is not the same product as OpenAI Platform API billing.

### 3.2 Optional OpenAI Platform API-key path

Power users can still select the `ChatGPT / OpenAI` provider preset, enter a key
from <https://platform.openai.com/api-keys>, and use the standard
`https://api.openai.com/v1/chat/completions` transport. Platform API usage is
billed separately from a ChatGPT subscription.

### 3.3 Explicit legacy fallbacks

The connection row retains browser-session capture, pasted session JSON, and
local `~/.codex/auth.json` import. Local Codex import understands nested token
objects, refreshes an expired short-lived token when possible, and enables the
same Responses transport. Browser-session credentials lack the account header
required by Codex, so only that fallback uses the old web conversation route
and text tool markers.

See [docs/UPSTREAM-INTEGRATION.md](docs/UPSTREAM-INTEGRATION.md) for exact
upstream revisions, license decisions, threat boundaries, and tests.

---

## 4. Connecting Google Gemini

### 4.1 The way GemAir implements it — Gemini's OpenAI-compatible endpoint

Google ships an **OpenAI-compatible layer** of the Gemini API, so the exact same client code that talks to ChatGPT talks to Gemini:

1. Create a key at <https://aistudio.google.com/apikey> (Google AI Studio — free tier available).
2. In GemAir: **Settings → AI BRAIN → click the `Gemini` preset** (fills Base URL `https://generativelanguage.googleapis.com/v1beta/openai` + model `gemini-2.5-flash`), paste your key, **TEST CONNECTION**, Save.

The call looks like:

```
POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
x-goog-api-key: AIza…            ← native Gemini header (sent alongside Bearer)
Content-Type: application/json

{ "model": "gemini-2.5-flash", "messages": […], "stream": true, "tools": […] }
```

Details handled by GemAir:

- **Auth**: `aiHeaders()` (main.js) and `directClientChat()` (ai-client.js) add `x-goog-api-key` automatically when the base URL is Gemini.
- **Tool compatibility**: if a Gemini model refuses the `tools` schema (400/404/422 mentioning tools/functions), the client **retries once without tools** so you still get an answer.
- **Models**: `gemini-2.5-flash` (default), `gemini-2.0-flash`, `gemini-1.5-flash`, `gemini-2.5-pro`.

### 4.2 The way Stonic does its *voice* — Gemini Live API

Stonic's Terms (§6) disclose that their **voice assistant is powered by Google's Gemini Live API** (free preview): a bidirectional **audio-streaming** session (mic audio in → spoken audio out) with ~15-minute session caps. That is the "it feels human" layer.

GemAir today uses **text-in / TTS-out** (Web Speech recognition + neural TTS), which is the local-first, zero-preview-dependency choice. A Gemini Live integration would slot in behind the same `speak()`/recognition seams — the streaming protocol is a WebSocket (`wss://generativelanguage.googleapis.com/ws`) exchanging `realtimeInput`/`serverContent` messages. Tracked as future work, not required for the text brain.

---

## 5. Connecting Claude (bonus)

Preset `Claude` → base `https://api.anthropic.com/v1` (Anthropic's OpenAI-compatible endpoint) + model `claude-sonnet-4-20250514`. Auth adds `x-api-key` + `anthropic-version` automatically. Key from <https://console.anthropic.com>.

---

## 6. The tool loop (how the brain gets "hands")

GemAir has one catalog (98 tools in `main.js`) and one `executeTool` policy,
but two native wire formats:

```text
Provider/API-key/local models: chat/completions → assistant.tool_calls → role:tool
ChatGPT account:              responses → function_call → function_call_output
```

Both loops are capped at six rounds. Before each connected-account turn,
`lib/tool-router.js` ranks the catalog against the recent conversation, keeps a
small always-useful core, adds explicit intent matches, and sends at most 24
tools. This reduces context rot without bypassing permissions. The ChatGPT
Responses loop also carries encrypted reasoning output between stateless
rounds.

Tools the brain can drive include: `get_weather`, `web_search`, `fetch_webpage`, `open_application`, `run_command` (permission-gated), `save_note`, `remember_fact`, `search_memory`, `set_reminder`, `control_volume`, `take_screenshot`, `translate`, `get_crypto_price`, `send_email`, `open_whatsapp`, `generate_image` and more. Every execution is logged to the mission log.

**Computer-Use (keyless) suite** — `get_screen_size`, `capture_agent_screen`, `describe_screen`, `move_mouse`, `mouse_click`, `type_text`, `press_key`, `scroll_mouse` — is added to the same `TOOLS` array and driven by the same loop, but all mouse/keyboard actions are gated on `allowComputerUse`. Implementation lives in `lib/computer-agent.js` and uses only OS-native calls (PowerShell / AppleScript / `xdotool`) — no native Node addon, no API key, no vendor.

There is also a dedicated `computerUseAgent` loop for autonomous desktop tasks: screenshot → ask the model to act → execute tool → re-look, up to N steps. It prefers a **keyless local Ollama** (auto-detected, vision-capable) and degrades to a deterministic, no-model `offlineComputerUse` brain if no model is present.

A **GemAir `codingAgent` loop** works the same way but against a project directory: it reads the repo (`list_directory`/`read_file`/`search_files`), plans, edits (`write_file`) and validates (`run_command`), all keyless via the same brain. There is a `run_coding_cli` tool that delegates whole tasks to a user-installed local coding CLI configured with a keyless Ollama endpoint. Vendored reference source for the upstream patterns lives in `vendor/`.

---

## 7. HUD themes — the string system (Stonic v1.0.52 parity)

Stonic: *"HUD themes — pick the look of the whole interface; your choice is saved and applies everywhere."*

GemAir does this with **`renderer/themes.js`** — every theme is one object of **plain string tokens**:

```js
emerald: {
  label: 'Emerald',
  tagline: 'Hacker green — matrix terminal',
  accent: '#35ffb0', hue: 152,
  bg: '#040a08', bg2: '#071310',
  text: '#e9fff5', dim: '#7fae9c',
  good: '#3dff9a', warn: '#ffc24b'
}
```

`GemAirThemes.apply('emerald')` then:

1. writes every token out as a **CSS custom property** on `<body>` (`--accent`, `--accent-soft`, `--accent-glow`, `--bg`, …) → the whole DOM re-skins;
2. fires `gemair:theme` → `app.js` sets `currentAccent` → every **canvas** (orb, 3D background, Agent Town, globe, map, mood) redraws in the new color;
3. updates the top-bar swatches, the top-bar theme name tag and the Settings picker.

**Pick a theme**: top-bar swatches, **Ctrl+K → "Emerald Theme"**, or **Settings → HUD THEMES** (the full swatch grid). The choice is saved in the profile and applied on every boot. **Add a theme**: add one string object to the table — swatch, settings card and command-palette entry all appear automatically.

---

## 8. Quick setup table

| Brain | Get a key | Base URL | Model | Notes |
|---|---|---|---|---|
| **ChatGPT / OpenAI** | platform.openai.com | `https://api.openai.com/v1` | `gpt-4o-mini` | preset `ChatGPT` |
| **Gemini** | aistudio.google.com/apikey | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | preset `Gemini`; free tier available |
| **Claude** | console.anthropic.com | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` | preset `Claude` |
| **Groq** | console.groq.com | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | preset `Groq`; fast + free tier |
| **OpenRouter** | openrouter.ai | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct` | one key, many models |
| **Ollama (local)** | none | `http://localhost:11434/v1` | `llama3` | fully offline |
| **Free core (no key)** | none | — | — | web mode only, Vercel serverless |

### Troubleshooting

- `HTTP_401/403` — wrong/expired key, or key from the wrong provider for the Base URL.
- `HTTP_404 model …` — model name not available on that provider/account; try a lighter model from the table.
- Gemini with tools error — automatic retry without tools kicks in; you'll still get answers, just no live tool calls on that model.
- Nothing happens in Electron — check **Settings → TEST CONNECTION** (it reports the provider name it detected: GEMINI / CHATGPT / CLAUDE / GROQ …).
