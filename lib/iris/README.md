# GemAir Assist

A port of [Blueturboguy07/iris](https://github.com/Blueturboguy07/iris) into
GemAir. Upstream is a standalone tray app; this is the same product as a
subsystem of GemAir, with two deliberate changes that run through everything:

1. **Free OpenCode models only.** Every model call — chat, the autopilot's
   self-repair ladder, maintain mode's Tier B and Tier C fixers — goes to a free
   OpenCode route. A paid model id is refused before a request is built.
2. **No publik.** Upstream was publik's desktop assistant: a hosted metered API,
   a funded tier, a balance with an "Add credit" button, account sign-in, a
   hosted guide service, and a shared recipe pool. None of it is here. The
   guides ship inside the app, the recipe pool is off, and there is nothing to
   buy.

Everything else — the two-pass screen pointing, the guided-install autopilot
with its fix ladder and risk gate, maintain mode's crash/hang watchers and fix
tiers, the deep-link grammar, the external-link allowlist, the secret handling —
is the upstream behaviour, ported.

## What it does

| Feature | Where |
| --- | --- |
| Ask about what is on screen; GemAir points at it with click-through overlays | `main/companion.js`, `main/screenshot.js`, `services/coordinates.js`, `renderer/iris/overlay/` |
| Install guides, step by step, with watched verification | `services/guide-service.js`, `guides/*.json`, `renderer/iris/guide/` |
| Autopilot: run a whole install hands-free, repairing itself when a step fails | `main/autopilot-controller.js`, `services/autopilot/`, `renderer/iris/autopilot/` |
| Maintain mode: notice an installed app crashing, offer a fix, verify it | `main/maintain/controller.js`, `services/maintain/`, `renderer/iris/maintain/` |
| `gemair://guide/<slug>` deep links | `services/deep-link-parser.js` |

## Mounting it

GemAir's `main.js` does this once, after `app.whenReady()`:

```js
const assistIntegration = require('./lib/iris/integration');

assist = assistIntegration.mount({
  onTrayChanged: () => rebuildTrayMenu()
});
```

`mount()` never throws. If anything inside fails to load it logs the reason and
returns an inert stub with the same shape, so a broken subsystem cannot take the
host app down. `assist.available` says which one you got.

The returned API: `openChat()`, `openGuide()`, `openGuideFor(slug)`,
`openSettings()`, `openAutopilot(slug)`, `ask(text)`, `guides()`, `route()`,
`refreshRoute()`, `menuItems()`, `trayTooltip()`, `receiveDeepLinksFromArgv()`,
`stop()`.

### One tray, one preload

Upstream owned the tray and created its own `Tray`. GemAir already has one, so
`main/tray.js` keeps the whole "your turn" state machine and gives up the icon:
it hands back a menu **fragment** (`menuItems()`) that GemAir's `rebuildTrayMenu()`
splices in, and calls `onTrayChanged` when the fragment would change — Electron
menus are immutable once built, so "changed" always means "rebuilt".

Assist's windows load `lib/iris/preload.js` (`window.gemair`, plus the generic
`window.gemairNative` bridge the transplanted guide panel drives). GemAir's own
renderer gets a much smaller surface, `window.assist`, from GemAir's `preload.js`.

## Layout

```
lib/iris/
  integration.js      the one entry point the host uses; cannot throw
  preload.js          the Assist windows' only channel to the main process
  guides/*.json       the install guides that ship with this build
  main/               Electron-touching code: windows, IPC, shells, secrets
    index.js          startAssist(): windows, IPC, deep links, the tray fragment
    companion.js      the ask-about-your-screen loop, two-pass [POINT] refinement
    opencode-session.js  the reader's own `opencode` binary as a chat backend
    settings.js       assist-settings.json + safeStorage-backed secrets
    autopilot-controller.js, maintain/
  services/           pure logic, no Electron, unit-testable
    opencode-models.js   the free-model gate — the file that makes "free only" true
    assistant-transport.js  which route answers, and how a request is built
    guide-service.js     loads a bundled guide; loopback-only for guide authors
    autopilot/, maintain/, coordinates.js, external-links.js, deep-link-parser.js
renderer/iris/        the Assist windows: chat, guide, autopilot, maintain, settings,
                      overlay, first-run
scripts/assist-test.js  the invariants above, asserted (`npm run test:assist`)
```

