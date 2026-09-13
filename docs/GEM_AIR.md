# Gem Air — attention control layer

Gem Air is the attention/productivity half of this Windows application. Its primary
interface is a **floating island**: a small always-on-top capsule that sits above your
work, shows what you are doing right now, and expands when there is a decision to make.

Interaction philosophy: **small control → contextual information → user decision →
system remembers → state changes.**

---

## 1. Layers

Nothing is built into one file. Each engine is pure where it can be, so it is testable
without Electron and without the OS.

```
lib/attention/
  core/                      pure logic — no Electron, no fs, no network
    schema.js                state shape, defaults, seed knowledge, hydrate/migrate
    classify.js              application -> activity/category -> focus relevance
                             (browser windows are classified by SITE, not by "Chrome")
    schedule.js              plans, focus periods, breaks, sleep windows, midnight math
    blocking.js              decides IF something is blocked and WHY (+ browser policy)
    tracking.js              activity segments, timeline, lanes, trends, idle
  store.js                   persistence (atomic writes, debounced, crash-safe)
  service.js                 the spine: detection -> classification -> blocking ->
                             tracking -> island state; owns the question flow
  ipc.js                     the guarded `air:` IPC surface
  bridge.js                  loopback browser-integration boundary (token-guarded)
  island-window.js           the frameless/transparent/always-on-top island window
  native/
    detector.js              foreground app + window title + idle (OS)
    enforcer.js              the part that actually acts on the OS + capability honesty

renderer/air/
  island.html/.css/.js       the floating island (compact ⇄ expanded, contextual states)
  attention.css              the desktop surfaces' styling
  attention-ui.js            Dashboard, Activity, Plans, Blocking, Browser, Sleep, Settings

extension/chrome/            MV3 extension — the only way to see/stop a browser tab
```

State lives in `%APPDATA%/GemAir/gemair-attention.json`, written atomically with backups.

---

## 2. Gem Air island states

| State | Compact shows | Behaviour |
|---|---|---|
| Working | `VS Code` · `Development` · `01:14:32` | live timer against the current subject |
| Distraction | `youtube.com` · `Distraction` | red accent, faster pulse |
| Blocked | `youtube.com` · `Blocked` | reason shown; protected blocks marked |
| Question | `What is this for?` | expands automatically with Work / Distraction / Other |
| Sleep | `Sleep until 07:00` | reflects the scheduled restriction |
| Idle | `Idle` | idle time tracked separately, never counted as focus |

Expanding shows the current activity, plan state, timer, blocking state and controls.
The island is draggable (the grip is the only `-webkit-app-region: drag` area) and its
position persists.

---

## 3. Capability honesty

Never claim a feature works if it is only drawn. Current status:

| Capability | Status | Notes |
|---|---|---|
| Foreground app + window title detection | **Implemented** | Windows (user32 via PowerShell), macOS, Linux best-effort |
| Idle detection | **Implemented** | Electron `powerMonitor.getSystemIdleTime` |
| Activity tracking / timeline / trends | **Implemented** | fully local |
| App classification + learning | **Implemented** | persists, user categories supported |
| Closing a blocked application | **Implemented** | graceful `taskkill`, forced if the rule is protected |
| Preventing relaunch of a blocked app | **Partial** | the app is re-closed when it returns to the foreground; there is no kernel hook |
| Website detection (exact URL) | **Implemented via extension** | without it, the site is *inferred* from the window title and the UI says so |
| Website blocking inside the browser | **Implemented via extension** | navigation is replaced with the block page |
| System-wide website blocking | **Requires native integration** | hosts-file edits need an elevated helper; the API returns `requiresNativeIntegration` rather than pretending |
| Tray, background running, notifications, startup | **Implemented** | startup via `HKCU\...\Run` |

The Settings → Windows integration panel renders this same table from the live
`capabilities` object, so the UI cannot drift from reality.

---

## 4. Browser integration

A web page cannot read or control another browser's tabs. So:

1. The app runs a loopback server on `127.0.0.1:8677` (`lib/attention/bridge.js`).
2. `extension/chrome` is loaded unpacked in Chrome/Edge and paired with a one-time
   6-digit code (Settings → Browser → Generate pairing code). It receives a token.
3. The extension POSTs the active tab to `/tab` and pulls block policy from `/policy`.
4. On a blocked navigation it swaps the tab to the local block page and POSTs `/attempt`.

If the desktop app is closed the extension **fails open** — browsing is never broken.
No data leaves the machine; there are no remote endpoints.

---

## 5. Plans and Sleep

A plan is reusable: `{ name, days[], blocks[{start,end,kind,label}], rules }` where rules
carry allowed/blocked apps, allowed/blocked sites, category rules and a `strict` flag.
During a focus block the blocking engine applies those rules live; breaks never block.

Sleep is a genuine scheduled restriction with correct across-midnight math: configured
categories/apps/sites stay shut, the island reflects it, and the end time is always shown.

---

## 6. Activity dashboard

Private and personal only — total focus / distraction / other / idle, a day timeline
split into those four lanes, percentages, last hour, 7-day trend, top subjects and recent
activity. Exportable and erasable. **No community, leaderboard or social ranking.**

---

## 7. Running it

```bash
npm start                 # the real Electron app (island + tray + detection)
npm run test:attention    # 48 engine, service and contract checks
npm run preview:air       # browser harness: real engines, simulated foreground feed
```

The preview harness (`scripts/attention-preview.js`) exists because the OS detector needs
Windows. It runs the **real** store, classification, blocking, planning and tracking
engines behind an HTTP shim and lets you drive the foreground feed by hand. It is a
development harness, not the product.

---

## 8. focusarx.site

Integrated as a resource, not an advertisement: Settings → Focus ecosystem offers the
account connection, attention resources and a link back to the web Focus experience. The
Windows application remains the primary product and the activity data never leaves it.
