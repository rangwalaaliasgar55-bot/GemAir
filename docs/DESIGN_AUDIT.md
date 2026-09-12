# GemAir Design Audit — Phase 0 + Phase 1

**Date:** 2026-09-09  
**Branch:** `arena/01a087af-gemair`  
**Scope:** UI-only redesign toward Apple-quality; backend/TOOLS/agents/memory/voice intact.

---

## 1. Repository structure (UI surface)

| Path | Role |
| --- | --- |
| `main.js` | Electron main process; TOOLS registry, IPC, computer/coding agents |
| `preload.js` | `window.gemair` bridge |
| `lib/*` | connections, modes, window-tools, OAuth, free-chatgpt |
| `api/*` | Vercel serverless (chat, weather, search, …) |
| `renderer/index.html` | Sole UI shell (~1.6k lines) — all views, modals, settings |
| `renderer/app.js` | Monolith controller (~9.2k lines) — chat, town, canvases, boot |
| `renderer/style.css` | Base sci-fi HUD stylesheet (~1.8k lines) |
| `renderer/depth.css` | Calm production surface layer |
| `renderer/apple.css` | Partial Apple HIG skin (loaded last, heavy `!important`) |
| `renderer/light-mode.css` | Light appearance overrides |
| `renderer/reduced-motion.css` | `prefers-reduced-motion` hooks |
| `renderer/themes.js` | String-token HUD themes → CSS vars on `<body>` |
| `renderer/avatar.js` | 3D/canvas Gem avatar + particles |
| `renderer/apple.js` | Control Center / Spotlight / DND / battery |
| `renderer/{store,ai-client,tts,edge-tts,gemini-live,providers,i18n}.js` | Feature modules |
| `build/icon*` | App icons (PNG/ICO/iconset) |
| `renderer/favicon.svg`, `assets/gemair-*.png` | Web icons / logo |
| `vendor/*` | Reference only (computer-agent Tauri, opencode) — **not** shipped UI |

**Architecture:** Vanilla DOM + Canvas 2D. No React/Vue. State via profile object + localStorage/IPC. Themes write CSS custom properties. Redesign must stay in this stack.

---

## 2. UI entry points & views

| View / surface | DOM id / class | Controller |
| --- | --- | --- |
| Boot sequence | `#bootOverlay` | `app.js` boot |
| Top bar / chrome | `.topbar` | HTML + `apple.css` traffic lights |
| Side nav | `.sidenav` `[data-view]` | `switchView()` |
| Assistant (chat/voice) | `#view-assistant` | chat pipeline, orb, mic |
| System Core / Workspace | `#view-core` | gauges, memory tabs |
| Life Companion | `#view-companion` | mood, goals, focus, wellness |
| Agent Town | `#view-town` `#townCanvas` | `startAgentTown()` |
| World Monitor | `#view-world` | globe/map canvases |
| Settings sheet | `#settingsModal` | sidebar sections |
| Command palette | `#palette` | Ctrl/Cmd+K |
| Control Center | `#appleControlPanel` | `apple.js` |
| Desktop / Coding agent modals | `#agentModal` `#codingAgentModal` | agent runners |
| Background starfield | `#bgCanvas` | `startBackground3D()` |
| Voice orb particles | `#orbCanvas` | `startOrb()` |
| Gem avatar | `avatar.js` + character PNGs | lip-sync / particles |

---

## 3. Hardcoded visual tokens (scattered)

### Colors (representative)
- **Base dark:** `#04060c`, `#070b15`, `#0a0f1a`, `#111318`, `#090a0d`
- **Accents (themes.js):** crimson `#ff3b3b`, emerald `#35ffb0`, cyan `#3bc9ff`, violet `#b05cff`, amber `#ffb73b`, graphite/ocean, RGB dynamic
- **Status:** good `#3dff9a` / `#30d158`, warn `#ffc24b` / `#ff9f0a`, error `#ff6b6b`, info `#3bc9ff` / `#0a84ff`
- **Apple layer:** `--apple-blue: #0a84ff`, `--apple-green: #30d158`, hairline `rgba(255,255,255,0.1)`
- **Light appearance (themes.js derive):** bg `#f4f7fb`, text `#111827`, dim `#526077`
- **RGB rainbow:** `#ff0040` → `#ff8c00` → `#ffe600` → `#2bff88` → `#00cfff` → `#7a4dff` → `#ff00d4`

### Typography
- Google Fonts: Inter, JetBrains Mono, Space Grotesk (`style.css` `@import`)
- Apple override: `-apple-system, SF Pro Text/Display, Inter, Segoe UI`
- Heavy mono letter-spacing (`.12em`–`.28em`) on HUD labels

### Shadows / glow
- `box-shadow: 0 0 Npx var(--accent-glow)` throughout `style.css`
- `text-shadow: 0 0 Npx var(--accent-glow)` on clocks, titles, circuits
- Modal: `0 0 50–60px var(--accent-glow)` + deep black drops

### Motion
- RGB infinite linear animations (`rgbGradient`, `rgbBorder`, `rgbHue`)
- `pulse`, `blink`, `msg-in`, boot sweeps
- Canvas RAF loops: bg stars, orb particles, town bob, globe spin, radar
- `reduced-motion.css` exists but many canvas loops only partially gate

---

## 4. Sci-fi / cyberpunk inventory (file + locus)

