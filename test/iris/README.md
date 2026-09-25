# The ported Iris suite

`npm run test:iris` — 1014 assertions across 46 files, run by `node --test`
(it is also part of `npm test`).

These are Iris's own tests for the subsystem in `lib/iris/`, ported the same way
the code was: compiled from the upstream TypeScript, then edited by hand where
GemAir genuinely behaves differently. They are here because a port whose tests
were left behind is a port nobody can change safely — the interesting failures
below were all found by running them.

Four of the files are GemAir's own (`integration`, `pointing.e2e`,
`state.e2e`, `maintain.e2e`): they mount the whole subsystem on a fake Electron.
See "The four end-to-end files" below.

## How they run without vitest

Upstream runs on vitest; GemAir has no test framework and no dependencies, so
`vitest-shim.js` maps the handful of vitest that the suite uses onto
`node:test` + `node:assert/strict`: `describe`/`it`/`it.each` (printf titles),
`it.runIf`, the lifecycle hooks, `expect` with the ~25 matchers the suite calls,
`.not`/`.resolves`/`.rejects`, the asymmetric matchers, and `vi.fn`/`vi.stubEnv`.
Two details matter and are deliberate:

- `toEqual` ignores keys whose value is `undefined`, as vitest's does, and
  `toMatchObject` is a *recursive partial* match including array elements.
  Getting either wrong silently changes what a hundred assertions mean.
- Anything the shim does not implement (`vi.mock`, `vi.spyOn`) throws by name
  rather than no-opping, so a test cannot quietly stop testing anything.

## What was NOT ported, and why

- `publik-*`, `account-service`, `claude-service`, `codex-chat` — the publik
  backend and its credential tiers are not in GemAir at all.
- `app-version`, `self-update-check`, `launch-arguments` — Squirrel/release
  plumbing that belongs to Iris's own installer, not GemAir's.
- The jsdom renderer tests (`chat-renderer`, `settings-renderer`,
  `guide-renderer`, `guide-autopilot-entry`) — they need a DOM GemAir does not
  install.

## Where GemAir's expectations differ from Iris's

Each of these is a deliberate divergence, asserted here so it cannot drift back:

| Suite | Divergence |
| --- | --- |
| `assistant-transport` | Rewritten for GemAir's three OpenCode routes (Zen free models, local `opencode serve`, the CLI). No publik gateway, no BYO Anthropic key, no paid tier — a 402 means "that model was not free", never "top up". |
| `maintain-model-provider` | Same: Tier C runs on free OpenCode models or the reader's own CLI, so "no key" is no longer a refusal. |
| `maintain-pool-client` | GemAir ships with **no** recipe pool. The default base URL is empty, which disables the client; the wire-shape tests point at a self-hosted one. |
| `guide-service` | Guides load from the bundle or a loopback guide server only; `publikhq.com` is rejected. |
| `external-links` | 37 hosts: upstream's 29 minus the two publik ones, plus the ten GemAir's own catalogue needs. |
| `maintain-app-inventory`, `autopilot-watch`, `maintain-detection-e2e` | The reviewed Windows roster is Ollama + VS Code, not publik's app. |
| `autopilot-recipe`, `guide-recipe` | The clone-build-serve recipe is Excalidraw; recipes that clone nothing must not move the shell at all. |
| `autopilot-fix-ladder` | The spend cap only exists for a `metered_tier` a reader would have to wire in themselves; GemAir's own routes are free. |

## The four end-to-end files

Everything upstream tests is a pure module — which left the half of the port
that only runs inside Electron (`lib/iris/main/*`, roughly 2,000 lines: the
windows, the tray fragment, the deep-link funnel, the IPC surface, the capture
pipeline) covered by nothing, because Electron cannot run here. Those four files
close that hole by injecting `fixtures/fake-electron.js` into the module cache
and then calling the real `integration.mount()`:

| File | What it drives |
| --- | --- |
| `integration.test.js` | The host contract GemAir's `main.js` actually uses: mount, the tray fragment, the guide list, the route probe, `ask()` over the free Zen route, every window, the deep-link funnel, and the `NOT_MOUNTED` stub. |
| `pointing.e2e.test.js` | The eye, end to end on two monitors of different densities: capture → downscale to 1568 → `[POINT]` → refinement crop → overlay. Proves the coordinates the overlay is handed are DISPLAY space, window-relative, and on the right monitor. |
| `state.e2e.test.js` | What is written to disk, read back as bytes: settings round-trip, a secret refused rather than stored in the clear, and a pre-fork install's plaintext keys removed. |
| `maintain.e2e.test.js` | A break, a card, an answer: the ask card opens inactive, its snapshot survives the window still loading, the reader's answer reaches it over IPC, and mute/cooldown keep it from nagging. |

`fixtures/fake-electron.js` implements exactly the twenty Electron APIs
`lib/iris` touches (`grep -rho "electron_1\.[A-Za-z.]*" lib/iris`) and nothing
else, so a call the port starts making that the fake does not know about fails
loudly rather than passing quietly. It fires `did-finish-load` after a load, as
real Electron does, because several windows queue their first message until it.

## What running them caught

The port had six real defects, each fixed in `lib/iris/`:

1. `main/index.js` broadcast `iris-deep-link-rejected` / `iris-guide-opened`
   while the preload listened for `gemair-*` — deep links reached no window.
2. `maintain/replay-engine.js` and `maintain/tier-c-fixer.js` still committed
   fixes on `iris/fix-…` branches and signed them `iris-maintain-mode/1`.
3. `maintain/sandbox.js` still named its jail, its firewall rule and its
   P/Invoke namespace `iris-jail-…` / `IrisJail`.
4. `maintain/pool-client.js` still called publik's `/api/iris/*` routes and
   held them in a field called `publikBaseUrl`.
5. The Excalidraw recipe declared `~/excalidraw` for steps a Windows shell
   would have left in `~`, and its clone was not idempotent on re-run.
6. `main/settings.js` spread the whole parsed file into its state, so the
   migration that is supposed to strip a pre-fork install's plaintext
   `anthropicApiKey` wrote it straight back out again — the key would have sat
   in the clear forever. Caught by `state.e2e.test.js` reading the file back.
