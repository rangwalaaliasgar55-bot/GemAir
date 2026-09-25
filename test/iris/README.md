# The ported Iris suite

`npm run test:iris` — 950 assertions across 42 files, run by `node --test`
(it is also part of `npm test`).

These are Iris's own tests for the subsystem in `lib/iris/`, ported the same way
the code was: compiled from the upstream TypeScript, then edited by hand where
GemAir genuinely behaves differently. They are here because a port whose tests
were left behind is a port nobody can change safely — the interesting failures
below were all found by running them.

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

## What running them caught

The port had five real defects, each fixed in `lib/iris/`:

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
