# Vendored third-party source

GemAir vendors the source of two open-source projects so its capabilities can
be audited and extended in-repo. Neither is built into the Electron app; each is a
reference + integration point (see the notes below and the license in each folder).

| Folder | Upstream | License | Why it's here |
| --- | --- | --- | --- |
| `computer-agent/` | [suitedaces/computer-agent](https://github.com/suitedaces/computer-agent) | Apache-2.0 | Desktop "computer-use" agent (Tauri + React + Rust). GemAir's keyless **Desktop Agent** (`lib/computer-agent.js`) is the JS port of its Rust input primitives, upgraded to run inside Electron with **no API key, no vendor**. |
| `opencode/` | [sst/opencode](https://github.com/sst/opencode) | MIT | Terminal AI coding agent (75+ providers, keyless via Ollama). GemAir's **Coding Agent** reuses its keyless provider config approach and can delegate to a user-installed `opencode` CLI. |

## Notes

- These folders are **excluded** from `electron-builder` (see the `files` list in
  `package.json`); they are reference source only.
- Full `opencode` is a separate Bun/TypeScript monorepo (~5,000 files). We vendor its
  LICENSE + README + the key agent/provider source and wire a keyless adapter, rather
  than pull the whole tree (which would bloat the repo and conflict with the Electron build).