## The three invariants worth protecting

**Free only.** `services/opencode-models.js` is the gate. Everything that names
a model goes through `assertFreeModelId`, including the settings field (so a
reader who types a paid id is told no by the field they typed it into) and
`defaultModelForTransport` (so a stale settings value cannot become a paid
request). The free line-up is promotional and changes; it is treated as data and
can be refreshed from OpenCode's own catalogue, which only ever teaches the gate
ids the catalogue itself marks free.

**Nothing phones home.** The guide source defaults to `bundled:` — files on
disk. A remote guide source is accepted only on loopback, for guide authors. The
maintain recipe pool defaults to an empty base URL, which disables it. The app
catalogue is a local roster.

**A renderer never sees a secret.** `main/secrets.js` is the only code that
reads one, and the preload exposes no way to read one back — a renderer can ask
*whether* a key is stored and can set one, never read it. When the OS refuses to
encrypt, GemAir refuses to store rather than falling back to plain text.

## Testing

```
npm run test:assist     # this subsystem's contract with the host
npm run test:iris       # Iris's own suite, ported (1014 assertions)
npm run check           # the whole suite, which now includes both
```

`test/iris/` also mounts the whole subsystem headlessly — windows, tray, deep
links, capture, maintain card — against a fake Electron
(`test/iris/fixtures/fake-electron.js`); see `test/iris/README.md`.

The `test:assist` suite is pure logic: no Electron, no network. It asserts the free-model gate
(including that a paid id is refused by name), route selection and its refusal
to silently switch providers, that no shipped file reaches publik, that every
bundled guide is valid on both platforms and links only to allowlisted hosts,
that every guide derives a runnable recipe, the deep-link grammar, and that the
host wiring is intact (one tray, Assist mounted, Assist torn down on quit).

## Seeing it without Electron

```
npm run preview:assist        # http://localhost:4173
```

Electron cannot run everywhere this repo is checked out, which would otherwise
make seven renderer windows unreviewable. `scripts/assist-preview.js` serves
`renderer/iris/**` over HTTP and gives the page a bridge with the same shape as
`preload.js` — `invoke` over POST, the `on…` callbacks over Server-Sent Events —
backed by the real main process running on the same fake Electron the tests use.
The renderers and `lib/iris/` are untouched: a window that would break in
Electron breaks here too. Model replies are simulated unless you set
`ASSIST_PREVIEW_OFFLINE=0`, and there is no real screen, so capture hands the
pointing pipeline a blank display. `scripts/assist-preview-test.js` (part of
`npm run check`) uses it to assert the renderer → preload → main chain is whole.

## Differences from upstream, in one place

| Upstream | Here | Why |
| --- | --- | --- |
| publik API tier, funded tier, balance, "Add credit" | gone | free models only |
| Anthropic / OpenAI BYO keys (chat, Tier C fixer, patch adapter) | free OpenCode routes | free models only |
| Supabase account sign-in | gone | nothing to link |
| Hosted guide service at publikhq.com | `guides/*.json`, loopback for authors | works offline |
| Shared maintain recipe pool | off by default (`DEFAULT_MAINTAIN_POOL_BASE_URL = ""`) | nothing to phone |
| Its own `Tray`, its own single-instance lock, Squirrel install hooks, self-update poll | GemAir's | it is a subsystem now |
| Windows-only maintain shell runner | picks PowerShell or a login shell | GemAir ships on both |
| Windows-only recipes | each recipe carries a `posixCommand` | GemAir ships on both |
