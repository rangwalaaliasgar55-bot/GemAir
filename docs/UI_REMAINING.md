# GemAir — Remaining Frontend UI Work (living checklist)

**Date:** 2026-09-09 · **Branch:** `arena/01a087cc-gemair` · **Scope:** Apple-quality frontend finish; backend/TOOLS/IPC untouched.
Re-audit of main against the mission brief. Checked items are done and verified by the named tests; unchecked items are open work. Update this file each phase until empty.

---

## A. Cascade & token health

- [x] `design-tokens.css` first in cascade; materials / radius / elevation / type / motion / spacing tokens (docs/DESIGN_TOKENS.md).
- [x] **Phase 1 done** — `style.css` rewritten as a calm, token-driven base (no Google Fonts import, no RGB/konami/iron-man default paths, no scanline/vignette paint, semantic tokens everywhere). `depth.css` rewritten as a pure layout/responsive/a11y layer (spaceship-bridge + command-deck re-skins deleted). `light-mode.css` slimmed to scrim tints. `apple.css` `!important` count 289 → 8 (survivors are `@supports not (backdrop-filter)` opaque fallbacks only).
- [x] `renderer/components.css` `.ga-*` recipe library added (linked after `apple.css`, in `sw.js` shell, `CACHE_VERSION` → `-production2`). Recipes documented in docs/DESIGN_TOKENS.md.
- [ ] `stonic-skin.css` still on disk, unlinked (dead weight; `scripts/apply_stonic_skin.js` would re-link it). Leave, ignore pipeline.
- [ ] Accent bridges on `:root` (`--accent` = system blue until themes.js paints a theme) — verify first-paint in Electron.
- [ ] `apple.css` residual: a final read-through for dead rules (RGB neutralizers etc.) once Phases 2–8 land.

## B. Decorative canvas loops (resolved in Phase 12)

- [x] **S2 done** — decorative paint is off by default (`window.__GA_DECOR = true` re-enables): starfield `#bgCanvas` (hidden), orb particles `#orbCanvas` (CSS orb replaces it), radar `#radarCanvas` (hidden), sat sweep `#satCanvas`, circuit wires `#wireCanvas`. Globe and 2D map draw **one static frame** (hotspots stay clickable; `worldGlobeRedraw()` repaints on headline load and resize). All canvas nodes stay in the DOM; guards never throw.
- [x] **S12 done** — intervals pause while `document.hidden`: town tick (250ms), town chrome tick, radar sys poll (4s), `pollSystem` (2.5s), topbar clock (1s); avatar loop stops while hidden and restarts on `visibilitychange`; `scheduleViewFrame` already paused per-view frames and `reduced-motion.css` + per-animation `prefers-reduced-motion` blocks cover the new orb animations.
- [x] **S11 done** — `scripts/contrast-audit.js` (WCAG AA, both appearances + 8 theme text/dim pairs): label tertiary alphas raised (dark .4→.55, light .42→.66), new `--color-system-blue-filled: #0066cc` for filled surfaces carrying white text (user bubbles, primary/mini buttons, palette selection, `.ga-btn-primary`), light link `#0066cc`, dark-green labels on green badges. Audit exits non-zero on failure — run it with `node scripts/contrast-audit.js`.

## C. IA / chrome

