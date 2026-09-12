# Upstream integration review — ChatGPT, FreeGPT and JARVIS projects

Reviewed on **2026-09-12** for the release after GemAir 2.7.0. This document
records what was inspected, what is shipped, and the licensing/security boundaries.

## Repositories and exact revisions

| Repository | Revision reviewed | License | Decision |
| --- | --- | --- | --- |
| [`missuo/FreeGPT35`](https://github.com/missuo/FreeGPT35) | `3bf421eecee954a5361677ec225f61348684f6bc` | AGPL-3.0-only | Source-derived anonymous sidecar, kept under a separate AGPL program boundary |
| [`opencoredev/login-with-chatgpt`](https://github.com/opencoredev/login-with-chatgpt) | `3befb7fb625170cb305b116a654c7e2f8672bae4` | MIT | Integrated its published core package, pinned at `0.2.0` |
| [`isair/jarvis`](https://github.com/isair/jarvis) | `d22ed8b975792842dc09e49861f31a39cbb302a6` | custom non-commercial license | Product patterns studied; no source copied |
| [`open-jarvis/OpenJarvis`](https://github.com/open-jarvis/OpenJarvis) | `b1055c983b25b298c7e97723847d215df18de4a8` | Apache-2.0 | Python/Rust source included as an explicitly installed reasoning sidecar |

The complete relevant source trees were inspected. FreeGPT35 and OpenJarvis are
now present under `sidecars/` with pinned revision files and their original
licenses. They are not relicensed as part of GemAir's MIT core.

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

## 2. `FreeGPT35`: separately licensed anonymous chat sidecar

GemAir ships a source-derived AGPL-3.0-only sidecar under
`sidecars/freegpt35/`. It follows the reviewed upstream behavior closely:

1. create a new anonymous device id;
2. call `backend-anon/sentinel/chat-requirements`;
3. calculate the sentinel proof token from the returned challenge;
4. submit the legacy anonymous conversation request;
5. translate cumulative assistant snapshots into OpenAI-compatible streaming
   deltas or a buffered `POST /v1/chat/completions` response.

The upstream source snapshot, README, license, package manifest, and exact
revision are retained next to the production sidecar. `lib/freegpt35-sidecar.js`
is the Electron-main lifecycle/client boundary. The renderer never receives the
sidecar port or token.

### Deliberate security differences from upstream

GemAir does **not** reproduce unsafe deployment defaults:

- TLS certificate verification is never disabled;
- the server binds only to an ephemeral `127.0.0.1` port;
- every route requires a random, per-process bearer token;
- CORS is not enabled;
- request size, message count, concurrency, and deadlines are bounded;
- upstream errors are surfaced instead of being presented as valid answers;
- the process is shut down with GemAir.

This sidecar is an anonymous fallback, not a replacement for account-backed
Codex OAuth. It uses an undocumented, historically fragile OpenAI web route and
may stop working when OpenAI changes that route. The UI identifies answers as
`FreeGPT35 / gpt-3.5-turbo` and labels the code's AGPL boundary.

### License boundary

`sidecars/freegpt35/` remains AGPL-3.0-only. Its full corresponding source and
license ship with packaged builds. GemAir's MIT main process controls it as a
separate child program over an authenticated loopback HTTP interface. Changes
to the AGPL sidecar must continue to be offered under AGPL-3.0-only, including
when the modified sidecar is made available over a network.

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
| Tool and memory digest passes | Conversation digests are now persisted through the separately licensed OpenJarvis sidecar |
| MCP catalog/runtime | Implemented through the Apache-2.0 OpenJarvis sidecar; no `isair/jarvis` source was copied |
| Dictation into any application | Not added; global hotkeys/accessibility permissions need platform-specific work |
| Nutrition journal | Existing life/mood/goals focus; nutrition remains optional future scope |
| Behavioral eval suite | Existing Node regression suite; expanded for OAuth, SSE, tool calls and routing |

The tool router added in 2.7 is an original implementation for GemAir's
existing `TOOLS` format. It tokenizes the current turn, applies explicit intent
hints, keeps a utility core, ranks descriptions and JSON-schema fields, and
retains stable catalog order.

---

## 4. `OpenJarvis`: isolated Python/Rust reasoning sidecar

The complete reviewed OpenJarvis Python source and Rust workspace are pinned in
`sidecars/openjarvis/`. GemAir does not silently download or start the large
runtime. Settings presents an explicit **Install runtime** action which:

1. locates Python 3.10–3.13;
2. creates an app-private virtual environment under Electron `userData`;
3. installs the bundled pinned source into that environment;
4. builds the bundled PyO3 Rust extension when Cargo is available;
5. writes a private configuration with analytics and telemetry disabled;
6. starts a JSON-lines bridge over stdio (no listening network port).

A missing Rust toolchain is reported honestly and does not disable the Python
runtime. The stable PyPI wheel is pure Python; GemAir never attempts to install
a nonexistent `openjarvis-rust` distribution. GemAir's pinned source patch keeps
capability enforcement and SQLite/FTS5 memory available through conservative
Python fallbacks when the optional native module is absent. It also retains MCP
clients for the full agent run, closes them deterministically, and excludes MCP
tools unless their protocol annotations explicitly mark them read-only and
non-destructive.

### Connected capabilities

The bridge exposes bounded operations for:

- orchestrator/ReAct reasoning and an advisory pre-plan pass;
- the `deep_research` multi-hop researcher with retrieval-only tools;
- SQLite/Rust-backed memory search and storage plus conversation summaries;
- injection, secret, and optional PII scanning;
- MCP discovery and agent use for an explicitly enabled loopback HTTP(S)
  server; only tools declaring `readOnlyHint=true` and
  `destructiveHint=false` are eligible for non-interactive reasoning;
- sandbox/runtime status with network-none and default-deny/read-only mount
  policy;
- capability-policy and guardrail status.

ChatGPT, Gemini, custom provider, local model, and anonymous fallback messages
can receive an OpenJarvis planning brief when the user enables **Deep
reasoning**. `/research`, `/plan`, `/memory-search`, and `/jarvis` provide
explicit access from chat.

### Authority and safety model

OpenJarvis is a reasoning sidecar, not a second desktop-control authority.
Only allowlisted agents and reasoning/retrieval/memory tools can be requested by
the bridge. It cannot directly invoke GemAir's JavaScript file, shell, browser,
mouse, keyboard, or operating-system tools. Concrete actions still return to
GemAir's existing `executeTool` validation, risk policy, user confirmation, and
audit log.

Generated OpenJarvis configuration enforces:

- `[telemetry].enabled = false` and `[analytics].enabled = false`;
- personal security profile, scanning, SSRF checks, rate limits, and tool
  confirmation;
- `[security.capabilities]` enabled with `default_deny = true`;
- an empty MCP server list by default;
- sandbox disabled until a compatible Docker/Podman runtime and image are
  explicitly configured; declared sandbox network policy is `none`.

OpenJarvis is Apache-2.0. Its original license and notices ship with the source.

---

## 5. Files changed for the integration

| File | Purpose |
| --- | --- |
| `lib/chatgpt-codex.js` | SDK adapter, device state machine, Responses SSE, model discovery, native tool loop |
| `lib/oauth-bridge.js` | Main-process token custody, public response filtering, refresh/model orchestration |
| `lib/connections.js` | Encrypted ID/account token fields plus model/reasoning/tier preferences |
| `lib/codex-auth-import.js` | Current nested Codex token shape, account metadata and refresh-on-import |
| `lib/tool-router.js` | Turn-aware catalog reduction |
| `sidecars/freegpt35/`, `lib/freegpt35-sidecar.js` | AGPL anonymous gateway and authenticated lifecycle/client |
| `sidecars/openjarvis/`, `lib/openjarvis-sidecar.js` | Pinned Python/Rust source, bridge, isolated installer and JSON-lines controller |
| `main.js` | IPC endpoints, provider fallback, sidecar lifecycle, planning and memory integration |
| `preload.js` | Narrow account and sidecar IPC surfaces |
| `renderer/index.html`, `renderer/app.js`, `renderer/style.css` | Account controls plus anonymous/OpenJarvis install and status UI |
| `scripts/chatgpt-codex-test.js`, `test/*sidecar.test.js` | Network-free OAuth, protocol, lifecycle, policy and fallback regressions |
| `THIRD_PARTY_NOTICES.md` | Required attribution for the shipped MIT dependency |

Legacy web-session capture remains available as a clearly labelled fallback.
It does not have the account id needed by Codex, so it intentionally stays on
the old web transport and custom marker adapter.

---

## 6. Security and operational limitations

- FreeGPT35 relies on undocumented anonymous OpenAI endpoints. Matching the upstream protocol cannot guarantee current or future availability.
- OpenJarvis installation can download a large Python dependency set and therefore only runs after explicit confirmation. It requires Python 3.10–3.13 and a local inference engine/configuration to reason.
- External MCP servers and execution sandboxes are default-deny and unconfigured. Source/runtime support is reported separately from readiness; GemAir never claims Docker, Podman, Rust, or an MCP server is ready when it is not.
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

1. Extend MCP beyond one loopback HTTP(S) endpoint only after implementing
   encrypted bearer-token custody and interactive approval for mutating tools;
   subprocess MCP transports and remote hosts remain blocked.
2. Add byte-level package download progress where pip exposes totals.
3. Publish and sign platform-specific sandbox images before enabling sandboxed
   execution; keep network disabled and mounts read-only/default-deny.
4. Add opt-in system-wide dictation after implementing platform accessibility
   permission checks and a clear recording indicator.
5. Add provider health/model-capability caching with expiry and manual refresh.
