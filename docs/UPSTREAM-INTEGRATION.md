# Upstream integration review — ChatGPT, FreeGPT and JARVIS projects

Reviewed on **2026-09-12** for GemAir 2.7.0. This document records what was
inspected, what was integrated, and what was deliberately not copied.

## Repositories and exact revisions

| Repository | Revision reviewed | License | Decision |
| --- | --- | --- | --- |
| [`missuo/FreeGPT35`](https://github.com/missuo/FreeGPT35) | `3bf421eecee954a5361677ec225f61348684f6bc` | AGPL-3.0 | Protocol ideas only; no source copied or bundled |
| [`opencoredev/login-with-chatgpt`](https://github.com/opencoredev/login-with-chatgpt) | `3befb7fb625170cb305b116a654c7e2f8672bae4` | MIT | Integrated its published core package, pinned at `0.2.0` |
| [`isair/jarvis`](https://github.com/isair/jarvis) | `d22ed8b975792842dc09e49861f31a39cbb302a6` | custom non-commercial license | Product patterns studied; no source copied |
| [`open-jarvis/OpenJarvis`](https://github.com/open-jarvis/OpenJarvis) | `b1055c983b25b298c7e97723847d215df18de4a8` | Apache-2.0 | Architecture compared; GemAir-native implementation retained |

The repositories were cloned separately and their source trees, manifests,
documentation, tests, workflows, and license files were reviewed. GemAir does
not vendor those clones.

---

## 1. `login-with-chatgpt`: what GemAir adopted

This was the best match for the requested ChatGPT connection. Its `core`
package is framework-agnostic, runs on Node 18+, and implements the current
ChatGPT-backed Codex protocol without requiring a developer API key.

### Relevant upstream architecture

The monorepo contains four packages:

- **core** — device authorization, loopback PKCE, refresh rotation, JWT/account
  metadata, account model discovery, Codex Responses adaptation, and
  experimental Realtime helpers;
- **server** — cookie sessions, AES-GCM storage, origin checks, request limits,
  rate limits, and server-side response proxying;
- **react** — login component and hook;
- **ai** — Vercel AI SDK providers for proxy and direct server use.

GemAir Desktop already has a trusted Electron main process, OS-backed
`safeStorage`, a preload boundary, and its own streaming/tool engine. Bringing
in the server, React, or AI SDK packages would duplicate those layers. GemAir
therefore depends only on:

```json
"@opencoredev/loginwithchatgpt-core": "0.2.0"
```

Using the package rather than pasting a snapshot preserves its tests,
maintainer updates, package integrity hash, and MIT attribution.

### Implemented end-to-end flow

```text
Settings → CONNECT CHATGPT
  → main process requests device code
  → system browser opens auth.openai.com/codex/device
  → renderer receives only one-time code + public URL
  → main process polls at OpenAI's requested cadence
  → authorization code is exchanged for access/refresh/id tokens
  → account id, email, plan and token expiry are derived
  → tokens/account id are encrypted through Electron safeStorage
  → account-specific model list is requested
  → renderer receives only email, plan, model ids and preferences
```

Important boundaries:

- The user's OpenAI password is entered only on OpenAI's page.
- `device_auth_id`, authorization code, access token, refresh token, ID token,
  and ChatGPT account id never cross the preload bridge.
- A pending login is memory-only and expires after OpenAI's 15-minute window.
- Renderer polling cannot exceed the server-supplied interval.
- Disconnect removes the encrypted connection.

### Codex Responses transport

OAuth account sessions no longer use the old web `backend-api/conversation`
request. They use:

```text
https://chatgpt.com/backend-api/codex/responses
```

The SDK adapter supplies:

- `Authorization: Bearer …`;
- `chatgpt-account-id`;
- `originator`;
- `OpenAI-Beta: responses=experimental`;
- the current `client_version` model gate;
- `store: false`;
- reasoning configuration;
- `reasoning.encrypted_content` continuity;
- filtering of server-side response IDs for stateless follow-up requests.

GemAir parses Responses SSE incrementally and supports chunk-split UTF-8. The
connection panel lists the models returned for the signed-in account rather
than pretending one hard-coded model works for every plan. Users can select:

- account model;
- reasoning effort (`none` through `xhigh`);
- service tier (`auto`, `default`, `flex`, `priority`, or `fast`).

Model and tier availability remain controlled by OpenAI and the user's plan.

### Native tool calling

The old ChatGPT web path asked the model to print a custom `TOOL_CALL` marker.
The account OAuth path now sends real Responses function definitions and reads
real `function_call` output items.

For every tool round GemAir:

1. sends a relevant subset of the local tool catalog;
2. receives native function calls;
3. executes them through the existing `executeTool` permission/risk policy;
4. appends `function_call_output` items;
5. carries encrypted reasoning output into the next stateless request;
6. stops after at most six rounds.

This preserves one permission and audit system for provider-key chat, local
agents, and ChatGPT-account chat.

### Refresh behavior

OpenAI access tokens are short lived and refresh tokens may rotate. GemAir now:

- refreshes five minutes before expiry;
- refreshes synchronously before the first post-sleep request when needed;
- uses the current JSON refresh request including scope;
- keeps refreshes single-flight to avoid rotation races;
- persists a returned replacement refresh token;
- distinguishes a dead/reused/invalid refresh token from a transient outage.

---

## 2. `FreeGPT35`: what was learned and why it was not copied

The reviewed project is a roughly 400-line Express gateway exposing
`POST /v1/chat/completions`. It obtains an anonymous ChatGPT web session,
computes a proof token, calls the undocumented web conversation endpoint, and
translates the stream into an OpenAI-compatible response.

### Useful idea

An OpenAI-compatible local gateway is a good interoperability boundary. GemAir
already accepts arbitrary OpenAI-compatible base URLs, including local services
such as Ollama. A separately operated gateway can therefore be connected
without changing GemAir's renderer or tool loop.

### Reasons not to embed its implementation

- **License:** FreeGPT35 is AGPL-3.0 while GemAir is MIT. Copying or combining
  its server implementation would add copyleft distribution/network-source
  obligations to the combined work.
- **Transport age:** the code targets the old anonymous
  `text-davinci-002-render-sha` web flow and its own README redirects users to a
  different DuckDuckGo-based project because OpenAI changes broke the route.
- **Security:** its Axios agent sets `rejectUnauthorized: false`, disabling TLS
  certificate verification. GemAir will not ship that.
- **Reliability:** it depends on undocumented proof-of-work and browser
  fingerprint details that can change without notice.
- **Account model access:** anonymous GPT-3.5 emulation does not satisfy the
  requested “use my ChatGPT account and plan” behavior.

The obsolete `lib/free-chatgpt.js` script in GemAir was replaced with a
side-effect-free compatibility facade over the new device OAuth/Codex adapter.
It no longer writes bearer tokens to plaintext or launches a Windows shell at
module import time.

---

## 3. `isair/jarvis`: patterns reviewed

This project is a private/offline Python voice assistant with a desktop UI. Its
reviewed tree includes listening and wake detection, local Whisper, TTS,
conversation and graph memory, model tiers, planning/evaluation, MCP runtime,
tool selection, nutrition tools, dictation, location/time context, and a large
test/evaluation suite.

Its custom license allows non-commercial derivative use only and requires
those derivatives to keep the same terms. GemAir's MIT distribution cannot
copy that source while remaining generally reusable, including commercially.
No source, prompts, assets, or tests from it were copied.

### Patterns mapped to GemAir

| Jarvis pattern | GemAir status |
| --- | --- |
| Local-first assistant | Existing Electron local stores and optional Ollama |
| Wake phrase | Existing on-device Vosk wake word |
| Barge-in and TTS | Existing streaming TTS and barge-in |
| Tool selection to reduce context rot | **Added in 2.7:** original JS relevance router, max 24 tools/turn |
| Task planner | Existing plan/act workflow and coding/computer agents |
| Tool and memory digest passes | Partial: bounded histories and selected tools; deeper digest remains future work |
| MCP catalog/runtime | Not added in this release; requires a permission and process-isolation design |
| Dictation into any application | Not added; global hotkeys/accessibility permissions need platform-specific work |
| Nutrition journal | Existing life/mood/goals focus; nutrition remains optional future scope |
| Behavioral eval suite | Existing Node regression suite; expanded for OAuth, SSE, tool calls and routing |

The tool router added in 2.7 is an original implementation for GemAir's
existing `TOOLS` format. It tokenizes the current turn, applies explicit intent
hints, keeps a utility core, ranks descriptions and JSON-schema fields, and
retains stable catalog order.

---

## 4. `OpenJarvis`: patterns reviewed

OpenJarvis is a much broader Python/Rust/Tauri platform. The reviewed source
covers:

- multiple local/cloud inference engines and model discovery;
- simple, ReAct, orchestrator, proactive, research, coding, and channel agents;
- tool registries, confirmation flags, schedulers, MCP, skills and workflows;
- memory stores, extraction, session compression and learning;
- many messaging channels and personal-data connectors;
- credential stripping, SSRF controls, injection scanning, file policy,
  capabilities, sandboxing, signing, audit and rate limiting;
- speech backends, telemetry/energy benchmarks, a desktop app, API server and
  a large test suite.

GemAir and OpenJarvis have different runtime goals: GemAir is one Electron app
with a browser build; OpenJarvis is a Python platform with optional Rust and
Tauri components. Vendoring its 175k-line tree would add a second application
rather than improve this one.

### Architecture comparison

| OpenJarvis capability | GemAir equivalent / decision |
| --- | --- |
| Engine abstraction | Existing OpenAI-compatible provider catalog + Ollama + free core |
| Model discovery | Existing Ollama/Gemini discovery; **ChatGPT account discovery added** |
| Native tool schema | Existing OpenAI chat tools; **Responses native tools added** |
| Tool confirmation | Existing `TOOL_RISK` and human-in-the-loop policy |
| Agent loop guard | Existing bounded tool loops; ChatGPT capped at six rounds |
| Scheduler/proactive work | Existing reminders and background topic monitors |
| Persistent memory | Existing local-first facts, transcript, notes, tasks, mood, goals |
| Skills/workflows | Existing learned skills, modes, workflow gallery and agents |
| Security boundary | Electron sandbox + context isolation + preload allowlist + path/URL guards |
| MCP | Future work; must not launch arbitrary servers without clear consent |
| Messaging channel matrix | Not imported; each channel adds credentials and abuse surface |
| Mining/telemetry stack | Not aligned with GemAir's no-telemetry desktop goal |

OpenJarvis is Apache-2.0 and could be reused with notices, but this release did
not copy its source. The useful architectural ideas were implemented against
GemAir's existing APIs instead of embedding Python/Rust services.

---

## 5. Files changed for the integration

| File | Purpose |
| --- | --- |
| `lib/chatgpt-codex.js` | SDK adapter, device state machine, Responses SSE, model discovery, native tool loop |
| `lib/oauth-bridge.js` | Main-process token custody, public response filtering, refresh/model orchestration |
| `lib/connections.js` | Encrypted ID/account token fields plus model/reasoning/tier preferences |
| `lib/codex-auth-import.js` | Current nested Codex token shape, account metadata and refresh-on-import |
| `lib/tool-router.js` | Turn-aware catalog reduction |
| `main.js` | IPC endpoints and connected-brain Codex routing |
| `preload.js` | Narrow device/model IPC surface |
| `renderer/index.html`, `renderer/app.js`, `renderer/style.css` | One-time-code UI and account model controls |
| `scripts/chatgpt-codex-test.js` | Network-free protocol and tool-loop regression tests |
| `THIRD_PARTY_NOTICES.md` | Required attribution for the shipped MIT dependency |

Legacy web-session capture remains available as a clearly labelled fallback.
It does not have the account id needed by Codex, so it intentionally stays on
the old web transport and custom marker adapter.

---

## 6. Security and operational limitations

- The ChatGPT Codex endpoints and device flow are account-backed but can change
  upstream. They are not equivalent to an OpenAI Platform API key.
- Requests use the signed-in user's ChatGPT limits. GemAir cannot guarantee a
  model, fast tier, quota, or availability.
- JWT payload decoding supplies untrusted display/account hints only. GemAir
  does not treat a decoded payload as proof of identity; OpenAI validates the
  bearer token and account relationship on the model/model-list endpoints.
- The desktop main process necessarily holds usable account tokens in memory
  while running. At rest they are encrypted with Electron `safeStorage`.
  On Linux, GemAir rejects Electron's insecure `basic_text` fallback; a working
  Secret Service/keyring backend is required to connect an account.
- Manual web-session paste/capture is less stable and is not refreshable unless
  the imported JSON actually includes a refresh token.
- Gemini browser cookies are not Gemini API bearer tokens. Text generation
  still requires a valid AI Studio key or OAuth token with an accepted API
  scope.

## 7. Next integrations worth doing

1. Add a permission-scoped MCP host with an explicit server allowlist,
   per-tool confirmation metadata, process limits, and a visible activity log.
2. Add conversation/tool-result digest passes for small local models.
3. Add a provider health/model-capability cache with expiry and manual refresh.
4. Add opt-in system-wide dictation after implementing platform accessibility
   permission checks and a clear recording indicator.
5. Add account request budgeting in the desktop process (per-minute guard and
   user-visible counters), analogous to the reviewed server SDK guardrail.

These should be implemented as GemAir-native modules, with license review and
security tests before any upstream source is copied.