| Element | Location |
| --- | --- |
| Scanlines overlay | `index.html` `.scanlines`; `style.css` ~136–140; hidden by `apple.css` |
| Vignette | `index.html` `.vignette`; `style.css` ~142–145 |
| Boot BIOS / power sweep | `#bootOverlay`, `.boot-scan`, `.boot-bios` |
| Starfield + wireframe icosahedron | `app.js` `startBackground3D()` ~1896–1984; `#bgCanvas` |
| Orb particle field | `app.js` `startOrb()` ~1989–2040; `avatar.js` `drawParticles` |
| Pixel-art Agent Town | `app.js` `startAgentTown()` ~3633+; `#townCanvas`, `#townMiniCanvas` |
| Wireframe globe / command map | `app.js` `startGlobe()` etc.; `#globeCanvas` `#mapCanvas` |
| Radar sweep | `#radarCanvas` in core view |
| Sat decorative globe | `#satCanvas` |
| RGB speaking/recording borders | `style.css` 46–116; body classes `rgb-speaking` / `rgb-recording` |
| Neon glows on chips/buttons | `.icon-btn:hover`, `.nav-btn.active`, gauges, tool chips |
| Traffic-light title bar | `apple.css` `.topbar::before` (exact Apple red/yellow/green dots) |
| Mission-control copy | “MISSION CONTROL”, “SYSTEMS NOMINAL”, ALL-CAPS mono labels |
| Konami / Iron Man burst | `style.css` konami/iron-man keyframes |

**Preserved data bindings (must not break):**  
`AGENTS`, `window.__assignAgentTask`, `window.__agentBubble`, `window.__agentHandoff`, town seat bars, activity/mission feeds, dispatch UI, chat `@Agent` routing, TOOLS / offline brain / voice engines / store / themes API.

---

## 5. State & rendering approach

- **No component framework** — imperative DOM updates in `app.js`.
- **Persistence:** `store.js` + profile defaults in `app.js`; Electron `userData` via IPC; web `localStorage`.
- **Theming:** `GemAirThemes.apply(name)` sets `body.dataset.theme` + CSS vars; light/dark via `setAppearance`.
- **Canvases:** multiple independent RAF loops, gated by `scheduleViewFrame(view, cb)` and `REDUCED_MOTION`.
- **CSS cascade:** `style.css` → `light-mode.css` → `depth.css` → `apple.css` → `reduced-motion.css`.

**Redesign strategy:** Introduce `design-tokens.css` first in the cascade; evolve `apple.css` / calm overrides; replace town canvas with DOM glass cards; tone down or disable decorative canvas loops without removing agent state APIs.

---

## 6. Tests that gate UI changes

- `scripts/appearance-test.js` — light/dark token derivation, toggle, `light-mode.css` link, SW cache
- `scripts/selfcheck.js` — parse all JS, no dup IDs, boot wiring; **version locked at 2.7.0**
- `scripts/product-experience-test.js` — composer, download route
- Full `npm test` suite covers connections, chat transport, security, etc.

**Do not:** bump `VERSION` / `package.json` version, edit `.github/workflows/`, delete TOOLS or agent APIs.

---

## Phase 1 — Research findings (concise)

### Multi-agent visualization
- **AI Town / generative-agents:** spatial sim is charming but reads as game, not product.
- **LangGraph Studio / CrewAI / AutoGen Studio:** agent = card/row with status pill, current step, expandable tool trace, handoff edges as list or thin connectors — not sprites.
- **Adopt:** glass agent cards (avatar monogram, status chip, current task, last result); handoffs as compact activity rows; drop continuous idle walk loops.

### AI-native chat patterns
- **assistant-ui / Vercel AI SDK Elements / CopilotKit:** user bubble trailing, assistant leading; streaming caret or shimmer; tool calls as collapsible “ran `web_search`” chips with input/output.
- **Adopt:** calm bubbles (already partly iMessage in `apple.css`); keep `#toolFeed` as structured chips; subtle streaming indicator (pulse bar, not RGB).

### Apple HIG / Liquid Glass
- Materials: thin / regular / thick — blur 12–40px, saturate 120–180%, fill 40–72% opacity, 1px specular top edge.
- Type: SF Pro optical sizes; tracking tight on large titles (−0.02em), loose on captions.
- Corners: continuous (squircle) — CSS approximation via large radius + consistent scale 8/12/16/20/28.
- Motion: springy curves ≈ `cubic-bezier(0.22, 1, 0.36, 1)` / `(0.32, 0.72, 0, 1)`; respect `prefers-reduced-motion`.
- **Avoid:** literal Apple traffic-light trademark colors/layout as window chrome; use original window controls.

### Patterns we will adopt (5)
1. **Semantic design tokens** — surfaces, labels, materials, elevation, type, motion, spacing — light/dark.
2. **Liquid Glass panels** — replace neon HUD panels and accent-glow borders.
3. **Card-based Agent Town** — same agent state, no pixel office loop.
4. **System Settings chrome** — sidebar + detail (settings already half-there); clean title bar without clone traffic lights.
5. **Calm voice presence** — soft glass orb / level meter; no RGB conic carnival on mic/speak.

---

## Implementation order (Phase 2–5)

1. `renderer/design-tokens.css` + wire into HTML/SW  
2. Logo SVG + favicon variants  
3. Global chrome (topbar, sidenav, footer)  
4. Chat / voice core polish  
5. Agent Town DOM rebuild (preserve APIs)  
6. Life Companion dashboard calm  
7. Settings System Settings polish  
8. Sweep: remove leftover neon, reduced-motion, contrast, boot verification  

Each step: small commit → run relevant tests → push branch only.