- [x] Sidenav labels + icon tiles (apple.css Finder skin); `data-view` hooks intact.
- [x] **Phase 2 done** — i18n dictionaries (en/hi/ur) relabeled to the new IA (Assistant / Workspace / Tasks & Goals / Automations / Discover; `sat.title` → Local brief; sentence-case status strings). Topbar de-cluttered: clock + date restored to center; Spotlight/CC compacted to icon buttons (aria-labelled); mode/context/system/battery/download chips hidden from the bar and surfaced as a live status section in Control Center (apple.js `mirrorCcStatus()` MutationObservers, `#appleBattery2` via existing `updateBatteryBadge`). Assistant stacking conversation-first ≤1050px/≤720px. PWA standalone safe-area padding. Boot line + Settings sheet titles sentence-cased; `.assistant-grid` breakpoints consolidated into depth.css.
- [x] **Phase 3 done** — conversation-first Assistant: the chat panel (now `#chatPanel`) moved from the AGENT expert tab into the hero center column (log + activity + composer + quick commands); the AGENT tab/pane was removed (Voice tab active by default; `activateQuickButton`'s agent-tab click is guarded and stays for the quick-access test contract); the right rail is now context meters (2×2 circuits) → voice orb → town preview → expert tabs (Voice/Notes/Desktop). Designed chat empty state (`.chat-empty-mark`), readable tool cards (text-face head, clipped mono I/O), chat-first stacking at ≤1050/≤720. `pushToolActivity` scrolls to `#chatPanel`.
     Note: the sandbox was re-cloned mid-mission (branch history reset to 75e4046; phases 0–2 commits lost, never pushed) — this commit re-lands phases 0–3 together; a few silently-lost edits (icon-btn base, CC battery/status styles, settings title, depth breakpoints) were re-applied and verified.
- [ ] Topbar on very narrow widths (<420px): brand, net, brain, STT, 3 icon buttons — may still crowd; revisit with Phase 13 responsive pass.
- [ ] Footer copy + clock/date casing fine; ensure single quiet sentence (already calm).
- [ ] Boot: apple.css already hides BIOS; remove the boot-scan/BIOS markup weight in style.css source; verify skip affordance.
- [ ] Windows safe-area / `-webkit-app-region` for Electron titlebar not verified (main.js frame config untouched).

## D. View-by-view remaining sci-fi / HUD copy

ALL-CAPS `panel-title`s in `renderer/index.html` (sentence-case pass pending):
- Assistant: 139 `NOW — DASHBOARD`, 149 `LOCAL BRIEF — WEATHER & SEARCH`, 166 `TODAY HEADLINES`, 264 `PLAN-ACT — IDLE`, 342 `DESKTOP STATE — LIVE`; 218 `THINKING` pill, 223 gem role, 231 `START AI`, 238 `STANDBY`.
- Core: 361 `LIVE TELEMETRY`, 418 `LONG-TERM MEMORY`, 438 `MEMORY BROWSER`, 457 `ACTIVE PROCESSES — SYSTEM MONITOR`, 468 `TASKS`, 479 `NOTEBOOK`, 490 `REMINDERS — ACTIVE ALARMS`, 502 `LEARNED SKILLS`, 514 `STANDING RULES`, 525 `ACTION AUDIT LOG — FED BY GET_ACTION_LOG`, 536 `SOUL — PERSONALITY TUNING`, 557 `DESKTOP MODES — ONE SENTENCE ARRANGES EVERYTHING`.
- Companion: 569 `MOOD — EMOTIONAL BASELINE`, 592 `HABITS & GOALS`, 610 `WELLNESS & FOCUS`, 642 `LIFE COMPASS`; 601 `⟳ NEW AFFIRMATION`, 619 `🍅 FOCUS POMODORO`, 620 `📊 WEEKLY REPORT`.
- World: 743 `DUAL / GLOBE / 2D COMMAND MAP` modes, 754 `WORLD MONITOR — UTC`, 756 globe caption `DOTTED WIREFRAME EARTH · CLICKABLE NEWS HOTSPOTS`, 761 `COMMAND MAP — LIVE 2D GRID`, 768 `GLOBAL HEADLINES — LIVE INTELLIGENCE FEED`, 778 `⟳ REFRESH FEED`.
- Modals: 802 `PICK YOUR HUD THEME`, 821 `⚠️ EXPERIMENTAL CONNECTION`, 845 `🔌 CONNECTION LOST`, 866 `📋 PASTE CHATGPT SESSION`, 922 `SETTINGS`; 553 `STEADY · W 60 · WIT 40 · B 70` adaptive chip; 960 `CONNECT CHATGPT`, 974 `CONNECT GEMINI`.
- app.js strings: 4876–4877 `VOICE/GENDER` rows, `SAT-LINK FEED` (i18n `sat.title`), greeting "all systems online" (~boot), `NO MODE`/`FREE CORE` chips, topbar `WORK/GAMING/CHILL/STUDY` chips (index.html:79–82).
- View structure: core radar panel (index.html:381–384) hides; world grid keeps canvas ids; settings sections structurally OK (860px sidebar collapse exists).

## E. Component system (`.ga-*` recipes) — base library landed (Phase 1)

`components.css` has the core recipes (documented in docs/DESIGN_TOKENS.md): `.ga-card`, `.ga-section-title`, `.ga-row`, `.ga-btn-primary/secondary/ghost/destructive`, `.ga-icon-btn`, `.ga-segmented`, `.ga-field`, `.ga-switch`, `.ga-slider`, `.ga-chip`/`.ga-status-pill`, `.ga-msg-user/assistant/system`, `.ga-tool-call`, `.ga-agent-card` (refine existing), `.ga-sheet`, `.ga-toast`, `.ga-empty`, `.ga-skeleton`, `.ga-meter`, `.ga-voice-orb`. Remaining: apply `.ga-*` inside app.js message templates (optional — legacy classes now styled to match), `.ga-voice-orb` states (Phase 10).

## F. Assets, marketing, misc

- [ ] `build/icon*.png|ico`, `renderer/assets/gemair-512.png`, `gemair-logo.png` still pre-SVG-mark rasters; regenerate from `assets/logo-mark.svg` (selfcheck enforces sizes/thresholds).
- [ ] `download.html` tone sweep (Mission Control language check).
- [ ] Light-mode AA audit across 8 themes (accents via `themes.js derive()`).
- [ ] Onboarding overlay copy still cinematic (index.html:889–915 `GEMAIR` / `Commander…` / orb pulse).
- [x] `<860px` assistant stacking: conversation first (chat is the hero center column at every breakpoint; ≤1050/≤720 put it first).
- [ ] Empty/loading skeletons inconsistent (`.empty` text-only) — chat empty state designed in Phase 3; remaining views in Phases 4–8.

## Quality gates (every commit)

`node scripts/selfcheck.js` · `appearance-test.js` · `product-experience-test.js` · `production-surface-test.js` (+ touched-area tests). Version locked 2.5.3; no `.github/**` edits; IDs/`window.__*`/`GemAirThemes` contracts sacred.
